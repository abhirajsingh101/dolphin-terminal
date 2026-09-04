# Feature parity ledger

`features.json` is the machine-readable extraction contract copied from the
83-item Dolphin Tasks baseline. `implemented` means the behavior exists in the
standalone source. `verified` additionally requires named standalone and
Dolphin-host evidence plus visual review where applicable.

All 83 entries are now `verified`. `evidence-catalog.json` resolves every test
and visual reference to a repository file and repeatable command;
`npm run check:parity` fails on a missing item, missing evidence, unresolved
visual state, or deleted source file. Reviewed screenshots are under
`parity/evidence/`; state-specific behavior that is clearer as an interaction
is marked `automated_assertion` and linked to its browser suite.

The source baseline remains historical. `verification_snapshot` identifies the
current standalone/Dolphin acceptance pair. Publication is still a separate
owner-authorized action.
