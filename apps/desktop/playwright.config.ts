import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { e2eTemporaryRoot } from './e2e/temporary-root.js'

const temporaryRoot = e2eTemporaryRoot()

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: process.env.MUSIC_BRIDGE_E2E_OUTPUT_DIR ?? path.join(temporaryRoot, 'musicbridge-playwright-results'),
  reporter: [['list'], ['json', { outputFile: path.join(temporaryRoot, 'musicbridge-playwright-report.json') }]],
})
