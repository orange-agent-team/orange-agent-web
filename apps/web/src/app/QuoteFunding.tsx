import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Spin} from 'antd';
import {authorityKey,type UserSession} from '../api/contracts';
import {formatCredits} from '../api/accounts';
import type {ComputeClient} from '../api/compute-client';
import type {Quote,QuoteFunding} from '../api/compute-contracts';

type BoundQuote=Pick<Quote,'quote_id'|'root_budget_id'|'price_version'|'max_amount'|'expires_at_unix'>;
export function useQuoteFunding(api:ComputeClient,session:UserSession,quote?:BoundQuote){
  return useQuery({
    queryKey:[authorityKey(session),api.owner(session),'quote-funding',quote?.quote_id??null],
    queryFn:({signal})=>{if(!quote)throw Error('QUOTE_REQUIRED');return api.funding(session,quote,signal);},
    enabled:!!quote,retry:false,refetchInterval:q=>q.state.data?.status==='expired'?false:8000,
    refetchIntervalInBackground:false
  });
}
const explanations:Record<Exclude<QuoteFunding['status'],'sufficient'>,string>={
  expired:'报价已过期，请重新获取报价。',budget_closed:'预算已关闭。请选择可用预算。',
  spending_paused:'原付款正在复核，当前账户已暂停新增付费任务。',
  insufficient_budget:'本次最大预留超过该预算的剩余额度。请调整预算或减少任务范围。',
  insufficient_funds:'账户可用积分不足。请调整任务范围或核对资金来源。'
};
export function FundingDetails({query}:{query:ReturnType<typeof useQuoteFunding>}){
  const value=query.data;
  if(query.isFetching)return <Spin aria-label="核对当前额度"/>;
  if(query.error||!value)return <Alert type="warning" title="暂时无法核对原报价的可用额度" action={<Button onClick={()=>void query.refetch()}>重试核对</Button>}/>;
  return <section aria-label="原报价资金核对">
    <dl><dt>费用归属</dt><dd>{value.account_kind==='personal'?'个人账户':'团队账户'} · {value.owner_id}</dd>
      <dt>预算总额 / 已用 / 已预留</dt><dd>{[value.budget_limit,value.budget_spent,value.budget_reserved].map(formatCredits).join(' / ')} 积分</dd>
      <dt>该预算可用额度</dt><dd>{formatCredits(value.budget_remaining)} 积分</dd>
      {value.status==='sufficient'&&<><dt>预留本次上限后的预算余量</dt><dd>{formatCredits(BigInt(value.budget_remaining)-BigInt(value.max_microcredits))} 积分</dd></>}
      {value.wallet_available!==null&&<><dt>账户可用余额</dt><dd>{formatCredits(value.wallet_available)} 积分</dd></>}
    </dl>
    {value.status!=='sufficient'&&<Alert type="warning" title={explanations[value.status]}/>}
  </section>;
}
