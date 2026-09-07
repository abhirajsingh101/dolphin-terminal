import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createTerminalHttpClient,
  createTerminalDictationHttpClient,
  TerminalDictationControl,
  TerminalDictationProvider,
  TerminalRuntimeProvider,
  TerminalWorkspace,
  useTerminalDictation,
  type TerminalCapabilities,
  type TerminalHttpClient,
  type TerminalSession,
  type TerminalWorkspaceDescriptor,
  type TerminalWorkspaceStatus,
} from '@dolphin-terminal/react';

const gatewayUrl =
  import.meta.env.VITE_DOLPHIN_TERMINAL_URL ??
  (() => {
    const url = new URL(window.location.origin);
    if (url.port === '8734') url.port = '8733';
    return url.origin;
  })();

const disabledCapabilities: TerminalCapabilities = {
  session_backend: {
    id: 'unknown',
    available: false,
    detail: 'Connecting to the persistent session backend.',
  },
  attachments: { max_bytes: 600 * 1024 * 1024 },
  dictation: { enabled: false },
  automation: { enabled: false },
};

const DEFAULT_MAX_ATTACHMENT_BYTES = 600 * 1024 * 1024;
const WORKSPACE_STORAGE_PREFIX = 'dolphin.terminal.workspace.tab.v2';
const WORKSPACE_ROUTE_ALIAS_PREFIX =
  'dolphin.terminal.workspace.route-alias.v1:';
const WORKSPACE_LOAD_TIMEOUT_MS = 15_000;

function initialQueryTarget() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('workspace');
  return {
    projectId,
    // A session name is meaningful only inside a workspace. Treating an
    // unscoped value as a persistence identity could restore an unrelated
    // layout after the workspace list chooses its fallback project.
    sessionName: projectId ? params.get('session') : null,
  };
}

function targetStorageKey(projectId: string, sessionName: string | null) {
  return [
    WORKSPACE_STORAGE_PREFIX,
    encodeURIComponent(projectId),
    encodeURIComponent(sessionName ?? ''),
  ].join(':');
}

function workspaceStorageKey() {
  const target = initialQueryTarget();
  if (!target.projectId) return undefined;
  const routeKey = targetStorageKey(target.projectId, target.sessionName);
  try {
    return (
      window.sessionStorage.getItem(`${WORKSPACE_ROUTE_ALIAS_PREFIX}${routeKey}`) ??
      routeKey
    );
  } catch {
    return routeKey;
  }
}

function linkWorkspaceRoute(
  storageKey: string | undefined,
  projectId: string,
  sessionName: string | null,
) {
  if (!storageKey) return;
  try {
    window.sessionStorage.setItem(
      `${WORKSPACE_ROUTE_ALIAS_PREFIX}${targetStorageKey(projectId, sessionName)}`,
      storageKey,
    );
  } catch {
    // Route aliases are best-effort. The live workspace remains usable when
    // session storage is blocked or full.
  }
}

function replaceRouteTarget(
  storageKey: string | undefined,
  projectId: string,
  sessionName: string | null,
) {
  const url = new URL(window.location.href);
  url.searchParams.set('workspace', projectId);
  if (sessionName) url.searchParams.set('session', sessionName);
  else url.searchParams.delete('session');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  linkWorkspaceRoute(storageKey, projectId, sessionName);
}

