import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, Input, Spin, Tag, Typography } from 'antd';
import { ApiFailure } from '../api/client';
import { ComputeClient, ContentUnavailable } from '../api/compute-client';
import { authorityKey, type UserSession } from '../api/contracts';
import { formatCredits } from '../api/accounts';
import { modelInput, pathId, type Job } from '../api/compute-contracts';
import { advanceComputeIntent, confirmComputeIntent, loadComputeIntent, newComputeIntent, saveComputeIntent, clearFinishedCreation, withdrawComputeIntent, OriginalInputRequired, type ComputeIntent, type VerifiedComputeQuote } from '../api/compute-intent';
const api = new ComputeClient();
const states: Record<Job['execution_state'], string> = { queued: '等待执行', running: '执行中', cancelling: '正在取消', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' };
const settlements: Record<Job['settlement_state'], string> = { pending: '结算待核对', settled: '已结算', reversed: '已冲正' };
function failureText(error: unknown): string {
  if (error instanceof OriginalInputRequired) return '原输入尚未上传完成，请重新输入完全相同的文本，再继续核对。';
  if (error instanceof Error && error.message === 'ORIGINAL_SUBMISSION_STILL_UNRESOLVED') return '停止意图已保留，但尚未查到原任务。请继续撤回核对，当前不会再发起提交。';
  if (error instanceof ContentUnavailable) return '当前无法读取此结果，输入可能已删除或内容权限已经变化。';
  if (error instanceof Error && ['INPUT_BYTES_CHANGED', 'ORIGINAL_INPUT_CHANGED'].includes(error.message)) return '文本与原请求不一致，尚未替换原输入。请重新输入原文本。';
  if (error instanceof ApiFailure && error.code === 'JOB_SUBMISSION_REJECTED') return '任务提交被拒绝，请核对余额、预算和报价有效期。原请求编号已保留。';
  return '请求尚未完成核对。请保留原请求，刷新或继续核对，避免重复创建任务。';
}
export default function ModelTasks({ session, invalidate }: { session: UserSession; invalidate: () => void }) {
  const scope = authorityKey(session), client = useQueryClient();
  const [intent, setIntent] = useState<ComputeIntent | null>(null);
  const [prepared, setPrepared] = useState<VerifiedComputeQuote | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState(''), [price, setPrice] = useState(''), [output, setOutput] = useState('32');
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<unknown>();
  const [needInput, setNeedInput] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [cursor, setCursor] = useState<string>(), [history, setHistory] = useState<(string | undefined)[]>([]);
  const alive = useRef(true), busy = useRef(false), inputBytes = useRef<Uint8Array | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    try { const value = loadComputeIntent(sessionStorage, session); setIntent(value); if (value?.job) setSelected(value.job.job_id); }
    catch { setRecoveryError(true); }
    setInitializing(false);
    return () => { alive.current = false; inputBytes.current = undefined; };
  }, [session.user_id, session.personal_owner_id]);
  const wallet = useQuery({ queryKey: [scope, 'wallet'], queryFn: ({ signal }) => api.wallet(session, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const prices = useQuery({ queryKey: [scope, 'text-prices'], queryFn: ({ signal }) => api.prices(signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const budgets = useQuery({ queryKey: [scope, 'model-budgets'], queryFn: ({ signal }) => api.budgets(session, undefined, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const jobs = useQuery({ queryKey: [scope, 'jobs', cursor ?? 'first'], queryFn: ({ signal }) => api.jobs(session, cursor, signal), refetchInterval: 5000, refetchIntervalInBackground: false });
  const current = useQuery({ queryKey: [scope, 'job', selected], queryFn: ({ signal }) => api.job(session, selected!, signal), enabled: Boolean(selected), refetchInterval: 3000, refetchIntervalInBackground: false });
  const result = useQuery({ queryKey: [scope, 'job-result', selected], enabled: current.data?.execution_state === 'succeeded' && !current.error,
    queryFn: async ({ signal }) => api.resultText(session, await api.result(session, selected!, signal), signal), refetchInterval: 10000, refetchIntervalInBackground: false });
  const offer = !prices.error ? prices.data?.find(row => row.price_version === price) : undefined;
  const activeBudgets = !budgets.error ? budgets.data?.data.filter(row => row.status === 'active') ?? [] : [];
  const count = /^[1-9][0-9]{0,3}$/.test(output) ? Number(output) : 0;
  const canPrepare = Boolean(offer && activeBudgets.some(row => row.root_budget_id === budget) && prompt.trim() && count > 0 && count <= Number(offer.output_limit));
  const selectedBudget = activeBudgets.find(row => row.root_budget_id === (intent?.budget ?? budget));
  const available = !wallet.error && wallet.data ? BigInt(wallet.data.gift) + BigInt(wallet.data.earned) + BigInt(wallet.data.purchased) : undefined;
  const maximum = prepared?.intent.quote ? BigInt(prepared.intent.quote.max_amount) : undefined;
  const affordable = maximum !== undefined && available !== undefined && selectedBudget !== undefined && maximum <= available && maximum <= BigInt(selectedBudget.limit) - BigInt(selectedBudget.spent) - BigInt(selectedBudget.reserved);
  const refresh = () => { void jobs.refetch(); void prices.refetch(); void budgets.refetch(); void wallet.refetch(); if (selected) { void current.refetch(); if (current.data?.execution_state === 'succeeded') void result.refetch(); } };
  const reconcile = async (approve = false) => {
    if (busy.current || initializing || recoveryError || (approve && !affordable)) return;
    busy.current = true; setPending(true); setFailure(undefined);
    try {
      let original = intent;
      if (!original) {
        if (!offer || !canPrepare) return;
        const fresh = await newComputeIntent(session, budget, offer, prompt, count);
        inputBytes.current = fresh.bytes; original = saveComputeIntent(sessionStorage, session, fresh.intent, true);
        if (alive.current) setIntent(original);
      }
      if (needInput && prompt) inputBytes.current = modelInput(original.invocation, original.price.model_version, prompt, original.output);
      const approval = approve && prepared ? confirmComputeIntent(session, prepared) : undefined;
      if (approve && !approval) throw new Error('QUOTE_REQUIRES_CURRENT_VERIFICATION');
      setPrepared(null);
      const progress = await advanceComputeIntent(api, sessionStorage, session, original, inputBytes.current, approval);
      if (!alive.current) return;
      setIntent(progress.intent); setNeedInput(false);
      if (progress.kind === 'quoted') setPrepared(progress.prepared);
      else { setSelected(progress.intent.job!.job_id); void client.invalidateQueries({ queryKey: [scope, 'jobs'] }); void budgets.refetch(); }
    } catch (error) {
      if (!alive.current) return;
      setFailure(error); setPrepared(null); setNeedInput(error instanceof OriginalInputRequired);
      try { const saved = loadComputeIntent(sessionStorage, session); setIntent(saved); if (saved?.job) setSelected(saved.job.job_id); } catch { setRecoveryError(true); }
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) invalidate();
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const cancel = async () => {
    if (!selected || busy.current) return;
    const job = selected; busy.current = true; setPending(true); setFailure(undefined);
    try {
      const storageKey = `orange-cancel-v1:${JSON.stringify([session.user_id, session.personal_owner_id, job])}`;
      let key = sessionStorage.getItem(storageKey); if (key === null) { key = crypto.randomUUID(); sessionStorage.setItem(storageKey, key); } pathId(key);
      const value = await api.cancel(session, job, key);
      if (!alive.current) return;
      client.setQueryData([scope, 'job', job], value); sessionStorage.removeItem(storageKey);
      void client.invalidateQueries({ queryKey: [scope, 'jobs'] }); void budgets.refetch();
    } catch (error) {
      if (!alive.current) return;
      setFailure(error); if (error instanceof ApiFailure && [401, 403].includes(error.status)) invalidate();
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const withdraw = async () => {
    if (!intent || busy.current || recoveryError) return;
    busy.current = true; setPending(true); setFailure(undefined); setPrepared(null);
    try {
      const next = await withdrawComputeIntent(api, sessionStorage, session, intent);
      if (!alive.current) return;
      setIntent(next); setNeedInput(false); inputBytes.current = undefined;
      if (next?.job) setSelected(next.job.job_id); else setPrompt('');
      void jobs.refetch(); void budgets.refetch(); void wallet.refetch();
    } catch (error) {
      if (!alive.current) return;
      setFailure(error); try { const saved = loadComputeIntent(sessionStorage, session); setIntent(saved); if (saved?.job) setSelected(saved.job.job_id); } catch { setRecoveryError(true); }
      if (error instanceof ApiFailure && [401,403].includes(error.status)) invalidate();
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const freshTask = () => {
    if (!intent || busy.current) return;
    try { clearFinishedCreation(sessionStorage, session, intent); setIntent(null); setPrepared(null); setPrompt(''); setNeedInput(false); inputBytes.current = undefined; setFailure(undefined); }
    catch (error) { setFailure(error); }
  };
  const visibleJob = !current.error ? current.data : undefined;
  const showText = !result.error && !result.isFetching && visibleJob?.execution_state === 'succeeded' ? result.data : undefined;
  return <>
    <div className="page-heading"><div><p className="eyebrow">MODEL TASKS</p><h1>模型任务</h1><p>使用可用算力执行文本推理，提交前核对最大预留。</p></div><Button onClick={refresh}>刷新任务</Button></div>
    {recoveryError && <Alert type="error" showIcon title="本地恢复记录无法核对" description="创建入口已关闭，你仍可在任务列表中查询现有任务。" />}
    {Boolean(failure) && <Alert type="warning" showIcon title="操作待核对" description={failureText(failure)} />}
    <div className="model-layout"><section><Card><h2>{intent ? '原任务请求' : '创建文本任务'}</h2>
      {initializing ? <Spin /> : <>
        {(prices.error || budgets.error) && <Alert type="warning" showIcon title="暂时无法读取可用模型或预算" />}
        {!intent && !prices.error && !prices.isPending && prices.data?.length === 0 && <Empty description="暂无可用模型节点" />}
        {!intent && !budgets.error && !budgets.isPending && activeBudgets.length === 0 && <p>先在<Link to="/account">积分与预算</Link>页面创建个人预算。</p>}
        {intent && <Alert type="info" showIcon title="保留原请求编号" description="继续会先只读查找原任务，恢复过程不会自动换键或重新运行模型。" />}
        <Form layout="vertical" onFinish={() => { void reconcile(); }}>
          {!intent && <div className="model-fields"><Form.Item label="个人预算" required><select aria-label="个人预算" value={budget} disabled={pending || recoveryError} onChange={event => setBudget(event.target.value)}><option value="">选择预算</option>{activeBudgets.map(row => <option key={row.root_budget_id} value={row.root_budget_id}>{row.root_budget_id.slice(0, 8)} · 可用 {formatCredits(BigInt(row.limit) - BigInt(row.spent) - BigInt(row.reserved))} 积分</option>)}</select></Form.Item>
            <Form.Item label="可用模型" required><select aria-label="可用模型" value={price} disabled={pending || recoveryError} onChange={event => { setPrice(event.target.value); setOutput('32'); }}><option value="">选择模型节点</option>{(!prices.error ? prices.data : [])?.map(row => <option key={row.price_version} value={row.price_version}>{row.model_version} · 节点 {row.node_id.slice(0, 8)}</option>)}</select></Form.Item>
            <Form.Item label="输出计费上限" required extra={offer ? `当前模型最多 ${offer.output_limit} 单位` : undefined}><Input aria-label="输出计费上限" inputMode="numeric" value={output} maxLength={4} disabled={pending || recoveryError} onChange={event => setOutput(event.target.value)} /></Form.Item></div>}
          <Form.Item label={needInput ? '重新输入原文本' : '任务文本'} required={!intent || needInput}><Input.TextArea aria-label="任务文本" value={prompt} rows={6} maxLength={16000} disabled={pending || recoveryError || Boolean(intent && !needInput)} onChange={event => setPrompt(event.target.value)} placeholder={intent ? '提示词不会写入浏览器恢复记录。' : '输入希望模型处理的文本'} /></Form.Item>
          <p className="muted">确认提交后，输入将发送给所选算力节点进行推理。本页不执行模型返回的工具调用。</p>
          <Button htmlType="submit" aria-label={intent ? '核对原任务' : '获取报价'} aria-busy={pending} loading={pending} disabled={recoveryError || Boolean(intent?.withdrawn) || (!intent && !canPrepare)}>{intent ? '核对原任务' : '获取报价'}</Button>
          {intent && <Button danger disabled={pending || recoveryError} onClick={() => { void withdraw(); }}>{intent.withdrawn ? '继续撤回核对' : intent.confirmed ? '停止原请求' : '删除未提交输入'}</Button>}
        </Form>
        {prepared && <Card className="quote-card"><p>本次最大预留</p><strong data-testid="quote-maximum">{formatCredits(prepared.intent.quote!.max_amount)} 积分</strong><p>报价编号 {prepared.intent.quote!.quote_id.slice(0, 8)} · 输出上限 {prepared.intent.output}</p><p className="muted">有效期和可用余额由服务端在提交时检查，实际费用按交付结果结算。</p>{!affordable && <Alert type="warning" title="当前余额或预算不足，或额度尚未读取" description="可以删除未提交输入后重新选择预算，创建预算不会增加余额。" />}<Button type="primary" aria-label="确认并提交原请求" aria-busy={pending} loading={pending} disabled={!affordable || Boolean(intent?.withdrawn)} onClick={() => { void reconcile(true); }}>确认并提交原请求</Button></Card>}
        {intent?.job && <div className="model-request-foot"><Typography.Text copyable={{ text: intent.job.job_id }}>任务 {intent.job.job_id.slice(0, 8)}</Typography.Text><Button disabled={pending || (!intent.bound && intent.job.execution_state === 'queued')} onClick={freshTask}>开始另一任务</Button></div>}
      </>}
    </Card>
      {selected && <Card className="model-result"><div className="organization-top"><h2>任务结果</h2>{visibleJob && <Tag>{states[visibleJob.execution_state]}</Tag>}</div>
        {current.error ? <Alert type="warning" title="暂时无法读取任务" /> : !visibleJob ? <Spin /> : <><Typography.Text copyable={{ text: visibleJob.job_id }}>任务 {visibleJob.job_id}</Typography.Text><p>原预留上限 {formatCredits(visibleJob.reserved)} 积分 · {settlements[visibleJob.settlement_state]}{visibleJob.charge !== null ? ` · 已记费用 ${formatCredits(visibleJob.charge)} 积分` : ''}</p>
          {['queued', 'running'].includes(visibleJob.execution_state) && <Button danger loading={pending} onClick={() => { void cancel(); }}>取消任务</Button>}
          {visibleJob.execution_state === 'cancelling' && <p>取消请求已接收，执行终止和积分释放仍待确认。</p>}
          {result.error && <Alert type="warning" showIcon title="结果暂不可读" description={failureText(result.error)} />}
          {result.isFetching && <Spin aria-label="正在核对结果权限" />}
          {showText !== undefined && <pre data-testid="model-result-text">{showText}</pre>}
        </>}
      </Card>}
    </section><aside><Card><h2>我的任务</h2>{jobs.error ? <Alert type="warning" title="任务列表暂不可用" /> : jobs.isPending ? <Spin /> : jobs.data && <>
      {!jobs.data.data.length ? <Empty description="还没有模型任务" /> : <ul className="task-list">{jobs.data.data.map(row => <li key={row.job_id}><button onClick={() => setSelected(row.job_id)} aria-label={`查看任务 ${row.job_id}`}><strong>{row.job_id.slice(0, 8)}</strong><span>{states[row.execution_state]} · {settlements[row.settlement_state]}</span></button></li>)}</ul>}
      <div className="pagination"><Button disabled={!history.length || jobs.isFetching} onClick={() => { const next = [...history]; setCursor(next.pop()); setHistory(next); }}>上一页</Button><Button disabled={!jobs.data.next_cursor || jobs.isFetching} onClick={() => { setHistory([...history, cursor]); setCursor(jobs.data?.next_cursor ?? undefined); }}>下一页</Button></div>
    </>}</Card></aside></div>
  </>;
}
