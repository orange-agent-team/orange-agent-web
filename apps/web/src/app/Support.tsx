import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Empty, Form, Input, Select, Space } from 'antd';
import { ApiFailure } from '../api/client';
import { authorityKey, type UserSession } from '../api/contracts';
import { SupportClient, type Terms, type Version } from '../api/support';
const api=new SupportClient();
const labels={active:'有效',expired:'已到期',revoked:'已撤销',unavailable:'文件已不可用'};
type Intent = {key:string;body:Terms} | {key:string;revoke:string};
function Pager({pages,next,change}:{pages:string[];next?:string;change:(v:string[])=>void}) {
  return <Space><Button disabled={!pages.length} onClick={()=>change(pages.slice(0,-1))}>上一页</Button>
    <Button disabled={!next} onClick={()=>{if(next)change([...pages,next]);}}>下一页</Button></Space>;
}
export default function Support({session,invalidate}:{session:UserSession;invalidate:()=>void}) {
  const [resources,setResources]=useState<Version[]>([]);
  const [ticket,setTicket]=useState(''),[purpose,setPurpose]=useState('');
  const [seconds,setSeconds]=useState(3600);
  const [filePages,setFilePages]=useState<string[]>([]),[pages,setPages]=useState<string[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<Intent>();
  const [receipt,setReceipt]=useState('');
  const live=useRef(true), lock=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false};},[]);
  const key=authorityKey(session);
  const files=useQuery({queryKey:[key,'support-files',filePages.at(-1)],queryFn:({signal})=>api.files(session,filePages.at(-1),signal)});
  const consents=useQuery({queryKey:[key,'support-consents',pages.at(-1)],queryFn:({signal})=>api.consents(session,pages.at(-1),signal)});
  async function submit(intent:Intent) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setReceipt('');
    try {
      const row='body' in intent ? await api.authorize(session,intent.key,intent.body) : await api.revoke(session,intent.key,intent.revoke);
      if(!live.current)return;
      setPending(undefined);setReceipt(row.authorization_id+' · '+labels[row.status]);setPages([]);
      if('body' in intent){setResources([]);setPurpose('');setTicket('');}
      await consents.refetch();
    } catch(e) {
      if(!live.current)return;
      if(e instanceof ApiFailure && [401,403].includes(e.status)){invalidate();return;}
      const uncertain=!(e instanceof ApiFailure)||e.status===0||e.status>=500||e.status<300;
      setPending(uncertain?intent:undefined);
      setError(uncertain?'提交结果待核对，请使用原请求重试。':'请求被拒绝，请刷新文件和授权记录。');
    } finally {lock.current=false;if(live.current)setBusy(false);}
  }
  const disabled=busy||!!pending;
  return <><h1>支持授权</h1><Card title="授权支持人员查看文件">
    <p>选择个人纯文本文件的具体版本，填写工单、用途和有效期。支持人员还需通过独立审批才能读取内容。</p>
    <Form layout="vertical" disabled={disabled} onFinish={()=>{if(!disabled&&resources.length)
      void submit({key:crypto.randomUUID(),body:{ticket_id:ticket,purpose,resources,content_field:'file_content',duration_seconds:seconds}});}}>
      <Form.Item label="可授权的文件版本">
        {files.isError?<Alert type="warning" title="文件列表读取失败"/>:files.data?.data.length?files.data.data.map(f=>{
          const selected=resources.some(r=>r.artifact_id===f.artifact_id);
          return <p key={f.version_id}><Checkbox checked={selected} disabled={disabled||(!selected&&resources.length===20)} onChange={e=>{
            setResources(prev=>e.target.checked?[...prev,{artifact_id:f.artifact_id,version_id:f.version_id}]:prev.filter(v=>v.artifact_id!==f.artifact_id));
          }}>{f.artifact_id} · 版本 {f.version_id} · {f.size_bytes} 字节</Checkbox></p>;
        }):!files.isFetching&&<Empty description="当前没有可授权的个人纯文本文件"/>}
        <Pager pages={filePages} next={files.data?.next_before} change={setFilePages}/>
      </Form.Item>
      <p>已选 {resources.length} 个版本</p>
      {resources.map(v=><div key={v.artifact_id}>{v.artifact_id} / {v.version_id}</div>)}
      <label>关联工单<Input maxLength={128} value={ticket} onChange={e=>setTicket(e.target.value)}/></label>
      <label>支持用途<Input.TextArea maxLength={500} value={purpose} onChange={e=>setPurpose(e.target.value)}/></label>
      <Form.Item label="有效期"><Select aria-label="有效期" value={seconds} onChange={setSeconds} options={[{value:900,label:'15 分钟'},{value:3600,label:'1 小时'},{value:86400,label:'24 小时'}]}/></Form.Item>
      <Button htmlType="submit" type="primary" disabled={disabled||!resources.length||!purpose.trim()||!/^[A-Za-z0-9_.:-]{1,128}$/.test(ticket)}>确认授权所选版本</Button>
    </Form>
  </Card>
  {error&&<Alert type="warning" title={error}/>}
  {pending&&<Button loading={busy} onClick={()=>void submit(pending)}>核对原请求</Button>}
  {receipt&&<p role="status">{receipt}</p>}
  <Card title="我的支持授权" extra={<Button onClick={()=>{void consents.refetch();void files.refetch();}}>刷新</Button>}>
    {consents.isError?<Alert type="warning" title="授权记录读取失败"/>:consents.data?.data.map(row=><section key={row.authorization_id}>
      <h3>{row.ticket_id} · {labels[row.status]}</h3><p>{row.purpose}</p><p>{row.authorization_id} · 到期 {new Date(row.expires_at).toLocaleString()}</p>
      <ul>{row.resources.map(r=><li key={r.artifact_id}>{r.artifact_id} / {r.version_id}</li>)}</ul>
      {row.status==='active'&&<Button disabled={disabled} onClick={()=>void submit({key:crypto.randomUUID(),revoke:row.authorization_id})}>撤销授权</Button>}
    </section>)}<Pager pages={pages} next={consents.data?.next_before} change={setPages}/>
  </Card></>;
}
