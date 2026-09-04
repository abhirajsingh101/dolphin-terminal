/**
 * When to give up on a terminal websocket, and when to try again.
 *
 * The pane used to open one websocket per effect run and then wait forever.
 * If the handshake never completed — a slept laptop, a stale SSH tunnel, a
 * moment of packet loss — it sat on CONNECTING with no timeout, no retry, and
 * nothing to click. It recovered only if the TCP connection eventually
 * completed on its own, which is why it looked like "sometimes it takes a
 * while." Measured against a healthy backend the handshake is ~5ms, so a wait
 * of seconds always means the network, never the server thinking.
 *
 * The budget is bounded on purpose. Retrying forever would keep attaching the
 * persistent-session clients to a machine that may genuinely be off; after the budget the pane
 * says so and waits for a click.
 */

/** How long one handshake may take before it is treated as stalled. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Waits between attempts. One per attempt after the first. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export const MAX_CONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length + 1;

/**
 * The wait before the attempt that follows `attempt`, or null once the budget
 * is spent. `attempt` is 1-based: 1 is the first connection.
 */
export function nextConnectDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt >= MAX_CONNECT_ATTEMPTS) return null;
  return RECONNECT_DELAYS_MS[attempt - 1] ?? null;
}

/**
 * Retrying is gated on the socket never having reached OPEN, and that alone is
 * enough to leave real rejections alone. A provider stream calls
 * `accept()` before it validates the project, workspace, or session, so a
 * rejection always arrives as open-then-close-with-1008 — never as a failed
 * connection. Inspecting close codes would add a branch that cannot fire.
 *
 * It also means a connection that was live and then dropped is left alone:
 * deliberately killing a session closes the socket, and reconnecting into that
 * would fight the user.
 */
export function shouldRetryConnection(reachedOpen: boolean): boolean {
  return !reachedOpen;
}

export function reconnectNotice(attempt: number, delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1_000));
  return `Connection stalled. Retrying in ${seconds}s… (attempt ${attempt} of ${MAX_CONNECT_ATTEMPTS})`;
}

/** Shown once the budget is spent. Names the cause, since it is not the app. */
export const OFFLINE_NOTICE =
  'Could not reach the backend. Check the connection to this machine, then retry.';
