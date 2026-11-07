import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, Link, NavLink } from 'react-router';
import { QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, ConfigProvider, Empty, Form, Input, Spin, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { UserClient, ApiFailure } from '../api/client';
import { authorityKey, type UserSession, type Organization, type CreateOrganization, type TeamRole } from '../api/contracts';
const api = new UserClient();
const Account = lazy(() => import('./Account'));
const roles: Record<TeamRole, string> = { owner: '所有者', admin: '管理员', member: '成员', billing: '账务', viewer: '只读成员' };
export default function Portal({ session, invalidate, logout }: { session: UserSession; invalidate: () => void; logout: () => void }) {
  const invalidateRef = useRef(invalidate); invalidateRef.current = invalidate;
  const client = useMemo(() => new QueryClient({
    queryCache: new QueryCache({ onError: failure => { if (failure instanceof ApiFailure && [401, 403].includes(failure.status)) invalidateRef.current(); } }),
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 }, mutations: { retry: false } },
  }), []);
  useEffect(() => () => { void client.cancelQueries(); client.clear(); }, [client]);
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#bb481d', borderRadius: 10, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }}><QueryClientProvider client={client}>
    <div className="portal"><header className="portal-header"><Link to="/organizations" className="brand"><span className="brand-mark">o</span>orange</Link>
      <nav aria-label="用户导航"><NavLink to="/organizations">组织空间</NavLink><NavLink to="/account">积分与预算</NavLink></nav><div className="account"><span className="account-dot" />用户身份已验证<Button aria-label="退出" onClick={logout}>退出</Button></div></header>
      <main className="portal-main"><Routes><Route path="/organizations" element={<Organizations session={session} invalidate={invalidate} />} /><Route path="/account" element={<Suspense fallback={<Spin />}><Account session={session} invalidate={invalidate} /></Suspense>} /><Route path="*" element={<Navigate to="/organizations" replace />} /></Routes></main>
      <footer className="portal-footer"><span>个人空间 · {session.personal_owner_id.slice(0, 8)}</span><span>组织成员身份不授予平台管理权限</span></footer>
    </div>
  </QueryClientProvider></ConfigProvider>;
}
function Organizations({ session, invalidate }: { session: UserSession; invalidate: () => void }) {
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [created, setCreated] = useState<Organization | null>(null);
  const intent = useRef<{ key: string; body: CreateOrganization } | null>(null);
  const query = useQuery({ queryKey: [authorityKey(session), 'organizations', cursor ?? 'first'], queryFn: ({ signal }) => api.organizations(session, cursor, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const create = async () => {
    if (pending) return;
    if (!intent.current) {
      const clean = name.trim(); if (!clean || clean.length > 100) return;
      intent.current = { key: crypto.randomUUID(), body: { name: clean, member_limit: 20 } };
    }
    setPending(true); setFailure(undefined); setCreated(null);
    try {
      const result = await api.createOrganization(session, intent.current.key, intent.current.body);
      setCreated(result); setName(''); intent.current = null; setUncertain(false); setCursor(undefined); setHistory([]);
      await query.refetch();
    } catch (error) {
      setFailure(error);
      const unknown = !(error instanceof ApiFailure) || error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300);
      setUncertain(unknown);
      if (!unknown) intent.current = null;
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) invalidate();
    } finally { setPending(false); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">ORGANIZATIONS</p><h1>你的组织</h1><p>查看当前成员身份，或为团队创建一个新的空间。</p></div><Button onClick={() => { void query.refetch(); }}>刷新组织</Button></div>
    {query.error && <Alert type="warning" showIcon title="暂时无法读取组织，请刷新后重试。" />}
    <div className="organization-layout"><section aria-label="组织列表">
      {query.isPending ? <div className="panel-loading"><Spin /></div> : query.data && <>
        {query.data.data.length === 0 ? <Card><Empty description="你还没有加入组织" /></Card> : <div className="organization-grid">{query.data.data.map(organization => <Card key={organization.organization_id} className="organization-card">
          <div className="organization-top"><span className="organization-symbol" aria-hidden>{Array.from(organization.name)[0]}</span><Tag color={organization.role === 'owner' ? 'orange' : 'default'}>{roles[organization.role]}</Tag></div>
          <h2>{organization.name}</h2><p className="muted">成员上限 {organization.member_limit} 人</p><Typography.Text type="secondary" copyable={{ text: organization.organization_id }}>组织 {organization.organization_id.slice(0, 8)}</Typography.Text>
        </Card>)}</div>}
        <div className="pagination"><Button disabled={!history.length || query.isFetching} onClick={() => { const next = [...history]; setCursor(next.pop()); setHistory(next); }}>上一页</Button><span className="muted">本页 {query.data.data.length} 个组织</span>
          <Button disabled={!query.data.next_cursor || query.isFetching} onClick={() => { setHistory([...history, cursor]); setCursor(query.data?.next_cursor); }}>下一页</Button></div>
      </>}
    </section><aside><Card className="create-card"><p className="eyebrow">NEW SPACE</p><h2>创建组织</h2><p>创建后，你将成为组织所有者。内容共享需要另外授权。</p>
      {created && <Alert data-testid="created-result" type="success" showIcon title={`已创建：${created.name}`} />}
      {Boolean(failure) && <Alert type="warning" showIcon title={uncertain ? '创建结果尚未确认' : '创建请求未完成'} description={uncertain ? '重试会核对同一次创建，不会发起新的组织申请。' : '请检查输入或重新验证当前身份。'} />}
      <Form layout="vertical" onFinish={() => { void create(); }}><Form.Item label="组织名称" required><Input aria-label="组织名称" value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={pending || uncertain} placeholder="例如：研发协作组" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={pending} disabled={!name.trim() && !uncertain}>{uncertain ? '重试本次创建' : '创建组织'}</Button></Form>
      <p className="create-note">初始成员上限 20 人。创建组织不会充值或产生模型消费。</p>
    </Card><div className="sharing-note"><span>明确的共享边界</span><p>组织角色不自动开放成员的私有内容。资源共享由相应内容权限决定。</p></div></aside></div>
  </>;
}
