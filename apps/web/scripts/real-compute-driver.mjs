// Real browser/API/model acceptance driver. The private caller supplies explicit
// user-session, price and enrollment fixtures; no OIDC or payment certification.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, extname, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { request as proxyRequest } from 'node:http';
import { createHash } from 'node:crypto';
if(process.version!=='v22.23.2')throw Error('Pinned Node22.23.2 required');
const file=process.argv[2];if(!file||(statSync(file).mode&0o077))throw Error('Private fixture file required');
const f=JSON.parse(readFileSync(file,'utf8')), api=new URL(f.api), origin=new URL(f.origin);
if(api.protocol!=='http:'||api.hostname!=='127.0.0.1'||api.username||api.password||api.pathname!=='/'||api.search||api.hash||!['https://127.0.0.1:43127','https://127.0.0.1:43128'].includes(origin.origin))throw Error('Dedicated loopback services required');
if(typeof f.cookie!=='string'||!f.cookie.startsWith('__Host-orange-user='))throw Error('Explicit user-session fixture required');
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),dist=realpathSync(resolve(app,'dist'));
const tls=resolve(app,'../../.local/tls'),output=resolve(dirname(file),'browser-result.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(name,value)=>writeFileSync(resolve(dirname(file),name),value,{mode:0o600});
let browser,page;const failedResponses=[];
const server=createServer({key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(!req.url.startsWith('/')||url.origin!==origin.origin){res.writeHead(400);res.end();return;}
  if(url.pathname.startsWith('/api/v1/')){
   const proxy=proxyRequest(new URL(req.url,api),{method:req.method,headers:{...req.headers,host:api.host}},upstream=>{res.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(res);});
   proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>proxy.destroy());req.pipe(proxy);return;
  }
  if(!['GET','HEAD'].includes(req.method)||url.pathname.startsWith('/admin/')){res.writeHead(404);res.end();return;}
  let path=resolve(dist,'.'+decodeURIComponent(url.pathname));const rel=relative(dist,path);
  if(rel.startsWith('..')||isAbsolute(rel)||rel.split('/').some(part=>part.startsWith('.'))){res.writeHead(404);res.end();return;}
  try{if(!statSync(path).isFile())path=resolve(dist,'index.html');}catch{if(extname(path)){res.writeHead(404);res.end();return;}path=resolve(dist,'index.html');}
  const actual=realpathSync(path),inside=relative(dist,actual);if(inside.startsWith('..')||isAbsolute(inside)){res.writeHead(404);res.end();return;}
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
  const bytes=readFileSync(actual);res.writeHead(200,{'Content-Type':types[extname(actual)]??'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(400);res.end();}
});
try{
 await new Promise((ok,bad)=>{server.once('error',bad);server.listen(Number(origin.port),'127.0.0.1',ok);});
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({baseURL:origin.origin,ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}});
 await context.addCookies([{name:'__Host-orange-user',value:f.cookie.slice('__Host-orange-user='.length),url:origin.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
 page=await context.newPage();page.on('response',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/v1/')&&r.status()>=400)failedResponses.push({path:url.pathname,status:r.status()});});await page.goto('/tasks');await page.getByRole('heading',{name:'模型任务',exact:true}).waitFor();
 const sessionResponse=await page.request.get('/api/v1/session');if(sessionResponse.status()!==200)throw Error('Actual user session rejected');const session=await sessionResponse.json();if(session.user_id!==f.user||session.personal_owner_id!==f.owner)throw Error('Actor mismatch');
 await page.getByRole('combobox',{name:'个人预算'}).selectOption(f.budget);await page.getByRole('combobox',{name:'可用模型'}).selectOption(f.price);
 let inputWrites=0,unreviewedSecret=false,uploadedDigest;
 const sensitive='private-fixture@example.test';
 page.on('request',req=>{
   if(!['POST','PUT','PATCH'].includes(req.method())||!new URL(req.url()).pathname.startsWith('/api/v1/'))return;
   inputWrites++;
   const body=req.postDataBuffer();
   if(body?.includes(Buffer.from(sensitive)))unreviewedSecret=true;
   if(req.method()==='PUT'&&new URL(req.url()).pathname.endsWith('/content'))uploadedDigest=createHash('sha256').update(body).digest('hex');
 });
 await page.getByRole('textbox',{name:'任务文本',exact:true}).fill('Say a short greeting.');
 if(!await page.getByRole('button',{name:'批准上传并获取报价'}).isDisabled())throw Error('Local-only editing allowed transmission');
 await page.getByRole('combobox',{name:'文本处理方式'}).selectOption('original');
 await page.getByRole('button',{name:'在本机生成上传预览'}).click();
 await page.getByRole('region',{name:'上传内容预览'}).waitFor();
 if(inputWrites!==0)throw Error('Preview sent a remote mutation');
 const previewQuoteResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/text-quotes'));
 await page.getByRole('button',{name:'批准上传并获取报价',exact:true}).click();const previewResponse=await previewQuoteResponse;if(previewResponse.status()!==201)throw Error('Preview quote failed');const previewQuote=await previewResponse.json();await page.getByTestId('quote-maximum').waitFor();
 const original=await page.evaluate(({user,owner})=>JSON.parse(sessionStorage.getItem('orange-compute-v1:'+JSON.stringify([user,owner]))),{user:f.user,owner:f.owner});
 const withdrawalResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/withdraw'));
 await page.getByRole('button',{name:'删除未提交输入',exact:true}).click();const withdrawalHttp=await withdrawalResponse;if(withdrawalHttp.status()!==200)throw Error('Pre-admission withdrawal rejected');const withdrawal=await withdrawalHttp.json();if(!withdrawal.prevented||!withdrawal.receipt_id||withdrawal.job!==null)throw Error('No authoritative prevention receipt');
 await page.getByRole('button',{name:'批准上传并获取报价',exact:true}).waitFor();
 const originalBody={root_budget_id:previewQuote.root_budget_id,invocation_id:previewQuote.invocation_id,purpose:'primary',quote_id:previewQuote.quote_id,request_projection_digest:previewQuote.request_projection_digest};
 const blocked=await page.request.post('/api/v1/owners/'+encodeURIComponent(f.owner)+'/jobs',{data:originalBody,headers:{Origin:origin.origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':original.submit_key}});if(blocked.status()!==409||(await blocked.json()).code!=='INVOCATION_WITHDRAWN')throw Error('Late original submission crossed the barrier');
 // Changing or withdrawing a preview must discard its upload authority before any second request.
 const priorWrites=inputWrites;
 await page.getByRole('textbox',{name:'任务文本',exact:true}).fill('Please greet '+sensitive);
 await page.getByRole('combobox',{name:'文本处理方式'}).selectOption('redacted');
 await page.getByRole('textbox',{name:'需遮盖的原文片段'}).fill(sensitive);
 await page.getByRole('button',{name:'在本机生成上传预览'}).click();
 await page.getByRole('region',{name:'上传内容预览'}).waitFor();
 await page.getByRole('textbox',{name:'任务文本',exact:true}).fill('Say a short greeting. Contact: '+sensitive);
 if(!await page.getByRole('button',{name:'批准上传并获取报价'}).isDisabled())throw Error('Text edit retained old approval');
 await page.getByRole('button',{name:'在本机生成上传预览'}).click();
 const area=page.getByRole('region',{name:'上传内容预览'});await area.waitFor();
 const exact=await area.locator('pre').innerText(), expectedHash=await area.locator('code').innerText();
 if(exact.includes(sensitive)||!exact.includes('[已遮盖]')||createHash('sha256').update(exact).digest('hex')!==expectedHash||inputWrites!==priorWrites)throw Error('Incorrect scoped preview');

 const uploaded=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/content'));
 await page.getByRole('button',{name:'批准上传并获取报价',exact:true}).click();const uploadResponse=await uploaded;if(uploadResponse.status()!==200)throw Error('Actual input upload failed');const input=await uploadResponse.json();
 if(uploadedDigest!==expectedHash||unreviewedSecret)throw Error('Uploaded bytes differ from the locally authorized projection');
 const sessionData=await page.evaluate(()=>Object.values(sessionStorage).join(' '));
 if(sessionData.includes(sensitive)||sessionData.includes('Say a short greeting. Contact:'))throw Error('Raw input or review terms persisted');
 console.log(JSON.stringify({default_local_only:true,changed_preview_revoked:true,redacted_upload_matches_digest:true,raw_literal_sent:false}));
 await page.getByTestId('quote-maximum').waitFor();const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/jobs'));
 const funding=page.getByRole('region',{name:'原报价资金核对'});await funding.getByText('账户可用余额',{exact:true}).waitFor();
 if(!(await funding.innerText()).includes(f.owner))throw Error('Original personal owner missing from funding view');
 await page.getByRole('button',{name:'确认并提交原请求',exact:true}).click();const response=await submitted;if(response.status()!==200)throw Error('Actual model Job not accepted');const job=await response.json();
 await page.getByTestId('model-result-text').waitFor({timeout:60000});const text=await page.getByTestId('model-result-text').innerText();if(!text.trim())throw Error('No actual model output rendered');
 const base=`/api/v1/owners/${encodeURIComponent(f.owner)}`;
 const metadataResponse=await page.request.get(`${base}/jobs/${encodeURIComponent(job.job_id)}/result`);if(metadataResponse.status()!==200)throw Error('Result metadata denied');const artifact=await metadataResponse.json();
 const content=await page.request.get(`${base}/uploads/${encodeURIComponent(artifact.upload_id)}/content?version_id=${encodeURIComponent(artifact.version_id)}`);if(content.status()!==200)throw Error('Result bytes denied');const bytes=await content.body();
 if(hash(bytes)!==artifact.sha256||bytes.length.toString()!==artifact.size_bytes||JSON.parse(bytes).text!==text)throw Error('Displayed output differs from committed bytes');
 const inputContent=await page.request.get(`${base}/uploads/${encodeURIComponent(input.upload_id)}/content?version_id=${encodeURIComponent(input.version_id)}`);if(inputContent.status()!==200)throw Error('Original input denied');const inputBytes=await inputContent.body();if(hash(inputBytes)!==input.sha256)throw Error('Original input changed');
 write('browser-input.json',inputBytes);write('browser-output.json',bytes);
 await page.getByText(/已记费用/).waitFor();
 const settledResponse=await page.request.get(`${base}/jobs/${encodeURIComponent(job.job_id)}`);const settled=await settledResponse.json();if(settled.settlement_state!=='settled'||settled.charge===null)throw Error('Actual settlement missing');
 const lateWithdrawal=await page.request.post(`${base}/invocations/${encodeURIComponent(job.invocation_id)}/withdraw`,{data:response.request().postDataJSON(),headers:{Origin:origin.origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':response.request().headers()['idempotency-key']}});
 if(lateWithdrawal.status()!==200)throw Error('Late withdrawal reconciliation failed');const retained=await lateWithdrawal.json();if(retained.prevented||retained.job?.execution_state!=='succeeded'||retained.job?.charge!==settled.charge)throw Error('Late withdrawal changed committed delivery or charge');
 await page.screenshot({path:resolve(dirname(file),'browser-model-result.png'),fullPage:true});
 const removed=await page.request.delete(`${base}/uploads/${encodeURIComponent(input.upload_id)}`,{headers:{Origin:origin.origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':input.upload_id}});if(removed.status()!==200)throw Error('Actual deletion rejected');
 await page.getByRole('button',{name:'刷新任务'}).click();await page.getByText('结果暂不可读',{exact:true}).waitFor();if(await page.getByTestId('model-result-text').count())throw Error('Deleted source output remained visible');await page.getByRole('heading',{name:'模型任务',exact:true}).waitFor();
 writeFileSync(output,JSON.stringify({prevented_invocation:previewQuote.invocation_id,withdrawal_receipt:withdrawal.receipt_id,late_withdrawal_preserved:true,job_id:job.job_id,invocation_id:job.invocation_id,quote_id:response.request().postDataJSON().quote_id,input_upload_id:input.upload_id,input_version_id:input.version_id,output_artifact_id:artifact.artifact_id,output_sha256:artifact.sha256,text_sha256:hash(Buffer.from(text)),content_denied_after_deletion:true})+'\n',{mode:0o600});
 console.log('PASS actual browser withdrawal barrier, late-submit refusal, upload/quote/confirmation/Job/result, retained late-withdrawal charge and deletion denial; session/price/enrollment fixtures, no real payment or hosted Agent certification');
}catch(error){
 try{if(page){write('browser-error.txt',JSON.stringify({error:String(error),responses:failedResponses,main:await page.locator('main').innerText()})+'\n');await page.screenshot({path:resolve(dirname(file),'browser-failed.png'),fullPage:true});}}catch{}
 throw error;
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
