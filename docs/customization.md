# Customization

The default preset intentionally matches Dolphin Tasks, but hosts can change
branding without forking terminal behavior.

## Theme

Import `@dolphin-terminal/react/theme.css`, then override variables on the
wrapper carrying `dolphin-terminal-theme`. Stable tokens cover typography,
surface/text/border colors, accent and danger colors, terminal/link/status
colors, radii, shadows, and motion easing. Import `styles.css` explicitly only
when rendering lower-level exports; `TerminalWorkspace` already loads it.

```css
.my-terminal {
  --accent: #5eead4;
  --accent-on: #061a17;
  --term-bg: #071018;
  --font-mono: "Berkeley Mono", ui-monospace, monospace;
}
```

## Labels, icons, slots, and portals

`TerminalRuntimeProvider` accepts:

- `labels`: session vocabulary, including a host-specific persistent-engine
  name such as `tmux`.
- `icons`: a partial `TerminalIconRegistry`. Unspecified controls retain the
  reviewed Lucide defaults.
- `slots`: optional `dockLeading`, `dockTrailing`, `toolbarLeading(target)`,
  and `toolbarTrailing(target)` React content.
- `portalRoot`: the element used by placement and automation popovers.
- storage keys/storage object, exact-target URL builder, optional dictation
  bridge, and automation capability.

```tsx
<TerminalRuntimeProvider
  client={client}
  icons={{ Power: BrandStopIcon }}
  labels={{ persistentEngine: 'workspace runtime' }}
  portalRoot={overlayRoot}
  slots={{
    dockLeading: <BrandMark />,
    toolbarTrailing: (target) => <AuditLink target={target} />,
  }}
>
  <TerminalWorkspace {...props} />
</TerminalRuntimeProvider>
```

Custom controls must preserve the supplied accessible name, confirmation,
exact-target identity, and X-versus-Power semantics. Avoid styling xterm's
private DOM; use the published variables and slots.
