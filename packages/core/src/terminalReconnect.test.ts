import { describe, expect, it } from 'vitest';

import {
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_ATTEMPTS,
  RECONNECT_DELAYS_MS,
  nextConnectDelayMs,
  reconnectNotice,
  shouldRetryConnection,
} from './terminalReconnect';

describe('the retry budget', () => {
  it('spends every delay once, in increasing order, then gives up', () => {
    const delays = [1, 2, 3, 4].map(nextConnectDelayMs);
    expect(delays).toEqual([...RECONNECT_DELAYS_MS]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    expect(nextConnectDelayMs(MAX_CONNECT_ATTEMPTS)).toBeNull();
  });

  it('has one delay for every attempt after the first', () => {
    // Otherwise the last attempt is either skipped or waited on forever.
    expect(RECONNECT_DELAYS_MS).toHaveLength(MAX_CONNECT_ATTEMPTS - 1);
  });

  it('gives up past the budget rather than retrying unboundedly', () => {
    expect(nextConnectDelayMs(MAX_CONNECT_ATTEMPTS + 5)).toBeNull();
  });

  /* The point of the whole feature: a stall must be bounded in wall-clock
     time, so the pane cannot sit on CONNECTING indefinitely the way it did. */
  it('bounds the worst case, when every attempt burns the full timeout', () => {
    const waiting = RECONNECT_DELAYS_MS.reduce((total, ms) => total + ms, 0);
    const connecting = CONNECT_TIMEOUT_MS * MAX_CONNECT_ATTEMPTS;
    expect(waiting + connecting).toBeLessThanOrEqual(45_000);
  });

  it('waits long enough that a slow tunnel is not mistaken for a stall', () => {
    // A handshake over a tunnel is tens of milliseconds; anything under a
    // second or two would abort connections that were about to succeed.
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
  });
});

describe('which failures are worth retrying', () => {
  it('retries a connection that never opened', () => {
    // The reported symptom: no 101 ever arrives, so there is nothing to show
    // and nothing to lose by asking again.
    expect(shouldRetryConnection(false)).toBe(true);
  });

  it('leaves a connection that opened and then closed alone', () => {
    /* Two cases land here and both must be left alone. The backend accepts
       before it validates, so a rejected session arrives as open-then-close
       with an error message already written to the pane — retrying would
       repeat a tmux lookup and bury that message. And killing a session
       deliberately closes the socket; reconnecting would fight the user. */
    expect(shouldRetryConnection(true)).toBe(false);
  });
});

describe('what the pane says while it retries', () => {
  it('names the attempt and the wait, so the wait is legible', () => {
    expect(reconnectNotice(2, 4_000)).toBe(
      'Connection stalled. Retrying in 4s… (attempt 2 of 5)',
    );
  });

  it('rounds a sub-second wait up rather than saying 0s', () => {
    expect(reconnectNotice(2, 400)).toContain('Retrying in 1s…');
  });
});
