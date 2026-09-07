# @dolphin-terminal/react

The complete React and xterm.js Dolphin Terminal workspace. It includes the
session dock, tabs, recursive splits, fullscreen, selectable terminal history,
safe file and web links, persistent session hide/restore, drag-and-drop
attachments and optional automation UI.
Copy, Ctrl-C, reconnect, and confirmed close controls remain available to
keyboard, pointer, and touch users. Hosts can align attachment validation with
their backend through `TerminalRuntimeProvider.maxAttachmentBytes`; stalled
uploads remain bounded by a deadline that scales with the selected file size.
The optional `./dictation` and `./dictation-client` exports provide local-ASR
push-to-talk with live preview and exact insertion into the focused terminal.

See the repository `docs/embedding.md` for the host adapter contract.
