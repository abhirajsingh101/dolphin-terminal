import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

const workspaceId = 'dolphin-terminal';
const alternateWorkspaceId = 'dolphin-terminal-alt';
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

async function inventory(request: APIRequestContext, projectId = workspaceId) {
  const response = await request.get(`/terminal/v1/workspaces/${projectId}`);
  if (!response.ok()) {
    throw new Error(`inventory failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<{ sessions: Array<{ name: string }> }>;
}

test.describe.serial('standalone native terminal', () => {
  test.afterAll(async ({ request }) => {
    for (const projectId of [workspaceId, alternateWorkspaceId]) {
      const current = await inventory(request, projectId).catch(() => ({ sessions: [] }));
      for (const session of current.sessions) {
        if (!session.name.includes(run)) continue;
        await request.delete(
          `/terminal/v1/workspaces/${projectId}/sessions/${encodeURIComponent(session.name)}`,
        );
      }
    }
  });

  test('keeps the latest target when workspace loads and mutations finish out of order', async ({
    page,
    request,
  }) => {
    const primaryCreated = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: `race-primary-${run}`, mode: 'shell' } },
    );
    const primarySession = ((await primaryCreated.json()) as { name: string }).name;
    const alternateCreated = await request.post(
      `/terminal/v1/workspaces/${alternateWorkspaceId}/sessions`,
      { data: { name: `race-alternate-${run}`, mode: 'shell' } },
    );
    const alternateSession = ((await alternateCreated.json()) as { name: string }).name;

    let alternateWorkspaceLoads = 0;
    await page.route(
      `**/terminal/v1/workspaces/${alternateWorkspaceId}`,
      async (route) => {
        alternateWorkspaceLoads += 1;
        if (alternateWorkspaceLoads === 2) await new Promise((resolve) => setTimeout(resolve, 450));
        await route.continue();
      },
    );
    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(primarySession)}`,
    );
    const dock = page.getByRole('region', { name: 'Open sessions' });
    await dock.getByLabel('Project for terminal sessions').selectOption(alternateWorkspaceId);
    await dock
      .getByRole('button', {
        name: new RegExp(`Open .* session ${alternateSession} as a tab`),
      })
      .click();
    await expect(page).toHaveURL(new RegExp(`workspace=${alternateWorkspaceId}`));
    await page.getByRole('tab', { name: new RegExp(primarySession) }).click();
    await page.waitForTimeout(550);
    await expect(page).toHaveURL(
      new RegExp(`workspace=${workspaceId}.*session=${primarySession}`),
    );
    await expect(page.getByRole('tab', { name: new RegExp(primarySession) })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await dock.getByLabel('Project for terminal sessions').selectOption(workspaceId);
    await dock.getByRole('button', { name: /New session in /i }).click();
    await dock.getByRole('textbox', { name: /Name for new .* session/i }).fill(`late-${run}`);
    await page.route(
      `**/terminal/v1/workspaces/${workspaceId}/sessions`,
      async (route) => {
        if (route.request().method() === 'POST') {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        await route.continue();
      },
    );
    await dock.getByRole('button', { name: /Create and open session in /i }).click();
    await dock.getByLabel('Project for terminal sessions').selectOption(alternateWorkspaceId);
    await dock
      .getByRole('button', {
        name: new RegExp(`Show .* session ${alternateSession} in its open tab`),
      })
      .click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('tab', { name: new RegExp(alternateSession) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: new RegExp(`late-${run}`) })).toHaveCount(0);
  });

  test('remains compatible with a gateway that omits attachment capabilities', async ({
    page,
  }) => {
    await page.route('**/terminal/v1/capabilities', async (route) => {
      await route.fulfill({
        json: {
          session_backend: { id: 'native', available: true, detail: 'ready' },
          dictation: { enabled: false },
          automation: { enabled: false },
        },
      });
    });
    await page.goto('/');
    await expect(page.getByText('Dolphin Terminal', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Open sessions' })).toBeVisible();
  });

  test('rolls a rejected cross-workspace target back to the committed route and tab', async ({
    page,
    request,
  }) => {
    const primaryCreated = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: `rollback-primary-${run}`, mode: 'shell' } },
    );
    const primarySession = ((await primaryCreated.json()) as { name: string }).name;
    const primaryNextCreated = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: `rollback-primary-next-${run}`, mode: 'shell' } },
    );
    const primaryNextSession = (
      (await primaryNextCreated.json()) as { name: string }
    ).name;
    const alternateCreated = await request.post(
      `/terminal/v1/workspaces/${alternateWorkspaceId}/sessions`,
      { data: { name: `rollback-alternate-${run}`, mode: 'shell' } },
    );
    const alternateSession = ((await alternateCreated.json()) as { name: string }).name;

    let alternateWorkspaceLoads = 0;
    await page.route(
      `**/terminal/v1/workspaces/${alternateWorkspaceId}`,
      async (route) => {
        alternateWorkspaceLoads += 1;
        if (alternateWorkspaceLoads === 1) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          json: { detail: 'Alternate workspace synchronization failed.' },
        });
      },
    );
    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(primarySession)}`,
    );
    const dock = page.getByRole('region', { name: 'Open sessions' });
    await dock
      .getByRole('button', {
        name: new RegExp(`Open .* session ${primaryNextSession} as a tab`),
      })
      .click();
    await page.getByRole('tab', { name: new RegExp(primarySession) }).click();
    await dock.getByLabel('Project for terminal sessions').selectOption(alternateWorkspaceId);
    await dock
      .getByRole('button', {
        name: new RegExp(`Open .* session ${alternateSession} as a tab`),
      })
      .click();

    await expect(page.getByRole('alert')).toContainText(
      'Alternate workspace synchronization failed.',
    );
    await expect(page).toHaveURL(
      new RegExp(`workspace=${workspaceId}.*session=${primarySession}`),
    );
    await expect(page.getByRole('tab', { name: new RegExp(primarySession) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: new RegExp(primaryNextSession) }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL(
      new RegExp(`workspace=${workspaceId}.*session=${primaryNextSession}`),
    );
  });

  test('commits an empty workspace without retaining an optimistic session', async ({
    page,
    request,
  }) => {
    const primaryCreated = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: `empty-success-primary-${run}`, mode: 'shell' } },
    );
    const primarySession = ((await primaryCreated.json()) as { name: string }).name;
    const alternateCreated = await request.post(
      `/terminal/v1/workspaces/${alternateWorkspaceId}/sessions`,
      { data: { name: `empty-success-alternate-${run}`, mode: 'shell' } },
    );
    const alternateSession = ((await alternateCreated.json()) as { name: string }).name;
    let alternateWorkspaceLoads = 0;
    await page.route(
      `**/terminal/v1/workspaces/${alternateWorkspaceId}`,
      async (route) => {
        alternateWorkspaceLoads += 1;
        if (alternateWorkspaceLoads === 1) {
          await route.continue();
          return;
        }
        await route.fulfill({
          json: {
            project_id: alternateWorkspaceId,
            path: '/tmp/dolphin-terminal-e2e-alt',
            path_exists: true,
            is_directory: true,
            is_allowed: true,
            message: 'Workspace is ready.',
            session_count: 0,
            sessions: [],
          },
        });
      },
    );

    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(primarySession)}`,
    );
    const dock = page.getByRole('region', { name: 'Open sessions' });
    await dock.getByLabel('Project for terminal sessions').selectOption(alternateWorkspaceId);
    await dock
      .getByRole('button', {
        name: new RegExp(`Open .* session ${alternateSession} as a tab`),
      })
      .click();

    await expect(page).toHaveURL(new RegExp(`workspace=${alternateWorkspaceId}(?:&|$)`));
    expect(new URL(page.url()).searchParams.has('session')).toBe(false);
    await expect(page.getByRole('tab', { name: new RegExp(alternateSession) })).toHaveCount(0);
    await expect(page.getByText('Choose a session from the bar above')).toBeVisible();
  });

  test('removes a stale session query when the requested workspace is empty', async ({
    page,
  }) => {
    await page.route(`**/terminal/v1/workspaces/${workspaceId}`, async (route) => {
      await route.fulfill({
        json: {
          project_id: workspaceId,
          path: '/tmp/dolphin-terminal-e2e',
          path_exists: true,
          is_directory: true,
          is_allowed: true,
          message: 'Workspace is ready.',
          session_count: 0,
          sessions: [],
        },
      });
    });
    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=missing-session`,
    );

    await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}(?:&|$)`));
    expect(new URL(page.url()).searchParams.has('session')).toBe(false);
    await expect(page.getByText('Choose a session from the bar above')).toBeVisible();
  });

  test('rolls back to a committed workspace that has no selected session', async ({
    page,
    request,
  }) => {
    const alternateCreated = await request.post(
      `/terminal/v1/workspaces/${alternateWorkspaceId}/sessions`,
      { data: { name: `rollback-empty-${run}`, mode: 'shell' } },
    );
    const alternateSession = ((await alternateCreated.json()) as { name: string }).name;
    await page.route(`**/terminal/v1/workspaces/${workspaceId}`, async (route) => {
      await route.fulfill({
        json: {
          project_id: workspaceId,
          path: '/tmp/dolphin-terminal-e2e',
          path_exists: true,
          is_directory: true,
          is_allowed: true,
          message: 'Workspace is ready.',
          session_count: 0,
          sessions: [],
        },
      });
    });
    let alternateWorkspaceLoads = 0;
    await page.route(
      `**/terminal/v1/workspaces/${alternateWorkspaceId}`,
      async (route) => {
        alternateWorkspaceLoads += 1;
        if (alternateWorkspaceLoads === 1) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          json: { detail: 'Empty workspace transition failed.' },
        });
      },
    );

    await page.goto(`/?workspace=${encodeURIComponent(workspaceId)}`);
    const dock = page.getByRole('region', { name: 'Open sessions' });
    await expect(page.getByText('Choose a session from the bar above')).toBeVisible();
    await dock.getByLabel('Project for terminal sessions').selectOption(alternateWorkspaceId);
    await dock
      .getByRole('button', {
        name: new RegExp(`Open .* session ${alternateSession} as a tab`),
      })
      .click();

    await expect(page.getByRole('alert')).toContainText(
      'Empty workspace transition failed.',
    );
    await expect(page).toHaveURL(new RegExp(`workspace=${workspaceId}(?:&|$)`));
    expect(new URL(page.url()).searchParams.has('session')).toBe(false);
    await expect(page.getByRole('tab', { name: new RegExp(alternateSession) })).toHaveCount(0);
    await expect(page.getByText('Choose a session from the bar above')).toBeVisible();
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
    const alternateCreated = await request.post(
      `/terminal/v1/workspaces/${workspaceId}/sessions`,
      { data: { name: `${requestedRouteTarget}-alternate`, mode: 'shell' } },
    );
    expect(alternateCreated.status()).toBe(201);
    const alternateSession = ((await alternateCreated.json()) as { name: string }).name;

    await page.addInitScript(({ projectId, routeSession, alternateSession }) => {
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
      window.sessionStorage.setItem(
        [
          'dolphin.terminal.workspace.tab.v2',
          encodeURIComponent(projectId),
          encodeURIComponent(routeSession),
        ].join(':'),
        JSON.stringify({
          version: 2,
          root: {
            type: 'terminal',
            id: 'scoped-pane',
            preferredProjectId: projectId,
            tabs: [
              { projectId, sessionName: routeSession },
              { projectId, sessionName: alternateSession },
            ],
            activeTabIndex: 1,
          },
          activePaneId: 'scoped-pane',
        }),
      );
    }, { projectId: workspaceId, routeSession, alternateSession });

    await page.goto(
      `/?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(routeSession)}`,
    );
    await expect(page.locator('.terminal-pane').filter({ hasText: routeSession })).toBeVisible();
    await expect(page.getByRole('tab', { name: new RegExp(routeSession) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('tab', { name: new RegExp(alternateSession) }),
    ).toBeVisible();
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
      attachments: { max_bytes: 600 * 1024 * 1024 },
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

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const liveScreen = page.locator('.xterm-screen:visible');
    const liveBounds = await liveScreen.boundingBox();
    expect(liveBounds).not.toBeNull();
    await page.mouse.move(liveBounds!.x + 1, liveBounds!.y + 34);
    await page.mouse.down();
    await page.mouse.move(liveBounds!.x + 310, liveBounds!.y + 34, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTitle('Copy selection')).toBeEnabled();
    await page.getByTitle('Copy selection').click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(`NATIVE_BROWSER_${run}`);

    await page.getByTitle(/Select terminal text/).click();
    const copyLayer = page.getByLabel('Selectable terminal text');
    await expect(copyLayer).toContainText(
      `NATIVE_BROWSER_${run}`,
    );
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
    await page.getByRole('button', { name: `Placement options for ${secondary}` }).click();
    await page.getByRole('menuitem', { name: 'Hide from session bar' }).click();
    await expect(page.getByRole('button', { name: `Restore session ${secondary}` })).toBeVisible();
    await page.getByRole('button', { name: `Rename session ${secondary}` }).click();
    const hiddenRename = page.getByRole('textbox', { name: `Rename session ${secondary}` });
    const renamedSecondary = `${requestedSecondary}-renamed-dolphin`;
    await hiddenRename.fill(`${requestedSecondary}-renamed`);
    await hiddenRename.press('Enter');
    await expect(
      page.getByRole('button', { name: `Restore session ${renamedSecondary}` }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('button', { name: `Restore session ${renamedSecondary}` }),
    ).toBeVisible();
    await page.getByRole('button', { name: `Restore session ${renamedSecondary}` }).click();
    const renamedSecondaryTab = page.getByRole('tab', {
      name: new RegExp(renamedSecondary),
    });
    const renamedSecondaryOpen = page.getByRole('button', {
      name: new RegExp(`Open .* session ${renamedSecondary} as a tab`),
    });
    await expect(renamedSecondaryTab.or(renamedSecondaryOpen)).toBeVisible();
    if (await renamedSecondaryOpen.isVisible()) {
      await renamedSecondaryOpen.click();
    }
    await expect(renamedSecondaryTab).toBeVisible();
    await page.getByRole('button', { name: `Close terminal tab ${primary}` }).click();
    await page.getByRole('button', { name: `Placement options for ${primary}` }).click();
    await page.getByRole('menuitem', { name: 'Open right of active view' }).click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await expect(page.getByRole('separator', { name: /Resize terminal views/ })).toHaveCount(1);
    await expect(page).toHaveURL(
      new RegExp(`workspace=${workspaceId}.*session=${primary}`),
    );
    await page.reload();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: new RegExp(primary) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
    expect((await inventory(request)).sessions.map((session) => session.name)).toContain(
      renamedSecondary,
    );
  });
});
