import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useTerminalRuntime } from './TerminalRuntime.js';
import type {
  ProjectBriefContent,
  SessionAutomation,
  SessionAutomationDetails,
  SessionAutomationMode,
  SessionAutomationState,
} from './types.js';

const MODES: SessionAutomationMode[] = ['off', 'learn', 'active'];
const MODE_LABEL: Record<SessionAutomationMode, string> = {
  off: 'Off',
  learn: 'Learn',
  active: 'Active',
};
const EMPTY_BRIEF: ProjectBriefContent = {
  purpose: '',
  user_intent: '',
  direction: '',
  goals: [],
  working_preferences: [],
  success_signals: [],
  boundaries: [],
};
type AutomationPanelTab = 'settings' | 'memory' | 'activity';

export function sessionAutomationStatusCopy(
  status: SessionAutomation,
  seconds: number | null,
): string {
  if (!status.available && status.mode === 'off') return status.availability_message;
  if (status.last_learning_error) return 'Learning needs attention';
  if (status.state === 'thinking') {
    return status.mode === 'learn' ? 'Updating project brief…' : 'Thinking…';
  }
  if (status.state === 'countdown') {
    return `Sending in ${Math.max(0, seconds ?? 0)}s`;
  }
  if (status.state === 'sending') return 'Sending…';
  if (status.state === 'blocked') return 'Blocked — needs you';
  if (status.state === 'error') return 'Automation paused';
  if (status.state === 'paused') return 'Waiting for you';
  if (status.mode === 'learn') return "Building this project's brief";
  if (status.mode === 'active') return 'Waiting for verified completion';
  return 'Off';
}

