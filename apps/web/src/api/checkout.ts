import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/test-checkout.schema.json' with {type:'json'};
import {UserClient} from './client';
import type {UserSession} from './contracts';
import {pathId} from './compute-contracts';

export type Offer={offer_id:string;currency:string;amount_minor:string;microcredits:string};
export const states={created:'等待确认',cancelled:'已取消',dispatching:'支付会话创建中',unknown:'支付会话待核对',open:'等待测试付款',expired:'支付会话已过期',paid_review:'付款凭证核对中',credited:'测试积分已入账',review_required:'需要人工复核'};
export type Order={order_id:string;owner_id:string;offer:Offer;state:keyof typeof states;checkout_url:string|null};
export const refundStates={held:'等待独立审批，余额已冻结',authorized:'已批准，等待派发',approval_lost:'审批权限已变更',dispatching:'正在提交退款',unknown:'商户结果待核对，余额仍冻结',pending:'商户退款处理中',succeeded:'测试退款已确认',failed:'测试退款失败，冻结已解除',cancelled:'退款申请已取消',review_required:'需要财务复核'};
export type Eligibility={order_id:string;owner_id:string;currency:string;max_refundable_minor:string;unspent_microcredits:string;pending_refund_id:string|null};
export type Refund={refund_id:string;order_id:string;owner_id:string;currency:string;amount_minor:string;held_microcredits:string;case_id:string;state:keyof typeof refundStates};
const ajv=new Ajv2020({strict:false});ajv.addSchema(schema);
const offers=ajv.compile<Offer[]>({$ref:schema.$id+'#/$defs/TestCreditOffers'});
const order=ajv.compile<Order>({$ref:schema.$id+'#/$defs/TestCheckoutOrder'});
export type OrderPage={owner_id:string;data:Pick<Order,'order_id'|'state'|'offer'>[];next_cursor:string|null};
const page=ajv.compile<OrderPage>({$ref:schema.$id+'#/$defs/TestOrderPage'});
type SpendingStatus={owner_id:string;positive_spending:'available'|'paused';open_restrictions:string};
const spending=ajv.compile<SpendingStatus>({$ref:schema.$id+'#/$defs/TestSpendingStatus'});
const eligibility=ajv.compile<Eligibility>({$ref:schema.$id+'#/$defs/TestRefundEligibility'});
const refund=ajv.compile<Refund>({$ref:schema.$id+'#/$defs/TestRefundView'});
export const validOrder=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
function validOffer(v:Offer){return BigInt(v.microcredits)<=9223372036854775807n;}
const root=(s:UserSession)=>'/api/v1/owners/'+pathId(s.personal_owner_id);
export class CheckoutClient extends UserClient{
  async offers(s:UserSession,signal:AbortSignal){
    const v=await this.call(root(s)+'/credit-offers',{signal});
    if(!offers(v)||!v.every(validOffer)||new Set(v.map(x=>x.offer_id)).size!==v.length)throw Error('INVALID_CREDIT_OFFERS');
    return v;
  }
  async status(s:UserSession,signal:AbortSignal){
    const v=await this.call(root(s)+'/spending-status',{signal});
    if(!spending(v)||v.owner_id!==s.personal_owner_id||(v.positive_spending==='paused')!==(BigInt(v.open_restrictions)>0n))throw Error('UNCONFIRMED_SPENDING_STATUS');
    return v;
  }
  async history(s:UserSession,after:string|undefined,signal:AbortSignal){
    if(after&&!validOrder(after))throw Error('INVALID_CURSOR');
    const v=await this.call(root(s)+'/checkout-orders?limit=10'+(after?'&after='+after:''),{signal});
    if(!page(v)||v.owner_id!==s.personal_owner_id||v.data.some(r=>!validOffer(r.offer)))throw Error('UNCONFIRMED_ORDER_HISTORY');
    return v;
  }
  async eligibility(s:UserSession,id:string,signal:AbortSignal){
    if(!validOrder(id))throw Error('INVALID_ORDER');
    const v=await this.call(root(s)+'/checkout-orders/'+id+'/refundable',{signal});
    if(!eligibility(v)||v.order_id!==id||v.owner_id!==s.personal_owner_id)throw Error('UNCONFIRMED_ELIGIBILITY');
    return v;
  }
  async refund(s:UserSession,order:Order,id:string,action:'get'|'create'|'cancel',signal:AbortSignal,amount?:string){
    if(!validOrder(id)||!validOrder(order.order_id))throw Error('INVALID_REFUND');
    const url=root(s)+(action==='create'?'/checkout-orders/'+order.order_id+'/refunds':'/refunds/'+id+(action==='cancel'?'/cancel':''));
    const body=action==='create'?{refund_id:id,currency:order.offer.currency,amount_minor:amount}:{};
    const v=await this.call(url,action==='get'?{signal}:{signal,method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':id},body:JSON.stringify(body)},action==='create'?201:200);
    if(!refund(v)||v.owner_id!==s.personal_owner_id||v.order_id!==order.order_id||v.refund_id!==id||v.currency!==order.offer.currency||amount!==undefined&&v.amount_minor!==amount)throw Error('UNCONFIRMED_REFUND');
    return v;
  }
  async order(s:UserSession,id:string,action:'get'|'create'|'session'|'reconcile'|'cancel',signal:AbortSignal,sku?:string){
    if(!validOrder(id))throw Error('INVALID_ORDER_ID');
    const url=root(s)+'/checkout-orders'+(action==='create'?'':'/'+id+(action==='get'?'':'/'+action));
    const init:RequestInit=action==='get'?{signal}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':id},
      body:JSON.stringify(action==='create'?{order_id:id,offer_id:sku}:{}),signal};
    const v=await this.call(url,init,action==='create'?201:200);
    if(!order(v)||v.order_id!==id||v.owner_id!==s.personal_owner_id||!validOffer(v.offer)||sku!==undefined&&v.offer.offer_id!==sku)throw Error('UNCONFIRMED_ORDER');
    if((v.state==='open')!==(v.checkout_url!==null))throw Error('UNCONFIRMED_CHECKOUT_LINK');
    if(v.checkout_url){
      const location=new URL(v.checkout_url);
      if(location.origin!=='https://checkout.stripe.com'||location.username||location.password||!/^\/c\/pay\/cs_test_[A-Za-z0-9_]+$/.test(location.pathname))throw Error('INVALID_CHECKOUT_ORIGIN');
    }
    return v;
  }
}
