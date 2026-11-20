// The API and Host control channel are real. Drop one committed HTTP response
// to test browser recovery using the original idempotency key after a reload.
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let privatePacket='';for await(const chunk of process.stdin)privatePacket+=chunk;
const f=JSON.parse(privatePacket),api=new URL(f.api),origin='https://127.0.0.1:43122';
if(api.hostname!=='127.0.0.1'||api.protocol!=='http:'||!api.port)throw Error('Expected local user router');
const tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
  https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const ctx=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:{width:1400,height:1000}});
  await ctx.addCookies([{name:'__Host-orange-user',value:f.token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const p=await ctx.newPage();p.setDefaultTimeout(18000);
  const base='/api/v1/agent/runs';let creates=0,uploads=0,cancellations=0,lookups=0,id,version,requestKey;
  p.on('request',r=>{
    const path=new URL(r.url()).pathname;
    if(path.startsWith('/api/v1/agent/invocations/')&&r.method()==='GET')lookups++;
    if(path.endsWith('/content')&&r.method()==='PUT')uploads++;
    if(path.startsWith(base+'/')&&r.method()==='DELETE')cancellations++;
  });
  await p.route('**/api/v1/agent/runs',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    creates++;requestKey=route.request().headers()['idempotency-key'];const res=await route.fetch();
    if(res.status()!==201)throw Error('Actual reservation rejected: '+res.status());
    const row=await res.json();if(row.user_id!==f.user||row.status!=='queued')throw Error('Invalid committed Run');
    id=row.run_id;version=row.input_version_id;
    await route.abort('failed');
  });
  await p.goto('/agent');
  await p.getByText(/托管 Host 可接单/).waitFor();
  await p.getByLabel('运行输入').fill('Only this isolated browser input.');
  await p.getByRole('button',{name:'保存输入并预留工作区'}).click();
  await p.getByText('操作结果待核对，请刷新或继续原请求。').waitFor();
  const cached=await p.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)));
  if(cached.includes('Only this isolated browser input.'))throw Error('Prompt persisted in browser storage');
  await p.reload();
  await p.getByRole('button',{name:'继续原请求'}).click();
  await p.getByRole('status').filter({hasText:id}).waitFor();
  const entry=p.locator('section').filter({has:p.getByRole('heading',{name:id,exact:true})});
  await entry.getByText(/工作区准备中/).waitFor();
  await entry.getByRole('button',{name:'取消运行'}).click();
  const ack=p.waitForResponse(r=>new URL(r.url()).pathname===base+'/'+id&&r.request().method()==='DELETE');
  await entry.getByRole('button',{name:'确认取消'}).click();
  const res=await ack,row=await res.json();
  if(res.status()!==200||row.status!=='cancelled'||row.workspace.status!=='draining')throw Error('Cancellation did not fence claimed allocation');
  await entry.getByText(/工作区已回收/).waitFor();
  if(creates!==1||uploads!==1||cancellations!==1||lookups!==1)throw Error('Unexpected duplicate or missing requests');
  const firstRun=id,firstVersion=version;
  await p.getByRole('button',{name:'刷新托管运行',exact:true}).click();
  await p.getByLabel('运行输入').fill('Withdraw this second request.');
  await p.getByRole('button',{name:'保存输入并预留工作区'}).click();
  await p.getByText('操作结果待核对，请刷新或继续原请求。').waitFor();
  const ackWithdrawal=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/agent/invocations/'+requestKey&&r.request().method()==='DELETE');
  await p.getByRole('button',{name:'撤回原请求'}).click();
  const response=await ackWithdrawal,withdrawal=await response.json();
  if(response.status()!==200||withdrawal.run.run_id!==id||withdrawal.run.workspace.status!=='deleted'||withdrawal.run.status!=='cancelled')throw Error('Original withdrawal did not cancel the queued reservation');
  await p.getByText('原请求已撤回。已上传的个人文件版本仍可单独管理。').waitFor();
  if(creates!==2||uploads!==2||firstRun===id||await p.getByRole('button',{name:'继续原请求'}).count())throw Error('Withdrawn request remains active');
  await p.screenshot({path:f.screenshot,fullPage:true});
  process.stdout.write(JSON.stringify({run_id:firstRun,input_version_id:firstVersion,creates,uploads,cancellations,lookups,withdrawn_run:id,withdrawal_receipt:withdrawal.receipt_id,cleared:true})+'\n');
}finally{if(browser)await browser.close();await server.close();}
