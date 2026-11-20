import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/confluence-connector.schema.json' with {type:'json'};
import {ApiFailure,UserClient} from './client';
import {verifiedDownload} from './verified-download';
import type {UserSession} from './contracts';

export interface Source{source_id:string;source_digest:string;site:string;spaces:Record<string,{id:string;key:string}>}
export interface Grant{source_id:string;source_digest:string;grant_id:string;space_keys:string[];expires_at:string;revoked:boolean}
interface Inventory{sources:Source[];recent_grants:Grant[];run_readable:boolean;document_access_selected:boolean;quarantine_available:boolean}
interface Page{type:'page';id:string;title:string;version:string;handle:string}
interface Other{type:string;id:string;title:string}
interface Attachment{id:string;title:string;media_type:string;size_bytes:string;version:string;handle:string}
interface Content{page:Page;text:string;omitted_nodes:string[];attachments:Attachment[];next_attachments_cursor:string|null}
export interface Receipt{kind:'quarantined_artifact';artifact_id:string;title:string;size_bytes:string;version:string;sha256:string}
export type Action=
 |{action:'search_pages';space:string;query:string;limit:number;cursor?:string}
 |{action:'read_page';space:string;page:string;attachments_cursor?:string}
 |{action:'list_children';space:string;page:string;limit:number;cursor?:string}
 |{action:'read_attachment';space:string;attachment:string};
export type Output=
 |{kind:'pages';pages:Page[];next_cursor:string|null}
 |{kind:'content';content:Content}
 |{kind:'children';children:(Page|Other)[];next_cursor:string|null}
 |{kind:'file';file:Receipt};
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',(v:string)=>Number.isFinite(Date.parse(v)));ajv.addSchema(schema,'confluence');
function decode<T>(n:string){const validate=ajv.compile<T>({$ref:'confluence#/$defs/'+n});return (raw:unknown):T=>{if(!validate(raw))throw new ApiFailure(200,'INVALID_RESPONSE');return raw;};}
const inventory=decode<Inventory>('Inventory'),grant=decode<{grant_id:string}>('GrantReceipt'),envelope=decode<{data:unknown}>('Output');
const pages=decode<{pages:Page[];next_cursor:string|null}>('Pages'),content=decode<Content>('Content'),children=decode<{children:(Page|Other)[];next_cursor:string|null}>('Children'),file=decode<Receipt>('Quarantine');
const segment=(s:string)=>{if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(s))throw Error('INVALID_IDENTIFIER');return encodeURIComponent(s);};
const base=(run:string)=>'/api/v1/agent/runs/'+segment(run)+'/connectors/confluence';
function headers(s:UserSession,key:string){return {'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':key};}
export class ConfluenceClient extends UserClient{
  async inventory(run:string,signal?:AbortSignal){return inventory(await this.call(base(run),{signal}));}
  async grant(s:UserSession,run:string,source:Source,spaces:string[],key:string){
    return grant(await this.call(base(run),{method:'POST',headers:headers(s,key),body:JSON.stringify({source_id:source.source_id,source_digest:source.source_digest,space_keys:spaces,duration_seconds:900})}));
  }
  async revoke(s:UserSession,run:string,g:Grant){await this.call(base(run)+'/'+segment(g.grant_id),{method:'DELETE',headers:headers(s,'revoke-'+g.grant_id)},204);}
  async read(s:UserSession,run:string,g:Grant,a:Action,key:string):Promise<Output>{
    if(!g.space_keys.includes(a.space))throw new ApiFailure(403,'SPACE_NOT_GRANTED');
    const raw=envelope(await this.call(base(run)+'/'+segment(g.grant_id)+'/actions',{method:'POST',headers:headers(s,key),body:JSON.stringify(a)})).data;
    switch(a.action){
      case 'search_pages':return {kind:'pages',...pages(raw)};
      case 'list_children':return {kind:'children',...children(raw)};
      case 'read_page':return {kind:'content',content:content(raw)};
      case 'read_attachment':return {kind:'file',file:file(raw)};
    }
  }
  async download(s:UserSession,run:string,g:Grant,ref:Receipt,signal:AbortSignal){
    return verifiedDownload(this.fetcher,base(run)+'/'+segment(g.grant_id)+'/artifacts/'+segment(ref.artifact_id)+'/content',
      headers(s,crypto.randomUUID()),ref.size_bytes,ref.sha256,signal);
  }
}
