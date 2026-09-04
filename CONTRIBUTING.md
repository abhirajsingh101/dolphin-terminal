# Contributing

Thank you for improving Dolphin Terminal. The project treats terminal input,
persistent-session identity, filesystem access and session termination as
security-critical.

## Development checks

```bash
npm install
npm run typecheck
npm test
npm run build
python -m pip install -e './python[dev]'
python -m pytest -q python/tests
```

Changes to tabs, splits, xterm transport, attachments, select-text mode,
fullscreen, session lifecycle or adapters must update the feature-parity
ledger and include a regression test. A browser view close must never become a
session-backend kill, and text insertion must never add Enter implicitly.

## Pull requests

- Keep provider-neutral code out of host adapters.
- Document any public contract change and preserve v1 compatibility or state
  the migration explicitly.
- Do not include terminal transcripts, private filesystem paths, secrets or
  user attachment contents in fixtures, screenshots or logs.
- Run the security-focused Python suite and the consuming-host browser suite.

Public release and security contact details are maintained by the repository
owner. Until then, follow the private reporting instructions in SECURITY.md.
