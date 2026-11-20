import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Select,Space} from 'antd';
import {Link} from 'react-router';
import {CloudClient,type Choice} from '../api/cloud-runs';
import {PgConnectorClient} from '../api/pg-connector';
import {S3Client} from '../api/s3-connector';
import type {UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';

const api=new CloudClient(),pg=new PgConnectorClient(),s3=new S3Client();
export default function ModelConnectorApproval({session,run,choice,stage}:{session:UserSession;run:string;choice:Choice;stage:string}){
  const [grant,setGrant]=useState<string>(),[working,setWorking]=useState(false),[error,setError]=useState('');
  const pending=useRef<{intent:string;key:string}|undefined>(undefined);
  const locked=useRef(false);
  const op=useQuery({queryKey:['model-connector',session.session_id,run,choice.execution_digest],enabled:['waiting_tool','tool_result_available','stopped'].includes(stage),
    queryFn:({signal})=>api.modelConnector(run,choice,signal),refetchInterval:2000,retry:false});
  const model=op.isError?undefined:op.data;
  type Scope={run_readable:boolean;sources:{source_digest:string;source_id:string}[];recent_grants:{source_id:string;source_digest:string;grant_id:string;revoked:boolean;expires_at:string;view_ids?:string[]}[]};
  const grants=useQuery<Scope>({queryKey:['model-connector-grants',session.session_id,run,model?.connector],enabled:model?.state==='waiting_approval',
    queryFn:({signal})=>model?.connector==='s3'?s3.inventory(run,signal):pg.inventory(run,signal),refetchInterval:2000,retry:false});
  if(!model)return op.isError?<Alert type="warning" title="未能核对模型工具请求"/>:null;
  const inventory=grants.data;
  const rows=grants.isError||!inventory?.run_readable?[]:inventory.recent_grants.filter(g=>!g.revoked&&Date.parse(g.expires_at)>Date.now()&&(!g.view_ids||typeof model.arguments?.view_id!=='string'||g.view_ids.includes(model.arguments.view_id))&&inventory.sources.some(s=>s.source_digest===g.source_digest&&s.source_id===g.source_id));
  async function decide(decision:'approve'|'reject'){
    if(!model||locked.current)return;
    const intent=JSON.stringify([model.operation_id,model.argument_digest,decision,decision==='approve'?grant:null]);
    if(pending.current?.intent!==intent)pending.current={intent,key:crypto.randomUUID()};
    locked.current=true;setWorking(true);setError('');
    try{await api.decideModelConnector(session,model,decision,grant,pending.current.key);pending.current=undefined;}
    catch(e){setError(e instanceof ApiFailure?e.code:'REQUEST_FAILED');}
    finally{await op.refetch();locked.current=false;setWorking(false);}
  }
  return <Card title="模型连接器审批">
    <p>{model.connector} · {model.tool} · {model.state}</p>
    {model.arguments&&<pre>{JSON.stringify(model.arguments,null,2)}</pre>}
    {model.state==='waiting_approval'&&<Space wrap>
      <Link to={'/agent/runs/'+encodeURIComponent(run)+'/'+model.connector}>管理本运行的数据源授权</Link>
      <Select aria-label="此次调用使用的授权" value={grant} onChange={setGrant} placeholder="选择已批准的数据源" disabled={working} options={rows.map(g=>({value:g.grant_id,label:g.source_id+' · '+g.grant_id}))}/>
      <Button disabled={working||!rows.some(g=>g.grant_id===grant)} onClick={()=>void decide('approve')}>批准此次连接器调用</Button>
      <Button disabled={working} onClick={()=>void decide('reject')}>拒绝此次连接器调用</Button>
    </Space>}
    {model.result&&<pre>{JSON.stringify(model.result.data,null,2)}</pre>}
    {model.source_unavailable&&<p>数据源授权已失效。</p>}
    {error&&<Alert type="error" title={error}/>}
  </Card>;
}
