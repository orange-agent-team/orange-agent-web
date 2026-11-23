import {expect,test,type Page} from '@playwright/test';

async function fixture(page:Page,acceptFirst=false){
  const state={revoked:false,decided:false,version:'1',review:'c'.repeat(64),reads:0,
    writes:[] as {key:string|undefined,body:unknown}[]};
  const op='a'.repeat(64);
  await page.route('**/api/v1/agent/runs/fixture-run/operations**',async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      expect(new URL(req.url()).pathname).toBe('/api/v1/agent/runs/fixture-run/operations/'+op+'/decision');
      state.writes.push({key:req.headers()['idempotency-key'],body:req.postDataJSON()});
      if(state.writes.length===1){
        state.decided=acceptFirst;
        return route.fulfill({status:503,json:{code:'UNAVAILABLE',message:'uncertain fixture',request_id:'fixture',retry_class:'unknown'}});
      }
      state.decided=true;
      return route.fulfill({json:{run_id:'fixture-run',user_id:'fixture-user',owner_id:'fixture-owner',operation_id:op,
        review_digest:state.review,decision:'approve'}});
    }
    expect(req.method()).toBe('GET');state.reads++;
    return route.fulfill({json:{run_id:'fixture-run',user_id:'fixture-user',owner_id:'fixture-owner',workspace_id:'space',
      capability_id:'cap',execution_digest:'e'.repeat(64),policy_version:'f'.repeat(64),revoked:state.revoked,
      source_available:!state.revoked,data:[{operation_id:op,approval_id:'b'.repeat(64),tool_name:'list_directory',
        tool_version:'list.v1',argument_digest:'d'.repeat(64),review_digest:state.review,version:state.version,
        commit_id:'fixture-commit',state:'intended',...(state.decided?{decision:'approve'}:{}),
        ...(state.revoked?{}:{arguments:{path:'.',limit:1}})}]}});
  });
  await page.goto('/tests/hosted-approval/component.html');
  await page.getByRole('button',{name:'批准本次目录读取'}).click();
  return state;
}

test('uncertain review uses a read, and only explicit retry posts the identical original decision',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByRole('button',{name:'核对原决定'})).toBeVisible();
  const reads=state.reads;
  await page.getByRole('button',{name:'核对原决定'}).click();
  await expect(page.getByRole('button',{name:'再次提交原批准'})).toBeVisible();
  expect(state.reads).toBeGreaterThan(reads);
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button',{name:'再次提交原批准'}).click();
  await expect(page.getByText(/已批准/)).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0].key).toBeTruthy();
  expect(state.writes[1]).toEqual(state.writes[0]);
});

test('confirmed decision after a lost response is reconciled without a second write',async({page})=>{
  const state=await fixture(page,true);
  await expect(page.getByText(/已批准/)).toBeVisible();
  await expect(page.getByRole('button',{name:'核对原决定'})).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('hidden approval is discarded and reopening after revocation exposes no old arguments or retry',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByRole('button',{name:'核对原决定'})).toBeVisible();
  const hidden=(value:boolean)=>page.evaluate(v=>{
    Object.defineProperty(document,'hidden',{value:v,configurable:true});
    document.dispatchEvent(new Event('visibilitychange'));
  },value);
  await hidden(true);
  await expect(page.getByLabel('工具参数')).toHaveCount(0);
  state.revoked=true;
  await hidden(false);
  await expect(page.getByText(/权限已撤销/)).toBeVisible();
  await expect(page.getByLabel('工具参数')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'核对原决定'})).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('changed reviewed content invalidates a previously reconciled retry',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'核对原决定'}).click();
  await expect(page.getByRole('button',{name:'再次提交原批准'})).toBeVisible();
  state.version='2';state.review='9'.repeat(64);
  await expect(page.getByText('审核摘要 '+state.review)).toBeVisible();
  await expect(page.getByRole('button',{name:'再次提交原批准'})).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
