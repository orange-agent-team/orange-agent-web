import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preview} from 'vite';
import {chromium} from '@playwright/test';

const chunks=[];for await(const bytes of process.stdin)chunks.push(bytes);
const f=JSON.parse(Buffer.concat(chunks));
const backend=new URL(f.api);
if(f.origin!=='https://127.0.0.1:43122'||backend.protocol!=='http:'||backend.hostname!=='127.0.0.1'||!backend.port)throw Error('Loopback required');
const app=fileURLToPath(new URL('../',import.meta.url)),tls=resolve(app,'../../.local/tls');
const server=await preview({root:app,configFile:false,build:{outDir:f.assets},logLevel:'silent',preview:{
  host:'127.0.0.1',port:43122,strictPort:true,https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
  proxy:{'/api/v1/':{target:backend.origin,changeOrigin:false}}}});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true});
  await context.addCookies([{name:'__Host-orange-user',value:f.login,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.setDefaultTimeout(14000);
  const errors=[];page.on('pageerror',e=>errors.push(e.name+': '+e.message.slice(0,140)));
  const button=name=>page.getByRole('button',{name,exact:true});
  const visible=text=>page.getByText(text,{exact:true}).waitFor();
  const phase=async text=>{if(await page.getByTestId('rotation-state').textContent()!==text)await visible(text);};
  let writes=0,deletes=0;
  page.on('request',r=>{if(r.method()==='DELETE')deletes++;});
  if(f.mode==='authorize')await page.route('**/worker-certificate-rotations/*',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    writes++;const r=await route.fetch();
    if(r.status()!==200)throw Error('Gateway did not confirm original PUT');
    await r.dispose();await route.abort('failed');
  });
  try{
    await page.goto('/account');
    await page.getByRole('link',{name:'管理个人设备注册'}).click();
    await page.getByText('轮换现有设备证书',{exact:true}).click();
    if(f.mode==='authorize'){
      const choose=value=>page.getByLabel('轮换交接文件').setInputFiles({name:'rotation.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
      const other=structuredClone(f.handoff);other.intent.owner_id+='x';await choose(other);
      await visible('轮换文件无效，或签名意图中的归属与当前账户不符。');
      if(writes!==0)throw Error('Cross-owner handoff sent a PUT');
      await choose(f.handoff);
      await visible(f.handoff.intent.node_id);
      await button('确认授权证书轮换').click();
      await phase('轮换已授权，等待签发');
      await visible('已按原请求编号核对平台回执。');
      await page.reload();await page.getByText('轮换现有设备证书',{exact:true}).click();
      await phase('轮换已授权，等待签发');
      const stored=await page.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('orange.worker-rotation.v1:')).map(([,v])=>v));
      if(writes!==1||stored.length!==1||stored[0]!==f.handoff.intent.replacement.request.request_id)throw Error('Mutation replay or invalid bookmark');
    }else if(f.mode==='revoke'){
      await page.getByLabel('轮换请求编号').fill(f.request);
      await button('读取轮换记录').click();await phase('新设备证书已兑换');
      await button('撤销轮换授权').click();await button('保留轮换授权').click();
      if(deletes!==0)throw Error('Cancelled revocation mutated a credential');
      await button('撤销轮换授权').click();await button('确认撤销轮换授权').click();
      await phase('轮换授权已撤销');if(deletes!==1)throw Error('Incorrect revocation count');
    }else throw Error('Unknown fixture mode');
    if(errors.length)throw Error(errors.join(' / '));
    console.log(JSON.stringify({mode:f.mode,writes,deletes,origin:f.origin}));
    console.log('PASS real owner rotation browser '+f.mode);
  }catch(e){if(errors.length)console.error('Browser errors',errors);throw e;}
}finally{try{await browser?.close();}finally{await new Promise(done=>server.httpServer.close(done));}}
