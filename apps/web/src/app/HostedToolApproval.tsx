import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert, Button, Space} from 'antd';
import {CloudClient, type CloudOperation, type CloudOps, type Choice} from '../api/cloud-runs';
import {ApiFailure} from '../api/client';
import {authorityKey, type UserSession} from '../api/contracts';

const api=new CloudClient();
type Decision='approve'|'reject';
type Intent={
  operationId:string;
  approvalId:string;
  reviewDigest:string;
  version:string;
  decision:Decision;
  key:string;
};
type Props={session:UserSession;run:string;choice:Choice;invalidate:()=>void};
const states={intended:'等待执行',dispatching:'已发出一次性许可',succeeded:'已完成',failed:'未执行或已失败',unknown:'执行结果待核对'};

function observeConnection(notify:()=>void){
  document.addEventListener('visibilitychange',notify);
  window.addEventListener('online',notify);
  window.addEventListener('offline',notify);
  return ()=>{
    document.removeEventListener('visibilitychange',notify);
    window.removeEventListener('online',notify);
    window.removeEventListener('offline',notify);
  };
}
const viewAvailable=()=>!document.hidden && navigator.onLine;

export default function HostedToolApproval(props:Props){
  const available=useSyncExternalStore(observeConnection,viewAvailable);
  if(!available)return null;
  return <ApprovalView key={JSON.stringify([authorityKey(props.session),props.run,props.choice.execution_digest])} {...props}/>;
}

function sameReview(op:CloudOperation,intent:Intent){
  return op.operation_id===intent.operationId && op.approval_id===intent.approvalId && op.review_digest===intent.reviewDigest;
}
function actionable(scope:CloudOps|undefined,op:CloudOperation|undefined){
  return !!scope && !scope.revoked && scope.source_available && !!op?.arguments && op.state==='intended' && !op.decision;
}

function ApprovalView({session,run,choice,invalidate}:Props){
  const [view]=useState(()=>crypto.randomUUID());
  const q=useQuery({queryKey:[authorityKey(session),'cloud-operations',run,view],
    queryFn:({signal})=>api.operations(session,run,signal),refetchInterval:1500,gcTime:0,retry:false});
  const [pending,setPending]=useState<Intent>();
  const [checked,setChecked]=useState(false);
  const [issue,setIssue]=useState('');
  const [busy,setBusy]=useState(false);
  const [revoking,setRevoking]=useState(false);
  const lock=useRef(false), live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const current=q.error||q.data?.execution_digest!==choice.execution_digest?undefined:q.data;
  const matching=pending && current?.data.find(op=>sameReview(op,pending));

  useEffect(()=>{
    if(!pending || !current)return;
    if(matching?.decision===pending.decision){
      setPending(undefined);setChecked(false);setIssue('');
    } else if(!matching || !actionable(current,matching) || matching.version!==pending.version){
      setPending(undefined);setChecked(false);setIssue('这次申请的内容或权限已变化，请重新核对。');
    }
  },[pending,current,matching]);

  async function submit(op:CloudOperation,decision:Decision,key:string){
    if(lock.current || !viewAvailable() || !actionable(current,op))return;
    lock.current=true;setBusy(true);setIssue('');setChecked(false);
    try{
      await api.decide(session,run,op,decision,key);
      if(live.current){setPending(undefined);await q.refetch();}
    } catch(e){
      if(!live.current)return;
      if(e instanceof ApiFailure && [401,403].includes(e.status)){invalidate();return;}
      const uncertain=!(e instanceof ApiFailure)||e.status===0||e.status<300||e.status>=500;
      setPending(uncertain?{operationId:op.operation_id,approvalId:op.approval_id,reviewDigest:op.review_digest,version:op.version,decision,key}:undefined);
      setIssue(uncertain?'决定尚未确认，请核对原请求。':'工具版本或权限已变化，请重新核对。');
      void q.refetch();
    } finally {lock.current=false;if(live.current)setBusy(false);}
  }

  async function checkDecision(){
    if(lock.current || !pending || !viewAvailable())return;
    lock.current=true;setBusy(true);setChecked(false);
    try{
      const result=await q.refetch({throwOnError:true});
      if(!live.current)return;
      const latest=result.data;
      const op=latest?.data.find(row=>sameReview(row,pending));
      if(op?.decision===pending.decision){setPending(undefined);setIssue('');}
      else if(latest?.execution_digest===choice.execution_digest && op?.version===pending.version && actionable(latest,op)){
        setChecked(true);setIssue('服务端尚未确认这次决定。你可以再次提交原决定。');
      } else {setPending(undefined);setIssue('这次申请的内容或权限已变化，请重新核对。');}
    } catch(e){
      if(live.current){
        if(e instanceof ApiFailure && [401,403].includes(e.status))invalidate();
        else setIssue('暂时无法核对原决定，请稍后重试查询。');
      }
    } finally {lock.current=false;if(live.current)setBusy(false);}
  }

  async function revoke(){
    if(lock.current || !viewAvailable())return;
    lock.current=true;setBusy(true);
    try{
      await api.revokeDirectory(session,run,run);
      if(live.current){setRevoking(false);setPending(undefined);await q.refetch();}
    } catch(e){
      if(live.current){
        if(e instanceof ApiFailure && [401,403].includes(e.status))invalidate();
        else setIssue('撤销结果尚未确认，请刷新核对。');
      }
    } finally {lock.current=false;if(live.current)setBusy(false);}
  }

  return <section aria-label="工具审批"><h3>工作区目录权限</h3>
    {q.error&&<Alert type="warning" title="工具操作读取失败"/>}
    {current&&<><p>工作区 {current.workspace_id} · {current.revoked?'权限已撤销':current.source_available?'当前有效':'来源不可用'}</p>
      {current.data.map(op=><section key={op.operation_id} aria-label="目录操作">
        <p>{op.tool_version} · {states[op.state]} · {op.decision==='approve'?'已批准':op.decision==='reject'?'已拒绝':'尚无决定'}</p>
        {op.arguments&&<pre aria-label="工具参数">{JSON.stringify(op.arguments,null,2)}</pre>}
        <p>模型提交 {op.commit_id}</p><p>审核摘要 {op.review_digest}</p>
        {actionable(current,op)&&<Space>
          <Button disabled={busy||!!pending} onClick={()=>void submit(op,'approve',crypto.randomUUID())}>批准本次目录读取</Button>
          <Button disabled={busy||!!pending} onClick={()=>void submit(op,'reject',crypto.randomUUID())}>拒绝本次目录读取</Button>
        </Space>}
        {op.result&&<div aria-label="已提交的目录结果">{op.result.entries.map(f=><p key={f.name}>{f.name} · {f.bytes} 字节</p>)}</div>}
      </section>)}
      {!current.revoked&&(revoking?<Space><Button danger disabled={busy} onClick={()=>void revoke()}>确认撤销目录权限</Button>
        <Button disabled={busy} onClick={()=>setRevoking(false)}>返回</Button></Space>:<Button disabled={busy} onClick={()=>setRevoking(true)}>撤销目录权限</Button>)}
    </>}
    {issue&&<Alert type="warning" title={issue}/>}
    {pending&&<Space><Button disabled={busy} onClick={()=>void checkDecision()}>核对原决定</Button>
      {checked && matching?.version===pending.version && actionable(current,matching) &&
        <Button disabled={busy} onClick={()=>void submit(matching,pending.decision,pending.key)}>
          {pending.decision==='approve'?'再次提交原批准':'再次提交原拒绝'}
        </Button>}
    </Space>}
  </section>;
}
