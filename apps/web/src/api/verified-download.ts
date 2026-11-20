import {ApiFailure} from './client';
export async function verifiedDownload(fetcher:typeof fetch,url:string,headers:HeadersInit,declaredSize:string,sha256:string,signal:AbortSignal):Promise<Blob>{
    if(!url.startsWith('/api/v1/agent/runs/')||url.includes('://')||url.includes('\\')||!/^[0-9a-f]{64}$/.test(sha256))throw new ApiFailure(400,'INVALID_DOWNLOAD');
    const size=Number(declaredSize);
    if(!/^(0|[1-9][0-9]*)$/.test(declaredSize)||!Number.isSafeInteger(size)||size>20*1024*1024)throw new ApiFailure(413,'OBJECT_TOO_LARGE');
    const res=await fetcher(url,{method:'POST',headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if(res.status!==200)throw new ApiFailure(res.status,'DOWNLOAD_DENIED');
    if(!res.body||res.headers.get('Content-Type')!=='application/octet-stream')throw new ApiFailure(200,'INVALID_RESPONSE');
    const reader=res.body.getReader(), data=new Uint8Array(size);
    let offset=0;
    try{
      for(;;){
        const part=await reader.read();
        if(part.done)break;
        if(part.value.byteLength>size-offset)throw new ApiFailure(200,'BYTE_COUNT_MISMATCH');
        data.set(part.value,offset);offset+=part.value.byteLength;
      }
    }finally{await reader.cancel();reader.releaseLock();}
    const digest=await crypto.subtle.digest('SHA-256',data);
    if(offset!==size||Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')!==sha256)throw new ApiFailure(200,'CONTENT_INTEGRITY');
    return new Blob([data],{type:'application/octet-stream'});
}
