import {describe,expect,it} from 'vitest';
import {EnrollmentClient,readEnrollmentHandoff,type EnrollmentHandoff,type EnrollmentView} from '../src/api/worker-enrollment';
import type {UserSession} from '../src/api/contracts';
const rid='fa3e0baf-4181-4dcb-8f7c-63664183d4b5';
const owner='device-owner';
const session:UserSession={user_id:'user',session_id:'session',personal_owner_id:owner,csrf_token:'csrf',expires_at:'2030-01-01T00:00:00Z'};
const source:EnrollmentHandoff={exchange_token_sha256:'a'.repeat(64),request:{request_id:rid,version:1,purpose:'public_worker',spki_sha256:'b'.repeat(64),csr_sha256:'c'.repeat(64),csr_pem:'-----BEGIN CERTIFICATE REQUEST-----'}};
const ack:EnrollmentView={request_id:rid,owner_id:owner,requested_by:'user',spki_sha256:source.request.spki_sha256,csr_sha256:source.request.csr_sha256,state:'authorized',expires_unix:'1790000000'};
const reply=(v:unknown)=>new EnrollmentClient(async()=>new Response(JSON.stringify(v),{status:200}));
const signal=new AbortController().signal;
describe('worker enrollment acknowledgment',()=>{
  it('binds write to the selected owner, original UUID, request, and current user',async()=>{
    let sent:RequestInit|undefined;
    const client=new EnrollmentClient(async(url,init)=>{expect(url).toBe('/api/v1/owners/'+owner+'/worker-enrollments/'+rid);sent=init;return new Response(JSON.stringify(ack));});
    expect(await client.authorize(session,owner,source,signal)).toEqual(ack);
    expect(new Headers(sent?.headers).get('Idempotency-Key')).toBe(rid);
    expect(JSON.parse(String(sent?.body))).toEqual(source);
    for(const altered of [{owner_id:'other'},{requested_by:'other'},{request_id:crypto.randomUUID()},{spki_sha256:'e'.repeat(64)},{csr_sha256:'f'.repeat(64)},{private_material:'unexpected'}]){
      await expect(reply({...ack,...altered}).authorize(session,owner,source,signal)).rejects.toThrow();
    }
  });
  it('checks the original revocation and refuses unrecognized receipt states',async()=>{
    expect((await reply({...ack,state:'revoked'}).revoke(session,owner,ack,signal)).state).toBe('revoked');
    for(const altered of [{state:'authorized'},{state:'online'},{state:'revoked',expires_unix:'1790000099'},{state:'revoked',requested_by:'other'}]){
      await expect(reply({...ack,...altered}).revoke(session,owner,ack,signal)).rejects.toThrow();
    }
    await expect(reply({...ack,expires_unix:'999999999999999999999'}).inspect(owner,rid,signal)).rejects.toThrow();
  });
  it('treats only an enrollment-specific 404 as an unused request ID',async()=>{
    const error=(code:string)=>new EnrollmentClient(async()=>new Response(JSON.stringify({code,message:code,request_id:rid,retry_class:'never'}),{status:404}));
    expect(await error('ENROLLMENT_NOT_FOUND').inspect(owner,rid,signal)).toBeNull();
    await expect(error('NOT_FOUND').inspect(owner,rid,signal)).rejects.toThrow();
  });
  it('limits local upload size and rejects private fields before transport',async()=>{
    const file=(text:string)=>new File([text],'public.json',{type:'application/json'});
    await expect(readEnrollmentHandoff(file('x'.repeat(8193)))).rejects.toThrow();
    await expect(readEnrollmentHandoff(file(JSON.stringify({...source,token:'unacceptable'})))).rejects.toThrow();
  });
});
