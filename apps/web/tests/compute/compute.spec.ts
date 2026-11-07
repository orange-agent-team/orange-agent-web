// Actual Chrome with explicit API/model/settlement substitutes only.
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Artifact, Job, Quote, Upload } from '../../src/api/compute-contracts';
const session={session_id:'compute-session',user_id:'compute-user',personal_owner_id:'compute-owner',csrf_token:'c'.repeat(43),expires_at:'2099-01-01T00:00:00Z'};
const price={price_version:'price-fixture',model_version:'model-fixture',node_id:'node-fixture',meter_profile_digest:'b'.repeat(64),input_price:'2000',output_price:'6000',output_limit:'32',fee_bps:2000};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(page:Page,options:{loss?:'after'|'before';running?:boolean;empty?:boolean;balance?:string}={}){
 const state={job:null as Job|null,input:null as Artifact|null,upload:null as Upload|null,request:null as {invocation_id:string;tools:unknown[]}|null,quote:null as Quote|null,submits:0,binds:0,cancels:0,deletes:0,lookups:0,deleted:false,loss:options.loss,keys:[] as string[],quoteKeys:[] as string[]};
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
  if(path.endsWith('/text-quotes')&&method==='POST'){
   const body=request.postDataJSON();expect(body.input_upload_id).toBe(state.upload!.upload_id);expect(body.input_version_id).toBe(state.input!.version_id);state.quoteKeys.push(request.headers()['idempotency-key']);
   state.quote??={quote_id:'quote-fixture',root_budget_id:'budget-fixture',invocation_id:state.request!.invocation_id,price_version:price.price_version,request_projection_digest:'a'.repeat(64),meter_profile_digest:price.meter_profile_digest,input_units:'10',output_limit:'32',max_amount:'100',expires_at_unix:'4102444800'};return send(state.quote,201);
  }
  if(path.endsWith('/jobs')&&method==='POST'){
   state.submits++;state.keys.push(request.headers()['idempotency-key']);expect(request.postDataJSON().quote_id).toBe(state.quote!.quote_id);
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
async function quote(page:Page){await page.goto('/tasks');await page.getByRole('combobox',{name:'个人预算'}).selectOption('budget-fixture');await page.getByRole('combobox',{name:'可用模型'}).selectOption('price-fixture');await page.getByRole('textbox',{name:'任务文本',exact:true}).fill('PRIVATE PROMPT FOR THIS TASK');await page.getByRole('button',{name:'获取报价',exact:true}).click();await expect(page.getByTestId('quote-maximum')).toContainText('0.0001');}
test('lost accepted response recovers read-only, binds once, renders text safely and clears revoked content',async({page})=>{
 const state=await fixture(page,{loss:'after'});await quote(page);expect(state.submits).toBe(0);await page.getByRole('button',{name:'确认并提交原请求'}).click();await expect(page.getByText('操作待核对', {exact:true})).toBeVisible();expect(state.submits).toBe(1);
 await page.reload();await page.getByRole('button',{name:'核对原任务',exact:true}).click();await expect(page.getByTestId('model-result-text')).toContainText('Hello <script');expect(state.submits).toBe(1);expect(state.binds).toBe(1);expect(await page.evaluate(()=>Object.hasOwn(window,'MODEL_EXECUTED'))).toBe(false);await expect(page.locator('script[data-model-danger]')).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain('PRIVATE PROMPT FOR THIS TASK');
 await page.screenshot({path:'test-results-compute/model-task.png',fullPage:true});state.deleted=true;await page.getByRole('button',{name:'刷新任务'}).click();await expect(page.getByText('结果暂不可读',{exact:true})).toBeVisible();await expect(page.getByTestId('model-result-text')).toHaveCount(0);await expect(page.getByRole('heading',{name:'模型任务',exact:true})).toBeVisible();
});
test('unaccepted unknown response is never automatically resubmitted on reload',async({page})=>{
 const state=await fixture(page,{loss:'before'});await quote(page);await page.getByRole('button',{name:'确认并提交原请求'}).click();await expect(page.getByText('操作待核对',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'核对原任务',exact:true}).click();await expect(page.getByTestId('quote-maximum')).toBeVisible();expect(state.submits).toBe(1);expect(state.binds).toBe(0);
 await page.getByRole('button',{name:'停止原请求'}).click();await expect(page.getByText(/停止意图已保留/)).toBeVisible();await expect(page.getByRole('button',{name:'核对原任务',exact:true})).toBeDisabled();expect(state.submits).toBe(1);
});
test('insufficient credits block confirmation and an unsubmitted input can be deleted',async({page})=>{
 const state=await fixture(page,{balance:'0'});await quote(page);await expect(page.getByRole('button',{name:'确认并提交原请求'})).toBeDisabled();await page.getByRole('button',{name:'删除未提交输入'}).click();await expect(page.getByRole('button',{name:'获取报价',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'获取报价',exact:true})).toHaveAttribute('aria-busy','false');expect(state.submits).toBe(0);expect(state.deletes).toBe(1);
});
test('running cancellation remains pending until an independent terminal fact arrives',async({page})=>{
 const state=await fixture(page,{running:true});await quote(page);await page.getByRole('button',{name:'确认并提交原请求'}).click();await page.getByRole('button',{name:'取消任务',exact:true}).click();await expect(page.getByText('取消请求已接收，执行终止和积分释放仍待确认。')).toBeVisible();expect(state.job!.settlement_state).toBe('pending');expect(state.job!.charge).toBeNull();expect(state.cancels).toBe(1);
 state.job!.execution_state='cancelled';state.job!.settlement_state='settled';state.job!.charge='0';await page.getByRole('button',{name:'刷新任务'}).click();await expect(page.getByText(/已记费用 0 积分/)).toBeVisible();expect(state.submits).toBe(1);
});
