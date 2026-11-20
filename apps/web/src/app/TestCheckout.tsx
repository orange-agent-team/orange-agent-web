import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Space} from 'antd';
import {CheckoutClient,states,validOrder,type Order,type Offer} from '../api/checkout';
import {ApiFailure} from '../api/client';
import type {UserSession} from '../api/contracts';
import {formatCredits} from '../api/accounts';
const api=new CheckoutClient();
type Handle={id:string;offer?:string};
const terminal=new Set(['credited','cancelled','expired']);

export default function TestCheckout({session,onCredit}:{session:UserSession;onCredit:()=>void}){
  const storage='orange.test-checkout.v1:'+JSON.stringify([session.user_id,session.personal_owner_id]);
  const [offers,setOffers]=useState<Offer[]>();
  const [handle,setHandle]=useState<Handle>();
  const [order,setOrder]=useState<Order>();
  const [error,setError]=useState('');
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>{
    const c=new AbortController();
    async function init(){
      try{
        const saved=sessionStorage.getItem(storage);
        let h:Handle|undefined;
        if(saved){h=JSON.parse(saved) as Handle;if(!h||!validOrder(h.id)||h.offer!==undefined&&typeof h.offer!=='string')throw Error('INVALID_LOCAL_ORDER');}
        else{const returned=new URLSearchParams(window.location.search).get('checkout_order');if(returned&&validOrder(returned))h={id:returned};}
        if(h&&!c.signal.aborted){
          setHandle(h);
          try{const data=await api.order(session,h.id,'get',c.signal,h.offer);if(!c.signal.aborted)setOrder(data);}
          catch{if(!c.signal.aborted)setError('尚未核对原订单。');}
        }
        const items=await api.offers(session,c.signal);
        if(!c.signal.aborted)setOffers(items);
      }catch(e){if(!c.signal.aborted && !(e instanceof ApiFailure&&e.status===404))setError('暂时无法读取测试充值资料。');}
      finally{if(!c.signal.aborted)setReady(true);}
    }
    void init();return ()=>{c.abort();active.current?.abort();};
  },[session,storage]);
  async function perform(h:Handle,action:'create'|'session'|'get'|'cancel'|'reconcile'){
    if(active.current)return;
    const c=new AbortController();active.current=c;setBusy(true);setError('');
    try{
      if(action==='create'){sessionStorage.setItem(storage,JSON.stringify(h));setHandle(h);}
      const v=await api.order(session,h.id,action,c.signal,h.offer);
      if(!c.signal.aborted){setOrder(v);if(v.state==='credited')onCredit();}
    }catch{if(!c.signal.aborted){setOrder(undefined);setError('结果尚未确认，请查询同一订单。');}}
    finally{if(!c.signal.aborted){active.current=null;setBusy(false);}}
  }
  if(!handle&&!offers?.length&&!error)return null;
  return <Card title="测试积分充值">
    <p>这里使用测试商户。到账状态以平台核对后的账本为准。</p>
    {handle?<><p>订单编号 <code>{handle.id}</code></p>
      {order&&<><p role="status">{states[order.state]}</p><p>{order.offer.amount_minor} {order.offer.currency.toUpperCase()} 最小货币单位 · {formatCredits(order.offer.microcredits)} 积分</p></>}
      <Space wrap>
        {!order&&<Button disabled={busy||!ready} onClick={()=>void perform(handle,'get')}>查询原订单</Button>}
        {!order&&handle.offer&&<Button disabled={busy||!ready} onClick={()=>void perform(handle,'create')}>恢复原订单</Button>}
        {order?.state==='created'&&<><Button disabled={busy} onClick={()=>void perform(handle,'session')}>确认创建测试支付会话</Button><Button disabled={busy} onClick={()=>void perform(handle,'cancel')}>取消未派发订单</Button></>}
        {order?.state==='open'&&order.checkout_url&&<a href={order.checkout_url} target="_blank" rel="noopener noreferrer">打开测试收银台</a>}
        {order&&!terminal.has(order.state)&&order.state!=='created'&&<Button disabled={busy} onClick={()=>void perform(handle,'reconcile')}>核对付款状态</Button>}
        {order&&terminal.has(order.state)&&<Button disabled={busy} onClick={()=>{try{sessionStorage.removeItem(storage);setHandle(undefined);setOrder(undefined);setError('');const url=new URL(window.location.href);url.searchParams.delete('checkout_order');history.replaceState(history.state,'',url);}catch{setError('无法清除本机订单记录。');}}}>返回测试充值</Button>}
      </Space>
    </>:offers?.map(v=><p key={v.offer_id}>{v.amount_minor} {v.currency.toUpperCase()} 最小货币单位 · {formatCredits(v.microcredits)} 积分 <Button disabled={busy||!ready} onClick={()=>void perform({id:crypto.randomUUID(),offer:v.offer_id},'create')}>创建测试订单</Button></p>)}
    {error&&<Alert type="warning" title={error}/>}
  </Card>;
}
