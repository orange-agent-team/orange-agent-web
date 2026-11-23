import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {ComputeClient} from '../api/compute-client';
import type {Price} from '../api/compute-contracts';
import {formatCredits} from '../api/accounts';

function sameTerms(current: Price, selected: Price): boolean {
  return current.price_version === selected.price_version && current.model_version === selected.model_version &&
    current.node_id === selected.node_id && current.meter_profile_digest === selected.meter_profile_digest &&
    current.input_price === selected.input_price && current.output_price === selected.output_price &&
    current.output_limit === selected.output_limit && current.fee_bps === selected.fee_bps;
}

export default function ModelSource({api, scope, offer}: {api: ComputeClient; scope: string; offer: Price}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: [scope, 'reviewed-market-models', offer.price_version],
    queryFn: ({signal}) => api.models(signal),
    enabled: open,
    refetchInterval: open ? 15000 : false,
    refetchIntervalInBackground: false,
    gcTime: 0,
  });
  const model = !query.isFetching && !query.error
    ? query.data?.data.find(entry => entry.offers.some(current => sameTerms(current, offer))) : undefined;
  return <details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>模型来源和计费限制</summary>
    {open && (query.isFetching ? <p role="status">正在核对当前模型…</p> : model ? <dl>
      <dt>权重仓库</dt><dd>{model.repository}</dd>
      <dt>权重版本</dt><dd><code>{model.revision}</code></dd>
      <dt>SHA-256</dt><dd><code>{model.model_sha256}</code></dd>
      <dt>模型许可</dt><dd>{model.license}</dd>
      <dt>上下文窗口</dt><dd>{model.context_tokens} token</dd>
      <dt>请求大小上限</dt><dd>{model.max_request_bytes} 字节</dd>
      <dt>每千计量单位</dt><dd>输入 {formatCredits(offer.input_price)} 积分，输出 {formatCredits(offer.output_price)} 积分</dd>
    </dl> : <p role="status">{query.error ? '暂时无法核对模型来源。' : '当前价格版本没有匹配的已审核模型记录。'}</p>)}
  </details>;
}
