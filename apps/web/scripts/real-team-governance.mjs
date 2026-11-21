import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
let input='';for await(const chunk of process.stdin)input+=chunk;
const f=JSON.parse(input),api=new URL(f.api);
if(f.origin!=='https://127.0.0.1:43122'||api.protocol!=='http:'||api.hostname!=='127.0.0.1'||!api.port)throw Error('Local fixture required');
const root=fileURLToPath(new URL('../',import.meta.url)),tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 async function user(token){
   const ctx=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true,viewport:{width:1280,height:1000}});
   await ctx.addCookies([{name:'__Host-orange-user',value:token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
   const page=await ctx.newPage();page.setDefaultTimeout(20000);return page;
 }
 const owner=await user(f.owner),member=await user(f.member);
 async function submit(page,button,path){
   const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
   await page.getByRole('button',{name:button,exact:true}).click();const res=await waiting;
   if(res.status()!==200)throw Error(button+' HTTP '+res.status());return res.json();
 }
 await owner.goto('/organizations');await owner.getByLabel('组织名称',{exact:true}).fill(f.name);
 const org=await submit(owner,'创建组织','/api/v1/organizations');
 await owner.getByRole('link',{name:'进入团队'}).click();
 await owner.getByRole('heading',{name:f.name,exact:true}).waitFor();
 await owner.getByLabel('被邀请人的成员标识').fill(f.recipient);
 const base='/api/v1/organizations/'+org.organization_id;
 let posts=0,invitation;
 await owner.route('**/organizations/*/invitations',async r=>{
    if(r.request().method()!=='POST')return r.continue();
    posts++;if(posts>1)return r.continue();
    const response=await r.fetch();const saved=await response.json();
    if(response.status()!==200||saved.state!=='pending'||saved.recipient_id!==f.recipient)throw Error('Original invitation not committed');
    invitation=saved.invitation_id;await r.abort('failed');
 });
 await owner.getByRole('button',{name:'发送站内邀请'}).click();await owner.getByText('待核对的团队操作',{exact:true}).waitFor();
 await owner.reload();const replay=await submit(owner,'重试原操作',base+'/invitations');
 if(replay.invitation_id!==invitation||posts!==2)throw Error('Recovery created another invitation');
 await member.goto('/invitations');await member.getByText(f.name,{exact:true}).waitFor();
 await submit(member,'接受团队邀请','/api/v1/team-invitations/'+invitation+'/accept');
 await member.getByText('当前没有待处理的邀请。',{exact:true}).waitFor();
 await owner.getByLabel('生效硬上限（微积分）').fill('700');
 await owner.getByLabel('所有者允许的最高上限（微积分）').fill('900');
 const policy=await submit(owner,'保存团队硬预算',base+'/budget-policy');
 if(policy.hard_limit!=='700'||policy.owner_ceiling!=='900')throw Error('Different budget policy');
 await owner.getByLabel('额度受益成员').selectOption(f.recipient);await owner.getByLabel('成员额度（微积分）').fill('500');
 const budget=await submit(owner,'分配团队额度',base+'/budgets');
 if(budget.member_id!==f.recipient||budget.organization_id!==org.organization_id)throw Error('Wrong budget target');
 await member.goto('/organizations/'+org.organization_id);await member.getByText('分配给我的团队预算',{exact:true}).waitFor();
 await member.getByText(budget.root_budget_id,{exact:true}).waitFor();
 if(await member.getByRole('button',{name:'保存团队硬预算'}).count()||await member.getByLabel('被邀请人的成员标识').count())throw Error('Member sees governance actions');
 await member.screenshot({path:f.screenshot,fullPage:true});
 await owner.getByText('变更已有成员',{exact:true}).click();await owner.getByLabel('目标成员').selectOption(f.recipient);await owner.getByLabel('新的成员权限').selectOption('remove');
 await submit(owner,'确认成员变更',base+'/members');await member.reload();
 await member.waitForFunction(id=>!document.body.innerText.includes(id),budget.root_budget_id);
 const denied=await member.request.get(base+'/budgets');if(denied.status()!==403)throw Error('Removed member retained budget access');
 console.log(JSON.stringify({two_user_contexts:true,one_invitation_after_lost_response:true,original_invitation_posts:posts,explicit_accept:true,team_hard_limit:'700',member_allocation:'500',removed_member_denied:true}));
}finally{await browser?.close();await server.close();}
