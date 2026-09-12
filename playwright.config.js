import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  } }, webServer: { command: 'npm run dev -- --port 4178', url: 'http://127.0.0.1:4178', reuseExistingServer: false, timeout: 30000 } });
