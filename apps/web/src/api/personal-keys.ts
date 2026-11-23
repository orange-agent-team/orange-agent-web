import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/account.schema.json' with {type:'json'};
import {UserClient} from './client';
import type {UserSession} from './contracts';

export type ReadScope='wallet:read'|'budgets:read';
export interface KeyDetails {
  key_id:string; user_id:string; owner_id:string; audience:'orange-personal-automation-v1'; scope:ReadScope;
  label:string; status:'active'|'revoked'|'expired'; created_at:string; expires_at:string;
}
export interface KeyPage {data:KeyDetails[];next_cursor:string|null}
export interface Registration {
  label:string;audience:'orange-personal-automation-v1';scope:ReadScope;ttl_seconds:number;verifier:string;
}
export interface LocalKey {id:string;bearer:string;registration:Registration}

const ajv=new Ajv2020({strict:false});
ajv.addSchema(schema);
const keyView=ajv.compile<KeyDetails>({$ref:schema.$id+'#/$defs/PersonalKeyView'});
const keyPage=ajv.compile<KeyPage>({$ref:schema.$id+'#/$defs/PersonalKeyPage'});
export const validKeyId=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const base='/api/v1/account/api-keys';
function owned(s:UserSession,k:KeyDetails){
  if(k.user_id!==s.user_id || k.owner_id!==s.personal_owner_id ||
     !(Date.parse(k.expires_at)>Date.parse(k.created_at)))throw Error('UNCONFIRMED_KEY');
}
function path(id:string){
  if(!validKeyId(id))throw Error('INVALID_KEY_ID');
  return base+'/'+id;
}
function writeHeaders(s:UserSession,id:string){
  return {'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':id};
}
const hex=(bytes:Uint8Array)=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
export async function generateKey(label:string,scope:ReadScope,ttlSeconds:number):Promise<LocalKey>{
  const id=crypto.randomUUID();
  const bearer='oa1.'+id+'.'+hex(crypto.getRandomValues(new Uint8Array(32)));
  const verifier=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bearer))));
  return {id,bearer,registration:{label,scope,ttl_seconds:ttlSeconds,verifier,audience:'orange-personal-automation-v1'}};
}
export class KeyClient extends UserClient {
  async list(s:UserSession,after?:string,signal?:AbortSignal){
    if(after && !validKeyId(after))throw Error('INVALID_KEY_CURSOR');
    const result=await this.call(base+'?limit=25'+(after?'&after='+after:''),{signal});
    if(!keyPage(result))throw Error('INVALID_KEY_LIST');
    for(const row of result.data)owned(s,row);
    return result;
  }
  async register(s:UserSession,id:string,request:Registration){
    const result=await this.call(path(id),{method:'PUT',headers:writeHeaders(s,id),body:JSON.stringify(request)});
    if(!keyView(result))throw Error('INVALID_KEY_RESULT');
    owned(s,result);
    if(result.key_id!==id || result.scope!==request.scope || result.label!==request.label ||
       Date.parse(result.expires_at)-Date.parse(result.created_at)!==request.ttl_seconds*1000)throw Error('UNCONFIRMED_KEY');
    return result;
  }
  async withdraw(s:UserSession,id:string){
    await this.call(path(id),{method:'DELETE',headers:writeHeaders(s,id)},204);
  }
}
