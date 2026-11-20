import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { Link } from 'react-router';
import type { UserSession } from '../api/contracts';
import type { AudioGrantReceipt, AudioQuote, AudioTarget, Job } from '../api/compute-contracts';
import { ComputeClient } from '../api/compute-client';

const api = new ComputeClient();

export default function AudioOrder({session,receipt}:{session:UserSession;receipt:AudioGrantReceipt}) {
  const [quote,setQuote]=useState<AudioQuote>();
  const [target,setTarget]=useState<AudioTarget>();
  const [job,setJob]=useState<Job>();
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [recovered,setRecovered]=useState(false);
  const [now,setNow]=useState(Date.now);
  const active=useRef<AbortController|null>(null);
  const {grant_id:grant,invocation_id:invocation,observation_id:observation}=receipt;
  useEffect(()=>{
    const c=new AbortController();
    api.lookup(session,invocation,c.signal).then(value=>{
      if(!c.signal.aborted){setJob(value?.job);setRecovered(true);}
    }).catch(()=>{if(!c.signal.aborted)setMessage('暂时无法核对原任务，请刷新。');});
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return ()=>{clearInterval(timer);c.abort();active.current?.abort();};
  },[session,invocation]);
  async function perform(work:(signal:AbortSignal)=>Promise<void>){
    if(active.current)return;
    const c=new AbortController();active.current=c;setBusy(true);setMessage('');
    try {await work(c.signal);}
    catch {if(!c.signal.aborted)setMessage('请求结果待核对。刷新页面可查询原任务。');}
    finally {if(!c.signal.aborted){setBusy(false);active.current=null;}}
  }
  function prepare(){
    void perform(async signal=>{
      setQuote(undefined);setTarget(undefined);
      const existing=await api.lookup(session,invocation,signal);
      if(existing){if(!signal.aborted)setJob(existing.job);return;}
      const price=await api.audioPrice(session,grant,signal);
      if(!price){if(!signal.aborted)setMessage('此节点当前没有可用的开发积分价格。');return;}
      const selected=await api.audioTarget(observation,signal);
      const q=await api.audioQuote(session,receipt,price,crypto.randomUUID(),signal);
      if(!signal.aborted){setQuote(q);setTarget(selected);setNow(Date.now());}
    });
  }
  function order(q:AudioQuote){
    void perform(async signal=>{
      const existing=await api.lookup(session,invocation,signal);
      if(existing){if(!signal.aborted)setJob(existing.job);return;}
      if(signal.aborted)return;
      if(BigInt(q.expires_at_unix)*1000n<=BigInt(Date.now())){setMessage('报价已过期，请重新获取。');return;}
      // One authoritative grant per invocation. Replays of this submission share its original business key.
      const result=await api.submit(session,grant,{root_budget_id:q.root_budget_id,invocation_id:invocation,
        purpose:'transcription',quote_id:q.quote_id,request_projection_digest:q.request_projection_digest});
      if(!signal.aborted)setJob(result);
    });
  }
  return <section aria-label="转写任务">
    {job ? <p role="status">转写任务已提交 <code>{job.job_id}</code> · <Link to="/tasks">查看任务</Link></p> :
      <>
        <Button disabled={busy||!recovered} onClick={prepare}>获取转写报价</Button>
        {quote&&target&&<>
          <dl><dt>执行节点与地区</dt><dd>{target.node_id} · {target.region_id}</dd>
            <dt>预算</dt><dd>{quote.root_budget_id}</dd>
            <dt>计量时长</dt><dd>{quote.duration_ms} 毫秒</dd>
            <dt>每分钟费率</dt><dd>{quote.price_per_minute} 个开发积分最小单位</dd>
            <dt>本次最多预留</dt><dd>{quote.max_amount} 个开发积分最小单位</dd>
            <dt>报价截止</dt><dd>{new Date(Number(quote.expires_at_unix)*1000).toLocaleTimeString()}</dd></dl>
          <Button disabled={busy||BigInt(quote.expires_at_unix)*1000n<=BigInt(now)} onClick={()=>order(quote)}>确认预留并提交转写</Button>
        </>}
      </>}
    {message&&<Alert type="warning" title={message}/>}
  </section>;
}
