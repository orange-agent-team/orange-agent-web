import { describe, expect, it, vi } from 'vitest';
import { ComputeClient } from '../src/api/compute-client';
import { advanceComputeIntent, confirmComputeIntent, loadComputeIntent, newComputeIntent, saveComputeIntent, clearFinishedCreation, withdrawComputeIntent, type ComputeIntent, type IntentStorage } from '../src/api/compute-intent';
import type { UserSession } from '../src/api/contracts';
import type { Price, Artifact, Quote, Job } from '../src/api/compute-contracts';
const session: UserSession = { session_id: 'session', user_id: 'user', personal_owner_id: 'owner', csrf_token: 'private-csrf-token-not-for-storage', expires_at: '2099-01-01T00:00:00Z' };
const price: Price = { price_version: 'price', model_version: 'model', node_id: 'node', meter_profile_digest: 'b'.repeat(64), input_price: '2000', output_price: '6000', output_limit: '32', fee_bps: 2000 };
async function fixture() {
 const records=new Map<string,string>();const storage:IntentStorage={getItem:key=>records.get(key)??null,setItem:(key,value)=>{records.set(key,value);},removeItem:key=>{records.delete(key);}};
 const {intent,bytes}=await newComputeIntent(session,'budget',price,'PRIVATE ORIGINAL PROMPT',32);
 const artifact:Artifact={...intent.upload,artifact_id:'artifact',version_id:'version',owner_id:'owner',state:'available'};
 const quote:Quote={quote_id:'quote',root_budget_id:'budget',invocation_id:intent.invocation,price_version:'price',request_projection_digest:'a'.repeat(64),meter_profile_digest:price.meter_profile_digest,input_units:'10',output_limit:'32',max_amount:'100',expires_at_unix:'4102444800'};
 const job:Job={job_id:'job',root_budget_id:'budget',invocation_id:intent.invocation,execution_state:'queued',settlement_state:'pending',reserved:'100',charge:null};
 const api=new ComputeClient(vi.fn<typeof fetch>());
 const lookup=vi.spyOn(api,'lookup').mockResolvedValue(null);
 vi.spyOn(api,'beginUpload').mockResolvedValue({...artifact,state:'staging'});
 const put=vi.spyOn(api,'putInput').mockResolvedValue(artifact);
 const quotes=vi.spyOn(api,'quote').mockResolvedValue(quote);
 const submit=vi.spyOn(api,'submit').mockResolvedValue(job);
 const bind=vi.spyOn(api,'bind').mockResolvedValue({job_id:job.job_id,artifact_id:artifact.artifact_id,version_id:artifact.version_id,sha256:artifact.sha256,size_bytes:artifact.size_bytes,projection_digest:quote.request_projection_digest});
 const withdraw=vi.spyOn(api,'withdraw').mockResolvedValue({owner_id:session.personal_owner_id,user_id:session.user_id,invocation_id:intent.invocation,quote_id:quote.quote_id,prevented:true,receipt_id:'withdraw-receipt',job:null});
 vi.spyOn(api,'deleteUpload').mockResolvedValue({...artifact,state:'deleted'});
 return {records,storage,intent,bytes,artifact,quote,job,api,lookup,put,quotes,submit,bind,withdraw};
}
describe('recoverable model-task intent with explicit in-memory approval',()=>{
 it('pricing never submits, and no prompt or credentials enter recovery storage',async()=>{
  const f=await fixture();const progress=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);
  expect(progress.kind).toBe('quoted');expect(f.submit).not.toHaveBeenCalled();expect(f.bind).not.toHaveBeenCalled();
  const saved=JSON.stringify([...f.records.values()]);expect(saved).not.toContain('PRIVATE ORIGINAL PROMPT');expect(saved).not.toContain(session.csrf_token);
  if(progress.kind!=='quoted')throw Error('expected quote');
  expect(()=>confirmComputeIntent(session,JSON.parse(JSON.stringify(progress.prepared)))).toThrow('QUOTE_REQUIRES_CURRENT_VERIFICATION');
  expect(()=>confirmComputeIntent({...session,session_id:'new-session'},progress.prepared)).toThrow();
 });
 it('recovers a committed but lost submission by read-only lookup without resubmitting',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);if(ready.kind!=='quoted')throw Error('quote');
  const approval=confirmComputeIntent(session,ready.prepared);
  f.submit.mockImplementationOnce(async()=>{f.lookup.mockResolvedValue({owner_id:'owner',user_id:'user',quote_id:'quote',job:f.job});throw new TypeError('lost receipt after server commit');});
  await expect(advanceComputeIntent(f.api,f.storage,session,ready.intent,undefined,approval)).rejects.toThrow('lost receipt');
  const saved=loadComputeIntent(f.storage,session)!;expect(saved.confirmed).toBe(true);expect(saved.job).toBeUndefined();
  const recovered=await advanceComputeIntent(f.api,f.storage,session,saved);
  expect(recovered.kind).toBe('job');expect(recovered.intent.job?.job_id).toBe('job');expect(recovered.intent.bound).toBe(true);expect(f.submit).toHaveBeenCalledTimes(1);expect(f.bind).toHaveBeenCalledTimes(1);
  clearFinishedCreation(f.storage,session,recovered.intent);expect(loadComputeIntent(f.storage,session)).toBeNull();
 });
 it('a stored confirmed flag and a404 never authorize a fresh submission',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);if(ready.kind!=='quoted')throw Error('quote');
  const remembered=saveComputeIntent(f.storage,session,{...ready.intent,confirmed:true});
  const checked=await advanceComputeIntent(f.api,f.storage,session,remembered);
  expect(checked.kind).toBe('quoted');expect(f.submit).not.toHaveBeenCalled();expect(f.quotes).toHaveBeenCalledTimes(2);expect(f.put).toHaveBeenCalledTimes(1);
  if(checked.kind!=='quoted')throw Error('quote');const approval=confirmComputeIntent(session,checked.prepared);
  await expect(advanceComputeIntent(f.api,f.storage,session,checked.intent,undefined,JSON.parse(JSON.stringify(approval)))).rejects.toThrow('QUOTE_REQUIRES_CURRENT_VERIFICATION');
  expect(f.submit).not.toHaveBeenCalled();
 });
 it('records an approved attempt before lookup and a withdrawal fences its late continuation',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);if(ready.kind!=='quoted')throw Error('quote');
  let resolve!: (value:null)=>void;f.lookup.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const approval=confirmComputeIntent(session,ready.prepared);const advancing=advanceComputeIntent(f.api,f.storage,session,ready.intent,undefined,approval);
  const rejected=expect(advancing).rejects.toThrow('INTENT_NO_LONGER_CURRENT');
  expect(loadComputeIntent(f.storage,session)?.confirmed).toBe(true);
  expect(await withdrawComputeIntent(f.api,f.storage,session,ready.intent)).toBeNull();
  resolve(null);await rejected;expect(f.submit).not.toHaveBeenCalled();expect(loadComputeIntent(f.storage,session)).toBeNull();
 });
 it('unconfirmed input can be removed and a late writer cannot restore the cleared draft',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);
  expect(await withdrawComputeIntent(f.api,f.storage,session,ready.intent)).toBeNull();
  expect(loadComputeIntent(f.storage,session)).toBeNull();expect(()=>saveComputeIntent(f.storage,session,ready.intent)).toThrow('INTENT_NO_LONGER_CURRENT');expect(f.submit).not.toHaveBeenCalled();
 });
 it('does not clear an unresolved request from an invalid or mismatched withdrawal receipt',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);
  f.withdraw.mockResolvedValue({owner_id:'owner',user_id:'user',invocation_id:f.intent.invocation,quote_id:'quote',prevented:false,receipt_id:null,job:null});
  await expect(withdrawComputeIntent(f.api,f.storage,session,ready.intent)).rejects.toThrow('WITHDRAWAL_UNCONFIRMED');expect(loadComputeIntent(f.storage,session)).not.toBeNull();expect(f.api.deleteUpload).not.toHaveBeenCalled();
 });
 it('refuses changed original identity or quote and clears only the matching resolved intent',async()=>{
  const f=await fixture();const ready=await advanceComputeIntent(f.api,f.storage,session,f.intent,f.bytes);
  expect(()=>saveComputeIntent(f.storage,session,{...ready.intent,submit_key:'replacement'})).toThrow('ORIGINAL_INTENT_CHANGED');
  expect(()=>saveComputeIntent(f.storage,session,{...ready.intent,invocation:'replacement'})).toThrow();
  f.quotes.mockResolvedValue({...f.quote,max_amount:'999'});
  await expect(advanceComputeIntent(f.api,f.storage,session,ready.intent)).rejects.toThrow('ORIGINAL_QUOTE_CHANGED');expect(f.submit).not.toHaveBeenCalled();
  expect(()=>clearFinishedCreation(f.storage,session,ready.intent)).toThrow('UNRESOLVED_CREATION');
  const serialized=JSON.parse(JSON.stringify(ready.intent)) as ComputeIntent & {prompt?:string};serialized.prompt='must not be stored';expect(()=>saveComputeIntent(f.storage,session,serialized)).toThrow('INVALID_COMPUTE_INTENT');
 });
});

