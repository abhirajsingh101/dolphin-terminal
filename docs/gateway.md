# Gateway configuration

The installed application serves its gateway and compiled UI together on
`127.0.0.1:8733`. The separate `8734` Vite origin is development-only.

## Workspaces

`DOLPHIN_TERMINAL_WORKSPACES` is a trusted server setting. Accepted forms:

```bash
# one path
DOLPHIN_TERMINAL_WORKSPACES=/home/user/projects/alpha

# stable ids
DOLPHIN_TERMINAL_WORKSPACES=alpha=/home/user/projects/alpha:beta=/data/projects/beta

# display metadata
DOLPHIN_TERMINAL_WORKSPACES='[{"id":"alpha","name":"Alpha","emoji":"🐬","path":"/home/user/projects/alpha"}]'
```

The browser cannot add or widen roots. Sessions must belong to the selected
workspace. Path resolution and downloads repeat no-follow containment checks.

## Run

```bash
python -m venv .venv
.venv/bin/pip install -e './python[dev]'
DOLPHIN_TERMINAL_WORKSPACES=/path/to/project \
  .venv/bin/dolphin-terminal serve /path/to/project
```

Use `npm run dev` only for hot reload. Set `VITE_DOLPHIN_TERMINAL_URL` when that
development UI uses a different gateway URL. Origins must be listed exactly in
`DOLPHIN_TERMINAL_ALLOWED_ORIGINS`.

Useful commands:

```bash
dolphin-terminal doctor
dolphin-terminal serve --help
dolphin-terminal serve ~/projects/alpha ~/projects/beta
```

The CLI uses the current directory when no workspace is configured. The
browser cannot add or widen workspace roots.

## Session persistence

The default `native` backend is automatic and needs no separate service or
multiplexer installation. A private per-user daemon owns the shell PTYs so
closing a browser, losing a WebSocket, or restarting the gateway does not stop
the session. The daemon socket and shell are trusted host configuration and
are never accepted through HTTP or WebSocket input.

Use the compatibility provider only when an embedding host already owns tmux
sessions:

```bash
dolphin-terminal serve --session-backend tmux /path/to/project
```

## Optional local dictation

Voice is disabled by default. Enable it only when a trusted local
speech-recognition worker is configured:

```bash
DOLPHIN_TERMINAL_ENABLE_DICTATION=1 \
DOLPHIN_TERMINAL_ASR_URL=http://127.0.0.1:8411 \
  dolphin-terminal serve /path/to/project
```

The worker contract is deliberately small: `GET /health` returns JSON status,
and `POST /transcribe` accepts the recorded audio body plus
`X-Audio-Filename`, optional `X-Dictation-Language`, and optional
`X-Dictation-Mode: preview`. The gateway caps audio at 16 MiB by default;
override it with `DOLPHIN_TERMINAL_ASR_MAX_AUDIO_BYTES`.

Audio remains on the configured gateway/worker path. The frontend does not
contact a cloud speech provider. When voice is disabled, it makes no speech
health request and renders no microphone control. If an enabled worker fails,
the terminal remains fully usable.

The CLI refuses non-loopback binding unless
`DOLPHIN_TERMINAL_ALLOW_REMOTE=1`. That override is not a security system; a
remote deployment still requires operator-supplied TLS, authentication and
authorization.
