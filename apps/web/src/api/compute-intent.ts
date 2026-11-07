import type { UserSession } from './contracts';
import { ComputeClient } from './compute-client';
import { decodeCompute, modelInput, pathId, sha256, type Artifact, type Job, type Price, type Quote, type Upload } from './compute-contracts';
export interface ComputeIntent {
 version: 1; user: string; owner: string; invocation: string; budget: string; price: Price; output: number;
 upload: Upload; quote_key: string; submit_key: string; confirmed: boolean; bound: boolean; withdrawn: boolean;
 artifact?: Artifact; quote?: Quote; job?: Job;
}
export type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const allowed = new Set(['version','user','owner','invocation','budget','price','output','upload','quote_key','submit_key','confirmed','bound','withdrawn','artifact','quote','job']);
export const computeIntentKey = (session: UserSession) => `orange-compute-v1:${JSON.stringify([session.user_id,session.personal_owner_id])}`;
export function checkIntent(value: unknown, session: UserSession): ComputeIntent {
 if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error('INVALID_COMPUTE_INTENT');
 const intent = value as ComputeIntent;
 if (intent.version !== 1 || intent.user !== session.user_id || intent.owner !== session.personal_owner_id || typeof intent.confirmed !== 'boolean' || typeof intent.bound !== 'boolean' || typeof intent.withdrawn !== 'boolean') throw new Error('INVALID_COMPUTE_INTENT');
 for (const id of [intent.invocation,intent.budget,intent.quote_key,intent.submit_key]) { if (typeof id !== 'string') throw new Error('INVALID_COMPUTE_INTENT'); pathId(id); }
 decodeCompute('Price',intent.price); decodeCompute('Upload',intent.upload);
 if (intent.upload.media_type !== 'application/json' || BigInt(intent.upload.size_bytes) < 1n || BigInt(intent.upload.size_bytes) > 262144n || !Number.isInteger(intent.output) || intent.output < 1 || BigInt(intent.output) > BigInt(intent.price.output_limit)) throw new Error('INVALID_COMPUTE_INTENT');
 if (intent.artifact !== undefined) {
  const a = decodeCompute('Artifact',intent.artifact);
  if (a.owner_id !== intent.owner || a.upload_id !== intent.upload.upload_id || a.sha256 !== intent.upload.sha256 || a.size_bytes !== intent.upload.size_bytes || a.media_type !== 'application/json' || a.state !== 'available') throw new Error('INTENT_ARTIFACT_CHANGED');
 }
 if (intent.quote !== undefined) {
  const q = decodeCompute('Quote',intent.quote);
  if (!intent.artifact || q.root_budget_id !== intent.budget || q.invocation_id !== intent.invocation || q.price_version !== intent.price.price_version || q.meter_profile_digest !== intent.price.meter_profile_digest || q.output_limit !== intent.output.toString()) throw new Error('INTENT_QUOTE_CHANGED');
 }
 if (intent.confirmed && !intent.quote) throw new Error('CONFIRMATION_WITHOUT_QUOTE');
 if (intent.job !== undefined) {
  const job = decodeCompute('Job',intent.job);
  if (!intent.confirmed || !intent.quote || job.root_budget_id !== intent.budget || job.invocation_id !== intent.invocation || job.reserved !== intent.quote.max_amount) throw new Error('INTENT_JOB_CHANGED');
 }
 if (intent.bound && !intent.job) throw new Error('BINDING_WITHOUT_JOB');
 return intent;
}
const identity = (i: ComputeIntent) => JSON.stringify([i.user,i.owner,i.invocation,i.budget,i.output,i.quote_key,i.submit_key,
 i.price.price_version,i.price.model_version,i.price.node_id,i.price.meter_profile_digest,i.price.input_price,i.price.output_price,i.price.output_limit,i.price.fee_bps,
 i.upload.upload_id,i.upload.sha256,i.upload.size_bytes,i.upload.media_type]);
