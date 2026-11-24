// Run the packaged portal with its deployment-selected storage origin and a real private S3 endpoint.
import {chromium,expect} from '@playwright/test';
import {preview} from 'vite';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

let text='';
for await (const part of process.stdin) text+=part;
const f=JSON.parse(text);
const root=fileURLToPath(new URL('../',import.meta.url));
const origin=new URL(f.origin),api=new URL(f.api),storage=new URL(f.storage);
if ([origin,api,storage].some(p=>p.hostname!=='127.0.0.1'||!p.port) || origin.protocol!=='https:' || storage.protocol!=='http:')
  throw Error('Local fixture required');
let configured=false;
const server=await preview({root,configFile:false,logLevel:'silent',build:{outDir:f.site},plugins:[{
  name:'fixture-deployment-configuration',
  configurePreviewServer(s){s.middlewares.use('/artifact-download.json',(_req,res,next)=>{
    if(!configured){next();return;}
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    res.end(JSON.stringify({version:1,origin:storage.origin}));
  });}
}],preview:{host:'127.0.0.1',port:Number(origin.port),strictPort:true,
  https:{key:readFileSync(resolve(f.tls,'key.pem')),cert:readFileSync(resolve(f.tls,'cert.pem'))},
  proxy:{'/api/v1/':{target:api.origin,changeOrigin:false,ws:true}}}});
let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true});
  await context.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'},
    {name:'artifact-cookie-probe',value:'test-only',url:f.storage,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();
  const requests=[];
  page.on('request',r=>{const url=new URL(r.url());if(url.origin===storage.origin&&url.searchParams.has('versionId'))requests.push(r);});
  await page.goto(origin.origin+'/tasks');
  await page.getByText('核对已存图像',{exact:true}).click();
  await page.getByRole('textbox',{name:'图像上传记录 ID'}).fill(f.upload);
  await page.getByRole('button',{name:'校验 PNG'}).click();
  const receipt=page.getByLabel('图像校验结果');
  await expect(receipt).toContainText(f.rgb);
  const save=page.getByRole('button',{name:'下载已校验 PNG'});
  async function download() {
    const [file]=await Promise.all([page.waitForEvent('download',{timeout:18000}),save.click()]);
    const data=readFileSync(await file.path());
    if(file.suggestedFilename()!==f.artifact+'.png'||data.length!==f.bytes||createHash('sha256').update(data).digest('hex')!==f.sha256)
      throw Error('Different browser download');
    await file.delete();
  }
  await download();
  if(requests.length)throw Error('Unconfigured portal contacted the provider');
  configured=true;
  await download();
  if(requests.length!==1)throw Error('Expected one direct versioned GET');
  const headers=await requests[0].allHeaders();
  if(headers.cookie||headers.authorization||headers.referer)throw Error('Unexpected identity or referrer forwarded to the provider');
  let arrived,release;
  const ready=new Promise(r=>{arrived=r}),resume=new Promise(r=>{release=r});
  const hold=async route=>{
    const resp=await route.fetch();
    if(resp.status()!==200)throw Error('Expected actual authorized bytes');
    arrived();await resume;
    try {await route.fulfill({response:resp});} catch(e){if(!route.request().failure())throw e;}
  };
  const published=storage.origin+'/**';
  let unexpected=0;
  page.on('download',()=>unexpected++);
  await page.route(published,hold);
  try{
    await save.click();
    let timeout;try{await Promise.race([ready,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Download gate timeout')),12000);})]);}finally{clearTimeout(timeout);}
    const res=await fetch(api.origin+'/api/v1/owners/'+f.owner+'/uploads/'+f.upload,{method:'DELETE',
      headers:{Cookie:'__Host-orange-user='+f.token,Origin:f.origin,'X-CSRF-Token':f.csrf,'Idempotency-Key':f.upload}});
    if(res.status!==200)throw Error('Independent client did not delete the source');
  }finally{release();}
  await expect(page.getByText(/图像下载未完成/)).toBeVisible();
  await expect(receipt).toHaveCount(0);
  if(unexpected)throw Error('Revoked image was saved');
  console.log(JSON.stringify({real_chrome:true,verified_proxy_file:true,verified_s3_file:true,provider_cookie:false,
    provider_referrer:false,revoked_before_save:true,files_after_deletion:0}));
}finally{if(browser)await browser.close();await server.close();}
