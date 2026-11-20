// Qualification serves only the unpacked assets. Absent APIs return an explicit 503.
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
const [dir,surface]=process.argv.slice(2);
if(!['web','admin'].includes(surface))throw Error('Unknown application surface');
const manifest=JSON.parse(readFileSync(resolve(dir,'manifest.json'),'utf8'));
const session=surface==='web'?'/api/v1/session':'/admin/v1/session';
let sessionRequests=0;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 if(path.startsWith('/api/')||path.startsWith('/admin/v1/')){
  if(path===session)sessionRequests++;
  res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({code:'SERVICE_UNAVAILABLE',message:'Offline release qualification'}));
 }
 const name='site'+path;
 const key=Object.hasOwn(manifest.sha256,name)?name:(!extname(path)?'site/index.html':null);
 if(!key){res.writeHead(404);return res.end();}
 const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(key)]??'application/octet-stream';
 res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff'});res.end(readFileSync(resolve(dir,key)));
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const origin='http://127.0.0.1:'+server.address().port;
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const blocked=[];
 await page.route('**/*',r=>{const url=new URL(r.request().url());if(url.origin!==origin){blocked.push(url.origin);return r.abort();}return r.continue();});
 const gate=page.waitForResponse(r=>new URL(r.url()).pathname===session && r.status()===503);
 await page.goto(origin+(surface==='web'?'/tasks/audio':'/overview'));await gate;
 await page.getByRole('heading',{level:1}).first().waitFor();
 const route=surface==='web'?'/api/v1/auth/start':'/admin/v1/auth/start';
 await page.locator('a[href="'+route+'"]').first().waitFor();
 if(sessionRequests<1||errors.length||blocked.length)throw Error('Failed static release gate '+JSON.stringify({errors,blocked}));
 console.log(JSON.stringify({chrome:true,deep_link:true,no_external_asset_requests:true,session_status:503,privileged_interface_opened:false,
  scope:'Static archive with explicit offline API response; separate live API and identity gates qualify authenticated flows.'}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
