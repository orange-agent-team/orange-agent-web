import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Card,Input,Space,Spin,Typography} from 'antd';
import {Link,useParams} from 'react-router';
import {ApiFailure} from '../api/client';
import type {TeamRole,UserSession} from '../api/contracts';
import {TeamClient,checkIntent,type Budget,type Intent,type Invite} from '../api/team';
const api=new TeamClient();
export const labels:Record<TeamRole,string>={owner:'所有者',admin:'管理员',member:'成员',billing:'账务',viewer:'只读成员'};
const roles=Object.keys(labels) as TeamRole[];
const amount=(v:string)=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
function errorLabel(e:unknown){
  if(e instanceof ApiFailure){
    if(e.status===0||e.status>=500||e.status>=200&&e.status<300)return '尚未确认本次操作，请核对后以原编号重试。';
    const known:Record<string,string>={TEAM_BUDGET_EXCEEDED:'团队总上限不足，请核对已分配额度。',TEAM_BUDGET_NOT_CONFIGURED:'请先由所有者设置团队预算上限。',BUDGET_ALREADY_COMMITTED:'额度低于已消费及冻结之和。',VERSION_CONFLICT:'团队资料已经变更，请依据最新资料重试。',LAST_OWNER_REQUIRED:'团队需要保留一位所有者。',CAPACITY_EXCEEDED:'团队成员数已达到上限。',FORBIDDEN:'当前身份无权执行这项操作。'};
    return known[e.code]??'服务端已拒绝本次团队操作。';
  }return '尚未确认本次操作，可用原编号重试。';
}
function useWrite(session:UserSession,scope:string){
  const client=useQueryClient();const key='orange.team.write.v1:'+JSON.stringify([session.user_id,scope]);
  const [saved,setSaved]=useState<Intent>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [ready,setReady]=useState(false);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>{try{const v=sessionStorage.getItem(key);if(v){const intent=JSON.parse(v) as Intent;checkIntent(intent,scope==='inbox'?intent.org:scope);if(scope==='inbox'&&!['accept','decline'].includes(intent.op))throw Error('Wrong operation');setSaved(intent);}setReady(true);}
    catch{setError('本机团队操作记录不可读取。');}return ()=>active.current?.abort();},[key,scope]);
  async function submit(m:Intent){
    if(!ready||active.current||saved&&JSON.stringify(saved)!==JSON.stringify(m))return;
    const c=new AbortController();active.current=c;setBusy(true);setError('');
    try{checkIntent(m,scope==='inbox'?m.org:scope);sessionStorage.setItem(key,JSON.stringify(m));setSaved(m);
      await api.act(session,m,c.signal);
      if(!c.signal.aborted){sessionStorage.removeItem(key);setSaved(undefined);await client.invalidateQueries();}
    }catch(e){if(!c.signal.aborted){setError(errorLabel(e));if(e instanceof ApiFailure && [400,401,403,404,409,422].includes(e.status)){sessionStorage.removeItem(key);setSaved(undefined);await client.invalidateQueries();}}}
    finally{if(!c.signal.aborted){active.current=null;setBusy(false);}}
  }
  const feedback=<>{error&&<Alert title={error} type="warning"/>}{saved&&!busy&&<Card title="待核对的团队操作"><p>原编号 <code>{saved.key}</code></p><pre>{JSON.stringify(saved.body,null,2)}</pre><Button onClick={()=>void submit(saved)}>重试原操作</Button></Card>}</>;
  return {submit,disabled:!ready||busy||!!saved,feedback};
}
function roleSelect(value:TeamRole,set:(v:TeamRole)=>void,options:TeamRole[],label:string){
  return <label>{label} <select aria-label={label} value={value} onChange={e=>set(e.target.value as TeamRole)}>{options.map(r=><option key={r} value={r}>{labels[r]}</option>)}</select></label>;
}
function Pages({pages,set,next}:{pages:string[];set:(p:string[])=>void;next?:string|null}){
  return <Space>{pages.length>0&&<Button onClick={()=>set(pages.slice(0,-1))}>上一页</Button>}{next&&<Button onClick={()=>set([...pages,next])}>下一页</Button>}</Space>;
}
export function InvitationInbox({session}:{session:UserSession}){
  const [pages,setPages]=useState<string[]>([]);const w=useWrite(session,'inbox');
  const inbox=useQuery({queryKey:['team',session.session_id,'inbox',pages.at(-1)],queryFn:({signal})=>api.invitations(session,null,pages.at(-1),signal),refetchInterval:10000});
  function decide(i:Invite,op:'accept'|'decline'){void w.submit({org:i.organization_id,op,key:i.invitation_id,target:i.invitation_id,body:op==='accept'?{accept:true}:{}});}
  return <><h1>我的团队邀请</h1><p>供邀请人使用的成员标识 <Typography.Text copyable>{session.user_id}</Typography.Text></p>
    {inbox.error?<Alert type="warning" title="无法读取团队邀请"/>:inbox.isLoading?<Spin/>:inbox.data?.data.length?inbox.data.data.map(i=>
      <Card key={i.invitation_id} title={i.organization_name}><p>拟加入角色 {labels[i.role]} · 截止 {new Date(Number(i.expires_at_unix)*1000).toLocaleString()}</p>
        <p>邀请者 <code>{i.issuer_id}</code></p><Space><Button disabled={w.disabled} onClick={()=>decide(i,'accept')}>接受团队邀请</Button><Button disabled={w.disabled} onClick={()=>decide(i,'decline')}>拒绝邀请</Button></Space></Card>):<p>当前没有待处理的邀请。</p>}
    {w.feedback}<Pages pages={pages} set={setPages} next={inbox.data?.next_cursor}/><p><Link to="/organizations">查看我的组织</Link></p></>;
}
function BudgetEdit({b,submit,disabled}:{b:Budget;submit:(m:Intent)=>Promise<void>;disabled:boolean}){
  const [limit,setLimit]=useState(b.limit);const [allow,setAllow]=useState(b.allow_submit);
  if(!b.version)return null;
  return <details><summary>调整额度与提交权限</summary><label>调整后额度（微积分）<Input value={limit} onChange={e=>setLimit(e.target.value)}/></label>
    <label><input type="checkbox" checked={allow} onChange={e=>setAllow(e.target.checked)}/>允许使用这笔额度提交任务</label>
    <Button disabled={disabled||!amount(limit)} onClick={()=>void submit({op:'adjust',org:b.organization_id,target:b.root_budget_id,key:crypto.randomUUID(),body:{limit,allow_submit:allow,expected_version:b.version}})}>确认调整额度</Button></details>;
}
export function TeamPage({session}:{session:UserSession}){
  const {org=''}=useParams();return <Team key={org} org={org} session={session}/>;
}
function Team({org,session}:{org:string;session:UserSession}){
  const q=useQuery({queryKey:['team',session.session_id,org],queryFn:({signal})=>api.organization(session,org,signal),refetchInterval:5000});
  const me=q.error?undefined:q.data;const managed=me?.role==='owner'||me?.role==='admin';
  const members=useQuery({queryKey:['team',session.session_id,org,'members'],enabled:managed,queryFn:({signal})=>api.members(org,signal),refetchInterval:5000});
  const [ip,setIp]=useState<string[]>([]);const [bp,setBp]=useState<string[]>([]);
  const sent=useQuery({queryKey:['team',session.session_id,org,'outgoing',ip.at(-1)],enabled:managed,queryFn:({signal})=>api.invitations(session,org,ip.at(-1),signal),refetchInterval:5000});
  const policy=useQuery({queryKey:['team',session.session_id,org,'policy'],enabled:managed||me?.role==='billing',queryFn:({signal})=>api.policy(org,signal),refetchInterval:5000});
  const budgets=useQuery({queryKey:['team',session.session_id,org,'budgets',bp.at(-1)],enabled:!!me&&me.role!=='viewer',queryFn:({signal})=>api.memberBudgets(org,bp.at(-1),signal),refetchInterval:5000});
  const [recipient,setRecipient]=useState('');const [grantRole,setGrantRole]=useState<TeamRole>('member');
  const [member,setMember]=useState('');const [newRole,setNewRole]=useState<TeamRole|'remove'>('member');
  const [hard,setHard]=useState('');const [ceiling,setCeiling]=useState('');const [beneficiary,setBeneficiary]=useState('');const [limit,setLimit]=useState('');
  const w=useWrite(session,org);const authorizedRoles:TeamRole[]=me?.role==='owner'?roles:['member','billing','viewer'];
  if(!me)return q.error?<Alert title="当前身份无法读取这个组织" type="warning"/>:<Spin/>;
  const roster=managed&&!members.error?members.data:undefined;const protectedPolicy=!policy.error?policy.data:undefined;
  const editable=roster?.data.filter(m=>me.role==='owner'||!['owner','admin'].includes(m.role))??[];
  return <><p><Link to="/organizations">我的组织</Link></p><h1>{me.name}</h1><p>{labels[me.role]} · 组织编号 <Typography.Text copyable>{org}</Typography.Text></p>
    {['owner','admin','member'].includes(me.role)&&<p><Link to={'/organizations/'+encodeURIComponent(org)+'/tasks'}>我在这个团队的任务</Link></p>}
    {me.role!=='billing' && <p><Link to={'/organizations/'+encodeURIComponent(org)+'/images'}>校验团队图像</Link></p>}
    {managed&&<p><Link to={'/organizations/'+encodeURIComponent(org)+'/devices'}>管理团队设备注册</Link></p>}
    {w.feedback}
    {managed&&<Card title="团队成员与邀请">{roster?<><ul>{roster.data.map(m=><li key={m.user_id}><code>{m.user_id}</code> · {labels[m.role]}</li>)}</ul>
      <label>被邀请人的成员标识<Input value={recipient} onChange={e=>setRecipient(e.target.value)}/></label>
      {roleSelect(grantRole,setGrantRole,authorizedRoles,'邀请角色')}
      <Button disabled={w.disabled||!recipient||!authorizedRoles.includes(grantRole)} onClick={()=>{const id=crypto.randomUUID();void w.submit({op:'invite',org,key:id,body:{invitation_id:id,recipient_id:recipient,role:grantRole,ttl_seconds:86400,expected_policy_version:roster.policy_version}});}}>发送站内邀请</Button>
      <details><summary>变更已有成员</summary><label>目标成员 <select aria-label="目标成员" value={member} onChange={e=>setMember(e.target.value)}><option value="">选择成员</option>{editable.map(m=><option key={m.user_id}>{m.user_id}</option>)}</select></label>
        <label>新的成员权限 <select aria-label="新的成员权限" value={newRole} onChange={e=>setNewRole(e.target.value as TeamRole|'remove')}>{authorizedRoles.map(r=><option key={r} value={r}>{labels[r]}</option>)}<option value="remove">移出组织</option></select></label>
        <Button disabled={w.disabled||!editable.some(m=>m.user_id===member)} onClick={()=>void w.submit({op:'change',org,key:crypto.randomUUID(),body:{user_id:member,role:newRole==='remove'?null:newRole,expected_policy_version:roster.policy_version}})}>确认成员变更</Button></details></>:<p>正在核对成员权限。</p>}
      {!sent.error&&sent.data?.data.map(i=><p key={i.invitation_id}>{i.recipient_id} · {labels[i.role]} · {({pending:'待领取',accepted:'已接受',declined:'已拒绝',expired:'已过期',revoked:'已撤回'})[i.state]} {i.state==='pending'&&authorizedRoles.includes(i.role)&&<Button disabled={w.disabled} onClick={()=>void w.submit({op:'revoke',org,key:i.invitation_id,target:i.invitation_id,body:{}})}>撤回邀请</Button>}</p>)}
      <Pages pages={ip} set={setIp} next={sent.data?.next_cursor}/></Card>}
    {(managed||me.role==='billing')&&<Card title="团队硬预算">{protectedPolicy?<><p>当前硬上限 {protectedPolicy.hard_limit??'未设置'} · 已分配 {protectedPolicy.allocated} 微积分</p>
      {managed&&<><label>生效硬上限（微积分）<Input value={hard} onChange={e=>setHard(e.target.value)}/></label>
        {me.role==='owner'&&<label>所有者允许的最高上限（微积分）<Input value={ceiling} onChange={e=>setCeiling(e.target.value)} placeholder={protectedPolicy.owner_ceiling??''}/></label>}
        <Button disabled={w.disabled||!amount(hard)||!!ceiling&&!amount(ceiling)||protectedPolicy.owner_ceiling===null&&(!ceiling||me.role!=='owner')} onClick={()=>void w.submit({op:'policy',org,key:crypto.randomUUID(),body:{hard_limit:hard,expected_version:protectedPolicy.version,...(me.role==='owner'&&ceiling?{owner_ceiling:ceiling}:{})}})}>保存团队硬预算</Button></>}</>:<p>暂未读到预算政策。</p>}</Card>}
    {me.role!=='viewer'&&<Card title={me.role==='member'?'分配给我的团队预算':'成员预算'}>
     {managed&&protectedPolicy?.hard_limit!=null&&roster&&<>
       <label>额度受益成员 <select aria-label="额度受益成员" value={beneficiary} onChange={e=>setBeneficiary(e.target.value)}><option value="">选择成员</option>{roster.data.filter(m=>['owner','admin','member'].includes(m.role)).map(m=><option key={m.user_id}>{m.user_id}</option>)}</select></label>
       <label>成员额度（微积分）<Input value={limit} onChange={e=>setLimit(e.target.value)}/></label>
       <Button disabled={w.disabled||!beneficiary||!amount(limit)} onClick={()=>{const id=crypto.randomUUID();void w.submit({op:'allocate',org,key:id,body:{budget_id:id,member_id:beneficiary,limit,expected_policy_version:protectedPolicy.version}});}}>分配团队额度</Button></>}
     {budgets.error?<p>当前无法读取成员预算。</p>:budgets.data?.data.map(b=><div key={b.root_budget_id}><p>预算 <Typography.Text copyable>{b.root_budget_id}</Typography.Text></p>
       <p>额度 {b.limit} · 已消费 {b.spent} · 已冻结 {b.reserved} 微积分 · {b.allow_submit?'允许提交':'授权已关闭'}</p>
       {b.allow_submit&&b.member_id===session.user_id&&b.state==='active'&&<p><Link to={'/organizations/'+encodeURIComponent(org)+'/budgets/'+encodeURIComponent(b.root_budget_id)+'/audio'}>使用这笔团队预算转写</Link> · <Link to={'/organizations/'+encodeURIComponent(org)+'/budgets/'+encodeURIComponent(b.root_budget_id)+'/text'}>使用这笔团队预算运行文本任务</Link></p>}
       {managed&&<BudgetEdit key={b.root_budget_id+':'+b.version} b={b} submit={w.submit} disabled={w.disabled}/>}</div>)}
     <Pages pages={bp} set={setBp} next={budgets.data?.next_cursor}/></Card>}
  </>;
}
