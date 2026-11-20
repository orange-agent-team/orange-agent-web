import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Input,Select,Space,Tag} from 'antd';
import {Link} from 'react-router';
import {CloudClient,profile,type CloudRun} from '../api/cloud-runs';
import {cloudKey,readIntent,type CloudIntent} from '../api/cloud-intent';
import {ApiFailure} from '../api/client';
import {sha256} from '../api/compute-contracts';
import {authorityKey,type UserSession} from '../api/contracts';
const api=new CloudClient();
const names={queued:'排队中',running:'运行中',cancelled:'已取消',failed:'失败',completed:'已完成',paused:'已暂停',waiting_approval:'等待批准',recovery_required:'需要恢复'};
const workspace={requested:'已预留',preparing:'准备中',ready:'就绪',running:'运行中',draining:'等待回收',deleted:'已回收',quarantined:'隔离中'};

export default function HostedRuns({session,invalidate}:{session:UserSession;invalidate:()=>void}){
  const [prompt,setPrompt]=useState(''),[budget,setBudget]=useState(''),[ttl,setTtl]=useState(900);
  const [pages,setPages]=useState<string[]>([]),[budgetPages,setBudgetPages]=useState<string[]>([]);
  const [intent,setIntent]=useState<CloudIntent>(),[storageReady,setStorageReady]=useState(false);
  const [notice,setNotice]=useState(''),[working,setWorking]=useState(false),[confirmed,setConfirmed]=useState<CloudRun>();
  const [cancelId,setCancelId]=useState<string>();
  const busy=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;try{
    const old=readIntent(sessionStorage,session);setIntent(old);if(old){setBudget(old.budget);setTtl(old.ttl);}setStorageReady(true);
  }catch{setNotice('无法核对本会话的待处理请求，已暂停创建。');}return()=>{alive.current=false;};},[session.session_id,session.user_id,session.personal_owner_id]);
  const key=authorityKey(session);
  const cap=useQuery({queryKey:[key,'cloud-capacity'],queryFn:({signal})=>api.cloudCapacity(session,signal),refetchInterval:10000});
  const list=useQuery({queryKey:[key,'cloud-runs',pages.at(-1)],queryFn:({signal})=>api.cloudRuns(session,pages.at(-1),signal),refetchInterval:10000});
  const budgets=useQuery({queryKey:[key,'cloud-budgets',budgetPages.at(-1)],queryFn:({signal})=>api.budgets(session,budgetPages.at(-1),signal)});
  const active=budgets.data?.data.filter(b=>b.status==='active')??[];
  const selected=budget||active[0]?.root_budget_id;
  function save(next:CloudIntent){sessionStorage.setItem(cloudKey(session),JSON.stringify(next));if(alive.current)setIntent(next);}
  function refresh(){void cap.refetch();void list.refetch();}
  function failure(e:unknown){
    if(e instanceof ApiFailure&&[401,403].includes(e.status)){invalidate();return;}
    setNotice(e instanceof ApiFailure&&e.code==='HOST_POOL_UNAVAILABLE'?'托管 Host 暂无容量。已保存原请求，可在恢复后继续。':
      e instanceof ApiFailure&&e.code==='WORKSPACE_QUOTA_EXCEEDED'?'工作区配额已满，释放容量后可继续原请求。':
      e instanceof Error&&e.message==='INPUT_REQUIRED'?'请重新输入与原摘要一致的内容，以继续上传。':'操作结果待核对，请刷新或继续原请求。');
  }
  async function reserve(){
    if(busy.current||!storageReady)return;busy.current=true;setWorking(true);setNotice('');setConfirmed(undefined);
    try{
      const bytes=new TextEncoder().encode(prompt);let current=intent;
      if(!current){
        if(!selected||!cap.data?.can_reserve||!bytes.length||bytes.length>262144)throw Error('INPUT_REQUIRED');
        current={v:1,owner:session.personal_owner_id,user:session.user_id,session:session.session_id,key:crypto.randomUUID(),budget:selected,ttl,
          upload:{upload_id:crypto.randomUUID(),media_type:'text/plain',sha256:await sha256(bytes),size_bytes:String(bytes.length)}};
        save(current);
      }
      function complete(row:CloudRun,expected:CloudIntent){
        if(!expected.prepared||row.input_artifact_id!==expected.prepared.artifact||row.input_version_id!==expected.prepared.version||row.root_budget_id!==expected.budget)
          throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
        sessionStorage.removeItem(cloudKey(session));
        if(alive.current){setIntent(undefined);setPrompt('');setPages([]);setConfirmed(row);refresh();}
      }
      if(current.prepared){
        try{complete(await api.originalRun(session,current.key),current);return;}
        catch(e){if(!(e instanceof ApiFailure&&e.status===404))throw e;}
      }else{
        let object=await api.beginUpload(session,current.upload);
        if(object.state==='staging'){
          if(String(bytes.length)!==current.upload.size_bytes||await sha256(bytes)!==current.upload.sha256)throw Error('INPUT_REQUIRED');
          object=await api.putInput(session,current.upload,bytes);
        }
        if(object.state!=='available')throw Error('INPUT_UNAVAILABLE');
        current={...current,prepared:{artifact:object.artifact_id,version:object.version_id}};save(current);
      }
      if(!alive.current)return;
      if(!current.prepared)throw Error('INPUT_UNAVAILABLE');
      complete(await api.createRun(session,current.key,{root_budget_id:current.budget,input_artifact_id:current.prepared.artifact,
        input_version_id:current.prepared.version,workspace_ttl_seconds:current.ttl,resource_profile_id:profile}),current);
    }catch(e){if(alive.current)failure(e);}
    finally{busy.current=false;if(alive.current)setWorking(false);}
  }
  async function withdraw(){
    if(busy.current||!intent)return;busy.current=true;setWorking(true);setNotice('');
    try{
      const receipt=await api.withdrawOriginal(session,intent.key);
      sessionStorage.removeItem(cloudKey(session));
      if(alive.current){setIntent(undefined);setConfirmed(receipt.run);setNotice('原请求已撤回。已上传的个人文件版本仍可单独管理。');refresh();}
    }catch(e){if(alive.current)failure(e);}finally{busy.current=false;if(alive.current)setWorking(false);}
  }
  async function cancel(id:string){
    if(busy.current)return;busy.current=true;setWorking(true);setNotice('');
    try{const row=await api.cancelCloudRun(session,id,id);if(alive.current){setConfirmed(row);setCancelId(undefined);refresh();}}
    catch(e){if(alive.current)failure(e);}finally{busy.current=false;if(alive.current)setWorking(false);}
  }
  return <><h1>托管运行</h1><Card title="预留云工作区">
    <p>输入将保存为个人文件版本。预留本身不扣费，模型调用需要另行报价并使用所选预算。</p>
    {cap.error?<Alert type="warning" title="容量查询失败"/>:cap.data&&<p>{cap.data.pool_available?'托管 Host 可接单':'托管 Host 暂不可用'} · 个人工作区 {cap.data.occupied} / {cap.data.max_active}</p>}
    <label>根预算<Select aria-label="根预算" value={selected} disabled={working||!!intent} onChange={setBudget}
      options={active.map(b=>({value:b.root_budget_id,label:b.scope_id+' · '+b.root_budget_id}))}/></label>
    <Space><Button disabled={!!intent||!budgetPages.length} onClick={()=>{setBudget('');setBudgetPages(v=>v.slice(0,-1));}}>上一页预算</Button>
      <Button disabled={!!intent||!budgets.data?.next_cursor} onClick={()=>{if(budgets.data?.next_cursor){setBudget('');setBudgetPages(v=>[...v,budgets.data.next_cursor!]);}}}>下一页预算</Button></Space>
    {!selected&&!budgets.isFetching&&<Link to="/account">创建个人预算</Link>}
    <label>工作区期限<Select aria-label="工作区期限" value={ttl} disabled={working||!!intent} onChange={setTtl} options={[{value:300,label:'5 分钟'},{value:900,label:'15 分钟'},{value:3600,label:'1 小时'}]}/></label>
    <label>运行输入<Input.TextArea aria-label="运行输入" value={prompt} disabled={working||!!intent?.prepared} maxLength={262144} onChange={e=>setPrompt(e.target.value)}/></label>
    <Button type="primary" loading={working} disabled={!storageReady||(!intent&&(!cap.data?.can_reserve||!selected||!prompt.trim()))} onClick={()=>void reserve()}>{intent?'继续原请求':'保存输入并预留工作区'}</Button>
    {intent&&<><p>原请求编号 {intent.key}</p><Button danger disabled={working} onClick={()=>void withdraw()}>撤回原请求</Button></>}
    {notice&&<Alert type="warning" title={notice}/>}
    {confirmed&&<p role="status">运行 {confirmed.run_id} · {names[confirmed.status]} · 工作区{workspace[confirmed.workspace.status]}</p>}
  </Card><Card title="我的运行" extra={<Button aria-label="刷新托管运行" onClick={refresh}>刷新</Button>}>
    {list.error?<Alert type="warning" title="运行记录读取失败"/>:list.data?.data.map(row=><section key={row.run_id}>
      <h3>{row.run_id}</h3><Tag>{names[row.status]}</Tag><span>工作区{workspace[row.workspace.status]} · 到期 {new Date(row.workspace.expires_at).toLocaleString()}</span>
      {!['cancelled','failed','completed'].includes(row.status)&&(cancelId===row.run_id?<Space><Button danger disabled={working} onClick={()=>void cancel(row.run_id)}>确认取消</Button>
        <Button disabled={working} onClick={()=>setCancelId(undefined)}>返回</Button></Space>:<Button disabled={working} onClick={()=>setCancelId(row.run_id)}>取消运行</Button>)}
    </section>)}
    <Space><Button disabled={!pages.length||list.isFetching} onClick={()=>setPages(v=>v.slice(0,-1))}>上一页运行</Button>
      <Button disabled={!list.data?.next_before||list.isFetching} onClick={()=>{if(list.data?.next_before)setPages(v=>[...v,list.data.next_before!]);}}>下一页运行</Button></Space>
  </Card></>;
}
