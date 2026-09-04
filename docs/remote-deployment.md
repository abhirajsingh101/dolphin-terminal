# Remote deployment

Version 0.3.0 is supported as a trusted single-user localhost service. It has
no built-in user authentication or tenant isolation. Do not expose the gateway
directly to a LAN or the public internet.

The `--allow-remote` flag only acknowledges a non-loopback bind. It is not an
access control. An operator choosing remote access must place the service
behind a reverse proxy that supplies TLS, strong authentication, per-user
authorization, WebSocket forwarding, request/body limits, and an exact Origin
allowlist. The proxy must protect every `/terminal/v1` HTTP and WebSocket route,
including downloads and attachments.

Keep the native Unix socket and state directory private to the service user,
mount only intended workspaces, and do not share one daemon between mutually
untrusted users. For remote use, audit proxy logs to ensure terminal contents,
paths, transcripts, filenames, and query strings are not retained.

Multi-user or multi-tenant service remains unsupported even behind a proxy;
same-user processes share operating-system authority.
