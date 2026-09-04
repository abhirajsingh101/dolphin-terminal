# Optional user services

This template keeps the complete one-process application alive without owning
persistent session lifetimes. Review paths before installing it.

```bash
mkdir -p ~/.config/dolphin-terminal ~/.config/systemd/user
cp .env.example ~/.config/dolphin-terminal/environment
cp systemd/user/dolphin-terminal-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dolphin-terminal-gateway.service
```

Run `./scripts/install-local` before starting the service. The unit serves the
built UI and API on port 8733 and uses `KillMode=process` so stopping or
restarting it does not cgroup-kill the persistence backend or sessions spawned
through the gateway.
