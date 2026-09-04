import { describe, expect, it } from 'vitest';

import { sessionAutomationStatusCopy } from './SessionAutomationControl';
import type { SessionAutomation } from './types';


function status(
  patch: Partial<SessionAutomation> = {},
): SessionAutomation {
  return {
    project_id: 'project-1',
    session_name: 'project-session',
    mode: 'off',
    state: 'idle',
    available: true,
    availability_message: 'OpenClaw planner is ready.',
    provider: 'codex',
    goal: '',
    max_turns: 8,
    max_minutes: 30,
    max_failures: 3,
    send_delay_seconds: 5,
    turns_used: 0,
    no_progress_count: 0,
    pending_send_at: null,
    last_decision: null,
    last_reason: null,
    last_error: null,
    last_learning_error: null,
    warning: null,
    updated_at: null,
    ...patch,
  };
}

describe('sessionAutomationStatusCopy', () => {
  it('distinguishes Learn from Active without implying that Learn can send', () => {
    expect(
      sessionAutomationStatusCopy(
        status({ mode: 'learn', state: 'observing' }),
        null,
      ),
    ).toBe("Building this project's brief");
    expect(
      sessionAutomationStatusCopy(
        status({ mode: 'active', state: 'waiting' }),
        null,
      ),
    ).toBe('Waiting for verified completion');
  });

  it('shows a bounded, visible countdown and user-needed states', () => {
    expect(
      sessionAutomationStatusCopy(
        status({ mode: 'active', state: 'countdown' }),
        4,
      ),
    ).toBe('Sending in 4s');
    expect(
      sessionAutomationStatusCopy(
        status({ mode: 'active', state: 'paused' }),
        null,
      ),
    ).toBe('Waiting for you');
    expect(
      sessionAutomationStatusCopy(
        status({ mode: 'active', state: 'blocked' }),
        null,
      ),
    ).toBe('Blocked — needs you');
  });

  it('surfaces readiness instead of enabling a shell-only session', () => {
    expect(
      sessionAutomationStatusCopy(
        status({
          available: false,
          availability_message: 'Start exactly one Codex or Claude session first.',
        }),
        null,
      ),
    ).toBe('Start exactly one Codex or Claude session first.');
  });

  it('makes a failed project-memory update visible while Learn stays send-free', () => {
    expect(
      sessionAutomationStatusCopy(
        status({
          mode: 'learn',
          state: 'observing',
          last_learning_error: 'openclaw_project_brief_invalid',
        }),
        null,
      ),
    ).toBe('Learning needs attention');
  });
});
