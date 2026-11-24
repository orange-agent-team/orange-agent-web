import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Input,Space} from 'antd';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {authorityKey,type UserSession} from '../api/contracts';
import {EnrollmentClient,validRequestId} from '../api/worker-enrollment';
import {RotationClient,matchesRotation,readRotationHandoff,type RotationInput,type RotationView} from '../api/worker-rotation';

const api=new RotationClient(),enrollments=new EnrollmentClient();
function label(row:RotationView){
  if(row.enrollment.state==='revoked')return '轮换授权已撤销';
  if(row.activated_unix!==null)return '新设备证书已兑换';
  if(row.enrollment.state==='expired')return '轮换兑换窗口已过期';
  if(!row.predecessor_eligible)return '原凭据已无法用于本次轮换';
  return row.enrollment.state==='certificate_prepared'?'新证书已签发，等待原设备兑换':'轮换已授权，等待签发';
}
export default function WorkerRotation({session,owner}:{session:UserSession;owner:string}){
  const bookmark='orange.worker-rotation.v1:'+JSON.stringify([session.user_id,session.session_id,owner]);
  const [id,setId]=useState(()=>{try{const v=sessionStorage.getItem(bookmark)??'';return validRequestId(v)?v:'';}catch{return '';}});
  const [lookup,setLookup]=useState(id),[input,setInput]=useState<RotationInput>(),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[confirm,setConfirm]=useState(false);
  const serial=useRef(0),flight=useRef<AbortController|null>(null);
  const cache=useQueryClient(),key=['worker-rotation',authorityKey(session),owner,id];
  const query=useQuery({queryKey:key,queryFn:({signal})=>api.inspect(owner,id,signal),enabled:validRequestId(id),retry:false});
  const row=query.isError?undefined:query.data;
  const mismatch=!!(row&&input&&!matchesRotation(row,input));
  useEffect(()=>()=>{serial.current++;flight.current?.abort();},[]);
  function remember(v:string){sessionStorage.setItem(bookmark,v);setId(v);setLookup(v);setConfirm(false);}
  async function choose(file?:File){
    if(!file||flight.current)return;
    const ticket=++serial.current;setInput(undefined);setId('');setLookup('');setConfirm(false);setBusy(true);setError('');
    try{const next=await readRotationHandoff(file,owner);if(serial.current===ticket){remember(next.handoff.intent.replacement.request.request_id);setInput(next);}}
    catch{if(serial.current===ticket)setError('轮换文件无效，或签名意图中的归属与当前账户不符。');}
    finally{if(serial.current===ticket)setBusy(false);}
  }
  async function write(revoke:boolean){
    if(busy||flight.current||!query.isSuccess||query.isFetching||lookup!==id||mismatch||
      (revoke?(!confirm||!row):(!input||row!==null)))return;
    const ctl=new AbortController();flight.current=ctl;setBusy(true);setError('');
    try{
      await cache.cancelQueries({queryKey:key,exact:true});
      let recorded=false;
      try{
        if(revoke&&row)await enrollments.revoke(session,owner,row.enrollment,ctl.signal);
        else if(input)await api.authorize(session,owner,input,ctl.signal);
        recorded=true;
      }catch{if(ctl.signal.aborted)return;}
      const current=await api.inspect(owner,id,ctl.signal);
      if(ctl.signal.aborted)return;
      cache.setQueryData(key,current);
      if(!current || (input&&!matchesRotation(current,input)) || (revoke && current.enrollment.state!=='revoked')||
        (!revoke&&current.enrollment.requested_by!==session.user_id))throw Error('ROTATION_UNCONFIRMED');
      setConfirm(false);
      if(!recorded)setError('已按原请求编号核对平台回执。');
    }catch{if(!ctl.signal.aborted)setError('无法确认本次变更。可用原轮换请求编号重新读取记录。');}
    finally{if(flight.current===ctl){flight.current=null;if(!ctl.signal.aborted)setBusy(false);}}
  }
  return <Card><details><summary>轮换现有设备证书</summary>
    <p>在原设备上运行 <code>orange-worker prepare-certificate-rotation</code>，选择导出的公开交接文件。</p>
    <label>轮换交接文件 <input aria-label="轮换交接文件" type="file" accept=".json,application/json" disabled={busy} onChange={e=>void choose(e.target.files?.[0])}/></label>
    {input&&<><p>授权归属 <code>{owner}</code></p><p>保留节点 <code>{input.handoff.intent.node_id}</code></p>
      <p>原证书 SHA-256 <code>{input.handoff.intent.previous_certificate_sha256}</code></p>
      <p>新设备公钥 SHA-256 <code>{input.handoff.intent.replacement.request.spki_sha256}</code></p>
      <p>新证书首次连接后原凭据立即退出。兑换后的重叠时间最多两分钟。</p>
      {row===null&&<Button type="primary" disabled={busy||query.isFetching||lookup!==id} onClick={()=>void write(false)}>确认授权证书轮换</Button>}</>}
    <Space wrap><label>轮换请求编号 <Input aria-label="轮换请求编号" value={lookup} maxLength={36} disabled={busy}
      onChange={e=>{setLookup(e.target.value);setConfirm(false);}}/></label>
      <Button disabled={busy||!validRequestId(lookup)} onClick={()=>{setError('');if(id!==lookup)setInput(undefined);
        try{remember(lookup);if(id===lookup)void query.refetch();}catch{setError('当前浏览器无法保存原请求编号。');}}}>读取轮换记录</Button></Space>
    {query.isError&&<Alert type="warning" title="无法读取此轮换记录"/>}
    {mismatch&&<Alert type="error" title="平台回执与本次轮换签名意图不符"/>}
    {row&&!mismatch&&<><p data-testid="rotation-state">{label(row)}</p><p>节点 <code>{row.node_id}</code></p>
      {row.overlap_until_unix&&<p>原凭据最迟截止 <time>{new Date(Number(row.overlap_until_unix)*1000).toLocaleString()}</time></p>}
      {row.enrollment.state==='certificate_prepared'&&row.predecessor_eligible&&<code>orange-worker redeem-certificate-rotation</code>}
      {row.enrollment.state!=='revoked'&&(confirm?<><p>本次及后续换发的证书将停用。</p><Space>
        <Button danger disabled={busy||lookup!==id} onClick={()=>void write(true)}>确认撤销轮换授权</Button><Button disabled={busy} onClick={()=>setConfirm(false)}>保留轮换授权</Button></Space></>:
        <Button danger disabled={busy||lookup!==id||query.isFetching} onClick={()=>setConfirm(true)}>撤销轮换授权</Button>)}</>}
    {error&&<Alert type="warning" title={error}/>}
  </details></Card>;
}
