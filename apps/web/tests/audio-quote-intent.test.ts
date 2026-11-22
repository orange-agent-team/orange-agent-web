import {describe,it,expect} from 'vitest';
import {acknowledgeAudioQuote,audioQuoteScope,beginAudioAttempt,forgetEndedAudioAttempt,markAudioSubmission,readAudioAttempt} from '../src/api/audio-quote-intent';
import type {UserSession} from '../src/api/contracts';
import type {AudioGrantReceipt,AudioPrice,AudioQuote} from '../src/api/compute-contracts';
const session:UserSession={user_id:'member',personal_owner_id:'personal',session_id:'sess',csrf_token:'csrf-private',expires_at:'2099-01-01T00:00:00Z'};
const grant:AudioGrantReceipt={grant_id:'grant',invocation_id:'inv',observation_id:'observation',projection_digest:'a'.repeat(64),expires_at_unix:'900000',state:'active'};
const price:AudioPrice={price_version:'price-v1',price_per_minute:'12000',fee_bps:500};
const quote:AudioQuote={...price,grant_id:'grant',invocation_id:'inv',observation_id:'observation',request_projection_digest:grant.projection_digest,root_budget_id:'allocation',quote_id:'quote-v1',duration_ms:'11000',max_amount:'2200',expires_at_unix:'800000'};
const scope=audioQuoteScope(session,'team',grant,'allocation');
function memory(){const data=new Map<string,string>();return {data,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
describe('recoverable transcription quotes',()=>{
 it('persists the original request before its receipt and isolates team, budget and user',()=>{
    const s=memory(),a=beginAudioAttempt(s,scope,price);
    expect(beginAudioAttempt(s,scope,{...price,price_version:'rotated'})).toEqual(a);
    for(const other of [{...scope,owner:'personal'},{...scope,user:'another'},{...scope,budget:'different'}])expect(readAudioAttempt(s,other)).toBeNull();
    expect(JSON.stringify([...s.data.values()])).not.toContain(session.csrf_token);
    expect(acknowledgeAudioQuote(s,scope,a.request,quote).quote).toBe(quote.quote_id);
    expect(()=>acknowledgeAudioQuote(s,scope,a.request,{...quote,quote_id:'other'})).toThrow();
 });
 it('rejects changed amounts, allocations and stale price requests and blocks replacement after possible submission',()=>{
   const s=memory(),first=beginAudioAttempt(s,scope,price);
   expect(()=>acknowledgeAudioQuote(s,scope,first.request,{...quote,price_per_minute:'1'})).toThrow();
   expect(()=>acknowledgeAudioQuote(s,scope,first.request,{...quote,root_budget_id:'other'})).toThrow();
   const second=beginAudioAttempt(s,scope,price,first.request);
   expect(second.request).not.toBe(first.request);
   expect(()=>acknowledgeAudioQuote(s,scope,first.request,quote)).toThrow();
   acknowledgeAudioQuote(s,scope,second.request,quote);
   markAudioSubmission(s,scope,second.request,quote.quote_id);
   expect(()=>beginAudioAttempt(s,scope,price,second.request)).toThrow();
   expect(()=>forgetEndedAudioAttempt(s,scope,grant)).toThrow();
   forgetEndedAudioAttempt(s,scope,{...grant,state:'revoked'});
   expect(readAudioAttempt(s,scope)).toBeNull();
 });
});
