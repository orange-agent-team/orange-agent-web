import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

let text='';
for await(const chunk of process.stdin)text+=chunk;
const f=JSON.parse(text);
const api=new URL(f.api);
if(f.origin!=='https://127.0.0.1:43122'||api.protocol!=='http:'||api.hostname!=='127.0.0.1'||!api.port)throw Error('Loopback fixture required');
const root=fileURLToPath(new URL('../',import.meta.url)),tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
  https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const ctx=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true});
  await ctx.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await ctx.newPage();page.setDefaultTimeout(16000);
  await page.goto('/account');
  const expand=page.locator('summary').filter({hasText:'个人自动化密钥'});
  await expand.click();
  const name=page.getByLabel('密钥名称');
  await name.fill('日报');
  await page.getByLabel('读取权限').selectOption('budgets:read');
  let writes=0,firstID,firstBody,receipt,later;
  await page.route('**/api/v1/account/api-keys/*',async route=>{
    const req=route.request();
    if(req.method()!=='PUT')return route.continue();
    const id=req.headers()['idempotency-key'],body=req.postData();
    if(body.includes('oa1.'))throw Error('Raw secret entered registration transport');
    writes++;
    if(writes===1){
      firstID=id;firstBody=body;
      const response=await route.fetch();receipt=await response.json();
      if(response.status()!==200||receipt.status!=='active'||receipt.verifier!==undefined)throw Error('Original registration failed');
      return route.abort('failed');
    }
    if(writes===2){
      if(id!==firstID||body!==firstBody)throw Error('Uncertain issuance rotated the original credential');
      return route.continue();
    }
    later={url:req.url(),body:req.postDataJSON(),csrf:req.headers()['x-csrf-token'],id};
    return route.abort('failed');
  });
  await page.getByRole('button',{name:'创建只读密钥'}).click();
  await page.getByRole('button',{name:'重试原登记'}).click();
  const shown=page.getByLabel('新建的自动化密钥');await shown.waitFor();
  const token=await shown.inputValue();
  if(createHash('sha256').update(token).digest('hex')!==JSON.parse(firstBody).verifier || receipt.key_id!==firstID)throw Error('Displayed credential does not match its registration');
  const read=async path=>fetch(api.origin+path,{headers:{Authorization:'Bearer '+token}});
  const pageResult=await read('/api/v1/automation/account/budgets');
  if(pageResult.status!==200||(await pageResult.json()).user_id!==f.user||(await read('/api/v1/automation/account/wallet')).status!==403)throw Error('Credential scope is incorrect');
  if(await page.evaluate(value=>[sessionStorage,localStorage].some(s=>Object.values(s).some(v=>String(v).includes(value))),token))throw Error('Raw credential persisted in browser storage');
  await expand.click();await expand.click();
  if(await shown.count())throw Error('Secret redisplayed after leaving view');
  await page.getByRole('button',{name:'撤销这次登记'}).click();
  await page.getByRole('button',{name:'确认撤销密钥'}).click();
  await name.waitFor();
  if((await read('/api/v1/automation/account/budgets')).status!==401)throw Error('Revocation did not close the read');
  await name.fill('撤回');
  await page.getByRole('button',{name:'创建只读密钥'}).click();
  await page.getByRole('button',{name:'重试原登记'}).waitFor();
  await page.getByRole('button',{name:'撤销这次登记'}).click();await page.getByRole('button',{name:'确认撤销密钥'}).click();
  await name.waitFor();
  const delayed=await ctx.request.put(later.url,{headers:{Origin:f.origin,'X-CSRF-Token':later.csrf,'Idempotency-Key':later.id},data:later.body});
  if(delayed.status()!==409)throw Error('Withdrawn unissued credential could be recreated');
  await page.unroute('**/api/v1/account/api-keys/*');
  await name.fill('换发验证');
  await page.getByLabel('读取权限').selectOption('wallet:read');
  await page.getByRole('button',{name:'创建只读密钥'}).click();
  await shown.waitFor();
  const predecessor=await shown.inputValue();
  const use=async bearer=>(await fetch(api.origin+'/api/v1/automation/account/wallet',{headers:{Authorization:'Bearer '+bearer}})).status;
  if(await use(predecessor)!==200)throw Error('Original key was not usable');
  await page.getByRole('button',{name:'我已保存'}).click();
  await page.getByRole('button',{name:'换发 换发验证',exact:true}).click();
  let replacements=0,successorId,registration;
  await page.route('**/api/v1/account/api-keys/*/replacements/*',async route=>{
    const req=route.request();replacements++;
    if(req.method()!=='PUT'||req.postData().includes('oa1.'))throw Error('Invalid replacement transport');
    if(replacements===1){
      successorId=req.headers()['idempotency-key'];registration=req.postData();
      const reply=await route.fetch();
      if(reply.status()!==200||(await reply.json()).key_id!==successorId||await use(predecessor)!==401)throw Error('Original still usable after replacement');
      return route.abort('failed');
    }
    if(req.headers()['idempotency-key']!==successorId||registration!==req.postData())throw Error('Replacement retry changed identity');
    return route.continue();
  });
  await page.getByRole('button',{name:'确认换发密钥'}).click();
  await page.getByRole('button',{name:'重试原登记'}).click();
  await shown.waitFor();
  const successor=await shown.inputValue();
  if(replacements!==2||successor===predecessor||await use(successor)!==200||await use(predecessor)!==401)throw Error('Rotation did not preserve exactly one usable key');
  await page.getByRole('button',{name:'我已保存'}).click();
  await page.getByRole('button',{name:'撤销 换发验证',exact:true}).click();
  await page.getByRole('button',{name:'确认撤销密钥'}).click();
  await page.getByRole('button',{name:'撤销 换发验证',exact:true}).waitFor({state:'hidden'});
  if(await use(successor)!==401)throw Error('Successor withdrawal failed');
  console.log(JSON.stringify({real_browser:true,lost_response_same_key:true,budget_read:true,wallet_scope_denied:true,
    no_secret_in_web_storage:true,reopening_hides_secret:true,revoke_denied_future_reads:true,withdraw_before_create:true,original_revoked_at_replacement:true,recovered_successor:true,successor_withdrawn:true}));
}finally{await browser?.close();await server.close();}
