import {useEffect, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {ComputeClient} from '../api/compute-client';
import type {UserSession} from '../api/contracts';
import type {Artifact, ArtifactRetention} from '../api/compute-contracts';

const descriptions: Record<ArtifactRetention['basis'], string> = {
  staging:'从开始上传起保留 1 小时', published:'从发布输入起保留 24 小时',
  last_reference_released:'从最后一次释放引用起保留 24 小时', response_commit:'从提交交付结果起保留 24 小时',
  migration_grace:'从数据库升级起计算 24 小时过渡期', active_reference:'输入正在使用，释放最后一个引用后开始计时',
  deleted:'已逻辑删除',
};

export default function ArtifactRetentionDetails({api,session,artifact,label}: {
  api:ComputeClient;session:UserSession;artifact:Artifact;label:string
}){
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    const hide=()=>{if(document.hidden)setOpen(false);};
    document.addEventListener('visibilitychange',hide);
    return ()=>document.removeEventListener('visibilitychange',hide);
  },[]);
  const clock=useQuery({
    queryKey:[session.session_id,artifact.owner_id,artifact.upload_id,artifact.version_id,'retention'],
    queryFn:({signal})=>api.retention(session,artifact,signal),enabled:open,
    retry:false, gcTime:0, refetchInterval:open?10000:false, refetchIntervalInBackground:false,
  });
  const view=open&&!clock.isFetching&&!clock.error?clock.data:undefined;
  // The decoder bounds seconds to the JS Date range before rendering.
  const due=view?.due_unix ? new Date(Number(view.due_unix)*1000) : undefined;
  return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{label}</summary>
    {open&&(view?<div>
      <p>{descriptions[view.basis]}</p>
      {due&&<p>策略到期时间 <time dateTime={due.toISOString()}>{due.toLocaleString()}</time></p>}
    </div>:<p role="status">{clock.error?'暂时无法核对此版本的保留期限。':'正在核对保留期限…'}</p>)}
  </details>;
}
