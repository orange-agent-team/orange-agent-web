import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const input=createInterface({input:process.stdin,crlfDelay:Infinity});
const lines=input[Symbol.asyncIterator]();
async function take(){const {value,done}=await lines.next();if(done)throw Error('Owner driver closed');return JSON.parse(value);}
function require(value,why){if(!value)throw Error(why);}
async function step(name){console.log(JSON.stringify({step:name}));const next=await take();require(next.continue===name,'Unexpected test phase');}
const f=await take();
const api=new URL(f.api);
require(f.origin==='https://127.0.0.1:43122' && api.hostname==='127.0.0.1' && api.protocol==='http:' && !!api.port,'Local fixture required');
const root=fileURLToPath(new URL('../',import.meta.url));
const tls=resolve(root,'../../.local/tls');
const site=await preview({root,configFile:false,build:{outDir:f.assets},logLevel:'silent',preview:{
  host:'127.0.0.1',port:43122,strictPort:true,https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
  proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser,page;
const diagnostic=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true});
  await context.addCookies([{name:'__Host-orange-user',value:f.login,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  page=await context.newPage();page.setDefaultTimeout(16000);
  page.on("pageerror",e=>diagnostic.push(["script-error",e.name,String(e.message).slice(0,160)]));
  page.on("response",r=>{if(r.status()>=400)diagnostic.push([r.status(),new URL(r.url()).pathname]);});
  const imported=(handoff)=>page.getByLabel('公开交接文件').setInputFiles({name:'handoff.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(handoff))});
  const visible=(name)=>page.getByText(name,{exact:true}).waitFor();
  const button=(name)=>page.getByRole('button',{name,exact:true});
  const enabled=(name)=>page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled),name);
  const path='/api/v1/owners/'+f.owner+'/worker-enrollments/'+f.personal.request.request_id;
  let writes=0,removals=0;
  await page.route('**'+path,async route=>{
    const req=route.request();
    if(req.method()==='DELETE'){removals++;return route.continue();}
    if(req.method()!=='PUT')return route.continue();
    writes++;
    const payload=req.postDataJSON();require(Object.keys(payload).length===2 && payload.exchange_token_sha256===f.personal.exchange_token_sha256 &&
        payload.request.csr_pem===f.personal.request.csr_pem && req.headers()['idempotency-key']===f.personal.request.request_id,'Wrong device intent');
    const answer=await route.fetch(),receipt=await answer.json();
    require(answer.status()===200 && receipt.state==='authorized','Original owner write failed');
    return route.abort('failed');
  });
  await page.goto('/account');await page.getByRole('link',{name:'管理个人设备注册'}).click();
  await imported({...f.personal,private_key:'invalid-secret-field'});await visible('请使用 Worker 导出的公开交接 JSON，并核对请求摘要。');
  await imported({...f.personal,request:{...f.personal.request,csr_sha256:'0'.repeat(64)}});await visible('请使用 Worker 导出的公开交接 JSON，并核对请求摘要。');
  require(writes===0,'Imported an invalid device request');
  await imported(f.personal);
  await visible(f.personal.request.spki_sha256);await enabled('确认授权设备');require(writes===0,'Import authorized the device');
  await button('确认授权设备').click();
  await visible('操作结果尚未确认，请按原请求编号刷新状态。');await visible('已授权，等待签发');
  if(f.screenshot)await page.screenshot({path:f.screenshot,fullPage:true});
  await page.reload();await visible('已授权，等待签发');
  const scopeBookmarks=await page.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('orange.worker-enrollment.v1:')).map(([,v])=>v));
  require(writes===1 && scopeBookmarks.length===1 && scopeBookmarks[0]===f.personal.request.request_id,'Refresh changed original intent or retained excess data');
  await step('personal-authorized');
  await button('读取授权状态').click();await visible('设备已兑换证书');
  await button('撤销设备授权').click();await button('保留授权').click();require(removals===0,'Dismissed confirmation mutated enrollment');
  await button('撤销设备授权').click();await button('确认撤销设备授权').click();await visible('授权已撤销');
  require(removals===1,'Expected one confirmed revocation');
  await step('personal-revoked');
  const teamRoute='/organizations/'+encodeURIComponent(f.org);
  await page.goto(teamRoute);await page.getByRole('link',{name:'管理团队设备注册'}).click();
  await imported(f.team);await enabled('确认授权设备');
  await step('team-preview');
  // Test a form already rendered before the administrator lost their membership role.
  if(await button('确认授权设备').isVisible() && await button('确认授权设备').isEnabled()){
    try {await button('确认授权设备').click({timeout:1200});}
    catch(e){if(await button('确认授权设备').isVisible())throw e;}
  }
  await visible('需要当前团队所有者或管理员权限');
  require(!await button('确认授权设备').count(),'Lost manager still sees an approval control');
  await step('team-denied');
  await page.reload();await imported(f.team);await enabled('确认授权设备');await button('确认授权设备').click();
  await visible('已授权，等待签发');
  await step('team-authorized');
  await button('读取授权状态').click();await visible('授权已撤销');
  require(!await button('确认授权设备').count()||!await button('确认授权设备').isEnabled(),'Regrant revived original signed request');
  console.log(JSON.stringify({step:'verified',personal_writes:writes,personal_revocations:removals,committed_response_lost:true,role_withdrawal:true}));
}catch(e){
  console.error(JSON.stringify({path:page?new URL(page.url()).pathname:null,headings:page?await page.locator('h1,h2').allTextContents():[],
                               errorTypes:diagnostic.slice(-8)}));
  throw e;
}finally{
  input.close();process.stdin.pause();
  if(browser)await browser.close();
  await new Promise(ok=>site.httpServer.close(ok));
}
