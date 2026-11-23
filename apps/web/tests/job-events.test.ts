import {describe,expect,it,vi} from 'vitest';
import {JobEventReceiver,jobSocketUrl} from '../src/api/job-events';
const job={job_id:'job-1',root_budget_id:'budget-1',invocation_id:'inv-1',execution_state:'queued',settlement_state:'pending',reserved:'17',charge:null};
const generation='44fb8e77-a455-4622-b08f-38fb1ac7e9ee';
const cursor={stream_id:'stream-1',after:'9007199254740993'};
const wire=(history:unknown,gen=generation)=>JSON.stringify({protocol_version:1,connection_generation:gen,history});
const snapshot={kind:'snapshot',job,job_version:'1',cursor};
const next={stream_id:cursor.stream_id,after:'9007199254740994'};
const event={event_id:'event-2',seq:next.after,event_type:'job.cancelled',attempt_id:null,occurred_at:'2026-01-01T00:00:00Z',payload_digest:'a'.repeat(64)};
const page={kind:'page',job_id:job.job_id,cursor:next,events:[event]};
describe('Job event stream generations',()=>{
 it('binds a subscription to the current origin, owner, job and durable position',()=>{
  const url=jobSocketUrl('https://orange.example','owner:1','job:1',cursor);
  expect(url.protocol).toBe('wss:');expect(url.hostname).toBe('orange.example');
  expect(url.pathname).toBe('/api/v1/owners/owner%3A1/jobs/job%3A1/events/ws');
  expect([...url.searchParams.entries()]).toEqual([['stream_id',cursor.stream_id],['after',cursor.after]]);
  expect(()=>jobSocketUrl('http://remote.example','owner','job',cursor)).toThrow();
 });
 it('acknowledges only after applying the frame and keeps exact 64-bit cursors',async()=>{
  const receiver=new JobEventReceiver(job.job_id,null);
  const apply=vi.fn(async()=>{});
  expect(await receiver.accept(wire(snapshot),apply)).toEqual({kind:'ack',connection_generation:generation,cursor});
  expect(apply).toHaveBeenCalledWith(snapshot,true);
  expect((await receiver.accept(wire(page),apply)).cursor).toEqual(next);
  expect(apply).toHaveBeenLastCalledWith(page,false);
  await expect(receiver.accept(wire(page),apply)).rejects.toThrow('JOB_EVENT_GAP');
 });
 it('rejects wrong scope, generation, future fields and out-of-order metadata before publishing',async()=>{
  const receiver=new JobEventReceiver(job.job_id,cursor);
  const apply=vi.fn(async()=>{});
  for(const altered of [{...page,job_id:'other'},{...page,cursor:{...next,stream_id:'foreign'}},
      {...page,events:[{...event,seq:'9007199254740995'}]},{...page,events:[{...event,prompt:'raw input'}]}]){
   await expect(receiver.accept(wire(altered),apply)).rejects.toThrow();
  }
  expect(apply).not.toHaveBeenCalled();
  await receiver.accept(wire(page),apply);
  await expect(receiver.accept(wire({...snapshot,kind:'reset'},'f101e24b-82ca-4bd3-83c7-bf6da04562af'),apply)).rejects.toThrow('STALE_JOB_CONNECTION');
 });
 it('supports an explicit reset, never advances on a failed callback and rejects overlapping delivery',async()=>{
  const receiver=new JobEventReceiver(job.job_id,cursor);
  const reset={...snapshot,kind:'reset',cursor:{stream_id:'new-stream',after:'12'}};
  await expect(receiver.accept(wire(reset),async()=>{throw Error('owner changed');})).rejects.toThrow('owner changed');
  let release:()=>void=()=>{};
  const applied=receiver.accept(wire(reset),()=>new Promise<void>(resolve=>{release=resolve;}));
  await expect(receiver.accept(wire(reset),async()=>{})).rejects.toThrow('UNACKNOWLEDGED_JOB_FRAME');
  release();
  expect((await applied).cursor).toEqual(reset.cursor);
  await expect(receiver.accept(new Uint8Array([1,2]),async()=>{})).rejects.toThrow();
 });
});
