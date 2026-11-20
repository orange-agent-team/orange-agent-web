import { UserClient, ApiFailure } from './client';
import type { UserSession } from './contracts';
import { decodeCompute, pathId, sha256, MODEL_RESPONSE_MEDIA, type Artifact, type Upload, type QuoteRequest, type Submission, type Job } from './compute-contracts';
/** Content denial is scoped to this result. It is not itself a revoked login. */
export class ContentUnavailable extends Error {}
const write = (session: UserSession, key: string) => { pathId(key); return { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': key }; };
const audioFormats: Readonly<Record<string,string>> = { 'audio/wav':'wav', 'audio/flac':'flac', 'audio/mpeg':'mp3', 'audio/ogg':'ogg', 'audio/mp4':'mov' };
const base = (session: UserSession) => `/api/v1/owners/${pathId(session.personal_owner_id)}`;
export class ComputeClient extends UserClient {
 async prices(signal?: AbortSignal) {
  const data = await this.call('/api/v1/text-prices', { signal });
  if (!Array.isArray(data) || data.length > 1000) throw new Error('INVALID_PRICE_LIST');
  return data.map(value => decodeCompute('Price', value));
 }
 private ownedArtifact(session: UserSession, value: unknown, upload?: string) {
  const artifact = decodeCompute('Artifact', value);
  if (artifact.owner_id !== session.personal_owner_id || (upload !== undefined && artifact.upload_id !== upload)) throw new ApiFailure(403, 'ACTOR_MISMATCH');
  return artifact;
 }
 async beginUpload(session: UserSession, request: Upload, signal?: AbortSignal) {
  decodeCompute('Upload', request);
  const artifact = this.ownedArtifact(session, await this.call(`${base(session)}/uploads`, { method: 'POST', headers: write(session, request.upload_id), body: JSON.stringify(request), signal }), request.upload_id);
  if (artifact.sha256 !== request.sha256 || artifact.size_bytes !== request.size_bytes || artifact.media_type !== request.media_type) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return artifact;
 }
 async deleteUpload(session: UserSession, upload: string) {
  const artifact=this.ownedArtifact(session,await this.call(`${base(session)}/uploads/${pathId(upload)}`,{method:'DELETE',headers:write(session,upload)}),upload);
  if(artifact.state!=='deleted')throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');return artifact;
 }
 async uploadStatus(session: UserSession, upload: string, signal?: AbortSignal) {
  return this.ownedArtifact(session, await this.call(`${base(session)}/uploads/${pathId(upload)}`, { signal }), upload);
 }
 async putInput(session: UserSession, request: Upload, bytes: Uint8Array) {
  decodeCompute('Upload', request);
  if (bytes.byteLength === 0 || bytes.byteLength > 262144 || request.size_bytes !== bytes.byteLength.toString() || request.sha256 !== await sha256(bytes)) throw new Error('INPUT_BYTES_CHANGED');
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return this.putContent(session, request, owned.buffer);
 }
 async putAudio(session: UserSession, request: Upload, file: File, signal: AbortSignal) {
  decodeCompute('Upload', request);
  if (!request.media_type.startsWith('audio/') || file.size < 1 || file.size > 100000000 || request.size_bytes !== String(file.size)) throw new Error('INVALID_AUDIO');
  return this.putContent(session, request, file, signal, 300000);
 }
 private async putContent(session: UserSession, request: Upload, body: BodyInit, signal?: AbortSignal, timeoutMs = 15000) {
  const artifact = this.ownedArtifact(session, await this.call(`${base(session)}/uploads/${pathId(request.upload_id)}/content`, { method: 'PUT', headers: { ...write(session,request.upload_id), 'Content-Type': 'application/octet-stream' }, body, signal }, 200, timeoutMs),request.upload_id);
  if (artifact.state !== 'available' || artifact.sha256 !== request.sha256 || artifact.size_bytes !== request.size_bytes || artifact.media_type !== request.media_type) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return artifact;
 }
 async measureAudio(session: UserSession, input: Artifact, signal?: AbortSignal) {
  this.ownedArtifact(session, input);
  if (input.state !== 'available' || !audioFormats[input.media_type]) throw new Error('INVALID_AUDIO');
  const data = await this.call(`${base(session)}/uploads/${pathId(input.upload_id)}/transcription-measurements`, {
   method:'POST', headers:write(session,input.upload_id), body:JSON.stringify({version_id:input.version_id}), signal,
  }, 200, 90000);
  const result = decodeCompute('AudioMeasurement', data);
  if (result.source_samples.length > 9 || result.normalized_samples.length > 7 || result.duration_ms.length > 6) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  const rate = BigInt(result.source_sample_rate), samples = BigInt(result.source_samples);
  const normalized = BigInt(result.normalized_samples);
  const difference = normalized * rate - samples * 16000n;
  const duration = (samples * 1000n + rate - 1n) / rate;
  if (result.artifact_id !== input.artifact_id || result.version_id !== input.version_id || result.audio_sha256 !== input.sha256 ||
      result.format !== audioFormats[input.media_type] || duration !== BigInt(result.duration_ms) || duration > 600000n ||
      normalized > 9600000n || difference > 2n*rate || difference < -2n*rate) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return result;
 }
 async quote(session: UserSession, request: QuoteRequest) {
  decodeCompute('QuoteRequest', request);
  const result = decodeCompute('Quote', await this.call(`${base(session)}/text-quotes`, { method: 'POST', headers: write(session,request.request_id), body: JSON.stringify(request) },201));
  if (result.root_budget_id !== request.root_budget_id || result.price_version !== request.price_version || result.output_limit !== request.output_limit.toString()) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return result;
 }
 async submit(session: UserSession, key: string, request: Submission) {
  decodeCompute('Submission',request);
  const job = decodeCompute('Job', await this.call(`${base(session)}/jobs`, { method: 'POST', headers: write(session,key), body: JSON.stringify(request) }));
  if (job.root_budget_id !== request.root_budget_id || job.invocation_id !== request.invocation_id) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return job;
 }
 async bind(session: UserSession, job: Job, input: Artifact, projection: string) {
  decodeCompute('Job',job); this.ownedArtifact(session,input);
  const result = decodeCompute('InputBinding', await this.call(`${base(session)}/jobs/${pathId(job.job_id)}/input`, { method: 'POST', headers: write(session,job.job_id), body: JSON.stringify({ upload_id: input.upload_id, version_id: input.version_id }) }));
  if (result.job_id !== job.job_id || result.artifact_id !== input.artifact_id || result.version_id !== input.version_id || result.sha256 !== input.sha256 || result.size_bytes !== input.size_bytes || result.projection_digest !== projection) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return result;
 }
 async jobs(session: UserSession, after?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' }); if (after) params.set('after',after);
  const page = decodeCompute('JobPage',await this.call(`${base(session)}/jobs?${params}`,{ signal }));
  if (page.owner_id !== session.personal_owner_id || page.user_id !== session.user_id) throw new ApiFailure(403,'ACTOR_MISMATCH'); return page;
 }
 async lookup(session: UserSession, invocation: string, signal?: AbortSignal) {
  let value: unknown;
  try { value = await this.call(`${base(session)}/jobs/by-invocation/${pathId(invocation)}`,{ signal }); }
  catch (error) { if (error instanceof ApiFailure && error.status === 404) return null; throw error; }
  const result = decodeCompute('JobLookup',value);
  if (result.owner_id !== session.personal_owner_id || result.user_id !== session.user_id || result.job.invocation_id !== invocation) throw new ApiFailure(403,'ACTOR_MISMATCH'); return result;
 }
 async job(session: UserSession, id: string, signal?: AbortSignal) {
  const job = decodeCompute('Job',await this.call(`${base(session)}/jobs/${pathId(id)}`,{ signal }));
  if (job.job_id !== id) throw new ApiFailure(403,'ACTOR_MISMATCH'); return job;
 }
 async withdraw(session:UserSession,key:string,request:Submission){
  decodeCompute('Submission',request);
  const value=decodeCompute('Withdrawal',await this.call(`${base(session)}/invocations/${pathId(request.invocation_id)}/withdraw`,{method:'POST',headers:write(session,key),body:JSON.stringify(request)}));
  if(value.owner_id!==session.personal_owner_id||value.user_id!==session.user_id||value.invocation_id!==request.invocation_id||value.quote_id!==request.quote_id||(value.job&&(value.job.invocation_id!==request.invocation_id||value.job.root_budget_id!==request.root_budget_id)))throw new ApiFailure(403,'ACTOR_MISMATCH');return value;
 }
 async cancel(session: UserSession, id: string, key: string) {
  const job = decodeCompute('Job',await this.call(`${base(session)}/jobs/${pathId(id)}/cancel`,{ method: 'POST', headers: write(session,key), body: '{}' }));
  if (job.job_id !== id) throw new ApiFailure(403,'ACTOR_MISMATCH'); return job;
 }
 async result(session: UserSession, id: string, signal?: AbortSignal) {
  let value: unknown;
  try { value = await this.call(`${base(session)}/jobs/${pathId(id)}/result`,{ signal }); }
  catch (error) { if (error instanceof ApiFailure && [403,410].includes(error.status)) throw new ContentUnavailable('CONTENT_UNAVAILABLE'); throw error; }
  return this.ownedArtifact(session,value);
 }
 async resultText(session: UserSession, artifact: Artifact, external?: AbortSignal) {
  this.ownedArtifact(session,artifact);
  if (artifact.state !== 'available' || artifact.media_type !== MODEL_RESPONSE_MEDIA || BigInt(artifact.size_bytes) < 1n || BigInt(artifact.size_bytes) > 1048576n) throw new Error('INVALID_RESULT_DESCRIPTOR');
  const deadline = new AbortController(), cancel = () => deadline.abort();
  if (external?.aborted) cancel(); else external?.addEventListener('abort',cancel,{ once: true });
  const timer = setTimeout(cancel,30000);
  try {
   const url = `${base(session)}/uploads/${pathId(artifact.upload_id)}/content?${new URLSearchParams({ version_id: artifact.version_id })}`;
   const response = await this.fetcher(url,{ signal: deadline.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/octet-stream' } });
   if (response.status !== 200 || !response.body) { await response.body?.cancel(); if ([403,410].includes(response.status)) throw new ContentUnavailable('CONTENT_UNAVAILABLE'); throw new ApiFailure(response.status,'RESULT_UNAVAILABLE'); }
   const length = response.headers.get('Content-Length');
   if (length !== null && length !== artifact.size_bytes) { await response.body.cancel(); throw new Error('RESULT_LENGTH_MISMATCH'); }
   const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
   try {
    for (;;) { const read = await reader.read(); if (read.done) break; size += read.value.byteLength; if (size > Number(artifact.size_bytes)) throw new Error('RESULT_TOO_LARGE'); chunks.push(read.value); }
   } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
   if (size !== Number(artifact.size_bytes)) throw new Error('RESULT_LENGTH_MISMATCH');
   const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
   if (await sha256(bytes) !== artifact.sha256) throw new Error('RESULT_HASH_MISMATCH');
   const result = decodeCompute('Result',JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes)));
   if (result.finish_reason !== 'stop' || result.tool_calls.length) throw new Error('UNREQUESTED_MODEL_TOOL');
   if (external?.aborted) throw new DOMException('aborted','AbortError'); return result.text;
  } finally { clearTimeout(timer); external?.removeEventListener('abort',cancel); }
 }
}