describe('team compute recovery scope',()=>{
 it('preserves legacy personal keys and isolates organization, member and allocation before any write',async()=>{
  const {storage,api,lookup,records}=await fixture();
  const team={...session,allocation:{owner:'team-1',budget:'allocated-1'}};
  const otherBudget={...team,allocation:{owner:'team-1',budget:'allocated-2'}};
  const otherMember={...team,user_id:'someone-else'};
  const own=await newComputeIntent(session,'budget',price,'personal prompt',32);
  const shared=await newComputeIntent(team,'allocated-1',price,'team prompt',32);
  saveComputeIntent(storage,session,own.intent,true);
  saveComputeIntent(storage,team,shared.intent,true);
  expect(records.has('orange-compute-v1:["user","owner"]')).toBe(true);
  expect(loadComputeIntent(storage,session)?.owner).toBe('owner');
  expect(loadComputeIntent(storage,team)?.owner).toBe('team-1');
  expect(loadComputeIntent(storage,otherBudget)).toBeNull();
  expect(loadComputeIntent(storage,otherMember)).toBeNull();
  expect(()=>saveComputeIntent(storage,otherBudget,shared.intent,true)).toThrow();
  expect(()=>saveComputeIntent(storage,session,shared.intent,true)).toThrow();
  await expect(advanceComputeIntent(api,storage,team,shared.intent,shared.bytes)).rejects.toThrow('COMPUTE_PAYER_MISMATCH');
  await expect(withdrawComputeIntent(api,storage,team,shared.intent)).rejects.toThrow('COMPUTE_PAYER_MISMATCH');
  expect(lookup).not.toHaveBeenCalled();
  expect(JSON.stringify([...records.values()])).not.toContain('team prompt');
 });
});
