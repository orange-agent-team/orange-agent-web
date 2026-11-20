import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const tls=resolve(root,'../../.local/tls');
let input='';
for await (const chunk of process.stdin) input+=chunk;
const f=JSON.parse(input);
const api=new URL(f.api);
if (api.protocol!=='http:' || api.hostname!=='127.0.0.1' || !api.port ||
    f.origin!=='https://127.0.0.1:43122') throw new Error('Private loopback origins required');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{
  host:'127.0.0.1',port:43122,strictPort:true,
  https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
  proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}},
}});
let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true,viewport:{width:1160,height:880}});
  await context.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.setDefaultTimeout(18000);
  await page.goto('/tasks');
  await page.getByRole('link',{name:'音频预检'}).click();
  await page.getByLabel('本地文件').setInputFiles(f.sample);
  const completed=page.waitForResponse(r=>r.url().endsWith('/transcription-measurements') && r.request().method()==='POST');
  await page.getByRole('button',{name:'上传并预检'}).click();
  const response=await completed;
  if(response.status()!==200)throw new Error('Audio measurement HTTP '+response.status());
  const result=await response.json();
  if(result.audio_sha256!==f.sha || result.duration_ms!=='11000' || result.source_samples!=='176000')throw new Error('Wrong immutable input or duration');
  await page.getByText('11000 毫秒',{exact:true}).waitFor();
  const upload=await page.getByLabel('上传编号').inputValue();
  await page.screenshot({path:f.screenshot,fullPage:true});
  await page.reload();
  await page.getByLabel('上传编号').fill(upload);
  await page.getByRole('button',{name:'预检已有音频'}).click();
  await page.getByText('11000 毫秒',{exact:true}).waitFor();
  const removed=await context.request.delete('/api/v1/owners/'+encodeURIComponent(f.owner)+'/uploads/'+encodeURIComponent(upload),
      {headers:{Origin:f.origin,'X-CSRF-Token':f.csrf,'Idempotency-Key':upload}});
  if(removed.status()!==200 || (await removed.json()).state!=='deleted')throw new Error('Fixture deletion failed');
  await page.getByText('当前无法确认源音频的读取权限。',{exact:true}).waitFor();
  if(await page.getByText('11000 毫秒',{exact:true}).count())throw new Error('Stale source measurement remained visible');
  console.log(JSON.stringify({real_chrome:true,uploaded_and_measured:true,recovered_by_upload_id:true,removed_source_hides_result:true}));
} finally {await browser?.close();await server.close();}
