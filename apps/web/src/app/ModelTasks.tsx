import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, Input, Spin, Tag, Typography } from 'antd';
import { ApiFailure } from '../api/client';
import { ComputeClient, ContentUnavailable } from '../api/compute-client';
import { authorityKey, type UserSession } from '../api/contracts';
import { formatCredits } from '../api/accounts';
import { modelInput, pathId, sha256, type Job } from '../api/compute-contracts';
import { advanceComputeIntent, confirmComputeIntent, loadComputeIntent, newComputeIntent, saveComputeIntent, clearFinishedCreation, withdrawComputeIntent, OriginalInputRequired, type ComputeIntent, type VerifiedComputeQuote } from '../api/compute-intent';
import TaskDocument from './TaskDocument';
import {FundingDetails,useQuoteFunding} from './QuoteFunding';
import {projectText,type TransferMode} from '../api/text-transfer';
import type { Budget as MemberBudget } from '../api/team';
import type { ComputeSession } from '../api/compute-intent';
const states: Record<Job['execution_state'], string> = { queued: '等待执行', running: '执行中', cancelling: '正在取消', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' };
const settlements: Record<Job['settlement_state'], string> = { pending: '结算待核对', settled: '已结算', reversed: '已冲正' };
function failureText(error: unknown): string {
  if (error instanceof OriginalInputRequired) return '原输入尚未上传完成，请重新输入完全相同的文本，再继续核对。';
  if (error instanceof Error && error.message === 'ORIGINAL_SUBMISSION_STILL_UNRESOLVED') return '停止意图已保留，但尚未查到原任务。请继续撤回核对，当前不会再发起提交。';
  if (error instanceof ContentUnavailable) return '当前无法读取此结果，输入可能已删除或内容权限已经变化。';
  if (error instanceof Error && ['INPUT_BYTES_CHANGED', 'ORIGINAL_INPUT_CHANGED'].includes(error.message)) return '文本与原请求不一致，尚未替换原输入。请重新输入原文本。';
  if (error instanceof ApiFailure && error.code === 'SPENDING_PAUSED') return '账户支付争议正在核对，平台已拒绝本次付费任务，未新增预留。';
  if (error instanceof ApiFailure && error.code === 'JOB_SUBMISSION_REJECTED') return '任务提交被拒绝，请核对余额、预算和报价有效期。原请求编号已保留。';
  return '请求尚未完成核对。请保留原请求，刷新或继续核对，避免重复创建任务。';
}
export default function ModelTasks({ session: identity, invalidate, teamBudget }: {
  session: UserSession; invalidate: () => void; teamBudget?: MemberBudget
}) {
  const team = teamBudget?.organization_id;
  const fixedBudget = teamBudget?.root_budget_id;
  const session: ComputeSession = useMemo(() => team && fixedBudget
    ? {...identity, allocation: {owner:team, budget:fixedBudget}} : identity, [identity, team, fixedBudget]);
  const api = useMemo(() => new ComputeClient(undefined, team), [team]);
  const scope = team ? JSON.stringify([authorityKey(identity),team,fixedBudget]) : authorityKey(identity);
  const client = useQueryClient();
  const accountLabel = team ? '团队预算' : '个人预算';
  const [intent, setIntent] = useState<ComputeIntent | null>(null);
  const [prepared, setPrepared] = useState<VerifiedComputeQuote | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [mode,setMode]=useState<TransferMode>('local');
  const [terms,setTerms]=useState('');
  const [previewError,setPreviewError]=useState('');
  const [draft,setDraft]=useState<{intent:ComputeIntent;bytes:Uint8Array;count:number}>();
  const previewRevision=useRef(0);
  function clearPreview(){previewRevision.current++;setDraft(undefined);setPreviewError('');}
  function resetPrivacy(){clearPreview();setMode('local');setTerms('');setPrompt('');}

  const [budget, setBudget] = useState(fixedBudget ?? ''), [price, setPrice] = useState(''), [output, setOutput] = useState('32');
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
  }, [scope]);
  const prices = useQuery({ queryKey: [scope, 'text-prices'], queryFn: ({ signal }) => api.prices(signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const budgets = useQuery({ queryKey: [scope, 'model-budgets'], enabled: !team, queryFn: ({ signal }) => api.budgets(session, undefined, signal), refetchInterval: 15000, refetchIntervalInBackground: false });
  const jobs = useQuery({ queryKey: [scope, 'jobs', cursor ?? 'first'], enabled: !team, queryFn: ({ signal }) => api.jobs(session, cursor, signal), refetchInterval: 5000, refetchIntervalInBackground: false });
  const current = useQuery({ queryKey: [scope, 'job', selected], queryFn: ({ signal }) => api.job(session, selected!, signal), enabled: !team && Boolean(selected), refetchInterval: 3000, refetchIntervalInBackground: false });
  const result = useQuery({ queryKey: [scope, 'job-result', selected], enabled: !team && current.data?.execution_state === 'succeeded' && !current.error,
    queryFn: async ({ signal }) => api.resultDocument(session, await api.result(session, selected!, signal), signal), refetchInterval: 10000, refetchIntervalInBackground: false });
  const offer = !prices.error ? prices.data?.find(row => row.price_version === price) : undefined;
  const activeBudgets = teamBudget ? [teamBudget] : !budgets.error ? budgets.data?.data.filter(row => row.status === 'active') ?? [] : [];
  const count = /^[1-9][0-9]{0,3}$/.test(output) ? Number(output) : 0;
  const canPrepare = Boolean(offer && activeBudgets.some(row => row.root_budget_id === budget) && prompt.trim() && count > 0 && count <= Number(offer.output_limit));
  const funding=useQuoteFunding(api,session,prepared?.intent.quote);
  const expiryMillis=prepared?.intent.quote?Number(prepared.intent.quote.expires_at_unix)*1000:NaN;
  const expiry=new Date(expiryMillis);
  const hasExpiry=Number.isFinite(expiry.getTime());
  const affordable = hasExpiry && !funding.error && !funding.isFetching && funding.data?.status==='sufficient'
    && BigInt(funding.data.expires_unix)*1000n>BigInt(Date.now());
  const needsTransfer=!intent || needInput;
  const draftCurrent=!!draft && mode!=='local' && draft.intent.user===session.user_id &&
    draft.intent.owner===api.owner(session) && (intent ? draft.intent.invocation===intent.invocation :
      draft.intent.budget===budget && draft.intent.output===count && draft.intent.price.price_version===offer?.price_version);
  async function previewTransfer(){
    if(busy.current || mode==='local' || (!intent && (!offer || !canPrepare)))return;
    const revision=++previewRevision.current;
    setDraft(undefined);setPreviewError('');
    try{
      const projected=projectText(prompt,mode,terms);
      const next=intent ? {intent,bytes:modelInput(intent.invocation,intent.price.model_version,projected.text,intent.output)} :
        await newComputeIntent(session,budget,offer!,projected.text,count);
      if(intent && (next.bytes.length.toString()!==intent.upload.size_bytes || await sha256(next.bytes)!==intent.upload.sha256))throw Error('ORIGINAL_MISMATCH');
      if(alive.current && revision===previewRevision.current)setDraft({...next,count:projected.replacements});
    }catch(err){
      if(alive.current && revision===previewRevision.current)setPreviewError(err instanceof Error && err.message==='ORIGINAL_MISMATCH'?
        '当前文本与原请求的摘要不一致，请核对原文本和遮盖规则。':'请核对输入大小、字符编码和遮盖规则（1 至 32 项，每项最多 256 个字符）。');
    }
  }
  const refreshBudget = () => {
    if(team) void client.invalidateQueries({queryKey:['team-model-budget',session.session_id,team,fixedBudget]});
    else void budgets.refetch();
  };
  const refresh = () => { if(!team) void jobs.refetch(); void prices.refetch(); refreshBudget(); if(prepared)void funding.refetch(); if (!team && selected) { void current.refetch(); if (current.data?.execution_state === 'succeeded') void result.refetch(); } };
  const reconcile = async (approve = false) => {
    if (busy.current || initializing || recoveryError || (approve && !affordable)) return;
    busy.current = true; setPending(true); setFailure(undefined);
    try {
      let original = intent;
      if (needsTransfer) {
        if(!draftCurrent || !draft)return;
        inputBytes.current=draft.bytes;
        if(!original){
          original=saveComputeIntent(sessionStorage,session,draft.intent,true);
          if(alive.current)setIntent(original);
        }
        clearPreview();
      }
      if(!original)return;
      const approval = approve && prepared ? confirmComputeIntent(session, prepared) : undefined;
      if (approve && !approval) throw new Error('QUOTE_REQUIRES_CURRENT_VERIFICATION');
      setPrepared(null);
      const progress = await advanceComputeIntent(api, sessionStorage, session, original, inputBytes.current, approval);
      if (!alive.current) return;
      setIntent(progress.intent); setNeedInput(false);
      if (progress.kind === 'quoted') setPrepared(progress.prepared);
      else { setSelected(progress.intent.job!.job_id); void client.invalidateQueries({ queryKey: [scope, 'jobs'] }); refreshBudget(); }
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
      const storageKey = `orange-cancel-v1:${JSON.stringify([session.user_id, api.owner(session), job])}`;
      let key = sessionStorage.getItem(storageKey); if (key === null) { key = crypto.randomUUID(); sessionStorage.setItem(storageKey, key); } pathId(key);
      const value = await api.cancel(session, job, key);
      if (!alive.current) return;
      client.setQueryData([scope, 'job', job], value); sessionStorage.removeItem(storageKey);
      void client.invalidateQueries({ queryKey: [scope, 'jobs'] }); refreshBudget();
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
      if (next?.job) setSelected(next.job.job_id); else resetPrivacy();
      if(!team) void jobs.refetch(); refreshBudget(); if(prepared)void funding.refetch();
    } catch (error) {
      if (!alive.current) return;
      setFailure(error); try { const saved = loadComputeIntent(sessionStorage, session); setIntent(saved); if (saved?.job) setSelected(saved.job.job_id); } catch { setRecoveryError(true); }
      if (error instanceof ApiFailure && [401,403].includes(error.status)) invalidate();
    } finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const freshTask = () => {
    if (!intent || busy.current) return;
    try { clearFinishedCreation(sessionStorage, session, intent); setIntent(null); setPrepared(null); resetPrivacy(); setNeedInput(false); inputBytes.current = undefined; setFailure(undefined); }
    catch (error) { setFailure(error); }
  };
  const visibleJob = !current.error ? current.data : undefined;
  const verifiedDocument = !result.error && !result.isFetching && visibleJob?.execution_state === 'succeeded' ? result.data : undefined;
  return <>
    <div className="page-heading"><div><h1>{team ? '团队文本任务' : '模型任务'}</h1><p>使用可用算力执行文本推理，提交前核对最大预留。</p></div><div><Link to={team ? '/organizations/'+pathId(team)+'/tasks' : '/tasks/audio'}>{team ? '我的团队任务' : '音频预检'}</Link> <Button onClick={refresh}>刷新任务</Button></div></div>
    {recoveryError && <Alert type="error" showIcon title="本地恢复记录无法核对" description="创建入口已关闭，你仍可在任务列表中查询现有任务。" />}
    {Boolean(failure) && <Alert type="warning" showIcon title="操作待核对" description={failureText(failure)} />}
    <div className={team ? undefined : "model-layout"}><section><Card><h2>{intent ? '原任务请求' : '创建文本任务'}</h2>
      {initializing ? <Spin /> : <>
        {(prices.error || budgets.error) && <Alert type="warning" showIcon title="暂时无法读取可用模型或预算" />}
        {!intent && !prices.error && !prices.isPending && prices.data?.length === 0 && <Empty description="暂无可用模型节点" />}
        {!intent && !budgets.error && !budgets.isPending && activeBudgets.length === 0 && <p>先在<Link to="/account">积分与预算</Link>页面创建个人预算。</p>}
        {intent && <Alert type="info" showIcon title="保留原请求编号" description="继续会先只读查找原任务，恢复过程不会自动换键或重新运行模型。" />}
        <Form layout="vertical" onFinish={() => { if(!needsTransfer)void reconcile(); }}>
          {!intent && <div className="model-fields"><Form.Item label={accountLabel} required><select aria-label={accountLabel} value={budget} disabled={!!fixedBudget || pending || recoveryError} onChange={event => {clearPreview();setBudget(event.target.value);}}><option value="">选择预算</option>{activeBudgets.map(row => <option key={row.root_budget_id} value={row.root_budget_id}>{row.root_budget_id.slice(0, 8)} · 可用 {formatCredits(BigInt(row.limit) - BigInt(row.spent) - BigInt(row.reserved))} 积分</option>)}</select></Form.Item>
            <Form.Item label="可用模型" required><select aria-label="可用模型" value={price} disabled={pending || recoveryError} onChange={event => { clearPreview();setPrice(event.target.value); setOutput('32'); }}><option value="">选择模型节点</option>{(!prices.error ? prices.data : [])?.map(row => <option key={row.price_version} value={row.price_version}>{row.model_version} · 节点 {row.node_id.slice(0, 8)}</option>)}</select></Form.Item>
            <Form.Item label="输出计费上限" required extra={offer ? `当前模型最多 ${offer.output_limit} 单位` : undefined}><Input aria-label="输出计费上限" inputMode="numeric" value={output} maxLength={4} disabled={pending || recoveryError} onChange={event => {clearPreview();setOutput(event.target.value);}} /></Form.Item></div>}
          <Form.Item label={needInput ? '重新输入原文本' : '任务文本'} required={!intent || needInput}><Input.TextArea aria-label="任务文本" value={prompt} rows={6} maxLength={16000} disabled={pending || recoveryError || Boolean(intent && !needInput)} onChange={event => {clearPreview();setPrompt(event.target.value);}} placeholder={intent ? '提示词不会写入浏览器恢复记录。' : '输入希望模型处理的文本'} /></Form.Item>
          {needsTransfer && <>
            <Form.Item label="文本处理方式"><select aria-label="文本处理方式" value={mode} disabled={pending} onChange={e=>{clearPreview();setMode(e.target.value as TransferMode);}}>
              <option value="local">仅在浏览器编辑</option><option value="original">允许上传原文</option><option value="redacted">遮盖后允许上传</option>
            </select></Form.Item>
            {mode==='local'?<p>文本保留在此页面。离开后草稿会清除；离线推理可使用桌面端本地模型。</p>:<>
              {mode==='redacted'&&<Form.Item label="需遮盖的原文片段" extra="每行一项，按原字符匹配；请检查姓名、联系方式和上下文线索。">
                <Input.TextArea aria-label="需遮盖的原文片段" rows={3} maxLength={8224} value={terms} disabled={pending} onChange={e=>{clearPreview();setTerms(e.target.value);}}/>
              </Form.Item>}
              <p>批准上传后，平台收到下方预览中的字节并免费询价，本次最高预留为 0。确认提交模型任务后，所选执行节点可读取这些明文。遮盖后仍可能保留可识别信息。</p>
              <Button disabled={pending || (!intent && !canPrepare) || !prompt.trim()} onClick={()=>void previewTransfer()}>在本机生成上传预览</Button>
              {previewError&&<Alert type="warning" title={previewError}/>}
              {draftCurrent && draft && <section aria-label="上传内容预览"><p>模型 {draft.intent.price.model_version} · {accountLabel} {draft.intent.budget} · {draft.bytes.length} 字节{mode==='redacted'&&` · 已遮盖 ${draft.count} 处`}</p>
                <p>执行节点 {draft.intent.price.node_id} · 付款方 {draft.intent.owner}</p>
                <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{new TextDecoder().decode(draft.bytes)}</pre><p>SHA-256 <code>{draft.intent.upload.sha256}</code></p>
              </section>}
            </>}
          </>}
          <Button htmlType={needsTransfer?'button':'submit'} onClick={needsTransfer?()=>void reconcile():undefined} aria-label={needInput?'批准上传原请求的预览内容':intent?'核对原任务':'批准上传并获取报价'} aria-busy={pending} loading={pending} disabled={pending || recoveryError || Boolean(intent?.withdrawn) || (needsTransfer && !draftCurrent) || (!intent && !canPrepare)}>{needInput?'批准上传原请求的预览内容':intent?'核对原任务':'批准上传并获取报价'}</Button>
          {intent && <Button danger disabled={pending || recoveryError} onClick={() => { void withdraw(); }}>{intent.withdrawn ? '继续撤回核对' : intent.confirmed ? '停止原请求' : '删除未提交输入'}</Button>}
        </Form>
        {prepared && <Card className="quote-card"><FundingDetails query={funding}/><p>本次最大预留</p><strong data-testid="quote-maximum">{formatCredits(prepared.intent.quote!.max_amount)} 积分</strong><p>模型版本 {prepared.intent.price.model_version} · 报价编号 {prepared.intent.quote!.quote_id.slice(0, 8)} · 输出上限 {prepared.intent.output}</p><p>执行节点 <code>{prepared.intent.price.node_id}</code> · 价格版本 <code>{prepared.intent.price.price_version}</code></p><p>报价截止 {hasExpiry?<time dateTime={expiry.toISOString()}>{expiry.toLocaleString()}</time>:'待核对'}</p><p className="muted">有效期和可用余额由服务端在提交时检查，实际费用按交付结果结算。</p><Button type="primary" aria-label="确认并提交原请求" aria-busy={pending} loading={pending} disabled={!affordable || Boolean(intent?.withdrawn)} onClick={() => { void reconcile(true); }}>确认并提交原请求</Button></Card>}
        {intent?.job && <div className="model-request-foot"><Typography.Text copyable={{ text: intent.job.job_id }}>任务 {intent.job.job_id.slice(0, 8)}</Typography.Text>{team && <Link to={'/organizations/'+pathId(team)+'/tasks?job='+pathId(intent.job.job_id)}>查看团队任务结果</Link>}<Button disabled={pending || (!intent.bound && intent.job.execution_state === 'queued')} onClick={freshTask}>开始另一任务</Button></div>}
      </>}
    </Card>
      {!team && selected && <Card className="model-result"><div className="organization-top"><h2>任务结果</h2>{visibleJob && <Tag>{states[visibleJob.execution_state]}</Tag>}</div>
        {current.error ? <Alert type="warning" title="暂时无法读取任务" /> : !visibleJob ? <Spin /> : <><Typography.Text copyable={{ text: visibleJob.job_id }}>任务 {visibleJob.job_id}</Typography.Text><p>原预留上限 {formatCredits(visibleJob.reserved)} 积分 · {settlements[visibleJob.settlement_state]}{visibleJob.charge !== null ? ` · 已记费用 ${formatCredits(visibleJob.charge)} 积分` : ''}</p>
          {['queued', 'running'].includes(visibleJob.execution_state) && <Button danger loading={pending} onClick={() => { void cancel(); }}>取消任务</Button>}
          {visibleJob.execution_state === 'cancelling' && <p>取消请求已接收，执行终止和积分释放仍待确认。</p>}
          {result.error && <Alert type="warning" showIcon title="结果暂不可读" description={failureText(result.error)} />}
          {result.isFetching && <Spin aria-label="正在核对结果权限" />}
          {verifiedDocument && <TaskDocument document={verifiedDocument}/>}
        </>}
      </Card>}
    </section>{!team && <aside><Card><h2>我的任务</h2>{jobs.error ? <Alert type="warning" title="任务列表暂不可用" /> : jobs.isPending ? <Spin /> : jobs.data && <>
      {!jobs.data.data.length ? <Empty description="还没有模型任务" /> : <ul className="task-list">{jobs.data.data.map(row => <li key={row.job_id}><button onClick={() => setSelected(row.job_id)} aria-label={`查看任务 ${row.job_id}`}><strong>{row.job_id.slice(0, 8)}</strong><span>{states[row.execution_state]} · {settlements[row.settlement_state]}</span></button></li>)}</ul>}
      <div className="pagination"><Button disabled={!history.length || jobs.isFetching} onClick={() => { const next = [...history]; setCursor(next.pop()); setHistory(next); }}>上一页</Button><Button disabled={!jobs.data.next_cursor || jobs.isFetching} onClick={() => { setHistory([...history, cursor]); setCursor(jobs.data?.next_cursor ?? undefined); }}>下一页</Button></div>
    </>}</Card></aside>}</div>
  </>;
}
