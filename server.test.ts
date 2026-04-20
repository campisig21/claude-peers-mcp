import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";

// server.test.ts — integration-style tests for the MCP server's poll
// loop + broker interaction. Spawns real broker + real server as
// subprocesses rather than unit-testing pollAndPushMessages in isolation,
// because the blocker this file closes (rawBrokerFetch's 5s abort firing
// against 30s long-poll) was a wiring bug between two layers — exactly
// the class of defect that in-process unit tests can't catch.
//
// Keep this file small and focused on invariants that can ONLY be
// observed at the process boundary. Tests that belong at the broker
// protocol layer go in broker.test.ts.

const TEST_PORT = 17902; // distinct from broker.test.ts's 17899
const TEST_DB = path.join(os.tmpdir(), `claude-peers-server-test-${Date.now()}.db`);
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;
const BROKER_SCRIPT = path.join(import.meta.dir, "broker.ts");
const SERVER_SCRIPT = path.join(import.meta.dir, "server.ts");

let brokerProc: ReturnType<typeof Bun.spawn>;

async function waitForBrokerHealth(timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${BROKER_URL}/health`);
      if (res.ok) return true;
    } catch {
      // not yet up
    }
  }
  return false;
}

async function drainStderr(
  proc: ReturnType<typeof Bun.spawn>,
  ms: number
): Promise<string> {
  // Collect everything the process writes to stderr over `ms` milliseconds.
  // Implementation note: Bun.spawn with `stderr: "pipe"` exposes a stream;
  // we tee it into a string by reading chunks until the collection window
  // elapses OR the stream closes.
  const chunks: Uint8Array[] = [];
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const step = Math.min(remaining, 500);
    const raceResult = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), step)
      ),
    ]);
    if (raceResult.done) continue;
    if (raceResult.value) chunks.push(raceResult.value);
  }
  try { reader.releaseLock(); } catch { /* ok */ }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const ready = await waitForBrokerHealth();
  if (!ready) throw new Error("test broker failed to start");
});

afterAll(async () => {
  brokerProc.kill();
  await brokerProc.exited;
  try { fs.unlinkSync(TEST_DB); } catch { /* ok */ }
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ok */ }
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ok */ }
});

describe("Server long-poll loop", () => {
  // This test directly guards against the blocker caught by codex on PR #2:
  // rawBrokerFetch's 5s AbortSignal.timeout firing against a 30s wait_ms,
  // surfacing as repeated "Poll error" log lines and degrading effective
  // poll cadence to ~6s. We spawn a real server, let it run for 7 seconds
  // (long enough for the 5s abort to trip AT LEAST once if the bug
  // re-emerges), and inspect its stderr.
  test(
    "long-poll does not spuriously abort over a >5s idle window",
    async () => {
      const serverProc = Bun.spawn(["bun", SERVER_SCRIPT], {
        env: {
          ...process.env,
          CLAUDE_PEERS_PORT: String(TEST_PORT),
          // Intentionally clear CLAUDE_PEER_ROLE so this session registers
          // without a role claim — test reproducibility regardless of the
          // developer's shell env.
          CLAUDE_PEER_ROLE: "",
        },
        // stdin: we feed nothing; server's MCP stdio reader just idles.
        // stdout would carry MCP protocol frames; we don't care about
        // them — the invariant under test lives in stderr.
        stdio: ["pipe", "ignore", "pipe"],
      });

      try {
        // Drain stderr for 7 seconds. If the bug is present, we'd see at
        // least one "Poll error" line before this window closes (5s abort
        // + ~2s back into a second poll attempt).
        const stderr = await drainStderr(serverProc, 7000);

        // Sanity: server actually came up and registered.
        expect(stderr).toContain("Registered as peer");

        // The invariant under test. Both phrasings covered:
        // - "Poll error:" is the log prefix server.ts emits on any caught
        //   exception from brokerFetch inside pollAndPushMessages.
        // - "aborted" / "AbortError" catches the specific DOMException
        //   raised by AbortSignal.timeout firing.
        expect(stderr).not.toMatch(/Poll error/);
        expect(stderr).not.toMatch(/AbortError|aborted/i);
      } finally {
        serverProc.kill();
        await serverProc.exited;
      }
    },
    15_000 // bun test per-test timeout: generous buffer on top of the 7s drain
  );
});
