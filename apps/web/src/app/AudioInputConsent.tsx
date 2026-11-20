import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input } from 'antd';
import type { UserSession } from '../api/contracts';
import { ComputeClient } from '../api/compute-client';
import { ApiFailure } from '../api/client';
import { pathId, type AudioGrantReceipt, type AudioMeasurement, type AudioTarget } from '../api/compute-contracts';

const api = new ComputeClient();
type Props = {session:UserSession;upload:string;measurement?:AudioMeasurement};

export default function AudioInputConsent({session,upload,measurement}:Props) {
  const key='orange.audio-consent.v1:'+session.user_id+':'+session.personal_owner_id;
  const [grant,setGrant]=useState('');
  const [state,setState]=useState<AudioGrantReceipt['state']|'unknown'>('unknown');
  const [expires,setExpires]=useState('');
  const [observation,setObservation]=useState('');
  const [target,setTarget]=useState<AudioTarget>();
  const [budget,setBudget]=useState('');
  const [language,setLanguage]=useState('');
  const [approved,setApproved]=useState('');
  const [busy,setBusy]=useState(false);
  const [initialized,setInitialized]=useState(false);
  const [error,setError]=useState('');
  const active=useRef<AbortController|null>(null);
  const consentScope=JSON.stringify([session.user_id,upload,measurement?.version_id,measurement?.audio_sha256,measurement?.normalized_sha256,target,budget,language]);
  useEffect(()=>{
    try {
      const id=sessionStorage.getItem(key);
      if(id){pathId(id);setGrant(id);}
      setInitialized(true);
    } catch {setError('无法读取授权恢复记录。');}
    return ()=>active.current?.abort();
  },[key]);
  useEffect(()=>{
    if(!grant||busy||state==='revoked'||state==='expired')return;
    const c=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function check(){
      try {
        const r=await api.audioGrant(session,grant,c.signal);
        if(!c.signal.aborted){setState(r.state);setExpires(r.expires_at_unix);setError('');}
      } catch(failure){
        if(!c.signal.aborted){setState('unknown');setExpires('');setError(failure instanceof ApiFailure&&failure.status===404?'尚未找到已签发授权，可撤回这个编号。':'暂时无法确认授权状态，可撤回后重新授权。');}
      } finally {if(!c.signal.aborted)timer=setTimeout(()=>void check(),5000);}
    }
    void check();
    return ()=>{clearTimeout(timer);c.abort();};
  },[grant,busy,state,session]);
  async function perform(action:(signal:AbortSignal)=>Promise<void>){
    if(active.current)return;
    const c=new AbortController();active.current=c;setBusy(true);setError('');
    try{await action(c.signal);}
    catch{if(!c.signal.aborted)setError('请求结果尚未确认，请核对目标与授权状态。');}
    finally{if(!c.signal.aborted){active.current=null;setBusy(false);}}
  }
  function submit(){
    if(!measurement||!target||!budget||approved!==consentScope||grant||!initialized)return;
    void perform(async signal=>{
      pathId(budget);
      const id=crypto.randomUUID();
      // Save the recovery handle before dispatch. A lost response can be reconciled or withdrawn.
      sessionStorage.setItem(key,id);setGrant(id);setState('unknown');
      const result=await api.createAudioGrant(session,{grant_id:id,invocation_id:crypto.randomUUID(),root_budget_id:budget,upload_id:upload,
        observation_id:target.observation_id,node_id:target.node_id,region_id:target.region_id,execution_profile_digest:target.execution_profile_digest,
        measurement,language:language||null,ttl_seconds:900,allow_remote_transcription:true},signal);
      if(!signal.aborted){setState(result.state);setExpires(result.expires_at_unix);}
    });
  }
  if(!grant&&!measurement&&!error)return null;
  return <Card title="远程转写输入授权">
    {grant ? <>
      <p>授权编号 <code>{grant}</code></p>
      <p role="status">{({active:'授权有效',revoked:'授权已撤回',expired:'授权已过期',unknown:'授权待核对'})[state]}
        {state==='active'&&expires&&<>，截止 {new Date(Number(expires)*1000).toLocaleTimeString()}</>}</p>
      {state==='expired'||state==='revoked'?
        <Button disabled={busy} onClick={()=>{try{sessionStorage.removeItem(key);setGrant('');setState('unknown');setApproved('');setError('');}catch{setError('无法清除本机恢复记录。');}}}>完成</Button>:
        <Button disabled={busy} onClick={()=>void perform(async signal=>{await api.withdrawAudio(session,grant,signal);if(!signal.aborted){setState('revoked');setExpires('');}})}>撤回音频授权</Button>}
    </> : <>
      <p>允许一个已审核的节点在有效任务租约内读取这份音频。授权有效期为 15 分钟，创建授权不产生费用。</p>
      <label>节点观测编号<Input value={observation} disabled={busy} onChange={e=>{setObservation(e.target.value);setTarget(undefined);setApproved('');}}/></label>
      <Button disabled={busy||!observation} onClick={()=>void perform(async signal=>{setTarget(undefined);setApproved('');const t=await api.audioTarget(observation,signal);if(!signal.aborted)setTarget(t);})}>核对转写节点</Button>
      {target&&<>
        <dl><dt>节点</dt><dd>{target.node_id}</dd><dt>地区</dt><dd>{target.region_id}</dd><dt>模型</dt><dd>{target.model_version}</dd></dl>
        <label>预算编号<Input value={budget} disabled={busy} onChange={e=>{setBudget(e.target.value);setApproved('');}}/></label>
        <p><label>转写语言 <select value={language} disabled={busy} onChange={e=>{setLanguage(e.target.value);setApproved('');}}>
          <option value="">自动检测</option><option value="zh">中文</option><option value="en">英语</option></select></label></p>
        <p><label><input type="checkbox" checked={approved===consentScope} disabled={busy||!measurement||!budget} onChange={e=>setApproved(e.target.checked?consentScope:'')}/>允许此节点读取当前音频版本用于本次转写</label></p>
        <Button type="primary" disabled={busy||!initialized||!measurement||!budget||approved!==consentScope} onClick={submit}>授权 15 分钟</Button>
      </>}
    </>}
    {error&&<Alert type="warning" title={error}/>}
  </Card>;
}
