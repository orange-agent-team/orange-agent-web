// Actual Chrome with explicit API/model/settlement substitutes only.
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Artifact, Job, Quote, Upload } from '../../src/api/compute-contracts';
const session={session_id:'compute-session',user_id:'compute-user',personal_owner_id:'compute-owner',csrf_token:'c'.repeat(43),expires_at:'2099-01-01T00:00:00Z'};
const price={price_version:'price-fixture',model_version:'model-fixture',node_id:'node-fixture',meter_profile_digest:'b'.repeat(64),input_price:'2000',output_price:'6000',output_limit:'32',fee_bps:2000};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(page:Page,options:{loss?:'after'|'before';running?:boolean;empty?:boolean;balance?:string}={}){
 const state={job:null as Job|null,input:null as Artifact|null,upload:null as Upload|null,request:null as {invocation_id:string;tools:unknown[]}|null,quote:null as Quote|null,prevented:false,submission:null as unknown,submits:0,binds:0,cancels:0,deletes:0,lookups:0,deleted:false,loss:options.loss,keys:[] as string[],quoteKeys:[] as string[]};
 const result=Buffer.from(JSON.stringify({response_id:'response-fixture',text:'Hello <script data-model-danger>window.MODEL_EXECUTED=true</script>',tool_calls:[],native_usage:null,finish_reason:'stop'}));
 const output:Artifact={upload_id:'output-fixture',artifact_id:'output-artifact',version_id:'output-version',owner_id:session.personal_owner_id,sha256:digest(result),size_bytes:result.length.toString(),media_type:'application/vnd.orange.model-response+json',state:'available'};
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  const send=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'Cache-Control':'no-store'}});
  const error=(code:string,status:number)=>send({code,message:'explicit test substitute',request_id:'error-fixture',retry_class:'never'},status);
  if(['POST','PUT','DELETE'].includes(method)){expect(request.headers()['x-csrf-token']).toBe(session.csrf_token);expect(request.headers()['authorization']).toBeUndefined();expect(request.headers()['idempotency-key']).toBeTruthy();}
  if(path==='/api/v1/session')return send(session);
  if(path==='/api/v1/account/wallet')return send({user_id:session.user_id,owner_id:session.personal_owner_id,gift:options.balance??'1000',earned:'0',purchased:'0',reserved_gift:'0',reserved_earned:'0',reserved_purchased:'0',pending_earned:'0'});
  if(path==='/api/v1/account/budgets')return send({user_id:session.user_id,owner_id:session.personal_owner_id,data:[{root_budget_id:'budget-fixture',scope_id:'scope',limit:'1000',spent:'0',reserved:'0',status:'active'}],next_cursor:null});
  if(path==='/api/v1/text-prices')return send(options.empty?[]:[price]);
  if(path.includes('/jobs/by-invocation/')){state.lookups++;return state.job?send({owner_id:session.personal_owner_id,user_id:session.user_id,quote_id:state.quote!.quote_id,job:state.job}):error('NOT_FOUND',404);}
  if(path.endsWith('/uploads')&&method==='POST'){
   const upload=request.postDataJSON() as Upload;if(!state.upload){state.upload=upload;state.input={...upload,artifact_id:'input-artifact',version_id:'input-version',owner_id:session.personal_owner_id,state:'staging'};}else expect(upload).toEqual(state.upload);return send(state.input);
  }
  if(path.includes('/uploads/')&&path.endsWith('/content')&&method==='PUT'){
   const bytes=request.postDataBuffer()!;expect(digest(bytes)).toBe(state.upload!.sha256);expect(bytes.length.toString()).toBe(state.upload!.size_bytes);state.request=JSON.parse(bytes.toString());expect(state.request!.tools).toEqual([]);state.input!.state='available';return send(state.input);
  }
  if(path.endsWith('/quotes/quote-fixture/funding')&&method==='GET'&&state.quote){
   const q=state.quote,amount=options.balance??'1000';
   return send({quote_id:q.quote_id,requester_id:session.user_id,owner_id:session.personal_owner_id,root_budget_id:q.root_budget_id,account_kind:'personal',price_version:q.price_version,
     max_microcredits:q.max_amount,budget_limit:'1000',budget_spent:'0',budget_reserved:'0',budget_remaining:'1000',wallet_available:amount,
     status:BigInt(amount)<BigInt(q.max_amount)?'insufficient_funds':'sufficient',observed_unix:Math.floor(Date.now()/1000).toString(),expires_unix:q.expires_at_unix});
  }
  if(path.endsWith('/text-quotes')&&method==='POST'){
   const body=request.postDataJSON();expect(body.input_upload_id).toBe(state.upload!.upload_id);expect(body.input_version_id).toBe(state.input!.version_id);state.quoteKeys.push(request.headers()['idempotency-key']);
   state.quote??={quote_id:'quote-fixture',root_budget_id:'budget-fixture',invocation_id:state.request!.invocation_id,price_version:price.price_version,request_projection_digest:'a'.repeat(64),meter_profile_digest:price.meter_profile_digest,input_units:'10',output_limit:'32',max_amount:'100',expires_at_unix:'4102444800'};return send(state.quote,201);
  }
  if(path.endsWith('/withdraw')&&method==='POST'){
   expect(request.postDataJSON().invocation_id).toBe(state.request!.invocation_id);expect(request.postDataJSON().quote_id).toBe(state.quote!.quote_id);
   if(state.job){if(['queued','running'].includes(state.job.execution_state))state.job.execution_state='cancelling';return send({owner_id:session.personal_owner_id,user_id:session.user_id,invocation_id:state.request!.invocation_id,quote_id:state.quote!.quote_id,prevented:false,receipt_id:null,job:state.job});}
   state.prevented=true;return send({owner_id:session.personal_owner_id,user_id:session.user_id,invocation_id:state.request!.invocation_id,quote_id:state.quote!.quote_id,prevented:true,receipt_id:'withdraw-receipt',job:null});
  }
  if(path.endsWith('/jobs')&&method==='POST'){
   state.submits++;state.submission=request.postDataJSON();state.keys.push(request.headers()['idempotency-key']);if(state.prevented)return error('INVOCATION_WITHDRAWN',409);expect(request.postDataJSON().quote_id).toBe(state.quote!.quote_id);
   if(state.loss==='before'){state.loss=undefined;return route.abort('failed');}
   state.job??={job_id:'job-fixture',root_budget_id:'budget-fixture',invocation_id:state.request!.invocation_id,execution_state:'queued',settlement_state:'pending',reserved:'100',charge:null};
   if(state.loss==='after'){state.loss=undefined;return route.abort('failed');}return send(state.job);
  }
  if(path.endsWith('/jobs')&&method==='GET')return send({owner_id:session.personal_owner_id,user_id:session.user_id,data:state.job?[state.job]:[],next_cursor:null});
  if(path.endsWith('/input')&&method==='POST'){
   state.binds++;expect(request.postDataJSON()).toEqual({upload_id:state.upload!.upload_id,version_id:state.input!.version_id});state.job!.execution_state=options.running?'running':'succeeded';state.job!.settlement_state=options.running?'pending':'settled';state.job!.charge=options.running?null:'37';
   return send({job_id:state.job!.job_id,artifact_id:state.input!.artifact_id,version_id:state.input!.version_id,sha256:state.input!.sha256,size_bytes:state.input!.size_bytes,projection_digest:state.quote!.request_projection_digest});
  }
  if(path.endsWith('/cancel')&&method==='POST'){state.cancels++;expect(request.postDataJSON()).toEqual({});state.job!.execution_state='cancelling';return send(state.job);}
  if(path.endsWith('/result'))return state.deleted?error('FORBIDDEN',403):send(output);
  if(path.endsWith('/uploads/output-fixture/content'))return state.deleted?error('FORBIDDEN',403):route.fulfill({status:200,contentType:'application/octet-stream',body:result,headers:{'Content-Length':result.length.toString()}});
  if(path.endsWith('/jobs/job-fixture'))return send(state.job);
  if(path.includes('/uploads/')&&method==='DELETE'){state.deletes++;state.input!.state='deleted';return send(state.input);}
  return error('UNIMPLEMENTED_FIXTURE',500);
 });return state;
}
async function quote(page:Page){await page.goto('/tasks');await page.getByRole('combobox',{name:'个人预算'}).selectOption('budget-fixture');await page.getByRole('combobox',{name:'可用模型'}).selectOption('price-fixture');await page.getByRole('textbox',{name:'任务文本',exact:true}).fill('PRIVATE PROMPT FOR THIS TASK');await expect(page.getByRole('button',{name:'批准上传并获取报价'})).toBeDisabled();await page.getByRole('combobox',{name:'文本处理方式'}).selectOption('original');await page.getByRole('button',{name:'在本机生成上传预览'}).click();await expect(page.getByRole('region',{name:'上传内容预览'})).toContainText('PRIVATE PROMPT FOR THIS TASK');await page.getByRole('button',{name:'批准上传并获取报价',exact:true}).click();await expect(page.getByTestId('quote-maximum')).toContainText('0.0001');}
test('lost accepted response recovers read-only, binds once, renders text safely and clears revoked content',async({page})=>{
 const state=await fixture(page,{loss:'after'});await quote(page);expect(state.submits).toBe(0);await page.getByRole('button',{name:'确认并提交原请求'}).click();await expect(page.getByText('操作待核对', {exact:true})).toBeVisible();expect(state.submits).toBe(1);
 await page.reload();await page.getByRole('button',{name:'核对原任务',exact:true}).click();await expect(page.getByTestId('model-result-text')).toContainText('Hello <script');expect(state.submits).toBe(1);expect(state.binds).toBe(1);expect(await page.evaluate(()=>Object.hasOwn(window,'MODEL_EXECUTED'))).toBe(false);await expect(page.locator('script[data-model-danger]')).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain('PRIVATE PROMPT FOR THIS TASK');
 await page.screenshot({path:'test-results-compute/model-task.png',fullPage:true});state.deleted=true;await page.getByRole('button',{name:'刷新任务'}).click();await expect(page.getByText('结果暂不可读',{exact:true})).toBeVisible();await expect(page.getByTestId('model-result-text')).toHaveCount(0);await expect(page.getByRole('heading',{name:'模型任务',exact:true})).toBeVisible();
});
test('unaccepted unknown response is never automatically resubmitted on reload',async({page})=>{
 const state=await fixture(page,{loss:'before'});await quote(page);await page.getByRole('button',{name:'确认并提交原请求'}).click();await expect(page.getByText('操作待核对',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'核对原任务',exact:true}).click();await expect(page.getByTestId('quote-maximum')).toBeVisible();expect(state.submits).toBe(1);expect(state.binds).toBe(0);
 await page.getByRole('button',{name:'停止原请求'}).click();await expect(page.getByRole('button',{name:'批准上传并获取报价',exact:true})).toBeVisible();expect(state.submits).toBe(1);expect(state.prevented).toBe(true);expect(state.job).toBeNull();
 const late=await page.evaluate(async value=>(await fetch('/api/v1/owners/'+value.owner+'/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':value.csrf,'Idempotency-Key':value.key},body:JSON.stringify(value.body)})).status,{owner:session.personal_owner_id,csrf:session.csrf_token,key:state.keys[0],body:state.submission});expect(late).toBe(409);expect(state.job).toBeNull();
});
test('insufficient credits block confirmation and an unsubmitted input can be deleted',async({page})=>{
 const state=await fixture(page,{balance:'0'});await quote(page);await expect(page.getByRole('button',{name:'确认并提交原请求'})).toBeDisabled();await page.getByRole('button',{name:'删除未提交输入'}).click();await expect(page.getByRole('button',{name:'批准上传并获取报价',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'批准上传并获取报价',exact:true})).toHaveAttribute('aria-busy','false');expect(state.submits).toBe(0);expect(state.deletes).toBe(1);
});
test('running cancellation remains pending until an independent terminal fact arrives',async({page})=>{
 const state=await fixture(page,{running:true});await quote(page);await page.getByRole('button',{name:'确认并提交原请求'}).click();await page.getByRole('button',{name:'取消任务',exact:true}).click();await expect(page.getByText('取消请求已接收，执行终止和积分释放仍待确认。')).toBeVisible();expect(state.job!.settlement_state).toBe('pending');expect(state.job!.charge).toBeNull();expect(state.cancels).toBe(1);
 state.job!.execution_state='cancelled';state.job!.settlement_state='settled';state.job!.charge='0';await page.getByRole('button',{name:'刷新任务'}).click();await expect(page.getByText(/已记费用 0 积分/)).toBeVisible();expect(state.submits).toBe(1);
});

