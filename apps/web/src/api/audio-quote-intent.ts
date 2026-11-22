import {decodeCompute,pathId,type AudioPrice,type AudioQuote,type AudioGrantReceipt} from './compute-contracts';
import type {UserSession} from './contracts';

export type AudioQuoteScope = { user:string;owner:string;grant:string;invocation:string;observation:string;projection:string;budget:string|null };
export type AudioQuoteAttempt = {request:string;price:AudioPrice;quote:string|null;submitting:boolean};
type StoragePort = Pick<Storage,'getItem'|'setItem'>;
export function audioQuoteScope(s:UserSession,owner:string,r:AudioGrantReceipt,budget?:string):AudioQuoteScope{
  return {user:s.user_id,owner,grant:r.grant_id,invocation:r.invocation_id,observation:r.observation_id,projection:r.projection_digest,budget:budget??null};
}
const key=(s:AudioQuoteScope)=>'orange.audio-quote.v1:'+JSON.stringify([s.user,s.owner,s.grant,s.invocation,s.budget]);

export function readAudioAttempt(storage:StoragePort,scope:AudioQuoteScope):AudioQuoteAttempt|null{
  const raw=storage.getItem(key(scope));
  if(raw===null)return null;
  if(raw.length>8192)throw Error('INVALID_AUDIO_QUOTE_RECORD');
  const value=JSON.parse(raw);
  if(!value||value.version!==1||value.scope!==JSON.stringify(scope)||Object.keys(value).some(k=>!['version','scope','attempt'].includes(k)))throw Error('INVALID_AUDIO_QUOTE_RECORD');
  const a=value.attempt;
  if(!a||Object.keys(a).some(k=>!['request','price','quote','submitting'].includes(k))||typeof a.request!=='string'||typeof a.submitting!=='boolean'||(a.quote!==null&&typeof a.quote!=='string')||(a.submitting&&!a.quote))throw Error('INVALID_AUDIO_QUOTE_RECORD');
  pathId(a.request);if(a.quote!==null)pathId(a.quote);decodeCompute('AudioPrice',a.price);
  return a as AudioQuoteAttempt;
}
function save(storage:StoragePort,scope:AudioQuoteScope,a:AudioQuoteAttempt):AudioQuoteAttempt{
  storage.setItem(key(scope),JSON.stringify({version:1,scope:JSON.stringify(scope),attempt:a}));
  return a;
}
export function beginAudioAttempt(storage:StoragePort,scope:AudioQuoteScope,price:AudioPrice,replace?:string):AudioQuoteAttempt{
  const old=readAudioAttempt(storage,scope);
  if(old && replace===undefined)return old;
  if(replace!==undefined && (!old||old.request!==replace||old.submitting))throw Error('AUDIO_QUOTE_CHANGED');
  return save(storage,scope,{request:crypto.randomUUID(),price:decodeCompute('AudioPrice',price),quote:null,submitting:false});
}
export function acknowledgeAudioQuote(storage:StoragePort,scope:AudioQuoteScope,request:string,q:AudioQuote):AudioQuoteAttempt{
  const a=readAudioAttempt(storage,scope);
  if(!a||a.request!==request||(a.quote!==null&&a.quote!==q.quote_id)||a.price.price_version!==q.price_version||
     a.price.price_per_minute!==q.price_per_minute||a.price.fee_bps!==q.fee_bps||q.grant_id!==scope.grant||
     q.observation_id!==scope.observation||q.invocation_id!==scope.invocation||q.request_projection_digest!==scope.projection||
     (scope.budget!==null&&q.root_budget_id!==scope.budget))throw Error('AUDIO_QUOTE_CHANGED');
  return save(storage,scope,{...a,quote:q.quote_id});
}
export function markAudioSubmission(storage:StoragePort,scope:AudioQuoteScope,request:string,quote:string):AudioQuoteAttempt{
  const a=readAudioAttempt(storage,scope);
  if(!a||a.request!==request||a.quote!==quote)throw Error('AUDIO_QUOTE_CHANGED');
  return save(storage,scope,{...a,submitting:true});
}

export function forgetEndedAudioAttempt(storage:Pick<Storage,'removeItem'>,scope:AudioQuoteScope,receipt:AudioGrantReceipt){
  if(receipt.grant_id!==scope.grant||receipt.invocation_id!==scope.invocation||receipt.state==='active')throw Error('AUDIO_GRANT_STILL_ACTIVE');
  storage.removeItem(key(scope));
}
