import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/account.schema.json' with {type:'json'};
import { UserClient, ApiFailure } from './client';
import type { UserSession } from './contracts';

export interface Version { artifact_id: string; version_id: string }
export interface SupportFile extends Version { size_bytes: string; sha256: string }
export interface Terms { ticket_id: string; purpose: string; resources: Version[]; content_field: 'file_content'; duration_seconds: number }
export interface Consent extends Omit<Terms,'duration_seconds'> {
  authorization_id: string; subject_user_id: string; owner_id: string; created_at: string; expires_at: string;
  status: 'active'|'expired'|'unavailable'|'revoked'; revoked_at?: string;
}
interface Page<T> { data:T[]; next_before?: string }
const base='/api/v1/account/support-authorizations';
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',value=>/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\dZ$/.test(value)&&Number.isFinite(Date.parse(value)));
ajv.addSchema(schema);
const validator=<T,>(name:string)=>ajv.compile<T>({$ref:schema.$id+'#/$defs/'+name});
const terms=validator<Terms>('SupportConsentCreate'), consent=validator<Consent>('SupportConsent');
const consentPage=validator<Page<Consent>>('SupportConsentList');
const filePage=validator<Page<SupportFile>&{subject_user_id:string;owner_id:string}>('SupportFileList');
function owned(value:{subject_user_id:string;owner_id:string},session:UserSession){
  if(value.subject_user_id!==session.user_id||value.owner_id!==session.personal_owner_id)throw new ApiFailure(403,'ACTOR_MISMATCH');
}
function checked(value:unknown,session:UserSession) {
  if(!consent(value) || (value.status==='revoked')!==!!value.revoked_at)throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  owned(value,session);return value;
}
function params(before?:string) {const q=new URLSearchParams({limit:'50'});if(before)q.set('before',before);return q;}
const headers=(s:UserSession,key:string)=>({'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':key});
export class SupportClient extends UserClient {
  async files(s:UserSession,before?:string,signal?:AbortSignal) {
    const page=await this.call('/api/v1/account/support-resources?'+params(before),{signal});
    if(!filePage(page))throw new ApiFailure(200,'INVALID_RESPONSE');
    owned(page,s);return page;
  }
  async consents(s:UserSession,before?:string,signal?:AbortSignal) {
    const page=await this.call(base+'?'+params(before),{signal});
    if(!consentPage(page))throw new ApiFailure(200,'INVALID_RESPONSE');
    page.data.forEach(row=>checked(row,s));return page;
  }
  async authorize(s:UserSession,key:string,body:Terms) {
    if(!terms(body)||new Set(body.resources.map(r=>r.artifact_id)).size!==body.resources.length)throw new Error('INVALID_CONSENT');
    const row=checked(await this.call(base,{method:'POST',headers:headers(s,key),body:JSON.stringify(body)},201),s);
    const versions=(v:Version[])=>JSON.stringify(v.map(r=>[r.artifact_id,r.version_id]).sort(([a],[b])=>a<b?-1:a>b?1:0));
    if(row.ticket_id!==body.ticket_id||row.purpose!==body.purpose||row.content_field!==body.content_field||
        versions(row.resources)!==versions(body.resources)||Date.parse(row.expires_at)-Date.parse(row.created_at)!==body.duration_seconds*1000)
      throw new ApiFailure(201,'UNCONFIRMED_RESPONSE');
    return row;
  }
  async revoke(s:UserSession,key:string,id:string) {
    if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw new Error('INVALID_ID');
    const row=checked(await this.call(base+'/'+encodeURIComponent(id),{method:'DELETE',headers:headers(s,key)}),s);
    if(row.authorization_id!==id||row.status!=='revoked')throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
    return row;
  }
}
