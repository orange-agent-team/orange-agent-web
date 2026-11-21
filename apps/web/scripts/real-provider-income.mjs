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
 let mutations=0;page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/api/v1/'))mutations++;});
 const fetched=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/account/earnings'&&r.status()===200);
 await page.goto('/account');
 const response=await fetched,body=await response.json();
 if(body.data.length!==1||body.data[0].job_id!==f.job||body.data[0].state!=='available')throw Error('Supplier income query did not match the original job');
 const row=page.locator('[data-row-key="'+f.job+'"]');await row.getByText('已转为可用',{exact:true}).waitFor();
 await row.getByText('0.00176',{exact:true}).waitFor();
 if(await page.locator('[data-row-key="'+f.foreign+'"]').count()!==0||mutations!==0)throw Error('Unexpected scope or mutation');
 await page.screenshot({path:f.screenshot,fullPage:true});
 console.log(JSON.stringify({supplier_income_browser:true,own_job_only:true,available_microcredits:body.data[0].units,mutations}));
}finally{await browser?.close();await server.close();}
