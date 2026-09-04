# Distribution

## What is self-contained

The Python wheel contains the API server and compiled browser application. One
`dolphin-terminal serve` process serves both. It does not require Dolphin Tasks,
an LLM, an agent runner, a speech model, a second frontend process or a cloud
service.

The Docker image also contains Python, the UI and the native PTY daemon, so
Docker is its only host prerequisite. Browser disconnects and gateway restarts
inside a running container preserve sessions. Stopping or deleting the
container terminates its processes; projects remain on the bind-mounted host
path.

The native Linux package defaults to `NativeSessionBackend`, an automatically
managed per-user daemon built entirely on the Python standard library and
Linux PTYs. It needs no host tmux installation. `TmuxSessionBackend` remains an
explicit option for compatibility with existing Dolphin sessions. Version
0.3.0 is not a statically linked single binary; the Python wheel is the native
application artifact.

## Release artifacts

A public release can provide:

- Python wheel and source distribution with the UI embedded.
- OCI image from the repository Dockerfile.
- npm packages for protocol, pure state and React embedding.

`./scripts/release-check` performs the complete local release gate and writes
checksummed artifacts plus dependency records under `release-dist/`. The 83
parity entries and security/privacy review are complete for version 0.3.0.
Artifact signing requires the owner's established release identity.
Publishing, pushing and remote exposure still require explicit authorization.
