import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useParams} from 'react-router';
import {Alert,Button,Card,Checkbox,Input,Select,Space} from 'antd';
import type {UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';
import {RepositoryClient,type Provider,type Grant,type Source,type Page,type Repo,type Item,type FileReceipt} from '../api/repositories';

const api=new RepositoryClient();
type View={grant:string;repos?:Page<Repo>;repo?:Repo;items?:Page<Item>;issues?:boolean;detail?:Item;file?:FileReceipt};
export default function RepositoryRoute({session}:{session:UserSession}){
  const {run,provider}=useParams();
  if(!run||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(run)||!(provider==='github'||provider==='gitlab'))return <Alert type="error" title="运行或服务商无效"/>;
  return <><Link to="/agent">返回托管运行</Link><Panel key={session.session_id+run+provider} run={run} provider={provider} session={session}/></>;
}
function Panel({run,provider,session}:{run:string;provider:Provider;session:UserSession}){
  const [sourceId,setSource]=useState(''),[ids,setIds]=useState<string[]>([]),[view,setView]=useState<View>();
  const [revision,setRevision]=useState(''),[filePath,setFilePath]=useState(''),[issue,setIssue]=useState(''),[working,setWorking]=useState(false);
  const live=useRef(true),busy=useRef(false),download=useRef<AbortController|undefined>(undefined),intent=useRef<{terms:string;key:string}|undefined>(undefined);
  useEffect(()=>{live.current=true;return()=>{live.current=false;download.current?.abort();};},[]);
  const inv=useQuery({queryKey:['repository-grants',session.session_id,run,provider],queryFn:({signal})=>api.inventory(run,provider,signal),refetchInterval:2000,retry:false});
  const data=inv.data,sources=data?.sources??[],src=sources.find(s=>s.source_id===sourceId),grants=data?.recent_grants??[];
  function source(g:Grant):Source|undefined{return sources.find(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest);}
  function usable(g:Grant){return !inv.error&&data?.run_readable&&data.external_access_selected&&!g.revoked&&Date.parse(g.expires_at)>Date.now()&&!!source(g);}
  const displayed=view&&grants.some(g=>g.grant_id===view.grant&&usable(g))?view:undefined;
  useEffect(()=>{if(view&&!displayed){setView(undefined);download.current?.abort();}},[view,displayed]);
  function retryKey(terms:string){
    if(intent.current?.terms!==terms)intent.current={terms,key:crypto.randomUUID()};
    return intent.current.key;
  }
  async function act(fn:()=>Promise<void>){
    if(busy.current)return;
    busy.current=true;setWorking(true);setIssue('');
    try{await fn();}catch(e){if(live.current){setView(undefined);setIssue(e instanceof ApiFailure?e.code:'REQUEST_FAILED');}}
    finally{if(live.current){await inv.refetch();setWorking(false);}busy.current=false;}
  }
  function show(v:View){if(live.current)setView(v);}
  async function browse(g:Grant,n:number){const rows=await api.repos(session,run,provider,g,n);show({grant:g.grant_id,repos:rows});}
  async function listing(g:Grant,r:Repo,issues:boolean,n:number){const items=await api.items(session,run,provider,g,r.id,issues,n);show({grant:g.grant_id,repo:r,issues,items});}
  async function save(g:Grant,r:FileReceipt){
    const controller=new AbortController();download.current=controller;
    const timeout=setTimeout(()=>controller.abort(),35000);
    try{
      const blob=await api.download(session,run,provider,g,r,controller.signal);
      const latest=await inv.refetch();
      if(!live.current||controller.signal.aborted||!latest.isSuccess||!latest.data.run_readable||!latest.data.external_access_selected||
        !latest.data.sources.some(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest)||
        !latest.data.recent_grants.some(v=>v.grant_id===g.grant_id&&!v.revoked&&Date.parse(v.expires_at)>Date.now()))throw Error('GRANT_EXPIRED');
      const url=URL.createObjectURL(blob);const a=document.createElement('a');
      a.href=url;a.download=r.path.split('/').pop()||'file';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }finally{clearTimeout(timeout);download.current=undefined;}
  }
  const title=provider==='github'?'GitHub 仓库':'GitLab 项目';
  return <Card title={title+'授权'}>
    {inv.error&&<Alert type="warning" title="读取授权失败"/>}
    {issue&&<Alert type="error" title={issue}/>}
    {data&&!data.external_access_selected&&<p>创建此运行时未选择访问第三方仓库。</p>}
    {data?.external_access_selected&&!sources.length&&<p>没有可用的登记来源。</p>}
    {data?.external_access_selected&&!!sources.length&&<Space wrap>
      <Select aria-label="仓库数据源" placeholder="选择登记来源" value={sourceId||undefined} disabled={working} options={sources.map(s=>({value:s.source_id,label:s.source_id}))} onChange={v=>{setSource(v);setIds([]);}}/>
      {src&&<Checkbox.Group options={src.repositories.map(r=>({value:r.repository_id,label:r.path}))} value={ids} disabled={working} onChange={v=>setIds(v.map(String))}/>}
      <Button disabled={working||!src||!ids.length||!data.run_readable||inv.isError} onClick={()=>void act(async()=>{if(src){await api.grant(session,run,provider,src,ids,retryKey(JSON.stringify([src.source_digest,[...ids].sort()])));intent.current=undefined;setIds([]);}})}>授权读取所选仓库 15 分钟</Button>
    </Space>}
    {grants.map(g=>{
      const v=displayed?.grant===g.grant_id?displayed:undefined,r=v?.repo,policy=r&&source(g)?.repositories.find(x=>x.repository_id===r.id);
      return <section key={g.grant_id} aria-label={'仓库授权 '+g.grant_id}>
        <h3>{g.source_id} · {g.repository_ids.map(id=>source(g)?.repositories.find(x=>x.repository_id===id)?.path??id).join('、')}</h3>
        <p>{g.revoked?'已撤销':Date.parse(g.expires_at)<=Date.now()?'已到期':'有效至 '+new Date(g.expires_at).toLocaleTimeString()}</p>
        <Space>{usable(g)&&<Button disabled={working} onClick={()=>void act(()=>browse(g,1))}>列出已授权{provider==='github'?'仓库':'项目'}</Button>}
          {!g.revoked&&<Button danger disabled={working} onClick={()=>void act(async()=>{setView(undefined);await api.revoke(session,run,provider,g);})}>撤销仓库授权</Button>}</Space>
        {v?.repos?.data.map(repo=><p key={repo.id}><Button disabled={working} onClick={()=>{setRevision(repo.default_branch);setFilePath('');show({grant:g.grant_id,repo});}}>{repo.path}</Button></p>)}
        {v?.repos?.next_page&&<Button disabled={working} onClick={()=>void act(()=>browse(g,v.repos!.next_page!))}>下一页仓库</Button>}
        {r&&policy&&<div><h4>{r.path}</h4><Space wrap>
          {policy.issues&&<Button disabled={working} onClick={()=>void act(()=>listing(g,r,true,1))}>列出问题单</Button>}
          {policy.changes&&<Button disabled={working} onClick={()=>void act(()=>listing(g,r,false,1))}>列出{provider==='github'?'PR':'MR'}</Button>}
        </Space>
        {!!policy.file_prefixes.length&&<div>
          <p>可读目录 {policy.file_prefixes.map(p=>p||'仓库根目录').join('、')}</p>
          <label>提交或分支<Input value={revision} onChange={e=>setRevision(e.target.value)} maxLength={255}/></label>
          <label>仓库内文件路径<Input value={filePath} onChange={e=>setFilePath(e.target.value)} maxLength={1024}/></label>
          <Button disabled={working||!revision||!filePath} onClick={()=>void act(async()=>{const file=await api.file(session,run,provider,g,r.id,revision,filePath,retryKey(JSON.stringify([g.grant_id,r.id,revision,filePath])));intent.current=undefined;show({grant:g.grant_id,repo:r,file});})}>读取文件版本</Button>
        </div>}
        {v.items?.data.map(item=><p key={item.id}><Button disabled={working} onClick={()=>void act(async()=>show({...v,detail:await api.item(session,run,provider,g,r.id,!!v.issues,item.number)}))}>#{item.number} {item.title}</Button></p>)}
        {v.items?.next_page&&<Button disabled={working} onClick={()=>void act(()=>listing(g,r,!!v.issues,v.items!.next_page!))}>下一页记录</Button>}
        {v.detail&&<article><h4>{v.detail.title}</h4><p>{v.detail.state} · {v.detail.updated_at}</p><pre>{v.detail.body??''}</pre></article>}
        {v.file&&<><p>{v.file.path} · {v.file.size_bytes} 字节</p><p>提交 {v.file.commit}</p><Button disabled={working} onClick={()=>void act(()=>save(g,v.file!))}>下载已校验文件</Button></>}
        </div>}
      </section>;
    })}
  </Card>;
}
