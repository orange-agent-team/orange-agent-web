import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Card,Empty,Space,Table} from 'antd';
import {UserClient} from '../api/client';
import {authorityKey,type UserSession} from '../api/contracts';
import {formatCredits,type ProviderIncome} from '../api/accounts';

const client=new UserClient();
const states={pending:'等待期内',review:'审核中',available:'已转为可用'};

export default function ProviderIncomeHistory({session}:{session:UserSession}){
  const [pages,setPages]=useState<string[]>([]);
  const cursor=pages.at(-1);
  const history=useQuery({queryKey:[authorityKey(session),'provider-income',cursor??'first'],
    queryFn:({signal})=>client.earnings(session,cursor,signal),retry:false});
  const page=history.error||history.isFetching?undefined:history.data;
  return <Card title="贡献收益明细" extra={<Button onClick={()=>void history.refetch()}>刷新收益</Button>} loading={history.isFetching}>
    {history.error && <Alert type="warning" title="暂时无法读取贡献收益"/>}
    {page && (page.data.length?<Table<ProviderIncome> rowKey="job_id" dataSource={page.data} size="small" pagination={false} columns={[
      {title:'任务编号',dataIndex:'job_id'},{title:'收益（积分）',render:(_,row)=>formatCredits(row.units)},
      {title:'最早审核时间',render:(_,row)=>new Date(Number(row.eligible_unix)*1000).toLocaleString()},
      {title:'状态',render:(_,row)=>states[row.state]}
    ]}/>:<Empty description="当前没有贡献收益"/>)}
    <Space>{pages.length>0&&<Button onClick={()=>setPages(p=>p.slice(0,-1))}>上一页收益</Button>}
      {page?.next_cursor&&<Button onClick={()=>setPages(p=>[...p,page.next_cursor!])}>下一页收益</Button>}
    </Space>
  </Card>;
}
