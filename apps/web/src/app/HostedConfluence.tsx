import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useParams} from 'react-router';
import {Alert,Button,Card,Checkbox,Input,Select,Space} from 'antd';
import {ApiFailure} from '../api/client';
import {ConfluenceClient,type Action,type Grant,type Output,type Receipt} from '../api/confluence';
import type {UserSession} from '../api/contracts';

const api=new ConfluenceClient();
type View={grant:string;action:Action;value:Output};
export default function ConfluenceRoute({session}:{session:UserSession}){
  const {run}=useParams();
  if(!run||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(run))return <Alert type="error" title="运行编号无效"/>;
  return <><Link to="/agent">返回托管运行</Link><Panel key={run+session.session_id} run={run} session={session}/></>;
}
function Panel({run,session}:{run:string;session:UserSession}){
  const [site,setSite]=useState(''),[spaces,setSpaces]=useState<string[]>([]),[query,setQuery]=useState(''),[view,setView]=useState<View>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),lock=useRef(false),pending=useRef<{terms:string;key:string}|undefined>(undefined),controller=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  const inventory=useQuery({queryKey:['confluence',session.session_id,run],queryFn:({signal})=>api.inventory(run,signal),refetchInterval:2000,retry:false});
  const data=inventory.data,sources=data?.sources??[],src=sources.find(s=>s.source_id===site),grants=data?.recent_grants??[];
  const valid=(g:Grant)=>!inventory.isError&&data?.document_access_selected&&data.run_readable&&!g.revoked&&Date.parse(g.expires_at)>Date.now()&&sources.some(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest);
  const shown=view&&grants.some(g=>g.grant_id===view.grant&&valid(g))?view:undefined;
  useEffect(()=>{if(view&&!shown){setView(undefined);controller.current?.abort();}},[view,shown]);
  function intent(terms:string){if(pending.current?.terms!==terms)pending.current={terms,key:crypto.randomUUID()};return pending.current.key;}
  async function act(f:()=>Promise<void>){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await f();}catch(e){if(alive.current){setError(e instanceof ApiFailure?e.code:'REQUEST_FAILED');setView(undefined);}}
    finally{if(alive.current){await inventory.refetch();setBusy(false);}lock.current=false;}
  }
  async function read(g:Grant,a:Action){
    const key=a.action==='read_attachment'?intent(JSON.stringify([g.grant_id,a])):crypto.randomUUID();
    const v=await api.read(session,run,g,a,key);if(a.action==='read_attachment')pending.current=undefined;
    if(alive.current)setView({grant:g.grant_id,action:a,value:v});
  }
  async function save(g:Grant,ref:Receipt){
    const ctl=new AbortController();controller.current=ctl;const timer=setTimeout(()=>ctl.abort(),35000);
    try{
      const blob=await api.download(session,run,g,ref,ctl.signal);
      const fresh=await inventory.refetch();
      if(!fresh.isSuccess||!fresh.data.document_access_selected||!fresh.data.run_readable||!fresh.data.sources.some(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest)||
        !fresh.data.recent_grants.some(v=>v.grant_id===g.grant_id&&!v.revoked&&Date.parse(v.expires_at)>Date.now())||!alive.current||ctl.signal.aborted)throw Error('AUTHORITY_EXPIRED');
      const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=ref.title.split(/[\\/]/).pop()||'attachment';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }finally{clearTimeout(timer);controller.current=undefined;}
  }
  return <Card title="Confluence Cloud 空间">
    {inventory.isError&&<Alert type="warning" title="授权记录读取失败"/>}{error&&<Alert type="error" title={error}/>}
    {data&&!data.document_access_selected&&<p>此运行未选择访问第三方文档。</p>}
    {data?.document_access_selected&&(!sources.length?<p>没有可用的登记站点。</p>:<Space wrap>
      <Select aria-label="Confluence 站点" value={site||undefined} placeholder="选择登记站点" disabled={busy} options={sources.map(s=>({value:s.source_id,label:s.site+' · '+s.source_id}))} onChange={v=>{setSite(v);setSpaces([]);}}/>
      {src&&<Checkbox.Group value={spaces} options={Object.entries(src.spaces).map(([k,v])=>({value:k,label:k+' · '+v.key}))} disabled={busy} onChange={v=>setSpaces(v.map(String))}/>}
      <Button disabled={busy||!src||!spaces.length||!data.run_readable||inventory.isError} onClick={()=>void act(async()=>{if(src){await api.grant(session,run,src,spaces,intent(JSON.stringify([src.source_digest,[...spaces].sort()])));pending.current=undefined;if(alive.current)setSpaces([]);}})}>授权所选空间 15 分钟</Button>
    </Space>)}
    {grants.map(g=>{
      const v=shown?.grant===g.grant_id?shown:undefined,result=v?.value,a=v?.action;
      return <section key={g.grant_id} aria-label={'空间授权 '+g.grant_id}><h3>{g.source_id} · {g.space_keys.join('、')}</h3>
        <p>{g.revoked?'已撤销':Date.parse(g.expires_at)<=Date.now()?'已到期':'有效至 '+new Date(g.expires_at).toLocaleTimeString()}</p>
        {!g.revoked&&<Button disabled={busy} danger onClick={()=>void act(async()=>{setView(undefined);await api.revoke(session,run,g);})}>撤销空间授权</Button>}
        {valid(g)&&<div><label>搜索标题<Input value={query} maxLength={1024} onChange={e=>setQuery(e.target.value)}/></label>
          {g.space_keys.map(space=><Button key={space} disabled={busy} onClick={()=>void act(()=>read(g,{action:'search_pages',space,query,limit:25}))}>搜索 {space} 页面</Button>)}
        </div>}
        {result?.kind==='pages'&&a&&<div>{result.pages.map(page=><p key={page.id}><Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'read_page',space:a.space,page:page.handle}))}>{page.title||page.id}</Button></p>)}{!result.pages.length&&<p>本页没有匹配页面。</p>}</div>}
        {result?.kind==='content'&&a&&<article><h4>{result.content.page.title}</h4><p>版本 {result.content.page.version}</p><pre>{result.content.text}</pre>
          {!!result.content.omitted_nodes.length&&<p>未展开 {result.content.omitted_nodes.join('、')}</p>}
          <Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'list_children',space:a.space,page:result.content.page.handle,limit:25}))}>查看子页面</Button>
          {result.content.attachments.map(file=><div key={file.id}><p>{file.title} · {file.size_bytes} 字节 · 版本 {file.version}</p><Button disabled={busy||!data?.quarantine_available||Number(file.size_bytes)>20971520} onClick={()=>void act(()=>read(g,{action:'read_attachment',space:a.space,attachment:file.handle}))}>将 {file.title} 保存到隔离区</Button></div>)}
          {result.content.next_attachments_cursor&&<Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'read_page',space:a.space,page:result.content.page.handle,attachments_cursor:result.content.next_attachments_cursor!}))}>下一页附件</Button>}
        </article>}
        {result?.kind==='children'&&a&&<div>{result.children.map(child=><p key={child.id}>{'handle' in child?<Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'read_page',space:a.space,page:child.handle}))}>{child.title||child.id}</Button>:child.title+' · '+child.type}</p>)}{!result.children.length&&<p>没有子项。</p>}</div>}
        {a&&result&&'next_cursor' in result&&result.next_cursor&&<Button disabled={busy} onClick={()=>{const cursor=result.next_cursor;if(cursor&&(a.action==='search_pages'||a.action==='list_children'))void act(()=>read(g,{...a,cursor}));}}>下一页</Button>}
        {result?.kind==='file'&&<div><p>{result.file.title} · {result.file.size_bytes} 字节</p><p>SHA-256 {result.file.sha256}</p><Button disabled={busy} onClick={()=>void act(()=>save(g,result.file))}>下载已校验的隔离附件</Button></div>}
      </section>;
    })}
  </Card>;
}
