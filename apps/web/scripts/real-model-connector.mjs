// Calls go through the built user Web and the actual private user API. No browser routes are mocked.
export async function exerciseConnectorModel({page,ctx,origin,f,headers}){
  const runs=[];
  const repository=f.repository_provider;
  if(repository && !['github','gitlab'].includes(repository))throw Error('Unknown provider fixture');
  const family=repository??'s3';
  const name=family==='github'?'list_repositories':family==='gitlab'?'list_projects':'list_objects';
  if(repository)await page.getByLabel('允许此运行向已登记的第三方仓库发送查询').check();
  await page.getByLabel('最大输出单位').fill('128');
  await page.getByLabel('最大输出单位').press('Tab');
  await page.getByRole('combobox',{name:'连接器工具'}).click();
  await page.locator('.ant-select-item-option-content').filter({hasText:family+' · '+name}).click();
  for(const approved of [true,false]){
    await page.getByRole('button',{name:'刷新托管运行'}).click();
    await page.getByRole('textbox',{name:'运行输入'}).fill(repository?`Call the ${name} function with page 1 and limit 2. Return the function call now.`:'Call the list_objects function now with limit 2. Make a function call. Do not answer in text.');
    const reserved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/agent/runs');
    await page.getByRole('button',{name:'保存输入并预留工作区'}).click();
    const run=await (await reserved).json();
    if(!run.run_id)throw Error('Connector model Run refused: '+run.code);
    const base='/api/v1/agent/runs/'+run.run_id;
    const quoted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/model/quotes');
    await page.getByRole('button',{name:'获取模型报价'}).click();
    const quote=await (await quoted).json();
    if(!quote.quote_id)throw Error('Connector quote refused: '+String(quote.code));
    const grantBase=base+'/connectors/'+family;
    const sources=await (await ctx.request.get(origin+grantBase)).json();
    const source=sources.sources.find(s=>s.source_id===(repository??'documents'));
    if(!source)throw Error('Missing private registered source');
    const grant=await (await ctx.request.post(origin+grantBase,{headers:headers(crypto.randomUUID()),data:{source_id:source.source_id,source_digest:source.source_digest,...(repository?{repository_ids:['17']}:{}),duration_seconds:300}})).json();
    if(!grant.grant_id)throw Error('No user Run grant');
    const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/model/submit');
    await page.getByRole('button',{name:'确认报价并提交模型作业'}).click();
    const job=await (await submitted).json();
    if(!job.job_id)throw Error('No committed connector Job');
    const approve=page.getByRole('button',{name:'批准此次连接器调用'});
    await approve.waitFor({timeout:90000});
    const path=base+'/model/connector';
    const op=await (await ctx.request.get(origin+path)).json();
    if(op.state!=='waiting_approval'||op.tool!==name||op.connector!==family||op.arguments.limit!==2||(repository&&op.arguments.page!==1)||op.result||!op.commit_id)throw Error('Invalid source call preview');
    const invalid=await ctx.request.post(origin+path,{headers:headers(crypto.randomUUID()),data:{operation_id:op.operation_id,argument_digest:'0'.repeat(64),decision:'approve',grant_id:grant.grant_id}});
    if(invalid.status()!==409)throw Error('Stale operation allowed');
    if(approved){
      await page.getByRole('combobox',{name:'此次调用使用的授权'}).click();
      await page.locator('.ant-select-item-option-content').filter({hasText:grant.grant_id}).click();
    }
    const resultResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===path);
    await (approved?approve:page.getByRole('button',{name:'拒绝此次连接器调用'})).click();
    const response=await resultResponse;
    const result=await response.json();
    if(result.state!==(approved?'succeeded':'rejected'))throw Error('Source dispatch disposition: '+JSON.stringify({code:result.code,state:result.state}));
    const req=response.request(),idKey=(await req.allHeaders())['idempotency-key'];
    const again=await ctx.request.post(origin+path,{headers:headers(idKey),data:req.postDataJSON()});
    const recovered=await again.json();
    if(again.status()!==200||recovered.operation_id!==op.operation_id||recovered.state!==result.state)throw Error('Stored decision not recoverable');
    if(approved){
      if(repository){
        const rows=result.result?.data.data;
        if(rows?.length!==1||rows[0].id!=='17'||rows[0].path!=='acme/notes'||rows[0].default_branch!=='main')
          throw Error('Approved result must contain exactly the registered repository');
        await page.locator('pre').filter({hasText:'acme/notes'}).waitFor();
      } else {
      if(JSON.stringify(result.result?.data.keys)!==JSON.stringify(['a.txt','b.txt']))throw Error('Genuine S3 fixture keys required');
      await page.locator('pre').filter({hasText:'a.txt'}).waitFor();
      }
      await page.screenshot({path:f.connector_screenshot,fullPage:true});
      const revoked=await ctx.request.delete(origin+grantBase+'/'+grant.grant_id,{headers:headers(crypto.randomUUID())});
      if(revoked.status()!==204)throw Error('Revoke failed');
      const hidden=await (await ctx.request.get(origin+path)).json();
      if(hidden.result||hidden.arguments||!hidden.source_unavailable)throw Error('Revoked model connector content visible');
    }else if(result.result)throw Error('Rejected operation returned rows');
    const entry=page.locator('section').filter({has:page.getByRole('heading',{name:run.run_id,exact:true})});
    await entry.getByText(/工作区已回收/).waitFor({timeout:60000});
    runs.push({run_id:run.run_id,job_id:job.job_id,commit_id:op.commit_id,operation_id:op.operation_id,approved,state:result.state});
  }
  return runs;
}
