import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import '@xterm/xterm/css/xterm.css';
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useDictation } from './DictationProvider.js';
import SessionAutomationControl from './SessionAutomationControl.js';
import { useTerminalRuntime } from './TerminalRuntime.js';
import { isTerminalLikeTarget } from './shortcutTarget.js';
import {
  CONNECT_TIMEOUT_MS,
  OFFLINE_NOTICE,
  nextConnectDelayMs,
  reconnectNotice,
  shouldRetryConnection,
} from './terminalReconnect.js';
import { sanitizeTerminalTranscript } from './dictationTarget.js';
import {
  copyLayerScrollTopForAnchor,
  wheelDeltaYToPixels,
} from './terminalCopyScroll.js';
import {
  buildSnapshotSegments,
  extractPathCandidates,
  pathCandidateBatches,
  type SnapshotSegment,
} from './terminalFilePaths.js';
import {
  buildWebLinkSegments,
  type WebLinkSegment,
} from './terminalWebLinks.js';
import {
  attachmentPasteMessage,
  isFileDrag,
  sameTerminalAttachmentTarget,
  selectTerminalAttachments,
  terminalAttachmentAgent,
  terminalAttachmentAgentLabel,
  type TerminalAttachmentTargetIdentity,
} from './terminalAttachmentDrop.js';
import type { TerminalPathResolution, TerminalSession } from './types.js';

/* Shared empty map so a reset is referentially stable and does not re-run the
   segment memo for a copy layer that has nothing in it. */
const EMPTY_RESOLVED_PATHS: ReadonlyMap<string, TerminalPathResolution> =
  new Map();

export interface TerminalWorkspaceControls {
  paneId: string;
  tabs: Array<{
    projectId: string;
    projectName: string;
    projectEmoji: string;
    sessionName: string;
    isActive: boolean;
  }>;
  isActive: boolean;
  isSplit: boolean;
  canClose: boolean;
  onActivateTab: (projectId: string, sessionName: string) => void;
  onCloseTab: (projectId: string, sessionName: string) => void;
  onCloseView: () => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

interface DraggableTerminalTabProps {
  index: number;
  paneId: string;
  tab: TerminalWorkspaceControls['tabs'][number];
  onActivate: () => void;
  onClose: () => void;
  onKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => void;
  setButtonRef: (node: HTMLButtonElement | null) => void;
}

function DraggableTerminalTab({
  index,
  paneId,
  tab,
  onActivate,
  onClose,
  onKeyDown,
  setButtonRef,
}: DraggableTerminalTabProps) {
  const {
    icons: { X },
    labels,
  } = useTerminalRuntime();
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
  } = useDraggable({
    id: `terminal-tab:${paneId}:${tab.projectId}:${tab.sessionName}`,
    data: {
      type: 'terminal-tab',
      sourcePaneId: paneId,
      projectId: tab.projectId,
      projectName: tab.projectName,
      projectEmoji: tab.projectEmoji,
      sessionName: tab.sessionName,
    },
  });
  const before = useDroppable({
    id: `terminal-tab-insert:${paneId}:${index}:before`,
    data: { type: 'terminal-tab-insert', paneId, tabIndex: index },
  });
  const after = useDroppable({
    id: `terminal-tab-insert:${paneId}:${index}:after`,
    data: { type: 'terminal-tab-insert', paneId, tabIndex: index + 1 },
  });
  const { onKeyDown: onDragKeyDown, ...dragListeners } = listeners ?? {};

  return (
    <div
      className={`terminal-pane-tab${tab.isActive ? ' is-active' : ''}${
        isDragging ? ' is-dragging' : ''
      }`}
      ref={setNodeRef}
    >
      <span
        aria-hidden="true"
        className={`terminal-tab-insert-zone is-before${
          before.isOver ? ' is-over' : ''
        }`}
        ref={before.setNodeRef}
      />
      <button
        {...attributes}
        {...dragListeners}
        aria-selected={tab.isActive}
        className="terminal-pane-tab-main"
        onClick={onActivate}
        onKeyDown={(event) => {
          onDragKeyDown?.(event);
          if (!event.defaultPrevented) onKeyDown(event, index);
        }}
        ref={(node) => {
          setButtonRef(node);
          setActivatorNodeRef(node);
        }}
        role="tab"
        tabIndex={tab.isActive ? 0 : -1}
        title={`${tab.projectName} · ${tab.sessionName} · Drag to move or split`}
        type="button"
      >
        <span aria-hidden="true" className="terminal-pane-tab-emoji">
          {tab.projectEmoji}
        </span>
        <span className="terminal-pane-tab-copy">
          <strong>{tab.sessionName}</strong>
          <small>{tab.projectName}</small>
        </span>
      </button>
      <button
        aria-label={`Close terminal tab ${tab.sessionName}`}
        className="terminal-pane-tab-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        title={`Close tab (${labels.persistentEngine} keeps running)`}
        type="button"
      >
        <X aria-hidden="true" size={13} />
      </button>
      <span
        aria-hidden="true"
        className={`terminal-tab-insert-zone is-after${
          after.isOver ? ' is-over' : ''
        }`}
        ref={after.setNodeRef}
      />
    </div>
  );
}

export interface TerminalPaneProps {
  projectId: string;
  session: TerminalSession | null;
  onSessionClosed: () => void;
  onSessionChanged: () => void;
  dictationTargetId?: string;
  enableWebgl?: boolean;
  workspaceControls?: TerminalWorkspaceControls;
}

type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'live'
  | 'closed'
  | 'offline'
  | 'error';
