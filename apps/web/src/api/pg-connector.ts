import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/pg-connector.schema.json' with {type:'json'};
import type {UserSession} from './contracts';
import {ApiFailure, UserClient} from './client';

export interface Source {source_id:string; source_digest:string; view_ids:string[]}
export interface Grant extends Source {grant_id:string; expires_at:string; revoked:boolean}
interface Inventory {run_readable:boolean; sources:Source[]; recent_grants:Grant[]}
export type ReadAction =
  | {action:'list_views'}
  | {action:'describe_view';view_id:string}
  | {action:'query_view';view_id:string;columns:string[];limit:number;after?:string};
type Rows = {rows:Record<string,string|boolean|null>[];next_after:string|null};
type Description = {view_id:string;columns:Record<string,string>;paging_key:string};
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',(v:string)=>Number.isFinite(Date.parse(v)));
ajv.addSchema(schema,'connector');
function decoder<T>(name:string){
  const validator=ajv.compile<T>({$ref:'connector#/$defs/'+name});
  return (raw:unknown):T=>{
    if(!validator(raw))throw new ApiFailure(200,'INVALID_RESPONSE');
    return raw;
  };
}
const inventory=decoder<Inventory>('Inventory');
const receipt=decoder<{grant_id:string}>('GrantReceipt');
const output=decoder<{kind:'external_untrusted_data';data:Rows|Description|{view_ids:string[]}}>('Output');
function segment(id:string){
  if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))throw Error('INVALID_IDENTIFIER');
  return encodeURIComponent(id);
}
export class PgConnectorClient extends UserClient {
  private path(run:string){return '/api/v1/agent/runs/'+segment(run)+'/connectors/postgres';}
  async inventory(run:string,signal?:AbortSignal){return inventory(await this.call(this.path(run),{signal}));}
  private post(s:UserSession,key:string,body:unknown){return {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':key},body:JSON.stringify(body)};}
  async grant(s:UserSession,run:string,src:Source,views:string[],key:string){
    return receipt(await this.call(this.path(run),this.post(s,key,{source_id:src.source_id,source_digest:src.source_digest,view_ids:views,duration_seconds:900})));
  }
  async revoke(s:UserSession,run:string,g:Grant){
    await this.call(this.path(run)+'/'+segment(g.grant_id),{method:'DELETE',headers:{'X-CSRF-Token':s.csrf_token,'Idempotency-Key':'revoke-'+g.grant_id}},204);
  }
  async read(s:UserSession,run:string,g:Grant,a:ReadAction){
    const raw=await this.call(this.path(run)+'/'+segment(g.grant_id)+'/actions',this.post(s,crypto.randomUUID(),a));
    const {data}=output(raw);
    if(a.action==='list_views' && 'view_ids' in data && data.view_ids.every(id=>g.view_ids.includes(id)))return data;
    if(a.action==='describe_view' && 'view_id' in data && data.view_id===a.view_id)return data;
    if(a.action==='query_view' && 'rows' in data && data.rows.every(row=>Object.keys(row).length===a.columns.length && a.columns.every(c=>Object.hasOwn(row,c))))return data;
    throw new ApiFailure(200,'INVALID_RESPONSE');
  }
}
