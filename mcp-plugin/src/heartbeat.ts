/**
 * Heartbeat / dead-connection detection — extracted for testability.
 *
 * HeartbeatMonitor sends periodic pings and watches for pong replies.
 * If no pong arrives within `pongTimeout` ms it forces a reconnect.
 */

export interface HeartbeatDeps {
  /** Send a ping message over the wire */
  sendPing: () => void;
  /** Force-close the current connection and reconnect */
  reconnect: () => void;
  /** Current WS ready-state (matches WebSocket.OPEN / CLOSED constants) */
  getReadyState: () => number;
}

/** WebSocket readyState constants (same as the spec) */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export class HeartbeatMonitor {
  private lastPong: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When we first noticed the socket in CONNECTING state */
  private connectingSince: number | null = null;
  /** Guard against overlapping reconnect calls */
  private reconnecting = false;

  public readonly pingInterval: number;
  public readonly pongTimeout: number;
  public readonly connectTimeout: number;

  constructor(
    private deps: HeartbeatDeps,
    /** How often to send a ping (ms) */
    pingInterval: number = 30_000,
    /** Max time without a pong before we consider connection dead (ms) */
    pongTimeout: number = 90_000,
    /** Max time to stay in CONNECTING before forcing retry (ms) */
    connectTimeout: number = 30_000,
  ) {
    this.pingInterval = Number.isFinite(pingInterval) && pingInterval > 0 ? Math.max(1, Math.min(Math.floor(pingInterval), 2_147_483_647)) : 30_000;
    this.pongTimeout = Number.isFinite(pongTimeout) && pongTimeout > 0 ? Math.max(1, Math.min(Math.floor(pongTimeout), 2_147_483_647)) : 90_000;
    this.connectTimeout = Number.isFinite(connectTimeout) && connectTimeout > 0 ? Math.max(1, Math.min(Math.floor(connectTimeout), 2_147_483_647)) : 30_000;
    this.lastPong = Date.now();
  }

  /** Record that a pong (or any alive signal like auth_ok) was received */
  receivedPong() {
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
  }

  /** Start the periodic heartbeat check */
  start() {
    this.stop();
    this.lastPong = Date.now();
    this.connectingSince = null;
    this.reconnecting = false;
    this.timer = setInterval(() => this.tick(), this.pingInterval);
    (this.timer as unknown as { unref?: () => void })?.unref?.();
  }

  /** Stop the heartbeat timer */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reset reconnect guard (call after reconnect completes) */
  resetReconnecting() {
    this.reconnecting = false;
  }

  /** Exposed for testing — runs one heartbeat cycle */
  tick() {
    let state: number;
    try {
      state = this.deps.getReadyState();
    } catch {
      this.connectingSince = null;
      this.safeReconnect("readyState failed");
      return;
    }

    const now = Date.now();
    if (state === WS_OPEN) {
      this.connectingSince = null;
      if (this.lastPong > now) {
        this.lastPong = now;
      }
      if (now - this.lastPong > this.pongTimeout) {
        // No pong in too long — force reconnect
        this.safeReconnect("pong timeout");
        return;
      }
      try {
        this.deps.sendPing();
      } catch {
        this.safeReconnect("ping send failed");
      }
      return;
    }

    if (state === WS_CONNECTING) {
      // Track how long we've been stuck in CONNECTING (recovering from backward NTP jumps)
      if (this.connectingSince === null || this.connectingSince > now) {
        this.connectingSince = now;
      } else if (now - this.connectingSince > this.connectTimeout) {
        // Stuck in CONNECTING too long (server probably still down) — force retry
        this.connectingSince = null;
        this.safeReconnect("connect timeout");
      }
      return;
    }

    // WS_CLOSING or WS_CLOSED — connection is dead or dying
    this.connectingSince = null;
    this.safeReconnect(state === WS_CLOSING ? "stuck closing" : "closed");
  }

  private safeReconnect(reason: string) {
    if (this.reconnecting) return; // already in progress
    this.reconnecting = true;
    try {
      this.deps.reconnect();
    } catch {
      // Never permanently wedge `reconnecting = true` or crash the interval loop if reconnect throws.
      this.reconnecting = false;
    }
  }
}
