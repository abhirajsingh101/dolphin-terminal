import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

const workspaceId = 'dolphin-terminal';
const run = `${Date.now()}-${process.pid}`;
const requestedPrimary = `e2e-primary-${run}`;
const requestedSecondary = `e2e-secondary-${run}`;
const requestedRouteTarget = `e2e-route-target-${run}`;
const primary = `${requestedPrimary}-dolphin`;
const secondary = `${requestedSecondary}-dolphin`;

async function createFromDock(page: Page, name: string) {
  await page.getByRole('button', { name: /New session in /i }).click();
  await page.getByRole('textbox', { name: /Name for new .* session/i }).fill(name);
  await page.getByRole('button', { name: /Create and open session in /i }).click();
}

async function inventory(request: APIRequestContext) {
  const response = await request.get(`/terminal/v1/workspaces/${workspaceId}`);
  if (!response.ok()) {
    throw new Error(`inventory failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<{ sessions: Array<{ name: string }> }>;
}

test.describe.serial('standalone native terminal', () => {
  test.afterAll(async ({ request }) => {
    const current = await inventory(request).catch(() => ({ sessions: [] }));
    for (const session of current.sessions) {
      if (!session.name.includes(run)) continue;
      await request.delete(
        `/terminal/v1/workspaces/${workspaceId}/sessions/${encodeURIComponent(session.name)}`,
      );
    }
  });

  test('isolates an explicit route target from stale global workspace state', async ({
    page,
    request,
  }) => {
    const created = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: requestedRouteTarget, mode: 'shell' } },
    );
    expect(created.status()).toBe(201);
    const routeSession = ((await created.json()) as { name: string }).name;

    await page.addInitScript(() => {
      window.sessionStorage.setItem(
        'dolphin.terminal.workspace.tab.v2',
        JSON.stringify({
          version: 2,
          root: {
            type: 'terminal',
            id: 'stale-pane',
            preferredProjectId: 'stale-workspace',
            tabs: [{ projectId: 'stale-workspace', sessionName: 'stale-session' }],
            activeTabIndex: 0,
          },
          activePaneId: 'stale-pane',
        }),
      );
    });

    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(routeSession)}`,
    );
    await expect(page.locator('.terminal-pane').filter({ hasText: routeSession })).toBeVisible();
    await expect(page.getByLabel('Terminal connection: live')).toBeVisible();
    await expect(page.getByText(/Workspace not found/)).toHaveCount(0);
    const scopedState = await page.evaluate(
      ({ projectId, sessionName }) =>
        window.sessionStorage.getItem(
          [
            'dolphin.terminal.workspace.tab.v2',
            encodeURIComponent(projectId),
            encodeURIComponent(sessionName),
          ].join(':'),
        ),
      { projectId: workspaceId, sessionName: routeSession },
    );
    expect(scopedState).toContain(routeSession);
    expect(scopedState).not.toContain('stale-workspace');
  });

  test('runs the complete UI on native persistence without tmux or optional AI services', async ({
    browser,
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByText('Dolphin Terminal', { exact: true })).toBeVisible();

    const capabilities = await request.get('/terminal/v1/capabilities');
    expect(await capabilities.json()).toMatchObject({
      session_backend: { id: 'native', available: true },
      dictation: { enabled: false },
      automation: { enabled: false },
    });
    await expect(page.getByRole('button', { name: /Start dictation/i })).toHaveCount(0);

    await createFromDock(page, requestedPrimary);
    await expect(page.getByLabel('Terminal connection: live')).toBeVisible();
    await expect
      .poll(async () => {
        const snapshot = await request.get(
          `/terminal/v1/workspaces/${workspaceId}/sessions/${primary}/snapshot`,
        );
        return (await snapshot.json()).content as string;
      })
      .toMatch(/[$#]\s*$/m);
    const terminal = page.locator('.xterm-helper-textarea:visible');
    await terminal.focus();
    await page.keyboard.type(`printf 'NATIVE_BROWSER_${run}\\n'`);
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const snapshot = await request.get(
          `/terminal/v1/workspaces/${workspaceId}/sessions/${primary}/snapshot`,
        );
        return (await snapshot.json()).content as string;
      })
      .toContain(`NATIVE_BROWSER_${run}`);

    await page.getByTitle(/Select terminal text/).click();
    const copyLayer = page.getByLabel('Selectable terminal text');
    await expect(copyLayer).toContainText(
      `NATIVE_BROWSER_${run}`,
    );
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await copyLayer.evaluate((element, marker) => {
      const text = element.textContent ?? '';
      const start = text.indexOf(marker);
      if (start < 0 || !element.firstChild) throw new Error('copy marker missing');
      const range = document.createRange();
      range.setStart(element.firstChild, start);
      range.setEnd(element.firstChild, start + marker.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }, `NATIVE_BROWSER_${run}`);
    await page.getByTitle('Copy selection').click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`NATIVE_BROWSER_${run}`);
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-select.png',
      animations: 'disabled',
    });
    await page.getByTitle('Exit select mode').click();

    await terminal.focus();
    await page.keyboard.type('sleep 30');
    await page.keyboard.press('Enter');
    await page.getByTitle('Send Ctrl-C').click();
    await terminal.focus();
    await page.keyboard.type(`printf 'AFTER_INTERRUPT_${run}\\n'`);
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const snapshot = await request.get(
          `/terminal/v1/workspaces/${workspaceId}/sessions/${primary}/snapshot`,
        );
        return (await snapshot.json()).content as string;
      })
      .toContain(`AFTER_INTERRUPT_${run}`);
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-desktop.png',
      animations: 'disabled',
    });

    await page.getByRole('button', { name: `Close terminal tab ${primary}` }).click();
    expect((await inventory(request)).sessions.map((session) => session.name)).toContain(primary);
    await page
      .getByRole('button', {
        name: new RegExp(`Open .* session ${primary} as a tab`),
      })
      .click();
    await expect(page.getByLabel('Terminal connection: live')).toBeVisible();
    await page.getByTitle(/Select terminal text/).click();
    await expect(page.getByLabel('Selectable terminal text')).toContainText(
      `NATIVE_BROWSER_${run}`,
    );
    await page.getByTitle('Exit select mode').click();

    const popupPromise = page.waitForEvent('popup');
    await page
      .getByRole('button', {
        name: new RegExp(`Show .* session ${primary} in its open tab`),
      })
      .click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await popup.waitForURL(
      (url) =>
        url.searchParams.get('session') === primary &&
        url.searchParams.get('workspace') === workspaceId,
      { waitUntil: 'domcontentloaded' },
    );
    expect(new URL(popup.url()).searchParams.get('session')).toBe(primary);
    expect(new URL(popup.url()).searchParams.get('workspace')).toBe(workspaceId);
    await popup.close();

    await createFromDock(page, requestedSecondary);
    await page.getByRole('button', { name: `Close terminal tab ${primary}` }).click();
    await page.getByRole('button', { name: `Placement options for ${primary}` }).click();
    await page.getByRole('menuitem', { name: 'Open right of active view' }).click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await expect(page.getByRole('separator', { name: /Resize terminal views/ })).toHaveCount(1);
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-split.png',
      animations: 'disabled',
    });

    const attachmentPane = page.locator('.terminal-pane').last();
    const fileChooserPromise = page.waitForEvent('filechooser');
    await attachmentPane
      .getByRole('button', { name: /Attach files or images to/ })
      .click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'release-picker-evidence.ts',
      mimeType: 'text/typescript',
      buffer: Buffer.from('export const safe = true;'),
    });
    await expect(attachmentPane.locator('.terminal-attachment-status')).toContainText(
      'Path pasted for 1 attachment.',
    );
    const attachmentTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['safe attachment'], 'release-evidence.txt', { type: 'text/plain' }));
      return transfer;
    });
    const attachmentHost = attachmentPane.locator('.terminal-host');
    await attachmentHost.dispatchEvent('dragenter', { dataTransfer: attachmentTransfer });
    await expect(page.getByText(/Drop files or images into/)).toBeVisible();
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-attachment.png',
      animations: 'disabled',
    });
    await attachmentHost.dispatchEvent('dragleave', { dataTransfer: attachmentTransfer });
    await attachmentTransfer.dispose();

    await page.locator('.terminal-pane').last().getByTitle('Fullscreen terminal').click();
    await expect(page.locator('.terminal-pane.fullscreen')).toHaveCount(1);
    await expect(page.getByRole('separator', { name: /Resize terminal views/ })).toBeHidden();
    await expect(page.locator('.terminal-session-dock')).toBeHidden();
    await expect(page.locator('.terminal-workspace-leaf.fullscreen-background')).toHaveAttribute(
      'inert',
      '',
    );
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-fullscreen.png',
      animations: 'disabled',
    });
    await page.locator('.terminal-pane.fullscreen .xterm-helper-textarea').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-pane.fullscreen')).toHaveCount(1);
    await page.locator('.terminal-pane.fullscreen').getByTitle('Exit fullscreen').click();

    await page.setViewportSize({ width: 820, height: 900 });
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-tablet.png',
      animations: 'disabled',
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('navigation', { name: 'Terminal views' })).toBeVisible();
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    const undersizedPaneActions = await page
      .locator('.terminal-actions button:visible')
      .evaluateAll((buttons) =>
        buttons.filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width < 40 || bounds.height < 40;
        }).length,
      );
    expect(undersizedPaneActions).toBe(0);
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-mobile.png',
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    const touchContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(
        `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(primary)}`,
      );
      await expect(touchPage.getByLabel('Terminal connection: live')).toBeVisible();
      const undersizedTouchActions = await touchPage
        .locator('.terminal-actions button:visible')
        .evaluateAll((buttons) =>
          buttons.filter((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.width < 44 || bounds.height < 44;
          }).length,
        );
      expect(undersizedTouchActions).toBe(0);
    } finally {
      await touchContext.close();
    }

    const primaryPane = page.locator('.terminal-pane').filter({ hasText: primary });
    await page.route(
      `**/terminal/v1/workspaces/${workspaceId}/sessions/${primary}`,
      async (route) => {
        if (route.request().method() === 'DELETE') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'close refused' }),
          });
          return;
        }
        await route.continue();
      },
    );
    page.once('dialog', (dialog) => dialog.accept());
    await primaryPane.getByTitle('Close session').click();
    await expect(primaryPane.getByRole('alert')).toBeVisible();
    await expect(primaryPane.getByRole('alert')).toContainText('close refused');
    expect((await inventory(request)).sessions.map((session) => session.name)).toContain(primary);
    await page.unroute(
      `**/terminal/v1/workspaces/${workspaceId}/sessions/${primary}`,
    );

    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('.terminal-pane')
      .filter({ hasText: primary })
      .getByTitle('Close session')
      .click();
    await expect
      .poll(async () => (await inventory(request)).sessions.map((session) => session.name))
      .not.toContain(primary);
    expect((await inventory(request)).sessions.map((session) => session.name)).toContain(secondary);
  });
});
