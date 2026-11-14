/**
 * Reconnect backoff timing.
 *
 * Exponential-ish delay capped at 30s plus up to 3s of jitter so a fleet of
 * agents doesn't reconnect in a thundering herd. Capping matters: without the
 * min() a long outage would push each successive reconnect unboundedly far out.
 * Extracted from ws.onclose so the cap and jitter bound can be unit-tested.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function safeUnitRand(rand: () => number): number {
  let r: number;
  try {
    r = rand();
  } catch {
    return 0;
  }
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r >= 1 ? 0.999999 : r;
}

export function computeReconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const safeAttempt = typeof attempt === "number" && !Number.isNaN(attempt) ? Math.max(0, attempt) : 0;
  const jitter = safeUnitRand(rand) * 3000; // 0–3s
  return Math.min(safeAttempt * 2, 30) * 1000 + jitter;
}

export function computePleaseReconnectDelay(jitterMs?: unknown, rand: () => number = Math.random): number {
  const maxJitter =
    typeof jitterMs === "number" && Number.isFinite(jitterMs) && jitterMs > 0
      ? Math.min(Math.floor(jitterMs), 10_000)
      : 2_000;
  return 200 + Math.floor(safeUnitRand(rand) * maxJitter);
}

/**
 * Compute jittered reconnect delay for both `please_reconnect` (`jitter_ms`)
 * and `shard_moved` / admin fleet drain (`within_ms` or no field -> [200ms, 2200ms]),
 * avoiding thundering-herd simultaneous reconnects across connected MCP clients.
 */
export function resolveDrainReconnectDelay(
  frame?: { jitter_ms?: unknown; within_ms?: unknown } | null,
  rand: () => number = Math.random,
): number {
  const safeFrame =
    frame && typeof frame === "object" && !Array.isArray(frame) && !Object.prototype.hasOwnProperty.call(frame, "__proto__")
      ? frame
      : null;
  return computePleaseReconnectDelay(safeFrame?.jitter_ms ?? safeFrame?.within_ms, rand);
}

/**
 * Compose an optional caller `AbortSignal` with a bounded `timeoutMs` timer
 * (unref'd so background timers never hold the event loop open). Ensures
 * passing `init.signal` into `apiFetch` never silently disables `timeoutMs`.
 */
export function withTimeoutController(
  parentSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const boundedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS)
      : 0;
  if (boundedTimeoutMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      const err = new Error(`HTTP request timed out after ${boundedTimeoutMs}ms`);
      err.name = "TimeoutError";
      controller.abort(err);
    }, boundedTimeoutMs);
    (timer as any)?.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}
