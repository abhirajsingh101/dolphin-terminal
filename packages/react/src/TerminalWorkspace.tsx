import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type Layout,
} from 'react-resizable-panels';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { useTerminalRuntime } from './TerminalRuntime.js';
import type { Project, TerminalSession, WorkspaceStatus } from './types.js';
import {
  activeTerminalTab,
  activateTerminalPane,
  activateTerminalTab,
  closeTerminalTab,
  collectTerminalPanes,
  createTerminalWorkspace,
  findTerminalPane,
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
  type TerminalWorkspaceNode,
  type TerminalWorkspacePane,
  type TerminalWorkspaceSplit,
  type TerminalWorkspaceState,
} from './terminalWorkspaceModel.js';
import './styles.css';

const TerminalPane = lazy(() => import('./TerminalPane.js'));
const TAB_STORAGE_KEY = 'dolphin.terminal.workspace.tab.v2';
const LEGACY_STORAGE_KEY = 'dolphin.terminal.workspace.v1';
const LEGACY_MIGRATION_KEY = 'dolphin.terminal.workspace.tab-migration.v2';
let generatedId = 0;

type TerminalPlacement = 'tab' | 'left' | 'right' | 'above' | 'below';

interface TerminalTarget {
  projectId: string;
  projectName: string;
  projectEmoji: string;
  session: TerminalSession;
}

interface DropTargetData {
  type: 'terminal-drop';
  paneId: string;
  placement: TerminalPlacement;
}

interface TabInsertTargetData {
  type: 'terminal-tab-insert';
  paneId: string;
  tabIndex: number;
}

interface TabStripTargetData {
  type: 'terminal-tab-strip';
  paneId: string;
  tabIndex: number;
}

interface TerminalTabDragData {
  type: 'terminal-tab';
  sourcePaneId: string;
  projectId: string;
  projectName: string;
  projectEmoji: string;
  sessionName: string;
}

type ActiveTerminalDrag =
  | {
      origin: 'dock';
      projectId: string;
      projectName: string;
      projectEmoji: string;
      sessionName: string;
      target: TerminalTarget;
    }
  | {
      origin: 'tab';
      projectId: string;
      projectName: string;
      projectEmoji: string;
      sessionName: string;
      sourcePaneId: string;
    };

