import { describe, expect, it, vi } from 'vitest';
import { ComputeClient, ContentUnavailable } from '../src/api/compute-client';
import { decodeCompute, modelInput, pathId, sha256, MODEL_RESPONSE_MEDIA, type Artifact } from '../src/api/compute-contracts';
import type { UserSession } from '../src/api/contracts';
const session: UserSession = { session_id: 'session', user_id: 'user', personal_owner_id: 'owner', csrf_token: 'c'.repeat(43), expires_at: '2099-01-01T00:00:00Z' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const job = { job_id: 'job', root_budget_id: 'budget', invocation_id: 'invocation', execution_state: 'queued', settlement_state: 'pending', reserved: '100', charge: null };
const result = { response_id: 'response', text: '<script>untrusted model text</script>', tool_calls: [], native_usage: null, finish_reason: 'stop' };
async function descriptor(bytes: Uint8Array, media_type = 'application/json'): Promise<Artifact> { return { upload_id: 'upload:original', artifact_id: 'artifact', version_id: 'version', owner_id: session.personal_owner_id, sha256: await sha256(bytes), size_bytes: bytes.length.toString(), media_type, state: 'available' }; }
describe('fixed-contract model Job client', () => {
 it('builds bounded tool-free input and refuses path traversal and invalid Unicode', () => {
  const value = JSON.parse(new TextDecoder().decode(modelInput('invocation','model','Keep exact whitespace.\n',32)));
  expect(value.messages).toEqual([{ role: 'user', content: 'Keep exact whitespace.\n' }]); expect(value.tools).toEqual([]);
  for (const id of ['..','a/b','a?owner=other','https://other']) expect(() => pathId(id)).toThrow();
  expect(() => modelInput('invocation','model','\ud800',32)).toThrow(); expect(() => modelInput('invocation','model','x'.repeat(262144),32)).toThrow();
 });
 it('binds exact uploaded bytes and keeps raw stable keys rather than URL-encoding headers', async () => {
  const bytes = modelInput('invocation','model','Hello',32), artifact = await descriptor(bytes);
  const upload = { upload_id: artifact.upload_id, sha256: artifact.sha256, size_bytes: artifact.size_bytes, media_type: 'application/json' as const };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(artifact)), client = new ComputeClient(fetcher);
  await client.putInput(session,upload,bytes); expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('upload:original'); expect(fetcher.mock.calls[0][0]).toContain('upload%3Aoriginal');
  await expect(client.putInput(session,upload,modelInput('invocation','model','Different',32))).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json({ ...artifact, sha256: '0'.repeat(64) }))).beginUpload(session,upload)).rejects.toMatchObject({ code: 'UNCONFIRMED_RESPONSE' });
 });
 it('rejects mismatched quote, job, actor and impossible monetary facts', async () => {
  const quote = { quote_id: 'quote', root_budget_id: 'wrong-budget', invocation_id: 'invocation', price_version: 'price', request_projection_digest: 'a'.repeat(64), meter_profile_digest: 'b'.repeat(64), input_units: '1', output_limit: '32', max_amount: '100', expires_at_unix: '4102444800' };
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json(quote,201))).quote(session,{ request_id: 'request', root_budget_id: 'budget', price_version: 'price', input_upload_id: 'upload', input_version_id: 'version', output_limit: 32 })).rejects.toMatchObject({ code: 'UNCONFIRMED_RESPONSE' });
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json({ ...job, job_id: 'different' }))).job(session,'job')).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json({ owner_id: 'other', user_id: 'user', data: [], next_cursor: null }))).jobs(session)).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
  expect(() => decodeCompute('Job',{ ...job, charge: '101' })).toThrow(); expect(() => decodeCompute('Job',{ ...job, reserved: '9223372036854775808' })).toThrow();
 });
 it('binds a definitive withdrawal receipt to the original user, Invocation and quote',async()=>{
  const request={root_budget_id:'budget',invocation_id:'invocation',purpose:'primary' as const,quote_id:'quote',request_projection_digest:'a'.repeat(64)};
  const receipt={owner_id:'owner',user_id:'user',invocation_id:'invocation',quote_id:'quote',prevented:true,receipt_id:'receipt',job:null};
  const client=new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json(receipt)));expect((await client.withdraw(session,'original-key',request)).prevented).toBe(true);
  for(const bad of [{...receipt,user_id:'other'},{...receipt,quote_id:'other'},{...receipt,receipt_id:null},{...receipt,job}])await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json(bad))).withdraw(session,'original-key',request)).rejects.toThrow();
 });
 it('verifies original result length/hash and never grants model tool effects', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(result)), artifact = await descriptor(bytes,MODEL_RESPONSE_MEDIA);
  const good = new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes,{ headers: { 'Content-Length': artifact.size_bytes } })));
  expect(await good.resultText(session,artifact)).toBe(result.text);
  await expect(new ComputeClient(vi.fn<typeof fetch>()).resultText(session,{...artifact,media_type:'application/json'})).rejects.toThrow('INVALID_RESULT_DESCRIPTOR');
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes))).resultText(session,{ ...artifact, sha256: '0'.repeat(64) })).rejects.toThrow('RESULT_HASH_MISMATCH');
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes,{ headers: { 'Content-Length': '1' } }))).resultText(session,artifact)).rejects.toThrow('RESULT_LENGTH_MISMATCH');
  const tool = new TextEncoder().encode(JSON.stringify({ ...result, finish_reason: 'tool_calls', tool_calls: [{ id: 'call', name: 'dangerous', arguments: {} }] }));
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(tool))).resultText(session,await descriptor(tool,MODEL_RESPONSE_MEDIA))).rejects.toThrow('UNREQUESTED_MODEL_TOOL');
 });
 it('scopes content deletion separately from identity substitution and refuses oversized metadata', async () => {
  await expect(new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json({ code: 'FORBIDDEN', message: 'fixture', request_id: 'error', retry_class: 'never' },403))).result(session,'job')).rejects.toBeInstanceOf(ContentUnavailable);
  const bytes = new TextEncoder().encode(JSON.stringify(result)), artifact = await descriptor(bytes,MODEL_RESPONSE_MEDIA), fetcher = vi.fn<typeof fetch>();
  await expect(new ComputeClient(fetcher).resultText(session,{ ...artifact, owner_id: 'other' })).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
  await expect(new ComputeClient(fetcher).resultText(session,{ ...artifact, size_bytes: '1048577' })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
 });
});

