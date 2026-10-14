import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const projectDirectory = fileURLToPath(new URL('.', import.meta.url))
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173'
const serverURL = new URL(baseURL)

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    channel: 'msedge',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_START_SERVER === '1' ? {
    command: `"${process.execPath}" "${fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url))}" --host "${serverURL.hostname}" --port ${serverURL.port || '5173'} --strictPort`,
    cwd: projectDirectory,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  } : undefined,
})