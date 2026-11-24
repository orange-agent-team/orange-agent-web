import {useEffect,useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Input,Spin} from 'antd';
import {Link,useParams} from 'react-router';
import {TeamClient,type SharingChange,type SharedAccess} from '../api/team';
import type {UserSession} from '../api/contracts';
import {ApiFailure} from '../api/client';
import {pathId} from '../api/compute-contracts';

type Props = {session:UserSession; invalidate:()=>void};
type Intent = {key:string; body:SharingChange};

export default function ResourceSharing(props:Props) {
  const {org='', resource=''} = useParams();
  const id=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  if (!id.test(org) || !id.test(resource)) return <Alert type="warning" title="资源地址无效" />;
  return <SharingForm key={JSON.stringify([props.session.session_id,org,resource])} {...props} org={org} resource={resource} />;
}

function SharingForm({session,invalidate,org,resource}:Props & {org:string;resource:string}) {
  const api=useMemo(()=>new TeamClient(),[]);
  const [user,setUser]=useState('');
  const [access,setAccess]=useState<SharedAccess|'revoke'>('read');
  const [pending,setPending]=useState(false);
  const [uncertain,setUncertain]=useState<Intent>();
  const [error,setError]=useState('');
  const query=useQuery({queryKey:['resource-sharing',session.session_id,org,resource],meta:{accessScope:'resource'},
    queryFn:({signal})=>api.sharing(session,org,resource,signal),retry:false,refetchInterval:5000});
  useEffect(()=>{
    if(query.error instanceof ApiFailure && query.error.status===401) invalidate();
  },[query.error,invalidate]);
  const current=query.isSuccess ? query.data : undefined;
  const target=user.trim();
  const next=access==='revoke' ? null : access;
  const existing=current?.data.find(row=>row.user_id===target)?.access ?? null;
  const allowed=Boolean(current && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target) && existing!==next);
  async function submit() {
    if (!current || pending || (!uncertain && !allowed)) return;
    const operation=uncertain ?? {key:crypto.randomUUID(),body:{user_id:target,access:next,expected_acl_version:current.acl_version}};
    setPending(true);setError('');
    try {
      await api.changeSharing(session,org,resource,operation.key,operation.body);
      setUncertain(undefined);
      setUser('');
      await query.refetch();
    } catch(reason) {
      if(reason instanceof ApiFailure && reason.status===401) { invalidate();return; }
      if(reason instanceof ApiFailure && reason.status>=400 && reason.status<500) {
        setUncertain(undefined);setError('权限更改未生效，请核对最新权限后重试。');await query.refetch();
      } else {
        setUncertain(operation);setError('尚未收到更改回执，可以重试同一次请求。');
      }
    } finally { setPending(false); }
  }
  return <>
    <Link to={'/organizations/'+pathId(org)+'/images'}>返回团队图像</Link>
    <h1>资源共享权限</h1>
    {query.isPending ? <Spin/> : !current ? <Alert type="warning" title="当前身份无法管理此资源的共享权限"/> :
      <Card><p>资源 ID <code>{resource}</code></p>
        <ul aria-label="当前授权">{current.data.map(row=><li key={row.user_id}>{row.user_id} · {row.access==='read'?'读取':'读写'}</li>)}</ul>
        <form onSubmit={event=>{event.preventDefault();void submit();}}>
          <label>成员用户 ID<Input value={user} maxLength={128} disabled={pending||Boolean(uncertain)}
            onChange={event=>{setUser(event.target.value);setError('');}} /></label>
          <label>权限<select value={access} disabled={pending||Boolean(uncertain)} onChange={event=>setAccess(event.target.value as typeof access)}>
            <option value="read">读取</option><option value="write">读写</option><option value="revoke">撤销授权</option>
          </select></label>
          <Button type="primary" htmlType="submit" loading={pending} disabled={!uncertain && !allowed}>{uncertain?'重试同一次更改':'保存权限'}</Button>
        </form>
        {error && <Alert type="warning" title={error}/>}
      </Card>}
  </>;
}