describe('immutable audio measurement', () => {
 it('checks the actual version, input digest, container, decoded duration and resampling counts', async () => {
  const input = await descriptor(new Uint8Array([0,1,2]), 'audio/wav');
  const measured = {artifact_id:input.artifact_id, version_id:input.version_id, audio_sha256:input.sha256,
   model_version:'whisper-small-ct2-int8-cpu-v1', preprocessing:'mono-16khz-s16-f32-v1', format:'wav',
   codec:'pcm_s16le', source_sample_rate:16000, source_samples:'17', normalized_samples:'17',
   normalized_sha256:'c'.repeat(64), duration_ms:'2'};
  const fetcher = vi.fn(async () => json(measured));
  await expect(new ComputeClient(fetcher).measureAudio(session,input)).resolves.toEqual(measured);
  expect(fetcher).toHaveBeenCalledWith('/api/v1/owners/owner/uploads/upload%3Aoriginal/transcription-measurements',
    expect.objectContaining({method:'POST',body:JSON.stringify({version_id:input.version_id})}));
  for (const changed of [{duration_ms:'1'},{normalized_samples:'9'},{source_samples:'1234567890'},
    {artifact_id:'other'},{version_id:'other'},{audio_sha256:'a'.repeat(64)},{format:'ogg'},{charge:'1'}]) {
    const invalid = new ComputeClient(async () => json({...measured,...changed}));
    await expect(invalid.measureAudio(session,input)).rejects.toThrow();
  }
 });
});

it('keeps the authenticated user separate from the chosen organization when checking artifacts and task metadata',async()=>{
  const value={upload_id:'upload',artifact_id:'artifact',version_id:'v1',owner_id:'org',sha256:'a'.repeat(64),size_bytes:'1',media_type:'text/plain',state:'available'};
  const fetcher=vi.fn(async()=>json(value));const client=new ComputeClient(fetcher,'org');
  expect((await client.uploadStatus(session,'upload')).owner_id).toBe('org');
  expect(fetcher).toHaveBeenCalledWith('/api/v1/owners/org/uploads/upload',expect.anything());
  const wrong=new ComputeClient(async()=>json({...value,owner_id:session.personal_owner_id}),'org');
  await expect(wrong.uploadStatus(session,'upload')).rejects.toMatchObject({status:403,code:'ACTOR_MISMATCH'});
  const foreign=new ComputeClient(async()=>json({owner_id:'org',user_id:'another-user',data:[],next_cursor:null}),'org');
  await expect(foreign.jobs(session)).rejects.toMatchObject({status:403,code:'ACTOR_MISMATCH'});
});

