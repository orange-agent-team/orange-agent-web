// Fresh user contexts, actual same-origin HTTPS, and the installed User API. Only one reply is lost by the fixture.
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let input='';
for await (const data of process.stdin) input+=data;
const f=JSON.parse(input);
const origin=new URL(f.origin), upstream=new URL(f.api);
if (origin.protocol!=='https:'||upstream.protocol!=='http:'||[origin,upstream].some(url=>url.hostname!=='127.0.0.1'||!url.port))
  throw Error('Disposable loopback fixture required');
const root=fileURLToPath(new URL('../',import.meta.url));
const server=await preview({root,configFile:false,logLevel:'silent',build:{outDir:f.site},preview:{
  host:'127.0.0.1',port:Number(origin.port),strictPort:true,
  https:{cert:readFileSync(resolve(f.tls,'cert.pem')),key:readFileSync(resolve(f.tls,'key.pem'))},
  proxy:{'/api/v1/':{target:upstream.origin,changeOrigin:false,ws:true}}
}});
let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const image=f.origin+'/organizations/'+f.team+'/images';
  const share='/api/v1/organizations/'+f.team+'/resources/'+f.resource+'/sharing';
  const financial=[];
  async function pageAs(who) {
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    await context.addCookies([{name:'__Host-orange-user',value:who.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
    const tab=await context.newPage();
    tab.on('request',r=>{if(r.method()!=='GET' && /\/(jobs|budgets|quotes|payments)(\/|$)/.test(new URL(r.url()).pathname)) financial.push(r.method());});
    await tab.goto(image);
    return tab;
  }
  async function inspect(page) {
    await page.getByText('核对已存图像',{exact:true}).click();
    await page.getByRole('textbox',{name:'图像上传记录 ID'}).fill(f.upload);
    await page.getByRole('button',{name:'校验 PNG'}).click();
    await expect(page.getByLabel('图像校验结果')).toContainText(f.rgb);
  }
  const reader=await pageAs(f.viewer);
  await inspect(reader);
  await expect(reader.getByRole('link',{name:'管理共享权限'})).toHaveCount(0);
  const finance=await pageAs(f.billing);
  await expect(finance.getByText('当前身份无法读取团队内容')).toBeVisible();
  await expect(finance.getByRole('button',{name:'校验 PNG'})).toHaveCount(0);
  const creator=await pageAs(f.author);
  await inspect(creator);
  await creator.getByRole('link',{name:'管理共享权限'}).click();
  const list=creator.getByRole('list',{name:'当前授权'});
  await expect(list).toContainText(f.viewer.user);
  await creator.getByRole('textbox',{name:'成员用户 ID'}).fill(f.viewer.user);
  await creator.getByRole('combobox',{name:'权限',exact:true}).selectOption('revoke');
  const used=[];
  let lost=false;
  await creator.route(f.origin+share,async route=>{
    if(route.request().method()!=='POST') {await route.continue();return;}
    used.push(route.request().headers()['idempotency-key']);
    if(lost){await route.continue();return;}
    const reply=await route.fetch();
    if(reply.status()!==200)throw Error('Original ACL change was not committed');
    lost=true;await route.abort('failed');
  });
  await creator.getByRole('button',{name:'保存权限'}).click();
  await expect(creator.getByRole('button',{name:'重试同一次更改'})).toBeVisible();
  await creator.getByRole('button',{name:'重试同一次更改'}).click();
  await expect(list).not.toContainText(f.viewer.user);
  if(used.length!==2||!used[0]||used[1]!==used[0])throw Error('Lost ACL receipt replay changed its idempotency key');
  await reader.getByRole('button',{name:'校验 PNG'}).click();
  await expect(reader.getByText(/无法核对该图像/)).toBeVisible();
  await expect(reader.getByLabel('图像校验结果')).toHaveCount(0);
  await reader.goto(f.origin+'/organizations/'+f.team+'/resources/'+f.resource+'/sharing');
  await expect(reader.getByText('当前身份无法管理此资源的共享权限')).toBeVisible();
  if(financial.length)throw Error('Content navigation initiated a financial operation');
  console.log(JSON.stringify({real_chrome:true,team_viewer_without_budget:true,billing_denied:true,creator_revoke:true,
    lost_response_exact_retry:true,revoked_reader_denied:true,financial_writes:0}));
} finally {if(browser)await browser.close();await server.close();}
