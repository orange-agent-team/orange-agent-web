import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/hosted-approval',workers:1,retries:0,timeout:30000,reporter:'list',
  outputDir:'test-results/hosted-approval',
  use:{baseURL:'http://127.0.0.1:43346',channel:'chrome',trace:'off',video:'off'},
  webServer:{command:`${process.execPath} node_modules/vite/bin/vite.js --host 127.0.0.1 --port 43346 --strictPort`,
    url:'http://127.0.0.1:43346/tests/hosted-approval/component.html',reuseExistingServer:false,timeout:30000}
});
