import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/test-checkout.schema.json' with {type:'json'};
import {UserClient} from './client';
import type {UserSession} from './contracts';
import {pathId} from './compute-contracts';

export type Offer={offer_id:string;currency:string;amount_minor:string;microcredits:string};
export const states={created:'等待确认',cancelled:'已取消',dispatching:'支付会话创建中',unknown:'支付会话待核对',open:'等待测试付款',expired:'支付会话已过期',paid_review:'付款凭证核对中',credited:'测试积分已入账',review_required:'需要人工复核'};
export type Order={order_id:string;owner_id:string;offer:Offer;state:keyof typeof states;checkout_url:string|null};
const ajv=new Ajv2020({strict:false});ajv.addSchema(schema);
const offers=ajv.compile<Offer[]>({$ref:schema.$id+'#/$defs/TestCreditOffers'});
const order=ajv.compile<Order>({$ref:schema.$id+'#/$defs/TestCheckoutOrder'});
export const validOrder=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
function validOffer(v:Offer){return BigInt(v.microcredits)<=9223372036854775807n;}
const root=(s:UserSession)=>'/api/v1/owners/'+pathId(s.personal_owner_id);
export class CheckoutClient extends UserClient{
  async offers(s:UserSession,signal:AbortSignal){
    const v=await this.call(root(s)+'/credit-offers',{signal});
    if(!offers(v)||!v.every(validOffer)||new Set(v.map(x=>x.offer_id)).size!==v.length)throw Error('INVALID_CREDIT_OFFERS');
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
