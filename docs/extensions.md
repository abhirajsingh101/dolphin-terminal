# Extension guide

There are two supported extension boundaries.

## Browser hosts

Implement the typed `TerminalClient` contract from
`@dolphin-terminal/protocol`. It covers inventory, exact lifecycle mutations,
snapshots, path/download handling, attachments, optional automation, and one
exact WebSocket URL. Browser code must use opaque workspace/session identity;
it must never accept or construct host roots, sockets, shells, or commands.

Optional dictation implements `TerminalDictationClient` and is installed with
`TerminalDictationProvider`. Optional automation methods may return an
explicit unavailable capability. Neither feature belongs in terminal core.

## Session backends

Implement `dolphin_terminal.session_backend.SessionBackend`, then pass the
instance to `create_app(settings, session_backend=backend)`. A backend owns
process lifetime and must provide health, exact workspace inventory/lifecycle,
snapshot capture, current paths, and an argument-vector attachment command.

Required invariants:

- closing an attachment never kills its persistent session;
- terminate, rename, capture, and attach resolve one exact session;
- dimensions, history, input, buffers, and process cleanup are bounded;
- errors become `SessionBackendError` with safe client text;
- no browser field selects an executable, socket, root, or launch command.

The built-in `NativeSessionBackend` is the reference implementation;
`TmuxSessionBackend` is the compatibility example.
