# Security and privacy review — 0.3.0

Review date: 2026-09-04

Verdict: **GO for a trusted, single-user, localhost release.** Direct network
exposure and multi-user hosting remain unsupported.

## Boundaries checked

- The gateway binds to loopback by default and refuses non-loopback binds
  without the explicit remote acknowledgement.
- HTTP and WebSocket clients choose only configured workspace IDs and validated
  session names. They cannot supply a filesystem root, shell executable,
  native/tmux socket, or launch command.
- The native daemon opens only a Unix-domain socket with mode `0600` inside an
  owner-checked `0700` directory. The browser never sees its path.
- Native shell creation uses an argument vector and a host-configured or login
  shell; it never interpolates browser text into a shell launch command.
- Every inventory, rename, snapshot, and termination request is checked against
  the exact session and workspace. A browser tab or WebSocket close terminates
  only its attachment helper.
- Origin checks precede WebSocket acceptance. CORS origins are exact; wildcard
  origins and credentialed CORS are not enabled.
- Resize, snapshot, control-frame, replay-history, write-buffer, filename,
  upload, image, storage, and workspace-root limits are bounded.
- Download authorization repeats no-follow containment checks independently of
  terminal output and path-resolution results.
- Attachments use private staging, bounded streaming, image decode/re-encode,
  atomic publication, expiry, and symlink-safe cleanup. Voice and automation
  are disabled by default; neither is required by the package.
- The optional speech URL accepts only HTTP(S) host configuration without
  embedded credentials. Terminal content, paths, transcripts, and attachment
  names are not emitted as telemetry.

## Automated evidence

The reproducible command is `./scripts/security-check`.

- npm audit: 0 known vulnerabilities across 104 resolved dependencies; 0 in
  the 21 production dependencies.
- Public CI runs Google OSV Scanner 2.5.1 recursively against the repository
  using the vendor's reusable workflow pinned to an immutable commit.
- pip-audit 2.10.1: 0 known vulnerabilities in the resolved Python project.
- Bandit 1.9.4 at medium/high severity: 0 findings.
- Gitleaks: no secrets found in the working tree.
- Personal-path scan: no owner-specific home/data paths, hostnames, or public
  IPs in release sources.
- License gate: all 12 bundled browser-runtime packages include reviewed
  0BSD/Apache-2.0/ISC/MIT texts; direct Python runtime dependencies resolve to
  reviewed permissive licenses. The notices are embedded in the Python wheel.
- Workspace escape, no-follow download, unsafe name, upload overflow,
  cancellation, image sanitation, Origin, exact-session, native socket mode,
  detach persistence, and daemon stop tests pass in the Python suite.

Semgrep was attempted on this workstation but its binary exited with SIGSEGV;
the release verdict does not count it as passing evidence.

The internal extraction commits contained owner-specific baseline fixtures.
They are not suitable for a public history. The release source archive and
public root commit are created from the path-clean reviewed tree; the internal
history is retained only as a local recovery bundle and must not be pushed.

## Supported-risk statement

The native daemon provides persistence across browser disconnects and gateway
restarts. Like tmux and other local multiplexers, it cannot preserve running
processes across a kernel reboot, forced daemon kill, or container stop. Any
process running as the same Unix user already has that user's filesystem and
process authority; this is not a tenant-isolation boundary.

Remote access must be placed behind operator-supplied TLS, authentication, and
authorization. `--allow-remote` is only an acknowledgement and is not itself a
security control.
