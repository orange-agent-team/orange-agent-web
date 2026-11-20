import {chromium} from '@playwright/test';
import {createHash} from 'node:crypto';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
let input='';
for await(const chunk of process.stdin)input+=chunk;
const f=JSON.parse(input), api=new URL(f.api);
if(f.origin!=='https://127.0.0.1:43122'||api.protocol!=='http:'||api.hostname!=='127.0.0.1'||!api.port)throw Error('Loopback fixture required');
const root=fileURLToPath(new URL('../',import.meta.url)), tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
 https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
 proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const ctx=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true,viewport:{width:1200,height:1100}});
 await ctx.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await ctx.newPage();page.setDefaultTimeout(20000);if(f.price_grant){
  // Resume only the same opaque handle that the consent page saves before its POST.
  await page.goto('/tasks/audio');
  await page.evaluate(x=>sessionStorage.setItem('orange.audio-consent.v1:'+x.user+':'+x.owner,x.grant),{user:f.user,owner:f.owner,grant:f.price_grant});
  await page.reload();
  await page.getByRole('button',{name:'获取转写报价'}).click();
  for(const text of ['11000 毫秒','12000 个开发积分最小单位','2200 个开发积分最小单位',f.node+' · '+f.region,f.budget])await page.getByText(text,{exact:true}).waitFor();
  let submitted=0,job;
  await page.route('**/jobs',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const response=await route.fetch(), value=await response.json();
    if(response.status()!==200||value.reserved!=='2200'||value.invocation_id!==f.invocation)throw Error('Unconfirmed real reservation');
    submitted++;job=value.job_id;await route.abort('failed');
  });
  await page.screenshot({path:f.screenshot,fullPage:true});
  await page.getByRole('button',{name:'确认预留并提交转写'}).click();
  await page.getByText('请求结果待核对。刷新页面可查询原任务。',{exact:true}).waitFor();
  await page.reload();await page.getByText(job,{exact:true}).waitFor();
  if(submitted!==1||await page.getByRole('button',{name:'确认预留并提交转写'}).count())throw Error('Recovered order could spend twice');
  console.log(JSON.stringify({real_chrome_development_quote:true,confirmed_limit:'2200',lost_response_after_freeze:true,original_job_recovered:true,submit_calls:submitted}));
 }else if(f.job){
  await page.goto('/tasks');
  await page.getByRole('button',{name:'查看任务 '+f.job,exact:true}).click();
  const text=await page.getByTestId('model-result-text').innerText();
  if(createHash('sha256').update(text).digest('hex')!==f.transcript_sha)throw Error('Unexpected transcript content');
  await page.getByText('查看转写时间段',{exact:true}).click();
  await page.getByText('语言 en · 解码时长 11000 毫秒',{exact:true}).waitFor();
  if(await page.locator('details ol li').count()!==f.segments)throw Error('Segment count changed');
  await page.screenshot({path:f.screenshot,fullPage:true});
  const removed=await ctx.request.delete('/api/v1/owners/'+encodeURIComponent(f.owner)+'/uploads/'+encodeURIComponent(f.upload),
    {headers:{Origin:f.origin,'X-CSRF-Token':f.csrf,'Idempotency-Key':f.upload}});
  if(removed.status()!==200||(await removed.json()).state!=='deleted')throw Error('Could not delete source');
  await page.getByRole('button',{name:'刷新任务'}).click();
  await page.getByText('结果暂不可读',{exact:true}).waitFor();
  if(await page.getByTestId('model-result-text').count()||await page.locator('details ol li').count())throw Error('Deleted source reexposed transcript');
  console.log(JSON.stringify({real_chrome_transcript:true,artifact_and_text_digest_verified:true,segments:f.segments,source_deletion_hides_result:true}));
 }else{
 await page.goto('/tasks/audio');
 await page.getByLabel('上传编号').fill(f.upload);await page.getByRole('button',{name:'预检已有音频'}).click();await page.getByText('11000 毫秒',{exact:true}).waitFor();
 await page.getByLabel('节点观测编号').fill(f.observation);await page.getByRole('button',{name:'核对转写节点'}).click();await page.getByText(f.node,{exact:true}).waitFor();
 await page.getByText(f.region,{exact:true}).waitFor();await page.getByLabel('预算编号').fill(f.budget);
 const check=page.getByRole('checkbox',{name:'允许此节点读取当前音频版本用于本次转写'});
 const submit=page.getByRole('button',{name:'授权 15 分钟'});
 if(await submit.isEnabled())throw Error('Explicit consent missing');
 await check.check();await page.getByLabel('转写语言').selectOption('zh');
 if(await submit.isEnabled()||await check.isChecked())throw Error('Selection changed without new consent');
 await check.check();
 let calls=0,id;
 // Discard exactly the first response after the real service has committed the consent.
 await page.route('**/transcription-input-grants',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   calls++;
   const response=await route.fetch(), granted=await response.json();
   if(response.status()!==200||granted.state!=='active'||granted.observation_id!==f.observation)throw Error('Real grant was not issued');
   id=granted.grant_id;await route.abort('failed');
 });
 await submit.click();await page.getByText(/^授权有效/).waitFor();
 if(calls!==1||!id)throw Error('Recovered consent was replayed or absent');
 await page.reload();await page.getByText(/^授权有效/).waitFor();await page.getByText(id,{exact:true}).waitFor();
 await page.screenshot({path:f.screenshot,fullPage:true});
 await page.getByRole('button',{name:'撤回音频授权'}).click();await page.getByText('授权已撤回',{exact:true}).waitFor();
 await page.reload();await page.getByText('授权已撤回',{exact:true}).waitFor();
 if(calls!==1)throw Error('Unexpected consent creation on reload');
 console.log(JSON.stringify({real_chrome:true,explicit_target_and_consent:true,recovered_after_lost_response:true,create_calls:calls,withdrawal_survives_reload:true}));
 }
} finally {await browser?.close();await server.close();}
