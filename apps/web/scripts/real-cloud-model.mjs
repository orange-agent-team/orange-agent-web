import {exerciseConnectorModel} from './real-model-connector.mjs';
import {publishTestMarker} from './publish-test-marker.mjs';
import {continueModel} from './real-continuation.mjs';
// Entire built portal, actual platform workspace and a distinct CPU inference
// Worker. Follow the user's explicit quote approval before any spending effect.
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),tls=resolve(root,'../../.local/tls');
let input='';for await(const b of process.stdin)input+=b;
const f=JSON.parse(input),api=new URL(f.api),origin=f.origin;
if(!['https://127.0.0.1:43127','https://127.0.0.1:43128'].includes(origin)||api.hostname!=='127.0.0.1'||api.protocol!=='http:'||!api.port)throw Error('Loopback user service required');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:Number(new URL(origin).port),strictPort:true,
  https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser,page;
const diagnostics=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const ctx=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:{width:1440,height:1080}});
  await ctx.addCookies([{name:'__Host-orange-user',value:f.cookie.slice('__Host-orange-user='.length),url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  page=await ctx.newPage();page.setDefaultTimeout(60000);
  page.on('pageerror',err=>diagnostics.push({error:String(err)}));
  page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/')&&r.status()>=400)diagnostics.push({path,status:r.status()});});
  let submissions=0;
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/model/submit'))submissions++;});
  await page.goto('/agent');
  await page.getByText(/托管 Host 可接单/).waitFor();
  await page.getByRole('combobox',{name:'运行模式'}).click();
  await page.locator('.ant-select-item-option').filter({hasText:'模型回复'}).click();
  await page.getByRole('combobox',{name:'推理价格版本'}).click();
  await page.locator('.ant-select-item-option').filter({hasText:f.price}).click();
  await page.getByRole('textbox',{name:'运行输入'}).fill('Give a short greeting in English.');
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/content'));
  const reservation=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/agent/runs');
  await page.getByRole('button',{name:'保存输入并预留工作区'}).click();
  const uploaded=await (await saved).json(),rr=await reservation,run=await rr.json();
  if(rr.status()!==201||run.input_version_id!==uploaded.version_id||uploaded.media_type!=='application/json'||run.user_id!==f.user)throw Error('Model request not bound to the reserved source');
  const path='/api/v1/agent/runs/'+run.run_id+'/model';
  const walletPath=origin+'/api/v1/account/wallet',before=await (await ctx.request.get(walletPath)).json();
  const quoteReply=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path+'/quotes',{timeout:90000});
  await page.getByRole('button',{name:'获取模型报价'}).click();
  const qr=await quoteReply,quote=await qr.json();
  if(qr.status()!==200||quote.price_version!==f.price||quote.root_budget_id!==f.budget||submissions!==0)throw Error('Preview or budget mismatch before confirmation');
  await page.getByRole('region',{name:'本次模型报价'}).waitFor();
  const who=await (await ctx.request.get(origin+'/api/v1/session')).json();
  const headers=key=>({'Content-Type':'application/json',Origin:origin,'X-CSRF-Token':who.csrf_token,'Idempotency-Key':key});
  const confirmBody={quote_id:quote.quote_id,request_projection_digest:quote.request_projection_digest,max_amount:quote.max_amount};
  const changed=await ctx.request.post(origin+path+'/submit',{headers:headers('stale-confirmation'),data:{...confirmBody,max_amount:String(BigInt(quote.max_amount)+1n)}});
  if(changed.status()!==409)throw Error('Stale maximum was accepted');
  const generic=await ctx.request.post(origin+'/api/v1/owners/'+f.owner+'/jobs',{headers:headers('wrong-origin'),data:{
    quote_id:quote.quote_id,root_budget_id:f.budget,invocation_id:quote.invocation_id,request_projection_digest:quote.request_projection_digest,purpose:'primary'}});
  if(generic.status()!==403)throw Error('Cloud quote accepted outside its governed submission');
  const after=await (await ctx.request.get(walletPath)).json();
  if(JSON.stringify(before)!==JSON.stringify(after)||(await ctx.request.get(origin+path+'/result')).ok())throw Error('Preview or rejected submissions changed the wallet or produced output');
  let delivered;
  const committed=new Promise(resolve=>{delivered=resolve;});
  await page.route('**'+path+'/submit',async route=>{
    const response=await route.fetch();
    const job=await response.json();delivered({status:response.status(),job});
    await route.abort('failed');
  });
  await page.getByRole('button',{name:'确认报价并提交模型作业'}).click();
  const {status,job}=await committed;
  if(status!==200||job.invocation_id!==quote.invocation_id||job.root_budget_id!==f.budget)throw Error('Confirmed model Job mismatch');
  const repeated=await ctx.request.post(origin+path+'/submit',{headers:headers(quote.quote_id),data:confirmBody});
  if(repeated.status()===200){
    if((await repeated.json()).job_id!==job.job_id)throw Error('Retry changed the committed Job');
  }else if(repeated.status()!==409)throw Error('Could not reconcile original confirmation');
  const [resultResponse]=await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname===path+'/result',{timeout:150000}),
    page.getByRole('button',{name:'读取已提交的答复'}).click({timeout:145000})]);
  const result=await resultResponse.json();
  const output=await page.getByLabel('托管模型答复').innerText();
  if(resultResponse.status()!==200||result.job_id!==job.job_id||!output.trim()||output!==result.response.text||result.response.tool_calls.length||submissions!==1)
    throw Error('Actual model response did not match the committed Job');
  const entry=page.locator('section').filter({has:page.getByRole('heading',{name:run.run_id,exact:true})});
  await entry.getByText(/工作区已回收/).waitFor();
  await page.screenshot({path:f.screenshot,fullPage:true});
  // The user's own API exercises source deletion and both previously visible
  // result paths. No browser response for a successful operation is substituted.
  const session=await (await ctx.request.get(origin+'/api/v1/session')).json();
  const read=await ctx.request.get(origin+'/api/v1/owners/'+f.owner+'/jobs/'+job.job_id+'/result');
  const artifact=await read.json();if(read.status()!==200||!artifact.upload_id)throw Error('Original committed output identity missing');
  const contentPath=origin+'/api/v1/owners/'+f.owner+'/uploads/'+artifact.upload_id+'/content?version_id='+encodeURIComponent(artifact.version_id);
  const originalOutput=await ctx.request.get(contentPath);
  const originalInput=await ctx.request.get(origin+'/api/v1/owners/'+f.owner+'/uploads/'+uploaded.upload_id+'/content?version_id='+encodeURIComponent(uploaded.version_id));
  if(originalOutput.status()!==200||originalInput.status()!==200)throw Error('Committed source bytes unavailable before deletion');
  publishTestMarker(f.oracle_input,await originalInput.body());publishTestMarker(f.oracle_output,await originalOutput.body());
  const deletion=await ctx.request.delete(origin+'/api/v1/owners/'+f.owner+'/uploads/'+uploaded.upload_id,{headers:{Origin:origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':uploaded.upload_id}});
  if(deletion.status()!==200)throw Error('Source deletion failed: '+deletion.status());
  await page.getByRole('button',{name:'刷新模型步骤'}).click();
  await page.getByText(/输入或答复已不可用/).waitFor();
  if(await page.getByLabel('托管模型答复').count())throw Error('Stale model answer retained');
  const denied=await ctx.request.get(origin+path+'/result');
  const direct=await ctx.request.get(contentPath);
  if(![403,409,410].includes(denied.status())||![403,409,410].includes(direct.status()))throw Error('Deleted source still exposes derived content');
  const cancelWallet=await (await ctx.request.get(walletPath)).json();
  await page.getByRole('button',{name:'刷新托管运行'}).click();
  await page.getByRole('textbox',{name:'运行输入'}).fill('Do not execute this cancelled model input.');
  const secondCreated=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/agent/runs');
  await page.getByRole('button',{name:'保存输入并预留工作区'}).click();
  const second=await (await secondCreated).json(),secondPath='/api/v1/agent/runs/'+second.run_id+'/model';
  const secondQuote=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===secondPath+'/quotes');
  await page.getByRole('button',{name:'获取模型报价'}).click();
  const quoted=await (await secondQuote).json();
  if(!quoted.quote_id||quoted.invocation_id===quote.invocation_id)throw Error('No independent second quote');
  publishTestMarker(f.gate_quote,quoted.quote_id);
  const until=Date.now()+20000;
  while(!existsSync(f.gate_locked)){if(Date.now()>until)throw Error('Provider control did not reach the pre-start barrier');await new Promise(ok=>setTimeout(ok,50));}
  const secondCommit=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===secondPath+'/submit');
  await page.getByRole('button',{name:'确认报价并提交模型作业'}).click();
  const cr=await secondCommit,queued=await cr.json();
  if(cr.status()!==200||queued.execution_state!=='queued')throw Error('Controlled second Job did not reserve');
  const pendingHistory=await ctx.request.get(origin+secondPath+'/history');
  const history=await pendingHistory.json(),pendingJob=history.turns?.[0]?.job;
  if(pendingHistory.status()!==200||pendingJob?.job_id!==queued.job_id||pendingJob?.settlement_state!=='pending'||pendingJob?.charge_microcredits!==null||
      history.settled_microcredits!=='0'||history.pending_max_microcredits!==quoted.max_amount)throw Error('Pending model history misrepresents the reserve or charge');
  const secondEntry=page.locator('section').filter({has:page.getByRole('heading',{name:second.run_id,exact:true})});
  await secondEntry.getByRole('button',{name:'取消运行'}).click();
  const stopped=page.waitForResponse(r=>r.request().method()==='DELETE'&&new URL(r.url()).pathname==='/api/v1/agent/runs/'+second.run_id);
  await secondEntry.getByRole('button',{name:'确认取消'}).click();
  const sr=await stopped,closed=await sr.json();
  if(sr.status()!==200||closed.status!=='cancelled')throw Error('Cloud model cancellation not committed');
  publishTestMarker(f.gate_release,'cancelled');
  const cancelled=await (await ctx.request.get(origin+'/api/v1/owners/'+f.owner+'/jobs/'+queued.job_id)).json();
  const restored=await (await ctx.request.get(walletPath)).json();
  if(cancelled.execution_state!=='cancelled'||cancelled.settlement_state!=='settled'||cancelled.charge!=='0'||JSON.stringify(cancelWallet)!==JSON.stringify(restored))
    throw Error('Run cancellation did not release the unstarted Job exactly');
  await secondEntry.getByText(/工作区已回收/).waitFor();
  const directoryRuns=[];
  if(f.directory_cases){
    await page.getByRole('checkbox',{name:'允许模型申请查看工作区根目录'}).check();
    await page.getByLabel('最大输出单位').fill('96');await page.getByLabel('最大输出单位').press('Tab');
    for(const scenario of ['approved','rejected','expired_after_dispatch',...(f.continuation_case?['continued']:[])]){
      const decision=scenario==='rejected'?'reject':'approve';
      if(scenario==='continued')await page.getByRole('checkbox',{name:'保留工作区以便使用工具结果继续回答'}).check();
      await page.getByRole('button',{name:'刷新托管运行'}).click();
      await page.getByRole('textbox',{name:'运行输入'}).fill(scenario==='continued'?'Use list_directory with path "." to find the filename in the workspace. After the tool result, answer with the filename.':'Use the list_directory tool now with path "." to list the working directory. Make a tool call. Do not give a text answer.');
      const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith('/content'));
      const reservation=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/agent/runs');
      await page.getByRole('button',{name:'保存输入并预留工作区'}).click();
      const run=await (await reservation).json(),input=await (await saved).json(),base='/api/v1/agent/runs/'+run.run_id;
      const quoteWait=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/model/quotes');
      await page.getByRole('button',{name:'获取模型报价'}).click();const quote=await (await quoteWait).json();
      if(!quote.quote_id)throw Error('Real tool turn not quotable');
      const jobWait=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/model/submit');
      await page.getByRole('button',{name:'确认报价并提交模型作业'}).click();const job=await (await jobWait).json();
      if(!job.job_id)throw Error('Model tool call not submitted');
      const tool=page.getByRole('region',{name:'目录操作'});
      await tool.getByRole('button',{name:'批准本次目录读取'}).waitFor({timeout:100000});
      const first=await (await ctx.request.get(origin+base+'/operations')).json(),op=first.data[0];
      if(op.state!=='intended'||op.decision||op.result||op.arguments?.path!=='.'||!op.commit_id)throw Error('Non-pending operation before approval');
      const decisionPath=base+'/operations/'+op.operation_id+'/decision';
      const stale=await ctx.request.post(origin+decisionPath,{headers:headers('stale-'+decision),data:{decision:'approve',expected_version:op.version,review_digest:'0'.repeat(64)}});
      if(stale.status()!==412)throw Error('Stale proposal accepted');
      if(scenario==='expired_after_dispatch'){
        publishTestMarker(f.expiry_operation,op.operation_id);
        const limit=Date.now()+20000;
        while(!existsSync(f.expiry_locked)){if(Date.now()>limit)throw Error('Uncertain-result control did not acquire its test barrier');await new Promise(ok=>setTimeout(ok,60));}
      }
      const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===decisionPath);
      await tool.getByRole('button',{name:decision==='approve'?'批准本次目录读取':'拒绝本次目录读取'}).click();
      const ack=await pending;if(ack.status()!==200||(await ack.json()).decision!==decision)throw Error('Decision not accepted');
      const entry=page.locator('section').filter({has:page.getByRole('heading',{name:run.run_id,exact:true})});
      if(scenario==='approved'||scenario==='continued'){
        await tool.getByLabel('已提交的目录结果').getByText('input.txt · '+input.size_bytes+' 字节',{exact:true}).waitFor();
        if(scenario==='approved')await page.screenshot({path:f.tool_screenshot,fullPage:true});
      }
      const continuation=scenario==='continued'?await continueModel({page,ctx,origin,f,run,input,job,op,quote,headers}):undefined;
      await entry.getByText(/工作区已回收/).waitFor();
      const outcome=(await (await ctx.request.get(origin+base+'/operations')).json()).data[0];
      const target={approved:'succeeded',rejected:'failed',expired_after_dispatch:'unknown',continued:'succeeded'}[scenario];
      if(outcome.state!==target||(target==='succeeded'?!outcome.result_artifact_id:!!outcome.result))throw Error('Unexpected terminal tool operation: '+outcome.state);
      await page.getByRole('button',{name:'撤销目录权限',exact:true}).click();
      await page.getByRole('button',{name:'确认撤销目录权限'}).click();
      await page.getByText(/权限已撤销/).waitFor();
      const redacted=await (await ctx.request.get(origin+base+'/operations')).json();
      if(!redacted.revoked||redacted.data.some(v=>v.arguments||v.result))throw Error('Revocation did not clear tool content');
      if(continuation){await continuation.verifyRevocation();continuation.evidence.revocation_denied_all_three=true;}
      directoryRuns.push({scenario,decision,continuation:continuation?.evidence,run_id:run.run_id,job_id:job.job_id,operation_id:op.operation_id,commit_id:op.commit_id,
        tool_version:op.tool_version,bytes:input.size_bytes,terminal:outcome.state,revoked_content_cleared:true});
    }
  }
  const connectorRuns=f.connector_case?await exerciseConnectorModel({page,ctx,origin,f,headers}):[];
  process.stdout.write(JSON.stringify({connector_runs:connectorRuns,run_id:run.run_id,workspace_id:run.workspace.workspace_id,job_id:job.job_id,quote_id:quote.quote_id,
    input_version_id:uploaded.version_id,output_version_id:artifact.version_id,model_version:f.model,pending_history_verified:true,directory_runs:directoryRuns,submit_posts:submissions,cancelled_job_id:queued.job_id,cancelled_run_id:second.run_id,unstarted_wallet_restored:true,unchanged_wallet_before_confirm:true,lost_confirmation_recovered:true,
    max_microcredits:quote.max_amount,answer_sha256:createHash('sha256').update(output).digest('hex'),result_denied_after_delete:true})+'\n');
}catch(error){
  if(page) {
    const headings=await page.locator('main h1,main h2,main h3').allTextContents().catch(()=>[]);
    writeFileSync(f.screenshot+'.failure.json',JSON.stringify({error:String(error),diagnostics:diagnostics.slice(-24),headings}),{mode:0o600});
  }
  throw error;
}finally{if(browser)await browser.close();await server.close();}
