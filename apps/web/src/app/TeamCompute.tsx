import {useEffect,useMemo,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Card,Space,Spin,Typography} from 'antd';
import {Link,useParams,useSearchParams} from 'react-router';
import {ComputeClient} from '../api/compute-client';
import {pathId} from '../api/compute-contracts';
import {TeamClient} from '../api/team';
import type {UserSession} from '../api/contracts';
import {formatCredits} from '../api/accounts';
import AudioPreflight from './AudioPreflight';
import TaskDocument from './TaskDocument';
import ModelTasks from './ModelTasks';
const teams=new TeamClient();
const execution={queued:'排队中',running:'执行中',cancelling:'取消中',succeeded:'已完成',failed:'失败',cancelled:'已取消'};

export function TeamBudgetTask({session,invalidate,kind}:{session:UserSession;invalidate:()=>void;kind:'audio'|'text'}){
  const {org='',budget=''}=useParams();
  const member=useQuery({queryKey:['team',session.session_id,org],queryFn:({signal})=>teams.organization(session,org,signal),refetchInterval:5000,retry:false});
  const active=member.isSuccess&&['admin','owner','member'].includes(member.data.role);
  const allocation=useQuery({queryKey:['team-model-budget',session.session_id,org,budget],enabled:active,queryFn:({signal})=>teams.budget(org,budget,signal),refetchInterval:5000,retry:false});
  if(member.isPending||active&&allocation.isPending)return <Spin/>;
  if(!active||!allocation.isSuccess||allocation.data.member_id!==session.user_id||!allocation.data.allow_submit||allocation.data.state!=='active')return <Alert title="当前团队预算未授权这项任务" type="warning"/>;
  return <><p><Link to={'/organizations/'+pathId(org)}>{member.data!.name}</Link> · 使用团队预算 <code>{budget}</code></p>
    {kind==='text' ? <ModelTasks key={JSON.stringify([session.session_id,org,budget,'text'])} session={session} invalidate={invalidate} teamBudget={allocation.data}/> : <AudioPreflight key={JSON.stringify([session.session_id,org,budget])} session={session} invalidate={invalidate} ownerId={org} budgetId={budget}/>}</>;
}

export function TeamJobs({session}:{session:UserSession}){
  const {org=''}=useParams();return <OwnedJobs key={session.session_id+':'+org} session={session} org={org}/>;
}
function OwnedJobs({session,org}:{session:UserSession;org:string}){
  const api=useMemo(()=>new ComputeClient(undefined,org),[org]);
  const client=useQueryClient();const [params,setParams]=useSearchParams();const raw=params.get('job');
  const selected=raw&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw)?raw:null;
  const [pages,setPages]=useState<string[]>([]);const after=pages.at(-1);
  const [visible,setVisible]=useState(!document.hidden);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const member=useQuery({queryKey:['team',session.session_id,org],queryFn:({signal})=>teams.organization(session,org,signal),refetchInterval:5000,retry:false});
  const allowed=member.isSuccess&&['owner','admin','member'].includes(member.data.role);
  const key=['team-jobs',session.session_id,org];
  const jobs=useQuery({queryKey:[...key,'list',after],enabled:allowed,queryFn:({signal})=>api.jobs(session,after,signal),refetchInterval:5000,retry:false});
  const job=useQuery({queryKey:[...key,'job',selected],enabled:allowed&&!!selected,queryFn:({signal})=>api.job(session,selected!,signal),refetchInterval:5000,retry:false});
  const result=useQuery({queryKey:[...key,'document',selected],enabled:allowed&&visible&&!!selected&&job.isSuccess&&job.data.execution_state==='succeeded',
    queryFn:async({signal})=>api.resultDocument(session,await api.result(session,selected!,signal),signal),refetchInterval:5000,refetchIntervalInBackground:false,retry:false});
  useEffect(()=>{function visibility(){setVisible(!document.hidden);if(document.hidden){void client.cancelQueries({queryKey:['team-jobs',session.session_id,org,'document']});client.removeQueries({queryKey:['team-jobs',session.session_id,org,'document']});}}
    document.addEventListener('visibilitychange',visibility);return ()=>document.removeEventListener('visibilitychange',visibility);},[session.session_id,org,client]);
  async function cancel(){if(!selected||busy)return;setBusy(true);setError('');try{await api.cancel(session,selected,selected);await client.invalidateQueries({queryKey:key});}
    catch{setError('取消结果待核对，请刷新原任务。');}finally{setBusy(false);}}
  if(member.isPending)return <Spin/>;
  if(!allowed)return <Alert type="warning" title="当前身份无法读取团队任务"/>;
  return <><p><Link to={'/organizations/'+pathId(org)}>{member.data!.name}</Link></p><h1>我的团队任务</h1>
    <Button onClick={()=>void client.invalidateQueries({queryKey:key})}>刷新团队任务</Button>
    {jobs.isError?<Alert type="warning" title="当前无法读取任务列表"/>:jobs.data?.data.map(j=><p key={j.job_id}><Button onClick={()=>setParams({job:j.job_id})}>{j.job_id}</Button> · {execution[j.execution_state]}</p>)}
    <Space>{pages.length>0&&<Button onClick={()=>setPages(pages.slice(0,-1))}>上页任务</Button>}{jobs.data?.next_cursor&&<Button onClick={()=>setPages([...pages,jobs.data!.next_cursor!])}>下页任务</Button>}</Space>
    {selected&&<Card title="团队任务结果">{job.isError?<Alert type="warning" title="任务暂不可读"/>:job.data&&<><p><Typography.Text copyable>{job.data.job_id}</Typography.Text> · {execution[job.data.execution_state]}</p>
      <p>原预留 {formatCredits(job.data.reserved)} 积分{job.data.charge!==null?' · 已记费用 '+formatCredits(job.data.charge)+' 积分':''}</p>
      {['queued','running'].includes(job.data.execution_state)&&<Button disabled={busy} onClick={()=>void cancel()}>取消团队任务</Button>}
      {result.error&&<Alert type="warning" title="结果暂不可读"/>}{visible&&!result.isFetching&&!result.error&&result.data&&<TaskDocument document={result.data}/>}
    </>}</Card>}{error&&<Alert type="warning" title={error}/>}</>;
}
