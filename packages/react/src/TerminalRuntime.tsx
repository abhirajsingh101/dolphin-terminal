import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

import type {
  DictationTarget,
  TerminalDictationBridge,
  TerminalRuntimeOptions,
  TerminalTarget,
  TerminalRuntimeLabels,
} from '@dolphin-terminal/protocol';
import {
  defaultTerminalIcons,
  type TerminalIconRegistry,
  type TerminalRuntimeSlots,
} from './customization.js';

export interface TerminalRuntimeProviderProps extends TerminalRuntimeOptions {
  children: ReactNode;
  icons?: Partial<TerminalIconRegistry>;
  portalRoot?: HTMLElement | null;
  slots?: TerminalRuntimeSlots;
}

const noopDictation: TerminalDictationBridge = {
  activateTarget(_target: DictationTarget) {},
  clearTarget(_targetId: string) {},
};

export interface TerminalRuntimeValue extends TerminalRuntimeOptions {
  dictation: TerminalDictationBridge;
  targetHref: (target: TerminalTarget) => string;
  storage?: Storage;
  storageKey: string;
  legacyStorageKey: string;
  legacyMigrationKey: string;
  automation: boolean;
  icons: TerminalIconRegistry;
  labels: TerminalRuntimeLabels;
  portalRoot: HTMLElement | null;
  slots: TerminalRuntimeSlots;
}

const TerminalRuntimeContext = createContext<TerminalRuntimeValue | null>(null);

const defaultLabels: TerminalRuntimeLabels = {
  session: 'session',
  sessions: 'sessions',
  newSession: 'New session',
  persistentEngine: 'session backend',
};

function defaultTargetHref(target: TerminalTarget): string {
  if (typeof window === 'undefined') return '#';
  const url = new URL(window.location.href);
  url.searchParams.set('workspace', target.projectId);
  url.searchParams.set('session', target.sessionName);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function TerminalRuntimeProvider({
  children,
  ...options
}: TerminalRuntimeProviderProps) {
  const value = useMemo<TerminalRuntimeValue>(
    () => ({
      ...options,
      dictation: options.dictation ?? noopDictation,
      targetHref: options.targetHref ?? defaultTargetHref,
      storage:
        options.storage ??
        (typeof window === 'undefined' ? undefined : window.sessionStorage),
      storageKey: options.storageKey ?? 'dolphin.terminal.workspace.tab.v2',
      legacyStorageKey:
        options.legacyStorageKey ?? 'dolphin.terminal.workspace.v1',
      legacyMigrationKey:
        options.legacyMigrationKey ??
        'dolphin.terminal.workspace.tab-migration.v2',
      automation: options.automation ?? true,
      icons: { ...defaultTerminalIcons, ...options.icons },
      labels: { ...defaultLabels, ...options.labels },
      portalRoot:
        options.portalRoot === undefined
          ? typeof document === 'undefined'
            ? null
            : document.body
          : options.portalRoot,
      slots: options.slots ?? {},
    }),
    [options],
  );

  return (
    <TerminalRuntimeContext.Provider value={value}>
      {children}
    </TerminalRuntimeContext.Provider>
  );
}

export function useTerminalRuntime(): TerminalRuntimeValue {
  const runtime = useContext(TerminalRuntimeContext);
  if (!runtime) {
    throw new Error('Dolphin Terminal must be wrapped in TerminalRuntimeProvider.');
  }
  return runtime;
}
