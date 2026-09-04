# Architecture

Dolphin Terminal separates reusable state, React UI, host capabilities and
machine control so a consuming app can adopt the terminal without adopting
Dolphin Tasks.

```text
Host application / standalone shell
             │
             ├── TerminalRuntimeProvider
             │     ├── TerminalClient (required)
             │     ├── dictation bridge (optional)
             │     ├── automation capability (optional)
             │     └── routing and storage policies
             │
             └── TerminalWorkspace
                    ├── @dolphin-terminal/core
                    ├── xterm.js
                    └── versioned protocol
                              │
                              └── localhost FastAPI gateway
                                    ├── SessionBackend contract
                                    │      ├── built-in native PTY daemon (default)
                                    │      └── tmux compatibility adapter
                                    ├── no-follow file reads
                                    └── private attachment storage
```

## Packages

- `@dolphin-terminal/protocol` contains stable data and provider contracts.
- `@dolphin-terminal/core` contains the serializable tab/split state machine,
  reconnect policy, link/path parsing, copy scrolling, attachment selection
  and dictation sanitization. It has no React or product dependency.
- `@dolphin-terminal/react` owns the session dock, terminal tabs, recursive
  split panes, xterm renderer, fullscreen, selectable history, icons and
  optional automation surface.
- `dolphin-terminal` is the one-process Linux reference application. Browser
  roots and commands are never accepted; workspaces come from trusted server
  config.
- `apps/standalone` is compiled into the Python package and served by that
  gateway. The Vite server exists only for development.

## Session ownership

The configured `SessionBackend` owns process lifetime. A browser pane owns only
an attachment client. Unmounting, closing a tab, closing a split, losing a
websocket or restarting a host app terminates the attachment process, never the
persistent session. The Power action is intentionally a different, confirmed
API call.

`NativeSessionBackend` is the standalone default. Its private per-user daemon
owns PTYs and bounded replay history, supports multiple attachments, and
survives UI or gateway restarts. `TmuxSessionBackend` preserves Dolphin Tasks'
existing sessions without migration risk. The React packages and versioned
HTTP API use canonical workspace/session contracts; compatibility wording is
a host-selectable label set. Another multiplexer can be added by implementing
inventory, lifecycle, snapshot, path and attach-command operations.

## Host integration

A host supplies a `TerminalClient`. Dolphin Tasks maps that interface to its
existing `/api/projects/...` routes and supplies its existing dictation and
OpenClaw automation providers. The standalone reference client maps the same
interface to `/terminal/v1/...`.

The reference app reads `/terminal/v1/capabilities` before rendering optional
controls. The standard gateway advertises voice only when explicitly enabled,
and never advertises automation because it ships without an agent runner.
