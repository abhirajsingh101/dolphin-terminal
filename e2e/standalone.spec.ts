import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

const workspaceId = 'dolphin-terminal';
const run = `${Date.now()}-${process.pid}`;
const requestedPrimary = `e2e-primary-${run}`;
const requestedSecondary = `e2e-secondary-${run}`;
const primary = `${requestedPrimary}-dolphin`;
const secondary = `${requestedSecondary}-dolphin`;

async function createFromDock(page: Page, name: string) {
  await page.getByRole('button', { name: /New session in dolphin-terminal/i }).click();
  await page.getByRole('textbox', { name: /Name for new dolphin-terminal session/i }).fill(name);
  await page.getByRole('button', { name: /Create and open session in dolphin-terminal/i }).click();
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

  test('runs the complete UI on native persistence without tmux or optional AI services', async ({
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
    await expect(page.getByLabel('Selectable terminal text')).toContainText(
      `NATIVE_BROWSER_${run}`,
    );
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-select.png',
      animations: 'disabled',
    });
    await page.getByTitle('Exit select mode').click();
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-desktop.png',
      animations: 'disabled',
    });

    await page.getByRole('button', { name: `Close terminal tab ${primary}` }).click();
    expect((await inventory(request)).sessions.map((session) => session.name)).toContain(primary);
    await page
      .getByRole('button', {
        name: new RegExp(`Open dolphin-terminal session ${primary} as a tab`),
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
        name: new RegExp(`Show dolphin-terminal session ${primary} in its open tab`),
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
      .locator('.terminal-pane-toolbar button:visible')
      .evaluateAll((buttons) =>
        buttons.filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width < 44 || bounds.height < 44;
        }).length,
      );
    expect(undersizedPaneActions).toBe(0);
    await page.screenshot({
      path: 'test-results/evidence/standalone-native-mobile.png',
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 900 });

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
