import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Input,Space} from 'antd';
import {authorityKey,type UserSession} from '../api/contracts';
import {KeyClient,generateKey,validKeyId,type LocalKey,type ReadScope} from '../api/personal-keys';

const client=new KeyClient();
const purposes={'wallet:read':'读取个人钱包','budgets:read':'读取个人预算'};
const statuses={active:'有效',revoked:'已撤销',expired:'已过期'};
const visible=()=>!document.hidden;
function observe(notify:()=>void){
  document.addEventListener('visibilitychange',notify);
  return ()=>document.removeEventListener('visibilitychange',notify);
}
export default function PersonalAutomationKeys({session}:{session:UserSession}){
  const [open,setOpen]=useState(false);
  const shown=useSyncExternalStore(observe,visible);
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>个人自动化密钥</summary>
    {open && shown && <KeyManager key={authorityKey(session)} session={session}/>}
  </details>;
}

function KeyManager({session}:{session:UserSession}){
  const storageKey='orange.personal-key.v1.'+authorityKey(session);
  const [view]=useState(()=>crypto.randomUUID());
  const [pages,setPages]=useState<string[]>([]);
  const after=pages.at(-1);
  const list=useQuery({queryKey:[authorityKey(session),'personal-keys',view,after??''],gcTime:0,
    queryFn:({signal})=>client.list(session,after,signal),retry:false});
  const [label,setLabel]=useState('');
  const [scope,setScope]=useState<ReadScope>('wallet:read');
  const [days,setDays]=useState(7);
  const [local,setLocal]=useState<LocalKey>();
  const [revealed,setRevealed]=useState(false);
  const [pending,setPending]=useState<string>();
  const [revokeId,setRevokeId]=useState<string>();
  const [issue,setIssue]=useState('');
  const [busy,setBusy]=useState(false);
  const [storageOK,setStorageOK]=useState(false);
  const live=useRef(true),lock=useRef(false);
  useEffect(()=>{
    live.current=true;
    try{
      const stored=sessionStorage.getItem(storageKey);
      if(stored && !validKeyId(stored))throw Error('INVALID_KEY_ID');
      setPending(stored??undefined);setStorageOK(true);
    }catch{setIssue('无法核对上次登记的编号。');}
    return ()=>{live.current=false;};
  },[storageKey]);
  function forget(){
    sessionStorage.removeItem(storageKey);
    setLocal(undefined);setPending(undefined);setRevealed(false);setIssue('');
  }
  async function register(){
    if(lock.current || !visible() || !storageOK || (pending && !local))return;
    lock.current=true;setBusy(true);setIssue('');
    try{
      const intent=local??await generateKey(label.trim(),scope,days*86400);
      if(!live.current || !visible())return;
      // A tab may lose the reply. Only the withdrawal ID survives leaving the view.
      sessionStorage.setItem(storageKey,intent.id);
      setLocal(intent);setPending(intent.id);
      const receipt=await client.register(session,intent.id,intent.registration);
      if(!live.current || !visible())return;
      if(receipt.status==='active'){setRevealed(true);}
      else {forget();setIssue('此编号已失效。请新建密钥。');}
      await list.refetch();
    }catch{if(live.current)setIssue('登记尚未确认。请核对原编号，或撤销这次登记。');}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function withdraw(id:string){
    if(lock.current || !visible())return;
    lock.current=true;setBusy(true);setIssue('');
    try{
      await client.withdraw(session,id);
      if(!live.current)return;
      if(pending===id)forget();
      setRevokeId(undefined);await list.refetch();
    }catch{if(live.current)setIssue('撤销尚未确认，请重试原编号。');}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  return <section aria-label="个人自动化密钥管理"><Card>
    <p>每把密钥只允许读取你选择的一类个人账户数据，到期或撤销后失效。</p>
    {!pending && <Space wrap><label>密钥名称 <Input aria-label="密钥名称" value={label} maxLength={64} disabled={busy} onChange={e=>setLabel(e.target.value)}/></label>
      <label>读取权限 <select value={scope} disabled={busy} onChange={e=>setScope(e.target.value as ReadScope)}><option value="wallet:read">读取个人钱包</option><option value="budgets:read">读取个人预算</option></select></label>
      <label>有效期 <select value={days} disabled={busy} onChange={e=>setDays(Number(e.target.value))}>{[1,7,30].map(n=><option key={n} value={n}>{n} 天</option>)}</select></label>
      <Button disabled={busy||!storageOK||!label.trim()||list.isError||!list.isSuccess} onClick={()=>void register()}>创建只读密钥</Button>
    </Space>}
    {pending && <section aria-label="本次登记"><p>登记编号 <code>{pending}</code></p>
      {revealed && local ? <><label>请保存密钥，离开此面板后无法再次显示
        <Input.TextArea aria-label="新建的自动化密钥" value={local.bearer} readOnly autoComplete="off" spellCheck={false}/></label>
        <Button onClick={()=>{try{forget();}catch{setIssue('无法清除登记编号。');}}}>我已保存</Button></> :
        <>{local && <Button disabled={busy} onClick={()=>void register()}>重试原登记</Button>}
          <Button disabled={busy} onClick={()=>setRevokeId(pending)}>撤销这次登记</Button></>}
    </section>}
    {issue && <Alert type="warning" title={issue}/>}
    {list.isError && <Alert type="warning" title="暂时无法读取密钥列表"/>}
    <Button disabled={list.isFetching||busy} onClick={()=>void list.refetch()}>刷新密钥列表</Button>
    {!list.isError && list.data?.data.map(item=><div key={item.key_id}><b>{item.label}</b> · {purposes[item.scope]} · {statuses[item.status]} · {new Date(item.expires_at).toLocaleString()}
      <p><code>{item.key_id}</code> {item.status==='active'&&<Button disabled={busy} onClick={()=>setRevokeId(item.key_id)}>撤销 {item.label}</Button>}</p></div>)}
    {revokeId && <Space><span>撤销编号 {revokeId}？</span><Button disabled={busy} danger onClick={()=>void withdraw(revokeId)}>确认撤销密钥</Button>
      <Button disabled={busy} onClick={()=>setRevokeId(undefined)}>返回</Button></Space>}
    <Space>{pages.length>0 && <Button onClick={()=>setPages(pages.slice(0,-1))}>上页密钥</Button>}
      {list.data?.next_cursor && <Button onClick={()=>setPages([...pages,list.data!.next_cursor!])}>下页密钥</Button>}</Space>
  </Card></section>;
}
