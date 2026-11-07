import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/account', workers: 1, retries: 0, timeout: 30000, reporter: 'list', outputDir: 'test-results-account',
 use: { baseURL: 'http://127.0.0.1:43125', channel: 'chrome', viewport: { width: 1440, height: 1000 }, trace: 'off', video: 'off', screenshot: 'only-on-failure' },
 webServer: { command: `${process.execPath} node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 43125 --strictPort`, url: 'http://127.0.0.1:43125', reuseExistingServer: false, timeout: 30000 },
});
