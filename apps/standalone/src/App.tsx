import { useEffect, useMemo, useState } from 'react';

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
  dictation: { enabled: false },
  automation: { enabled: false },
};

function initialQueryTarget() {
  const params = new URLSearchParams(window.location.search);
  return {
    projectId: params.get('workspace'),
    sessionName: params.get('session'),
  };
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
}: {
  capabilities: TerminalCapabilities;
  client: TerminalHttpClient;
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
  const [error, setError] = useState<string | null>(null);
  const isNarrowLayout = useNarrowLayout();

  useEffect(() => {
    const controller = new AbortController();
    void client
      .listWorkspaces(controller.signal)
      .then((items) => {
        setProjects(items);
        setPrimaryProjectId((current) =>
          current && items.some((item) => item.id === current)
            ? current
            : (items[0]?.id ?? null),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    return () => controller.abort();
  }, [client]);

  async function refreshWorkspace(projectId = primaryProjectId) {
    if (!projectId) return;
    const next = await client.fetchWorkspace(projectId);
    setWorkspace(next);
    setSelectedSessionName((current) =>
      current && next.sessions.some((session) => session.name === current)
        ? current
        : (next.sessions[0]?.name ?? null),
    );
  }

  useEffect(() => {
    if (!primaryProjectId) return;
    setError(null);
    void refreshWorkspace(primaryProjectId).catch((reason) => setError(String(reason)));
  }, [primaryProjectId]);

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
              setPrimaryProjectId(projectId);
              setSelectedSessionName(sessionName);
            }}
            onCreateSession={async (projectId, name) => {
              const created = await client.createSession(projectId, name);
              if (projectId === primaryProjectId) await refreshWorkspace(projectId);
              return created;
            }}
            onRefreshPrimaryProject={() => refreshWorkspace(primaryProject.id)}
            onRenameSession={async (projectId, session: TerminalSession, name) => {
              const renamed = await client.renameSession(projectId, session.name, name);
              if (projectId === primaryProjectId) await refreshWorkspace(projectId);
              return renamed;
            }}
            primaryProject={primaryProject}
            primaryWorkspace={workspace}
            projects={projects}
            selectedSession={selectedSession}
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
      <StandaloneTerminal capabilities={capabilities} client={client} />
    </TerminalDictationProvider>
  );
}
