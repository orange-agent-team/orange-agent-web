import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { Link } from 'react-router';
import type { UserSession } from '../api/contracts';
import type { AudioGrantReceipt, AudioQuote, AudioTarget, Job } from '../api/compute-contracts';
import { ComputeClient } from '../api/compute-client';

import {ApiFailure} from '../api/client';
import {FundingDetails,useQuoteFunding} from './QuoteFunding';
import {audioQuoteScope,readAudioAttempt,beginAudioAttempt,acknowledgeAudioQuote,markAudioSubmission,type AudioQuoteAttempt} from '../api/audio-quote-intent';


export default function AudioOrder({session,receipt,api,expectedBudget}:{session:UserSession;receipt:AudioGrantReceipt;api:ComputeClient;expectedBudget?:string}) {
  const [quote,setQuote]=useState<AudioQuote>();
  const [target,setTarget]=useState<AudioTarget>();
  const [job,setJob]=useState<Job>();
  const funding=useQuoteFunding(api,session,job?undefined:quote);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [recovered,setRecovered]=useState(false);
  const [now,setNow]=useState(Date.now);
  const active=useRef<AbortController|null>(null);
  const {grant_id:grant,invocation_id:invocation,observation_id:observation}=receipt;
  const owner=api.owner(session);
  const scope=useMemo(()=>audioQuoteScope(session,owner,receipt,expectedBudget),[session.user_id,owner,grant,invocation,observation,receipt.projection_digest,expectedBudget]);
  const [attempt,setAttempt]=useState<AudioQuoteAttempt|null>(null);
  const [recordError,setRecordError]=useState(false);
  useEffect(()=>{
    const c=new AbortController();
    setRecovered(false);setRecordError(false);setJob(undefined);setQuote(undefined);setTarget(undefined);
    let saved:AudioQuoteAttempt|null=null;
    try{saved=readAudioAttempt(sessionStorage,scope);setAttempt(saved);}
    catch{setRecordError(true);setMessage('本机报价恢复记录无法核对。请先查询原任务。');}
    api.lookup(session,invocation,c.signal).then(value=>{
      if(c.signal.aborted)return;
      if(value && ((expectedBudget&&value.job.root_budget_id!==expectedBudget)||(saved?.submitting&&value.quote_id!==saved.quote)))throw Error('AUDIO_QUOTE_CHANGED');
      setJob(value?.job);setRecovered(true);
    }).catch(()=>{if(!c.signal.aborted)setMessage('暂时无法核对原任务，请刷新。');});
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return ()=>{clearInterval(timer);c.abort();active.current?.abort();};
  },[session.session_id,invocation,api,expectedBudget,scope]);
  async function perform(work:(signal:AbortSignal)=>Promise<void>){
    if(active.current)return;
    const c=new AbortController();active.current=c;setBusy(true);setMessage('');
    try {await work(c.signal);}
    catch(e) {if(!c.signal.aborted)setMessage(e instanceof ApiFailure&&e.code==='SPENDING_PAUSED'?'账户支付争议正在核对，未新增转写预留。':'请求结果待核对。刷新页面可查询原任务。');}
    finally {if(!c.signal.aborted){setBusy(false);active.current=null;}}
  }
  function prepare(replace=false){
    if(recordError||!recovered)return;
    void perform(async signal=>{
      const selectedRequest=attempt?.request;
      setQuote(undefined);setTarget(undefined);
      const existing=await api.lookup(session,invocation,signal);
      if(signal.aborted)return;
      const previous=readAudioAttempt(sessionStorage,scope);
      if(existing){
        if((expectedBudget&&existing.job.root_budget_id!==expectedBudget)||(previous?.submitting&&previous.quote!==existing.quote_id))throw Error('AUDIO_QUOTE_CHANGED');
        setJob(existing.job);return;
      }
      let current=previous;
      if(!current||replace){
        if(replace&&(!current||current.submitting||current.request!==selectedRequest))throw Error('AUDIO_QUOTE_CHANGED');
        const price=await api.audioPrice(session,grant,signal);
        if(signal.aborted)return;
        if(!price){setMessage('此节点当前没有可用的开发积分价格。');return;}
        current=beginAudioAttempt(sessionStorage,scope,price,replace?selectedRequest:undefined);
      }
      setAttempt(current);
      const selected=await api.audioTarget(observation,signal);
      const q=await api.audioQuote(session,receipt,current.price,current.request,signal);
      if(signal.aborted)return;
      setAttempt(acknowledgeAudioQuote(sessionStorage,scope,current.request,q));
      setQuote(q);setTarget(selected);setNow(Date.now());
    });
  }
  function order(q:AudioQuote){
    if(!attempt || recordError || funding.isFetching||funding.error||funding.data?.status!=='sufficient'||funding.data.quote_id!==q.quote_id)return;
    void perform(async signal=>{
      const existing=await api.lookup(session,invocation,signal);
      if(existing){
        if((expectedBudget&&existing.job.root_budget_id!==expectedBudget)||(attempt.submitting&&existing.quote_id!==attempt.quote))throw Error('AUDIO_QUOTE_CHANGED');
        if(!signal.aborted)setJob(existing.job);
        return;
      }
      if(signal.aborted)return;
      if(BigInt(q.expires_at_unix)*1000n<=BigInt(Date.now())){setMessage('报价已过期，请重新获取。');return;}
      // One authoritative grant per invocation. Replays of this submission share its original business key.
      setAttempt(markAudioSubmission(sessionStorage,scope,attempt.request,q.quote_id));
      const result=await api.submit(session,grant,{root_budget_id:q.root_budget_id,invocation_id:invocation,
        purpose:'transcription',quote_id:q.quote_id,request_projection_digest:q.request_projection_digest});
      if(!signal.aborted)setJob(result);
    });
  }
  return <section aria-label="转写任务">
    {job ? <p role="status">转写任务已提交 <code>{job.job_id}</code> · <Link to={api.owner(session)===session.personal_owner_id?'/tasks':'/organizations/'+encodeURIComponent(api.owner(session))+'/tasks?job='+encodeURIComponent(job.job_id)}>查看任务</Link></p> :
      <>
        <Button disabled={busy||!recovered||recordError} onClick={()=>prepare()}>{attempt?'核对原转写报价':'获取转写报价'}</Button>
        {attempt&&!attempt.submitting&&(message||quote&&BigInt(quote.expires_at_unix)*1000n<=BigInt(now))&&
          <Button disabled={busy||!recovered||recordError} onClick={()=>prepare(true)}>放弃本次报价并重新获取</Button>}
        {attempt?.submitting&&!job&&<p>提交结果需核对。原授权和请求编号已保留，可查询原任务或撤回音频授权。</p>}
        {quote&&target&&<>
          <FundingDetails query={funding}/><dl><dt>模型版本</dt><dd>{target.model_version}</dd><dt>执行节点与地区</dt><dd>{target.node_id} · {target.region_id}</dd>
            <dt>预算</dt><dd>{quote.root_budget_id}</dd>
            <dt>计量时长</dt><dd>{quote.duration_ms} 毫秒</dd>
            <dt>每分钟费率</dt><dd>{quote.price_per_minute} 个开发积分最小单位</dd>
            <dt>本次最多预留</dt><dd>{quote.max_amount} 个开发积分最小单位</dd>
            <dt>报价截止</dt><dd>{new Date(Number(quote.expires_at_unix)*1000).toLocaleTimeString()}</dd></dl>
          <Button disabled={busy||funding.isFetching||!!funding.error||funding.data?.status!=='sufficient'||BigInt(quote.expires_at_unix)*1000n<=BigInt(now)} onClick={()=>order(quote)}>确认预留并提交转写</Button>
        </>}
      </>}
    {message&&<Alert type="warning" title={message}/>}
  </section>;
}