it('binds funding to the original quote, actor, scope, ceiling and complete budget arithmetic',async()=>{
  const q={quote_id:'q',price_version:'p',root_budget_id:'root',max_amount:'100',expires_at_unix:'4102444800'};
  const original={quote_id:'q',price_version:'p',requester_id:session.user_id,owner_id:session.personal_owner_id,account_kind:'personal',root_budget_id:'root',
    max_microcredits:'100',budget_limit:'300',budget_spent:'80',budget_reserved:'100',budget_remaining:'120',wallet_available:'120',
    status:'sufficient',observed_unix:'1800000000',expires_unix:'4102444800'};
  async function read(patch:Record<string,unknown>){return new ComputeClient(vi.fn<typeof fetch>().mockResolvedValue(json({...original,...patch}))).funding(session,q);}
  expect((await read({})).budget_spent).toBe('80');
  for(const changed of [{quote_id:'other'},{requester_id:'other'},{owner_id:'other'},{price_version:'other'},{root_budget_id:'other'},
    {max_microcredits:'99'},{wallet_available:null},{budget_remaining:'121'},{wallet_available:'99'}]){
    await expect(read(changed)).rejects.toThrow();
  }
});

describe('conditional Job cancellation',()=>{
 function storage(): Storage {
  const data=new Map<string,string>();
  return {get length(){return data.size;},getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);},removeItem:k=>{data.delete(k);},
          clear:()=>data.clear(),key:i=>[...data.keys()][i]??null};
 }
 const seen=(options?: RequestInit)=>new Headers(options?.headers);
 it('reads a fixed-width-independent decimal revision and refuses malformed server metadata',async()=>{
  const make=(revision?:string)=>new ComputeClient(async()=>{
   const reply=json(job); if(revision!==undefined)reply.headers.set('x-orange-job-version',revision);return reply;
  });
  expect((await make('9007199254740993').jobSnapshot(session,'job')).revision).toBe('9007199254740993');
  expect((await make().jobSnapshot(session,'job')).revision).toBeUndefined();
  for(const invalid of ['0','01','1, 2','9223372036854775808']){
   await expect(make(invalid).jobSnapshot(session,'job')).rejects.toMatchObject({code:'INVALID_JOB_REVISION'});
  }
 });
 it('keeps the first observed version and key after a lost response and a reload',async()=>{
  const local=storage();
  let key:string|null=null;
  const first=new ComputeClient(async(_path,init)=>{
   const h=seen(init);expect(h.get('x-orange-expected-job-version')).toBe('4');key=h.get('idempotency-key');throw new Error('response lost');
  });
  await expect(first.cancelObserved(session,'job','4',local)).rejects.toMatchObject({status:0});
  const restored=new ComputeClient(async(_path,init)=>{
   const h=seen(init);expect(h.get('x-orange-expected-job-version')).toBe('4');expect(h.get('idempotency-key')).toBe(key);
   return json({...job,execution_state:'cancelled',settlement_state:'settled',charge:'0'});
  });
  expect((await restored.cancelObserved(session,'job','7',local)).execution_state).toBe('cancelled');
  expect(local.length).toBe(0);
 });
 it('clears only a definitely stale command; rechecking status alone sends no new cancellation',async()=>{
  const local=storage();const keys:string[]=[];
  const api=new ComputeClient(async(_path,init)=>{
   const h=seen(init);keys.push(h.get('idempotency-key')!);
   return keys.length===1?json({code:'STALE_JOB_VERSION',message:'stale',request_id:'fixture',retry_class:'query_original'},412):json(job);
  });
  await expect(api.cancelObserved(session,'job','2',local)).rejects.toMatchObject({status:412,code:'STALE_JOB_VERSION'});
  expect(local.length).toBe(0);expect(keys).toHaveLength(1);
  await api.cancelObserved(session,'job','3',local);expect(keys[1]).not.toBe(keys[0]);
 });
 it('reuses a pre-upgrade receipt without changing its original precondition or raw key',async()=>{
  const local=storage(),oldJob={...job,job_id:'job:legacy'};
  local.setItem('orange-cancel-v1:'+JSON.stringify([session.user_id,session.personal_owner_id,oldJob.job_id]),'old:key');
  const api=new ComputeClient(async(_path,init)=>{
   const h=seen(init);expect(h.get('idempotency-key')).toBe('old:key');expect(h.has('x-orange-expected-job-version')).toBe(false);return json(oldJob);
  });
  await api.cancelObserved(session,oldJob.job_id,'2',local);expect(local.length).toBe(0);
 });
});
