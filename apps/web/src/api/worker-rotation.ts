import {Ajv2020} from 'ajv/dist/2020.js';
import contract from '../../../../docs/contracts/worker-enrollment.openapi.json' with {type:'json'};
import csrSchema from '../../../../docs/contracts/worker-certificate-request.schema.json' with {type:'json'};
import {ApiFailure,UserClient} from './client';
import type {UserSession} from './contracts';
import {validRequestId,validateEnrollmentHandoff,type EnrollmentHandoff,type EnrollmentView} from './worker-enrollment';

type Intent = {version:1;owner_id:string;node_id:string;previous_request_id:string;previous_certificate_sha256:string;previous_issuer_sha256:string;replacement:EnrollmentHandoff};
export type RotationInput = {handoff:{intent:Intent;previous_key_signature:string};digest:string};
export type RotationView = {enrollment:EnrollmentView;node_id:string;previous_request_id:string;previous_certificate_sha256:string;
  intent_sha256:string;predecessor_eligible:boolean;activated_unix:string|null;overlap_until_unix:string|null};
const schemas=contract.components.schemas;
const ajv=new Ajv2020({strict:false});
ajv.addFormat('uuid',/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
ajv.addSchema(csrSchema,'../json-schema/worker-certificate-request.v1.json');
const validHandoff=ajv.compile<RotationInput['handoff']>(schemas.RotationHandoff);
const validView=ajv.compile<RotationView>({...schemas.RotationView,properties:{...schemas.RotationView.properties,enrollment:schemas.EnrollmentView}});
const validEnrollment=ajv.compile<EnrollmentView>(schemas.EnrollmentView);
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export async function readRotationHandoff(file:File,owner:string):Promise<RotationInput>{
  if(!file.size||file.size>16384)throw Error('INVALID_ROTATION');
  const input:unknown=JSON.parse(await file.text());
  if(!validHandoff(input))throw Error('INVALID_ROTATION');
  const intent=input.intent;
  await validateEnrollmentHandoff(intent.replacement);
  if(intent.owner_id!==owner||intent.previous_request_id===intent.replacement.request.request_id||
    !validRequestId(intent.node_id)||!validRequestId(intent.previous_request_id))throw Error('ROTATION_SCOPE_MISMATCH');
  const sig=atob(input.previous_key_signature.replaceAll('-','+').replaceAll('_','/')+'==');
  if(sig.length!==64||btoa(sig).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==input.previous_key_signature)throw Error('INVALID_ROTATION_SIGNATURE');
  const message=new TextEncoder().encode('orange-request-v1\0worker-certificate-rotation.v1\0'+JSON.stringify(canonical(intent)));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',message)),v=>v.toString(16).padStart(2,'0')).join('');
  return {handoff:input,digest};
}
function url(owner:string,id:string){
  if(!owner||owner.length>128||!validRequestId(id))throw Error('INVALID_ROTATION_SCOPE');
  return '/api/v1/owners/'+encodeURIComponent(owner)+'/worker-certificate-rotations/'+id;
}
export function matchesRotation(v:RotationView,input:RotationInput){
  const i=input.handoff.intent;
  return v.intent_sha256===input.digest && v.node_id===i.node_id && v.previous_request_id===i.previous_request_id &&
    v.previous_certificate_sha256===i.previous_certificate_sha256 && v.enrollment.owner_id===i.owner_id &&
    v.enrollment.request_id===i.replacement.request.request_id && v.enrollment.csr_sha256===i.replacement.request.csr_sha256 &&
    v.enrollment.spki_sha256===i.replacement.request.spki_sha256;
}
export class RotationClient extends UserClient{
  async inspect(owner:string,id:string,signal:AbortSignal):Promise<RotationView|null>{
    let value:unknown;
    try{value=await this.call(url(owner,id),{signal});}
    catch(e){if(e instanceof ApiFailure && e.status===404 && e.code==='ENROLLMENT_ROTATION_NOT_FOUND')return null;throw e;}
    if(!validView(value)||value.enrollment.owner_id!==owner||value.enrollment.request_id!==id||
      !validRequestId(value.node_id)||!validRequestId(value.previous_request_id)||value.previous_request_id===id||
      (value.activated_unix===null)!==(value.overlap_until_unix===null)||
      (value.activated_unix!==null && (Number(value.overlap_until_unix)<Number(value.activated_unix)||
        Number(value.overlap_until_unix)>Number(value.activated_unix)+120))){throw Error('UNCONFIRMED_ROTATION');}
    return value;
  }
  async authorize(session:UserSession,owner:string,input:RotationInput,signal:AbortSignal){
    const i=input.handoff.intent,r=i.replacement.request;
    if(i.owner_id!==owner)throw Error('ROTATION_SCOPE_MISMATCH');
    const body:unknown=await this.call(url(owner,r.request_id),{method:'PUT',signal,headers:{
      'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':r.request_id},body:JSON.stringify(input.handoff)});
    if(!validEnrollment(body)||body.owner_id!==owner||body.request_id!==r.request_id||body.requested_by!==session.user_id||
      body.spki_sha256!==r.spki_sha256||body.csr_sha256!==r.csr_sha256)throw Error('UNCONFIRMED_ROTATION');
  }
}
