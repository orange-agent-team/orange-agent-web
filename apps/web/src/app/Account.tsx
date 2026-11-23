import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, Input, Spin, Tag, Typography } from 'antd';
import { UserClient, ApiFailure } from '../api/client';
import { authorityKey, type UserSession } from '../api/contracts';
import { formatCredits, parseCredits, type Budget } from '../api/accounts';
import { intentKey, loadIntent, saveIntent, type BudgetIntent } from '../api/budget-intent';
import TestCheckout from './TestCheckout';
import {Link} from 'react-router';
import PersonalAutomationKeys from './PersonalAutomationKeys';
import ProviderIncomeHistory from './ProviderIncomeHistory';
const api = new UserClient();
const labels = { active: '可用', closing: '正在关闭', closed: '已关闭' };
export default function Account({ session, invalidate }: { session: UserSession; invalidate: () => void }) {
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [amount, setAmount] = useState('');
  const [intent, setIntent] = useState<BudgetIntent | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [loadingIntent, setLoadingIntent] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const [created, setCreated] = useState<Budget | null>(null);
  const busy = useRef(false), alive = useRef(true);
  const client = useQueryClient();
  useEffect(() => {
    alive.current = true;
    try { const saved = loadIntent(sessionStorage, session); setIntent(saved); if (saved) setAmount(formatCredits(saved.body.limit)); }
    catch { setStorageError(true); }
    setLoadingIntent(false);
    return () => { alive.current = false; };
  }, [session.user_id, session.personal_owner_id]);
  const wallet = useQuery({ queryKey: [authorityKey(session), 'wallet'], queryFn: ({ signal }) => api.wallet(session, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const budgets = useQuery({ queryKey: [authorityKey(session), 'budgets', cursor ?? 'first'], queryFn: ({ signal }) => api.budgets(session, cursor, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const create = async () => {
    if (busy.current || storageError || loadingIntent) return;
    busy.current = true; setPending(true); setFailure(false); setCreated(null);
    let original = intent;
    try {
      if (!original) {
        const limit = parseCredits(amount); if (limit === undefined) return;
        original = { version: 1, user: session.user_id, owner: session.personal_owner_id, key: crypto.randomUUID(), body: { scope_id: crypto.randomUUID(), limit } };
        try { saveIntent(sessionStorage, session, original); } catch { setStorageError(true); return; }
        setIntent(original);
      }
      const result = await api.createBudget(session, original.key, original.body);
      if (!alive.current) return;
      setCreated(result);
      try { sessionStorage.removeItem(intentKey(session)); } catch { setStorageError(true); return; }
      setIntent(null); setAmount(''); setCursor(undefined); setHistory([]);
      await client.invalidateQueries({ queryKey: [authorityKey(session), 'budgets'] });
    } catch (error) {
      if (!alive.current) return;
      setFailure(true);
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) invalidate();
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const current = !wallet.error ? wallet.data : undefined;
  return <>
    <div className="page-heading"><div><p className="eyebrow">PERSONAL ACCOUNT</p><h1>积分与预算</h1><p>查看个人积分，并为模型任务设置消费上限。</p></div><Button onClick={() => { void wallet.refetch(); void budgets.refetch(); }}>刷新账户</Button></div>
    {wallet.error && <Alert type="warning" showIcon title="暂时无法读取余额" description="请刷新后核对，页面不会使用旧数据确认可消费金额。" />}
    {wallet.isPending && <Spin aria-label="正在读取余额" />}
    {current && <div className="account-summary">
      <Card><p>可用积分</p><strong data-testid="available-credits">{formatCredits(BigInt(current.gift) + BigInt(current.earned) + BigInt(current.purchased))}</strong><p className="muted">赠送 {formatCredits(current.gift)} · 收益 {formatCredits(current.earned)} · 购买 {formatCredits(current.purchased)}</p></Card>
      <Card><p>任务预留</p><strong>{formatCredits(BigInt(current.reserved_gift) + BigInt(current.reserved_earned) + BigInt(current.reserved_purchased))}</strong><p className="muted">等待原任务按实际结果结算。</p></Card>
      <Card><p>待确认收益</p><strong>{formatCredits(current.pending_earned)}</strong><p className="muted">暂不计入可用积分。</p></Card>
    </div>}
    <div className="organization-layout"><section aria-label="个人预算列表">
      <h2>个人预算</h2>
      {budgets.error ? <Alert type="warning" showIcon title="暂时无法读取预算" /> : budgets.isPending ? <Spin /> : budgets.data && <>
        {!budgets.data.data.length ? <Card><Empty description="还没有个人预算" /></Card> : <div className="budget-list">{budgets.data.data.map(budget => <Card key={budget.root_budget_id}>
          <div className="organization-top"><Typography.Text copyable={{ text: budget.root_budget_id }}>预算 {budget.root_budget_id.slice(0, 8)}</Typography.Text><Tag>{labels[budget.status]}</Tag></div>
          <div className="budget-values"><span>上限 <b>{formatCredits(budget.limit)}</b></span><span>已消费 <b>{formatCredits(budget.spent)}</b></span><span>已预留 <b>{formatCredits(budget.reserved)}</b></span></div>
        </Card>)}</div>}
        <div className="pagination"><Button disabled={!history.length || budgets.isFetching} onClick={() => { const next = [...history]; setCursor(next.pop()); setHistory(next); }}>上一页</Button><span>本页 {budgets.data.data.length} 项</span><Button disabled={!budgets.data.next_cursor || budgets.isFetching} onClick={() => { setHistory([...history, cursor]); setCursor(budgets.data?.next_cursor ?? undefined); }}>下一页</Button></div>
      </>}
    </section><aside><Card><h2>创建个人预算</h2><p>预算规定消费上限，不会充值或立即预留积分。</p>
      {created && <Alert data-testid="budget-created" type="success" showIcon title="预算已创建" description={`上限 ${formatCredits(created.limit)} 积分`} />}
      {storageError && <Alert type="error" showIcon title="无法保存或核对本次请求" description="请检查浏览器会话存储，并先在预算列表中核对已有记录。创建入口暂不可用。" />}
      {intent && !created && <Alert type="info" showIcon title="有一项创建请求待核对" description="继续会使用原上限和请求编号，不会另起一项创建。" />}
      {failure && <Alert type="warning" showIcon title="本次创建尚未确认" description="请稍后继续同一次创建，或在列表中核对现有预算。" />}
      <Form layout="vertical" onFinish={() => { void create(); }}><Form.Item label="预算上限（积分）" required extra="最多六位小数。创建预算不会改变余额。"><Input aria-label="预算上限（积分）" inputMode="decimal" maxLength={32} value={amount} disabled={pending || Boolean(intent) || loadingIntent || storageError} onChange={event => setAmount(event.target.value)} placeholder="例如：10.5" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={pending || loadingIntent} disabled={storageError || (!intent && parseCredits(amount) === undefined)}>{intent ? '继续本次创建' : '创建预算'}</Button>
      </Form>
    </Card></aside></div>
    <p><Link to="/devices">管理个人设备注册</Link></p>
    <PersonalAutomationKeys key={"api-keys:"+authorityKey(session)} session={session}/>
    <ProviderIncomeHistory key={authorityKey(session)} session={session}/>
    <TestCheckout key={session.user_id+session.personal_owner_id} session={session} onCredit={()=>void wallet.refetch()}/>
  </>;
}