function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() =>
    window.matchMedia('(max-width: 820px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

function StandaloneTerminal({
  capabilities,
  client,
  storageKey,
}: {
  capabilities: TerminalCapabilities;
  client: TerminalHttpClient;
  storageKey: string | undefined;
}) {
  const dictation = useTerminalDictation();
  const queryTarget = useMemo(initialQueryTarget, []);
  const [projects, setProjects] = useState<TerminalWorkspaceDescriptor[]>([]);
  const [primaryProjectId, setPrimaryProjectId] = useState<string | null>(
    queryTarget.projectId,
  );
  const [workspace, setWorkspace] = useState<TerminalWorkspaceStatus | null>(null);
  const [selectedSessionName, setSelectedSessionName] = useState<string | null>(
    queryTarget.sessionName,
  );
  const [selectedTargetRevision, setSelectedTargetRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const primaryProjectIdRef = useRef(primaryProjectId);
  const desiredProjectIdRef = useRef(primaryProjectId);
  const selectedSessionNameRef = useRef(selectedSessionName);
  const workspaceRequestGenerationRef = useRef(0);
  const workspaceRequestAbortRef = useRef<AbortController | null>(null);
  const rollbackErrorTargetRef = useRef<string | null>(null);
  const isNarrowLayout = useNarrowLayout();

  primaryProjectIdRef.current = primaryProjectId;
  selectedSessionNameRef.current = selectedSessionName;

  useEffect(() => {
    const controller = new AbortController();
    void client
      .listWorkspaces(controller.signal)
      .then((items) => {
        setProjects(items);
        setPrimaryProjectId((current) => {
          const next =
            current && items.some((item) => item.id === current)
              ? current
              : (items[0]?.id ?? null);
          desiredProjectIdRef.current = next;
          return next;
        });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    return () => controller.abort();
  }, [client]);

  useEffect(
    () => () => {
      workspaceRequestGenerationRef.current += 1;
      workspaceRequestAbortRef.current?.abort();
    },
    [],
  );

  async function loadWorkspaceTarget(
    projectId: string,
    preferredSessionName: string | null,
    rollbackOnFailure = false,
  ) {
    const committedProjectId = primaryProjectIdRef.current;
    const committedSessionName = selectedSessionNameRef.current;
    workspaceRequestAbortRef.current?.abort();
    const abortController = new AbortController();
    workspaceRequestAbortRef.current = abortController;
    const generation = workspaceRequestGenerationRef.current + 1;
    workspaceRequestGenerationRef.current = generation;
    let timedOut = false;
    let timeoutId: number | null = null;
    try {
      const next = await Promise.race([
        client.fetchWorkspace(projectId, abortController.signal),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            timedOut = true;
            abortController.abort();
            reject(new Error('Workspace load timed out after 15 seconds.'));
          }, WORKSPACE_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (
        workspaceRequestGenerationRef.current !== generation ||
        desiredProjectIdRef.current !== projectId
      ) {
        return;
      }
      const nextSessionName =
        preferredSessionName &&
        next.sessions.some((session) => session.name === preferredSessionName)
          ? preferredSessionName
          : (next.sessions[0]?.name ?? null);
      primaryProjectIdRef.current = projectId;
      selectedSessionNameRef.current = nextSessionName;
      setPrimaryProjectId(projectId);
      setWorkspace(next);
      setSelectedSessionName(nextSessionName);
      rollbackErrorTargetRef.current = null;
      setError(null);
      replaceRouteTarget(storageKey, projectId, nextSessionName);
      if (!nextSessionName) {
        // A successful empty workspace is an explicit controlled clear, not a
        // transient refresh gap. Advance the revision so a previously opened
        // optimistic tab cannot survive the server's empty inventory.
        setSelectedTargetRevision((current) => current + 1);
      }
    } catch (reason) {
      if (
        workspaceRequestGenerationRef.current !== generation ||
        (abortController.signal.aborted && !timedOut)
      ) {
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      if (rollbackOnFailure && committedProjectId) {
        desiredProjectIdRef.current = committedProjectId;
        rollbackErrorTargetRef.current = `${committedProjectId}:${
          committedSessionName ?? ''
        }`;
        replaceRouteTarget(storageKey, committedProjectId, committedSessionName);
        setSelectedTargetRevision((current) => current + 1);
      }
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (workspaceRequestAbortRef.current === abortController) {
        workspaceRequestAbortRef.current = null;
      }
    }
  }

  async function refreshWorkspace(projectId = primaryProjectIdRef.current) {
    if (!projectId) return;
    await loadWorkspaceTarget(
      projectId,
      projectId === primaryProjectIdRef.current
        ? selectedSessionNameRef.current
        : null,
    );
  }

  useEffect(() => {
    if (!primaryProjectId) return;
    if (workspace?.project_id === primaryProjectId) return;
    setError(null);
    void refreshWorkspace(primaryProjectId).catch((reason) => setError(String(reason)));
  }, [primaryProjectId, workspace?.project_id]);

  const primaryProject = projects.find((item) => item.id === primaryProjectId);
  const selectedSession =
    workspace?.sessions.find((session) => session.name === selectedSessionName) ??
    null;

  const targetHref = ({
    projectId,
    sessionName,
  }: {
    projectId: string;
    sessionName: string;
  }) => {
    const params = new URLSearchParams({ workspace: projectId, session: sessionName });
    return `${window.location.pathname}?${params.toString()}`;
  };

  return (
    <TerminalRuntimeProvider
      automation={capabilities.automation.enabled}
      client={client}
      dictation={dictation}
      labels={{
        session: 'session',
        sessions: 'sessions',
        newSession: 'New session',
        persistentEngine: 'session backend',
      }}
      maxAttachmentBytes={
        capabilities.attachments?.max_bytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
      }
      storageKey={storageKey}
      targetHref={targetHref}
    >
      <main className="standalone-shell dolphin-terminal-theme">
        <header className="standalone-header">
          <div>
            <strong>Dolphin Terminal</strong>
            <span>Persistent agent sessions, tabs and split panes</span>
          </div>
          <span className="standalone-gateway">
            Local gateway · {gatewayUrl}
          </span>
        </header>
        {capabilities.dictation.enabled ? <TerminalDictationControl /> : null}
        {error ? <div className="standalone-error" role="alert">{error}</div> : null}
        {!primaryProject || !workspace ? (
          <section className="standalone-loading">
            <strong>{projects.length ? 'Loading workspace…' : 'Connecting to gateway…'}</strong>
            <span>Configure `DOLPHIN_TERMINAL_WORKSPACES` on the server.</span>
          </section>
        ) : (
          <TerminalWorkspace
            isNarrowLayout={isNarrowLayout}
            onActiveTargetChange={(projectId, sessionName) => {
              const targetKey = `${projectId}:${sessionName}`;
              if (rollbackErrorTargetRef.current === targetKey) {
                rollbackErrorTargetRef.current = null;
              } else {
                rollbackErrorTargetRef.current = null;
                setError(null);
              }
              replaceRouteTarget(storageKey, projectId, sessionName);
              if (projectId === primaryProjectIdRef.current) {
                desiredProjectIdRef.current = projectId;
                workspaceRequestGenerationRef.current += 1;
                workspaceRequestAbortRef.current?.abort();
                selectedSessionNameRef.current = sessionName;
                setSelectedSessionName(sessionName);
                return;
              }
              desiredProjectIdRef.current = projectId;
              void loadWorkspaceTarget(projectId, sessionName, true);
            }}
            onActiveTargetCleared={(projectId) => {
              if (projectId !== primaryProjectIdRef.current) return;
              const targetKey = `${projectId}:`;
              if (rollbackErrorTargetRef.current === targetKey) {
                rollbackErrorTargetRef.current = null;
              } else {
                rollbackErrorTargetRef.current = null;
                setError(null);
              }
              desiredProjectIdRef.current = projectId;
              selectedSessionNameRef.current = null;
              setSelectedSessionName(null);
              replaceRouteTarget(storageKey, projectId, null);
            }}
            onCreateSession={async (projectId, name) => {
              const created = await client.createSession(projectId, name);
              if (
                projectId === primaryProjectIdRef.current &&
                desiredProjectIdRef.current === projectId
              ) {
                void refreshWorkspace(projectId);
              }
              return created;
            }}
            onRefreshPrimaryProject={() => refreshWorkspace(primaryProject.id)}
            onRenameSession={async (projectId, session: TerminalSession, name) => {
              const renamed = await client.renameSession(projectId, session.name, name);
              if (
                projectId === primaryProjectIdRef.current &&
                desiredProjectIdRef.current === projectId
              ) {
                void refreshWorkspace(projectId);
              }
              return renamed;
            }}
            primaryProject={primaryProject}
            primaryWorkspace={workspace}
            projects={projects}
            selectedSession={selectedSession}
            selectedTargetRevision={selectedTargetRevision}
          />
        )}
      </main>
    </TerminalRuntimeProvider>
  );
}

export default function App() {
  const client = useMemo(() => createTerminalHttpClient(gatewayUrl), []);
  const dictationClient = useMemo(
    () => createTerminalDictationHttpClient(gatewayUrl),
    [],
  );
  const storageKey = useMemo(workspaceStorageKey, []);
  const [capabilities, setCapabilities] = useState<TerminalCapabilities>(
    disabledCapabilities,
  );

  useEffect(() => {
    const controller = new AbortController();
    void client
      .fetchCapabilities(controller.signal)
      .then(setCapabilities)
      .catch(() => {
        // Workspace discovery below presents the actionable connection error.
        // Optional features remain safely disabled until advertised.
      });
    return () => controller.abort();
  }, [client]);

  return (
    <TerminalDictationProvider
      client={dictationClient}
      enabled={capabilities.dictation.enabled}
    >
      <StandaloneTerminal
        capabilities={capabilities}
        client={client}
        storageKey={storageKey}
      />
    </TerminalDictationProvider>
  );
}
