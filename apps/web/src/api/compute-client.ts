import { UserClient, ApiFailure } from './client';
import type { UserSession } from './contracts';
import { isArtifactError, decodeCompute, pathId, sha256, MODEL_RESPONSE_MEDIA, TRANSCRIPTION_MEDIA, type AudioGrantRequest, type AudioGrantReceipt, type AudioPrice, type Artifact, type Upload, type QuoteRequest, type Submission, type Job } from './compute-contracts';
/** Content denial is scoped to this result. It is not itself a revoked login. */
export class ContentUnavailable extends Error {}
const write = (session: UserSession, key: string) => { pathId(key); return { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': key }; };
const audioFormats: Readonly<Record<string,string>> = { 'audio/wav':'wav', 'audio/flac':'flac', 'audio/mpeg':'mp3', 'audio/ogg':'ogg', 'audio/mp4':'mov' };

function validatedVersion(value:string):string{
 if(!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value)>9223372036854775807n) throw new ApiFailure(0,'INVALID_JOB_REVISION');
 return value;
}

export class ComputeClient extends UserClient {
 constructor(fetcher?:typeof fetch,private readonly selectedOwner?:string){super(fetcher);if(selectedOwner!==undefined)pathId(selectedOwner);}
 owner(session:UserSession){return this.selectedOwner??session.personal_owner_id;}
 async funding(session:UserSession,quote:{quote_id:string;root_budget_id:string;price_version:string;max_amount:string;expires_at_unix:string},signal?:AbortSignal){
  const value=decodeCompute('Funding',await this.call(this.base(session)+'/quotes/'+pathId(quote.quote_id)+'/funding',{signal}));
  const personal=this.owner(session)===session.personal_owner_id;
  if(value.requester_id!==session.user_id||value.owner_id!==this.owner(session)||value.account_kind!==(personal?'personal':'team')||
     value.quote_id!==quote.quote_id||value.root_budget_id!==quote.root_budget_id||value.price_version!==quote.price_version||
     value.max_microcredits!==quote.max_amount||value.expires_unix!==quote.expires_at_unix||(personal&&value.wallet_available===null))
    throw new ApiFailure(403,'QUOTE_FUNDING_SCOPE_MISMATCH');
  const max=BigInt(value.max_microcredits);
  if(BigInt(value.budget_spent)+BigInt(value.budget_reserved)+BigInt(value.budget_remaining)!==BigInt(value.budget_limit)||
     (value.status==='sufficient'&&(max>BigInt(value.budget_remaining)||(value.wallet_available!==null&&max>BigInt(value.wallet_available)))))throw Error('INVALID_QUOTE_FUNDING');
  return value;
 }
 private base(session:UserSession){return '/api/v1/owners/'+pathId(this.owner(session));}

 protected override rejection(status:number,body:unknown){return isArtifactError(body)?new ApiFailure(status,body.code,body.request_id):super.rejection(status,body);}

 async audioTarget(id: string, signal?: AbortSignal) {
  const target=decodeCompute('AudioTarget',await this.call('/api/v1/transcription-targets/'+pathId(id),{signal}));
  if(target.observation_id!==id)throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return target;
 }
 async createAudioGrant(session:UserSession,request:AudioGrantRequest,signal?:AbortSignal){
  decodeCompute('AudioGrantRequest',request);
  const value=decodeCompute('AudioGrantReceipt',await this.call(this.base(session)+'/transcription-input-grants',{
   method:'POST',signal,headers:write(session,request.grant_id),body:JSON.stringify(request)},200,90000));
  if(value.grant_id!==request.grant_id || value.invocation_id!==request.invocation_id || value.observation_id!==request.observation_id)
   throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return value;
 }
 async audioGrant(session:UserSession,id:string,signal?:AbortSignal){
  const value=decodeCompute('AudioGrantReceipt',await this.call(this.base(session)+'/transcription-input-grants/'+pathId(id),{signal}));
  if(value.grant_id!==id)throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return value;
 }
 async audioPrice(session:UserSession, grant:string, signal?:AbortSignal){
  const data=await this.call(this.base(session)+'/transcription-input-grants/'+pathId(grant)+'/prices',{signal});
  if(!Array.isArray(data)||data.length>1) throw new Error('INVALID_AUDIO_PRICE_LIST');
  return data.length ? decodeCompute('AudioPrice',data[0]) : null;
 }
 async audioQuote(session:UserSession, receipt:AudioGrantReceipt, price:AudioPrice, requestId:string, signal?:AbortSignal){
  pathId(requestId);
  const body={request_id:requestId,grant_id:receipt.grant_id,price_version:price.price_version};
  const quote=decodeCompute('AudioQuote',await this.call(this.base(session)+'/transcription-quotes',{method:'POST',headers:write(session,requestId),body:JSON.stringify(body),signal},201));
  if(quote.grant_id!==receipt.grant_id || quote.invocation_id!==receipt.invocation_id || quote.observation_id!==receipt.observation_id ||
    quote.request_projection_digest!==receipt.projection_digest || quote.price_version!==price.price_version ||
    quote.price_per_minute!==price.price_per_minute || quote.fee_bps!==price.fee_bps ||
    (BigInt(quote.duration_ms)*BigInt(price.price_per_minute)+59999n)/60000n!==BigInt(quote.max_amount))
    throw new ApiFailure(201,'UNCONFIRMED_RESPONSE');
  return quote;
 }
 async withdrawAudio(session:UserSession,id:string,signal?:AbortSignal){
  const value=decodeCompute('AudioWithdrawal',await this.call(this.base(session)+'/transcription-input-grants/'+pathId(id),{
   method:'DELETE',headers:write(session,id),signal}));
  if(value.grant_id!==id)throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return value;
 }
 async prices(signal?: AbortSignal) {
  const data = await this.call('/api/v1/text-prices', { signal });
  if (!Array.isArray(data) || data.length > 1000) throw new Error('INVALID_PRICE_LIST');
  return data.map(value => decodeCompute('Price', value));
 }
 private ownedArtifact(session: UserSession, value: unknown, upload?: string) {
  const artifact = decodeCompute('Artifact', value);
  if (artifact.owner_id !== this.owner(session) || (upload !== undefined && artifact.upload_id !== upload)) throw new ApiFailure(403, 'ACTOR_MISMATCH');
  return artifact;
 }
 async beginUpload(session: UserSession, request: Upload, signal?: AbortSignal) {
  decodeCompute('Upload', request);
  const artifact = this.ownedArtifact(session, await this.call(`${this.base(session)}/uploads`, { method: 'POST', headers: write(session, request.upload_id), body: JSON.stringify(request), signal }), request.upload_id);
  if (artifact.sha256 !== request.sha256 || artifact.size_bytes !== request.size_bytes || artifact.media_type !== request.media_type) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return artifact;
 }
 async deleteUpload(session: UserSession, upload: string) {
  const artifact=this.ownedArtifact(session,await this.call(`${this.base(session)}/uploads/${pathId(upload)}`,{method:'DELETE',headers:write(session,upload)}),upload);
  if(artifact.state!=='deleted')throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');return artifact;
 }
 async uploadStatus(session: UserSession, upload: string, signal?: AbortSignal) {
  return this.ownedArtifact(session, await this.call(`${this.base(session)}/uploads/${pathId(upload)}`, { signal }), upload);
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
  const artifact = this.ownedArtifact(session, await this.call(`${this.base(session)}/uploads/${pathId(request.upload_id)}/content`, { method: 'PUT', headers: { ...write(session,request.upload_id), 'Content-Type': 'application/octet-stream' }, body, signal }, 200, timeoutMs),request.upload_id);
  if (artifact.state !== 'available' || artifact.sha256 !== request.sha256 || artifact.size_bytes !== request.size_bytes || artifact.media_type !== request.media_type) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return artifact;
 }
 async measureAudio(session: UserSession, input: Artifact, signal?: AbortSignal) {
  this.ownedArtifact(session, input);
  if (input.state !== 'available' || !audioFormats[input.media_type]) throw new Error('INVALID_AUDIO');
  const data = await this.call(`${this.base(session)}/uploads/${pathId(input.upload_id)}/transcription-measurements`, {
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
  const result = decodeCompute('Quote', await this.call(`${this.base(session)}/text-quotes`, { method: 'POST', headers: write(session,request.request_id), body: JSON.stringify(request) },201));
  if (result.root_budget_id !== request.root_budget_id || result.price_version !== request.price_version || result.output_limit !== request.output_limit.toString()) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
  return result;
 }
 async submit(session: UserSession, key: string, request: Submission) {
  decodeCompute(request.purpose==='transcription'?'AudioSubmission':'Submission',request);
  const job = decodeCompute('Job', await this.call(`${this.base(session)}/jobs`, { method: 'POST', headers: write(session,key), body: JSON.stringify(request) }));
  if (job.root_budget_id !== request.root_budget_id || job.invocation_id !== request.invocation_id) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return job;
 }
 async bind(session: UserSession, job: Job, input: Artifact, projection: string) {
  decodeCompute('Job',job); this.ownedArtifact(session,input);
  const result = decodeCompute('InputBinding', await this.call(`${this.base(session)}/jobs/${pathId(job.job_id)}/input`, { method: 'POST', headers: write(session,job.job_id), body: JSON.stringify({ upload_id: input.upload_id, version_id: input.version_id }) }));
  if (result.job_id !== job.job_id || result.artifact_id !== input.artifact_id || result.version_id !== input.version_id || result.sha256 !== input.sha256 || result.size_bytes !== input.size_bytes || result.projection_digest !== projection) throw new ApiFailure(200,'UNCONFIRMED_RESPONSE'); return result;
 }
 async jobs(session: UserSession, after?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' }); if (after) params.set('after',after);
  const page = decodeCompute('JobPage',await this.call(`${this.base(session)}/jobs?${params}`,{ signal }));
  if (page.owner_id !== this.owner(session) || page.user_id !== session.user_id) throw new ApiFailure(403,'ACTOR_MISMATCH'); return page;
 }
 async lookup(session: UserSession, invocation: string, signal?: AbortSignal) {
  let value: unknown;
  try { value = await this.call(`${this.base(session)}/jobs/by-invocation/${pathId(invocation)}`,{ signal }); }
  catch (error) { if (error instanceof ApiFailure && error.status === 404) return null; throw error; }
  const result = decodeCompute('JobLookup',value);
  if (result.owner_id !== this.owner(session) || result.user_id !== session.user_id || result.job.invocation_id !== invocation) throw new ApiFailure(403,'ACTOR_MISMATCH'); return result;
 }
 async jobSnapshot(session: UserSession, id: string, signal?: AbortSignal) {
  let revision: string | undefined;
  const body=await this.call(`${this.base(session)}/jobs/${pathId(id)}`,{signal},200,15000,headers=>{
   const value=headers.get('x-orange-job-version');
   if(value!==null) revision=validatedVersion(value);
  });
  const job=decodeCompute('Job',body);
  if(job.job_id!==id) throw new ApiFailure(403,'ACTOR_MISMATCH');
  return {job,revision};
 }
 async job(session:UserSession,id:string,signal?:AbortSignal){
  return (await this.jobSnapshot(session,id,signal)).job;
 }
 async withdraw(session:UserSession,key:string,request:Submission){
  decodeCompute(request.purpose==='transcription'?'AudioSubmission':'Submission',request);
  const value=decodeCompute('Withdrawal',await this.call(`${this.base(session)}/invocations/${pathId(request.invocation_id)}/withdraw`,{method:'POST',headers:write(session,key),body:JSON.stringify(request)}));
  if(value.owner_id!==this.owner(session)||value.user_id!==session.user_id||value.invocation_id!==request.invocation_id||value.quote_id!==request.quote_id||(value.job&&(value.job.invocation_id!==request.invocation_id||value.job.root_budget_id!==request.root_budget_id)))throw new ApiFailure(403,'ACTOR_MISMATCH');return value;
 }
 async cancel(session: UserSession, id: string, key: string, revision?: string) {
  const headers=new Headers(write(session,key));
  if(revision!==undefined) headers.set('x-orange-expected-job-version',validatedVersion(revision));
  const job = decodeCompute('Job',await this.call(`${this.base(session)}/jobs/${pathId(id)}/cancel`,{ method: 'POST', headers, body: '{}' }));
  if (job.job_id !== id) throw new ApiFailure(403,'ACTOR_MISMATCH'); return job;
 }
 async cancelObserved(session:UserSession,id:string,revision:string|undefined,storage:Storage=sessionStorage) {
  pathId(id);
  const storageKey='orange-cancel-v1:'+JSON.stringify([session.user_id,this.owner(session),id]);
  let serialized=storage.getItem(storageKey);
  let key:string;
  if(serialized===null){
   key=crypto.randomUUID();
   if(revision!==undefined) validatedVersion(revision);
   serialized=JSON.stringify({v:2,key,revision:revision??null});
   storage.setItem(storageKey,serialized);
  }else if(serialized.startsWith('{')){
   let data;
   try{data=JSON.parse(serialized);}catch{throw new ApiFailure(0,'INVALID_CANCEL_RECEIPT');}
   if(!data || Array.isArray(data) || typeof data!=='object' || Object.keys(data).sort().join(',')!=='key,revision,v' ||
      data.v!==2 || typeof data.key!=='string' || !(data.revision===null||typeof data.revision==='string')) {
    throw new ApiFailure(0,'INVALID_CANCEL_RECEIPT');
   }
   pathId(data.key);
   key=data.key;
   revision=data.revision===null?undefined:validatedVersion(data.revision);
  }else{
   // Earlier Web releases stored only the raw idempotency key.
   pathId(serialized);
   key=serialized;
   revision=undefined;
  }
  const clear=()=>{if(storage.getItem(storageKey)===serialized) storage.removeItem(storageKey);};
  try{
   const job=await this.cancel(session,id,key,revision);
   clear();
   return job;
  }catch(error){
   if(error instanceof ApiFailure && error.status===412 && error.code==='STALE_JOB_VERSION') clear();
   throw error;
  }
 }
 async result(session: UserSession, id: string, signal?: AbortSignal) {
  let value: unknown;
  try { value = await this.call(`${this.base(session)}/jobs/${pathId(id)}/result`,{ signal }); }
  catch (error) { if (error instanceof ApiFailure && [403,410].includes(error.status)) throw new ContentUnavailable('CONTENT_UNAVAILABLE'); throw error; }
  return this.ownedArtifact(session,value);
 }
 async resultText(session: UserSession, artifact: Artifact, external?: AbortSignal) {
  const result=decodeCompute('Result',await this.resultJson(session,artifact,MODEL_RESPONSE_MEDIA,1048576n,external));
  if(result.finish_reason!=='stop'||result.tool_calls.length)throw new Error('UNREQUESTED_MODEL_TOOL');
  return result.text;
 }
 async resultDocument(session:UserSession,artifact:Artifact,signal?:AbortSignal){
  if(artifact.media_type!==TRANSCRIPTION_MEDIA)return {kind:'text' as const,text:await this.resultText(session,artifact,signal)};
  const result=decodeCompute('TranscriptionResult',await this.resultJson(session,artifact,TRANSCRIPTION_MEDIA,2097152n,signal));
  const measurement=result.measurement;
  if(measurement.duration_ms.length>6||measurement.source_samples.length>9||measurement.normalized_samples.length>7)throw new Error('INVALID_TRANSCRIPT');
  const duration=BigInt(measurement.duration_ms),rate=BigInt(measurement.source_sample_rate),samples=BigInt(measurement.source_samples);
  const delta=BigInt(measurement.normalized_samples)*rate-samples*16000n;
  if(duration>600000n||(samples*1000n+rate-1n)/rate!==duration||delta>2n*rate||delta< -2n*rate)throw new Error('INVALID_TRANSCRIPT');
  let last=0;
  for(const segment of result.segments){
   if(segment.start_ms<last||segment.end_ms<segment.start_ms||segment.end_ms>Number(duration))throw new Error('INVALID_TRANSCRIPT_TIMING');
   last=segment.end_ms;
  }
  if(!result.text.trim()||result.segments.map(s=>s.text).join('').trim()!==result.text)throw new Error('INVALID_TRANSCRIPT_TEXT');
  return {kind:'transcription' as const,text:result.text,transcript:result};
 }
 private async resultJson(session:UserSession,artifact:Artifact,media:string,max:bigint,external?:AbortSignal):Promise<unknown>{
  this.ownedArtifact(session,artifact);
  if (artifact.state !== 'available' || artifact.media_type !== media || BigInt(artifact.size_bytes) < 1n || BigInt(artifact.size_bytes) > max) throw new Error('INVALID_RESULT_DESCRIPTOR');
  const deadline = new AbortController(), cancel = () => deadline.abort();
  if (external?.aborted) cancel(); else external?.addEventListener('abort',cancel,{ once: true });
  const timer = setTimeout(cancel,30000);
  try {
   const url = `${this.base(session)}/uploads/${pathId(artifact.upload_id)}/content?${new URLSearchParams({ version_id: artifact.version_id })}`;
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
   const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(external?.aborted)throw new DOMException('aborted','AbortError');
   return result;
  } finally { clearTimeout(timer); external?.removeEventListener('abort',cancel); }
 }
}
