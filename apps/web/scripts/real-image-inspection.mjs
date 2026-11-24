// Exercise the installed portal and real development API. Only delivery timing is controlled.
import {chromium, expect} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

let input = '';
for await (const part of process.stdin) input += part;
const f = JSON.parse(input);
const upstream = new URL(f.api);
if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port ||
    new URL(f.authorityOrigin).hostname !== '127.0.0.1') throw Error('Disposable loopback fixture required');
const root = fileURLToPath(new URL('../', import.meta.url));
const tls = f.tls ?? resolve(root, '../../.local/tls');
const server = await preview({root, configFile:false, logLevel:'silent', build:{outDir:f.staticRoot ?? 'dist'},
  preview:{host:'127.0.0.1',port:0,https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
    proxy:{'/api/v1/':{target:upstream.origin,changeOrigin:false,ws:true}}}});
const origin = 'https://127.0.0.1:'+server.httpServer.address().port;
let browser;
try {
  browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({ignoreHTTPSErrors:true});
  await context.addCookies([{name:'__Host-orange-user',value:f.token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page = await context.newPage();
  const writes = [];
  page.on('request', r => {if(new URL(r.url()).pathname.startsWith('/api/') && !['GET','HEAD'].includes(r.method())) writes.push(r.method());});
  await page.goto(origin+'/tasks');
  const summary = page.getByText('核对已存图像',{exact:true});
  const box = page.getByRole('textbox',{name:'图像上传记录 ID'});
  const inspect = page.getByRole('button',{name:'校验 PNG'});
  const receipt = page.getByLabel('图像校验结果');
  await summary.click();
  await box.fill(f.upload);
  await inspect.click();
  await expect(receipt).toContainText(f.version);
  await expect(receipt).toContainText(f.rgb);
  await expect(receipt).toContainText(f.sha256);
  // A subsequent valid HTTP response from the old request must not repopulate a changed form.
  let got, deliver;
  const arrived = new Promise(done => {got=done});
  const release = new Promise(done => {deliver=done});
  const path = origin+'/api/v1/owners/'+f.owner+'/uploads/'+f.upload+'/image-output-inspection?*';
  const hold = async route => {
    const response = await route.fetch();
    if (response.status()!==200) throw Error('Expected actual authorized image receipt');
    got();
    await release;
    try {await route.fulfill({response});} catch (error) {if (!route.request().failure()) throw error;}
  };
  await page.route(path,hold);
  try {
    await inspect.click();
    await arrived;
    await box.fill('unavailable-image');
    await expect(receipt).toHaveCount(0);
  } finally {
    deliver();
    await page.unroute(path,hold);
  }
  await inspect.click();
  await expect(page.getByText(/无法核对该图像/)).toBeVisible();
  await expect(receipt).toHaveCount(0);
  await box.fill(f.upload);
  await inspect.click();
  await expect(receipt).toContainText(f.rgb);
  const revoked = await fetch(upstream.origin+'/api/v1/session',{method:'DELETE',headers:{
    Cookie:'__Host-orange-user='+f.token,Origin:f.authorityOrigin,'X-CSRF-Token':f.csrf,'Idempotency-Key':randomUUID()}});
  if (revoked.status!==204) throw Error('Failed to revoke isolated session: '+revoked.status);
  await inspect.click();
  await expect(receipt).toHaveCount(0);
  await expect(inspect).toHaveCount(0);
  if (writes.length) throw Error('Read-only image page initiated a write');
  console.log(JSON.stringify({actual_chrome:true,inspected:true,delayed_response_retired:true,session_revoked:true,browser_api_writes:writes.length}));
} finally {
  if(browser) await browser.close();
  await server.close();
}