test('returning to a job cannot redisplay the previous result after its read grant is revoked',async({page})=>{
 const state=await fixture(page);
 await page.routeWebSocket('**/events/ws*',()=>{});
 await quote(page);
 await page.getByRole('button',{name:'确认并提交原请求'}).click();
 const content=page.getByTestId('model-result-text');
 await expect(content).toContainText('Hello <script');
 const setHidden=(hidden:boolean)=>page.evaluate(value=>{
   Object.defineProperty(document,'hidden',{value,configurable:true});
   document.dispatchEvent(new Event('visibilitychange'));
 },hidden);
 await setHidden(true);
 await expect(content).toHaveCount(0);
 state.deleted=true;
 await setHidden(false);
 await expect(page.getByText('结果暂不可读',{exact:true})).toBeVisible();
 await expect(content).toHaveCount(0);
 expect(state.submits).toBe(1);
 expect(state.cancels).toBe(0);
});

test('source details identify the exact current offer and clear an earlier match when terms change', async ({page}) => {
  const state = await fixture(page);
  let matches = true;
  let reads = 0;
  await page.route('**/api/v1/models', async route => {
    reads++;
    expect(route.request().method()).toBe('GET');
    await route.fulfill({json: {data: [{modality:'text', model_version:price.model_version,
      model_sha256:'d'.repeat(64), repository:'fixture/model', revision:'a'.repeat(40), license:'Apache-2.0',
      context_tokens:2048, max_request_bytes:262144, offers:[{...price,input_price:matches?'2000':'2001'}]}]}});
  });
  await page.goto('/tasks');
  await page.getByRole('combobox', {name:'可用模型'}).selectOption(price.price_version);
  expect(reads).toBe(0);
  const details = page.getByText('模型来源和计费限制', {exact:true});
  await details.click();
  await expect(page.getByText('Apache-2.0', {exact:true})).toBeVisible();
  await expect(page.getByText('输入 0.002 积分，输出 0.006 积分', {exact:true})).toBeVisible();
  await details.click();
  matches = false;
  await details.click();
  await expect(page.getByText('当前价格版本没有匹配的已审核模型记录。')).toBeVisible();
  await expect(page.getByText('Apache-2.0', {exact:true})).toHaveCount(0);
  expect(state.quoteKeys).toHaveLength(0);
  expect(state.submits).toBe(0);
});
