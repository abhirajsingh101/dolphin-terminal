# Threat model

## Supported system

One trusted Linux user runs Dolphin Terminal on loopback and explicitly
configures workspace roots. The browser, terminal output, filenames, uploaded
bytes, path-looking text, WebSocket frames, and optional provider responses are
untrusted inputs. The service user, local configuration, package artifacts,
and private native-daemon socket are trusted.

Protected assets are shell/process control, session identity and lifetime,
workspace files, attachment storage, terminal content, transcripts, and host
credentials.

## Principal threats and controls

| Threat | Control |
|---|---|
| Arbitrary command/root/socket selection | Browser protocol exposes opaque configured IDs only; launch command and backend socket stay server-side |
| Cross-workspace/session mutation | Every lifecycle, snapshot, path, upload, and stream operation resolves the exact pair again |
| Browser close kills work | Attachment lifetime is separate from persistent-session lifetime; only confirmed Power calls terminate |
| Path traversal or symlink race | Server allowlist plus independent no-follow download validation |
| Malicious/oversized uploads | Count, byte, quota, filename, decode/pixel, private staging, atomic publication, expiry, and cancellation bounds |
| Unsafe terminal links | Scheme allowlist and server-confirmed regular files only |
| Cross-origin browser attachment | Exact Origin validation before WebSocket acceptance and non-credentialed exact CORS origins |
| Memory/descriptor exhaustion | Bounded frames/history/client buffers/dimensions, output coalescing, attachment limits, and cleanup tests |
| Stale voice/upload/automation target | Connection generation and exact target are rechecked immediately before insertion; no implicit Enter |
| Secret or personal-data leakage | No terminal-content telemetry; secret/personal-path scans and neutral fixtures/evidence |

## Residual and unsupported risks

A terminal intentionally grants the service user code-execution authority in
configured workspaces. Compromise of that Unix account is outside this
component's isolation boundary. Native sessions do not survive reboot,
container stop, kernel termination, or forced daemon kill. Remote and
multi-user deployments require controls not included in 0.3.0 and are not
covered by the release verdict.

The reproducible security evidence and tool limitations are recorded in
`SECURITY-REVIEW.md`.
