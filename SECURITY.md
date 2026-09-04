# Security Policy

## Supported deployment

The initial supported mode is one trusted local operator on Linux, with the
gateway bound to `127.0.0.1` and an explicit workspace allowlist. Do not expose
the gateway directly to an untrusted network.

Remote access requires TLS termination, authentication, Origin validation,
and authorization configured by the operator. Multi-user and multi-tenant
hosting are not supported by the initial release.

See `THREAT_MODEL.md` and `docs/remote-deployment.md` for the reviewed trust
boundaries and unsupported modes.

## Terminal boundaries

- Browsers cannot nominate filesystem roots, native/tmux sockets, executables, or
  arbitrary launch commands.
- The native daemon listens on a `0600` Unix-domain socket inside a `0700`
  per-user runtime directory. It never opens a TCP listener.
- Every session operation is scoped to one configured workspace.
- Browser-tab/view closure never terminates the persistent session. Termination
  is a separate, explicit exact-session operation.
- Attachments and voice insert text without sending Enter.
- Terminal output is untrusted. Paths and links are validated before becoming
  actionable.
- Terminal contents, transcripts, paths, and attachment names are not telemetry.

## Reporting

Until a public security contact is announced, report issues privately to the
repository owner. Do not include terminal transcripts, personal paths, secrets,
or attachment contents in reports.
