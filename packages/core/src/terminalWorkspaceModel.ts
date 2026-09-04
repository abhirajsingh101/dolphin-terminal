export type TerminalSplitOrientation = 'horizontal' | 'vertical';
export type TerminalSplitPosition = 'before' | 'after';

export interface TerminalWorkspaceTab {
  projectId: string;
  sessionName: string;
}

export interface TerminalWorkspacePane {
  type: 'terminal';
  id: string;
  preferredProjectId: string | null;
  tabs: TerminalWorkspaceTab[];
  activeTabIndex: number;
}

export interface TerminalWorkspaceSplit {
  type: 'split';
  id: string;
  orientation: TerminalSplitOrientation;
  children: TerminalWorkspaceNode[];
  sizes: Record<string, number>;
}

export type TerminalWorkspaceNode =
  | TerminalWorkspacePane
  | TerminalWorkspaceSplit;

export interface TerminalWorkspaceState {
  version: 2;
  root: TerminalWorkspaceNode;
  activePaneId: string;
}

const MAX_PERSISTED_NODES = 128;
const MAX_TABS_PER_PANE = 128;
const MAX_ID_LENGTH = 120;
const MAX_TARGET_LENGTH = 240;

export function createTerminalWorkspace(
  projectId: string,
  sessionName: string | null,
  paneId: string,
): TerminalWorkspaceState {
  const tabs = sessionName ? [{ projectId, sessionName }] : [];
  return {
    version: 2,
    root: {
      type: 'terminal',
      id: paneId,
      preferredProjectId: projectId,
      tabs,
      activeTabIndex: 0,
    },
    activePaneId: paneId,
  };
}

export function activeTerminalTab(
  pane: TerminalWorkspacePane,
): TerminalWorkspaceTab | null {
  return pane.tabs[pane.activeTabIndex] ?? null;
}

export function collectTerminalPanes(
  node: TerminalWorkspaceNode,
): TerminalWorkspacePane[] {
  if (node.type === 'terminal') return [node];
  return node.children.flatMap(collectTerminalPanes);
}

