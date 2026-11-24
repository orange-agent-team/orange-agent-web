import {describe,expect,it} from 'vitest';
import {RotationClient,readRotationHandoff,matchesRotation,type RotationView} from '../src/api/worker-rotation';

const old='dc05e611-96d4-4caa-a68b-67e06b537955',next='8796a375-3d3f-494a-b463-2bd05365ccec',node='deef72b3-313c-4be7-ae59-fefe70bef9ef',owner='rotation-owner';
async function sample(){
  const bytes=Buffer.alloc(80,43);
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const intent={version:1,owner_id:owner,node_id:node,previous_request_id:old,previous_certificate_sha256:'1'.repeat(64),previous_issuer_sha256:'2'.repeat(64),
    replacement:{request:{version:1,request_id:next,purpose:'public_worker',spki_sha256:'3'.repeat(64),csr_sha256:hash,csr_pem:'-----BEGIN CERTIFICATE REQUEST-----\n'+bytes.toString('base64')+'\n-----END CERTIFICATE REQUEST-----\n'},exchange_token_sha256:'4'.repeat(64)}};
  return {intent,previous_key_signature:Buffer.alloc(64).toString('base64url')};
}
const file=(value:unknown)=>new File([JSON.stringify(value)],'handoff.json',{type:'application/json'});
describe('owner certificate rotation',()=>{
  it('rejects private fields, wrong owner and noncanonical signature; binds the exact predecessor and replacement',async()=>{
    const source=await sample();const input=await readRotationHandoff(file(source),owner);
    await expect(readRotationHandoff(file(source),'another-owner')).rejects.toThrow();
    await expect(readRotationHandoff(file({...source,token:'private'}),owner)).rejects.toThrow();
    await expect(readRotationHandoff(file({...source,previous_key_signature:source.previous_key_signature.slice(0,-1)+'B'}),owner)).rejects.toThrow();
    const changed=structuredClone(source);changed.intent.previous_certificate_sha256='5'.repeat(64);
    expect((await readRotationHandoff(file(changed),owner)).digest).not.toBe(input.digest);
    const view:RotationView={enrollment:{request_id:next,owner_id:owner,requested_by:'user',state:'authorized',expires_unix:'1000',
      spki_sha256:source.intent.replacement.request.spki_sha256,csr_sha256:source.intent.replacement.request.csr_sha256},
      node_id:node,previous_request_id:old,previous_certificate_sha256:source.intent.previous_certificate_sha256,intent_sha256:input.digest,
      predecessor_eligible:true,activated_unix:null,overlap_until_unix:null};
    expect(matchesRotation(view,input)).toBe(true);
    expect(matchesRotation({...view,node_id:old},input)).toBe(false);
    const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    for(const bad of [{...view,enrollment:{...view.enrollment,owner_id:'other'}},{...view,activated_unix:'100'},{...view,activated_unix:'100',overlap_until_unix:'221'}]){
      const client=new RotationClient(async()=>response(bad));
      await expect(client.inspect(owner,next,new AbortController().signal)).rejects.toThrow();
    }
  });
});
