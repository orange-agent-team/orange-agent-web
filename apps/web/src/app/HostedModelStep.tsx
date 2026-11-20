import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Space} from 'antd';
import {CloudClient} from '../api/cloud-runs';
import {authorityKey,type UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';
import {formatCredits} from '../api/accounts';
import type {Quote} from '../api/compute-contracts';
const api=new CloudClient();
const labels={awaiting_workspace:'等待工作区准备',ready_to_quote:'可以询价',submitted:'模型作业已提交',result_available:'模型答复已提交',stopped:'已停止',unavailable:'输入或答复已不可用'};

export default function HostedModelStep({session,run,invalidate}:{session:UserSession;run:string;invalidate:()=>void}){
  const step=useQuery({queryKey:[authorityKey(session),'hosted-model',run],queryFn:({signal})=>api.modelStep(session,run,signal),refetchInterval:2000});
  const [quote,setQuote]=useState<Quote>(),[text,setText]=useState<string>(),[issue,setIssue]=useState(''),[busy,setBusy]=useState(false);
  const [timeExpired,setTimeExpired]=useState(false),[checkingConfirmation,setCheckingConfirmation]=useState(false);
  const original=useRef<string>(''),lock=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const state=step.error?undefined:step.data;
  useEffect(()=>{if(state?.stage!=='result_available')setText(undefined);},[state?.stage]);
  useEffect(()=>{
    if(!quote){setTimeExpired(false);return;}
    const remaining=Number(quote.expires_at_unix)*1000-Date.now();
    setTimeExpired(remaining<=0);
    if(remaining<=0)return;
    const timer=setTimeout(()=>setTimeExpired(true),remaining);return()=>clearTimeout(timer);
  },[quote]);
  useEffect(()=>{
    if(checkingConfirmation&&state?.job_id){setCheckingConfirmation(false);setIssue('');}
  },[checkingConfirmation,state?.job_id]);
  function error(e:unknown){
    if(e instanceof ApiFailure&&[401,403].includes(e.status)){invalidate();return;}
    setIssue(e instanceof ApiFailure&&e.code==='BUDGET_EXCEEDED'?'当前预算或余额不足。':'操作未确认，请刷新模型步骤并核对原报价。');
  }
  async function act(f:()=>Promise<void>){
    if(lock.current)return;lock.current=true;setBusy(true);setIssue('');
    try{await f();}catch(e){if(live.current)error(e);}finally{lock.current=false;if(live.current)setBusy(false);}
  }
  const expired=quote&&(timeExpired||Number(quote.expires_at_unix)*1000<=Date.now());
  return <Card title="模型步骤" extra={<Button aria-label="刷新模型步骤" onClick={()=>void step.refetch()}>刷新</Button>}>
    {step.error&&<p>{step.error instanceof ApiFailure&&step.error.status===404?'该运行只准备工作区。':'模型步骤暂时不可用。'}</p>}
    {state&&<><p>{labels[state.stage]} · {state.model_version}</p><p>预算 {state.root_budget_id} · 每次最多 {state.output_limit} 个输出单位</p>
      {state.stage==='ready_to_quote'&&<Space direction="vertical">
        <Button disabled={busy} onClick={()=>void act(async()=>{
          if(!original.current||expired)original.current=crypto.randomUUID();
          const q=await api.quoteModel(session,state,original.current);if(live.current)setQuote(q);
        })}>{expired?'重新询价':'获取模型报价'}</Button>
        {quote&&<section aria-label="本次模型报价"><p>最高扣款 {formatCredits(quote.max_amount)} 积分 · 输入计量 {quote.input_units} · 价格版本 {quote.price_version}</p>
          <p>报价编号 {quote.quote_id} · 到期 {new Date(Number(quote.expires_at_unix)*1000).toLocaleString()}</p>
          <Button type="primary" disabled={busy||!!expired} onClick={()=>void act(async()=>{
            setCheckingConfirmation(true);
            try{await api.confirmModel(session,state,quote);if(live.current){setCheckingConfirmation(false);await step.refetch();}}
            catch(e){if(e instanceof ApiFailure&&e.status>=400&&e.status<500)setCheckingConfirmation(false);throw e;}
          })}>确认报价并提交模型作业</Button>
        </section>}
      </Space>}
      {state.job_id&&<p>模型作业 {state.job_id}</p>}
      {state.stage==='result_available'&&<Button disabled={busy} onClick={()=>void act(async()=>{
        const r=await api.committedModelResult(session,state);
        if(live.current)setText(r.text);
      })}>读取已提交的答复</Button>}
      {state.stage==='result_available'&&text!==undefined&&<pre aria-label="托管模型答复" style={{whiteSpace:'pre-wrap'}}>{text}</pre>}
    </>}
    {issue&&<Alert type="warning" title={issue}/>}
  </Card>;
}