const quoteIdentity = (q: Quote | undefined) => q && JSON.stringify([q.quote_id,q.root_budget_id,q.invocation_id,q.price_version,q.request_projection_digest,q.meter_profile_digest,q.input_units,q.output_limit,q.max_amount,q.expires_at_unix]);
export function loadComputeIntent(storage: IntentStorage, session: UserSession): ComputeIntent | null {
 const raw = storage.getItem(computeIntentKey(session)); if (raw === null) return null;
 if (raw.length > 32768) throw new Error('INTENT_TOO_LARGE'); return checkIntent(JSON.parse(raw),session);
}
export function saveComputeIntent(storage: IntentStorage, session: UserSession, value: ComputeIntent, initialize=false): ComputeIntent {
 checkIntent(value,session); const previous=loadComputeIntent(storage,session);
 if (!previous && (!initialize || value.confirmed || value.bound || value.withdrawn || value.job || value.quote || value.artifact)) throw new Error('INTENT_NO_LONGER_CURRENT');
 if (previous) {
  if (identity(previous)!==identity(value) || (previous.confirmed&&!value.confirmed) || (previous.bound&&!value.bound) || (previous.withdrawn&&!value.withdrawn)) throw new Error('ORIGINAL_INTENT_CHANGED');
  if (previous.artifact && JSON.stringify(previous.artifact)!==JSON.stringify(value.artifact)) throw new Error('ORIGINAL_ARTIFACT_CHANGED');
  if (previous.quote && quoteIdentity(previous.quote)!==quoteIdentity(value.quote)) throw new Error('ORIGINAL_QUOTE_CHANGED');
  if (previous.job && (!value.job || previous.job.job_id!==value.job.job_id)) throw new Error('ORIGINAL_JOB_CHANGED');
 }
 const raw = JSON.stringify(value); if (raw.length > 32768) throw new Error('INTENT_TOO_LARGE');
 storage.setItem(computeIntentKey(session),raw); return checkIntent(JSON.parse(raw),session);
}
export async function newComputeIntent(session: UserSession, budget: string, price: Price, prompt: string, output: number): Promise<{ intent: ComputeIntent; bytes: Uint8Array }> {
 const invocation = crypto.randomUUID(), bytes = modelInput(invocation,price.model_version,prompt,output);
 const intent: ComputeIntent = { version: 1, user: session.user_id, owner: session.personal_owner_id, invocation, budget, price, output,
  upload: { upload_id: crypto.randomUUID(), sha256: await sha256(bytes), size_bytes: bytes.length.toString(), media_type: 'application/json' },
  quote_key: crypto.randomUUID(), submit_key: crypto.randomUUID(), confirmed: false, bound: false, withdrawn: false };
 return { intent: checkIntent(intent,session), bytes };
}
export interface VerifiedComputeQuote { readonly intent: ComputeIntent }
export interface SubmissionApproval { readonly kind: 'original-quote-approval' }
const verified = new WeakMap<VerifiedComputeQuote,{ identity: string; quote: string; session: string }>();
const approvals = new WeakMap<SubmissionApproval,{ identity: string; quote: string; session: string }>();
/** Only a freshly observed server quote can produce an in-memory click permit.
 * This UI gate does not replace server identity, expiry or budget authorization. */
export function confirmComputeIntent(session: UserSession, prepared: VerifiedComputeQuote): SubmissionApproval {
 const proof=verified.get(prepared);
 if (!proof || proof.session!==session.session_id || proof.identity!==identity(prepared.intent) || proof.quote!==quoteIdentity(prepared.intent.quote)) throw new Error('QUOTE_REQUIRES_CURRENT_VERIFICATION');
 const approval:SubmissionApproval=Object.freeze({ kind:'original-quote-approval' });approvals.set(approval,proof);verified.delete(prepared);return approval;
}
export class OriginalInputRequired extends Error {}
export type ComputeProgress = { kind:'quoted'; intent:ComputeIntent; prepared:VerifiedComputeQuote } | { kind:'job'; intent:ComputeIntent };
/** Read-only lookup precedes any reconciliation. A stored confirmed bit alone
 * never authorizes a new submission. Unknown writes keep their original IDs. */
