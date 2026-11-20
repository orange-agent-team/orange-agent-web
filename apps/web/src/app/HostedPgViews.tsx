import {useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Checkbox,Select,Space} from 'antd';
import type {UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';
import {PgConnectorClient,type Grant,type ReadAction} from '../api/pg-connector';

const api=new PgConnectorClient();
type Result={grant:string; value:Awaited<ReturnType<PgConnectorClient['read']>>};
export default function HostedPgRoute({session}:{session:UserSession}){
  const {run}=useParams();
  if(!run||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(run))return <Alert title="运行编号无效" type="error"/>;
  return <><Link to="/agent">返回托管运行</Link><HostedPgViews key={session.session_id+run} run={run} session={session}/></>;
}

function HostedPgViews({run,session}:{run:string;session:UserSession}){
  const [source,setSource]=useState(''),[views,setViews]=useState<string[]>([]);
  const [result,setResult]=useState<Result>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const intent=useRef<{terms:string;key:string}|undefined>(undefined);
  const active=useRef(true),locked=useRef(false);
  useEffect(()=>{active.current=true;return ()=>{active.current=false;};},[]);
  const inventory=useQuery({queryKey:['pg-views',session.session_id,run],queryFn:({signal})=>api.inventory(run,signal),refetchInterval:2000,retry:false});
  const sources=inventory.data?.sources??[];
  const src=sources.find(s=>s.source_id===source);
  const grants=inventory.data?.recent_grants??[];
  const usable=(g:Grant)=>inventory.data?.run_readable && !g.revoked && Date.parse(g.expires_at)>Date.now() && sources.some(s=>s.source_id===g.source_id && s.source_digest===g.source_digest);
  const visible=!inventory.isError && result && grants.some(g=>g.grant_id===result.grant && usable(g))?result:undefined;
  useEffect(()=>{if(result&&!visible)setResult(undefined);},[result,visible]);
  async function act(work:()=>Promise<void>){
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');setResult(undefined);
    try{await work();}catch(e){if(active.current)setError(e instanceof ApiFailure?e.code:'REQUEST_FAILED');}
    finally{if(active.current){await inventory.refetch();setBusy(false);}locked.current=false;}
  }
  async function approve(){
    if(!src||!views.length)return;
    const terms=JSON.stringify([src.source_digest,[...views].sort()]);
    if(intent.current?.terms!==terms)intent.current={terms,key:crypto.randomUUID()};
    await api.grant(session,run,src,views,intent.current.key);
    intent.current=undefined;
    if(active.current)setViews([]);
  }
  async function read(g:Grant,a:ReadAction){
    const value=await api.read(session,run,g,a);
    if(active.current)setResult({grant:g.grant_id,value});
  }
  return <Card title="PostgreSQL 只读视图">
    {inventory.isError?<Alert type="error" title="授权记录读取失败"/>:null}
    {error&&<Alert type="error" title={error}/>}
    {!inventory.isLoading&&!inventory.isError&&!sources.length&&<p>此用户尚无已登记的数据源。</p>}
    {sources.length>0&&<Space wrap>
      <Select aria-label="数据源" placeholder="选择数据源" value={source||undefined} disabled={busy} options={sources.map(s=>({label:s.source_id,value:s.source_id}))} onChange={id=>{setSource(id);setViews([]);setResult(undefined);}}/>
      {src&&<Checkbox.Group aria-label="授权视图" options={src.view_ids} value={views} onChange={values=>setViews(values.map(String))} disabled={busy}/>}
      <Button disabled={busy||!src||!views.length||!inventory.data?.run_readable||inventory.isError} onClick={()=>void act(approve)}>授权此运行读取 15 分钟</Button>
    </Space>}
    {grants.map(g=><section key={g.grant_id}>
      <h3>{g.source_id} · {g.view_ids.join('、')}</h3>
      <p>{g.revoked?'已撤销':Date.parse(g.expires_at)<=Date.now()?'已到期':'有效至 '+new Date(g.expires_at).toLocaleTimeString()}</p>
      <Space wrap>
        {usable(g)&&!inventory.isError&&<>
          <Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'list_views'}))}>列出授权视图</Button>
          {g.view_ids.map(id=><Button key={id} disabled={busy} onClick={()=>void act(()=>read(g,{action:'describe_view',view_id:id}))}>查看 {id} 列定义</Button>)}
        </>}
        {!g.revoked&&<Button disabled={busy} danger onClick={()=>void act(()=>api.revoke(session,run,g))}>撤销授权</Button>}
      </Space>
      {visible?.grant===g.grant_id&&<div>
        <pre>{JSON.stringify(visible.value,null,2)}</pre>
        {'columns' in visible.value&&<Button disabled={busy} onClick={()=>{
          const value=visible.value;
          if('columns' in value)void act(()=>read(g,{action:'query_view',view_id:value.view_id,columns:Object.keys(value.columns),limit:20}));
        }}>读取前 20 行</Button>}
      </div>}
    </section>)}
  </Card>;
}
