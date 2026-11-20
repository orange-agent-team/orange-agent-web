import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/repository-connector.schema.json' with {type:'json'};
import {ApiFailure,UserClient} from './client';
import {verifiedDownload} from './verified-download';
import type {UserSession} from './contracts';

export type Provider='github'|'gitlab';
export interface Resource {repository_id:string;path:string;file_prefixes:string[];issues:boolean;changes:boolean}
export interface Source {source_id:string;source_digest:string;repositories:Resource[]}
export interface Grant {source_id:string;source_digest:string;grant_id:string;repository_ids:string[];expires_at:string;revoked:boolean}
interface Inventory {run_readable:boolean;external_access_selected:boolean;sources:Source[];recent_grants:Grant[]}
export interface Item {repository_id:string;id:string;number:string;title:string;state:string;updated_at:string;body?:string|null}
export interface Repo {id:string;path:string;default_branch:string}
export interface Page<T> {data:T[];next_page:number|null}
export interface FileReceipt {kind:'source_backed_artifact';artifact_id:string;repository_id:string;path:string;commit:string;blob:string;size_bytes:string;sha256:string}
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',(s:string)=>Number.isFinite(Date.parse(s)));
ajv.addSchema(schema,'repo');
function decoder<T>(name:string){
  const check=ajv.compile<T>({$ref:'repo#/$defs/'+name});
  return (value:unknown):T=>{if(!check(value))throw new ApiFailure(200,'INVALID_RESPONSE');return value;};
}
const inventory=decoder<Inventory>('Inventory'), confirm=decoder<{grant_id:string}>('GrantReceipt'), envelope=decoder<{kind:'external_untrusted_data';data:unknown}>('Output');
const page=decoder<Page<unknown>>('Page'),repo=decoder<Repo>('Repository'),summary=decoder<Item>('Summary'),detail=decoder<Item>('Item'),file=decoder<FileReceipt>('Artifact');
function segment(value:string){if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))throw Error('INVALID_IDENTIFIER');return encodeURIComponent(value);}
export class RepositoryClient extends UserClient {
  private base(run:string,p:Provider){return '/api/v1/agent/runs/'+segment(run)+'/connectors/'+p;}
  private headers(s:UserSession,key:string){return {'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':key};}
  async inventory(run:string,p:Provider,signal?:AbortSignal){return inventory(await this.call(this.base(run,p),{signal}));}
  async grant(s:UserSession,run:string,p:Provider,src:Source,ids:string[],key:string){return confirm(await this.call(this.base(run,p),{method:'POST',headers:this.headers(s,key),body:JSON.stringify({source_id:src.source_id,source_digest:src.source_digest,repository_ids:ids,duration_seconds:900})}));}
  async revoke(s:UserSession,run:string,p:Provider,g:Grant){await this.call(this.base(run,p)+'/'+segment(g.grant_id),{method:'DELETE',headers:this.headers(s,'revoke-'+g.grant_id)},204);}
  private async read(s:UserSession,run:string,p:Provider,g:Grant,a:object,key=crypto.randomUUID() as string){
    return envelope(await this.call(this.base(run,p)+'/'+segment(g.grant_id)+'/actions',{method:'POST',headers:this.headers(s,key),body:JSON.stringify(a)})).data;
  }
  async repos(s:UserSession,run:string,p:Provider,g:Grant,n:number){
    const v=page(await this.read(s,run,p,g,{action:p==='github'?'list_repositories':'list_projects',page:n,limit:25}));
    const rows=v.data.map(repo);
    if(rows.some(r=>!g.repository_ids.includes(r.id)))throw new ApiFailure(403,'SCOPE_MISMATCH');
    return {data:rows,next_page:v.next_page};
  }
  async items(s:UserSession,run:string,p:Provider,g:Grant,id:string,issues:boolean,n:number){
    const action=issues?'list_issues':p==='github'?'list_pull_requests':'list_merge_requests';
    const v=page(await this.read(s,run,p,g,{action,repository_id:id,page:n,limit:25}));
    const rows=v.data.map(summary);
    if(rows.some(r=>r.repository_id!==id))throw new ApiFailure(403,'SCOPE_MISMATCH');
    return {data:rows,next_page:v.next_page};
  }
  async item(s:UserSession,run:string,p:Provider,g:Grant,id:string,issues:boolean,n:string){
    const action=issues?'read_issue':p==='github'?'read_pull_request':'read_merge_request';
    const v=detail(await this.read(s,run,p,g,{action,repository_id:id,number:n}));
    if(v.repository_id!==id||v.number!==n)throw new ApiFailure(403,'SCOPE_MISMATCH');
    return v;
  }
  async file(s:UserSession,run:string,p:Provider,g:Grant,id:string,revision:string,path:string,key:string){
    const v=file(await this.read(s,run,p,g,{action:'read_file',repository_id:id,revision,path},key));
    if(v.repository_id!==id||v.path!==path||(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)&&v.commit!==revision))throw new ApiFailure(403,'SCOPE_MISMATCH');
    return v;
  }
  async download(s:UserSession,run:string,p:Provider,g:Grant,ref:FileReceipt,signal:AbortSignal){
    return verifiedDownload(this.fetcher,this.base(run,p)+'/'+segment(g.grant_id)+'/artifacts/'+segment(ref.artifact_id)+'/content',
      this.headers(s,crypto.randomUUID()),ref.size_bytes,ref.sha256,signal);
  }
}
