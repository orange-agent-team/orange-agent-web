import {describe,it,expect} from 'vitest';
import {transferDirect} from '../src/api/direct-upload';
import {ApiFailure} from '../src/api/client';
import {sha256,type Artifact,type Upload} from '../src/api/compute-contracts';
import type {UserSession} from '../src/api/contracts';

const session:UserSession={session_id:'session',user_id:'worker-owner',personal_owner_id:'owner',csrf_token:'c'.repeat(43),expires_at:'2099-01-01T00:00:00Z'};
async function setup(mode:'wrong-origin'|'unconfirmed'|'resume'|'mismatch') {
  const data=Uint8Array.of(7,9);const sha=await sha256(data);
  const req:Upload={upload_id:'u',media_type:'image/png',size_bytes:'2',sha256:sha};
  const a:Artifact={...req,owner_id:'owner',version_id:'version',artifact_id:'artifact',state:'staging'};
  const id='9de7782d-c3f7-407b-8ae8-3d1be9bde52b';
  const h={'content-length':'2','if-none-match':'*','content-type':'application/octet-stream','content-disposition':'attachment',
    'cache-control':'private, no-store','x-amz-checksum-sha256':btoa(String.fromCharCode(...(sha.match(/../g)??[]).map(n=>parseInt(n,16)))),
    'x-amz-meta-orange-root':'s3-'+'a'.repeat(64),'x-amz-meta-orange-key':'staging-'+id};
  const query=new URLSearchParams({'X-Amz-Expires':'300','X-Amz-Signature':'a'.repeat(64),'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
    'X-Amz-SignedHeaders':['host',...Object.keys(h)].join(';')});
  const origin='https://storage.example.invalid';
  const url=(mode==='wrong-origin'?'https://wrong.example.invalid':origin)+'/staging-'+id+'?'+query;
  const shared={transfer_id:id,version_id:'version',artifact_id:'artifact',upload_id:'u',expires_at_unix:String(Math.ceil(Date.now()/1000)+300)};
  const history=(state:string,version:string|null)=>({...shared,request_id:'u',state,provider_version:version});
  let writes=0,publications=0,issues=0;
  const signal=new AbortController().signal;
  const run=()=>transferDirect({origin,session,artifact:a,request:req,body:data.buffer,signal,base:'/api/v1/owners/owner',
    fetcher:async (_url,opts)=>{writes++;expect(opts?.credentials).toBe('omit');expect(opts?.referrerPolicy).toBe('no-referrer');
      expect(new Headers(opts?.headers).has('content-length')).toBe(false);throw new Error('lost reply');},
    api:async(path,opts)=>{
      if(path.endsWith('/upload-confirmations')){publications++;return {...a,state:'available'};}
      if(opts.method==='POST'){issues++;return {...shared,url,state:'authorized',required_headers:mode==='mismatch'?{...h,'content-length':'3'}:h};}
      if(path.endsWith('/upload-authorizations')){if(mode==='resume')return history('verifying','provider-v1');throw new ApiFailure(404,'NOT_FOUND');}
      return history('unconfirmed',null);
    }});
  return {run,counts:()=>[issues,writes,publications]};
}
describe('direct upload recovery',()=>{
  it('rejects a different storage origin or size before sending bytes',async()=>{
    for(const mode of ['wrong-origin','mismatch'] as const){const t=await setup(mode);await expect(t.run()).rejects.toThrow();expect(t.counts()).toEqual([1,0,0]);}
  });
  it('surfaces an unconfirmed write without automatic retransmission or confirmation',async()=>{
    const t=await setup('unconfirmed');await expect(t.run()).rejects.toThrow('UPLOAD_UNCONFIRMED');expect(t.counts()).toEqual([1,1,0]);
  });
  it('continues the frozen provider version after reopening without another PUT',async()=>{
    const t=await setup('resume');await expect(t.run()).resolves.toMatchObject({state:'available',version_id:'version'});expect(t.counts()).toEqual([0,0,1]);
  });
});
