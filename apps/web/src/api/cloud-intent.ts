import type {UserSession} from './contracts';
import type {Upload} from './compute-contracts';
export interface CloudIntent {
  v:1;owner:string;user:string;session:string;key:string;budget:string;ttl:number;
  upload:Upload;prepared?:{artifact:string;version:string};
}
const id=/^[A-Za-z0-9_.:-]{1,128}$/;
export function cloudKey(s:UserSession){return 'orange.cloud-reservation:'+encodeURIComponent(s.session_id);}
export function readIntent(storage:Storage,s:UserSession):CloudIntent|undefined {
  const text=storage.getItem(cloudKey(s));if(text===null)return;
  const v:CloudIntent=JSON.parse(text);
  if(!v||v.v!==1||v.owner!==s.personal_owner_id||v.user!==s.user_id||v.session!==s.session_id||
      ![v.key,v.budget,v.upload?.upload_id].every(x=>typeof x==='string'&&id.test(x))||!Number.isInteger(v.ttl)||v.ttl<60||v.ttl>3600||
      v.upload.media_type!=='text/plain'||!/^[0-9a-f]{64}$/.test(v.upload.sha256)||!/^[1-9][0-9]{0,5}$/.test(v.upload.size_bytes)||Number(v.upload.size_bytes)>262144||
      (v.prepared&&(![v.prepared.artifact,v.prepared.version].every(x=>typeof x==='string'&&id.test(x)))))throw Error('INVALID_CLOUD_INTENT');
  return v;
}
