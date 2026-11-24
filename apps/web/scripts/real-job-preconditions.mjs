// Both competing cancellation requests go to the real user router. The browser
// only pauses one in flight so it cannot silently acquire a newer precondition.
import {chromium,expect} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const tls=resolve(root,'../../.local/tls');
let input='';
for await(const chunk of process.stdin) input+=chunk;
const f=JSON.parse(input);
const upstream=new URL(f.api);
if(upstream.hostname!=='127.0.0.1'||upstream.protocol!=='http:'||!upstream.port||f.origin!=='https://127.0.0.1:43122')throw Error('Private development fixture required');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
 https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:upstream.origin,changeOrigin:false,ws:true}}}});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true});
 await context.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();
 page.setDefaultTimeout(18000);
 const path='/api/v1/owners/'+encodeURIComponent(f.owner)+'/jobs/'+encodeURIComponent(f.job);
 // Retain only the native socket created by this owned Chrome test so we can interrupt it.
 await page.addInitScript(({path})=>{
  const Native=window.WebSocket;
  window.WebSocket=class extends Native{
   constructor(...args){super(...args);if(new URL(this.url).pathname===path+'/events/ws')window.orangeTestJobSocket=this;}
  };
 },{path});
 const frames=[];
 const acknowledgments=[];
 page.on('websocket',ws=>{
  if(new URL(ws.url()).pathname!==path+'/events/ws')return;
  ws.on('framereceived',({payload})=>{if(typeof payload==='string')frames.push(JSON.parse(payload));});
  ws.on('framesent',({payload})=>{if(typeof payload==='string')acknowledgments.push(JSON.parse(payload));});
 });
 const read=page.waitForResponse(r=>r.url()===f.origin+path&&r.request().method()==='GET'&&r.status()===200);
 await page.goto(f.team?'/organizations/'+encodeURIComponent(f.owner)+'/tasks?job='+encodeURIComponent(f.job):'/tasks');
 if(!f.team)await page.getByRole('button',{name:'查看任务 '+f.job,exact:true}).click();
 const observed=(await read).headers()['x-orange-job-version'];
 await expect.poll(()=>acknowledgments.length,{timeout:12000}).toBeGreaterThan(0);
 const snapshot=frames.find(frame=>frame.history.kind==='snapshot'&&frame.history.job.job_id===f.job);
 if(!snapshot||!acknowledgments.some(a=>a.kind==='ack'&&a.connection_generation===snapshot.connection_generation))throw Error('No native browser acknowledgment for this Job snapshot');
 if(!observed||!/^\d+$/.test(observed))throw Error('Missing observed version');
 const action=page.getByRole('button',{name:f.team?'取消团队任务':'取消任务',exact:true});
 await expect(action).toBeVisible();
 let allowRead;
 const delayed=new Promise(ok=>{allowRead=ok;});
 let intercepted=0;
 const pause=async route=>{intercepted++;await delayed;await route.continue();};
 await page.route(f.origin+path,pause);
 let resumed;
 try{
  await page.evaluate(()=>{const ws=window.orangeTestJobSocket;if(!ws||ws.readyState!==WebSocket.OPEN)throw Error('No live native socket');ws.close(1000,'owned reconnect exercise');});
  await expect(action).toHaveCount(0);
  await expect.poll(()=>intercepted,{timeout:5000}).toBeGreaterThan(0);
  await expect.poll(()=>frames.some(frame=>frame.connection_generation!==snapshot.connection_generation&&frame.history.kind==='page'),{timeout:8000}).toBe(true);
  resumed=frames.find(frame=>frame.connection_generation!==snapshot.connection_generation&&frame.history.kind==='page');
  if(acknowledgments.some(a=>a.connection_generation===resumed.connection_generation))throw Error('Acknowledged the new generation without a fresh status read');
 }finally{allowRead();}
 await expect.poll(()=>acknowledgments.some(a=>a.connection_generation===resumed.connection_generation),{timeout:8000}).toBe(true);
 await page.unroute(f.origin+path,pause);
 await expect(action).toBeVisible();
 let posts=0;
 let competingStatus;
 let sent;
 const cancelUrl=f.origin+path+'/cancel';
 await page.route(cancelUrl,async route=>{
  posts++;
  sent=(await route.request().allHeaders())['x-orange-expected-job-version'];
  if(!f.team){
   const competitor=await context.request.post(cancelUrl,{headers:{Origin:f.origin,'X-CSRF-Token':f.csrf,'Idempotency-Key':randomUUID(),'x-orange-expected-job-version':observed},data:{}});
   competingStatus=competitor.status();
  }
  await route.continue();
 });
 const reply=page.waitForResponse(r=>r.url()===cancelUrl&&r.request().method()==='POST');
 await page.getByRole('button',{name:f.team?'取消团队任务':'取消任务',exact:true}).click();
 const response=await reply;
 if(sent!==observed||response.status()!==(f.team?200:412)||(!f.team&&competingStatus!==200))throw Error('Unexpected real conditional cancellation');
 if(!f.team){
  if((await response.json()).code!=='STALE_JOB_VERSION')throw Error('Wrong precondition response');
  await page.getByText('任务状态已变化。请核对刷新后的状态，再决定是否取消。',{exact:true}).waitFor();
 }
 await page.getByRole('button',{name:f.team?'取消团队任务':'取消任务',exact:true}).waitFor({state:'hidden'});
 if(posts!==1)throw Error('Portal resent a cancellation without another operator action');
 await expect.poll(()=>frames.some(frame=>frame.history.kind==='page'&&frame.history.events.some(e=>e.event_type==='job.cancelled')),{timeout:12000}).toBe(true);
 if(posts!==1)throw Error('Event replay caused a second business command');
 // Revoke this disposable development session from another live client while the page is offline.
 // The original page must retire private views immediately, then wait for the real new session response.
 await context.setOffline(true);
 await expect(page.getByRole('heading',{name:'网络已断开'})).toBeVisible();
 await expect(page.getByRole('link',{name:'登录用户空间'})).toHaveCount(0);
 await expect(page.getByText(f.job,{exact:true})).toHaveCount(0);
 const revoker=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true});
 try{
  await revoker.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const revoked=await revoker.request.delete(f.origin+'/api/v1/session',{headers:{Origin:f.origin,'X-CSRF-Token':f.csrf,'Idempotency-Key':randomUUID()}});
  if(revoked.status()!==204)throw Error('Unable to revoke isolated browser identity');
 }finally{await revoker.close();}
 let allowSession;
 const holdSession=new Promise(done=>{allowSession=done;});
 let sessionProbes=0;
 await page.route(f.origin+'/api/v1/session',async route=>{sessionProbes++;await holdSession;await route.continue();});
 try{
  await context.setOffline(false);
  await expect.poll(()=>sessionProbes).toBeGreaterThan(0);
  await expect(page.getByRole('heading',{name:'正在确认登录状态'})).toBeVisible();
  await expect(action).toHaveCount(0);
  await expect(page.getByRole('link',{name:'登录用户空间'})).toHaveCount(0);
  allowSession();
  await expect(page.getByRole('heading',{name:'登录你的账户'})).toBeVisible();
  await expect(action).toHaveCount(0);
 } finally {allowSession();}
 console.log(JSON.stringify({offline_session_retired:true,remote_revocation_confirmed:true,event_snapshot:true,reconnect_hid_cancel:true,fresh_revision_before_ack:true,durable_cancellation_event:true,acknowledgments:acknowledgments.length,team:f.team,observed,sent,status:response.status(),browser_posts:posts,competing_status:competingStatus??null}));
}finally{
 await browser?.close();
 await new Promise(resolve=>server.httpServer.close(resolve));
}