export async function advanceComputeIntent(api: ComputeClient, storage: IntentStorage, session: UserSession, original: ComputeIntent, bytes?: Uint8Array, approval?: SubmissionApproval): Promise<ComputeProgress> {
 let intent=saveComputeIntent(storage,session,checkIntent(JSON.parse(JSON.stringify(original)),session),true);
 if(intent.withdrawn)throw new Error('ORIGINAL_INTENT_WITHDRAWING');
 let approved=false;
 if(approval){
  const proof=approvals.get(approval);approvals.delete(approval);
  if(!proof||proof.session!==session.session_id||proof.identity!==identity(intent)||proof.quote!==quoteIdentity(intent.quote))throw new Error('QUOTE_REQUIRES_CURRENT_VERIFICATION');
  // Record possible submission before the first await, including lookup/hash.
  intent=saveComputeIntent(storage,session,{...intent,confirmed:true});approved=true;
 }
 const originalIdentity=identity(intent);
 const current=()=>{const value=loadComputeIntent(storage,session);if(!value||identity(value)!==originalIdentity||value.withdrawn)throw new Error('INTENT_NO_LONGER_CURRENT');return value;};
 if (bytes && (bytes.byteLength.toString()!==intent.upload.size_bytes || await sha256(bytes)!==intent.upload.sha256)) throw new Error('ORIGINAL_INPUT_CHANGED');
 intent=current();
 const existing=await api.lookup(session,intent.invocation);
 intent=current();
 if (existing) {
  if (!intent.quote || existing.quote_id!==intent.quote.quote_id) throw new Error('RECOVERED_QUOTE_CHANGED');
  intent=saveComputeIntent(storage,session,{ ...intent, confirmed:true, job:existing.job });
 } else if (intent.job) {
  throw new Error('ORIGINAL_JOB_UNAVAILABLE');
 } else if (approved) {
  const job=await api.submit(session,intent.submit_key,{ root_budget_id:intent.budget,invocation_id:intent.invocation,purpose:'primary',quote_id:intent.quote!.quote_id,request_projection_digest:intent.quote!.request_projection_digest });
  intent=saveComputeIntent(storage,session,{ ...intent, job });
 } else {
  if (!intent.artifact) {
   let artifact=await api.beginUpload(session,intent.upload);
   intent=current();
   if (artifact.state==='deleted') throw new Error('ORIGINAL_INPUT_DELETED');
   if (artifact.state!=='available') {
    if (!bytes) throw new OriginalInputRequired('ORIGINAL_INPUT_REQUIRED');
    artifact=await api.putInput(session,intent.upload,bytes);
   }
   intent=saveComputeIntent(storage,session,{ ...intent, artifact });
  }
  // Re-read the original quote, never authorize spending from stored flags.
  const quote=await api.quote(session,{ request_id:intent.quote_key,root_budget_id:intent.budget,price_version:intent.price.price_version,input_upload_id:intent.artifact!.upload_id,input_version_id:intent.artifact!.version_id,output_limit:intent.output });
  intent=saveComputeIntent(storage,session,{ ...intent, quote });
  const prepared:VerifiedComputeQuote=Object.freeze({ intent });verified.set(prepared,{ identity:identity(intent),quote:quoteIdentity(quote)!,session:session.session_id });
  return { kind:'quoted', intent, prepared };
 }
 if (!intent.bound && intent.job!.execution_state==='queued') {
  await api.bind(session,intent.job!,intent.artifact!,intent.quote!.request_projection_digest);
  intent=saveComputeIntent(storage,session,{ ...intent, bound:true });
 }
 return { kind:'job', intent };
}
export function clearFinishedCreation(storage: IntentStorage, session: UserSession, value: ComputeIntent): void {
 checkIntent(value,session);const current=loadComputeIntent(storage,session);if (!current) return;
 if (identity(value)!==identity(current) || !current.job || (!current.bound && current.job.execution_state==='queued')) throw new Error('UNRESOLVED_CREATION');
 storage.removeItem(computeIntentKey(session));
}

/** Withdraw never starts an original task. Only the current server's immutable
 * prevention receipt can close a not-yet-visible submission. */
export async function withdrawComputeIntent(api:ComputeClient,storage:IntentStorage,session:UserSession,original:ComputeIntent):Promise<ComputeIntent|null>{
 const saved=loadComputeIntent(storage,session);if(!saved||identity(saved)!==identity(checkIntent(original,session)))throw new Error('INTENT_NO_LONGER_CURRENT');
 const intent=saveComputeIntent(storage,session,{...saved,withdrawn:true});
 let prevented=false;
 if(intent.quote){
  const receipt=await api.withdraw(session,intent.submit_key,{root_budget_id:intent.budget,invocation_id:intent.invocation,purpose:'primary',quote_id:intent.quote.quote_id,request_projection_digest:intent.quote.request_projection_digest});
  if(receipt.job)return saveComputeIntent(storage,session,{...intent,confirmed:true,job:receipt.job});
  if(!receipt.prevented||!receipt.receipt_id)throw new Error('WITHDRAWAL_UNCONFIRMED');
  prevented=true;
 }else{
  // Before any quote there was no submission approval. Still refuse to delete
  // an input used by an unexpected existing Invocation.
  if(await api.lookup(session,intent.invocation))throw new Error('RECOVERED_QUOTE_CHANGED');
  if(intent.confirmed)throw new Error('ORIGINAL_SUBMISSION_STILL_UNRESOLVED');
 }
 const artifact=await api.beginUpload(session,intent.upload);
 if(artifact.state!=='deleted')await api.deleteUpload(session,intent.upload.upload_id);
 const current=loadComputeIntent(storage,session);
 if(!current||identity(current)!==identity(intent)||current.job||!current.withdrawn||(!prevented&&current.confirmed))throw new Error('INTENT_NO_LONGER_CURRENT');
 storage.removeItem(computeIntentKey(session));return null;
}
