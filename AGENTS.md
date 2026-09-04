# Dolphin Terminal agent instructions

- This is a standalone terminal component, not Dolphin Tasks business UI. tmux
  is the first replaceable persistence adapter, not a public UI dependency.
- Keep `packages/core` pure, `packages/protocol` provider-neutral, and host
  product behavior behind `TerminalClient` and optional capability adapters.
- Treat exact workspace/session targeting as an invariant.
- Closing a browser tab or split must not kill tmux. Only the confirmed Power
  action may terminate one exact session.
- Never add a browser-controlled workspace root, tmux socket, executable or
  arbitrary launch command.
- Never send Enter for dictation or attachments.
- Bind the gateway to loopback by default and preserve Origin validation.
- Before reporting success run TypeScript typecheck/tests/build and Python
  tests. For UI changes, run Playwright against a built artifact.
- Do not publish, push packages or expose the gateway remotely without the
  owner's explicit authorization.
