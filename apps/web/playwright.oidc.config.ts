import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/identity', fullyParallel: false, workers: 1, retries: 0, timeout: 60000, reporter: 'list',
  outputDir: 'test-results-identity',
  use: { baseURL: 'https://127.0.0.1:43122', channel: 'chrome', ignoreHTTPSErrors: true,
    trace: 'off', video: 'off', screenshot: 'off', viewport: { width: 1440, height: 1000 } },
});
