import WorkerRotation from './WorkerRotation';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Input,Space,Spin,Typography} from 'antd';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link,useParams} from 'react-router';
import {ApiFailure} from '../api/client';
import {authorityKey,type UserSession} from '../api/contracts';
import {TeamClient} from '../api/team';
import {EnrollmentClient,readEnrollmentHandoff,validRequestId,type EnrollmentHandoff,type EnrollmentState} from '../api/worker-enrollment';

const api=new EnrollmentClient();
const teams=new TeamClient();
const labels:Record<EnrollmentState,string>={
  authorized:'已授权，等待签发',certificate_prepared:'证书已准备，等待设备兑换',redeemed:'设备已兑换证书',revoked:'授权已撤销',expired:'兑换窗口已过期',
};
export default function WorkerEnrollment({session}:{session:UserSession}){
  const {org}=useParams();
  const team=useQuery({queryKey:['worker-enrollment-team',authorityKey(session),org],
    queryFn:({signal})=>teams.organization(session,org!,signal),enabled:!!org,retry:false,refetchInterval:5000});
  if(org && team.isPending)return <Spin/>;
  if(org && (team.isError || !team.data || !['admin','owner'].includes(team.data.role)))return <Alert type="warning" title="需要当前团队所有者或管理员权限"/>;
  const owner=org??session.personal_owner_id;
  return <Enrollment key={JSON.stringify([authorityKey(session),owner])} session={session} owner={owner}
    ownerLabel={org?team.data!.name:'个人账户'} back={org?'/organizations/'+encodeURIComponent(org):'/account'}/>;
}
function Enrollment({session,owner,ownerLabel,back}:{session:UserSession;owner:string;ownerLabel:string;back:string}){
  const bookmark='orange.worker-enrollment.v1:'+JSON.stringify([session.user_id,session.session_id,owner]);
  const cache=useQueryClient();
  const [id,setId]=useState<string>(()=>{try{const old=sessionStorage.getItem(bookmark)??'';return validRequestId(old)?old:'';}catch{return '';}});
  const [lookup,setLookup]=useState(id);
  const [handoff,setHandoff]=useState<EnrollmentHandoff>();
  const [busy,setBusy]=useState(false);
  const [issue,setIssue]=useState('');
  const [readback,setReadback]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const active=useRef<AbortController|null>(null);
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;active.current?.abort();},[]);
  const queryKey=['worker-enrollment',authorityKey(session),owner,id];
  const query=useQuery({queryKey,queryFn:({signal})=>api.inspect(owner,id,signal),enabled:validRequestId(id),retry:false});
  const result=query.isError?undefined:query.data;
  const mismatch=!!(result&&handoff&&(result.spki_sha256!==handoff.request.spki_sha256 || result.csr_sha256!==handoff.request.csr_sha256));
  const remember=(next:string)=>{sessionStorage.setItem(bookmark,next);setLookup(next);setId(next);setConfirm(false);};
  async function fileSelected(file:File|undefined){
    if(!file||active.current)return;
    const version=++generation.current;setHandoff(undefined);setId('');setLookup('');setConfirm(false);setIssue('');setReadback(false);setBusy(true);
    try{
      const data=await readEnrollmentHandoff(file);
      if(version!==generation.current)return;
      remember(data.request.request_id);setHandoff(data);
    }catch{if(version===generation.current)setIssue('请使用 Worker 导出的公开交接 JSON，并核对请求摘要。');}
    finally{if(version===generation.current)setBusy(false);}
  }
  function inspect(){
    if(busy||!validRequestId(lookup))return;
    generation.current++;setIssue('');setReadback(false);if(lookup!==id)setHandoff(undefined);
    try{remember(lookup);if(lookup===id)void query.refetch();}
    catch{setIssue('当前浏览器无法保存请求编号。');}
  }
  async function mutate(action:'authorize'|'revoke'){
    if(active.current||busy||!id||lookup!==id||mismatch || (action==='authorize' && !handoff) || (action==='revoke' && (!result||!confirm)))return;
    const controller=new AbortController();active.current=controller;setBusy(true);setIssue('');setReadback(false);
    try{
      sessionStorage.setItem(bookmark,id);
      await cache.cancelQueries({queryKey,exact:true});
      const receipt=action==='authorize'?await api.authorize(session,owner,handoff!,controller.signal):await api.revoke(session,owner,result!,controller.signal);
      if(!controller.signal.aborted){cache.setQueryData(queryKey,receipt);setConfirm(false);}
    }catch(e){
      if(!controller.signal.aborted){
        if(e instanceof ApiFailure && (e.status===401||e.status===403)){
          setIssue('当前登录或团队权限已失效。');await query.refetch();
        }else{
          const original=await query.refetch();
          if(controller.signal.aborted)return;
          const receipt=original.isError?null:original.data;
          const matches=receipt && (action==='authorize' ? handoff && receipt.requested_by===session.user_id &&
            receipt.csr_sha256===handoff.request.csr_sha256 && receipt.spki_sha256===handoff.request.spki_sha256 :
            result && receipt.state==='revoked' && receipt.spki_sha256===result.spki_sha256 && receipt.csr_sha256===result.csr_sha256 &&
            receipt.requested_by===result.requested_by && receipt.expires_unix===result.expires_unix);
          if(matches){setReadback(true);setConfirm(false);}
          else setIssue('操作结果尚未确认，请按原请求编号刷新状态。');
        }
      }
    }finally{if(active.current===controller){active.current=null;if(!controller.signal.aborted)setBusy(false);}}
  }
  return <section className="enrollment-page" aria-label="设备注册">
    <p><Link to={back}>返回{ownerLabel}</Link></p><h1>设备注册</h1>
    <Card><h2>授权设备公钥</h2><p>在设备上运行 <code>orange-worker prepare-enrollment-handoff</code>，选择导出的公开 JSON。</p>
      <label>公开交接文件 <input aria-label="公开交接文件" type="file" accept=".json,application/json" disabled={busy}
        onChange={e=>{void fileSelected(e.target.files?.[0]);}}/></label>
      {handoff&&(!result||mismatch)&&<><p>授权归属 <strong>{ownerLabel}</strong> · <code>{owner}</code></p><p>请求编号 <code>{handoff.request.request_id}</code></p>
        <p>设备公钥 SHA-256 <Typography.Text copyable>{handoff.request.spki_sha256}</Typography.Text></p>
        <p>请与设备端显示的公钥摘要核对。授权自首次提交起有效 10 分钟。</p>
        <Button type="primary" disabled={busy||lookup!==id||query.isFetching||!query.isSuccess||result!==null||mismatch} onClick={()=>void mutate('authorize')}>确认授权设备</Button></>}
    </Card>
    <WorkerRotation session={session} owner={owner}/>
    <Card><h2>查询与撤销</h2><Space wrap><label>请求编号 <Input aria-label="查询请求编号" value={lookup} maxLength={36} disabled={busy}
      onChange={e=>{setLookup(e.target.value);setConfirm(false);}}/></label><Button disabled={busy||!validRequestId(lookup)} onClick={inspect}>读取授权状态</Button></Space>
      {query.isFetching&&id&&<p>正在读取授权状态</p>}
      {query.isError&&<Alert type="warning" title="当前无法读取这项授权"/>}
      {result===null&&<p>尚未找到这项设备授权。</p>}
      {mismatch&&<Alert type="error" title="现有授权与交接文件的设备摘要不符"/>}
      {result&&!mismatch&&<><p>{ownerLabel} · 请求 <code>{result.request_id}</code></p><p>设备公钥 <Typography.Text copyable>{result.spki_sha256}</Typography.Text></p><p>状态 <strong data-testid="enrollment-state">{labels[result.state]}</strong></p><p>授权截止 <time>{new Date(Number(result.expires_unix)*1000).toLocaleString()}</time></p>
        {result.state==='certificate_prepared'&&<p>可在原设备上运行 <code>orange-worker redeem-enrollment</code> 安装证书。</p>}
        {result.state==='redeemed'&&<p>设备已取得客户端证书。连接和接单状态由 Worker 网关记录。</p>}
        {result.state!=='revoked'&&<>{confirm?<><p>撤销会停用本次授权及其后续轮换已经兑换的设备证书。</p>
          <Space><Button danger disabled={busy} onClick={()=>void mutate('revoke')}>确认撤销设备授权</Button><Button disabled={busy} onClick={()=>setConfirm(false)}>保留授权</Button></Space></>:
          <Button danger disabled={busy||lookup!==id||query.isFetching} onClick={()=>setConfirm(true)}>撤销设备授权</Button>}</>}
      </>}
    </Card>{readback&&<Alert type="info" title="已按原请求编号读回平台记录。"/>}{issue&&<Alert type="warning" title={issue}/>}
  </section>;
}
