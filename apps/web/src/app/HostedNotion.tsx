import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useParams} from 'react-router';
import {Alert,Button,Card,Checkbox,Input,Select,Space} from 'antd';
import {ApiFailure} from '../api/client';
import {NotionClient,type Action,type Filter,type Grant,type Output,type Sort} from '../api/notion';
import type {UserSession} from '../api/contracts';
const api=new NotionClient();
type Display={id:string;request:Action;result:Output};
export default function HostedNotion({session}:{session:UserSession}){
  const {run}=useParams();
  if(!run||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(run))return <Alert type="error" title="运行编号无效"/>;
  return <><Link to="/agent">返回托管运行</Link><Panel key={run+session.session_id} run={run} session={session}/></>;
}
function Panel({session,run}:{session:UserSession;run:string}){
  const [source,setSource]=useState(''),[roots,setRoots]=useState<string[]>([]),[query,setQuery]=useState('');
  const [property,setProperty]=useState(''),[kind,setKind]=useState<Filter['kind']>('title'),[value,setValue]=useState(''),[sort,setSort]=useState<Sort['direction']>();
  const [display,setDisplay]=useState<Display>(),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const live=useRef(true),lock=useRef(false),pending=useRef<{terms:string;key:string}|undefined>(undefined);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const inventory=useQuery({queryKey:['notion',session.session_id,run],queryFn:({signal})=>api.inventory(run,signal),refetchInterval:2000,retry:false});
  const data=inventory.data,src=data?.sources.find(s=>s.source_id===source);
  const matches=(g:Grant)=>data?.sources.find(s=>s.source_id===g.source_id&&s.source_digest===g.source_digest);
  const valid=(g:Grant)=>!!matches(g)&&!inventory.isError&&data?.run_readable&&data.document_access_selected&&!g.revoked&&Date.parse(g.expires_at)>Date.now();
  const shown=display&&data?.recent_grants.some(g=>g.grant_id===display.id&&valid(g))?display:undefined;
  useEffect(()=>{if(display&&!shown)setDisplay(undefined);},[display,shown]);
  async function act(work:()=>Promise<void>){
    if(lock.current)return;
    lock.current=true;setBusy(true);setMessage('');
    try{await work();}
    catch(e){if(live.current){setDisplay(undefined);setMessage(e instanceof ApiFailure?e.code:'REQUEST_FAILED');}}
    finally{if(live.current){await inventory.refetch();setBusy(false);}lock.current=false;}
  }
  async function read(g:Grant,request:Action){
    const result=await api.read(session,run,g,request);
    if(live.current)setDisplay({id:g.grant_id,request,result});
  }
  function filter():Filter|undefined{
    if(!property.trim())return;
    if(kind==='number'){const number=Number(value);if(!value.trim()||!Number.isFinite(number))throw new ApiFailure(400,'INVALID_FILTER');return {kind,property,equals:number};}
    if(kind==='checkbox'){if(value!=='true'&&value!=='false')throw new ApiFailure(400,'INVALID_FILTER');return {kind,property,equals:value==='true'};}
    return {kind,property,equals:value};
  }
  return <Card title="Notion 页面与数据库">
    {inventory.error&&<Alert type="warning" title="读取授权记录失败"/>}{message&&<Alert type="error" title={message}/>}
    {data&&!data.document_access_selected&&<p>创建此运行时未选择访问第三方文档。</p>}
    {data?.document_access_selected&&(!data.sources.length?<p>没有可用的登记来源。</p>:<Space wrap>
      <Select aria-label="Notion 来源" placeholder="选择登记来源" value={source||undefined} disabled={busy} onChange={v=>{setSource(v);setRoots([]);}} options={data.sources.map(s=>({value:s.source_id,label:s.source_id}))}/>
      {src&&<Checkbox.Group options={Object.entries(src.roots).map(([key,v])=>({value:key,label:key+' · '+(v.kind==='page'?'页面':'数据库')}))} value={roots} disabled={busy} onChange={v=>setRoots(v.map(String))}/>}
      <Button disabled={!src||!roots.length||busy||!data.run_readable||inventory.isError} onClick={()=>void act(async()=>{
        if(!src)return;const terms=JSON.stringify([src.source_digest,[...roots].sort()]);
        if(pending.current?.terms!==terms)pending.current={terms,key:crypto.randomUUID()};
        await api.grant(session,run,src,roots,pending.current.key);pending.current=undefined;
        if(live.current)setRoots([]);
      })}>授权所选文档 15 分钟</Button>
    </Space>)}
    {data?.recent_grants.map(g=>{
      const registered=matches(g),v=shown?.id===g.grant_id?shown:undefined;
      const items=new Map(Object.entries(registered?.roots??{}));
      return <section key={g.grant_id} aria-label={'文档授权 '+g.grant_id}><h3>{g.source_id} · {g.root_keys.join('、')}</h3>
        <p>{g.revoked?'已撤销':Date.parse(g.expires_at)<=Date.now()?'已到期':'有效至 '+new Date(g.expires_at).toLocaleTimeString()}</p>
        {!g.revoked&&<Button disabled={busy} danger onClick={()=>void act(async()=>{setDisplay(undefined);await api.revoke(session,run,g);})}>撤销文档授权</Button>}
        {valid(g)&&<><div><label>页面标题<Input value={query} maxLength={1024} onChange={e=>setQuery(e.target.value)}/></label>
          <Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'search_pages',query,limit:25}))}>搜索已授权页面</Button></div>
          {g.root_keys.map(root=>{
            const scope=items.get(root);
            if(scope?.kind==='page')return <Space key={root}><Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'read_page',root}))}>读取 {root}</Button><Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'list_blocks',root,limit:25}))}>浏览 {root} 内容块</Button></Space>;
            if(scope?.kind!=='database')return null;
            return <div key={root}><h4>{root}</h4><Space wrap>
              <label>筛选属性<Input value={property} placeholder="可选" onChange={e=>setProperty(e.target.value)}/></label>
              {property&&<><Select aria-label="属性类型" value={kind} onChange={setKind} options={['title','rich_text','select','status','number','checkbox'].map(k=>({value:k,label:k}))}/>
                <label>等于<Input value={value} onChange={e=>setValue(e.target.value)}/></label></>}
              <Select aria-label="按修改时间排序" placeholder="默认排序" allowClear value={sort} onChange={setSort} options={[{value:'ascending',label:'最早修改'},{value:'descending',label:'最近修改'}]}/>
              {scope.data_sources.map(ds=><Button key={ds} disabled={busy} onClick={()=>void act(()=>read(g,{action:'query_database',root,data_source:ds,limit:25,filter:filter(),sort:sort?{timestamp:'last_edited_time',direction:sort}:undefined}))}>查询 {scope.data_sources.length===1?root:ds}</Button>)}
            </Space></div>;
          })}
        </>}
        {v?.result.kind==='search'&&<div>{v.result.pages.map(p=><p key={p.root}><Button disabled={busy} onClick={()=>void act(()=>read(g,{action:'read_page',root:p.root}))}>{p.page.title||p.page.page_id}</Button></p>)}{!v.result.pages.length&&<p>本页没有匹配标题。</p>}</div>}
        {v?.result.kind==='page'&&v.request.action==='read_page'&&<article><h4>{v.result.page.title||v.result.page.page_id}</h4><dl>{Object.entries(v.result.page.properties).map(([name,p])=><div key={name}><dt>{name}</dt><dd>{'value' in p?JSON.stringify(p.value):'未展开 · '+p.type}</dd></div>)}</dl>
          <Button disabled={busy} onClick={()=>{const q=v.request;if(q.action==='read_page')void act(()=>read(g,{action:'list_blocks',root:q.root,target:q.page,limit:25}));}}>读取页面内容块</Button></article>}
        {v?.result.kind==='blocks'&&<div>{v.result.blocks.map(b=><p key={b.block_id}>{b.text??b.expression??b.cells?.join(' · ')??b.type}
          {b.children&&<Button disabled={busy} onClick={()=>{const q=v.request;if(q.action==='list_blocks')void act(()=>read(g,{action:'list_blocks',root:q.root,target:b.children,limit:25}));}}>展开子块</Button>}</p>)}{!v.result.blocks.length&&<p>没有内容块。</p>}</div>}
        {v?.result.kind==='rows'&&<div>{v.result.rows.map(row=><p key={row.page.page_id}><Button disabled={busy} onClick={()=>{const q=v.request;if(q.action==='query_database')void act(()=>read(g,{action:'read_page',root:q.root,page:row.handle}));}}>{row.page.title||row.page.page_id}</Button></p>)}{!v.result.rows.length&&<p>没有匹配记录。</p>}</div>}
        {v&&'next_cursor' in v.result&&v.result.next_cursor&&<Button disabled={busy} onClick={()=>{const q=v.request,cursor='next_cursor' in v.result?v.result.next_cursor:null;if(q.action!=='read_page'&&cursor)void act(()=>read(g,{...q,cursor}));}}>下一页</Button>}
      </section>;
    })}
  </Card>;
}
