import {createHash} from 'node:crypto';

export async function continueModel({page,ctx,origin,f,run,input,job,op,quote,headers}){
  const base='/api/v1/agent/runs/'+run.run_id+'/model',wallet=origin+'/api/v1/account/wallet';
  const priorWallet=await (await ctx.request.get(wallet)).json();
  const prepared=page.waitForResponse(r=>new URL(r.url()).pathname===base+'/continuation'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'用工具结果准备后续答复'}).click();
  const pr=await prepared,step=await pr.json();
  if(pr.status()!==200||step.turn!==2||step.stage!=='ready_to_quote'||step.source_input_version_id!==input.version_id||step.root_budget_id!==f.budget)
    throw Error('Continuation was not bound to the original sources');
  const repeat=await ctx.request.post(origin+base+'/continuation',{headers:headers(run.run_id+':continuation'),data:{}});
  if(repeat.status()!==200||(await repeat.json()).input_version_id!==step.input_version_id)throw Error('Continuation preparation produced a different source');
  const derivedContent=origin+'/api/v1/owners/'+f.owner+'/uploads/'+step.model_input_upload_id+'/content?version_id='+step.input_version_id;
  const derived=await ctx.request.get(derivedContent),request=await derived.json();
  const assistant=request.messages?.find(message=>message.role==='assistant'),toolResult=request.messages?.find(message=>message.role==='tool');
  if(derived.status()!==200||request.invocation_id!==step.invocation_id||request.tools.length||assistant?.tool_calls.length!==1||
      toolResult?.tool_call_id!==assistant.tool_calls[0].id||JSON.parse(toolResult.content).data.entries[0].name!=='input.txt')throw Error('Model history does not contain the approved E03 result');
  if(JSON.stringify(priorWallet)!==JSON.stringify(await (await ctx.request.get(wallet)).json()))throw Error('Preparing the next turn changed funds');
  const nextQuote=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/quotes');
  await page.getByRole('button',{name:'获取模型报价'}).click();const nq=await (await nextQuote).json();
  if(nq.invocation_id!==step.invocation_id||nq.quote_id===quote.quote_id||nq.request_projection_digest!==step.request_projection_digest)
    throw Error('Continuation quote crossed turn identity');
  const nextJob=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/submit');
  const preview=page.getByRole('region',{name:'原报价资金核对'});await preview.getByText('预留本次上限后的预算余量',{exact:true}).waitFor();
  const fundingResponse=await page.request.get(origin+'/api/v1/owners/'+encodeURIComponent(f.owner)+'/quotes/'+encodeURIComponent(nq.quote_id)+'/funding');
  const funding=await fundingResponse.json();
  if(fundingResponse.status()!==200||funding.root_budget_id!==f.budget||BigInt(funding.budget_spent)<=0n||
     BigInt(funding.budget_spent)+BigInt(funding.budget_reserved)+BigInt(funding.budget_remaining)!==BigInt(funding.budget_limit))throw Error('Continuation budget lost the previous turn');
  await page.getByRole('button',{name:'确认报价并提交模型作业'}).click();
  const response=await nextJob,nj=await response.json();
  if(response.status()!==200||nj.job_id===job.job_id||nj.invocation_id!==step.invocation_id)throw Error('Continuation submission failed');
  const [final]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===base+'/result',{timeout:140000}),
    page.getByRole('button',{name:'读取已提交的答复'}).click({timeout:135000})]);
  const result=await final.json(),answer=await page.getByLabel('托管模型答复').innerText();
  if(final.status()!==200||result.job_id!==nj.job_id||answer!==result.response.text||!answer.includes('input.txt'))throw Error('Final model answer did not use the real directory result');
  await page.screenshot({path:f.continuation_screenshot,fullPage:true});
  const history=await (await ctx.request.get(origin+base+'/history')).json();
  if(history.turns.length!==2||history.turns[0].job.job_id!==job.job_id||history.turns[1].job.job_id!==nj.job_id||history.turns[1].outcome!=='final'||
      history.turns[1].parent_operation_id!==op.operation_id||BigInt(history.settled_microcredits)!==history.turns.reduce((sum,t)=>sum+BigInt(t.job.charge_microcredits),0n))
    throw Error('Per-turn accounting differs');
  const out=await (await ctx.request.get(origin+'/api/v1/owners/'+f.owner+'/jobs/'+nj.job_id+'/result')).json();
  const answerContent=origin+'/api/v1/owners/'+f.owner+'/uploads/'+out.upload_id+'/content?version_id='+out.version_id;
  if(!(await ctx.request.get(answerContent)).ok())throw Error('Final result inaccessible before revocation');
  return {
    evidence:{second_job:nj.job_id,second_quote:nq.quote_id,second_invocation:step.invocation_id,derived_version:step.input_version_id,
      settled_microcredits:history.settled_microcredits,answer_sha256:createHash('sha256').update(answer).digest('hex')},
    async verifyRevocation(){
      const blocked=await Promise.all([origin+base+'/result',derivedContent,answerContent].map(path=>ctx.request.get(path)));
      if(blocked.some(r=>![403,409,410].includes(r.status())))throw Error('Revoked lineage exposed a continuation input or output');
      await page.getByText(/输入或答复已不可用/).waitFor();
      if(await page.getByLabel('托管模型答复').count())throw Error('Revoked continuation answer remained visible');
    },
  };
}