function eventLabel(kind: string): string {
  return kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function lines(value: string[]): string {
  return value.join('\n');
}

function lineItems(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sourceStatusLabel(status: SessionAutomationDetails['source_context_status']): string {
  if (status === 'ready') return 'Current';
  if (status === 'stale') return 'Refresh needed';
  if (status === 'refreshing') return 'Refreshing';
  if (status === 'error') return 'Needs attention';
  return 'Not initialized';
}

function StatusIcon({ state }: { state: SessionAutomationState }) {
  const {
    icons: { CirclePause, LoaderCircle, Timer, TriangleAlert },
  } = useTerminalRuntime();
  if (state === 'thinking') {
    return <LoaderCircle aria-hidden="true" className="terminal-automation-spin" size={12} />;
  }
  if (state === 'countdown') return <Timer aria-hidden="true" size={12} />;
  if (state === 'paused') return <CirclePause aria-hidden="true" size={12} />;
  if (state === 'blocked' || state === 'error') {
    return <TriangleAlert aria-hidden="true" size={12} />;
  }
  return null;
}

function popoverPosition(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(540, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const estimatedHeight = 640;
  const below = rect.bottom + 8;
  const top =
    below + estimatedHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - estimatedHeight - 8);
  return {
    left,
    top,
    width,
    maxHeight: Math.max(240, window.innerHeight - top - 8),
  };
}

export interface SessionAutomationControlProps {
  projectId: string;
  sessionName: string;
}

export default function SessionAutomationControl({
  projectId,
  sessionName,
}: SessionAutomationControlProps) {
  const {
    client,
    icons: { Brain, History, OctagonX, RefreshCw, Settings2 },
    labels,
    portalRoot,
  } = useTerminalRuntime();
  const cancelSessionAutomation = client.cancelAutomation.bind(client);
  const fetchSessionAutomationDetails =
    client.fetchAutomationDetails.bind(client);
  const fetchSessionAutomation = client.fetchAutomation.bind(client);
  const refreshProjectAutomationSourceContext =
    client.refreshAutomationSourceContext.bind(client);
  const stopAllSessionAutomation = client.stopAllAutomation.bind(client);
  const updateProjectAutomationBrief = client.updateProjectBrief.bind(client);
  const updateSessionAutomation = client.updateAutomation.bind(client);
  const groupLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLFormElement>(null);
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [status, setStatus] = useState<SessionAutomation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const [goal, setGoal] = useState('');
  const [maxTurns, setMaxTurns] = useState(8);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [maxFailures, setMaxFailures] = useState(3);
  const [sendDelaySeconds, setSendDelaySeconds] = useState(5);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<AutomationPanelTab>('settings');
  const [details, setDetails] = useState<SessionAutomationDetails | null>(null);
  const [briefDraft, setBriefDraft] = useState<ProjectBriefContent>(EMPTY_BRIEF);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [briefSaved, setBriefSaved] = useState(false);
  const [globalStopArmed, setGlobalStopArmed] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await fetchSessionAutomation(projectId, sessionName, signal);
      setStatus(next);
      setError(null);
      return next;
    },
    [projectId, sessionName],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error ? reason.message : 'Automation status is unavailable.',
      );
    });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, status?.mode === 'off' ? 10_000 : 2_000);
    return () => window.clearInterval(interval);
  }, [refresh, status?.mode]);

  useEffect(() => {
    if (!status?.pending_send_at) {
      setCountdownSeconds(null);
      return;
    }
    const update = () => {
      setCountdownSeconds(
        Math.max(
          0,
          Math.ceil((new Date(status.pending_send_at!).getTime() - Date.now()) / 1000),
        ),
      );
    };
    update();
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [status?.pending_send_at]);

  const updatePosition = useCallback(() => {
    if (triggerRef.current) setPopoverStyle(popoverPosition(triggerRef.current));
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    updatePosition();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPopoverOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || popoverRef.current?.contains(target)) return;
      setPopoverOpen(false);
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [popoverOpen, updatePosition]);

  const loadDetails = useCallback(async () => {
    setDetailsBusy(true);
    try {
      const next = await fetchSessionAutomationDetails(projectId, sessionName);
      setDetails(next);
      setBriefDraft({
        purpose: next.brief.purpose,
        user_intent: next.brief.user_intent,
        direction: next.brief.direction,
        goals: next.brief.goals,
        working_preferences: next.brief.working_preferences,
        success_signals: next.brief.success_signals,
        boundaries: next.brief.boundaries,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Automation details are unavailable.');
    } finally {
      setDetailsBusy(false);
    }
  }, [projectId, sessionName]);

  function openSettings() {
    setGoal(status?.goal ?? '');
    setMaxTurns(status?.max_turns ?? 8);
    setMaxMinutes(status?.max_minutes ?? 30);
    setMaxFailures(status?.max_failures ?? 3);
    setSendDelaySeconds(status?.send_delay_seconds ?? 5);
    setError(null);
    setPanelTab('settings');
    setBriefSaved(false);
    setGlobalStopArmed(false);
    setPopoverOpen(true);
    void loadDetails();
    window.requestAnimationFrame(updatePosition);
  }

  async function saveBrief() {
    if (detailsBusy || busy) return;
    setDetailsBusy(true);
    setError(null);
    try {
      const brief = await updateProjectAutomationBrief(
        projectId,
        sessionName,
        briefDraft,
      );
      setDetails((current) => current ? { ...current, brief } : current);
      setBriefSaved(true);
      window.setTimeout(() => setBriefSaved(false), 2_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Project memory could not be saved.');
    } finally {
      setDetailsBusy(false);
    }
  }

  async function refreshSourceContext() {
    if (detailsBusy || busy) return;
    setDetailsBusy(true);
    setError(null);
    try {
      await refreshProjectAutomationSourceContext(projectId, sessionName);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const next = await fetchSessionAutomationDetails(projectId, sessionName);
        setDetails(next);
        if (next.source_context_status !== 'refreshing') break;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Project source context could not be refreshed.',
      );
    } finally {
      setDetailsBusy(false);
    }
  }

  async function stopEverything() {
    if (!globalStopArmed) {
      setGlobalStopArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stopAllSessionAutomation();
      await refresh();
      setGlobalStopArmed(false);
      setPopoverOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Global automation stop failed.');
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(mode: SessionAutomationMode) {
    if (busy || mode === status?.mode) return;
    if (mode === 'active' && !status?.goal.trim()) {
      openSettings();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await updateSessionAutomation(projectId, sessionName, {
        mode,
        goal: status?.goal ?? '',
        max_turns: status?.max_turns ?? 8,
        max_minutes: status?.max_minutes ?? 30,
        max_failures: status?.max_failures ?? 3,
        send_delay_seconds: status?.send_delay_seconds ?? 5,
      });
      setStatus(next);
      setPopoverOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Automation mode could not change.');
    } finally {
      setBusy(false);
    }
  }

  async function startActive(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updateSessionAutomation(projectId, sessionName, {
        mode: 'active',
        goal,
        max_turns: maxTurns,
        max_minutes: maxMinutes,
        max_failures: maxFailures,
        send_delay_seconds: sendDelaySeconds,
      });
      setStatus(next);
      setPopoverOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Active mode could not start. Review the settings and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelPending() {
    if (busy) return;
    setBusy(true);
    try {
      await cancelSessionAutomation(projectId, sessionName);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Pending automation could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  function handleSegmentKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index + MODES.length - 1) % MODES.length;
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % MODES.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = MODES.length - 1;
    else return;
    event.preventDefault();
    segmentRefs.current[nextIndex]?.focus();
  }

  const compactStatus = useMemo(
    () =>
      status
        ? sessionAutomationStatusCopy(status, countdownSeconds)
        : 'Loading automation…',
    [countdownSeconds, status],
  );
  const selectedMode = status?.mode ?? 'off';
  const pending = status?.state === 'countdown' || status?.state === 'sending';
  const showStatus =
    busy ||
    Boolean(status?.last_learning_error) ||
    status === null ||
    status.state === 'thinking' ||
    status.state === 'countdown' ||
    status.state === 'sending' ||
    status.state === 'paused' ||
    status.state === 'blocked' ||
    status.state === 'error';

  return (
    <div
      className={`terminal-automation terminal-automation--${selectedMode}`}
      title={status?.last_reason ?? status?.availability_message ?? compactStatus}
    >
      <span className="sr-only" id={groupLabelId}>
        Automation mode for {sessionName}
      </span>
      <div
        aria-labelledby={groupLabelId}
        className="terminal-automation-segments"
        role="group"
      >
        {MODES.map((mode, index) => (
          <button
            aria-pressed={selectedMode === mode}
            className={selectedMode === mode ? 'selected' : ''}
            disabled={
              busy ||
              (mode !== 'off' && (status === null || !status.available))
            }
            key={mode}
            onClick={() => void changeMode(mode)}
            onKeyDown={(event) => handleSegmentKeyDown(event, index)}
            ref={(node) => {
              segmentRefs.current[index] = node;
              if (mode === 'active') triggerRef.current = node;
            }}
            tabIndex={selectedMode === mode ? 0 : -1}
            type="button"
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>

      <span
        aria-live="polite"
        className={`terminal-automation-status terminal-automation-status--${status?.last_learning_error ? 'error' : status?.state ?? 'idle'}${
          showStatus ? '' : ' terminal-automation-status--quiet'
        }`}
        role="status"
        title={status?.last_reason ?? status?.availability_message ?? compactStatus}
      >
        {status ? <StatusIcon state={status.state} /> : null}
        <span>{busy ? 'Changing…' : compactStatus}</span>
      </span>

      {pending ? (
        <button
          className="terminal-automation-cancel"
          disabled={busy}
          onClick={() => void cancelPending()}
          type="button"
        >
          Cancel Send
        </button>
      ) : null}

      {status ? (
        <button
          aria-label="Review Automation Settings"
          className="terminal-automation-settings"
          disabled={busy}
          onClick={openSettings}
          title="Review Automation Settings"
          type="button"
        >
          <Settings2 aria-hidden="true" size={14} />
        </button>
      ) : null}

      {error ? (
        <span className="terminal-automation-alert" role="alert" title={error}>
          {error}
        </span>
      ) : null}

      {popoverOpen &&
        createPortal(
          <form
            aria-label="Automation settings"
            className="terminal-automation-popover"
            onSubmit={(event) => {
              if (panelTab === 'settings') void startActive(event);
              else {
                event.preventDefault();
                if (panelTab === 'memory') void saveBrief();
              }
            }}
            ref={popoverRef}
            style={popoverStyle}
          >
            <div className="terminal-automation-popover-heading">
              <div>
                <strong>{status?.goal ? 'Automation control' : 'Set up automation'}</strong>
                <span>{status?.provider ? `OpenClaw planner · ${status.provider}` : 'OpenClaw planner'}</span>
              </div>
              <span className={`terminal-automation-mode-pill is-${selectedMode}`}>
                {MODE_LABEL[selectedMode]}
              </span>
            </div>
            <div aria-label="Automation sections" className="terminal-automation-panel-tabs" role="tablist">
              <button
                aria-selected={panelTab === 'settings'}
                onClick={() => setPanelTab('settings')}
                role="tab"
                type="button"
              >
                <Settings2 aria-hidden="true" size={13} /> Settings
              </button>
              <button
                aria-selected={panelTab === 'memory'}
                onClick={() => setPanelTab('memory')}
                role="tab"
                type="button"
              >
                <Brain aria-hidden="true" size={13} /> Project Memory
              </button>
              <button
                aria-selected={panelTab === 'activity'}
                onClick={() => setPanelTab('activity')}
                role="tab"
                type="button"
              >
                <History aria-hidden="true" size={13} /> Activity
              </button>
            </div>

            {panelTab === 'settings' ? (
              <div className="terminal-automation-panel" role="tabpanel">
                <p>
                  Active can continue authorized local implementation, tests,
                  diagnostics, and documentation. Consequential or unclear work pauses.
                </p>
                <label>
                  <span>Goal for this {labels.session}</span>
                  <textarea
                    autoFocus
                    maxLength={2_000}
                    onChange={(event) => setGoal(event.target.value)}
                    placeholder="What should this session finish?"
                    required
                    rows={3}
                    value={goal}
                  />
                </label>
                <div className="terminal-automation-budget-grid">
                  <label>
                    <span>Autonomous turns</span>
                    <input
                      max={100}
                      min={1}
                      onChange={(event) => setMaxTurns(Number(event.target.value))}
                      required
                      type="number"
                      value={maxTurns}
                    />
                  </label>
                  <label>
                    <span>Elapsed time</span>
                    <span className="terminal-automation-number-with-unit">
                      <input
                        max={1_440}
                        min={1}
                        onChange={(event) => setMaxMinutes(Number(event.target.value))}
                        required
                        type="number"
                        value={maxMinutes}
                      />
                      min
                    </span>
                  </label>
                  <label>
                    <span>No-progress limit</span>
                    <input
                      max={10}
                      min={1}
                      onChange={(event) => setMaxFailures(Number(event.target.value))}
                      required
                      type="number"
                      value={maxFailures}
                    />
                  </label>
                  <label>
                    <span>Review delay</span>
                    <span className="terminal-automation-number-with-unit">
                      <input
                        max={30}
                        min={3}
                        onChange={(event) => setSendDelaySeconds(Number(event.target.value))}
                        required
                        type="number"
                        value={sendDelaySeconds}
                      />
                      sec
                    </span>
                  </label>
                </div>
                {status?.mode === 'active' ? (
                  <div className="terminal-automation-usage">
                    <span>{status.turns_used} / {status.max_turns} turns used</span>
                    <span>{status.no_progress_count} no-progress turns</span>
                  </div>
                ) : null}
                <p className="terminal-automation-boundary">
                  Typing in the terminal, changing the target, or choosing Off
                  cancels pending automation immediately.
                </p>
                <div className="terminal-automation-popover-actions">
                  <button disabled={busy || !goal.trim()} type="submit">
                    {busy
                      ? 'Starting…'
                      : status?.mode === 'active'
                        ? 'Save & Restart Limits'
                        : 'Start Active'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void stopEverything()}
                    className={globalStopArmed ? 'is-danger-armed' : 'is-danger'}
                    type="button"
                  >
                    <OctagonX aria-hidden="true" size={13} />
                    {globalStopArmed ? 'Confirm stop everywhere' : 'Stop all automation'}
                  </button>
                </div>
              </div>
            ) : null}

            {panelTab === 'memory' ? (
              <div className="terminal-automation-panel terminal-automation-memory" role="tabpanel">
                <section className="terminal-automation-source-context" aria-labelledby="project-source-context-heading">
                  <div className="terminal-automation-source-heading">
                    <div>
                      <strong id="project-source-context-heading">Project source context</strong>
                      <span>{details?.source_context_message ?? 'Loading selected project sources…'}</span>
                    </div>
                    <span className={`is-${details?.source_context_status ?? 'refreshing'}`}>
                      {details
                        ? sourceStatusLabel(details.source_context_status)
                        : 'Loading'}
                    </span>
                  </div>
                  {details?.source_context ? (
                    <div className="terminal-automation-source-summary">
                      {details.source_context.purpose ? (
                        <p><strong>Purpose</strong>{details.source_context.purpose}</p>
                      ) : null}
                      {details.source_context.user_intent ? (
                        <p><strong>User intent</strong>{details.source_context.user_intent}</p>
                      ) : null}
                      {details.source_context.direction ? (
                        <p><strong>Direction</strong>{details.source_context.direction}</p>
                      ) : null}
                      {details.source_context.goals.length ? (
                        <div>
                          <strong>Goals</strong>
                          <ul>{details.source_context.goals.map((goal) => <li key={goal}>{goal}</li>)}</ul>
                        </div>
                      ) : null}
                      {details.source_context.working_preferences.length ? (
                        <div>
                          <strong>Working preferences</strong>
                          <ul>{details.source_context.working_preferences.map((preference) => <li key={preference}>{preference}</li>)}</ul>
                        </div>
                      ) : null}
                      {details.source_context.success_signals.length ? (
                        <div>
                          <strong>Success signals</strong>
                          <ul>{details.source_context.success_signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
                        </div>
                      ) : null}
                      {details.source_context.boundaries.length ? (
                        <div>
                          <strong>Boundaries</strong>
                          <ul>{details.source_context.boundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}</ul>
                        </div>
                      ) : null}
                      <div className="terminal-automation-source-files" aria-label="Project context sources">
                        {details.source_context.sources.map((source) => (
                          <span key={source.path} title={`${source.role} · ${source.sha256}`}>
                            {source.path}
                          </span>
                        ))}
                      </div>
                      {details.source_context.conflicts.length ? (
                        <div className="terminal-automation-source-conflicts">
                          <strong>Conflicts to review</strong>
                          <ul>{details.source_context.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="terminal-automation-source-empty">
                      Dolphin will derive a bounded baseline from named project documents without storing their raw text.
                    </p>
                  )}
                  <button
                    className="terminal-automation-source-refresh"
                    disabled={detailsBusy || status?.mode === 'off'}
                    onClick={() => void refreshSourceContext()}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={13} />
                    {details?.source_context ? 'Refresh from Project' : 'Initialize from Project'}
                  </button>
                </section>
                <div className="terminal-automation-panel-intro">
                  <p>
                    Learned memory is shared by this project's sessions. Learn
                    refines human intent and preferences; your edits are authoritative.
                  </p>
                  <span>Revision {details?.brief.revision ?? 0} · {details?.brief.evidence_count ?? 0} evidence updates</span>
                </div>
                <label>
                  <span>Project purpose</span>
                  <textarea
                    maxLength={600}
                    onChange={(event) => setBriefDraft((current) => ({ ...current, purpose: event.target.value }))}
                    placeholder="What is this project?"
                    rows={2}
                    value={briefDraft.purpose}
                  />
                </label>
                <label>
                  <span>Your intent</span>
                  <textarea
                    maxLength={600}
                    onChange={(event) => setBriefDraft((current) => ({ ...current, user_intent: event.target.value }))}
                    placeholder="What do you want from it?"
                    rows={2}
                    value={briefDraft.user_intent}
                  />
                </label>
                <label>
                  <span>Direction</span>
                  <textarea
                    maxLength={600}
                    onChange={(event) => setBriefDraft((current) => ({ ...current, direction: event.target.value }))}
                    placeholder="Where should the project go?"
                    rows={2}
                    value={briefDraft.direction}
                  />
                </label>
                <div className="terminal-automation-memory-grid">
                  {([
                    ['goals', 'Goals', 'One durable goal per line'],
                    ['working_preferences', 'Working preferences', 'One preference per line'],
                    ['success_signals', 'Success signals', 'One success signal per line'],
                    ['boundaries', 'Boundaries', 'One non-negotiable boundary per line'],
                  ] as const).map(([field, label, placeholder]) => (
                    <label key={field}>
                      <span>{label}</span>
                      <textarea
                        onChange={(event) => setBriefDraft((current) => ({ ...current, [field]: lineItems(event.target.value) }))}
                        placeholder={placeholder}
                        rows={3}
                        value={lines(briefDraft[field])}
                      />
                    </label>
                  ))}
                </div>
                <p className="terminal-automation-boundary">
                  Memory guides planning but never grants permission or overrides your goal.
                </p>
                <div className="terminal-automation-popover-actions">
                  <button disabled={detailsBusy} onClick={() => void saveBrief()} type="button">
                    {detailsBusy ? 'Saving…' : briefSaved ? 'Saved' : 'Save Project Memory'}
                  </button>
                  <button disabled={detailsBusy} onClick={() => void loadDetails()} type="button">
                    Reset edits
                  </button>
                </div>
              </div>
            ) : null}

            {panelTab === 'activity' ? (
              <div className="terminal-automation-panel" role="tabpanel">
                <div className="terminal-automation-panel-intro">
                  <p>Privacy-safe decisions, cancellations, and sends for this exact session.</p>
                  <button disabled={detailsBusy} onClick={() => void loadDetails()} type="button">
                    Refresh
                  </button>
                </div>
                <div className="terminal-automation-timeline">
                  {detailsBusy && !details ? <p>Loading activity…</p> : null}
                  {!detailsBusy && details?.events.length === 0 ? (
                    <p>No automation activity yet.</p>
                  ) : null}
                  {details?.events.map((item, index) => (
                    <div className={`terminal-automation-event is-${item.status}`} key={`${item.created_at}-${item.kind}-${index}`}>
                      <span className="terminal-automation-event-dot" />
                      <div>
                        <strong>{eventLabel(item.kind)}</strong>
                        <span>{new Date(item.created_at).toLocaleString()}</span>
                        {item.decision ? <em>{eventLabel(item.decision)}</em> : null}
                        {item.reason ? <p>{item.reason}</p> : null}
                        {item.error_code ? <code>{item.error_code}</code> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {error ? <p className="terminal-automation-form-error" role="alert">{error}</p> : null}
            <button
              className="terminal-automation-popover-close"
              disabled={busy}
              onClick={() => {
                setPopoverOpen(false);
                window.requestAnimationFrame(() => triggerRef.current?.focus());
              }}
              type="button"
            >
              Close
            </button>
          </form>,
          portalRoot ?? document.body,
        )}
    </div>
  );
}
