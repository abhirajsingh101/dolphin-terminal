import { describe, expect, it } from 'vitest';

import {
  activateTerminalTab,
  activeTerminalTab,
  closeTerminalTab,
  collectTerminalPanes,
  createTerminalWorkspace,
  findTerminalPaneByTarget,
  findTerminalTabByTarget,
  moveTerminalTab,
  openTerminalTab,
  parseTerminalWorkspace,
  removeTerminalPane,
  renameTerminalSessionTarget,
  serializeTerminalWorkspace,
  splitTerminalPane,
  updateTerminalSplitLayout,
} from './terminalWorkspaceModel';

describe('terminal workspace layout', () => {
  it('starts with one exact project/session target', () => {
    const state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');

    expect(state.activePaneId).toBe('pane-a');
    expect(collectTerminalPanes(state.root)).toEqual([
      {
        type: 'terminal',
        id: 'pane-a',
        preferredProjectId: 'project-a',
        tabs: [{ projectId: 'project-a', sessionName: 'session-a' }],
        activeTabIndex: 0,
      },
    ]);
  });

  it('supports recursively splitting any pane in either direction', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = splitTerminalPane(
      state,
      'pane-b',
      'vertical',
      'split-b',
      'pane-c',
    );

    expect(state.activePaneId).toBe('pane-c');
    expect(state.root).toMatchObject({
      type: 'split',
      id: 'split-a',
      orientation: 'horizontal',
      children: [
        { type: 'terminal', id: 'pane-a' },
        {
          type: 'split',
          id: 'split-b',
          orientation: 'vertical',
          children: [
            { type: 'terminal', id: 'pane-b' },
            { type: 'terminal', id: 'pane-c' },
          ],
        },
      ],
    });
    expect(collectTerminalPanes(state.root).map((pane) => pane.id)).toEqual([
      'pane-a',
      'pane-b',
      'pane-c',
    ]);
  });

  it('can place a chosen session on either side without an empty intermediate pane', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
      'before',
    );
    state = openTerminalTab(
      state,
      'pane-b',
      'project-b',
      'session-b',
    );

    expect(state.activePaneId).toBe('pane-b');
    expect(state.root).toMatchObject({
      type: 'split',
      orientation: 'horizontal',
      children: [
        {
          type: 'terminal',
          id: 'pane-b',
          tabs: [{ projectId: 'project-b', sessionName: 'session-b' }],
          activeTabIndex: 0,
        },
        {
          type: 'terminal',
          id: 'pane-a',
          tabs: [{ projectId: 'project-a', sessionName: 'session-a' }],
          activeTabIndex: 0,
        },
      ],
    });
    expect(collectTerminalPanes(state.root).every((pane) => activeTerminalTab(pane))).toBe(
      true,
    );
  });

  it('adds and activates tabs without changing the stable split identity', () => {
    const initial = createTerminalWorkspace('project-a', null, 'pane-a');
    let assigned = openTerminalTab(
      initial,
      'pane-a',
      'project-b',
      'session-b',
    );
    assigned = openTerminalTab(
      assigned,
      'pane-a',
      'project-c',
      'session-c',
    );

    expect(assigned.root).toEqual({
      type: 'terminal',
      id: 'pane-a',
      preferredProjectId: 'project-c',
      tabs: [
        { projectId: 'project-b', sessionName: 'session-b' },
        { projectId: 'project-c', sessionName: 'session-c' },
      ],
      activeTabIndex: 1,
    });
    expect(findTerminalPaneByTarget(assigned.root, 'project-b', 'session-b')).toBe(
      'pane-a',
    );
    expect(findTerminalTabByTarget(assigned.root, 'project-c', 'session-c')).toEqual({
      paneId: 'pane-a',
      tabIndex: 1,
    });
    assigned = activateTerminalTab(
      assigned,
      'pane-a',
      'project-b',
      'session-b',
    );
    expect(activeTerminalTab(collectTerminalPanes(assigned.root)[0])).toEqual({
      projectId: 'project-b',
      sessionName: 'session-b',
    });
    expect(initial.root).not.toBe(assigned.root);
  });

  it('closes only one browser tab and selects its nearest neighbor', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = openTerminalTab(state, 'pane-a', 'project-b', 'session-b');
    state = openTerminalTab(state, 'pane-a', 'project-c', 'session-c');

    state = closeTerminalTab(state, 'pane-a', 'project-b', 'session-b');
    const pane = collectTerminalPanes(state.root)[0];
    expect(pane.tabs).toEqual([
      { projectId: 'project-a', sessionName: 'session-a' },
      { projectId: 'project-c', sessionName: 'session-c' },
    ]);
    expect(activeTerminalTab(pane)).toEqual({
      projectId: 'project-c',
      sessionName: 'session-c',
    });
  });

  it('reorders tabs inside one split using insertion slots', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = openTerminalTab(state, 'pane-a', 'project-b', 'session-b');
    state = openTerminalTab(state, 'pane-a', 'project-c', 'session-c');

    state = moveTerminalTab(
      state,
      'pane-a',
      'pane-a',
      'project-a',
      'session-a',
      3,
    );

    const pane = collectTerminalPanes(state.root)[0];
    expect(pane.tabs).toEqual([
      { projectId: 'project-b', sessionName: 'session-b' },
      { projectId: 'project-c', sessionName: 'session-c' },
      { projectId: 'project-a', sessionName: 'session-a' },
    ]);
    expect(activeTerminalTab(pane)).toEqual({
      projectId: 'project-a',
      sessionName: 'session-a',
    });
  });

  it('moves a tab across split groups and collapses an emptied source group', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = openTerminalTab(state, 'pane-a', 'project-b', 'session-b');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = openTerminalTab(state, 'pane-b', 'project-c', 'session-c');
    state = moveTerminalTab(
      state,
      'pane-a',
      'pane-b',
      'project-b',
      'session-b',
      0,
    );

    expect(collectTerminalPanes(state.root)).toMatchObject([
      {
        id: 'pane-a',
        tabs: [{ projectId: 'project-a', sessionName: 'session-a' }],
      },
      {
        id: 'pane-b',
        tabs: [
          { projectId: 'project-b', sessionName: 'session-b' },
          { projectId: 'project-c', sessionName: 'session-c' },
        ],
        activeTabIndex: 0,
      },
    ]);

    state = moveTerminalTab(
      state,
      'pane-a',
      'pane-b',
      'project-a',
      'session-a',
    );
    expect(collectTerminalPanes(state.root)).toMatchObject([
      {
        id: 'pane-b',
        tabs: [
          { projectId: 'project-b', sessionName: 'session-b' },
          { projectId: 'project-c', sessionName: 'session-c' },
          { projectId: 'project-a', sessionName: 'session-a' },
        ],
        activeTabIndex: 2,
      },
    ]);
    expect(state.activePaneId).toBe('pane-b');
  });

  it('reuses an already-open session instead of mounting it in two split groups', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = openTerminalTab(state, 'pane-b', 'project-b', 'session-b');
    state = openTerminalTab(state, 'pane-b', 'project-a', 'session-a');

    expect(state.activePaneId).toBe('pane-a');
    expect(
      collectTerminalPanes(state.root).flatMap((pane) => pane.tabs),
    ).toEqual([
      { projectId: 'project-a', sessionName: 'session-a' },
      { projectId: 'project-b', sessionName: 'session-b' },
    ]);
  });

  it('keeps every open pane attached when its tmux session is renamed', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = openTerminalTab(state, 'pane-b', 'project-b', 'session-b');

    const renamed = renameTerminalSessionTarget(
      state,
      'project-a',
      'session-a',
      'release-dolphin',
    );

    expect(findTerminalPaneByTarget(
      renamed.root,
      'project-a',
      'release-dolphin',
    )).toBe('pane-a');
    expect(findTerminalPaneByTarget(renamed.root, 'project-a', 'session-a')).toBeNull();
    expect(findTerminalPaneByTarget(renamed.root, 'project-b', 'session-b')).toBe(
      'pane-b',
    );
    expect(renamed.activePaneId).toBe(state.activePaneId);
  });

  it('collapses redundant split branches when a view closes', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = splitTerminalPane(
      state,
      'pane-b',
      'vertical',
      'split-b',
      'pane-c',
    );

    state = removeTerminalPane(state, 'pane-b');
    expect(collectTerminalPanes(state.root).map((pane) => pane.id)).toEqual([
      'pane-a',
      'pane-c',
    ]);
    expect(state.root).toMatchObject({
      type: 'split',
      id: 'split-a',
      children: [
        { id: 'pane-a' },
        { type: 'terminal', id: 'pane-c' },
      ],
    });

    state = removeTerminalPane(state, 'pane-c');
    expect(state.root).toMatchObject({ type: 'terminal', id: 'pane-a' });
    expect(state.activePaneId).toBe('pane-a');

    // The workspace always retains one place from which another session can
    // be selected. Closing a view is never the same operation as killing tmux.
    expect(removeTerminalPane(state, 'pane-a')).toEqual(state);
  });

  it('remembers user-resized percentages by stable child id', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = updateTerminalSplitLayout(state, 'split-a', {
      'pane-a': 62,
      'pane-b': 38,
    });

    expect(state.root).toMatchObject({
      type: 'split',
      sizes: { 'pane-a': 62, 'pane-b': 38 },
    });
  });

  it('round-trips valid layouts and rejects malformed persisted trees', () => {
    let state = createTerminalWorkspace('project-a', 'session-a', 'pane-a');
    state = splitTerminalPane(
      state,
      'pane-a',
      'horizontal',
      'split-a',
      'pane-b',
    );
    state = openTerminalTab(
      state,
      'pane-b',
      'project-b',
      'session-b',
    );
    const fallback = createTerminalWorkspace(
      'fallback-project',
      'fallback-session',
      'fallback-pane',
    );

    expect(parseTerminalWorkspace(serializeTerminalWorkspace(state), fallback)).toEqual(
      state,
    );
    expect(parseTerminalWorkspace('{not json', fallback)).toEqual(fallback);
    expect(
      parseTerminalWorkspace(
        JSON.stringify({
          version: 1,
          activePaneId: 'missing',
          root: { type: 'terminal', id: '', projectId: 12, sessionName: [] },
        }),
        fallback,
      ),
    ).toEqual(fallback);
  });

  it('promotes a persisted one-session leaf into a tab group', () => {
    const fallback = createTerminalWorkspace(
      'fallback-project',
      'fallback-session',
      'fallback-pane',
    );
    const migrated = parseTerminalWorkspace(
      JSON.stringify({
        version: 1,
        activePaneId: 'legacy-pane',
        root: {
          type: 'terminal',
          id: 'legacy-pane',
          projectId: 'project-a',
          sessionName: 'session-a',
        },
      }),
      fallback,
    );

    expect(migrated).toEqual({
      version: 2,
      activePaneId: 'legacy-pane',
      root: {
        type: 'terminal',
        id: 'legacy-pane',
        preferredProjectId: 'project-a',
        tabs: [{ projectId: 'project-a', sessionName: 'session-a' }],
        activeTabIndex: 0,
      },
    });
  });

  it('rejects persisted layouts that would attach one session twice', () => {
    const fallback = createTerminalWorkspace(
      'fallback-project',
      'fallback-session',
      'fallback-pane',
    );
    const duplicateTarget = {
      projectId: 'project-a',
      sessionName: 'session-a',
    };

    expect(
      parseTerminalWorkspace(
        JSON.stringify({
          version: 2,
          activePaneId: 'pane-a',
          root: {
            type: 'split',
            id: 'split-a',
            orientation: 'horizontal',
            sizes: { 'pane-a': 50, 'pane-b': 50 },
            children: [
              {
                type: 'terminal',
                id: 'pane-a',
                preferredProjectId: 'project-a',
                tabs: [duplicateTarget],
                activeTabIndex: 0,
              },
              {
                type: 'terminal',
                id: 'pane-b',
                preferredProjectId: 'project-a',
                tabs: [duplicateTarget],
                activeTabIndex: 0,
              },
            ],
          },
        }),
        fallback,
      ),
    ).toEqual(fallback);
  });
});
