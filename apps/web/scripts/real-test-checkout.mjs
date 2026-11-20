import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
let input='';
for await(const chunk of process.stdin)input+=chunk;
const f=JSON.parse(input), api=new URL(f.api);
if(f.origin!=='https://127.0.0.1:43122'||api.protocol!=='http:'||api.hostname!=='127.0.0.1'||!api.port)throw Error('Loopback fixture required');
const root=fileURLToPath(new URL('../',import.meta.url)), tls=resolve(root,'../../.local/tls');
const server=await preview({root,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:43122,strictPort:true,
 https:{key:readFileSync(resolve(tls,'key.pem')),cert:readFileSync(resolve(tls,'cert.pem'))},
 proxy:{'/api/v1/':{target:api.origin,changeOrigin:false}}}});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const ctx=await browser.newContext({baseURL:f.origin,ignoreHTTPSErrors:true,viewport:{width:1200,height:1100}});
 await ctx.addCookies([{name:'__Host-orange-user',value:f.token,url:f.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await ctx.newPage();page.setDefaultTimeout(20000);
 await page.goto('/account');
 const create=page.getByRole('button',{name:'创建测试订单',exact:true});
 await create.click();await page.getByRole('button',{name:'取消未派发订单'}).click();
 await page.getByText('已取消',{exact:true}).waitFor();await page.getByRole('button',{name:'返回测试充值',exact:true}).click();
 await create.click();
 let count=0,original,checkout;
 await page.route('**/checkout-orders/*/session',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   const reply=await route.fetch(),v=await reply.json();
   if(reply.status()!==200||v.state!=='open'||v.owner_id!==f.owner||v.offer.amount_minor!=='500')throw Error('Unconfirmed checkout dispatch');
   count++;original=v.order_id;checkout=v.checkout_url;await route.abort('failed');
 });
 await page.getByRole('button',{name:'确认创建测试支付会话'}).click();
 await page.getByText('结果尚未确认，请查询同一订单。').waitFor();
 await page.reload();await page.getByText('等待测试付款',{exact:true}).waitFor();
 if(await page.getByRole('link',{name:'打开测试收银台'}).getAttribute('href')!==checkout||!original)throw Error('Original test session was not recovered');
 await page.getByText(original,{exact:true}).waitFor();
 await page.getByRole('button',{name:'核对付款状态'}).click();
 await page.getByText('测试积分已入账',{exact:true}).waitFor();
 if(count!==1||await page.getByRole('link',{name:'打开测试收银台'}).count())throw Error('Checkout dispatched twice or exposed after completion');
 await page.screenshot({path:f.screenshot,fullPage:true});
 console.log(JSON.stringify({chrome:true,locally_cancelled:true,recovered_same_order:true,dispatches:count,authoritative_test_credit:true,visited_external_checkout:false}));
} finally {await browser?.close();await server.close();}