function nextId(kind: 'pane' | 'split'): string {
  generatedId += 1;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${generatedId.toString(36)}`;
  return `terminal-${kind}-${random}`;
}

function readPersistedWorkspace(
  fallback: TerminalWorkspaceState,
  storage: Storage | undefined,
  storageKey: string,
  legacyStorageKey: string,
  legacyMigrationKey: string,
) {
  try {
    const stored = storage?.getItem(storageKey) ?? null;
    if (stored !== null) return parseTerminalWorkspace(stored, fallback);
  } catch {
    return fallback;
  }

  /* The first upgraded tab claims the old origin-wide layout. Later tabs start
     clean, and old builds can no longer make the new tabs share one workspace
     even if they write the legacy key again. */
  try {
    if (window.localStorage.getItem(legacyMigrationKey) !== 'done') {
      const legacy = window.localStorage.getItem(legacyStorageKey);
      window.localStorage.setItem(legacyMigrationKey, 'done');
      window.localStorage.removeItem(legacyStorageKey);
      if (legacy !== null) {
        const migrated = parseTerminalWorkspace(legacy, fallback);
        storage?.setItem(storageKey, serializeTerminalWorkspace(migrated));
        return migrated;
      }
    }
  } catch {
    // Storage preferences are best-effort. The exact route remains a safe fallback.
  }
  return fallback;
}

function persistWorkspace(
  state: TerminalWorkspaceState,
  storage: Storage | undefined,
  storageKey: string,
) {
  try {
    storage?.setItem(storageKey, serializeTerminalWorkspace(state));
  } catch {
    // A layout preference must not break a live terminal when storage is full
    // or disabled. The in-memory workspace remains fully usable.
  }
}

function sessionDetail(session: TerminalSession): string {
  const process = session.is_codex_running
    ? 'Codex detected'
    : session.is_claude_code_running
      ? 'Claude Code detected'
      : session.current_command || 'Shell';
  return [
    process,
    session.has_recent_activity ? 'recent output' : null,
    session.attached ? 'attached' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const terminalCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length) {
    // The insertion halves live behind the pane preview overlay. Prefer them
    // when the pointer is on the visible tab row so the exact insertion line
    // wins over the larger center "add to group" target.
    const insertionHits = pointerHits.filter(
      (hit) =>
        hit.data?.droppableContainer.data.current?.type ===
        'terminal-tab-insert',
    );
    if (insertionHits.length) return insertionHits;
    const tabStripHits = pointerHits.filter(
      (hit) =>
        hit.data?.droppableContainer.data.current?.type ===
        'terminal-tab-strip',
    );
    return tabStripHits.length ? tabStripHits : pointerHits;
  }
  return closestCenter(args);
};

// Keep the preview just off the pointer so the insertion line or split edge
// underneath remains visible while the collision geometry stays exact.
const offsetTerminalDragPreview: Modifier = ({ transform }) => ({
  ...transform,
  x: transform.x + 14,
  y: transform.y + 42,
});

export interface TerminalWorkspaceProps {
  projects: Project[];
  primaryProject: Project;
  primaryWorkspace: WorkspaceStatus;
  selectedSession: TerminalSession | null;
  isNarrowLayout: boolean;
  onActiveTargetChange: (projectId: string, sessionName: string) => void;
  onCreateSession: (projectId: string, name?: string) => Promise<TerminalSession>;
  onPaneCountChange?: (paneCount: number) => void;
  onRefreshPrimaryProject: () => Promise<void> | void;
  onRenameSession: (
    projectId: string,
    session: TerminalSession,
    name: string,
  ) => Promise<TerminalSession>;
}

interface NodeRendererProps {
  node: TerminalWorkspaceNode;
  renderPane: (pane: TerminalWorkspacePane) => React.ReactNode;
  onLayoutChanged: (splitId: string, layout: Layout) => void;
}

function normalizedLayout(node: TerminalWorkspaceSplit): Layout {
  return Object.fromEntries(
    node.children.map((child) => [
      child.id,
      node.sizes[child.id] ?? 100 / node.children.length,
    ]),
  );
}

function TerminalWorkspaceNodeView({
  node,
  renderPane,
  onLayoutChanged,
}: NodeRendererProps) {
  if (node.type === 'terminal') return renderPane(node);
  return (
    <PanelGroup
      className="terminal-workspace-group"
      defaultLayout={normalizedLayout(node)}
      id={node.id}
      onLayoutChanged={(layout) => onLayoutChanged(node.id, layout)}
      orientation={node.orientation}
      resizeTargetMinimumSize={{ coarse: 28, fine: 8 }}
    >
      {node.children.map((child, index) => (
        <TerminalWorkspaceChild
          child={child}
          index={index}
          key={child.id}
          node={node}
          onLayoutChanged={onLayoutChanged}
          renderPane={renderPane}
        />
      ))}
    </PanelGroup>
  );
}

function TerminalWorkspaceChild({
  child,
  index,
  node,
  renderPane,
  onLayoutChanged,
}: {
  child: TerminalWorkspaceNode;
  index: number;
  node: TerminalWorkspaceSplit;
  renderPane: NodeRendererProps['renderPane'];
  onLayoutChanged: NodeRendererProps['onLayoutChanged'];
}) {
  return (
    <>
      {index > 0 ? (
        <PanelResizeHandle
          aria-label={`Resize terminal views ${index} and ${index + 1}`}
          className={`terminal-workspace-resize-handle ${
            node.orientation === 'horizontal' ? 'vertical' : 'horizontal'
          }`}
        />
      ) : null}
      <Panel
        className="terminal-workspace-panel-slot"
        id={child.id}
        minSize={node.orientation === 'horizontal' ? '150px' : '130px'}
      >
        <TerminalWorkspaceNodeView
          node={child}
          onLayoutChanged={onLayoutChanged}
          renderPane={renderPane}
        />
      </Panel>
    </>
  );
}

function PlacementMenu({
  sessionName,
  canPlace,
  newTabHref,
  onPlace,
}: {
  sessionName: string;
  canPlace: boolean;
  newTabHref: string;
  onPlace: (placement: TerminalPlacement) => void;
}) {
  const {
    icons: {
      ArrowDown,
      ArrowLeft,
      ArrowRight,
      ArrowUp,
      ExternalLink,
      MoreHorizontal,
      Plus,
    },
    portalRoot,
  } = useTerminalRuntime();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const bounds = triggerRef.current.getBoundingClientRect();
    const menuWidth = 218;
    setPosition({
      top: bounds.bottom + 6,
      left: Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function choose(placement: TerminalPlacement) {
    setOpen(false);
    onPlace(placement);
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Placement options for ${sessionName}`}
        className="terminal-session-placement-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title="Split this session or open it in a new browser tab"
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      {open
        ? createPortal(
            <div
              className="terminal-session-placement-menu"
              ref={menuRef}
              role="menu"
              style={position}
            >
              {canPlace ? (
                <>
                  <button onClick={() => choose('tab')} role="menuitem" type="button">
                    <Plus aria-hidden="true" size={14} />
                    Open as tab in active split
                  </button>
                  <button onClick={() => choose('right')} role="menuitem" type="button">
                    <ArrowRight aria-hidden="true" size={14} />
                    Open right of active view
                  </button>
                  <button onClick={() => choose('below')} role="menuitem" type="button">
                    <ArrowDown aria-hidden="true" size={14} />
                    Open below active view
                  </button>
                  <button onClick={() => choose('left')} role="menuitem" type="button">
                    <ArrowLeft aria-hidden="true" size={14} />
                    Open left of active view
                  </button>
                  <button onClick={() => choose('above')} role="menuitem" type="button">
                    <ArrowUp aria-hidden="true" size={14} />
                    Open above active view
                  </button>
                </>
              ) : null}
              <a
                href={newTabHref}
                onClick={() => setOpen(false)}
                rel="noopener"
                role="menuitem"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" size={14} />
                Open in new browser tab
              </a>
            </div>,
            portalRoot ?? document.body,
          )
        : null}
    </>
  );
}

