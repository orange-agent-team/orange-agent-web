import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useParams} from 'react-router';
import {Alert,Button,Card,Select,Space} from 'antd';
import type {UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';
import {S3Client,type Grant,type Head,type Artifact} from '../api/s3-connector';
const api=new S3Client();
type Result={grant:string;keys?:string[];next?:string|null;head?:Head;artifact?:Artifact};
export default function S3Route({session}:{session:UserSession}){
  const {run}=useParams();
  if(!run||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(run))return <Alert type="error" title="运行编号无效"/>;
  return <><Link to="/agent">返回托管运行</Link><Panel key={session.session_id+run} session={session} run={run}/></>;
}
function Panel({session,run}:{session:UserSession;run:string}){
  const [choice,select]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result>();
  const alive=useRef(true),locked=useRef(false),pending=useRef<{input:string;key:string}|undefined>(undefined);
  const download=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;download.current?.abort();};},[]);
  const inventory=useQuery({queryKey:['s3-sources',session.session_id,run],queryFn:({signal})=>api.inventory(run,signal),refetchInterval:2000,retry:false});
  const sources=inventory.data?.sources??[],grants=inventory.data?.recent_grants??[],src=sources.find(s=>s.source_id===choice);
  const valid=(g:Grant)=>!g.revoked&&Date.parse(g.expires_at)>Date.now()&&inventory.data?.run_readable&&sources.some(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest);
  const visible=result&&!inventory.isError&&grants.some(g=>g.grant_id===result.grant&&valid(g))?result:undefined;
  useEffect(()=>{if(result&&!visible){setResult(undefined);download.current?.abort();}},[result,visible]);
  function intent(input:string){if(pending.current?.input!==input)pending.current={input,key:crypto.randomUUID()};return pending.current.key;}
  async function act(work:()=>Promise<void>){
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');
    try{await work();}catch(e){if(alive.current){setResult(undefined);setError(e instanceof ApiFailure?e.code:'REQUEST_FAILED');}}
    finally{if(alive.current){await inventory.refetch();setBusy(false);}locked.current=false;}
  }
  function store(r:Result){if(alive.current)setResult(r);}
  async function list(g:Grant,after:string|null){const page=await api.list(session,run,g,after);store({grant:g.grant_id,keys:page.keys,next:page.next_after});}
  async function save(g:Grant,r:Artifact){
    const ctl=new AbortController();download.current=ctl;
    const timer=setTimeout(()=>ctl.abort(),35000);
    try{
      const data=await api.download(session,run,g,r,ctl.signal);
      const latest=await inventory.refetch();
      const permitted=latest.isSuccess&&latest.data.run_readable&&latest.data.sources.some(s=>s.source_digest===g.source_digest&&s.source_id===g.source_id)&&latest.data.recent_grants.some(v=>v.grant_id===g.grant_id&&!v.revoked&&Date.parse(v.expires_at)>Date.now());
      if(!alive.current||ctl.signal.aborted||!permitted)throw Error('GRANT_EXPIRED');
      const url=URL.createObjectURL(data);const a=document.createElement('a');
      a.href=url;a.download=r.head.key.split('/').pop()||'object';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }finally{clearTimeout(timer);download.current=undefined;}
  }
  return <Card title="S3 只读对象">
    {inventory.isError&&<Alert type="error" title="授权记录读取失败"/>}{error&&<Alert type="error" title={error}/>}
    {!inventory.isFetching&&!inventory.isError&&!sources.length&&<p>此用户尚无已登记的 S3 来源。</p>}
    {!!sources.length&&<Space wrap><Select aria-label="S3 来源" placeholder="选择数据桶及前缀" value={choice||undefined} disabled={busy} onChange={select} options={sources.map(s=>({value:s.source_id,label:s.bucket+'/'+s.prefix+'/'}))}/>
      <Button disabled={busy||!src||inventory.isError||!inventory.data?.run_readable} onClick={()=>void act(async()=>{if(src){await api.grant(session,run,src,intent(src.source_digest));pending.current=undefined;}})}>授权读取此前缀 15 分钟</Button></Space>}
    {grants.map(g=><section key={g.grant_id}><h3>{g.source_id}</h3>
      <p>{g.revoked?'已撤销':Date.parse(g.expires_at)<=Date.now()?'已到期':'有效至 '+new Date(g.expires_at).toLocaleTimeString()}</p>
      <Space>{valid(g)&&!inventory.isError&&<Button disabled={busy} onClick={()=>void act(()=>list(g,null))}>列出对象</Button>}
        {!g.revoked&&<Button danger disabled={busy} onClick={()=>void act(async()=>{setResult(undefined);await api.revoke(session,run,g);})}>撤销 S3 授权</Button>}</Space>
      {visible?.grant===g.grant_id&&<div>
        {visible.keys?.map(key=><p key={key}><Button disabled={busy} onClick={()=>void act(async()=>store({grant:g.grant_id,head:await api.head(session,run,g,key)}))}>{key}</Button></p>)}
        {visible.keys?.length===0&&<p>此前缀下没有对象。</p>}
        {visible.next&&<Button disabled={busy} onClick={()=>void act(()=>list(g,visible.next??null))}>下一页对象</Button>}
        {visible.head&&<><p>{visible.head.key} · {visible.head.size_bytes} 字节 · {visible.head.etag}</p>
          <Button disabled={busy||Number(visible.head.size_bytes)>20971520} onClick={()=>void act(async()=>{if(visible.head){const r=await api.read(session,run,g,visible.head,intent(JSON.stringify([g.grant_id,visible.head])));pending.current=undefined;store({grant:g.grant_id,artifact:r});}})}>读取此版本并生成附件</Button></>}
        {visible.artifact&&<><p>{visible.artifact.head.key} · SHA-256 {visible.artifact.sha256}</p>
          <Button disabled={busy} onClick={()=>void act(()=>save(g,visible.artifact!))}>下载已校验附件</Button></>}
      </div>}
    </section>)}
  </Card>;
}
