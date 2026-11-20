import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/notion-connector.schema.json' with {type:'json'};
import {ApiFailure,UserClient} from './client';
import type {UserSession} from './contracts';

export type Root={kind:'page';page_id:string}|{kind:'database';database_id:string;data_sources:string[]};
export interface Source {source_id:string;source_digest:string;roots:Record<string,Root>}
export interface Grant {grant_id:string;source_id:string;source_digest:string;root_keys:string[];expires_at:string;revoked:boolean}
interface Inventory {sources:Source[];recent_grants:Grant[];run_readable:boolean;document_access_selected:boolean}
export interface Summary {page_id:string;title:string;last_edited_time:string}
export interface Page extends Summary {properties:Record<string,{type:string;value:unknown}|{type:string;projected:false}>}
export interface Block {block_id:string;type:string;text?:string;checked?:boolean;expression?:string;cells?:string[];children?:string;projected?:false}
export type Filter={property:string;kind:'title'|'rich_text'|'select'|'status';equals:string}|{property:string;kind:'checkbox';equals:boolean}|{property:string;kind:'number';equals:number};
export type Sort={timestamp:'created_time'|'last_edited_time';direction:'ascending'|'descending'};
export type Action=
 |{action:'search_pages';query:string;limit:number;cursor?:string}
 |{action:'read_page';root:string;page?:string}
 |{action:'list_blocks';root:string;limit:number;target?:string;cursor?:string}
 |{action:'query_database';root:string;data_source:string;limit:number;filter?:Filter;sort?:Sort;cursor?:string};
export type Output=
 |{kind:'search';pages:{root:string;page:Summary}[];next_cursor:string|null}
 |{kind:'page';page:Page}
 |{kind:'blocks';blocks:Block[];next_cursor:string|null}
 |{kind:'rows';rows:{handle:string;page:Page}[];next_cursor:string|null};
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',(v:string)=>Number.isFinite(Date.parse(v)));
ajv.addSchema(schema,'notion');
function decode<T>(type:string){
  const validate=ajv.compile<T>({$ref:'notion#/$defs/'+type});
  return (value:unknown):T=>{if(!validate(value))throw new ApiFailure(200,'INVALID_RESPONSE');return value;};
}
const inventory=decode<Inventory>('Inventory'), grant=decode<{grant_id:string}>('GrantReceipt');
const envelope=decode<{kind:'external_untrusted_data';data:unknown}>('Output');
const search=decode<{pages:{root:string;page:Summary}[];next_cursor:string|null}>('SearchResults');
const page=decode<Page>('Page'),blocks=decode<{blocks:Block[];next_cursor:string|null}>('Blocks'),rows=decode<{rows:{handle:string;page:Page}[];next_cursor:string|null}>('Rows');
function segment(v:string){if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(v))throw Error('INVALID_IDENTIFIER');return encodeURIComponent(v);}
const base=(run:string)=>'/api/v1/agent/runs/'+segment(run)+'/connectors/notion';
const headers=(session:UserSession,key:string)=>({'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':key});
export class NotionClient extends UserClient{
  async inventory(run:string,signal?:AbortSignal){return inventory(await this.call(base(run),{signal}));}
  async grant(session:UserSession,run:string,source:Source,roots:string[],key:string){
    return grant(await this.call(base(run),{method:'POST',headers:headers(session,key),body:JSON.stringify({source_id:source.source_id,source_digest:source.source_digest,root_keys:roots,duration_seconds:900})}));
  }
  async revoke(session:UserSession,run:string,g:Grant){await this.call(base(run)+'/'+segment(g.grant_id),{method:'DELETE',headers:headers(session,'revoke-'+g.grant_id)},204);}
  async read(session:UserSession,run:string,g:Grant,request:Action):Promise<Output>{
    const result=envelope(await this.call(base(run)+'/'+segment(g.grant_id)+'/actions',{method:'POST',headers:headers(session,crypto.randomUUID()),body:JSON.stringify(request)})).data;
    switch(request.action){
      case 'read_page':return {kind:'page',page:page(result)};
      case 'search_pages':{
        const list=search(result);
        if(list.pages.some(item=>!g.root_keys.includes(item.root)))throw new ApiFailure(403,'SCOPE_MISMATCH');
        return {kind:'search',...list};
      }
      case 'list_blocks':return {kind:'blocks',...blocks(result)};
      case 'query_database':return {kind:'rows',...rows(result)};
    }
  }
}
