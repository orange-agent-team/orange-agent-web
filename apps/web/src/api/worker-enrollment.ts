import { Ajv2020 } from 'ajv/dist/2020.js';
import csrSchema from '../../../../docs/contracts/worker-certificate-request.schema.json' with { type: 'json' };
import contract from '../../../../docs/contracts/worker-enrollment.openapi.json' with { type: 'json' };
import { ApiFailure, UserClient } from './client';
import type { UserSession } from './contracts';

export type WorkerRequest = {
  version: 1; request_id: string; purpose: 'public_worker'; spki_sha256: string; csr_sha256: string; csr_pem: string;
};
export type EnrollmentHandoff = {request: WorkerRequest; exchange_token_sha256: string};
export type EnrollmentState = 'authorized' | 'certificate_prepared' | 'redeemed' | 'revoked' | 'expired';
export type EnrollmentView = {
  request_id: string; owner_id: string; requested_by: string; spki_sha256: string; csr_sha256: string; state: EnrollmentState; expires_unix: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validRequestId = (id: string) => id.length === 36 && uuid.test(id);
const ajv = new Ajv2020({strict:false});
ajv.addFormat('uuid',uuid);
const validHandoff = ajv.compile<EnrollmentHandoff>({
  type:'object',required:['request','exchange_token_sha256'],additionalProperties:false,
  properties:{request:csrSchema,exchange_token_sha256:{type:'string',pattern:'^[a-f0-9]{64}$',maxLength:64}},
});
const validView = ajv.compile<EnrollmentView>(contract.components.schemas.EnrollmentView);

export async function readEnrollmentHandoff(file: File): Promise<EnrollmentHandoff> {
  if (file.size > 8192 || file.size === 0) throw Error('INVALID_HANDOFF');
  const v: unknown = JSON.parse(await file.text());
  return validateEnrollmentHandoff(v);
}
export async function validateEnrollmentHandoff(v:unknown):Promise<EnrollmentHandoff> {
  if (!validHandoff(v)) throw Error('INVALID_HANDOFF');
  const {request:r,exchange_token_sha256:commitment}=v;
  if (!validRequestId(r.request_id) || r.spki_sha256.length!==64 || r.csr_sha256.length!==64 ||
      [r.spki_sha256,r.csr_sha256,'0'.repeat(64)].includes(commitment)) throw Error('INVALID_HANDOFF');
  const pem = r.csr_pem.replaceAll('\r\n','\n');
  const match = /^-----BEGIN CERTIFICATE REQUEST-----\n([A-Za-z0-9+/=\n]+)\n-----END CERTIFICATE REQUEST-----\n?$/.exec(pem);
  if (!match || match[0]!==pem) throw Error('INVALID_HANDOFF');
  const base64=match[1].replaceAll('\n','');
  const der=Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
  if (der.length<64 || der.length>3072 || btoa(String.fromCharCode(...der))!==base64) throw Error('INVALID_HANDOFF');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',der)),b=>b.toString(16).padStart(2,'0')).join('');
  if (hash!==r.csr_sha256) throw Error('CSR_DIGEST_MISMATCH');
  return v;
}
function endpoint(owner:string,id:string) {
  if (!owner || owner.length>128 || !validRequestId(id)) throw Error('INVALID_ENROLLMENT_SCOPE');
  return '/api/v1/owners/'+encodeURIComponent(owner)+'/worker-enrollments/'+id;
}
function confirmed(raw:unknown,owner:string,id:string):EnrollmentView{
  if (!validView(raw) || raw.owner_id!==owner || raw.request_id!==id || !raw.requested_by ||
      Number(raw.expires_unix)>8640000000000 || raw.spki_sha256.length!==64 || raw.csr_sha256.length!==64) throw Error('UNCONFIRMED_ENROLLMENT');
  return raw;
}
export class EnrollmentClient extends UserClient {
  async inspect(owner:string,id:string,signal:AbortSignal): Promise<EnrollmentView|null> {
    try{return confirmed(await this.call(endpoint(owner,id),{signal}),owner,id);}
    catch(e){if(e instanceof ApiFailure && e.status===404 && e.code==='ENROLLMENT_NOT_FOUND')return null;throw e;}
  }
  async authorize(session:UserSession,owner:string,handoff:EnrollmentHandoff,signal:AbortSignal){
    const r=handoff.request;
    const result=confirmed(await this.call(endpoint(owner,r.request_id),{method:'PUT',signal,headers:{
      'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':r.request_id},
      body:JSON.stringify(handoff)}),owner,r.request_id);
    if(result.requested_by!==session.user_id || result.csr_sha256!==r.csr_sha256 || result.spki_sha256!==r.spki_sha256)throw Error('UNCONFIRMED_ENROLLMENT');
    return result;
  }
  async revoke(session:UserSession,owner:string,original:EnrollmentView,signal:AbortSignal){
    const id=original.request_id;
    const result=confirmed(await this.call(endpoint(owner,id),{method:'DELETE',signal,headers:{
      'X-CSRF-Token':session.csrf_token,'Idempotency-Key':id}}),owner,id);
    if(result.state!=='revoked' || result.csr_sha256!==original.csr_sha256 || result.spki_sha256!==original.spki_sha256 ||
      result.requested_by!==original.requested_by || result.expires_unix!==original.expires_unix)throw Error('UNCONFIRMED_ENROLLMENT');
    return result;
  }
}