function TerminalSessionLauncher({
  target,
  openPaneId,
  onOpen,
  onRename,
}: {
  target: TerminalTarget;
  openPaneId: string | null;
  onOpen: (placement: TerminalPlacement) => void;
  onRename: (name: string) => Promise<void>;
}) {
  const {
    icons: { Bot, Check, Pencil, TerminalSquare, X },
    labels,
    targetHref,
  } = useTerminalRuntime();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(target.session.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `terminal-session:${target.projectId}:${target.session.name}`,
    data: { type: 'terminal-session', target },
    disabled: openPaneId !== null || editing,
  });
  const action = openPaneId
    ? `Show ${target.projectName} session ${target.session.name} in its open tab`
    : `Open ${target.projectName} session ${target.session.name} as a tab in the active split`;
  const canRename = target.session.rename_allowed !== false;
  const renameTitle = canRename
    ? `Rename ${labels.session}`
    : target.session.rename_block_reason ?? `This ${labels.session} cannot be renamed.`;
  const newTabHref = targetHref({
    projectId: target.projectId,
    sessionName: target.session.name,
  });

  useEffect(() => {
    if (!editing) return;
    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [editing]);

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedName = nameDraft.trim();
    if (!requestedName) {
      setRenameError('Enter a session name.');
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onRename(requestedName);
      setEditing(false);
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : String(reason));
      setRenameBusy(false);
      window.requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }

  if (editing) {
    return (
      <form
        className="terminal-session-launcher terminal-session-rename-form"
        onSubmit={submitRename}
      >
        <input
          aria-label={`Rename ${labels.session} ${target.session.name}`}
          aria-invalid={renameError ? 'true' : undefined}
          autoComplete="off"
          disabled={renameBusy}
          maxLength={80}
          onChange={(event) => {
            setNameDraft(event.target.value);
            setRenameError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || renameBusy) return;
            event.preventDefault();
            setEditing(false);
            setNameDraft(target.session.name);
            setRenameError(null);
          }}
          pattern="[A-Za-z0-9_.-]+"
          ref={renameInputRef}
          spellCheck={false}
          title="Letters, numbers, dots, dashes, and underscores only"
          value={nameDraft}
        />
        <button
          aria-label={`Save renamed ${labels.session} ${target.session.name}`}
          disabled={renameBusy}
          title="Save rename"
          type="submit"
        >
          <Check aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={`Cancel renaming ${labels.session} ${target.session.name}`}
          disabled={renameBusy}
          onClick={() => {
            setEditing(false);
            setNameDraft(target.session.name);
            setRenameError(null);
          }}
          title="Cancel rename"
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
        {renameError ? (
          <span className="terminal-session-form-error" role="alert">
            {renameError}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <div
      className={`terminal-session-launcher${openPaneId ? ' is-open' : ''}${
        isDragging ? ' is-dragging' : ''
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-disabled={undefined}
        aria-label={action}
        className="terminal-session-launcher-main"
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          window.open(newTabHref, '_blank', 'noopener');
        }}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            window.open(newTabHref, '_blank', 'noopener');
            return;
          }
          onOpen('tab');
        }}
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform) }}
        title={
          openPaneId
            ? 'Show this open tab'
            : 'Click to add tab · Ctrl/Cmd-click for new browser tab · drag to split'
        }
        type="button"
      >
        <span className="terminal-session-launcher-icon">
          {target.session.is_codex_running || target.session.is_claude_code_running ? (
            <Bot aria-hidden="true" size={15} />
          ) : (
            <TerminalSquare aria-hidden="true" size={15} />
          )}
        </span>
        <span className="terminal-session-launcher-copy">
          <strong>{target.session.name}</strong>
          <small>{sessionDetail(target.session)}</small>
        </span>
        {openPaneId ? <span className="terminal-session-open-mark">Open</span> : null}
      </button>
      <button
        aria-label={`Rename ${labels.session} ${target.session.name}`}
        className="terminal-session-rename-trigger"
        disabled={!canRename}
        onClick={() => {
          setNameDraft(target.session.name);
          setRenameError(null);
          setEditing(true);
        }}
        title={renameTitle}
        type="button"
      >
        <Pencil aria-hidden="true" size={13} />
      </button>
      <PlacementMenu
        canPlace={openPaneId === null}
        newTabHref={newTabHref}
        onPlace={onOpen}
        sessionName={target.session.name}
      />
    </div>
  );
}

function TerminalSessionCreator({
  project,
  disabled,
  onCreate,
}: {
  project: Project;
  disabled: boolean;
  onCreate: (name?: string) => Promise<void>;
}) {
  const {
    icons: { Check, Plus, X },
    labels,
  } = useTerminalRuntime();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [editing]);

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(nameDraft.trim() || undefined);
      setEditing(false);
      setNameDraft('');
      setCreating(false);
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason));
      setCreating(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  if (!editing) {
    return (
      <button
        aria-label={`New ${labels.session} in ${project.name}`}
        className="terminal-session-create-trigger"
        disabled={disabled}
        onClick={() => {
          setCreateError(null);
          setEditing(true);
        }}
        title={`Create and open a new ${labels.session} in ${project.name}`}
        type="button"
      >
        <Plus aria-hidden="true" size={14} />
        <span>{labels.newSession}</span>
      </button>
    );
  }

  return (
    <form className="terminal-session-create-form" onSubmit={submitCreate}>
      <input
        aria-label={`Name for new ${project.name} ${labels.session}`}
        aria-invalid={createError ? 'true' : undefined}
        autoComplete="off"
        disabled={creating}
        maxLength={80}
        onChange={(event) => {
          setNameDraft(event.target.value);
          setCreateError(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || creating) return;
          event.preventDefault();
          setEditing(false);
          setNameDraft('');
          setCreateError(null);
        }}
        pattern="[A-Za-z0-9_.-]*"
        placeholder="Name (optional)"
        ref={inputRef}
        spellCheck={false}
        title="Letters, numbers, dots, dashes, and underscores only. Leave blank for an automatic name."
        value={nameDraft}
      />
      <button
        aria-label={`Create and open ${labels.session} in ${project.name}`}
        disabled={creating}
        title="Create and open"
        type="submit"
      >
        <Check aria-hidden="true" size={14} />
      </button>
      <button
        aria-label={`Cancel new ${labels.session} in ${project.name}`}
        disabled={creating}
        onClick={() => {
          setEditing(false);
          setNameDraft('');
          setCreateError(null);
        }}
        title="Cancel"
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </button>
      {createError ? (
        <span className="terminal-session-form-error" role="alert">
          {createError}
        </span>
      ) : null}
    </form>
  );
}

function TerminalSessionDock({
  fullscreenHidden,
  projects,
  selectedProjectId,
  workspace,
  loading,
  error,
  projectSelectRef,
  onProjectChange,
  onRefresh,
  findOpenPane,
  onOpen,
  onCreate,
  onRename,
}: {
  fullscreenHidden: boolean;
  projects: Project[];
  selectedProjectId: string;
  workspace: WorkspaceStatus | null;
  loading: boolean;
  error: string | null;
  projectSelectRef: RefObject<HTMLSelectElement | null>;
  onProjectChange: (projectId: string) => void;
  onRefresh: () => void;
  findOpenPane: (projectId: string, sessionName: string) => string | null;
  onOpen: (target: TerminalTarget, placement: TerminalPlacement) => void;
  onCreate: (project: Project, name?: string) => Promise<void>;
  onRename: (target: TerminalTarget, name: string) => Promise<void>;
}) {
  const {
    icons: { ChevronsUpDown, FolderGit2, MousePointer2, RefreshCw },
    labels,
    slots,
  } = useTerminalRuntime();
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];

  return (
    <section
      aria-hidden={fullscreenHidden ? 'true' : undefined}
      aria-label={`Open ${labels.sessions}`}
      className={`terminal-session-dock${
        fullscreenHidden ? ' is-fullscreen-hidden' : ''
      }`}
      inert={fullscreenHidden ? true : undefined}
      role="region"
    >
      {slots.dockLeading ? (
        <div className="terminal-runtime-slot terminal-runtime-slot--dock-leading">
          {slots.dockLeading}
        </div>
      ) : null}
      <div className="terminal-session-project-select">
        <FolderGit2 aria-hidden="true" size={15} />
        <select
          aria-label="Project for terminal sessions"
          onChange={(event) => onProjectChange(event.target.value)}
          ref={projectSelectRef}
          value={selectedProjectId}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.emoji} {project.name}
            </option>
          ))}
        </select>
        <ChevronsUpDown aria-hidden="true" size={13} />
      </div>

      {selectedProject ? (
        <TerminalSessionCreator
          disabled={loading || workspace?.is_allowed !== true}
          key={selectedProject.id}
          onCreate={(name) => onCreate(selectedProject, name)}
          project={selectedProject}
        />
      ) : null}

      <div className="terminal-session-dock-list" role="list">
        {loading ? (
          <span className="terminal-session-dock-status" role="status">
            <RefreshCw aria-hidden="true" size={13} /> Loading sessions…
          </span>
        ) : error ? (
          <span className="terminal-session-dock-status is-error" role="alert">
            Sessions unavailable
          </span>
        ) : workspace?.sessions.length && selectedProject ? (
          workspace.sessions.map((session) => {
            const target: TerminalTarget = {
              projectId: selectedProject.id,
              projectName: selectedProject.name,
              projectEmoji: selectedProject.emoji,
              session,
            };
            return (
              <TerminalSessionLauncher
                key={`${selectedProject.id}:${session.name}`}
                onOpen={(placement) => onOpen(target, placement)}
                onRename={(name) => onRename(target, name)}
                openPaneId={findOpenPane(selectedProject.id, session.name)}
                target={target}
              />
            );
          })
        ) : (
          <span className="terminal-session-dock-status">
            {selectedProject ? `No ${labels.sessions} in this project` : 'No project selected'}
          </span>
        )}
      </div>

      <div className="terminal-session-dock-help">
        <MousePointer2 aria-hidden="true" size={13} />
        <span>Click: add tab · Ctrl/Cmd-click: browser tab · drag: split</span>
      </div>
      {slots.dockTrailing ? (
        <div className="terminal-runtime-slot terminal-runtime-slot--dock-trailing">
          {slots.dockTrailing}
        </div>
      ) : null}
      <button
        aria-label={`Refresh ${labels.sessions}`}
        className="terminal-session-dock-refresh"
        disabled={loading || !selectedProject}
        onClick={onRefresh}
        title={`Refresh ${labels.sessions}`}
        type="button"
      >
        <RefreshCw aria-hidden="true" size={14} />
      </button>
    </section>
  );
}

const DROP_LABELS: Record<DropTargetData['placement'], string> = {
  tab: 'Add to tab group',
  left: 'Split left',
  right: 'Split right',
  above: 'Split above',
  below: 'Split below',
};

function TerminalDropZone({ paneId, placement }: Omit<DropTargetData, 'type'>) {
  const { isOver, setNodeRef } = useDroppable({
    id: `terminal-drop:${paneId}:${placement}`,
    data: { type: 'terminal-drop', paneId, placement } satisfies DropTargetData,
  });
  return (
    <div
      className={`terminal-pane-drop-zone is-${placement}${isOver ? ' is-over' : ''}`}
      ref={setNodeRef}
    >
      <span>{DROP_LABELS[placement]}</span>
    </div>
  );
}

function TerminalPaneDropOverlay({ paneId }: { paneId: string }) {
  return (
    <div aria-hidden="true" className="terminal-pane-drop-overlay">
      <TerminalDropZone paneId={paneId} placement="above" />
      <TerminalDropZone paneId={paneId} placement="left" />
      <TerminalDropZone paneId={paneId} placement="tab" />
      <TerminalDropZone paneId={paneId} placement="right" />
      <TerminalDropZone paneId={paneId} placement="below" />
    </div>
  );
}

function UnassignedTerminalView({
  project,
  missingSessionName,
  isActive,
  canClose,
  onActivate,
  onChoose,
  onClose,
  showDropTargets,
  paneId,
}: {
  project: Project | null;
  missingSessionName: string | null;
  isActive: boolean;
  canClose: boolean;
  onActivate: () => void;
  onChoose: () => void;
  onClose: () => void;
  showDropTargets: boolean;
  paneId: string;
}) {
  const {
    icons: { TerminalSquare },
    labels,
  } = useTerminalRuntime();
  return (
    <section
      className={`terminal-workspace-empty${isActive ? ' active' : ''}`}
      data-pane-id={paneId}
      onPointerDown={onActivate}
    >
      {canClose ? (
        <button className="terminal-workspace-empty-close" onClick={onClose} type="button">
          Close view
        </button>
      ) : null}
      <div className="terminal-workspace-empty-copy">
        <span className="terminal-workspace-empty-icon">
          <TerminalSquare aria-hidden="true" size={24} />
        </span>
        <strong>
          {missingSessionName
            ? `“${missingSessionName}” is no longer available`
            : 'Choose a session from the bar above'}
        </strong>
        <p>
          {project
            ? `Select one of ${project.name}’s ${labels.sessions}, or switch projects directly above.`
            : `Choose a project and exact ${labels.session} directly above.`}
        </p>
        <button className="dt-btn dt-btn--primary" onClick={onChoose} type="button">
          Focus session bar
        </button>
      </div>
      {showDropTargets ? <TerminalPaneDropOverlay paneId={paneId} /> : null}
    </section>
  );
}

export default function TerminalWorkspace({
  projects,
  primaryProject,
  primaryWorkspace,
  selectedSession,
  isNarrowLayout,
  onActiveTargetChange,
  onCreateSession,
  onPaneCountChange,
  onRefreshPrimaryProject,
  onRenameSession,
}: TerminalWorkspaceProps) {
  const {
    client,
    storage,
    storageKey,
    legacyStorageKey,
    legacyMigrationKey,
    labels,
  } = useTerminalRuntime();
  const fetchWorkspace = client.fetchWorkspace.bind(client);
  const initialTargetRef = useRef({
    projectId: primaryProject.id,
    sessionName: selectedSession?.name ?? null,
  });
  const [workspaceState, setWorkspaceState] = useState<TerminalWorkspaceState>(() => {
    const target = initialTargetRef.current;
    const fallback = createTerminalWorkspace(
      target.projectId,
      target.sessionName,
      nextId('pane'),
    );
    return readPersistedWorkspace(
      fallback,
      storage,
      storageKey,
      legacyStorageKey,
      legacyMigrationKey,
    );
  });
  const [workspaceCache, setWorkspaceCache] = useState<Record<string, WorkspaceStatus>>(
    () => ({ [primaryProject.id]: primaryWorkspace }),
  );
  const [dockProjectId, setDockProjectId] = useState(primaryProject.id);
  const [dockLoading, setDockLoading] = useState(false);
  const [dockError, setDockError] = useState<string | null>(null);
  const [activeDragItem, setActiveDragItem] = useState<ActiveTerminalDrag | null>(
    null,
  );
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null);
  const workspaceCacheRef = useRef(workspaceCache);
  const activeTargetChangeRef = useRef(onActiveTargetChange);
  const notifiedActiveTargetRef = useRef('');
  const pendingLoadsRef = useRef(new Map<string, Promise<WorkspaceStatus>>());
  const requestedTargetRef = useRef(
    `${primaryProject.id}:${selectedSession?.name ?? ''}`,
  );
  const projectSelectRef = useRef<HTMLSelectElement>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 7 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Tab],
      },
    }),
  );

  workspaceCacheRef.current = workspaceCache;
  activeTargetChangeRef.current = onActiveTargetChange;

  useEffect(() => {
    setWorkspaceCache((current) => ({
      ...current,
      [primaryProject.id]: primaryWorkspace,
    }));
  }, [primaryProject.id, primaryWorkspace]);

  useEffect(() => {
    if (!projects.some((project) => project.id === dockProjectId)) {
      setDockProjectId(primaryProject.id);
    }
  }, [dockProjectId, primaryProject.id, projects]);

  useEffect(() => {
    persistWorkspace(workspaceState, storage, storageKey);
  }, [storage, storageKey, workspaceState]);

  const loadWorkspace = useCallback(
    (projectId: string, force = false): Promise<WorkspaceStatus> => {
      const cached = workspaceCacheRef.current[projectId];
      if (!force && cached) return Promise.resolve(cached);
      const pending = pendingLoadsRef.current.get(projectId);
      if (!force && pending) return pending;

      const request = fetchWorkspace(projectId)
        .then((workspace) => {
          setWorkspaceCache((current) => ({ ...current, [projectId]: workspace }));
          return workspace;
        })
        .finally(() => {
          if (pendingLoadsRef.current.get(projectId) === request) {
            pendingLoadsRef.current.delete(projectId);
          }
        });
      pendingLoadsRef.current.set(projectId, request);
      return request;
    },
    [],
  );

  useEffect(() => {
    if (workspaceCacheRef.current[dockProjectId]) {
      setDockLoading(false);
      setDockError(null);
      return;
    }
    let current = true;
    setDockLoading(true);
    setDockError(null);
    void loadWorkspace(dockProjectId)
      .catch((reason) => {
        if (!current) return;
        setDockError(
          reason instanceof Error
            ? reason.message
            : `Dolphin Terminal could not load this project’s ${labels.sessions}.`,
        );
      })
      .finally(() => {
        if (current) setDockLoading(false);
      });
    return () => {
      current = false;
    };
  }, [dockProjectId, loadWorkspace]);

  const panes = useMemo(
    () => collectTerminalPanes(workspaceState.root),
    [workspaceState.root],
  );
  const paneCountRef = useRef(panes.length);
  paneCountRef.current = panes.length;
  const activePane =
    findTerminalPane(workspaceState.root, workspaceState.activePaneId) ?? panes[0];
  const activeTab = activeTerminalTab(activePane);

  useEffect(() => {
    if (!activeTab) return;
    const key = `${activeTab.projectId}:${activeTab.sessionName}`;
    if (notifiedActiveTargetRef.current === key) return;
    notifiedActiveTargetRef.current = key;
    activeTargetChangeRef.current(activeTab.projectId, activeTab.sessionName);
  }, [activeTab]);

  useEffect(() => {
    onPaneCountChange?.(panes.length);
  }, [onPaneCountChange, panes.length]);

  useEffect(
    () => () => {
      if (paneCountRef.current > 1) onPaneCountChange?.(1);
    },
    [onPaneCountChange],
  );

  useEffect(() => {
    const projectIds = new Set(
      panes.flatMap((pane) =>
        pane.tabs.map((tab) => tab.projectId),
      ),
    );
    for (const projectId of projectIds) {
      if (!workspaceCacheRef.current[projectId]) {
        void loadWorkspace(projectId).catch(() => undefined);
      }
    }
  }, [loadWorkspace, panes]);

  useEffect(() => {
    const key = `${primaryProject.id}:${selectedSession?.name ?? ''}`;
    if (!selectedSession || requestedTargetRef.current === key) return;
    requestedTargetRef.current = key;
    setWorkspaceState((current) => {
      const existing = findTerminalTabByTarget(
        current.root,
        primaryProject.id,
        selectedSession.name,
      );
      return existing
        ? activateTerminalTab(
            current,
            existing.paneId,
            primaryProject.id,
            selectedSession.name,
          )
        : openTerminalTab(
            current,
            current.activePaneId,
            primaryProject.id,
            selectedSession.name,
          );
    });
  }, [primaryProject.id, selectedSession]);

  const activatePane = useCallback(
    (pane: TerminalWorkspacePane) => {
      setWorkspaceState((current) => activateTerminalPane(current, pane.id));
      const tab = activeTerminalTab(pane);
      if (tab) {
        onActiveTargetChange(tab.projectId, tab.sessionName);
      }
    },
    [onActiveTargetChange],
  );

  const placeTarget = useCallback(
    (
      target: TerminalTarget,
      requestedPlacement: TerminalPlacement,
      requestedPaneId?: string,
      requestedTabIndex?: number,
    ) => {
      const paneId = requestedPaneId ?? workspaceState.activePaneId;
      const placement = requestedPlacement;
      setWorkspaceState((current) => {
        const existing = findTerminalTabByTarget(
          current.root,
          target.projectId,
          target.session.name,
        );
        if (existing) {
          return activateTerminalTab(
            current,
            existing.paneId,
            target.projectId,
            target.session.name,
          );
        }

        const destination = findTerminalPane(current.root, paneId);
        if (!destination) return current;
        if (placement === 'tab' || destination.tabs.length === 0) {
          return openTerminalTab(
            current,
            destination.id,
            target.projectId,
            target.session.name,
            requestedTabIndex,
          );
        }

        const orientation =
          placement === 'left' || placement === 'right'
            ? 'horizontal'
            : 'vertical';
        const position =
          placement === 'left' || placement === 'above' ? 'before' : 'after';
        const newPaneId = nextId('pane');
        const split = splitTerminalPane(
          current,
          destination.id,
          orientation,
          nextId('split'),
          newPaneId,
          position,
        );
        return openTerminalTab(
          split,
          newPaneId,
          target.projectId,
          target.session.name,
        );
      });
      onActiveTargetChange(target.projectId, target.session.name);
    },
    [onActiveTargetChange, workspaceState.activePaneId],
  );

  async function refreshPaneProject(projectId: string) {
    await loadWorkspace(projectId, true);
    if (projectId === primaryProject.id) await onRefreshPrimaryProject();
  }

  function sessionForPane(pane: TerminalWorkspacePane): TerminalSession | null {
    const tab = activeTerminalTab(pane);
    if (!tab) return null;
    return (
      workspaceCache[tab.projectId]?.sessions.find(
        (session) => session.name === tab.sessionName,
      ) ?? null
    );
  }

  const focusSessionDock = useCallback((pane: TerminalWorkspacePane) => {
    setWorkspaceState((current) => activateTerminalPane(current, pane.id));
    const projectId = activeTerminalTab(pane)?.projectId ?? pane.preferredProjectId;
    if (projectId && projects.some((project) => project.id === projectId)) {
      setDockProjectId(projectId);
    }
    window.requestAnimationFrame(() => projectSelectRef.current?.focus());
  }, [projects]);

  const renderPane = useCallback(
    (pane: TerminalWorkspacePane) => {
      const tab = activeTerminalTab(pane);
      const project =
        projects.find(
          (candidate) =>
            candidate.id === (tab?.projectId ?? pane.preferredProjectId),
        ) ?? null;
      const session = sessionForPane(pane);
      const isActive = pane.id === workspaceState.activePaneId;
      const isFullscreenOwner = fullscreenPaneId === pane.id;
      const isFullscreenBackground =
        fullscreenPaneId !== null && !isFullscreenOwner;
      const canClose = panes.length > 1;
      const paneIndex = panes.findIndex((candidate) => candidate.id === pane.id);
      const close = () => {
        setWorkspaceState((current) => removeTerminalPane(current, pane.id));
      };
      if (!tab) {
        return (
          <UnassignedTerminalView
            canClose={canClose}
            isActive={isActive}
            missingSessionName={null}
            onActivate={() => activatePane(pane)}
            onChoose={() => focusSessionDock(pane)}
            onClose={close}
            paneId={pane.id}
            project={project}
            showDropTargets={activeDragItem !== null}
          />
        );
      }

      return (
        <div
          aria-hidden={isFullscreenBackground ? 'true' : undefined}
          className={`terminal-workspace-leaf${isActive ? ' active' : ''}${
            isFullscreenOwner ? ' fullscreen-owner' : ''
          }${isFullscreenBackground ? ' fullscreen-background' : ''}`}
          data-pane-id={pane.id}
          inert={isFullscreenBackground ? true : undefined}
          onPointerDownCapture={() => activatePane(pane)}
        >
          <Suspense
            fallback={<div className="terminal-workspace-loading">Opening terminal…</div>}
          >
            <TerminalPane
              dictationTargetId={`dolphin-terminal-dictation-${pane.id}`}
              enableWebgl={paneIndex < 6}
              projectId={tab.projectId}
              session={session}
              workspaceControls={{
                paneId: pane.id,
                tabs: pane.tabs.map((paneTab, tabIndex) => {
                  const tabProject = projects.find(
                    (candidate) => candidate.id === paneTab.projectId,
                  );
                  return {
                    ...paneTab,
                    projectName: tabProject?.name ?? 'Unknown project',
                    projectEmoji: tabProject?.emoji ?? '◫',
                    isActive: tabIndex === pane.activeTabIndex,
                  };
                }),
                isActive,
                isSplit: panes.length > 1,
                canClose,
                onActivateTab: (projectId, sessionName) => {
                  setWorkspaceState((current) =>
                    activateTerminalTab(
                      current,
                      pane.id,
                      projectId,
                      sessionName,
                    ),
                  );
                  onActiveTargetChange(projectId, sessionName);
                },
                onCloseTab: (projectId, sessionName) => {
                  setWorkspaceState((current) =>
                    closeTerminalTab(
                      current,
                      pane.id,
                      projectId,
                      sessionName,
                    ),
                  );
                },
                onCloseView: close,
                onFullscreenChange: (fullscreen) => {
                  if (fullscreen) activatePane(pane);
                  setFullscreenPaneId((current) =>
                    fullscreen ? pane.id : current === pane.id ? null : current,
                  );
                },
              }}
              onSessionClosed={() => {
                setWorkspaceState((current) =>
                  closeTerminalTab(
                    current,
                    pane.id,
                    tab.projectId,
                    tab.sessionName,
                  ),
                );
                void refreshPaneProject(tab.projectId);
              }}
              onSessionChanged={() => {
                void refreshPaneProject(tab.projectId);
              }}
            />
          </Suspense>
          {activeDragItem ? <TerminalPaneDropOverlay paneId={pane.id} /> : null}
        </div>
      );
    },
    // Stable pane ids preserve terminal connections while active borders,
    // drop zones, and project/session observations update together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeDragItem, fullscreenPaneId, panes, primaryProject.id, projects, workspaceCache, workspaceState.activePaneId],
  );

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as
      | { type?: 'terminal-session'; target?: TerminalTarget }
      | Partial<TerminalTabDragData>
      | undefined;
    if (data?.type === 'terminal-session' && data.target) {
      setActiveDragItem({
        origin: 'dock',
        projectId: data.target.projectId,
        projectName: data.target.projectName,
        projectEmoji: data.target.projectEmoji,
        sessionName: data.target.session.name,
        target: data.target,
      });
      return;
    }
    if (
      data?.type === 'terminal-tab' &&
      typeof data.sourcePaneId === 'string' &&
      typeof data.projectId === 'string' &&
      typeof data.projectName === 'string' &&
      typeof data.projectEmoji === 'string' &&
      typeof data.sessionName === 'string'
    ) {
      setActiveDragItem({
        origin: 'tab',
        sourcePaneId: data.sourcePaneId,
        projectId: data.projectId,
        projectName: data.projectName,
        projectEmoji: data.projectEmoji,
        sessionName: data.sessionName,
      });
      return;
    }
    setActiveDragItem(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const item = activeDragItem;
    setActiveDragItem(null);
    const data = event.over?.data.current as
      | Partial<DropTargetData>
      | Partial<TabInsertTargetData>
      | Partial<TabStripTargetData>
      | undefined;
    if (!item || typeof data?.paneId !== 'string') return;

    if (item.origin === 'dock') {
      if (
        (data.type === 'terminal-tab-insert' ||
          data.type === 'terminal-tab-strip') &&
        typeof data.tabIndex === 'number'
      ) {
        placeTarget(item.target, 'tab', data.paneId, data.tabIndex);
      } else if (data.type === 'terminal-drop' && data.placement) {
        placeTarget(item.target, data.placement, data.paneId);
      }
      return;
    }

    if (
      (data.type === 'terminal-tab-insert' ||
        data.type === 'terminal-tab-strip') &&
      typeof data.tabIndex === 'number'
    ) {
      setWorkspaceState((current) =>
        moveTerminalTab(
          current,
          item.sourcePaneId,
          data.paneId as string,
          item.projectId,
          item.sessionName,
          data.tabIndex,
        ),
      );
      onActiveTargetChange(item.projectId, item.sessionName);
      return;
    }
    if (data.type !== 'terminal-drop' || !data.placement) return;

    setWorkspaceState((current) => {
      const source = findTerminalPane(current.root, item.sourcePaneId);
      const destination = findTerminalPane(current.root, data.paneId as string);
      if (!source || !destination) return current;
      if (data.placement === 'tab' || destination.tabs.length === 0) {
        return moveTerminalTab(
          current,
          item.sourcePaneId,
          destination.id,
          item.projectId,
          item.sessionName,
        );
      }
      // A sole tab is already its own group. Splitting it away from itself
      // would only manufacture an empty group, so that edge drop is a no-op.
      if (source.id === destination.id && source.tabs.length === 1) return current;

      const orientation =
        data.placement === 'left' || data.placement === 'right'
          ? 'horizontal'
          : 'vertical';
      const position =
        data.placement === 'left' || data.placement === 'above'
          ? 'before'
          : 'after';
      const newPaneId = nextId('pane');
      const split = splitTerminalPane(
        current,
        destination.id,
        orientation,
        nextId('split'),
        newPaneId,
        position,
      );
      return moveTerminalTab(
        split,
        item.sourcePaneId,
        newPaneId,
        item.projectId,
        item.sessionName,
      );
    });
    onActiveTargetChange(item.projectId, item.sessionName);
  }

  function cacheSession(projectId: string, session: TerminalSession) {
    setWorkspaceCache((current) => {
      const projectWorkspace = current[projectId];
      if (!projectWorkspace) return current;
      const existingIndex = projectWorkspace.sessions.findIndex(
        (item) => item.name === session.name,
      );
      const sessions =
        existingIndex >= 0
          ? projectWorkspace.sessions.map((item, index) =>
              index === existingIndex ? session : item,
            )
          : [...projectWorkspace.sessions, session];
      return {
        ...current,
        [projectId]: {
          ...projectWorkspace,
          session_count: sessions.length,
          sessions,
        },
      };
    });
  }

  async function createDockSession(project: Project, name?: string) {
    const created = await onCreateSession(project.id, name);
    cacheSession(project.id, created);
    placeTarget(
      {
        projectId: project.id,
        projectName: project.name,
        projectEmoji: project.emoji,
        session: created,
      },
      'tab',
    );
  }

  async function renameDockSession(target: TerminalTarget, name: string) {
    const renamed = await onRenameSession(
      target.projectId,
      target.session,
      name,
    );
    setWorkspaceCache((current) => {
      const projectWorkspace = current[target.projectId];
      if (!projectWorkspace) return current;
      return {
        ...current,
        [target.projectId]: {
          ...projectWorkspace,
          sessions: projectWorkspace.sessions.map((session) =>
            session.name === target.session.name ? renamed : session,
          ),
        },
      };
    });
    setWorkspaceState((current) =>
      renameTerminalSessionTarget(
        current,
        target.projectId,
        target.session.name,
        renamed.name,
      ),
    );
    if (
      activeTab?.projectId === target.projectId &&
      activeTab.sessionName === target.session.name
    ) {
      onActiveTargetChange(target.projectId, renamed.name);
    }
  }

  const dockWorkspace = workspaceCache[dockProjectId] ?? null;

  return (
    <DndContext
      accessibility={{
        announcements: {
          onDragStart({ active }) {
            const data = active.data.current as
              | {
                  target?: TerminalTarget;
                  sessionName?: string;
                  projectName?: string;
                }
              | undefined;
            return data?.target
              ? `Picked up ${data.target.projectName} session ${data.target.session.name}.`
              : data?.sessionName
                ? `Picked up ${data.projectName ?? 'terminal'} tab ${data.sessionName}.`
                : 'Picked up terminal session.';
          },
          onDragOver({ over }) {
            const data = over?.data.current as
              | Partial<DropTargetData>
              | Partial<TabInsertTargetData>
              | Partial<TabStripTargetData>
              | undefined;
            return data?.type === 'terminal-tab-insert'
              ? `Insert in tab group at position ${(data.tabIndex ?? 0) + 1}.`
              : data?.type === 'terminal-tab-strip'
                ? 'Add to the end of this tab group.'
              : data?.type === 'terminal-drop' && data.placement
                ? `${DROP_LABELS[data.placement]}.`
                : undefined;
          },
          onDragEnd({ over }) {
            return over ? 'Terminal session placed.' : 'Placement cancelled.';
          },
          onDragCancel() {
            return 'Placement cancelled.';
          },
        },
        screenReaderInstructions: {
          draggable:
            'Press Space to pick up a terminal tab or session. Use arrow keys to choose a tab position or pane edge, Space to place, or Escape to cancel.',
        },
      }}
      collisionDetection={terminalCollisionDetection}
      onDragCancel={() => setActiveDragItem(null)}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        className={`terminal-workspace${
          fullscreenPaneId ? ' has-fullscreen-pane' : ''
        }`}
        data-pane-count={panes.length}
      >
        <TerminalSessionDock
          error={dockError}
          findOpenPane={(projectId, sessionName) =>
            findTerminalPaneByTarget(workspaceState.root, projectId, sessionName)
          }
          fullscreenHidden={fullscreenPaneId !== null}
          loading={dockLoading}
          onCreate={createDockSession}
          onOpen={placeTarget}
          onProjectChange={setDockProjectId}
          onRefresh={() => {
            setDockLoading(true);
            setDockError(null);
            void loadWorkspace(dockProjectId, true)
              .catch((reason) => {
                setDockError(
                  reason instanceof Error
                    ? reason.message
                    : `Dolphin Terminal could not refresh these ${labels.sessions}.`,
                );
              })
              .finally(() => setDockLoading(false));
          }}
          onRename={renameDockSession}
          projectSelectRef={projectSelectRef}
          projects={projects}
          selectedProjectId={dockProjectId}
          workspace={dockWorkspace}
        />

        {isNarrowLayout ? (
          <nav className="terminal-workspace-mobile-tabs" aria-label="Terminal views">
            {panes.map((pane, index) => {
              const tab = activeTerminalTab(pane);
              const project = projects.find((item) => item.id === tab?.projectId);
              return (
                <button
                  aria-current={pane.id === activePane.id ? 'page' : undefined}
                  className={pane.id === activePane.id ? 'active' : ''}
                  key={pane.id}
                  onClick={() => activatePane(pane)}
                  type="button"
                >
                  <span aria-hidden="true">{project?.emoji ?? '◫'}</span>
                  <span>
                    <strong>{project?.name ?? `View ${index + 1}`}</strong>
                    <small>{tab?.sessionName ?? 'Choose session above'}</small>
                  </span>
                </button>
              );
            })}
          </nav>
        ) : null}

        <div className="terminal-workspace-stage">
          {isNarrowLayout ? (
            renderPane(activePane)
          ) : (
            <TerminalWorkspaceNodeView
              node={workspaceState.root}
              onLayoutChanged={(splitId, layout) =>
                setWorkspaceState((current) =>
                  updateTerminalSplitLayout(current, splitId, layout),
                )
              }
              renderPane={renderPane}
            />
          )}
        </div>
      </div>

      <DragOverlay modifiers={[offsetTerminalDragPreview]}>
        {activeDragItem ? (
          <div
            className={`terminal-session-drag-preview${
              activeDragItem.origin === 'tab' ? ' is-tab' : ''
            }`}
          >
            <span aria-hidden="true">{activeDragItem.projectEmoji}</span>
            <span>
              <strong>{activeDragItem.sessionName}</strong>
              <small>{activeDragItem.projectName}</small>
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
