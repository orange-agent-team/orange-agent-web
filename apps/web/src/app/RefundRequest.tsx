import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Input,Space} from 'antd';
import type {UserSession} from '../api/contracts';
import {CheckoutClient,refundStates,validOrder,type Eligibility,type Order,type Refund} from '../api/checkout';
const api=new CheckoutClient();
type Handle={id:string;amount?:string};

export default function RefundRequest({order,session}:{order:Order;session:UserSession}){
  const storage='orange.test-refund.v1:'+JSON.stringify([session.user_id,order.owner_id,order.order_id]);
  const [limits,setLimits]=useState<Eligibility>();
  const [handle,setHandle]=useState<Handle>();
  const [receipt,setReceipt]=useState<Refund>();
  const [amount,setAmount]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const op=useRef<AbortController|null>(null);
  async function reload(signal:AbortSignal){
    const v=await api.eligibility(session,order.order_id,signal);
    const stored=sessionStorage.getItem(storage);
    let h:Handle|undefined=v.pending_refund_id?{id:v.pending_refund_id}:stored?JSON.parse(stored) as Handle:undefined;
    if(h&&(!validOrder(h.id)||h.amount!==undefined&&!/^[1-9][0-9]{0,7}$/.test(h.amount)))throw Error('INVALID_REFUND_HANDLE');
    if(!signal.aborted){setLimits(v);setHandle(h);setReceipt(undefined);}
    if(h){const r=await api.refund(session,order,h.id,'get',signal,h.amount);if(!signal.aborted)setReceipt(r);}
  }
  useEffect(()=>{const c=new AbortController();void reload(c.signal).catch(()=>{if(!c.signal.aborted)setError('暂时无法核对原购买记录。');});
    return ()=>{c.abort();op.current?.abort();};},[order.order_id,session,storage]);
  async function perform(work:(signal:AbortSignal)=>Promise<void>){
    if(op.current)return;const c=new AbortController();op.current=c;setBusy(true);setError('');
    try{await work(c.signal);}catch{if(!c.signal.aborted)setError('退款结果尚未确认，请核对原申请。');}
    finally{if(!c.signal.aborted){op.current=null;setBusy(false);}}
  }
  const valid=limits&&/^[1-9][0-9]{0,7}$/.test(amount)&&BigInt(amount)<=BigInt(limits.max_refundable_minor);
  function submit(h:Handle){
    void perform(async signal=>{
      if(!h.amount)return;
      sessionStorage.setItem(storage,JSON.stringify(h));setHandle(h);
      const r=await api.refund(session,order,h.id,'create',signal,h.amount);if(!signal.aborted)setReceipt(r);
    });
  }
  return <section aria-label="原路测试退款"><h3>原路测试退款</h3>
    {limits&&<p>这笔购买当前最多可退 {limits.max_refundable_minor} {limits.currency.toUpperCase()} 最小货币单位。</p>}
    {handle?<><p>退款编号 <code>{handle.id}</code></p>{receipt&&<p role="status">{refundStates[receipt.state]} · {receipt.amount_minor} {receipt.currency.toUpperCase()} 最小货币单位</p>}
      <Space wrap><Button disabled={busy} onClick={()=>void perform(reload)}>核对退款进度</Button>
      {!receipt&&handle.amount&&<Button disabled={busy} onClick={()=>submit(handle)}>恢复原退款申请</Button>}
      {receipt&&['held','authorized','approval_lost'].includes(receipt.state)&&<Button disabled={busy} onClick={()=>void perform(async signal=>{await api.refund(session,order,handle.id,'cancel',signal);await reload(signal);})}>取消退款申请</Button>}
      {receipt&&['succeeded','failed','cancelled'].includes(receipt.state)&&<Button disabled={busy} onClick={()=>void perform(async signal=>{sessionStorage.removeItem(storage);setAmount('');await reload(signal);})}>返回可退余额</Button>}</Space>
    </>:limits&&BigInt(limits.max_refundable_minor)>0n&&<>
      <label>退款金额（最小货币单位）<Input inputMode="numeric" maxLength={8} value={amount} disabled={busy} onChange={e=>setAmount(e.target.value)}/></label>
      <p>提交后冻结这笔购买对应的未用积分，待财务独立审批和商户确认。</p>
      <Button disabled={busy||!valid} onClick={()=>submit({id:crypto.randomUUID(),amount})}>冻结并申请测试退款</Button></>}
    {error&&<Alert title={error} type="warning"/>}
  </section>;
}
