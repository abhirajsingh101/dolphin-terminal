# Dolphin Tasks migration

Dolphin Tasks is the first consuming host.

- The host imports `TerminalWorkspace` and `TerminalRuntimeProvider` from the
  sibling standalone project.
- `dolphinTerminalClient.ts` maps the generic contract to Dolphin's existing
  workspace, tmux, snapshot, file, upload and automation API routes.
- Dolphin's dictation context is supplied through the optional runtime bridge.
- Dolphin's hash route builder is supplied as `targetHref`; the component has
  no product-router dependency.
- Vite deduplicates React for the local symlink. The bundle check asserts both
  the workspace and xterm pane stay out of the initial control-center route.
- Dolphin now has one terminal UI implementation: the standalone package.
  A build-time boundary check rejects reintroduced local workspace, pane,
  split-model, reconnect, path/link, and attachment implementations.
- The legacy implementation was built and exercised before removal. Git commit
  `7f8161c` remains the immutable source rollback point; restoring it is a Git
  rollback, not a second live implementation or a session migration.

The package preserves Dolphin's storage keys, exact route adapter, dictation,
automation, todo dispatch, command palette, tmux labels, and backend APIs.
Public publication is a separate owner-authorized action.
