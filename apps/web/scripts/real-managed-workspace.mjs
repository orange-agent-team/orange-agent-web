// Actual user browser, real cloud Host binary and one gVisor allocation.
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let text='';for await(const chunk of process.stdin)text+=chunk;
const f=JSON.parse(text),api=new URL(f.api),origin='https://127.0.0.1:43122';
if(api.hostname!=='127.0.0.1'||api.protocol!=='http:'||!api.port)throw Error('Loopback user API required');
const tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
  https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const ctx=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
  await ctx.addCookies([{name:'__Host-orange-user',value:f.token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const p=await ctx.newPage();p.setDefaultTimeout(45000);
  await p.goto('/agent');
  await p.getByText(/托管 Host 可接单/).waitFor();
  await p.getByLabel('运行输入').fill('Prepare this exact real sandbox input.');
  const created=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/agent/runs'&&r.request().method()==='POST');
  await p.getByRole('button',{name:'保存输入并预留工作区'}).click();
  const response=await created,run=await response.json();
  if(response.status()!==201||run.user_id!==f.user||run.status!=='queued')throw Error('No committed personal Run');
  const entry=p.locator('section').filter({has:p.getByRole('heading',{name:run.run_id,exact:true})});
  await entry.getByText(/工作区就绪/).waitFor();
  await p.screenshot({path:f.ready,fullPage:true});
  await entry.getByRole('button',{name:'取消运行'}).click();
  const cancelled=p.waitForResponse(r=>r.request().method()==='DELETE'&&new URL(r.url()).pathname==='/api/v1/agent/runs/'+run.run_id);
  await entry.getByRole('button',{name:'确认取消'}).click();
  const ack=await cancelled,state=await ack.json();
  if(ack.status()!==200||state.workspace.status!=='draining'||state.status!=='cancelled')throw Error('Cancellation did not fence the live allocation');
  await entry.getByText(/工作区已回收/).waitFor();
  await p.screenshot({path:f.closed,fullPage:true});
  process.stdout.write(JSON.stringify({run_id:run.run_id,workspace_id:run.workspace.workspace_id,input_version_id:run.input_version_id,
    observed_ready:true,observed_draining:true,observed_deleted:true})+'\n');
}finally{if(browser)await browser.close();await server.close();}
