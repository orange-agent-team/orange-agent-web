import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(process.version!=='v22.23.2')throw Error('Use Node 22.23.2');
const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH};
delete env.ORANGE_USER_TLS_DIR;
for(const [cwd,args] of [[root,['scripts/check.mjs']],[path.join(root,'apps/web'),
  ['node_modules/@playwright/test/cli.js','test','--config','playwright.hosted-approval.config.ts']]]){
  const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
console.log('PASS real Chrome approval recovery with explicit loopback API substitutes; no production authorization or actual tool execution in this suite.');
