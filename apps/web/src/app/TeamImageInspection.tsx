import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Spin } from 'antd';
import { Link, useParams } from 'react-router';
import { TeamClient } from '../api/team';
import { ComputeClient } from '../api/compute-client';
import { pathId } from '../api/compute-contracts';
import type { UserSession } from '../api/contracts';
import { ImageOutputInspection } from './ImageOutputInspection';

export default function TeamImageInspection({session, invalidate}: {session: UserSession; invalidate: () => void}) {
  const {org = ''} = useParams();
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(org);
  const teams = useMemo(() => new TeamClient(), []);
  const api = useMemo(() => valid ? new ComputeClient(undefined, org, true) : undefined, [org, valid]);
  const membership = useQuery({queryKey:['team-image-membership',session.session_id,org], meta:{accessScope:'resource'}, enabled:valid, retry:false,
    queryFn:({signal}) => teams.organization(session, org, signal), refetchInterval:5000});
  if (valid && membership.isPending) return <Spin />;
  if (!api || !membership.isSuccess || membership.data.organization_id !== org || membership.data.role === 'billing') {
    return <Alert type="warning" title="当前身份无法读取团队内容" />;
  }
  return <>
    <p><Link to={'/organizations/'+pathId(org)}>{membership.data.name}</Link></p>
    <h1>团队图像校验</h1>
    <ImageOutputInspection key={session.session_id+':'+org} api={api} session={session} invalidate={invalidate}
      canUpload={membership.data.role!=='viewer'} sharingHref={membership.data.role==='viewer' ? undefined : resource=>'/organizations/'+pathId(org)+'/resources/'+pathId(resource)+'/sharing'} />
  </>;
}
