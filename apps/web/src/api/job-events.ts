import {isJobStreamFrame, pathId, type JobEventCursor, type JobHistory} from './compute-contracts';

const largestCursor=9223372036854775807n;
function sequence(value:string):bigint {
  if(!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw Error('INVALID_EVENT_CURSOR');
  const result=BigInt(value);
  if(result>largestCursor) throw Error('INVALID_EVENT_CURSOR');
  return result;
}

export function jobSocketUrl(origin:string,owner:string,job:string,cursor:JobEventCursor|null):URL {
  const url=new URL('/api/v1/owners/'+pathId(owner)+'/jobs/'+pathId(job)+'/events/ws',origin);
  if(url.username||url.password) throw Error('INVALID_JOB_STREAM_ORIGIN');
  if(url.protocol==='https:') url.protocol='wss:';
  else if(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) url.protocol='ws:';
  else throw Error('INVALID_JOB_STREAM_ORIGIN');
  if(cursor){
    sequence(cursor.after);
    url.searchParams.set('stream_id',cursor.stream_id);
    url.searchParams.set('after',cursor.after);
  }
  return url;
}

/** A receiver belongs to one socket. Only an applied durable cursor crosses reconnections. */
export class JobEventReceiver {
  private generation?:string;
  private processing=false;
  constructor(private readonly jobId:string,private cursor:JobEventCursor|null,private readonly previousGeneration?:string){}
  async accept(raw:unknown,apply:(value:JobHistory,first:boolean)=>Promise<void>){
    if(this.processing) throw Error('UNACKNOWLEDGED_JOB_FRAME');
    if(typeof raw!=='string'||raw.length>65536||new TextEncoder().encode(raw).byteLength>65536) throw Error('INVALID_JOB_FRAME');
    const frame:unknown=JSON.parse(raw);
    if(!isJobStreamFrame(frame)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(frame.connection_generation)) throw Error('INVALID_JOB_FRAME');
    if(frame.connection_generation===this.previousGeneration || (this.generation!==undefined && this.generation!==frame.connection_generation)) throw Error('STALE_JOB_CONNECTION');
    const history=frame.history;
    if(history.cursor) sequence(history.cursor.after);
    if(history.kind==='page'){
      if(history.job_id!==this.jobId||!this.cursor||history.cursor.stream_id!==this.cursor.stream_id) throw Error('UNEXPECTED_JOB_STREAM');
      let last=sequence(this.cursor.after);
      for(const event of history.events){
        if(sequence(event.seq)!==last+1n) throw Error('JOB_EVENT_GAP');
        last++;
      }
      if(sequence(history.cursor.after)!==last) throw Error('JOB_EVENT_GAP');
    } else {
      if(history.job.job_id!==this.jobId||sequence(history.job_version)===0n) throw Error('UNEXPECTED_JOB_SNAPSHOT');
      if(history.kind==='snapshot'&&this.cursor) throw Error('UNEXPECTED_JOB_SNAPSHOT');
    }
    this.processing=true;
    try {
      await apply(history,this.generation===undefined);
      this.cursor=history.cursor;
      this.generation=frame.connection_generation;
      return {kind:'ack' as const,connection_generation:this.generation,cursor:this.cursor};
    } finally {
      this.processing=false;
    }
  }
}
