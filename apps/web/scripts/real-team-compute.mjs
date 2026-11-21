import {createHash} from 'node:crypto';
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
 const writes=[];
 page.on('request',req=>{const url=new URL(req.url());if(req.method()==='POST'&&url.pathname.startsWith('/api/v1/owners/'))writes.push(url.pathname);});
 await page.goto('/organizations/'+f.org);
 await page.getByRole('link',{name:'使用这笔团队预算转写',exact:true}).click();
 await page.getByLabel('上传编号').fill(f.upload);await page.getByRole('button',{name:'预检已有音频'}).click();
 await page.getByText('11000 毫秒',{exact:true}).waitFor();
 await page.getByLabel('节点观测编号').fill(f.observation);await page.getByRole('button',{name:'核对转写节点'}).click();
 await page.getByText(f.node,{exact:true}).waitFor();
 if(await page.getByLabel('预算编号').inputValue()!==f.budget||await page.getByLabel('预算编号').isEnabled())throw Error('Team budget binding was not retained');
 await page.getByLabel('转写语言').selectOption('en');await page.getByRole('checkbox',{name:'允许此节点读取当前音频版本用于本次转写'}).check();
 await page.getByRole('button',{name:'授权 15 分钟'}).click();await page.getByText(/^授权有效/).waitFor();
 await page.getByRole('button',{name:'获取转写报价'}).click();await page.getByText('2200 个开发积分最小单位',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认预留并提交转写'}).click();
 await page.getByRole('link',{name:'查看任务',exact:true}).click();await page.getByRole('heading',{name:'我的团队任务'}).waitFor();
 const content=page.getByTestId('model-result-text');await content.waitFor({timeout:45000});
 if(createHash('sha256').update(await content.innerText()).digest('hex')!==f.transcript_sha)throw Error('Team transcript did not match actual approved recording');
 await page.getByText('查看转写时间段',{exact:true}).click();await page.getByText('语言 en · 解码时长 11000 毫秒',{exact:true}).waitFor();
 const base='/api/v1/owners/'+f.org+'/';
 if(writes.some(p=>!p.startsWith(base))||!['transcription-input-grants','transcription-quotes','jobs'].every(p=>writes.includes(base+p)))throw Error('Compute writes did not stay in the selected organization');
 await page.screenshot({path:f.screenshot,fullPage:true});
 console.log(JSON.stringify({team_browser_compute:true,member_budget_fixed:true,explicit_remote_consent:true,one_org_submission:writes.filter(p=>p===base+'jobs').length,verified_transcript:true}));
} finally {await browser?.close();await server.close();}
