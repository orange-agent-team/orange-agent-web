import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Space} from 'antd';
import {CloudClient,type CloudOperation,type Choice} from '../api/cloud-runs';
import {ApiFailure} from '../api/client';
import {authorityKey,type UserSession} from '../api/contracts';
const api=new CloudClient();
type Intent={op:CloudOperation;choice:'approve'|'reject';key:string};
const states={intended:'等待执行',dispatching:'已发出一次性许可',succeeded:'已完成',failed:'未执行或已失败',unknown:'执行结果待核对'};
export default function HostedToolApproval({session,run,choice,invalidate}:{session:UserSession;run:string;choice:Choice;invalidate:()=>void}){
  const q=useQuery({queryKey:[authorityKey(session),'cloud-operations',run],queryFn:({signal})=>api.operations(session,run,signal),refetchInterval:1500});
  const [pending,setPending]=useState<Intent>(),[issue,setIssue]=useState(''),[busy,setBusy]=useState(false),[revoking,setRevoking]=useState(false);
  const lock=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const current=q.error||q.data?.execution_digest!==choice.execution_digest?undefined:q.data;
  useEffect(()=>{if(pending && current?.data.some(op=>op.operation_id===pending.op.operation_id&&op.decision===pending.choice)){setPending(undefined);setIssue('');}},[pending,current]);
  async function choose(intent:Intent){
    if(lock.current)return;lock.current=true;setBusy(true);setIssue('');
    try{await api.decide(session,run,intent.op,intent.choice,intent.key);if(live.current){setPending(undefined);await q.refetch();}}
    catch(e){if(live.current){
      if(e instanceof ApiFailure&&[401,403].includes(e.status)){invalidate();return;}
      const uncertain=!(e instanceof ApiFailure)||e.status===0||e.status<300||e.status>=500;
      setPending(uncertain?intent:undefined);setIssue(uncertain?'决定尚未确认，请核对原请求。':'工具版本或权限已变化，请重新核对。');void q.refetch();
    }}finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function revoke(){
    if(lock.current)return;lock.current=true;setBusy(true);
    try{await api.revokeDirectory(session,run,run);if(live.current){setRevoking(false);setPending(undefined);await q.refetch();}}
    catch(e){if(live.current){if(e instanceof ApiFailure&&[401,403].includes(e.status))invalidate();else setIssue('撤销结果尚未确认，请刷新核对。');}}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  return <section aria-label="工具审批"><h3>工作区目录权限</h3>
    {q.error&&<Alert type="warning" title="工具操作读取失败"/>}
    {current&&<><p>工作区 {current.workspace_id} · {current.revoked?'权限已撤销':current.source_available?'当前有效':'来源不可用'}</p>
      {current.data.map(op=><section key={op.operation_id} aria-label="目录操作">
        <p>{op.tool_version} · {states[op.state]} · {op.decision==='approve'?'已批准':op.decision==='reject'?'已拒绝':'尚无决定'}</p>
        {op.arguments&&<pre aria-label="工具参数">{JSON.stringify(op.arguments,null,2)}</pre>}
        <p>模型提交 {op.commit_id}</p><p>审核摘要 {op.review_digest}</p>
        {op.state==='intended'&&!op.decision&&op.arguments&&!current.revoked&&current.source_available&&<Space>
          <Button disabled={busy||!!pending} onClick={()=>void choose({op,choice:'approve',key:crypto.randomUUID()})}>批准本次目录读取</Button>
          <Button disabled={busy||!!pending} onClick={()=>void choose({op,choice:'reject',key:crypto.randomUUID()})}>拒绝本次目录读取</Button>
        </Space>}
        {op.result&&<div aria-label="已提交的目录结果">{op.result.entries.map(f=><p key={f.name}>{f.name} · {f.bytes} 字节</p>)}</div>}
      </section>)}
      {!current.revoked&&(revoking?<Space><Button danger disabled={busy} onClick={()=>void revoke()}>确认撤销目录权限</Button>
        <Button disabled={busy} onClick={()=>setRevoking(false)}>返回</Button></Space>:<Button disabled={busy} onClick={()=>setRevoking(true)}>撤销目录权限</Button>)}
    </>}
    {issue&&<Alert type="warning" title={issue}/>}
    {pending&&<Button disabled={busy} onClick={()=>void choose(pending)}>核对原决定</Button>}
  </section>;
}
