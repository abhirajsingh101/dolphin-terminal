# Dolphin Terminal

This Python package is the one-command Dolphin Terminal distribution. Its
wheel contains the compiled browser UI, localhost-first FastAPI gateway and
replaceable persistent-session backend contract. The built-in native PTY
daemon is the default. The tmux compatibility adapter is optional; voice and
agent automation are not dependencies.

```bash
pip install dolphin-terminal
dolphin-terminal serve /path/to/project
dolphin-terminal doctor
```

The complete project documentation and security policy live in the repository
root.
