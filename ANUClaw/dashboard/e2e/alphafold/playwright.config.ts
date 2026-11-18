import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['workflow.spec.ts', 'accessibility.spec.ts'],
  workers: 1,
  timeout: 300_000,
  reporter: [['list'], ['json', { outputFile: '/tmp/anuclaw-af-browser-results.json' }]],
  outputDir: '/tmp/anuclaw-af-browser-output',
  use: {
    baseURL: 'http://127.0.0.1:5387',
    storageState: '/tmp/anuclaw-af-browser-state.json',
    viewport: { width: 1440, height: 1000 },
  },
});
