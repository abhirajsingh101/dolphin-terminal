import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TerminalClient } from '@dolphin-terminal/protocol';
import { defaultTerminalIcons } from './customization';
import { TerminalRuntimeProvider, useTerminalRuntime } from './TerminalRuntime';

const client = {} as TerminalClient;

function RuntimeProbe() {
  const runtime = useTerminalRuntime();
  return (
    <output
      data-default-power={runtime.icons.Power === defaultTerminalIcons.Power}
      data-label={runtime.labels.newSession}
      data-no-portal={runtime.portalRoot === null}
      data-overridden-terminal={
        runtime.icons.TerminalSquare === defaultTerminalIcons.Power
      }
      data-slot={runtime.slots.dockLeading}
    />
  );
}

describe('TerminalRuntimeProvider customization', () => {
  it('merges icon overrides while preserving labels, slots, and explicit portal policy', () => {
    const markup = renderToStaticMarkup(
      <TerminalRuntimeProvider
        automation={false}
        client={client}
        icons={{ TerminalSquare: defaultTerminalIcons.Power }}
        labels={{ newSession: 'Open shell' }}
        portalRoot={null}
        slots={{ dockLeading: 'Host slot' }}
      >
        <RuntimeProbe />
      </TerminalRuntimeProvider>,
    );

    expect(markup).toContain('data-default-power="true"');
    expect(markup).toContain('data-label="Open shell"');
    expect(markup).toContain('data-no-portal="true"');
    expect(markup).toContain('data-overridden-terminal="true"');
    expect(markup).toContain('data-slot="Host slot"');
  });
});
