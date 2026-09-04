# Dolphin Terminal

[![CI](https://github.com/abhirajsingh101/dolphin-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/abhirajsingh101/dolphin-terminal/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/abhirajsingh101/dolphin-terminal)](https://github.com/abhirajsingh101/dolphin-terminal/releases)
[![License](https://img.shields.io/github/license/abhirajsingh101/dolphin-terminal)](LICENSE)

Dolphin Terminal is a standalone, embeddable terminal workspace for humans and
AI agents. One local service provides the browser UI, persistent sessions,
tabs, recursive splits, exact input targeting, fullscreen, selectable history,
safe file links and drag-and-drop attachments.

Voice input and agent automation are optional capabilities, not runtime
requirements. The reference distribution uses its built-in native PTY daemon
by default, so neither tmux nor an LLM is required. A tmux compatibility
adapter remains available for hosts such as Dolphin Tasks that already own
tmux sessions.

The project contains:

- `@dolphin-terminal/protocol`: provider-neutral contracts.
- `@dolphin-terminal/core`: the pure tabs/splits/persistence state machine.
- `@dolphin-terminal/react`: the complete React terminal workspace.
- `dolphin-terminal`: a localhost-first, one-process application and gateway.
- `apps/standalone`: the complete browser interface bundled into that service.

## Quick start

The lowest-dependency host experience is Docker (Docker is the only host
prerequisite):

```bash
docker run -d --name dolphin-terminal \
  -p 127.0.0.1:8733:8733 \
  -v /absolute/path/to/project:/workspace \
  ghcr.io/abhirajsingh101/dolphin-terminal:0.3.0
```

To build the same image from source:

```bash
git clone https://github.com/abhirajsingh101/dolphin-terminal.git
cd dolphin-terminal
DOLPHIN_TERMINAL_WORKSPACE=/absolute/path/to/project docker compose up --build
```

Open `http://127.0.0.1:8733`. The container contains the UI, gateway, Python
runtime and native persistent-session backend. Voice and automation are off.

For a native Linux source install:

```bash
./scripts/install-local
.venv/bin/dolphin-terminal serve /absolute/path/to/project
```

The source-install path requires Python and Node/npm at build time, but not
tmux. A release wheel already contains the compiled UI and only needs Python.
One `dolphin-terminal` command serves the UI and API while an automatically
managed, private native daemon owns persistent PTYs across browser and gateway
restarts. Run `dolphin-terminal doctor` for a concise readiness check.

The signed-by-checksum GitHub release wheel needs no source checkout or Node:

```bash
python -m pip install "https://github.com/abhirajsingh101/dolphin-terminal/releases/download/v0.3.0/dolphin_terminal-0.3.0-py3-none-any.whl"
dolphin-terminal serve /absolute/path/to/project
```

## Security posture

The terminal gateway is remote-code-execution infrastructure by design. It
binds to `127.0.0.1` by default and only exposes explicitly configured
workspace roots. Read [SECURITY.md](SECURITY.md) before exposing it through a
reverse proxy or tunnel.

## Development

```bash
npm install
npm run build
npm test
python -m venv .venv
.venv/bin/pip install -e './python[dev]'
.venv/bin/pytest -q python/tests
```

Run the hot-reload gateway and UI during development:

```bash
DOLPHIN_TERMINAL_WORKSPACES=/path/to/project npm run dev
```

Development uses `8734` for Vite and `8733` for the gateway. Production uses
only `8733`.

## Current capabilities

- Exact project/session dock with create, rename and confirmed termination.
- Multiple terminal tabs, recursive splits, drag/keyboard placement and
  per-browser-tab persistence.
- Fullscreen with exclusive focus, accessible controls and mobile switching.
- xterm.js WebGL/DOM fallback, bounded reconnects, snapshots and selection.
- Safe website links and independently revalidated workspace downloads.
- Streaming attachments that paste private paths without sending Enter.
- Optional local-ASR dictation with push-to-talk, live preview and exact
  focused-terminal insertion; it is disabled and absent from the UI by default.
- Provider-neutral Off/Learn/Active automation capability; the standalone
  gateway reports it unavailable until a host supplies an automation provider.
- One-command standalone service, tmux-free native persistence, Docker image
  and provider-neutral host adapter contract.

See [architecture](docs/architecture.md), [embedding](docs/embedding.md),
[customization](docs/customization.md), [extensions](docs/extensions.md),
[gateway configuration](docs/gateway.md), [compatibility](docs/compatibility.md),
and the [83-item parity ledger](parity/features.json).

## Status

The standalone project is implemented and Dolphin Tasks consumes the package
through a thin adapter with duplicate terminal sources removed. Native
persistence is the standalone default; tmux is an opt-in compatibility
adapter. All 83 parity entries have executable evidence, and the local
security/package/browser gates are release-ready. It has not been published or
pushed. Public publishing, artifact signing, and remote exposure still require
explicit owner authorization.
