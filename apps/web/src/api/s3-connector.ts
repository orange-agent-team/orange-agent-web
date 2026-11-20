import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/s3-connector.schema.json' with {type:'json'};
import {UserClient,ApiFailure} from './client';
import type {UserSession} from './contracts';
export interface Source {source_id:string;source_digest:string;bucket:string;prefix:string}
export interface Grant {grant_id:string;source_id:string;source_digest:string;expires_at:string;revoked:boolean}
interface Inventory {sources:Source[];recent_grants:Grant[];run_readable:boolean}
export interface Head {key:string;etag:string;version:string|null;size_bytes:string}
export interface Artifact {kind:'source_backed_artifact';artifact_id:string;head:Head;sha256:string}
interface Listing {keys:string[];next_after:string|null}
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',(v:string)=>Number.isFinite(Date.parse(v)));
ajv.addSchema(schema,'s3-connector');
function readAs<T>(type:string){
  const validate=ajv.compile<T>({$ref:'s3-connector#/$defs/'+type});
  return (value:unknown):T=>{
    if(!validate(value))throw new ApiFailure(200,'INVALID_RESPONSE');
    return value;
  };
}
const inventory=readAs<Inventory>('Inventory'),grantReceipt=readAs<{grant_id:string}>('GrantReceipt');
const output=readAs<{kind:'external_untrusted_data';data:unknown}>('Output');
const head=readAs<Head>('Head'),artifact=readAs<Artifact>('Artifact'),listing=readAs<Listing>('List');
function segment(id:string){
  if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))throw Error('INVALID_IDENTIFIER');
  return encodeURIComponent(id);
}
function path(run:string){return '/api/v1/agent/runs/'+segment(run)+'/connectors/s3';}
function headers(session:UserSession,key:string){return {'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':key};}

export class S3Client extends UserClient{
  async inventory(run:string,signal?:AbortSignal){return inventory(await this.call(path(run),{signal}));}
  async grant(s:UserSession,run:string,src:Source,key:string){
    return grantReceipt(await this.call(path(run),{method:'POST',headers:headers(s,key),body:JSON.stringify({source_id:src.source_id,source_digest:src.source_digest,duration_seconds:900})}));
  }
  async revoke(s:UserSession,run:string,g:Grant){
    await this.call(path(run)+'/'+segment(g.grant_id),{method:'DELETE',headers:headers(s,'revoke-'+g.grant_id)},204);
  }
  private async action(s:UserSession,run:string,g:Grant,key:string,body:unknown){
    return output(await this.call(path(run)+'/'+segment(g.grant_id)+'/actions',{method:'POST',headers:headers(s,key),body:JSON.stringify(body)})).data;
  }
  async list(s:UserSession,run:string,g:Grant,after:string|null){
    return listing(await this.action(s,run,g,crypto.randomUUID(),{action:'list_objects',after,limit:25}));
  }
  async head(s:UserSession,run:string,g:Grant,key:string){
    const value=head(await this.action(s,run,g,crypto.randomUUID(),{action:'head_object',key}));
    if(value.key!==key)throw new ApiFailure(200,'OBJECT_CHANGED');
    return value;
  }
  async read(s:UserSession,run:string,g:Grant,expected:Head,key:string){
    const value=artifact(await this.action(s,run,g,key,{action:'read_object',expected}));
    if(value.head.key!==expected.key||value.head.etag!==expected.etag||value.head.version!==expected.version||value.head.size_bytes!==expected.size_bytes)throw new ApiFailure(200,'OBJECT_CHANGED');
    return value;
  }
  async download(s:UserSession,run:string,g:Grant,ref:Artifact,signal:AbortSignal){
    const size=Number(ref.head.size_bytes);
    if(!Number.isSafeInteger(size)||size>20*1024*1024)throw new ApiFailure(413,'OBJECT_TOO_LARGE');
    const url=path(run)+'/'+segment(g.grant_id)+'/artifacts/'+segment(ref.artifact_id)+'/content';
    const res=await this.fetcher(url,{method:'POST',headers:headers(s,crypto.randomUUID()),credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if(res.status!==200)throw new ApiFailure(res.status,'DOWNLOAD_DENIED');
    if(!res.body||res.headers.get('Content-Type')!=='application/octet-stream')throw new ApiFailure(200,'INVALID_RESPONSE');
    const reader=res.body.getReader(), data=new Uint8Array(size);
    let offset=0;
    try{
      for(;;){
        const part=await reader.read();
        if(part.done)break;
        if(part.value.byteLength>size-offset)throw new ApiFailure(200,'BYTE_COUNT_MISMATCH');
        data.set(part.value,offset);offset+=part.value.byteLength;
      }
    }finally{await reader.cancel();reader.releaseLock();}
    const digest=await crypto.subtle.digest('SHA-256',data);
    if(offset!==size||Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')!==ref.sha256)throw new ApiFailure(200,'CONTENT_INTEGRITY');
    return new Blob([data],{type:'application/octet-stream'});
  }
}
