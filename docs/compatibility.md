# Compatibility

| Surface | Version 0.3.0 support |
|---|---|
| Host OS | Linux with PTY and Unix-domain socket support |
| Python | 3.11 and newer |
| Node | 22 and newer for source builds only |
| Browsers | Current Chromium/Chrome; Firefox/WebKit use the DOM renderer when WebGL is unavailable |
| React embedding | React and React DOM 19 or newer peer dependencies |
| Persistent sessions | Built-in native backend by default; tmux adapter optional |
| Container | Docker/OCI image, loopback-published by the provided Compose file |
| Voice | Optional HTTP(S) transcription provider; disabled by default |
| Agent automation | Optional host provider; unavailable in the standalone distribution |
| Multi-user hosting | Not supported |
| Windows/macOS native daemon | Not supported in 0.3.0 |

The `/terminal/v1` protocol and persisted layout v2 are the compatibility
boundaries. Additive fields may land within v1; removals or semantic changes
require a new protocol version. Hosts should keep workspace and session IDs
opaque and pin all three npm packages to one version.