type AttachmentTransferState = {
  kind: 'idle' | 'uploading' | 'success' | 'error';
  message: string;
};
const ATTACHMENT_SUCCESS_NOTICE_MS = 3_000;
type CopyLayerScrollAnchor = {
  rowsFromBottom: number;
};
type TerminalTouchScrollState = {
  active: boolean;
  lastY: number;
  residualPixels: number;
};

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

function terminalSelectableText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const maxSnapshotLines = 5000;
  const start = Math.max(0, buffer.length - maxSnapshotLines);
  const end = buffer.length;
  const lines: string[] = [];

  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  return lines.join('\n').trimEnd();
}

function getCopyLayerLineHeight(copyLayer: HTMLElement): number {
  const style = window.getComputedStyle(copyLayer);
  const fontSize = Number.parseFloat(style.fontSize);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight)) return lineHeight;
  if (Number.isFinite(fontSize)) return fontSize * 1.2;
  return 15.6;
}

function getTerminalLineHeight(terminal: Terminal): number {
  const firstRow = terminal.element?.querySelector(
    '.xterm-rows > div',
  ) as HTMLElement | null;
  const rowHeight = firstRow?.getBoundingClientRect().height;
  if (rowHeight && Number.isFinite(rowHeight)) return rowHeight;

  const fontSize =
    typeof terminal.options.fontSize === 'number' ? terminal.options.fontSize : 13;
  const lineHeight =
    typeof terminal.options.lineHeight === 'number'
      ? terminal.options.lineHeight
      : 1.2;
  return fontSize * lineHeight;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function terminalPathLinkTitle(resolution: TerminalPathResolution): string {
  const size =
    resolution.size_bytes === null
      ? ''
      : ` · ${formatFileSize(resolution.size_bytes)}`;
  return `Download ${resolution.path}${size}`;
}

function terminalCopyScrollAnchor(terminal: Terminal): CopyLayerScrollAnchor {
  const buffer = terminal.buffer.active;
  return {
    rowsFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
  };
}

export default function TerminalPane({
  projectId,
  session,
  onSessionClosed,
  onSessionChanged,
  dictationTargetId = 'dolphin-terminal-dictation-target',
  enableWebgl = true,
  workspaceControls,
}: TerminalPaneProps) {
  const {
    automation,
    client,
    icons: {
      Maximize2,
      Minimize2,
      Paperclip,
      Power,
      RefreshCw,
      TerminalSquare,
      TextSelect,
      X,
    },
    labels,
    slots,
  } = useTerminalRuntime();
  const { activateTarget, clearTarget } = useDictation();
  const closeSession = client.closeSession.bind(client);
  const fetchSnapshot = client.fetchSnapshot.bind(client);
  const resolveTerminalPaths = client.resolvePaths.bind(client);
  const sessionStreamUrl = client.streamUrl.bind(client);
  const uploadAttachment = client.uploadAttachment.bind(client);
  const workspaceFileDownloadUrl = client.fileDownloadUrl.bind(client);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const copyLayerRef = useRef<HTMLPreElement | null>(null);
  const terminalTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusActiveTabAfterCloseRef = useRef(false);
  const pendingFitFrameRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const snapshotRequestRef = useRef(0);
  const copyLayerScrollAnchorRef = useRef<CopyLayerScrollAnchor | null>(null);
  const pendingCopyLayerScrollRestoresRef = useRef(0);
  const copyLayerInteractedRef = useRef(false);
  const terminalTouchScrollRef = useRef<TerminalTouchScrollState | null>(null);
  const dragDepthRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const initialEnableWebglRef = useRef(enableWebgl);
  const fullscreenChangeRef = useRef(workspaceControls?.onFullscreenChange);
  const fullscreenStateRef = useRef(false);
  const attachmentUploadAbortRef = useRef<AbortController | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [connectionNotice, setConnectionNotice] = useState('');
  // Bumped by the Retry control to re-run the connection effect with a fresh
  // attempt budget. The effect owns the retries; this is how a click re-enters it.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectionSnapshot, setSelectionSnapshot] = useState('');
  const [resolvedPaths, setResolvedPaths] =
    useState<ReadonlyMap<string, TerminalPathResolution>>(EMPTY_RESOLVED_PATHS);
  const resolveRequestRef = useRef(0);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const lastUpdateFlushRef = useRef(0);
  const workspaceTabLayoutKey =
    workspaceControls?.tabs
      .map(
        (tab) =>
          `${tab.projectId}\u0000${tab.sessionName}\u0000${tab.isActive ? '1' : '0'}`,
      )
      .join('\u0001') ?? '';
  const tabStripDropTarget = useDroppable({
    id: `terminal-tab-strip:${workspaceControls?.paneId ?? dictationTargetId}`,
    data: {
      type: 'terminal-tab-strip',
      paneId: workspaceControls?.paneId ?? '',
      tabIndex: workspaceControls?.tabs.length ?? 0,
    },
    disabled: !workspaceControls,
  });

  // A newly opened tab can land beyond the visible end of a compact tab strip.
  // Keep it in view, and return keyboard focus to the selected neighbor after
  // closing a tab whose button has just left the DOM.
  useLayoutEffect(() => {
    const activeIndex = workspaceControls?.tabs.findIndex((tab) => tab.isActive) ?? -1;
    if (activeIndex < 0) return;
    const frame = window.requestAnimationFrame(() => {
      const activeButton = terminalTabRefs.current[activeIndex];
      activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (focusActiveTabAfterCloseRef.current) {
        focusActiveTabAfterCloseRef.current = false;
        activeButton?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceTabLayoutKey]);
  const lastUpdateTimerRef = useRef<number | null>(null);
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const [attachmentTransfer, setAttachmentTransfer] =
    useState<AttachmentTransferState>({
      kind: 'idle',
      message: '',
    });
  const sessionName = session?.name ?? null;
  const projectIdRef = useRef(projectId);
  const sessionRef = useRef(session);
  projectIdRef.current = projectId;
  sessionRef.current = session;
  fullscreenChangeRef.current = workspaceControls?.onFullscreenChange;

  useEffect(() => {
    if (attachmentTransfer.kind !== 'success') return;

    const successMessage = attachmentTransfer.message;
    const timer = window.setTimeout(() => {
      setAttachmentTransfer((current) =>
        current.kind === 'success' && current.message === successMessage
          ? { kind: 'idle', message: '' }
          : current,
      );
    }, ATTACHMENT_SUCCESS_NOTICE_MS);

    return () => window.clearTimeout(timer);
  }, [attachmentTransfer.kind, attachmentTransfer.message]);

  useEffect(() => {
    fullscreenStateRef.current = isFullscreen;
    fullscreenChangeRef.current?.(isFullscreen);
  }, [isFullscreen]);

  useEffect(
    () => () => {
      if (fullscreenStateRef.current) fullscreenChangeRef.current?.(false);
    },
    [],
  );

  /* Marks terminal activity for the "Updated <time>" footer.

     This used to be a setState on EVERY websocket message. The footer shows a
     clock at one-second resolution, so a streaming agent — which can emit
     dozens of messages a second while it repaints a spinner — was re-rendering
     this 1000-line component dozens of times a second to display a value that
     had not changed. React's automatic batching hid most of the cost, which is
     why it never showed up as a dropped frame, but it was work done for
     nothing on the one surface the operator watches.

     Leading edge fires immediately so the first output looks instant; the
     trailing timer makes sure the final timestamp of a burst still lands. */
  const noteTerminalActivity = useCallback(() => {
    const now = Date.now();
    const sinceFlush = now - lastUpdateFlushRef.current;
    if (sinceFlush >= 1000) {
      lastUpdateFlushRef.current = now;
      setLastUpdate(new Date(now).toISOString());
      return;
    }
    if (lastUpdateTimerRef.current !== null) return;
    lastUpdateTimerRef.current = window.setTimeout(() => {
      lastUpdateTimerRef.current = null;
      lastUpdateFlushRef.current = Date.now();
      setLastUpdate(new Date().toISOString());
    }, 1000 - sinceFlush);
  }, []);

  useEffect(
    () => () => {
      if (lastUpdateTimerRef.current !== null) {
        window.clearTimeout(lastUpdateTimerRef.current);
      }
    },
    [],
  );

  function fitTerminal() {
    pendingFitFrameRef.current = null;
    fitRef.current?.fit();
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (terminal && socket?.readyState === WebSocket.OPEN) {
      const nextSize = { cols: terminal.cols, rows: terminal.rows };
      const lastSize = lastSentSizeRef.current;
      if (
        lastSize &&
        lastSize.cols === nextSize.cols &&
        lastSize.rows === nextSize.rows
      ) {
        return;
      }
      lastSentSizeRef.current = nextSize;
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: nextSize.cols,
          rows: nextSize.rows,
        }),
      );
    }
  }

  function scheduleFitTerminal() {
    if (pendingFitFrameRef.current !== null) return;
    pendingFitFrameRef.current = window.requestAnimationFrame(fitTerminal);
  }

  useEffect(() => {
    if (!hostRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#111111',
        foreground: '#e8e8e8',
        cursor: '#f3c64b',
        selectionBackground: '#3c4a5f',
        black: '#000000',
        red: '#ff5f56',
        green: '#27c93f',
        yellow: '#ffbd2e',
        blue: '#4da3ff',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#dcdcdc',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);

    /* xterm's default DOM renderer keeps up with a streaming agent only on a
       fast machine. Measured against a 960-line feed arriving every 16ms: on
       an unthrottled CPU the DOM and WebGL renderers tie (2017ms vs 2032ms,
       p95 frame 19ms vs 17ms), but at 4x CPU throttle — a laptop rather than
       this workstation — the DOM renderer took 3275ms for a 1920ms feed, i.e.
       it fell behind real time, while WebGL held 2017ms with zero frames over
       32ms. This app is normally driven from a laptop over a tunnel, which is
       the throttled case.

       The addon must be optional, not assumed: software GL, a blocklisted
       driver, or a lost context all have to degrade to the DOM renderer
       rather than blank the terminal. onContextLoss disposes the addon, and
       xterm falls back on its own. */
    let webgl: WebglAddon | null = null;
    if (initialEnableWebglRef.current) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webglRef.current === addon) webglRef.current = null;
        });
        terminal.loadAddon(addon);
        webgl = addon;
      } catch {
        // No usable WebGL context. The DOM renderer already stands.
      }
    }
    webglRef.current = webgl;

    fit.fit();
    terminal.attachCustomKeyEventHandler((event) => {
      const isCopyKey =
        event.key.toLowerCase() === 'c' &&
        (event.ctrlKey || event.metaKey) &&
        (!event.altKey || event.shiftKey);
      if (event.type === 'keydown' && isCopyKey && terminal.hasSelection()) {
        void copyTextToClipboard(terminal.getSelection()).catch(() => undefined);
        return false;
      }
      return true;
    });

    terminalRef.current = terminal;
    fitRef.current = fit;
    function activateTerminalDictationTarget() {
      const focusedSession = sessionRef.current;
      activateTarget({
        id: dictationTargetId,
        kind: 'terminal',
        label: focusedSession ? `terminal ${focusedSession.name}` : 'terminal',
        prepare: () => {
          const preparedSession = sessionRef.current;
          const preparedProjectId = projectIdRef.current;
          const preparedTerminal = terminalRef.current;
          const preparedSocket = socketRef.current;
          if (
            !preparedSession ||
            !preparedTerminal ||
            preparedSocket?.readyState !== WebSocket.OPEN
          ) {
            return null;
          }

          return {
            id: dictationTargetId,
            kind: 'terminal',
            label: `terminal ${preparedSession.name}`,
            insert(transcript: string) {
              const text = sanitizeTerminalTranscript(transcript);
              if (
                !text ||
                projectIdRef.current !== preparedProjectId ||
                sessionRef.current?.name !== preparedSession.name ||
                terminalRef.current !== preparedTerminal ||
                socketRef.current !== preparedSocket ||
                preparedSocket.readyState !== WebSocket.OPEN
              ) {
                return false;
              }
              preparedTerminal.input(text, true);
              preparedTerminal.focus();
              return true;
            },
          };
        },
      });
    }

    const hostElement = hostRef.current;

    function handleTerminalTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1) {
        terminalTouchScrollRef.current = null;
        return;
      }
      terminalTouchScrollRef.current = {
        active: false,
        lastY: event.touches[0].clientY,
        residualPixels: 0,
      };
    }

    function handleTerminalTouchMove(event: TouchEvent) {
      const touchState = terminalTouchScrollRef.current;
      if (!touchState || event.touches.length !== 1) return;

      const nextY = event.touches[0].clientY;
      const deltaY = touchState.lastY - nextY;
      touchState.lastY = nextY;
      touchState.residualPixels += deltaY;

      if (!touchState.active && Math.abs(touchState.residualPixels) < 6) {
        return;
      }

      touchState.active = true;
      const lineHeight = getTerminalLineHeight(terminal);
      const lines = Math.trunc(touchState.residualPixels / lineHeight);
      if (lines === 0) return;

      const buffer = terminal.buffer.active;
      const canScrollTerminal =
        (lines < 0 && buffer.viewportY > 0) ||
        (lines > 0 && buffer.viewportY < buffer.baseY);
      if (!canScrollTerminal) return;

      terminal.scrollLines(lines);
      touchState.residualPixels -= lines * lineHeight;

      event.preventDefault();
      event.stopPropagation();
    }

    function handleTerminalTouchEnd() {
      terminalTouchScrollRef.current = null;
    }

    hostElement.addEventListener('focusin', activateTerminalDictationTarget);
    hostElement.addEventListener('touchstart', handleTerminalTouchStart, {
      passive: true,
    });
    hostElement.addEventListener('touchmove', handleTerminalTouchMove, {
      passive: false,
    });
    hostElement.addEventListener('touchend', handleTerminalTouchEnd);
    hostElement.addEventListener('touchcancel', handleTerminalTouchEnd);

    const resizeObserver = new ResizeObserver(scheduleFitTerminal);
    resizeObserver.observe(hostRef.current);
    window.addEventListener('resize', scheduleFitTerminal);

    return () => {
      if (pendingFitFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFitFrameRef.current);
        pendingFitFrameRef.current = null;
      }
      window.removeEventListener('resize', scheduleFitTerminal);
      resizeObserver.disconnect();
      hostElement.removeEventListener('focusin', activateTerminalDictationTarget);
      hostElement.removeEventListener('touchstart', handleTerminalTouchStart);
      hostElement.removeEventListener('touchmove', handleTerminalTouchMove);
      hostElement.removeEventListener('touchend', handleTerminalTouchEnd);
      hostElement.removeEventListener('touchcancel', handleTerminalTouchEnd);
      attachmentUploadAbortRef.current?.abort();
      attachmentUploadAbortRef.current = null;
      clearTarget(dictationTargetId);
      // Release the GL context before the terminal goes; browsers cap how many
      // live contexts a page may hold, and cockpits are opened repeatedly.
      webglRef.current?.dispose();
      webglRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    scheduleFitTerminal();
  }, [isFullscreen]);

  /* Entering fullscreen must transfer the real keyboard/dictation focus, not
     merely raise this pane visually. Otherwise the fullscreen toolbar button
     keeps focus (or a previously focused background xterm keeps the active
     dictation target), and input can be routed somewhere the user cannot see. */
  useEffect(() => {
    if (!isFullscreen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isFullscreen]);

  /* Ask the server which of the path-shaped tokens in the snapshot are real
     files. Only those become links — the operator can then tell what is
     retrievable without clicking. A failed resolve leaves everything as plain
     text, which is exactly what select mode did before this existed. */
  useEffect(() => {
    if (!isSelectMode || !selectionSnapshot) return undefined;

    const unique = Array.from(
      new Set(
        extractPathCandidates(selectionSnapshot).map(
          (candidate) => candidate.lookup,
        ),
      ),
    );
    if (unique.length === 0) {
      setResolvedPaths(EMPTY_RESOLVED_PATHS);
      return undefined;
    }

    const requestId = resolveRequestRef.current + 1;
    resolveRequestRef.current = requestId;
    const controller = new AbortController();

    void (async () => {
      const resolved = new Map<string, TerminalPathResolution>();
      for (const batch of pathCandidateBatches(unique)) {
        let resolutions: TerminalPathResolution[] | null = null;
        for (
          let attempt = 0;
          attempt < 2 && resolutions === null;
          attempt += 1
        ) {
          try {
            resolutions = await resolveTerminalPaths(
              projectId,
              sessionName,
              batch,
              controller.signal,
            );
          } catch {
            if (controller.signal.aborted) return;
            if (attempt === 0) {
              await new Promise((resolve) => window.setTimeout(resolve, 150));
            }
          }
        }
        if (resolveRequestRef.current !== requestId) return;
        for (const item of resolutions ?? []) {
          if (item.kind === 'file' && item.path)
            resolved.set(item.candidate, item);
        }
        /* Publish successful batches immediately. A later transient failure
           must not erase files that the server already confirmed. */
        setResolvedPaths(new Map(resolved));
      }
    })();

    return () => {
      controller.abort();
      resolveRequestRef.current += 1;
    };
  }, [isSelectMode, selectionSnapshot, projectId, sessionName]);

  const snapshotSegments = useMemo(
    () =>
      buildSnapshotSegments(
        selectionSnapshot,
        extractPathCandidates(selectionSnapshot),
        (candidate) => resolvedPaths.has(candidate),
      ),
    [selectionSnapshot, resolvedPaths],
  );

  /* URLs do not need a server round trip. Apply them only to plain-text
     segments so a confirmed file path and a website link can never overlap. */
  const copyLayerSegments = useMemo(
    () =>
      snapshotSegments.reduce<Array<SnapshotSegment | WebLinkSegment>>(
        (segments, segment) => {
          if (segment.kind === 'text') {
            segments.push(...buildWebLinkSegments(segment.text));
          } else {
            segments.push(segment);
          }
          return segments;
        },
        [],
      ),
    [snapshotSegments],
  );

  useLayoutEffect(() => {
    if (!isSelectMode || pendingCopyLayerScrollRestoresRef.current <= 0) return;
    const copyLayer = copyLayerRef.current;
    const anchor = copyLayerScrollAnchorRef.current;
    if (!copyLayer || !anchor) return;

    copyLayer.scrollTop = copyLayerScrollTopForAnchor({
      scrollHeight: copyLayer.scrollHeight,
      clientHeight: copyLayer.clientHeight,
      lineHeight: getCopyLayerLineHeight(copyLayer),
      rowsFromBottom: anchor.rowsFromBottom,
    });
    copyLayer.focus({ preventScroll: true });
    pendingCopyLayerScrollRestoresRef.current -= 1;
  }, [isSelectMode, selectionSnapshot]);

  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to whatever is running inside the terminal — vim, a
      // readline prompt, Claude Code's interrupt. This listener had no target
      // check at all, so every Escape pressed inside a fullscreen session also
      // silently dropped the user out of fullscreen. It never called
      // preventDefault, so the key still reached xterm; the bug was the
      // uninvited side effect, which is the same "terminal is sacred"
      // violation as 937ec05.
      //
      // The Minimize control in the toolbar remains the always-available exit,
      // so nothing becomes unreachable.
      if (isTerminalLikeTarget(event.target as HTMLElement | null)) return;
      setIsFullscreen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    const connectionGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = connectionGeneration;
    attachmentUploadAbortRef.current?.abort();
    attachmentUploadAbortRef.current = null;
    dragDepthRef.current = 0;
    setIsAttachmentDragActive(false);
    setAttachmentTransfer({ kind: 'idle', message: '' });
    socketRef.current?.close();
    socketRef.current = null;
    snapshotRequestRef.current += 1;
    setIsSelectMode(false);
    setSelectionSnapshot('');
    setResolvedPaths(EMPTY_RESOLVED_PATHS);
    copyLayerScrollAnchorRef.current = null;
    pendingCopyLayerScrollRestoresRef.current = 0;
    copyLayerInteractedRef.current = false;

    const terminal = terminalRef.current;
    if (!sessionName || !terminal) {
      terminal?.reset();
      terminal?.writeln(`Open or select a ${labels.session}.`);
      setConnection('idle');
      return;
    }

    terminal.reset();
    terminal.writeln(`Connecting to ${sessionName}…`);
    setConnection('connecting');
    setConnectionNotice('');

    /* A handshake against a healthy backend is milliseconds, so a wait of
       seconds is always the network. This used to open exactly one socket and
       wait on it forever, which is why a slept laptop or a stale tunnel left
       the pane on CONNECTING with nothing to click. */
    let attempt = 0;
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let connectTimer: number | null = null;
    let retryTimer: number | null = null;

    const clearConnectTimer = () => {
      if (connectTimer === null) return;
      window.clearTimeout(connectTimer);
      connectTimer = null;
    };

    const isCurrentConnection = () =>
      !disposed && connectionGenerationRef.current === connectionGeneration;

    const teardownAttempt = () => {
      clearConnectTimer();
      inputDisposable?.dispose();
      inputDisposable = null;
      if (activeSocket) {
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onerror = null;
        activeSocket.onclose = null;
        activeSocket.close();
      }
      if (socketRef.current === activeSocket) socketRef.current = null;
      activeSocket = null;
    };

    const giveUpOrScheduleRetry = () => {
      teardownAttempt();
      if (!isCurrentConnection()) return;

      const delayMs = nextConnectDelayMs(attempt);
      if (delayMs === null) {
        setConnection('offline');
        setConnectionNotice(OFFLINE_NOTICE);
        return;
      }

      setConnection('reconnecting');
      setConnectionNotice(reconnectNotice(attempt + 1, delayMs));
      retryTimer = window.setTimeout(openSocket, delayMs);
    };

    /* An arrow assigned after the guard above, not a hoisted declaration:
       TypeScript discards the `sessionName`/`terminal` narrowing inside a
       function declaration, because such a function could be called before the
       guard ran. */
    const openSocket = (): void => {
      if (!isCurrentConnection()) return;
      attempt += 1;
      setConnection('connecting');
      setConnectionNotice('');

      const socket = new WebSocket(sessionStreamUrl(projectId, sessionName));
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      activeSocket = socket;
      lastSentSizeRef.current = null;
      let reachedOpen = false;

      const isCurrentSocket = () =>
        isCurrentConnection() && socketRef.current === socket;

      // The whole point: bound the handshake instead of waiting on TCP.
      connectTimer = window.setTimeout(() => {
        if (!isCurrentSocket() || reachedOpen) return;
        giveUpOrScheduleRetry();
      }, CONNECT_TIMEOUT_MS);

      inputDisposable = terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data }));
        }
      });

      socket.onopen = () => {
        if (!isCurrentSocket()) return;
        reachedOpen = true;
        clearConnectTimer();
        attempt = 0;
        setConnection('live');
        setConnectionNotice('');
        scheduleFitTerminal();
        terminal.clear();
      };

      socket.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data));
          noteTerminalActivity();
          return;
        }

        if (event.data instanceof Blob) {
          event.data.arrayBuffer().then((buffer) => {
            terminal.write(new Uint8Array(buffer));
            noteTerminalActivity();
          });
          return;
        }

        const payload = JSON.parse(event.data) as {
          type: string;
          message?: string;
        };

        if (payload.type === 'error') {
          terminal.writeln('');
          terminal.writeln(`\x1b[31m${payload.message ?? 'Terminal error'}\x1b[0m`);
          setConnection('error');
        }
      };

      socket.onerror = () => {
        if (!isCurrentSocket()) return;
        // A failed connection fires onerror and then onclose; the close is
        // where the retry decision is made, so that it is made exactly once.
        if (reachedOpen) setConnection('error');
      };

      socket.onclose = () => {
        if (!isCurrentSocket()) return;
        clearConnectTimer();
        if (!shouldRetryConnection(reachedOpen)) {
          setConnection((current) => (current === 'error' ? 'error' : 'closed'));
          return;
        }
        giveUpOrScheduleRetry();
      };
    };

    openSocket();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      teardownAttempt();
    };
  }, [labels.session, projectId, sessionName, reconnectNonce]);

  function sendToTerminal(data: string) {
    if (!session) return;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  }

  function currentAttachmentTargetIdentity():
    | TerminalAttachmentTargetIdentity
    | null {
    const currentSessionName = sessionRef.current?.name;
    if (!currentSessionName) return null;
    return {
      projectId: projectIdRef.current,
      sessionName: currentSessionName,
      connectionGeneration: connectionGenerationRef.current,
    };
  }

  function attachmentUnavailableMessage(): string {
    if (!sessionRef.current) return `Select a ${labels.session} first.`;
    if (isSelectMode) return 'Exit terminal select mode before attaching files.';
    return 'Wait for the terminal connection to become live.';
  }

  function summarizeErrors(errors: string[]): string {
    if (errors.length <= 2) return errors.join(' ');
    return `${errors.slice(0, 2).join(' ')} ${errors.length - 2} more failed.`;
  }

  async function handleAttachmentFiles(
    files: ArrayLike<File> | Iterable<File>,
  ) {
    const targetSession = sessionRef.current;
    const targetTerminal = terminalRef.current;
    const targetSocket = socketRef.current;
    const targetIdentity = currentAttachmentTargetIdentity();
    const targetAgent = terminalAttachmentAgent(targetSession);
    if (
      !targetTerminal ||
      !targetSocket ||
      targetSocket.readyState !== WebSocket.OPEN ||
      !targetIdentity ||
      isSelectMode
    ) {
      setAttachmentTransfer({
        kind: 'error',
        message: attachmentUnavailableMessage(),
      });
      return;
    }

    const selection = selectTerminalAttachments(files);
    if (selection.accepted.length === 0) {
      setAttachmentTransfer({
        kind: 'error',
        message:
          summarizeErrors(selection.errors) ||
          'Drop one or more files or images.',
      });
      return;
    }

    attachmentUploadAbortRef.current?.abort();
    const abortController = new AbortController();
    attachmentUploadAbortRef.current = abortController;
    let pastedCount = 0;
    const errors = [...selection.errors];

    for (const [index, selectedAttachment] of selection.accepted.entries()) {
      setAttachmentTransfer({
        kind: 'uploading',
        message: `Uploading attachment ${index + 1} of ${selection.accepted.length}…`,
      });
      try {
        const attachment = await uploadAttachment(
          targetIdentity.projectId,
          targetIdentity.sessionName,
          selectedAttachment.file,
          selectedAttachment.file.name,
          selectedAttachment.contentType,
          abortController.signal,
        );
        const currentIdentity = currentAttachmentTargetIdentity();
        const targetStillMatches =
          currentIdentity !== null &&
          sameTerminalAttachmentTarget(targetIdentity, currentIdentity) &&
          terminalRef.current === targetTerminal &&
          socketRef.current === targetSocket &&
          targetSocket.readyState === WebSocket.OPEN;
        if (!targetStillMatches) {
          errors.push(
            `${selectedAttachment.file.name}: the terminal changed before its path could be pasted.`,
          );
          break;
        }

        targetTerminal.paste(
          pastedCount === 0 ? attachment.path : ` ${attachment.path}`,
        );
        targetTerminal.focus();
        pastedCount += 1;
      } catch (error) {
        if (abortController.signal.aborted) {
          errors.push(
            `${selectedAttachment.file.name}: upload stopped because the terminal changed.`,
          );
          break;
        }
        errors.push(
          `${selectedAttachment.file.name}: ${
            error instanceof Error ? error.message : 'upload failed'
          }`,
        );
      }
    }

    if (attachmentUploadAbortRef.current === abortController) {
      attachmentUploadAbortRef.current = null;
    }
    if (pastedCount === 0) {
      setAttachmentTransfer({
        kind: 'error',
        message: summarizeErrors(errors),
      });
      return;
    }

    const pastedMessage = attachmentPasteMessage(pastedCount, targetAgent);
    setAttachmentTransfer({
      kind: errors.length === 0 ? 'success' : 'error',
      message:
        errors.length === 0
          ? pastedMessage
          : `${pastedMessage} ${summarizeErrors(errors)}`,
    });
  }

  function handleAttachmentDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      connection === 'live' && !isSelectMode ? 'copy' : 'none';
  }

  function handleAttachmentDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsAttachmentDragActive(false);
  }

  function handleAttachmentDrop(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsAttachmentDragActive(false);
    void handleAttachmentFiles(event.dataTransfer.files);
  }

  async function toggleSelectMode() {
    const terminal = terminalRef.current;
    if (isSelectMode) {
      snapshotRequestRef.current += 1;
      window.getSelection()?.removeAllRanges();
      setIsSelectMode(false);
      setSelectionSnapshot('');
      setResolvedPaths(EMPTY_RESOLVED_PATHS);
      copyLayerScrollAnchorRef.current = null;
      pendingCopyLayerScrollRestoresRef.current = 0;
      copyLayerInteractedRef.current = false;
      return;
    }

    const fallbackText = terminal ? terminalSelectableText(terminal) : '';
    copyLayerScrollAnchorRef.current = terminal
      ? terminalCopyScrollAnchor(terminal)
      : null;
    pendingCopyLayerScrollRestoresRef.current = session ? 2 : 1;
    copyLayerInteractedRef.current = false;
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;
    setSelectionSnapshot(fallbackText);
    setIsSelectMode(true);

    if (!session) return;

    try {
      const snapshot = await fetchSnapshot(projectId, session.name, 2000);
      if (snapshotRequestRef.current !== requestId || copyLayerInteractedRef.current) {
        return;
      }
      setSelectionSnapshot(snapshot.content || fallbackText);
    } catch {
      // Keep the local xterm buffer fallback if provider history cannot be captured.
    }
  }

  /* Dragging a selection across a link ends with mouseup on the link, which is
     a click. Without this, selecting a line of output that happens to contain
     a filename would download it. */
  function handleTerminalLinkClick(event: MouseEvent<HTMLAnchorElement>) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      event.preventDefault();
    }
  }

  function handleCopyLayerInteraction() {
    copyLayerInteractedRef.current = true;
    pendingCopyLayerScrollRestoresRef.current = 0;
  }

  function handleCopyLayerWheel(event: WheelEvent<HTMLPreElement>) {
    handleCopyLayerInteraction();
    const copyLayer = event.currentTarget;
    const deltaY = wheelDeltaYToPixels({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      lineHeight: getCopyLayerLineHeight(copyLayer),
      pageHeight: copyLayer.clientHeight,
    });
    copyLayer.scrollTop += deltaY;
    event.preventDefault();
  }

  async function handleClose() {
    if (!session) return;
    const ok = window.confirm(`Close ${labels.session} "${session.name}"?`);
    if (!ok) return;
    await closeSession(projectId, session.name);
    onSessionClosed();
  }

  function handleRetryConnection() {
    setReconnectNonce((current) => current + 1);
  }

  function handleToggleFullscreen() {
    setIsFullscreen((current) => !current);
  }

  function handleTerminalTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    // Fullscreen is intentionally bound to the exact active persistent session.
    // Other tabs return when the user exits fullscreen; hidden tabs must not
    // remain reachable through roving-tab keyboard navigation meanwhile.
    if (isFullscreen) return;
    const tabs = workspaceControls?.tabs ?? [];
    if (tabs.length < 2) return;
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    workspaceControls?.onActivateTab(next.projectId, next.sessionName);
    window.requestAnimationFrame(() => terminalTabRefs.current[nextIndex]?.focus());
  }

  const activeAttachmentAgent = terminalAttachmentAgent(session);
  const activeAttachmentAgentLabel = activeAttachmentAgent
    ? terminalAttachmentAgentLabel(activeAttachmentAgent)
    : null;
  const canAttachFiles = connection === 'live' && !isSelectMode;

  return (
    <section
      className={`terminal-pane ${isFullscreen ? 'fullscreen' : ''}${
        workspaceControls?.isSplit ? ' terminal-pane--split' : ''
      }${workspaceControls?.isActive ? ' terminal-pane--active' : ''}`}
    >
      {/* The footer that used to sit at the bottom of this pane held one
          sentence that never changed and one timestamp that did. The sentence
          was already duplicated verbatim in the footer's own title, so it
          becomes this toolbar's title; the timestamp moves beside the
          connection pill, where changing state already lives. That is 28px of
          permanent chrome returned to the terminal. */}
      <header
        className="terminal-toolbar"
        title={`Keyboard, voice, and attachment paths are sent to the ${labels.persistentEngine}. Voice and attachments never send Enter.`}
      >
        {session
          ? slots.toolbarLeading?.({
              projectId,
              sessionName: session.name,
            })
          : null}
        {workspaceControls ? (
          <div
            aria-label="Open terminal tabs in this split"
            className={`terminal-pane-tabs${
              tabStripDropTarget.isOver ? ' is-drop-target' : ''
            }`}
            role="tablist"
          >
            <span
              aria-hidden="true"
              className="terminal-tab-strip-drop-surface"
              ref={tabStripDropTarget.setNodeRef}
            />
            {workspaceControls.tabs.map((tab, index) =>
              isFullscreen && !tab.isActive ? null : (
              <DraggableTerminalTab
                index={index}
                key={`${tab.projectId}:${tab.sessionName}`}
                onActivate={() =>
                  workspaceControls.onActivateTab(tab.projectId, tab.sessionName)
                }
                onClose={() => {
                    focusActiveTabAfterCloseRef.current = true;
                    workspaceControls.onCloseTab(tab.projectId, tab.sessionName);
                }}
                onKeyDown={handleTerminalTabKeyDown}
                paneId={workspaceControls.paneId}
                setButtonRef={(node) => {
                  terminalTabRefs.current[index] = node;
                }}
                tab={tab}
              />
              ),
            )}
          </div>
        ) : (
          <div className="terminal-title">
            <TerminalSquare size={18} />
            <div>
              <strong>{session?.name ?? 'No session selected'}</strong>
              <span>
                {activeAttachmentAgentLabel
                  ? `${activeAttachmentAgentLabel} active`
                  : session?.current_command ?? 'Select a session'}
              </span>
            </div>
          </div>
        )}
        {/* Keep only frequent pane actions here. Attachments remain available
            by drag and drop, selection uses the platform copy shortcut, and
            interrupting a process remains a terminal keyboard action. */}
        <div className="terminal-actions">
          <span
            aria-label={`Terminal connection: ${connection}`}
            className={`connection-pill ${connection}`}
            role="status"
            title={`Terminal connection: ${connection}`}
          />
          {lastUpdate ? (
            <span className="terminal-updated">
              Updated {new Date(lastUpdate).toLocaleTimeString()}
            </span>
          ) : null}
          {session && automation ? (
            <SessionAutomationControl
              projectId={projectId}
              sessionName={session.name}
            />
          ) : null}
          {workspaceControls ? (
            <div className="terminal-action-group terminal-layout-actions">
              {workspaceControls.canClose ? (
                <button
                  aria-label="Close this terminal view"
                  onClick={workspaceControls.onCloseView}
                  title={`Close view (${labels.persistentEngine} keeps running)`}
                  type="button"
                >
                  <X size={16} />
                </button>
              ) : null}
            </div>
          ) : null}
          {session
            ? slots.toolbarTrailing?.({
                projectId,
                sessionName: session.name,
              })
            : null}
          <div className="terminal-action-group">
            <button
              type="button"
              aria-pressed={isSelectMode}
              onClick={toggleSelectMode}
              disabled={!session}
              title={
                isSelectMode
                  ? 'Exit select mode'
                  : 'Select terminal text · download file paths or open website links'
              }
            >
              <TextSelect size={16} />
            </button>
          </div>
          <div className="terminal-action-group">
            <button
              type="button"
              aria-pressed={isFullscreen}
              onClick={handleToggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen terminal'}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
          <div className="terminal-action-group">
            <button
              type="button"
              onClick={() => {
                // When connection is problematic, reconnect the websocket.
                // Otherwise, refresh the session list.
                if (
                  connection === 'closed' ||
                  connection === 'error' ||
                  connection === 'offline' ||
                  connection === 'reconnecting'
                ) {
                  handleRetryConnection();
                } else {
                  onSessionChanged();
                }
              }}
              disabled={!session}
              title={
                connection === 'closed' ||
                connection === 'error' ||
                connection === 'offline' ||
                connection === 'reconnecting'
                  ? 'Reconnect to session'
                  : 'Refresh sessions'
              }
            >
              <RefreshCw size={16} />
            </button>
            <button
              className="terminal-action-danger"
              type="button"
              onClick={handleClose}
              disabled={!session}
              title="Close session"
            >
              <Power size={16} />
            </button>
          </div>
        </div>
      </header>
      <div
        className={`terminal-host ${
          isAttachmentDragActive ? 'attachment-drag-active' : ''
        }`}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
        <div className="terminal-xterm-host" ref={hostRef} />
        {isAttachmentDragActive ? (
          <div className="terminal-attachment-drop-overlay" aria-hidden="true">
            <Paperclip size={28} />
            <strong>
              {canAttachFiles
                ? `Drop files or images into ${
                    activeAttachmentAgentLabel ?? 'this terminal'
                  }`
                : 'File attachment unavailable'}
            </strong>
            <span>
              {canAttachFiles
                ? 'Up to 4 files · 600 MiB each · PNG/JPEG images sanitized'
                : attachmentUnavailableMessage()}
            </span>
          </div>
        ) : null}
        {attachmentTransfer.kind !== 'idle' ? (
          <div
            className={`terminal-attachment-status ${attachmentTransfer.kind}`}
            role="status"
          >
            {attachmentTransfer.message}
          </div>
        ) : null}
        {isSelectMode ? (
          <pre
            ref={copyLayerRef}
            className="terminal-copy-layer"
            aria-label="Selectable terminal text"
            tabIndex={0}
            onPointerDown={handleCopyLayerInteraction}
            onWheel={handleCopyLayerWheel}
            onTouchStart={handleCopyLayerInteraction}
          >
            {selectionSnapshot
              ? copyLayerSegments.map((segment, index) => {
                  if (segment.kind === 'text') return segment.text;
                  if (segment.kind === 'web') {
                    return (
                      <a
                        key={`${index}-${segment.href}`}
                        className="terminal-web-link"
                        href={segment.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${segment.href} in a new tab`}
                        onClick={handleTerminalLinkClick}
                      >
                        {segment.text}
                      </a>
                    );
                  }
                  const resolution = resolvedPaths.get(segment.candidate);
                  if (!resolution?.path) return segment.text;
                  return (
                    <a
                      key={`${index}-${segment.candidate}`}
                      className="terminal-path-link"
                      href={workspaceFileDownloadUrl(resolution.path)}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      title={terminalPathLinkTitle(resolution)}
                      onClick={handleTerminalLinkClick}
                    >
                      {segment.text}
                    </a>
                  );
                })
              : 'No terminal text to select.'}
          </pre>
        ) : null}
      </div>
    </section>
  );
}