export function findTerminalPane(
  node: TerminalWorkspaceNode,
  paneId: string,
): TerminalWorkspacePane | null {
  if (node.type === 'terminal') return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findTerminalPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function findTerminalPaneByTarget(
  node: TerminalWorkspaceNode,
  projectId: string,
  sessionName: string,
): string | null {
  return (
    collectTerminalPanes(node).find(
      (pane) => pane.tabs.some(
        (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
      ),
    )?.id ?? null
  );
}

export function findTerminalTabByTarget(
  node: TerminalWorkspaceNode,
  projectId: string,
  sessionName: string,
): { paneId: string; tabIndex: number } | null {
  for (const pane of collectTerminalPanes(node)) {
    const tabIndex = pane.tabs.findIndex(
      (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
    );
    if (tabIndex >= 0) return { paneId: pane.id, tabIndex };
  }
  return null;
}

function updateNode(
  node: TerminalWorkspaceNode,
  targetId: string,
  update: (target: TerminalWorkspaceNode) => TerminalWorkspaceNode,
): TerminalWorkspaceNode {
  if (node.id === targetId) return update(node);
  if (node.type === 'terminal') return node;

  let changed = false;
  const children = node.children.map((child) => {
    const next = updateNode(child, targetId, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function activateTerminalTab(
  state: TerminalWorkspaceState,
  paneId: string,
  projectId: string,
  sessionName: string,
): TerminalWorkspaceState {
  const pane = findTerminalPane(state.root, paneId);
  const tabIndex = pane?.tabs.findIndex(
    (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
  ) ?? -1;
  if (!pane || tabIndex < 0) return state;
  const root = updateNode(state.root, paneId, (node) =>
    node.type === 'terminal' && node.activeTabIndex !== tabIndex
      ? { ...node, activeTabIndex: tabIndex, preferredProjectId: projectId }
      : node,
  );
  if (root === state.root && state.activePaneId === paneId) return state;
  return { ...state, root, activePaneId: paneId };
}

export function openTerminalTab(
  state: TerminalWorkspaceState,
  paneId: string,
  projectId: string,
  sessionName: string,
  requestedTabIndex?: number,
): TerminalWorkspaceState {
  const existing = findTerminalTabByTarget(state.root, projectId, sessionName);
  if (existing) {
    return activateTerminalTab(
      state,
      existing.paneId,
      projectId,
      sessionName,
    );
  }
  const root = updateNode(state.root, paneId, (node) =>
    node.type === 'terminal'
      ? (() => {
          const tabIndex = Math.max(
            0,
            Math.min(requestedTabIndex ?? node.tabs.length, node.tabs.length),
          );
          const tabs = [...node.tabs];
          tabs.splice(tabIndex, 0, { projectId, sessionName });
          return {
            ...node,
            preferredProjectId: projectId,
            tabs,
            activeTabIndex: tabIndex,
          };
        })()
      : node,
  );
  return root === state.root
    ? state
    : { ...state, root, activePaneId: paneId };
}

/**
 * Move one browser terminal tab without touching the underlying persistent session.
 * `requestedTabIndex` is an insertion slot in the destination's current tab
 * order, so `0` means before its first tab and `tabs.length` means append.
 */
export function moveTerminalTab(
  state: TerminalWorkspaceState,
  sourcePaneId: string,
  destinationPaneId: string,
  projectId: string,
  sessionName: string,
  requestedTabIndex?: number,
): TerminalWorkspaceState {
  const source = findTerminalPane(state.root, sourcePaneId);
  const destination = findTerminalPane(state.root, destinationPaneId);
  const sourceTabIndex = source?.tabs.findIndex(
    (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
  ) ?? -1;
  if (!source || !destination || sourceTabIndex < 0) return state;

  if (sourcePaneId === destinationPaneId) {
    const tabs = source.tabs.filter((_tab, index) => index !== sourceTabIndex);
    let tabIndex = Math.max(
      0,
      Math.min(requestedTabIndex ?? source.tabs.length, source.tabs.length),
    );
    if (tabIndex > sourceTabIndex) tabIndex -= 1;
    tabIndex = Math.min(tabIndex, tabs.length);
    tabs.splice(tabIndex, 0, { projectId, sessionName });
    const unchanged = tabs.every((tab, index) => tab === source.tabs[index]);
    if (unchanged && source.activeTabIndex === tabIndex) {
      return state.activePaneId === sourcePaneId
        ? state
        : { ...state, activePaneId: sourcePaneId };
    }
    const root = updateNode(state.root, sourcePaneId, (node) =>
      node.type === 'terminal'
        ? {
            ...node,
            preferredProjectId: projectId,
            tabs,
            activeTabIndex: tabIndex,
          }
        : node,
    );
    return { ...state, root, activePaneId: sourcePaneId };
  }

  if (
    destination.tabs.some(
      (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
    )
  ) {
    return activateTerminalTab(
      state,
      destinationPaneId,
      projectId,
      sessionName,
    );
  }

  const destinationTabIndex = Math.max(
    0,
    Math.min(requestedTabIndex ?? destination.tabs.length, destination.tabs.length),
  );
  let root = updateNode(state.root, sourcePaneId, (node) => {
    if (node.type !== 'terminal') return node;
    const tabs = node.tabs.filter((_tab, index) => index !== sourceTabIndex);
    const activeTabIndex =
      tabs.length === 0
        ? 0
        : sourceTabIndex < node.activeTabIndex
          ? node.activeTabIndex - 1
          : sourceTabIndex === node.activeTabIndex
            ? Math.min(sourceTabIndex, tabs.length - 1)
            : node.activeTabIndex;
    return { ...node, tabs, activeTabIndex };
  });
  root = updateNode(root, destinationPaneId, (node) => {
    if (node.type !== 'terminal') return node;
    const tabs = [...node.tabs];
    tabs.splice(destinationTabIndex, 0, { projectId, sessionName });
    return {
      ...node,
      preferredProjectId: projectId,
      tabs,
      activeTabIndex: destinationTabIndex,
    };
  });

  let moved: TerminalWorkspaceState = {
    ...state,
    root,
    activePaneId: destinationPaneId,
  };
  if (source.tabs.length === 1) {
    moved = removeTerminalPane(moved, sourcePaneId);
  }
  return moved;
}

export function closeTerminalTab(
  state: TerminalWorkspaceState,
  paneId: string,
  projectId: string,
  sessionName: string,
): TerminalWorkspaceState {
  const root = updateNode(state.root, paneId, (node) => {
    if (node.type !== 'terminal') return node;
    const removedIndex = node.tabs.findIndex(
      (tab) => tab.projectId === projectId && tab.sessionName === sessionName,
    );
    if (removedIndex < 0) return node;
    const tabs = node.tabs.filter((_tab, index) => index !== removedIndex);
    const activeTabIndex =
      tabs.length === 0
        ? 0
        : removedIndex < node.activeTabIndex
          ? node.activeTabIndex - 1
          : removedIndex === node.activeTabIndex
            ? Math.min(removedIndex, tabs.length - 1)
            : node.activeTabIndex;
    return {
      ...node,
      preferredProjectId: projectId,
      tabs,
      activeTabIndex,
    };
  });
  return root === state.root ? state : { ...state, root, activePaneId: paneId };
}

function renameSessionTargetInNode(
  node: TerminalWorkspaceNode,
  projectId: string,
  currentSessionName: string,
  nextSessionName: string,
): TerminalWorkspaceNode {
  if (node.type === 'terminal') {
    let changed = false;
    const tabs = node.tabs.map((tab) => {
      if (tab.projectId !== projectId || tab.sessionName !== currentSessionName) {
        return tab;
      }
      changed = true;
      return { ...tab, sessionName: nextSessionName };
    });
    return changed ? { ...node, tabs } : node;
  }

  let changed = false;
  const children = node.children.map((child) => {
    const next = renameSessionTargetInNode(
      child,
      projectId,
      currentSessionName,
      nextSessionName,
    );
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function renameTerminalSessionTarget(
  state: TerminalWorkspaceState,
  projectId: string,
  currentSessionName: string,
  nextSessionName: string,
): TerminalWorkspaceState {
  if (currentSessionName === nextSessionName) return state;
  const root = renameSessionTargetInNode(
    state.root,
    projectId,
    currentSessionName,
    nextSessionName,
  );
  return root === state.root ? state : { ...state, root };
}

export function activateTerminalPane(
  state: TerminalWorkspaceState,
  paneId: string,
): TerminalWorkspaceState {
  if (state.activePaneId === paneId || !findTerminalPane(state.root, paneId)) {
    return state;
  }
  return { ...state, activePaneId: paneId };
}

export function splitTerminalPane(
  state: TerminalWorkspaceState,
  paneId: string,
  orientation: TerminalSplitOrientation,
  splitId: string,
  newPaneId: string,
  position: TerminalSplitPosition = 'after',
): TerminalWorkspaceState {
  const target = findTerminalPane(state.root, paneId);
  if (!target) return state;

  const newPane: TerminalWorkspacePane = {
    type: 'terminal',
    id: newPaneId,
    preferredProjectId:
      activeTerminalTab(target)?.projectId ?? target.preferredProjectId,
    tabs: [],
    activeTabIndex: 0,
  };
  const root = updateNode(state.root, paneId, (node) => {
    const children = position === 'before' ? [newPane, node] : [node, newPane];
    return {
      type: 'split',
      id: splitId,
      orientation,
      children,
      sizes: { [node.id]: 50, [newPane.id]: 50 },
    };
  });
  return { ...state, root, activePaneId: newPaneId };
}

function removePaneFromNode(
  node: TerminalWorkspaceNode,
  paneId: string,
): TerminalWorkspaceNode | null {
  if (node.type === 'terminal') return node.id === paneId ? null : node;

  const removedChildren = node.children.map((child) =>
    removePaneFromNode(child, paneId),
  );
  const children = removedChildren
    .filter((child): child is TerminalWorkspaceNode => child !== null);
  if (
    children.length === node.children.length &&
    children.every((child, index) => child === node.children[index])
  ) {
    return node;
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const sizes = Object.fromEntries(
    children.map((child) => [child.id, node.sizes[child.id] ?? 100 / children.length]),
  );
  return { ...node, children, sizes };
}

export function removeTerminalPane(
  state: TerminalWorkspaceState,
  paneId: string,
): TerminalWorkspaceState {
  const before = collectTerminalPanes(state.root);
  if (before.length <= 1 || !before.some((pane) => pane.id === paneId)) return state;

  const root = removePaneFromNode(state.root, paneId);
  if (!root) return state;
  const panes = collectTerminalPanes(root);
  const activePaneId = panes.some((pane) => pane.id === state.activePaneId)
    ? state.activePaneId
    : panes[0].id;
  return { ...state, root, activePaneId };
}

export function updateTerminalSplitLayout(
  state: TerminalWorkspaceState,
  splitId: string,
  sizes: Record<string, number>,
): TerminalWorkspaceState {
  const root = updateNode(state.root, splitId, (node) => {
    if (node.type !== 'split') return node;
    const nextSizes = Object.fromEntries(
      node.children.map((child) => {
        const value = sizes[child.id];
        return [
          child.id,
          Number.isFinite(value) && value > 0
            ? value
            : node.sizes[child.id] ?? 100 / node.children.length,
        ];
      }),
    );
    return { ...node, sizes: nextSizes };
  });
  return root === state.root ? state : { ...state, root };
}

export function serializeTerminalWorkspace(state: TerminalWorkspaceState): string {
  return JSON.stringify(state);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isNullableTarget(value: unknown): value is string | null {
  return value === null || isBoundedString(value, MAX_TARGET_LENGTH);
}

function parseTabs(
  value: unknown,
  workspaceTargets: Set<string>,
): TerminalWorkspaceTab[] | null {
  if (!Array.isArray(value) || value.length > MAX_TABS_PER_PANE) return null;
  const tabs: TerminalWorkspaceTab[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const record = candidate as Record<string, unknown>;
    if (
      !isBoundedString(record.projectId, MAX_TARGET_LENGTH) ||
      !isBoundedString(record.sessionName, MAX_TARGET_LENGTH)
    ) {
      return null;
    }
    const target = `${record.projectId}\0${record.sessionName}`;
    if (workspaceTargets.has(target)) return null;
    workspaceTargets.add(target);
    tabs.push({ projectId: record.projectId, sessionName: record.sessionName });
  }
  return tabs;
}

function parseNode(
  value: unknown,
  ids: Set<string>,
  workspaceTargets: Set<string>,
  count: { value: number },
): TerminalWorkspaceNode | null {
  if (!value || typeof value !== 'object') return null;
  if (count.value >= MAX_PERSISTED_NODES) return null;
  count.value += 1;

  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.id, MAX_ID_LENGTH) || ids.has(record.id)) return null;
  ids.add(record.id);

  if (record.type === 'terminal') {
    if (Array.isArray(record.tabs)) {
      const tabs = parseTabs(record.tabs, workspaceTargets);
      const activeTabIndex = record.activeTabIndex;
      if (
        tabs === null ||
        !isNullableTarget(record.preferredProjectId) ||
        typeof activeTabIndex !== 'number' ||
        !Number.isInteger(activeTabIndex) ||
        activeTabIndex < 0 ||
        (tabs.length > 0 && activeTabIndex >= tabs.length) ||
        (tabs.length === 0 && activeTabIndex !== 0)
      ) {
        return null;
      }
      return {
        type: 'terminal',
        id: record.id,
        preferredProjectId: record.preferredProjectId,
        tabs,
        activeTabIndex,
      };
    }

    // Version 1 stored one target directly on each split leaf. Promote it to
    // the first tab so existing per-browser-tab layouts survive this upgrade.
    if (!isNullableTarget(record.projectId) || !isNullableTarget(record.sessionName)) {
      return null;
    }
    const tabs =
      record.projectId && record.sessionName
        ? [{ projectId: record.projectId, sessionName: record.sessionName }]
        : [];
    if (tabs.length > 0) {
      const target = `${tabs[0].projectId}\0${tabs[0].sessionName}`;
      if (workspaceTargets.has(target)) return null;
      workspaceTargets.add(target);
    }
    return {
      type: 'terminal',
      id: record.id,
      preferredProjectId: record.projectId,
      tabs,
      activeTabIndex: 0,
    };
  }

  if (
    record.type !== 'split' ||
    (record.orientation !== 'horizontal' && record.orientation !== 'vertical') ||
    !Array.isArray(record.children) ||
    record.children.length < 2
  ) {
    return null;
  }

  const children: TerminalWorkspaceNode[] = [];
  for (const child of record.children) {
    const parsed = parseNode(child, ids, workspaceTargets, count);
    if (!parsed) return null;
    children.push(parsed);
  }

  const rawSizes =
    record.sizes && typeof record.sizes === 'object'
      ? (record.sizes as Record<string, unknown>)
      : {};
  const sizes: Record<string, number> = {};
  for (const child of children) {
    const size = rawSizes[child.id];
    sizes[child.id] =
      typeof size === 'number' && Number.isFinite(size) && size > 0
        ? size
        : 100 / children.length;
  }
  return {
    type: 'split',
    id: record.id,
    orientation: record.orientation,
    children,
    sizes,
  };
}

export function parseTerminalWorkspace(
  raw: string | null,
  fallback: TerminalWorkspaceState,
): TerminalWorkspaceState {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || (value.version !== 1 && value.version !== 2)) return fallback;
    const root = parseNode(value.root, new Set(), new Set(), { value: 0 });
    if (
      !root ||
      !isBoundedString(value.activePaneId, MAX_ID_LENGTH) ||
      !findTerminalPane(root, value.activePaneId)
    ) {
      return fallback;
    }
    return { version: 2, root, activePaneId: value.activePaneId };
  } catch {
    return fallback;
  }
}
