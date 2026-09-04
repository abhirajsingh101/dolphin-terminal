import { existsSync } from 'node:fs';
import { defineConfig } from 'playwright/test';

const projectRoot = process.cwd();
const port = 18733;
const systemChrome = '/usr/bin/google-chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/playwright',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: existsSync(systemChrome)
      ? { executablePath: systemChrome }
      : undefined,
  },
  webServer: {
    command: [
      'python -m dolphin_terminal serve',
      projectRoot,
      '--port',
      String(port),
      '--session-backend native',
      '--no-open',
    ].join(' '),
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONPATH: `${projectRoot}/python`,
      DOLPHIN_TERMINAL_NATIVE_RUNTIME_DIR: `${projectRoot}/test-results/native-runtime`,
      DOLPHIN_TERMINAL_NATIVE_STATE_DIR: `${projectRoot}/test-results/native-state`,
      DOLPHIN_TERMINAL_SHELL: '/bin/sh',
    },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
