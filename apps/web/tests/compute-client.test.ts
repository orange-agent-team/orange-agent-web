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
