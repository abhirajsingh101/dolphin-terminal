# Embedding Dolphin Terminal

Install the three packages (during local development they can be npm workspace
or `file:` dependencies):

```bash
npm install @dolphin-terminal/protocol @dolphin-terminal/core @dolphin-terminal/react
```

Provide a client and render the workspace:

```tsx
import {
  TerminalRuntimeProvider,
  TerminalWorkspace,
  createTerminalHttpClient,
} from '@dolphin-terminal/react';
import '@dolphin-terminal/react/theme.css';

const client = createTerminalHttpClient('http://127.0.0.1:8733');

<TerminalRuntimeProvider
  client={client}
  automation={false}
  labels={{
    session: 'session',
    sessions: 'sessions',
    newSession: 'New session',
    persistentEngine: 'session backend',
  }}
  targetHref={({ projectId, sessionName }) =>
    `/terminal?workspace=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionName)}`
  }
>
  <TerminalWorkspace
    projects={projects}
    primaryProject={project}
    primaryWorkspace={workspace}
    selectedSession={session}
    isNarrowLayout={false}
    onActiveTargetChange={setExactTarget}
    onCreateSession={client.createSession}
    onRenameSession={(id, current, name) =>
      client.renameSession(id, current.name, name)
    }
    onRefreshPrimaryProject={refresh}
  />
</TerminalRuntimeProvider>
```

The complete default component CSS is loaded by `TerminalWorkspace`; import
`theme.css` when the host does not already provide equivalent design tokens.
Override tokens on a wrapper instead of targeting internal xterm DOM.

## Optional dictation

The standalone gateway and React package include an optional local-ASR
adapter. Enable it only when the gateway advertises the capability, then wrap
the runtime with it, pass its exact-target bridge into the runtime, and render
the control in normal document flow:

```tsx
import {
  TerminalDictationControl,
  TerminalDictationProvider,
  TerminalRuntimeProvider,
  createTerminalDictationHttpClient,
  useTerminalDictation,
} from '@dolphin-terminal/react';

const speech = createTerminalDictationHttpClient('http://127.0.0.1:8733');

function TerminalSurface() {
  const dictation = useTerminalDictation();
  return (
    <TerminalRuntimeProvider client={client} dictation={dictation}>
      <TerminalDictationControl />
      <TerminalWorkspace {...workspaceProps} />
    </TerminalRuntimeProvider>
  );
}

<TerminalDictationProvider client={speech} enabled={capabilities.dictation.enabled}>
  <TerminalSurface />
</TerminalDictationProvider>;
```

The bridge prepares the currently focused live xterm before recording and
revalidates the same project, session, terminal and WebSocket immediately
before insertion. It never submits Enter.

For code splitting, import the runtime and workspace subpaths separately:

```tsx
import { TerminalRuntimeProvider } from '@dolphin-terminal/react/runtime';
const TerminalWorkspace = lazy(() => import('@dolphin-terminal/react/workspace'));
```

If a local linked checkout produces two React dispatchers, configure the host
bundler to deduplicate `react` and `react-dom`. Published installs use the
package peer dependencies normally.
