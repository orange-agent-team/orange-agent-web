import {describe,expect,it} from 'vitest';
import {ComputeClient} from '../src/api/compute-client';
import {sha256,type InspectedImage} from '../src/api/compute-contracts';
import type {UserSession} from '../src/api/contracts';

const session:UserSession={user_id:'user',personal_owner_id:'owner',session_id:'session',csrf_token:'c'.repeat(43),expires_at:'2099-01-01T00:00:00Z'};
const origin='https://store.example.invalid';
const version='frozen-version';
const request=new URLSearchParams({versionId:version,'X-Amz-Expires':'60','X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Signature':'a'.repeat(64)});
const good=origin+'/private/published-image?'+request;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

async function fixture(url:string, provider:Uint8Array, mismatch=false) {
  const bytes=new Uint8Array([9,8,7]);
  const hash=await sha256(bytes);
  const image:InspectedImage={artifact_id:'image',version_id:version,content:{width:1024,height:1024,bytes:3,
    media_type:'image/png',sha256:hash,rgb_sha256:'a'.repeat(64)}};
  const artifact={upload_id:'upload',artifact_id:'image',version_id:version,owner_id:'owner',state:'available',media_type:'image/png',
    size_bytes:'3',sha256:hash};
  const external:RequestInit[]=[];
  const client=new ComputeClient(async (input,init={})=>{
    const target=String(input);
    if(target==='/artifact-download.json') return json({version:1,origin});
    if(target.endsWith('/download-authorizations')) return json({artifact_id:'image',version_id:version,sha256:mismatch?'b'.repeat(64):hash,
      size_bytes:'3',url,expires_at_unix:String(Math.floor(Date.now()/1000)+60)});
    if(target.startsWith('https:') || target.startsWith('http:')) {
      external.push(init);return new Response(Uint8Array.from(provider));
    }
    if(target.includes('/image-output-inspection?')) return json(image);
    return json(artifact);
  });
  return {external, run:()=>client.downloadImage(session,'upload',image,new AbortController().signal)};
}

describe('versioned download authority',()=>{
  it('never contacts an unregistered origin or accepts a rebound descriptor',async()=>{
    for(const [url,changed] of [[good.replace(origin,'https://other.example.invalid'),false],[good+'&versionId=second',false],
      [good.replace('Expires=60','Expires=90'),false],[good,true]] as const){
      const f=await fixture(url,new Uint8Array(3),changed);
      await expect(f.run()).rejects.toThrow();expect(f.external).toHaveLength(0);
    }
  });
  it('rejects incorrect bytes from the allowed origin and sends no ambient authority',async()=>{
    const f=await fixture(good,new Uint8Array([8,8,8]));
    await expect(f.run()).rejects.toThrow('RESULT_HASH_MISMATCH');
    expect(f.external).toHaveLength(1);
    expect(f.external[0]).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});
    expect(f.external[0].headers).toBeUndefined();
  });
});
