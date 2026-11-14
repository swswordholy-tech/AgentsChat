import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("cli.mjs --supervise lifecycle hygiene", () => {
  test("SIGTERM interrupts a long backoff sleep immediately instead of hanging up to 30s", async () => {
    const cliPath = resolve(import.meta.dir, "../src/cli.mjs");
    // Child runs --connector with invalid RELAY_IDENTITIES so the child exits immediately,
    // putting the parent supervisor straight into a 20s backoff sleep.
    const proc = Bun.spawn([process.execPath, cliPath, "--supervise", "--connector"], {
      env: {
        ...process.env,
        RELAY_IDENTITIES: "not-json",
        AGENTCHAT_SUPERVISE_INITIAL_DELAY_MS: "20000",
        AGENTCHAT_SUPERVISE_MAX_DELAY_MS: "30000",
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuf = "";
    const enteredSleep = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return false;
          stderrBuf += decoder.decode(value, { stream: true });
          if (stderrBuf.includes("supervise: restarting after exit")) return true;
        }
      })(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    expect(enteredSleep).toBe(true);

    const t0 = Date.now();
    proc.kill("SIGTERM");
    await proc.exited;
    const elapsedMs = Date.now() - t0;
    // Must exit promptly (< 2000ms), never waiting out the 20,000ms backoff sleep!
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("Campaign #106 KR3: clamps >2^31-1 delay overflow, handles SIGHUP, and skips supervision on one-shot flags", async () => {
    const cliPath = resolve(import.meta.dir, "../src/cli.mjs");

    // 1. One-shot `--register-only` (missing --name -> exits non-zero) with AGENTCHAT_WAKE_SUPERVISE=1
    //    must exit once immediately instead of entering an infinite `supervise: restarting` loop!
    const oneShotProc = Bun.spawn([process.execPath, cliPath, "--register-only"], {
      env: {
        ...process.env,
        AGENTCHAT_WAKE_SUPERVISE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const oneShotCode = await oneShotProc.exited;
    const oneShotStderr = await new Response(oneShotProc.stderr).text();
    expect(typeof oneShotCode).toBe("number");
    expect(oneShotStderr).not.toContain("supervise: restarting");

    // 2. Overflowing 32-bit delay (`999999999999`) clamps to 2^31-1 instead of firing in 1ms fork-storm,
    //    and SIGHUP (or SIGTERM on Windows) cleanly interrupts the sleep!
    const supProc = Bun.spawn([process.execPath, cliPath, "--supervise", "--connector"], {
      env: {
        ...process.env,
        RELAY_IDENTITIES: "not-json",
        AGENTCHAT_SUPERVISE_INITIAL_DELAY_MS: "999999999999",
        AGENTCHAT_SUPERVISE_MAX_DELAY_MS: "999999999999",
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    const reader = supProc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuf = "";
    const enteredFirstSleep = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return false;
          stderrBuf += decoder.decode(value, { stream: true });
          if (stderrBuf.includes("supervise: restarting after exit")) return true;
        }
      })(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    expect(enteredFirstSleep).toBe(true);

    // Wait 120ms: if 32-bit overflow occurred (1ms timer), it would have spawned dozens of restarts!
    await new Promise((r) => setTimeout(r, 120));
    const sig = process.platform === "win32" ? "SIGTERM" : "SIGHUP";
    supProc.kill(sig);
    await supProc.exited;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrBuf += decoder.decode(value, { stream: true });
    }
    const restartMatches = stderrBuf.match(/supervise: restarting after exit/g) ?? [];
    expect(restartMatches.length).toBe(1);
  });

  test("Campaign #121 KR3: supervisor enforces AGENTCHAT_SUPERVISE_STOP_GRACE_MS on running child and rejects multi-mode flags", async () => {
    const cliPath = resolve(import.meta.dir, "../src/cli.mjs");
    const conflictProc = Bun.spawn([process.execPath, cliPath, "--connector", "--muse"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await conflictProc.exited).not.toBe(0);

    // Spawn a live supervised connector on port 0 (random ephemeral port) and stop it with short grace window
    const liveProc = Bun.spawn([process.execPath, cliPath, "--supervise", "--connector"], {
      env: {
        ...process.env,
        RELAY_PORT: "0",
        RELAY_HOST: "127.0.0.1",
        AGENTCHAT_API_URL: "http://127.0.0.1:9",
        AGENTCHAT_WS_URL: "ws://127.0.0.1:9/ws",
        AGENTCHAT_AGENT_ID: "bot-sup-test",
        AGENTCHAT_TOKEN: "ac_test_token_1234567890",
        RELAY_GATEWAY_ID: "gw-sup-test",
        RELAY_GATEWAY_SECRET: "secret_1234567890abcdef",
        AGENTCHAT_SUPERVISE_STOP_GRACE_MS: "80",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    liveProc.kill("SIGTERM");
    await liveProc.exited;
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
