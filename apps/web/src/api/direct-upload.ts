import {ApiFailure} from './client';
import {decodeCompute,pathId,type Artifact,type Upload,type DirectUploadObservation} from './compute-contracts';
import type {UserSession} from './contracts';

type ApiCall = (path:string,init:RequestInit,timeoutMs?:number)=>Promise<unknown>;
type Transfer = {api:ApiCall; fetcher:typeof fetch; origin:string; base:string; session:UserSession;
  artifact:Artifact; request:Upload; body:BodyInit; signal:AbortSignal};

function checkedObservation(data:unknown, artifact:Artifact, transfer?:string):DirectUploadObservation {
  const v=decodeCompute('UploadObservation',data);
  if(v.artifact_id!==artifact.artifact_id || v.version_id!==artifact.version_id || v.upload_id!==artifact.upload_id ||
     (transfer!==undefined && transfer!==v.transfer_id)) throw new ApiFailure(200,'UNCONFIRMED_UPLOAD');
  return v;
}

export async function transferDirect({api,fetcher,origin,base,session,artifact,request,body,signal}:Transfer):Promise<unknown> {
  const collection=base+'/uploads/'+pathId(request.upload_id);
  const grants=collection+'/upload-authorizations';
  const headers=(key:string)=>({'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':key});
  async function confirm(v:DirectUploadObservation) {
    if(!v.provider_version || !['ready_to_confirm','verifying'].includes(v.state)) throw new ApiFailure(0,'UPLOAD_UNCONFIRMED');
    try{
      return await api(collection+'/upload-confirmations',{method:'POST',signal,headers:headers(v.transfer_id),body:JSON.stringify({
        version_id:artifact.version_id,transfer_id:v.transfer_id,provider_version:v.provider_version})},95000);
    } catch(failure) {
      if(signal.aborted || failure instanceof ApiFailure && failure.status>0 && failure.status<500) throw failure;
      const observed=checkedObservation(await api(grants+'/'+pathId(v.transfer_id),{signal}),artifact,v.transfer_id);
      if(observed.state==='available') return api(collection,{signal});
      throw new ApiFailure(0,'UPLOAD_CONFIRMATION_UNKNOWN');
    }
  }
  let previous:DirectUploadObservation|undefined;
  try {previous=checkedObservation(await api(grants,{signal}),artifact);}
  catch(failure){if(!(failure instanceof ApiFailure && failure.status===404))throw failure;}
  if(previous?.state==='available') return api(collection,{signal});
  if(previous?.state==='ready_to_confirm'||previous?.state==='verifying') return confirm(previous);
  const key=previous?.state==='expired'?previous.transfer_id:previous?.request_id??request.upload_id;
  const v=decodeCompute('UploadAuthorization',await api(grants,{method:'POST',headers:headers(key),signal,body:JSON.stringify({version_id:artifact.version_id})}));
  if(v.state==='available') return v.artifact;
  const signed=new URL(v.url),h=v.required_headers;
  const ttl=signed.searchParams.getAll('X-Amz-Expires'),list=signed.searchParams.getAll('X-Amz-SignedHeaders');
  const hashBytes=Uint8Array.from(request.sha256.match(/../g)??[],s=>parseInt(s,16));
  if(v.artifact_id!==artifact.artifact_id||v.version_id!==artifact.version_id||v.upload_id!==request.upload_id||
     previous?.state==='unconfirmed' && previous.transfer_id!==v.transfer_id||
     signed.origin!==origin || signed.username || signed.password || signed.hash || signed.searchParams.has('versionId') ||
     signed.searchParams.get('X-Amz-Algorithm')!=='AWS4-HMAC-SHA256'||!/^[0-9a-f]{64}$/.test(signed.searchParams.get('X-Amz-Signature')??'')||
     !signed.pathname.endsWith('/'+h['x-amz-meta-orange-key']) || ttl.length!==1 || !/^[1-9][0-9]{0,2}$/.test(ttl[0]) || Number(ttl[0])>300 ||
     list.length!==1 || !Object.keys(h).every(k=>list[0].split(';').includes(k)) || h['content-length']!==request.size_bytes ||
     h['x-amz-checksum-sha256']!==btoa(String.fromCharCode(...hashBytes)) || BigInt(v.expires_at_unix)<=BigInt(Math.floor(Date.now()/1000)))
    throw new ApiFailure(200,'UNCONFIRMED_UPLOAD_GRANT');
  // Content-Length is signed. The browser derives it from the immutable File/ArrayBuffer body.
  const sendHeaders=new Headers(h);sendHeaders.delete('content-length');
  let status=0;
  try{
    const reply=await fetcher(signed.href,{method:'PUT',body,headers:sendHeaders,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal});
    status=reply.status;await reply.body?.cancel();
  }catch(reason){if(signal.aborted)throw reason;}
  const latest=checkedObservation(await api(grants+'/'+pathId(v.transfer_id),{signal}),artifact,v.transfer_id);
  if(latest.state==='available') return api(collection,{signal});
  if(latest.state==='ready_to_confirm'||latest.state==='verifying')return confirm(latest);
  throw new ApiFailure(0,status===403?'STAGING_GRANT_UNCONFIRMED':'UPLOAD_UNCONFIRMED');
}
