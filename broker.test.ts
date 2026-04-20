import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import path from "path";
import os from "os";
import fs from "fs";
import type { PollMessagesResponse } from "./shared/types.ts";

const TEST_PORT = 17899;
const TEST_DB = path.join(os.tmpdir(), `claude-peers-test-${Date.now()}.db`);
const TEST_HOME = path.join(os.tmpdir(), `claude-peers-test-home-${Date.now()}`);
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;
const BROKER_SCRIPT = path.join(import.meta.dir, "broker.ts");

let brokerProc: ReturnType<typeof Bun.spawn>;

// Keep track of all spawned sleeper processes so we can kill them on cleanup
const sleeperProcs: ReturnType<typeof Bun.spawn>[] = [];

// ---- Helpers ----

/**
 * Spawn a long-running sleep process and return its PID.
 * This gives us a real, live PID that passes the broker's liveness check.
 */
function spawnSleeper(): { proc: ReturnType<typeof Bun.spawn>; pid: number } {
  const proc = Bun.spawn(["sleep", "3600"], { stdio: ["ignore", "ignore", "ignore"] });
  sleeperProcs.push(proc);
  return { proc, pid: proc.pid };
}

async function brokerFetch<T>(urlPath: string, body?: unknown): Promise<{ status: number; data: T }> {
  if (body === undefined) {
    const res = await fetch(`${BROKER_URL}${urlPath}`);
    return { status: res.status, data: await res.json() as T };
  }
  const res = await fetch(`${BROKER_URL}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as T };
}

/**
 * Register a peer with the broker using a real live PID.
 * Returns the peer ID and the sleeper process for cleanup.
 */
async function registerPeer(overrides: {
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  role?: string;
} = {}): Promise<{ id: string; proc: ReturnType<typeof Bun.spawn> }> {
  const { proc, pid } = spawnSleeper();
  const { data } = await brokerFetch<{ id: string }>("/register", {
    pid,
    cwd: "/tmp/test",
    git_root: null,
    tty: null,
    summary: "",
    ...overrides,
  });
  return { id: data.id, proc };
}

/**
 * Kill a sleeper process (simulates the peer dying without calling /unregister).
 */
async function killPeer(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill();
  await proc.exited;
}

// ---- Setup / Teardown ----

beforeAll(async () => {
  brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_HOME: TEST_HOME,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for broker to be ready (up to 6s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${BROKER_URL}/health`);
      if (res.ok) break;
    } catch {
      // not yet up
    }
  }
});

afterAll(async () => {
  // Kill all sleeper processes
  for (const proc of sleeperProcs) {
    try { proc.kill(); } catch {}
  }

  brokerProc.kill();
  await brokerProc.exited;
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

// ---- Health endpoint ----

describe("Health endpoint", () => {
  test("GET /health returns status ok with a version field", async () => {
    const res = await fetch(`${BROKER_URL}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { status: string; version: string; peers: number };
    expect(data.status).toBe("ok");
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
  });
});

// ---- Registration ----

describe("Registration", () => {
  test("POST /register returns a peer ID", async () => {
    const { proc, pid } = spawnSleeper();
    const { data, status } = await brokerFetch<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/reg-basic",
      git_root: null,
      tty: null,
      summary: "",
    });
    expect(status).toBe(200);
    expect(typeof data.id).toBe("string");
    expect(data.id.length).toBeGreaterThan(0);
    await brokerFetch("/unregister", { id: data.id });
    await killPeer(proc);
  });

  test("registering with a role creates a role-bound peer", async () => {
    const { id, proc } = await registerPeer({
      cwd: "/tmp/role-test",
      role: "reg-role-test-" + Date.now(),
    });

    const { data: peers } = await brokerFetch<{ id: string; role: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp/role-test",
      git_root: null,
    });
    const found = peers.find((p) => p.id === id);
    expect(found).toBeDefined();
    expect(found?.role).toMatch(/^reg-role-test-/);

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });

  test("re-registering the same PID marks the old peer dead", async () => {
    const { proc: proc1, pid } = spawnSleeper();

    // First registration
    const { data: first } = await brokerFetch<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/rereg",
      git_root: null,
      tty: null,
      summary: "first",
    });

    // Kill the first process, spawn a new one, reuse the SAME PID is not
    // possible with real OS processes. Instead we kill proc1 then re-register
    // with a fresh sleeper that happens to be alive — but we need to manually
    // trigger the re-register path by using same pid (which only works if the
    // process for that pid is dead OR still running).
    //
    // The broker marks the OLD active row dead when a NEW registration arrives
    // with the same PID regardless of liveness. So we can pass the same pid
    // a second time without killing proc1 — the broker will mark first.id dead
    // and create a fresh row for the second.
    const { data: second } = await brokerFetch<{ id: string }>("/register", {
      pid,
      cwd: "/tmp/rereg",
      git_root: null,
      tty: null,
      summary: "second",
    });

    expect(typeof second.id).toBe("string");
    // The new id should be different from the old one (new peer was created)
    expect(second.id).not.toBe(first.id);

    // The first ID should no longer appear in list-peers (it's dead)
    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    expect(peers.map((p) => p.id)).not.toContain(first.id);

    await brokerFetch("/unregister", { id: second.id });
    await killPeer(proc1);
  });

  test("role conflict: registering with a role held by another active peer errors", async () => {
    const conflictRole = "conflict-role-" + Date.now();
    const { id: idA, proc: procA } = await registerPeer({ role: conflictRole });

    const { proc: procB, pid: pidB } = spawnSleeper();
    const { status, data: errData } = await brokerFetch<{ error: string }>("/register", {
      pid: pidB,
      cwd: "/tmp/conflict",
      git_root: null,
      tty: null,
      summary: "",
      role: conflictRole,
    });
    expect(status).toBe(500);
    expect(errData.error).toMatch(conflictRole);

    await brokerFetch("/unregister", { id: idA });
    await killPeer(procA);
    await killPeer(procB);
  });
});

// ---- Role-based ID persistence ----

describe("Role-based ID persistence", () => {
  test("dead peer's role ID is reused when new session claims the same role", async () => {
    const testRole = "persist-role-" + Date.now();

    // Register peer A with the role
    const { id: originalId, proc: procA } = await registerPeer({ role: testRole });

    // Kill the process and unregister (mark dead)
    await killPeer(procA);
    await brokerFetch("/unregister", { id: originalId });

    // Register peer B with the same role
    const { id: revivedId, proc: procB } = await registerPeer({ role: testRole });

    // Peer B should get the same ID as peer A
    expect(revivedId).toBe(originalId);

    await brokerFetch("/unregister", { id: revivedId });
    await killPeer(procB);
  });
});

// ---- List peers ----

describe("List peers", () => {
  test("lists only active peers (not dead ones)", async () => {
    const { id: activeId, proc: procActive } = await registerPeer({ summary: "active peer" });
    const { id: deadId, proc: procDead } = await registerPeer({ summary: "dead peer" });

    // Unregister the dead peer
    await brokerFetch("/unregister", { id: deadId });
    await killPeer(procDead);

    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });

    const activeIds = peers.map((p) => p.id);
    expect(activeIds).not.toContain(deadId);

    await brokerFetch("/unregister", { id: activeId });
    await killPeer(procActive);
  });

  test("scope filtering works — directory scope returns only same-cwd peers", async () => {
    const uniqueCwd = `/tmp/dir-scope-${Date.now()}`;

    const { id: peerInDirId, proc: procInDir } = await registerPeer({ cwd: uniqueCwd });
    const { id: peerOutDirId, proc: procOutDir } = await registerPeer({ cwd: "/tmp/other-dir-xyz" });

    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "directory",
      cwd: uniqueCwd,
      git_root: null,
    });

    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerInDirId);
    expect(ids).not.toContain(peerOutDirId);

    await brokerFetch("/unregister", { id: peerInDirId });
    await brokerFetch("/unregister", { id: peerOutDirId });
    await killPeer(procInDir);
    await killPeer(procOutDir);
  });

  test("scope filtering works — repo scope returns peers with same git_root", async () => {
    const gitRoot = `/tmp/repo-${Date.now()}`;

    const { id: peerInRepoId, proc: procInRepo } = await registerPeer({
      cwd: `${gitRoot}/subdir`,
      git_root: gitRoot,
    });
    const { id: peerOutRepoId, proc: procOutRepo } = await registerPeer({
      cwd: "/tmp/other-repo",
      git_root: "/tmp/other-repo",
    });

    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "repo",
      cwd: `${gitRoot}/subdir`,
      git_root: gitRoot,
    });

    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerInRepoId);
    expect(ids).not.toContain(peerOutRepoId);

    await brokerFetch("/unregister", { id: peerInRepoId });
    await brokerFetch("/unregister", { id: peerOutRepoId });
    await killPeer(procInRepo);
    await killPeer(procOutRepo);
  });

  test("exclude_id removes the specified peer from results", async () => {
    const { id: idA, proc: procA } = await registerPeer({ cwd: "/tmp/exclude-test" });
    const { id: idB, proc: procB } = await registerPeer({ cwd: "/tmp/exclude-test" });

    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
      exclude_id: idA,
    });

    const ids = peers.map((p) => p.id);
    expect(ids).not.toContain(idA);
    expect(ids).toContain(idB);

    await brokerFetch("/unregister", { id: idA });
    await brokerFetch("/unregister", { id: idB });
    await killPeer(procA);
    await killPeer(procB);
  });
});

// ---- Messaging ----

describe("Messaging", () => {
  test("send a message, poll it, verify content", async () => {
    const { id: senderId, proc: procSender } = await registerPeer();
    const { id: recvId, proc: procRecv } = await registerPeer();

    const msgText = "hello from sender " + Date.now();
    const { data: sendResult } = await brokerFetch<{ ok: boolean }>("/send-message", {
      from_id: senderId,
      to_id: recvId,
      text: msgText,
    });
    expect(sendResult.ok).toBe(true);

    const { data: poll } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: recvId, wait_ms: 0 }
    );
    expect(poll.events.length).toBeGreaterThan(0);
    const found = poll.events.map((e) => e.payload).find((m) => m.text === msgText);
    expect(found).toBeDefined();
    expect(found?.from_id).toBe(senderId);

    await brokerFetch("/unregister", { id: senderId });
    await brokerFetch("/unregister", { id: recvId });
    await killPeer(procSender);
    await killPeer(procRecv);
  });

  test("messages are marked delivered after polling and not returned again", async () => {
    const { id: senderId, proc: procSender } = await registerPeer();
    const { id: recvId, proc: procRecv } = await registerPeer();

    await brokerFetch("/send-message", {
      from_id: senderId,
      to_id: recvId,
      text: "deliver-once",
    });

    // First poll — should receive the message
    const { data: firstPoll } = await brokerFetch<LongPollResponse>("/poll-messages", {
      id: recvId,
      wait_ms: 0,
    });
    expect(firstPoll.events.length).toBeGreaterThan(0);

    // Second poll — should be empty (message already delivered)
    const { data: secondPoll } = await brokerFetch<LongPollResponse>("/poll-messages", {
      id: recvId,
      wait_ms: 0,
    });
    expect(secondPoll.events.length).toBe(0);

    await brokerFetch("/unregister", { id: senderId });
    await brokerFetch("/unregister", { id: recvId });
    await killPeer(procSender);
    await killPeer(procRecv);
  });

  test("sending to a non-existent peer returns error", async () => {
    const { id: senderId, proc: procSender } = await registerPeer();

    const { data: result } = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      from_id: senderId,
      to_id: "nonexistent-peer-id-xyz",
      text: "hello?",
    });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");

    await brokerFetch("/unregister", { id: senderId });
    await killPeer(procSender);
  });
});

// ---- Set role ----

describe("Set role", () => {
  test("setting a role on an existing peer succeeds", async () => {
    const { id, proc } = await registerPeer();

    const { data: result } = await brokerFetch<{ ok: boolean }>("/set-role", {
      id,
      role: "my-new-role-" + Date.now(),
    });
    expect(result.ok).toBe(true);

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });

  test("setting a role already held by another active peer returns error", async () => {
    const sharedRole = "shared-role-" + Date.now();

    const { id: idA, proc: procA } = await registerPeer();
    const { id: idB, proc: procB } = await registerPeer();

    // Peer A claims the role first
    await brokerFetch("/set-role", { id: idA, role: sharedRole });

    // Peer B tries to claim the same role
    const { data: result } = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", {
      id: idB,
      role: sharedRole,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(sharedRole);

    await brokerFetch("/unregister", { id: idA });
    await brokerFetch("/unregister", { id: idB });
    await killPeer(procA);
    await killPeer(procB);
  });

  test("setting role to null clears it, allowing another peer to claim it", async () => {
    const testRole = "clearable-role-" + Date.now();

    const { id: idA, proc: procA } = await registerPeer({ role: testRole });

    // Clear the role
    const { data: clearResult } = await brokerFetch<{ ok: boolean }>("/set-role", {
      id: idA,
      role: null,
    });
    expect(clearResult.ok).toBe(true);

    // After clearing, another peer should be able to claim the role
    const { id: idB, proc: procB } = await registerPeer();
    const { data: claimResult } = await brokerFetch<{ ok: boolean }>("/set-role", {
      id: idB,
      role: testRole,
    });
    expect(claimResult.ok).toBe(true);

    await brokerFetch("/unregister", { id: idA });
    await brokerFetch("/unregister", { id: idB });
    await killPeer(procA);
    await killPeer(procB);
  });
});

// ---- Set summary ----

describe("Set summary", () => {
  test("summary updates correctly", async () => {
    const { id, proc } = await registerPeer({ summary: "initial summary" });

    const newSummary = "updated summary " + Date.now();
    const { data: setResult } = await brokerFetch<{ ok: boolean }>("/set-summary", {
      id,
      summary: newSummary,
    });
    expect(setResult.ok).toBe(true);

    // Verify by listing peers
    const { data: peers } = await brokerFetch<{ id: string; summary: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const found = peers.find((p) => p.id === id);
    expect(found?.summary).toBe(newSummary);

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });
});

// ---- Unregister ----

describe("Unregister", () => {
  test("peer is marked dead (not deleted) after unregister", async () => {
    const { id, proc } = await registerPeer();

    await brokerFetch("/unregister", { id });
    await killPeer(proc);

    // The peer should no longer appear in list-peers (dead)
    const { data: peers } = await brokerFetch<{ id: string }[]>("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    expect(peers.map((p) => p.id)).not.toContain(id);
  });

  test("dead peer's undelivered messages are cleaned up on unregister", async () => {
    const { id: senderId, proc: procSender } = await registerPeer();
    const { id: recvId, proc: procRecv } = await registerPeer();

    // Send a message that won't be polled before unregister
    await brokerFetch("/send-message", {
      from_id: senderId,
      to_id: recvId,
      text: "unread message",
    });

    // Unregister the receiver — this should clean up the undelivered message
    await brokerFetch("/unregister", { id: recvId });
    await killPeer(procRecv);

    // Register a brand new peer (different sleeper = different PID)
    const { id: newRecvId, proc: procNewRecv } = await registerPeer();

    // The new peer should not have any messages
    const { data: poll } = await brokerFetch<LongPollResponse>("/poll-messages", {
      id: newRecvId,
      wait_ms: 0,
    });
    expect(poll.events.length).toBe(0);

    await brokerFetch("/unregister", { id: senderId });
    await brokerFetch("/unregister", { id: newRecvId });
    await killPeer(procSender);
    await killPeer(procNewRecv);
  });
});

// ---- CLI send-by-role ----

describe("CLI send-by-role", () => {
  const cliScript = path.join(import.meta.dir, "cli.ts");

  async function runCli(args: string[], env: Record<string, string> = {}): Promise<{
    stdout: string; stderr: string; exitCode: number;
  }> {
    const proc = Bun.spawn(["bun", cliScript, ...args], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(TEST_PORT), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("resolves exact role match and sends message", async () => {
    const role = "cli-exact-" + Date.now();
    const { id, proc } = await registerPeer({ role });

    const { stdout, exitCode } = await runCli([
      "send-by-role", role, "hello via exact match",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(id);

    const { data: poll } = await brokerFetch<LongPollResponse>(
      "/poll-messages", { id, wait_ms: 0 }
    );
    const found = poll.events.map((e) => e.payload).find((m) => m.text === "hello via exact match");
    expect(found).toBeDefined();
    expect(found?.from_id).toBe("cli");

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });

  test("resolves suffix match for namespaced roles (bare name)", async () => {
    const suffix = "cli-suffix-" + Date.now();
    const fullRole = `test-proj/${suffix}`;
    const { id, proc } = await registerPeer({ role: fullRole });

    const { stdout, exitCode } = await runCli([
      "send-by-role", suffix, "hello via suffix match",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(id);

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });

  test("exits 2 when no peer holds the requested role", async () => {
    const { stderr, exitCode } = await runCli([
      "send-by-role", "nonexistent-role-" + Date.now(), "will not deliver",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/No active peer/);
  });

  test("exits 3 on ambiguous suffix match with multiple candidates", async () => {
    const suffix = "cli-ambig-" + Date.now();
    const { id: idA, proc: procA } = await registerPeer({ role: `proj-a/${suffix}` });
    const { id: idB, proc: procB } = await registerPeer({ role: `proj-b/${suffix}` });

    const { stderr, exitCode } = await runCli([
      "send-by-role", suffix, "will fail",
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/Ambiguous/);

    await brokerFetch("/unregister", { id: idA });
    await brokerFetch("/unregister", { id: idB });
    await killPeer(procA);
    await killPeer(procB);
  });

  test("honors CLAUDE_PEERS_FROM_ID env var for hook attribution", async () => {
    const role = "cli-fromid-" + Date.now();
    const { id, proc } = await registerPeer({ role });

    const { exitCode } = await runCli(
      ["send-by-role", role, "hook-attributed message"],
      { CLAUDE_PEERS_FROM_ID: "git-hook:post-merge" }
    );
    expect(exitCode).toBe(0);

    const { data: poll } = await brokerFetch<LongPollResponse>(
      "/poll-messages", { id, wait_ms: 0 }
    );
    const found = poll.events.map((e) => e.payload).find((m) => m.text === "hook-attributed message");
    expect(found?.from_id).toBe("git-hook:post-merge");

    await brokerFetch("/unregister", { id });
    await killPeer(proc);
  });
});

// ---- Long-poll transport (Slice 2: T1-T10) ----
//
// These tests lock in the wire contract for the long-poll transport
// landing in broker.ts Task 3. ALL T1-T10 will fail until Task 3 lands —
// that's intentional per TDD. See docs/a2a-lite-slice-2.md §"Test Plan"
// for the design rationale behind each test.

// Long-poll response shape lives in shared/types.ts — single source of truth.
// If Message or Event gains a field later, these tests automatically reflect it.
type LongPollResponse = PollMessagesResponse;

type DebugWaitersResponse = {
  size: number;
  peers: { peer_id: string; age_ms: number }[];
};

describe("Long-poll transport (Slice 2)", () => {
  test("T1 — long-poll resolves when a message arrives mid-block", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t1-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t1-b" });
    const started = Date.now();

    const pollPromise = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 5000 }
    );

    await new Promise((r) => setTimeout(r, 50));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "hello T1" });

    const { data } = await pollPromise;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    expect(data.events.length).toBe(1);
    expect(data.events[0]!.type).toBe("message");
    expect(data.events[0]!.payload.text).toBe("hello T1");
    expect(data.next_cursor).toBe(data.events[0]!.event_id);

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T2 — long-poll times out cleanly when no message arrives", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t2-a" });
    const started = Date.now();

    const { data } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 500 }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(1000);
    expect(data.events.length).toBe(0);
    expect(data.next_cursor).toBe(null);

    await brokerFetch("/unregister", { id: aid });
    await killPeer(pa);
  });

  test("T3 — wait_ms=0 fast path returns immediately with no pending", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t3-a" });
    const started = Date.now();

    const { data } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(data.events.length).toBe(0);
    expect(data.next_cursor).toBe(null);

    // G1: verify NO waiter was installed. Without this assertion, a buggy
    // impl that installs-and-immediately-resolves on wait_ms=0 would pass.
    const { data: debug } = await brokerFetch<DebugWaitersResponse>("/debug/waiters");
    expect(debug.peers.find((p) => p.peer_id === aid)).toBeUndefined();

    await brokerFetch("/unregister", { id: aid });
    await killPeer(pa);
  });

  test("T4 — wait_ms=0 with pending events returns them immediately", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t4-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t4-b" });

    // Tiny gap between sends so sent_at is distinct
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m1" });
    await new Promise((r) => setTimeout(r, 2));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m2" });

    const started = Date.now();
    const { data } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(data.events.length).toBe(2);
    expect(data.events.map((e) => e.payload.text)).toEqual(["m1", "m2"]);

    // G2: verify messages were marked delivered (consumed). A second
    // wait_ms=0 poll must return empty — catches "returns events but
    // forgets markDelivered" bugs in isolation (without relying on T9).
    const { data: d2 } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    expect(d2.events.length).toBe(0);

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T5 — waiter replacement: second poll supersedes first", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t5-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t5-b" });

    const poll1Started = Date.now();
    const poll1 = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 5000 }
    );
    await new Promise((r) => setTimeout(r, 50));

    const poll2 = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 5000 }
    );

    // poll1 returns quickly — cancelled when poll2 installs its waiter
    const { data: d1 } = await poll1;
    const poll1Elapsed = Date.now() - poll1Started;
    // G3: distinguishes cancel-path from timeout-path. A buggy impl that
    // failed to cancel poll1 would still return length=0 after 5000ms
    // (timeout). 500ms bound is well under the 5000ms timeout.
    expect(poll1Elapsed).toBeLessThan(500);
    expect(d1.events.length).toBe(0);
    expect(d1.next_cursor).toBe(null);

    await new Promise((r) => setTimeout(r, 50));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "T5 winner" });

    const { data: d2 } = await poll2;
    expect(d2.events.length).toBe(1);
    expect(d2.events[0]!.payload.text).toBe("T5 winner");

    // Waiter map entry for aid should be gone after resolution
    const { data: debug } = await brokerFetch<DebugWaitersResponse>("/debug/waiters");
    expect(debug.peers.find((p) => p.peer_id === aid)).toBeUndefined();

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T6 — concurrent sends deliver both (one via waiter, one via DB)", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t6-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t6-b" });

    const pollPromise = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 5000 }
    );
    await new Promise((r) => setTimeout(r, 50));

    // Promise.all fires both. JS single-threading + atomic handleSendMessage
    // (no await between pendingWaiters.get and the delete+resolve) means
    // broker serializes them deterministically.
    await Promise.all([
      brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "first" }),
      brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "second" }),
    ]);

    const { data: d1 } = await pollPromise;
    expect(d1.events.length).toBe(1);
    // Whichever handler hit pendingWaiters.get first resolved the waiter.
    // The OTHER is now sitting as undelivered.
    const firstText = d1.events[0]!.payload.text;
    expect(["first", "second"]).toContain(firstText);

    const { data: d2 } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    expect(d2.events.length).toBe(1);
    const otherText = d2.events[0]!.payload.text;
    expect(otherText).not.toBe(firstText);
    expect(["first", "second"]).toContain(otherText);

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T7 — unregister cancels pending waiter", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t7-a" });

    const pollPromise = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 30000 }
    );
    await new Promise((r) => setTimeout(r, 50));

    const unregisterStart = Date.now();
    await brokerFetch("/unregister", { id: aid });

    const { data } = await pollPromise;
    const pollReturnedAt = Date.now();

    // D1: unregister→cancel→resolve is the fast path — no timeout, no await.
    // 100ms is generous for CI jitter but tight enough to lock in "fast path."
    expect(pollReturnedAt - unregisterStart).toBeLessThan(100);
    expect(data.events.length).toBe(0);
    expect(data.next_cursor).toBe(null);

    const { data: debug } = await brokerFetch<DebugWaitersResponse>("/debug/waiters");
    expect(debug.peers.find((p) => p.peer_id === aid)).toBeUndefined();

    await killPeer(pa);
  });

  test("T9 — since_id returns replay without consuming delivered flag", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t9-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t9-b" });

    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m1" });
    await new Promise((r) => setTimeout(r, 2));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m2" });
    await new Promise((r) => setTimeout(r, 2));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m3" });

    // First poll consumes all, marks delivered
    const { data: d1 } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    expect(d1.events.length).toBe(3);
    const firstEventId = d1.events[0]!.event_id;

    // Replay via since_id — ignores delivered flag
    const { data: d2 } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0, since_id: firstEventId - 1 }
    );
    expect(d2.events.length).toBe(3);
    expect(d2.events.map((e) => e.payload.text)).toEqual(["m1", "m2", "m3"]);

    // Normal poll after replay should be empty — replay is read-only
    const { data: d3 } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    expect(d3.events.length).toBe(0);

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T10 — since_id=0 returns all messages for peer regardless of delivered", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t10-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t10-b" });

    // Send 3, consume them (delivered=1)
    for (let i = 1; i <= 3; i++) {
      await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: `m${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const { data: consumed } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0 }
    );
    expect(consumed.events.length).toBe(3);

    // Send 2 more (undelivered)
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m4" });
    await new Promise((r) => setTimeout(r, 2));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "m5" });

    // since_id=0 returns all 5 regardless of delivery state
    const { data: replay } = await brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 0, since_id: 0 }
    );
    expect(replay.events.length).toBe(5);
    expect(replay.events.map((e) => e.payload.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T11 — wait_ms out-of-range returns HTTP 400 (both ends)", async () => {
    // G4: locks in the fail-loud contract from F4. Without this, a broker
    // impl that silently clamps wait_ms would violate the documented
    // semantics while still passing all other tests. Pattern from the
    // existing role-conflict test (broker.test.ts:206-225).
    //
    // M2 extension: negative wait_ms is also rejected — fail-loud for both
    // ends of the invalid range, symmetric with the > MAX_WAIT_MS branch.
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t11-a" });

    // Too-large wait_ms
    const { status: tooBigStatus, data: tooBigErr } = await brokerFetch<{ error: string }>(
      "/poll-messages",
      { id: aid, wait_ms: 999_999_999 }
    );
    expect(tooBigStatus).toBe(400);
    expect(tooBigErr.error).toMatch(/MAX_WAIT_MS|wait_ms/i);

    // Negative wait_ms
    const { status: negStatus, data: negErr } = await brokerFetch<{ error: string }>(
      "/poll-messages",
      { id: aid, wait_ms: -1 }
    );
    expect(negStatus).toBe(400);
    expect(negErr.error).toMatch(/wait_ms/i);

    await brokerFetch("/unregister", { id: aid });
    await killPeer(pa);
  });
});

describe("A2A-lite schema (Slice 3)", () => {
  // All slice-3 assertions inspect the broker's DB directly via a second
  // readonly connection. WAL mode allows concurrent readers alongside the
  // broker's write connection. We do NOT use HTTP endpoints here because
  // slice 3 intentionally exposes zero new endpoints — the schema exists
  // purely as a landing pad for slice 4.

  function openRo(): Database {
    return new Database(TEST_DB, { readonly: true });
  }

  test("S1: tasks table exists with expected columns", () => {
    const db = openRo();
    try {
      const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
        pk: number;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(Object.keys(byName).sort()).toEqual(
        ["context_id", "created_at", "created_by", "id", "state", "title"].sort()
      );
      expect(byName.id!.pk).toBe(1);
      // Exact-string match (reviewer C1) — tighter than a regex; catches any
      // default-expression drift (e.g. wrapping parentheses, lowercased quote).
      expect(byName.state!.dflt_value).toBe("'open'");
      expect(byName.created_at!.notnull).toBe(1);
      expect(byName.created_by!.notnull).toBe(1);
    } finally {
      db.close();
    }
  });

  test("S2: task_participants table exists with composite PK", () => {
    const db = openRo();
    try {
      const cols = db.query("PRAGMA table_info(task_participants)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(Object.keys(byName).sort()).toEqual(
        ["joined_at", "peer_id", "role_at_join", "task_id"].sort()
      );
      // Composite PK ordering matters (reviewer C2): `(task_id, peer_id)` is
      // the ordering that makes "find participants for task X" a direct index
      // lookup — the dominant query pattern for slice 4+. Lock it in now;
      // reordering later would be a breaking migration, not a reshape.
      expect(byName.task_id!.pk).toBe(1);
      expect(byName.peer_id!.pk).toBe(2);
    } finally {
      db.close();
    }
  });

  test("S3: task_events table exists with AUTOINCREMENT id", () => {
    const db = openRo();
    try {
      const cols = db.query("PRAGMA table_info(task_events)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(Object.keys(byName).sort()).toEqual(
        ["data", "from_id", "id", "intent", "sent_at", "task_id", "text"].sort()
      );
      expect(byName.id!.pk).toBe(1);
      const sqlRow = db.query(
        "SELECT sql FROM sqlite_master WHERE name = 'task_events'"
      ).get() as { sql: string };
      expect(sqlRow.sql).toContain("AUTOINCREMENT");
    } finally {
      db.close();
    }
  });

  test("S4: task_event_cursors table exists with peer_id PK", () => {
    const db = openRo();
    try {
      const cols = db.query("PRAGMA table_info(task_event_cursors)").all() as Array<{
        name: string;
        pk: number;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(Object.keys(byName).sort()).toEqual(["last_event_id", "peer_id"]);
      expect(byName.peer_id!.pk).toBe(1);
      expect(byName.last_event_id!.notnull).toBe(1);
      expect(byName.last_event_id!.dflt_value).toBe("0");
    } finally {
      db.close();
    }
  });

  test("S5: idx_task_events_task indexes (task_id, id)", () => {
    const db = openRo();
    try {
      const idx = db.query(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_events_task'"
      ).get() as { name: string; tbl_name: string } | null;
      expect(idx).not.toBeNull();
      expect(idx!.tbl_name).toBe("task_events");

      const info = db.query("PRAGMA index_info(idx_task_events_task)").all() as Array<{
        seqno: number;
        name: string;
      }>;
      const ordered = [...info].sort((a, b) => a.seqno - b.seqno);
      expect(ordered.map((r) => r.name)).toEqual(["task_id", "id"]);
    } finally {
      db.close();
    }
  });

  test("S6: audit_stream view exists with the expected column set", () => {
    const db = openRo();
    try {
      const v = db.query(
        "SELECT type, sql FROM sqlite_master WHERE name = 'audit_stream'"
      ).get() as { type: string; sql: string } | null;
      expect(v).not.toBeNull();
      expect(v!.type).toBe("view");

      // Execute against the view to confirm the column set. LIMIT 0 keeps
      // this cheap and independent of row content.
      const stmt = db.query("SELECT * FROM audit_stream LIMIT 0");
      const cols = stmt.columnNames;
      expect(cols.sort()).toEqual(
        ["body", "data", "from_id", "intent", "sent_at", "source", "source_id", "task_id", "to_id"].sort()
      );
    } finally {
      db.close();
    }
  });

  test("S7: audit_stream reflects messages inserted via /send-message", async () => {
    const a = await registerPeer({ summary: "sender" });
    const b = await registerPeer({ summary: "recipient" });
    const sendRes = await brokerFetch<{ ok: boolean }>("/send-message", {
      from_id: a.id,
      to_id: b.id,
      text: "hello slice 3",
    });
    expect(sendRes.data.ok).toBe(true);

    const db = openRo();
    try {
      const rows = db.query(
        "SELECT source, from_id, to_id, body, intent, task_id, data FROM audit_stream WHERE from_id = ? AND body = ?"
      ).all(a.id, "hello slice 3") as Array<{
        source: string;
        from_id: string;
        to_id: string;
        body: string;
        intent: string;
        task_id: string | null;
        data: string | null;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.source).toBe("message");
      expect(rows[0]!.intent).toBe("text");
      expect(rows[0]!.task_id).toBeNull();
      expect(rows[0]!.data).toBeNull();
      expect(rows[0]!.to_id).toBe(b.id);
    } finally {
      db.close();
    }

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: b.id });
    await killPeer(a.proc);
    await killPeer(b.proc);
  });

  test("S8: audit_stream has no task_event rows in slice 3", () => {
    const db = openRo();
    try {
      const row = db.query(
        "SELECT COUNT(*) AS n FROM audit_stream WHERE source = 'task_event'"
      ).get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  // S9 (reviewer C3): restart the broker subprocess on the same DB and
  // verify the slice-3 DDL block tolerates a re-run cleanly. CREATE IF NOT
  // EXISTS is the migration mechanism — if a future refactor drops the
  // idempotency (e.g. by adding a CREATE without IF NOT EXISTS), a restart
  // against an existing DB would crash the broker at boot. This test locks
  // in the restart-safety invariant. Uses the same module-scoped brokerProc
  // reassignment pattern as T8 so afterAll still tears down cleanly.
  test("S9: broker restart on existing slice-3 DB is idempotent", async () => {
    brokerProc.kill();
    await brokerProc.exited;

    brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(TEST_PORT),
        CLAUDE_PEERS_DB: TEST_DB,
        CLAUDE_PEERS_HOME: TEST_HOME,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`${BROKER_URL}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not yet up */ }
    }
    expect(ready).toBe(true);

    // Schema survived the restart — reduced S1 check.
    const db = openRo();
    try {
      const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
      }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has("id")).toBe(true);
      expect(names.has("state")).toBe(true);
      expect(names.has("created_by")).toBe(true);

      // Also confirm the view survives — it's the slice-3 addition most likely
      // to break on a re-run if CREATE VIEW IF NOT EXISTS semantics change.
      const v = db.query(
        "SELECT 1 AS present FROM sqlite_master WHERE name = 'audit_stream'"
      ).get() as { present: number } | null;
      expect(v?.present).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("A2A-lite typed tools (Slice 4)", () => {
  // All tests here exercise the broker endpoints that slice 4 will add.
  // Against current main, every assertion that hits /dispatch-task or
  // /send-task-event returns 404, so tests fail deterministically until
  // Task 3 lands the handlers.

  const TASKS_DIR = path.join(TEST_HOME, "tasks");

  interface DispatchResp {
    task_id: string;
    participants: string[];
    event_id: number;
  }

  async function dispatchTask(
    fromId: string,
    participants: string[],
    opts: {
      title?: string;
      text?: string;
      data?: Record<string, unknown>;
      context_id?: string;
    } = {}
  ): Promise<{ status: number; data: DispatchResp | { error: string } }> {
    return brokerFetch<DispatchResp | { error: string }>("/dispatch-task", {
      from_id: fromId,
      title: opts.title ?? "test task",
      participants,
      context_id: opts.context_id,
      text: opts.text,
      data: opts.data,
    });
  }

  async function sendTaskEvent(
    fromId: string,
    taskId: string,
    intent: string,
    opts: { text?: string; data?: Record<string, unknown> } = {}
  ): Promise<{ status: number; data: { event_id?: number; error?: string } }> {
    return brokerFetch<{ event_id?: number; error?: string }>("/send-task-event", {
      from_id: fromId,
      task_id: taskId,
      intent,
      text: opts.text,
      data: opts.data,
    });
  }

  async function readTaskFile(taskId: string): Promise<string> {
    const filePath = path.join(TASKS_DIR, `${taskId}.md`);
    return fs.readFileSync(filePath, "utf8");
  }

  // ---- D: Dispatch ----

  test("D1: dispatch_task happy path with peer_id participants", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });

    const { status, data } = await dispatchTask(a.id, [b.id, c.id], {
      title: "test",
      text: "go",
    });
    expect(status).toBe(200);
    const resp = data as DispatchResp;
    expect(resp.task_id).toMatch(/^T-\d+$/);
    expect(resp.participants.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(typeof resp.event_id).toBe("number");

    const db = new Database(TEST_DB, { readonly: true });
    try {
      const taskRow = db.query("SELECT * FROM tasks WHERE id = ?").get(resp.task_id) as {
        state: string;
        title: string;
        created_by: string;
      };
      expect(taskRow.state).toBe("open");
      expect(taskRow.title).toBe("test");
      expect(taskRow.created_by).toBe(a.id);

      const partRows = db.query(
        "SELECT peer_id, role_at_join FROM task_participants WHERE task_id = ?"
      ).all(resp.task_id) as Array<{ peer_id: string; role_at_join: string | null }>;
      expect(partRows.length).toBe(3);
      const byPeer = Object.fromEntries(partRows.map((r) => [r.peer_id, r.role_at_join]));
      expect(byPeer[a.id]).toBe("dispatcher");

      const evtRows = db.query(
        "SELECT intent, from_id, text FROM task_events WHERE task_id = ? ORDER BY id"
      ).all(resp.task_id) as Array<{ intent: string; from_id: string; text: string }>;
      expect(evtRows.length).toBe(1);
      expect(evtRows[0]!.intent).toBe("dispatch");
      expect(evtRows[0]!.from_id).toBe(a.id);
    } finally {
      db.close();
    }

    const fileContents = await readTaskFile(resp.task_id);
    expect(fileContents).toContain(`# ${resp.task_id}`);
    expect(fileContents).toContain("## Events");
    expect(fileContents).toContain("dispatch");

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("D2: dispatch_task resolves role-name participant", async () => {
    const a = await registerPeer({ summary: "A" });
    const d = await registerPeer({ summary: "D", role: "reviewer-slice4" });

    const { data } = await dispatchTask(a.id, ["reviewer-slice4"]);
    const resp = data as DispatchResp;
    expect(resp.participants).toContain(d.id);
    expect(resp.participants).not.toContain("reviewer-slice4");

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: d.id });
    await killPeer(a.proc);
    await killPeer(d.proc);
  });

  test("D3: dispatch_task with zero-holder role → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const { status, data } = await dispatchTask(a.id, ["nonexistent-role"]);
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("nonexistent-role");

    await brokerFetch("/unregister", { id: a.id });
    await killPeer(a.proc);
  });

  test("D5: dispatch_task with empty participants → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const { status } = await dispatchTask(a.id, []);
    expect(status).toBe(400);

    await brokerFetch("/unregister", { id: a.id });
    await killPeer(a.proc);
  });

  test("D6: dispatch_task with inactive from_id → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    // Kill A's sleeper so its process is gone, then force inline mark-dead
    // via a /list-peers call.
    await killPeer(a.proc);
    await brokerFetch("/list-peers", { scope: "machine", cwd: "/", git_root: null });

    const { status } = await dispatchTask(a.id, [b.id]);
    expect(status).toBe(400);

    await brokerFetch("/unregister", { id: b.id });
    await killPeer(b.proc);
  });

  test("D7: dispatch_task generates sequential T-<n> ids", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });

    const r1 = await dispatchTask(a.id, [b.id], { title: "first" });
    const r2 = await dispatchTask(a.id, [b.id], { title: "second" });
    const n1 = parseInt((r1.data as DispatchResp).task_id.slice(2), 10);
    const n2 = parseInt((r2.data as DispatchResp).task_id.slice(2), 10);
    expect(n2).toBeGreaterThan(n1);

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: b.id });
    await killPeer(a.proc);
    await killPeer(b.proc);
  });

  // ---- S: send_task_event ----

  test("S1: send_task_event happy path", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const { status, data } = await sendTaskEvent(b.id, disp.task_id, "state_change", {
      data: { to: "working" },
    });
    expect(status).toBe(200);
    expect(typeof data.event_id).toBe("number");

    const db = new Database(TEST_DB, { readonly: true });
    try {
      const row = db.query("SELECT * FROM task_events WHERE id = ?").get(data.event_id!) as {
        intent: string;
        from_id: string;
        data: string;
      };
      expect(row.intent).toBe("state_change");
      expect(row.from_id).toBe(b.id);
      expect(row.data).toContain("working");
    } finally {
      db.close();
    }

    const file = await readTaskFile(disp.task_id);
    expect(file).toMatch(/state_change/);

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: b.id });
    await killPeer(a.proc);
    await killPeer(b.proc);
  });

  test("S2: send_task_event from non-participant → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const e = await registerPeer({ summary: "E" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const { status, data } = await sendTaskEvent(e.id, disp.task_id, "state_change", {
      data: { to: "working" },
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/participant/i);

    for (const p of [a, b, e]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("S3: send_task_event with invalid intent → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const { status } = await sendTaskEvent(b.id, disp.task_id, "bogus", { text: "x" });
    expect(status).toBe(400);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("S4: send_task_event with intent=dispatch → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const { status } = await sendTaskEvent(b.id, disp.task_id, "dispatch", { text: "x" });
    expect(status).toBe(400);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("S5: send_task_event with empty text+data → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const { status } = await sendTaskEvent(b.id, disp.task_id, "state_change");
    expect(status).toBe(400);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("S6: send_task_event with unknown task_id → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const { status } = await sendTaskEvent(a.id, "T-999999", "state_change", {
      data: { to: "x" },
    });
    expect(status).toBe(400);

    await brokerFetch("/unregister", { id: a.id });
    await killPeer(a.proc);
  });

  // ---- P: Poll / long-poll integration ----

  interface PollRespEvent {
    event_id: number;
    type: "message" | "task_event";
    payload: { id: number; task_id?: string; intent?: string; text?: string };
  }

  test("P1: poll returns task_events for participant", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchTask(a.id, [b.id]);

    const { data } = await brokerFetch<{
      events: PollRespEvent[];
      next_cursor: number | null;
    }>("/poll-messages", { id: b.id, wait_ms: 0 });
    const typed = data.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(1);
    expect(typed[0]!.payload.intent).toBe("dispatch");

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("P2: poll skips task_events for non-participant", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    await dispatchTask(a.id, [b.id]);

    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: c.id,
      wait_ms: 0,
    });
    const typed = data.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(0);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("P3: long-poll waiter resolves on task_event arrival", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });

    const pollPromise = brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 5000,
    });
    // Dangling-reject safety: if we bail early (e.g. dispatch 4xx in baseline),
    // pollPromise still resolves at the broker's wait_ms timeout and must not
    // surface as an "unhandled error between tests" at teardown.
    pollPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    const t0 = Date.now();
    // Fail fast in baseline: assert dispatch succeeded before awaiting the
    // long-poll resolution. Otherwise the test would block on pollPromise for
    // the full 5s wait_ms, colliding with bun's default 5s per-test timeout.
    const dispResp = await dispatchTask(a.id, [b.id]);
    expect(dispResp.status).toBe(200);
    const { data } = await pollPromise;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    const typed = data.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(1);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  }, 15_000);

  test("P4: cursor advances past delivered events", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchTask(a.id, [b.id]);

    // First poll consumes the dispatch event
    await brokerFetch("/poll-messages", { id: b.id, wait_ms: 0 });
    // Second poll should be empty (cursor is past)
    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    const typed = data.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(0);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("P5: sender does NOT receive their own task_event", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchTask(a.id, [a.id, b.id]);

    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: a.id,
      wait_ms: 0,
    });
    const typed = data.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(0);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("P6: mixed batch returns both messages and task_events", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "msg" });
    await dispatchTask(a.id, [b.id]);

    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    const kinds = new Set(data.events.map((e) => e.type));
    expect(kinds.has("message")).toBe(true);
    expect(kinds.has("task_event")).toBe(true);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  // ---- F: Filesystem ----

  test("F1: dispatch creates task file with header", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id], {
      title: "scaffold",
      text: "go do it",
    })).data as DispatchResp;

    const file = await readTaskFile(disp.task_id);
    expect(file).toContain(`# ${disp.task_id}`);
    expect(file).toMatch(/state:\s*open/);
    expect(file).toContain("participants:");
    expect(file).toContain("## Events");
    expect(file).toMatch(/### .+ dispatch/);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("F2: send_task_event appends event section", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;
    await sendTaskEvent(b.id, disp.task_id, "state_change", { data: { to: "working" } });

    const file = await readTaskFile(disp.task_id);
    const sections = file.split(/^###\s/m).slice(1); // drop the header chunk
    expect(sections.length).toBeGreaterThanOrEqual(2);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("F3: fs write failure does not block handler (chmod ro tasks dir)", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const filePath = path.join(TASKS_DIR, `${disp.task_id}.md`);
    fs.chmodSync(filePath, 0o400);
    try {
      const { status, data } = await sendTaskEvent(b.id, disp.task_id, "state_change", {
        data: { to: "working" },
      });
      expect(status).toBe(200);
      expect(typeof data.event_id).toBe("number");
    } finally {
      fs.chmodSync(filePath, 0o600);
    }

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("F4: task files live under ~/.claude-peers/tasks/", () => {
    expect(fs.existsSync(TASKS_DIR)).toBe(true);
  });

  test("F5: renderTaskFile is a pure function of DB state (slice-7 preview)", async () => {
    // This test imports the render module directly and feeds it DB-shaped
    // inputs. Lock in: output matches what the broker wrote to disk on dispatch.
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id], {
      title: "render-test",
      text: "pure",
    })).data as DispatchResp;

    const db = new Database(TEST_DB, { readonly: true });
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(disp.task_id);
    const parts = db.query("SELECT * FROM task_participants WHERE task_id = ?").all(disp.task_id);
    const events = db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(disp.task_id);
    db.close();

    const render = await import("./shared/render.ts");
    const rendered = render.renderTaskFile(task as Parameters<typeof render.renderTaskFile>[0], parts as Parameters<typeof render.renderTaskFile>[1], events as Parameters<typeof render.renderTaskFile>[2]);
    const onDisk = await readTaskFile(disp.task_id);
    expect(rendered).toBe(onDisk);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("F7: fs write failure after DB insert preserves DB row", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const filePath = path.join(TASKS_DIR, `${disp.task_id}.md`);
    fs.chmodSync(filePath, 0o400);
    try {
      const { data } = await sendTaskEvent(b.id, disp.task_id, "state_change", {
        data: { to: "working" },
      });
      const db = new Database(TEST_DB, { readonly: true });
      try {
        const row = db.query("SELECT id FROM task_events WHERE id = ?").get(data.event_id!) as
          | { id: number }
          | null;
        expect(row).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      fs.chmodSync(filePath, 0o600);
    }

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  // ---- R: Role resolution ----

  test("R1: role resolves to live peer", async () => {
    const a = await registerPeer({ summary: "A" });
    const d = await registerPeer({ summary: "D", role: "r1-role" });
    const { data } = await dispatchTask(a.id, ["r1-role"]);
    expect((data as DispatchResp).participants).toContain(d.id);

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: d.id });
    await killPeer(a.proc);
    await killPeer(d.proc);
  });

  test("R2: role released between list_peers and dispatch → 400", async () => {
    const a = await registerPeer({ summary: "A" });
    const d = await registerPeer({ summary: "D", role: "r2-role" });
    await brokerFetch("/set-role", { id: d.id, role: null });
    const { status, data } = await dispatchTask(a.id, ["r2-role"]);
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("r2-role");

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: d.id });
    await killPeer(a.proc);
    await killPeer(d.proc);
  });

  test("R3: role rebind — revived peer inherits task participation", async () => {
    const a = await registerPeer({ summary: "A" });
    const d = await registerPeer({ summary: "D", role: "r3-role" });
    const disp = (await dispatchTask(a.id, ["r3-role"])).data as DispatchResp;
    expect(disp.participants).toContain(d.id);

    // D dies; a new session F registers with the same role → inherits D's id
    await brokerFetch("/unregister", { id: d.id });
    await killPeer(d.proc);

    const f = await registerPeer({ summary: "F revived", role: "r3-role" });
    expect(f.id).toBe(d.id); // revive path returns the prior dead row's id

    // F (== old D) is still a participant on the old task — verify via DB
    const db = new Database(TEST_DB, { readonly: true });
    try {
      const row = db.query(
        "SELECT peer_id FROM task_participants WHERE task_id = ? AND peer_id = ?"
      ).get(disp.task_id, f.id) as { peer_id: string } | null;
      expect(row).not.toBeNull();
    } finally {
      db.close();
    }

    await brokerFetch("/unregister", { id: a.id });
    await brokerFetch("/unregister", { id: f.id });
    await killPeer(a.proc);
    await killPeer(f.proc);
  });

  test("R4: role held only by dead peer → 400 with dead-holder message", async () => {
    const a = await registerPeer({ summary: "A" });
    const d = await registerPeer({ summary: "D", role: "r4-role" });

    // Kill D's process + flush with /list-peers, but do NOT /unregister (so
    // the row stays, just flips to dead).
    await killPeer(d.proc);
    await brokerFetch("/list-peers", { scope: "machine", cwd: "/", git_root: null });

    const { status, data } = await dispatchTask(a.id, ["r4-role"]);
    expect(status).toBe(400);
    expect((data as { error: string }).error).toMatch(/r4-role/);

    await brokerFetch("/unregister", { id: a.id });
    await killPeer(a.proc);
  });

  test("R5: cleanStalePeers mid-dispatch does not corrupt task creation", async () => {
    // In the real broker, cleanStalePeers is a setInterval. This test doesn't
    // trigger it directly — instead it asserts that back-to-back dispatch
    // calls around a /list-peers (which also marks stale) produce consistent
    // state. If the race existed, we'd see orphan task_participants rows.
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });

    const disp1 = (await dispatchTask(a.id, [b.id])).data as DispatchResp;
    await brokerFetch("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const disp2 = (await dispatchTask(a.id, [b.id])).data as DispatchResp;

    const db = new Database(TEST_DB, { readonly: true });
    try {
      for (const tid of [disp1.task_id, disp2.task_id]) {
        const parts = db.query(
          "SELECT peer_id FROM task_participants WHERE task_id = ?"
        ).all(tid) as { peer_id: string }[];
        const ids = parts.map((p) => p.peer_id).sort();
        expect(ids).toEqual([a.id, b.id].sort());
      }
    } finally {
      db.close();
    }

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  // ---- C: Cursor semantics ----

  test("C1: new peer starts with cursor=0 and only receives events they participate in", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchTask(a.id, [b.id]);

    // A fresh peer C registers — cursor starts at 0 but they are not a
    // participant on the earlier task, so they see nothing.
    const c = await registerPeer({ summary: "C" });
    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: c.id,
      wait_ms: 0,
    });
    expect(data.events.filter((e) => e.type === "task_event")).toEqual([]);

    // After dispatching to C, they receive the new event.
    await dispatchTask(a.id, [c.id]);
    const { data: data2 } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: c.id,
      wait_ms: 0,
    });
    const typed = data2.events.filter((e) => e.type === "task_event");
    expect(typed.length).toBe(1);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("C2: cursor advances to max event_id in a multi-event batch", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const disp = (await dispatchTask(a.id, [b.id])).data as DispatchResp;
    await sendTaskEvent(a.id, disp.task_id, "state_change", { data: { to: "working" } });

    // B's single poll picks up both events
    const { data } = await brokerFetch<{ events: PollRespEvent[]; next_cursor: number | null }>(
      "/poll-messages",
      { id: b.id, wait_ms: 0 }
    );
    const taskEvents = data.events.filter((e) => e.type === "task_event");
    expect(taskEvents.length).toBe(2);

    // Next poll should be empty (cursor advanced past both)
    const { data: data2 } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    expect(data2.events.filter((e) => e.type === "task_event")).toEqual([]);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("C3: concurrent task_event inserts both reach polling peer", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchTask(a.id, [b.id, c.id])).data as DispatchResp;

    // C drains the dispatch event so its cursor is caught up.
    await brokerFetch("/poll-messages", { id: c.id, wait_ms: 0 });

    // A and B fire events concurrently.
    await Promise.all([
      sendTaskEvent(a.id, disp.task_id, "state_change", { data: { to: "working" } }),
      sendTaskEvent(b.id, disp.task_id, "question", { text: "q?" }),
    ]);

    // C polls, possibly twice, to collect both.
    const seen: number[] = [];
    for (let i = 0; i < 3 && seen.length < 2; i++) {
      const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
        id: c.id,
        wait_ms: 200,
      });
      for (const e of data.events.filter((e) => e.type === "task_event")) {
        seen.push(e.event_id);
      }
    }
    expect(seen.length).toBe(2);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("C4: cursor advances exactly once per event (no duplicate delivery)", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchTask(a.id, [b.id]);
    await brokerFetch("/poll-messages", { id: b.id, wait_ms: 0 });
    const { data } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    expect(data.events.filter((e) => e.type === "task_event")).toEqual([]);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("C5: cursor write and waiter resolve are paired", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });

    // B installs a long-poll; A dispatches; B's poll resolves.
    const pollPromise = brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 5000,
    });
    pollPromise.catch(() => {}); // dangling-reject safety (see P3)
    await new Promise((r) => setTimeout(r, 100));
    const dispResp = await dispatchTask(a.id, [b.id]);
    expect(dispResp.status).toBe(200); // fail fast in baseline (see P3)
    const { data } = await pollPromise;
    expect(data.events.filter((e) => e.type === "task_event").length).toBe(1);

    // Immediate second poll must be empty — cursor was advanced as part of
    // the resolve, not on the next poll.
    const { data: data2 } = await brokerFetch<{ events: PollRespEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    expect(data2.events.filter((e) => e.type === "task_event")).toEqual([]);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  }, 15_000);

  // F6 runs LAST in the slice-4 describe because it kills the broker and
  // respawns it (like T8). Later tests in the describe must not depend on
  // broker state that F6 disrupts; T8 (in the final describe) does its own
  // kill+respawn and tolerates restarts.
  test("F6: broker crash mid-slice-4 recovers cleanly (existing file survives)", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const dispResp = await dispatchTask(a.id, [b.id]);
    // In failing baseline, dispatch returns 4xx; skip the crash+restore dance
    // so subsequent tests in the same run (and afterAll teardown) aren't
    // affected. This preserves deterministic failure semantics: the test
    // fails on the dispatch assertion rather than cascading via a dead broker.
    expect(dispResp.status).toBe(200);
    const disp = dispResp.data as DispatchResp;

    brokerProc.kill();
    await brokerProc.exited;

    brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(TEST_PORT),
        CLAUDE_PEERS_DB: TEST_DB,
        CLAUDE_PEERS_HOME: TEST_HOME,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`${BROKER_URL}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not yet */ }
    }
    expect(ready).toBe(true);

    const fileAfter = await readTaskFile(disp.task_id);
    expect(fileAfter).toContain(`# ${disp.task_id}`);
    expect(fileAfter).toContain("dispatch");

    await killPeer(a.proc);
    await killPeer(b.proc);
  });
});

describe("A2A-lite push policy (Slice 5)", () => {
  // Slice 5 broadens the Event envelope with a `push` flag. Tests hit the
  // broker's /poll-messages endpoint directly and read push from the
  // returned events. Tests fail in baseline because:
  //   - `push` field is absent on slice-4 events (undefined, not true/false)
  //   - `observers` field on /dispatch-task is not yet accepted by broker

  interface PushDispatchResp {
    task_id: string;
    participants: string[];
    event_id: number;
  }

  async function dispatchS5(
    fromId: string,
    participants: string[],
    opts: {
      title?: string;
      observers?: string[];
      text?: string;
      data?: Record<string, unknown>;
    } = {}
  ): Promise<{ status: number; data: PushDispatchResp | { error: string } }> {
    return brokerFetch<PushDispatchResp | { error: string }>("/dispatch-task", {
      from_id: fromId,
      title: opts.title ?? "slice-5 task",
      participants,
      observers: opts.observers,
      text: opts.text,
      data: opts.data,
    });
  }

  async function sendEvt(
    fromId: string,
    taskId: string,
    intent: string,
    opts: { text?: string; data?: Record<string, unknown> } = {}
  ) {
    return brokerFetch<{ event_id?: number; error?: string }>("/send-task-event", {
      from_id: fromId,
      task_id: taskId,
      intent,
      text: opts.text,
      data: opts.data,
    });
  }

  interface PushPollEvent {
    event_id: number;
    type: "message" | "task_event";
    payload: { intent?: string; task_id?: string; text?: string };
    push?: boolean;
  }

  async function pollTaskEvents(peerId: string): Promise<PushPollEvent[]> {
    const { data } = await brokerFetch<{ events: PushPollEvent[] }>("/poll-messages", {
      id: peerId,
      wait_ms: 0,
    });
    return data.events.filter((e) => e.type === "task_event");
  }

  // ---- R: Rule-based push expectations ----

  test("R1: observer receives event with push=false; non-observer gets push=true", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = await dispatchS5(a.id, [b.id], { observers: [c.id] });
    expect(disp.status).toBe(200);
    const resp = disp.data as PushDispatchResp;
    await sendEvt(a.id, resp.task_id, "state_change", { data: { to: "done" } });

    // Drain dispatch event first for C and B to isolate the state_change
    await pollTaskEvents(b.id);
    await pollTaskEvents(c.id);
    await sendEvt(a.id, resp.task_id, "state_change", { data: { to: "done" } });

    const bEvents = await pollTaskEvents(b.id);
    const cEvents = await pollTaskEvents(c.id);
    expect(bEvents.some((e) => e.push === true)).toBe(true);
    expect(cEvents.every((e) => e.push === false)).toBe(true);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R2: sender-exclusion regression (slice-4 delivery-layer, NOT shouldPush)", async () => {
    // This test verifies sender exclusion is enforced at the delivery layer
    // (selectTaskEventsSincePeer's `te.from_id != ?` filter + the sender-skip
    // in deliverTaskEventToPeer from slice 4). The shouldPush sender rule
    // (D7, defense-in-depth) is never reached on this path because the sender
    // never gets a task_event in their poll batch. If a future refactor
    // removes the delivery-layer filter, D7 becomes the load-bearing rule.
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await dispatchS5(a.id, [b.id]);

    const aEvents = await pollTaskEvents(a.id);
    expect(aEvents.length).toBe(0);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R3: state_change→working suppressed universally", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    // Drain dispatch events so subsequent poll returns only the new event
    await pollTaskEvents(a.id);
    await pollTaskEvents(b.id);
    await pollTaskEvents(c.id);
    await sendEvt(b.id, disp.task_id, "state_change", { data: { to: "working" } });

    for (const recipient of [a, c]) {
      const events = await pollTaskEvents(recipient.id);
      const sc = events.find((e) => e.payload.intent === "state_change");
      expect(sc).toBeDefined();
      expect(sc!.push).toBe(false);
    }

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R4: state_change→done is NOT suppressed", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(b.id);
    await pollTaskEvents(c.id);
    await sendEvt(b.id, disp.task_id, "state_change", { data: { to: "done" } });

    for (const recipient of [a, c]) {
      const events = await pollTaskEvents(recipient.id);
      const sc = events.find((e) => e.payload.intent === "state_change");
      expect(sc).toBeDefined();
      expect(sc!.push).toBe(true);
    }

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R5: targeted question — only named target receives push", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(c.id);
    await sendEvt(b.id, disp.task_id, "question", { text: "for A", data: { to: a.id } });

    const aEvents = await pollTaskEvents(a.id);
    const cEvents = await pollTaskEvents(c.id);
    const aQ = aEvents.find((e) => e.payload.intent === "question");
    const cQ = cEvents.find((e) => e.payload.intent === "question");
    expect(aQ?.push).toBe(true);
    expect(cQ?.push).toBe(false);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R6: untargeted question — push to all non-senders", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(c.id);
    await sendEvt(b.id, disp.task_id, "question", { text: "anyone?" });

    for (const recipient of [a, c]) {
      const events = await pollTaskEvents(recipient.id);
      const q = events.find((e) => e.payload.intent === "question");
      expect(q?.push).toBe(true);
    }

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R7: targeted answer — only original asker receives push", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(b.id);
    await pollTaskEvents(c.id);
    await sendEvt(a.id, disp.task_id, "answer", { text: "reply", data: { reply_to_from: b.id } });

    const bEvents = await pollTaskEvents(b.id);
    const cEvents = await pollTaskEvents(c.id);
    expect(bEvents.find((e) => e.payload.intent === "answer")?.push).toBe(true);
    expect(cEvents.find((e) => e.payload.intent === "answer")?.push).toBe(false);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R8: complete intent pushes to all non-senders", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(b.id);
    await sendEvt(c.id, disp.task_id, "complete", { text: "done" });

    for (const recipient of [a, b]) {
      const events = await pollTaskEvents(recipient.id);
      const c = events.find((e) => e.payload.intent === "complete");
      expect(c?.push).toBe(true);
    }

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R9: cancel intent pushes to all non-senders", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id, c.id])).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(b.id);
    await sendEvt(c.id, disp.task_id, "cancel", { text: "abort" });

    for (const recipient of [a, b]) {
      const events = await pollTaskEvents(recipient.id);
      const cx = events.find((e) => e.payload.intent === "cancel");
      expect(cx?.push).toBe(true);
    }

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("R10: observer rule wins over targeted question", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    const c = await registerPeer({ summary: "C" });
    const disp = (await dispatchS5(a.id, [b.id], { observers: [c.id] })).data as PushDispatchResp;
    await pollTaskEvents(a.id);
    await pollTaskEvents(c.id);
    // B asks a question TARGETED AT C. Observer rule must still suppress
    // C's push — observer is first in the filter chain.
    await sendEvt(b.id, disp.task_id, "question", { text: "for C", data: { to: c.id } });

    const cEvents = await pollTaskEvents(c.id);
    const q = cEvents.find((e) => e.payload.intent === "question");
    expect(q?.push).toBe(false);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  // ---- I: Integration — Appendix A worked example ----

  test("I1: Appendix A full cycle yields 10 total pushes (A=4, B=4, C=2)", async () => {
    // A=coordinator, B=impl, C=reviewer. Parent spec Appendix A.
    const a = await registerPeer({ summary: "coordinator" });
    const b = await registerPeer({ summary: "impl-backend-A" });
    const c = await registerPeer({ summary: "reviewer-backend-A" });

    const disp = (await dispatchS5(a.id, [b.id, c.id], { text: "dispatch" })).data as PushDispatchResp;
    const tid = disp.task_id;

    // 8 follow-on events (slice-5 interpretation of Appendix A):
    //   2: B state_change→working
    //   3: B question (to: A)
    //   4: A answer (reply_to_from: B)
    //   5: B state_change→done
    //   6: C state_change→working
    //   7: C state_change→done
    //   8: C complete
    await sendEvt(b.id, tid, "state_change", { data: { to: "working" } });
    await sendEvt(b.id, tid, "question", { text: "nullable?", data: { to: a.id } });
    await sendEvt(a.id, tid, "answer", { text: "yes nullable", data: { reply_to_from: b.id } });
    await sendEvt(b.id, tid, "state_change", { data: { to: "done" } });
    await sendEvt(c.id, tid, "state_change", { data: { to: "working" } });
    await sendEvt(c.id, tid, "state_change", { data: { to: "done" } });
    await sendEvt(c.id, tid, "complete", { text: "approved" });

    const counts = { a: 0, b: 0, c: 0 };
    for (const [label, peer] of [["a", a], ["b", b], ["c", c]] as const) {
      const events = await pollTaskEvents(peer.id);
      for (const e of events) if (e.push === true) counts[label]++;
    }

    // Expected from re-derivation against the rules (spec table, not the
    // summary — see design-doc amendment noting the parent-spec inconsistency):
    //   A (coord): pushes on events 3, 5, 7, 8 = 4
    //   B (impl):  pushes on events 1, 4, 7, 8 = 4
    //   C (rev):   pushes on events 1, 5 = 2
    //   Total: 10 of 24 receiver-event pairs → 58% suppression.
    // Parent spec §Appendix A summary states impl=3/total=9; table-derived
    // count is impl=4/total=10. Separate docs fix-up commit in this slice
    // corrects docs/a2a-lite.md §Appendix A.
    expect(counts.a).toBe(4);
    expect(counts.b).toBe(4);
    expect(counts.c).toBe(2);

    for (const p of [a, b, c]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  // ---- M: Message event regression ----

  test("M1: message events in poll batch have push=true explicitly", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "hello" });
    const { data } = await brokerFetch<{ events: PushPollEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    const msg = data.events.find((e) => e.type === "message");
    expect(msg).toBeDefined();
    expect(msg!.push).toBe(true);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });

  test("M2: mixed batch — message push=true, observer task_event push=false", async () => {
    const a = await registerPeer({ summary: "A" });
    const b = await registerPeer({ summary: "B" });
    await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "hello" });
    await dispatchS5(a.id, [], { observers: [b.id] });

    const { data } = await brokerFetch<{ events: PushPollEvent[] }>("/poll-messages", {
      id: b.id,
      wait_ms: 0,
    });
    const msg = data.events.find((e) => e.type === "message");
    const te = data.events.find((e) => e.type === "task_event");
    expect(msg?.push).toBe(true);
    expect(te?.push).toBe(false);

    for (const p of [a, b]) {
      await brokerFetch("/unregister", { id: p.id });
      await killPeer(p.proc);
    }
  });
});

describe("A2A-lite SSE tail (Slice 6)", () => {
  // Tests exercise GET /events/stream. Each opens an HTTP stream, reads
  // one or two SSE frames, then cancels cleanly. Failure to cancel a
  // stream leaks a subscriber into the broker's set and can affect
  // subsequent tests' counts.

  const CLI_SCRIPT = path.join(import.meta.dir, "cli.ts");

  async function openSse(): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>;
    cancel: () => Promise<void>;
  }> {
    const res = await fetch(`${BROKER_URL}/events/stream`);
    if (!res.ok || !res.body) throw new Error(`SSE handshake failed: ${res.status}`);
    const reader = res.body.getReader();
    return {
      reader,
      cancel: async () => {
        try { await reader.cancel(); } catch { /* noop */ }
      },
    };
  }

  // Read from the SSE reader until we collect `count` complete frames or
  // `timeoutMs` elapses. Each frame ends with `\n\n`. Returns parsed JSON
  // envelopes.
  async function readFrames(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    count: number,
    timeoutMs = 2000
  ): Promise<Array<{ event_id: number; type: string; payload: Record<string, unknown>; push?: boolean }>> {
    const dec = new TextDecoder();
    let buf = "";
    const frames: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const raceResult = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining)
        ),
      ]);
      if (raceResult.done) break;
      buf += dec.decode(raceResult.value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        frames.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        idx = buf.indexOf("\n\n");
      }
    }
    return frames.map((frame) => {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) return { event_id: -1, type: "", payload: {} };
      return JSON.parse(dataLine.slice(5).trim());
    });
  }

  async function sseSubscriberCount(): Promise<number> {
    const { data } = await brokerFetch<{ sse_subscribers?: number }>("/debug/waiters");
    return data.sse_subscribers ?? 0;
  }

  // ---- H: Handshake ----

  test("H1: GET /events/stream returns 200 with text/event-stream content type", async () => {
    const res = await fetch(`${BROKER_URL}/events/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  test("H2: /debug/waiters exposes sse_subscribers count", async () => {
    const before = await sseSubscriberCount();
    const { cancel } = await openSse();
    await new Promise((r) => setTimeout(r, 100));
    const during = await sseSubscriberCount();
    expect(during).toBe(before + 1);
    await cancel();
    await new Promise((r) => setTimeout(r, 100));
    const after = await sseSubscriberCount();
    expect(after).toBe(before);
  });

  // ---- F: Fan-out ----

  test("F1: /send-message fans out to SSE subscriber", async () => {
    const { reader, cancel } = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "sse test" });
      const frames = await readFrames(reader, 1);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0]!.type).toBe("message");
      expect((frames[0]!.payload as { text: string }).text).toBe("sse test");
      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await cancel();
    }
  });

  test("F2: /dispatch-task fans out to SSE subscriber", async () => {
    const { reader, cancel } = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/dispatch-task", {
        from_id: a.id,
        title: "sse dispatch",
        participants: [b.id],
      });
      const frames = await readFrames(reader, 1);
      const te = frames.find((f) => f.type === "task_event");
      expect(te).toBeDefined();
      expect((te!.payload as { intent: string }).intent).toBe("dispatch");
      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await cancel();
    }
  });

  test("F3: /send-task-event fans out to SSE subscriber", async () => {
    const { reader, cancel } = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      const disp = await brokerFetch<{ task_id: string }>("/dispatch-task", {
        from_id: a.id,
        title: "sse ev",
        participants: [b.id],
      });
      const tid = disp.data.task_id;
      await brokerFetch("/send-task-event", {
        from_id: b.id,
        task_id: tid,
        intent: "state_change",
        data: { to: "done" },
      });
      const frames = await readFrames(reader, 2);
      const sc = frames.find((f) =>
        f.type === "task_event" &&
        (f.payload as { intent: string }).intent === "state_change"
      );
      expect(sc).toBeDefined();
      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await cancel();
    }
  });

  test("F4: SSE tail sees all events — push reflects receiver-independent rule only (D10)", async () => {
    // Per D10: SSE's push field reflects the receiver-independent portion
    // of shouldPush — currently just rule 3 (state_change→working). A
    // dispatch event is not rule 3, so its SSE frame shows push=true even
    // when observers are present (observer is a per-receiver rule, not
    // evaluated on SSE).
    const { reader, cancel } = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      const c = await registerPeer({ summary: "C" });
      await brokerFetch("/dispatch-task", {
        from_id: a.id,
        title: "observer test",
        participants: [b.id],
        observers: [c.id],
      });
      const frames = await readFrames(reader, 1);
      const te = frames.find((f) => f.type === "task_event");
      expect(te).toBeDefined();
      expect(te!.push).toBe(true);
      for (const p of [a, b, c]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await cancel();
    }
  });

  test("F4b: SSE frame shows push=false for state_change→working (rule 3 is receiver-independent)", async () => {
    const { reader, cancel } = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      const disp = await brokerFetch<{ task_id: string }>("/dispatch-task", {
        from_id: a.id,
        title: "rule-3 test",
        participants: [b.id],
      });
      const tid = disp.data.task_id;
      await brokerFetch("/send-task-event", {
        from_id: b.id,
        task_id: tid,
        intent: "state_change",
        data: { to: "working" },
      });
      const frames = await readFrames(reader, 2);
      const sc = frames.find((f) =>
        f.type === "task_event" &&
        (f.payload as { intent: string }).intent === "state_change"
      );
      expect(sc).toBeDefined();
      expect(sc!.push).toBe(false);

      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await cancel();
    }
  });

  // ---- M: Multi-subscriber ----

  test("M1: two subscribers both receive the same event", async () => {
    const sub1 = await openSse();
    const sub2 = await openSse();
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "two subs" });
      const [f1, f2] = await Promise.all([
        readFrames(sub1.reader, 1),
        readFrames(sub2.reader, 1),
      ]);
      expect((f1[0]!.payload as { text: string }).text).toBe("two subs");
      expect((f2[0]!.payload as { text: string }).text).toBe("two subs");
      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await sub1.cancel();
      await sub2.cancel();
    }
  });

  test("M2: one subscriber disconnecting does not affect remaining", async () => {
    const sub1 = await openSse();
    const sub2 = await openSse();
    await sub1.cancel();
    await new Promise((r) => setTimeout(r, 100));
    try {
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "remaining sub" });
      const frames = await readFrames(sub2.reader, 1);
      expect(frames.length).toBe(1);
      expect((frames[0]!.payload as { text: string }).text).toBe("remaining sub");
      const count = await sseSubscriberCount();
      expect(count).toBe(1);
      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      await sub2.cancel();
    }
  });

  // ---- D: Disconnect cleanup ----

  test("D1: subscriber count drops to baseline after cancel", async () => {
    const baseline = await sseSubscriberCount();
    const { cancel } = await openSse();
    await new Promise((r) => setTimeout(r, 100));
    expect(await sseSubscriberCount()).toBe(baseline + 1);
    await cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(await sseSubscriberCount()).toBe(baseline);
  });

  test("D2: abrupt body.cancel without reading cleans up subscriber", async () => {
    const baseline = await sseSubscriberCount();
    const res = await fetch(`${BROKER_URL}/events/stream`);
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(await sseSubscriberCount()).toBe(baseline);
  });

  // ---- C: CLI integration ----

  test("C1: bun cli.ts tail subprocess prints incoming message event", async () => {
    const tailProc = Bun.spawn(["bun", CLI_SCRIPT, "tail"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      // Wait for tail to establish the SSE connection
      await new Promise((r) => setTimeout(r, 500));
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "hello tail" });

      // Read tail's stdout until we see the expected line OR 2s elapses
      const reader = (tailProc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let accumulated = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !accumulated.includes("hello tail")) {
        const remaining = deadline - Date.now();
        const step = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), remaining)
          ),
        ]);
        if (step.done) break;
        if (step.value) accumulated += dec.decode(step.value, { stream: true });
      }
      expect(accumulated).toContain("hello tail");
      expect(accumulated).toContain("[message]");
      try { reader.releaseLock(); } catch { /* noop */ }

      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      tailProc.kill();
      await tailProc.exited;
    }
  }, 10_000);

  test("C2: bun cli.ts tail prints both message and task_event lines", async () => {
    const tailProc = Bun.spawn(["bun", CLI_SCRIPT, "tail"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const a = await registerPeer({ summary: "A" });
      const b = await registerPeer({ summary: "B" });
      await brokerFetch("/send-message", { from_id: a.id, to_id: b.id, text: "both test" });
      await brokerFetch("/dispatch-task", {
        from_id: a.id,
        title: "tail task",
        participants: [b.id],
      });

      const reader = (tailProc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let accumulated = "";
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        (!accumulated.includes("[message]") || !accumulated.includes("[task_event]"))
      ) {
        const remaining = deadline - Date.now();
        const step = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), remaining)
          ),
        ]);
        if (step.done) break;
        if (step.value) accumulated += dec.decode(step.value, { stream: true });
      }
      expect(accumulated).toContain("[message]");
      expect(accumulated).toContain("[task_event]");
      try { reader.releaseLock(); } catch { /* noop */ }

      for (const p of [a, b]) {
        await brokerFetch("/unregister", { id: p.id });
        await killPeer(p.proc);
      }
    } finally {
      tailProc.kill();
      await tailProc.exited;
    }
  }, 10_000);
});

// T8 lives in its own describe at the END of the file because it
// restarts the broker subprocess. afterAll's brokerProc.kill() hits
// the replacement broker that T8 spawns (reassigned to the module-scoped
// variable).
describe("Long-poll broker restart (T8 — LAST in file)", () => {
  test("T8 — broker restart cleanly resets waiter state (no zombies after restart)", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t8-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t8-b" });

    const originalPollPromise = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 30000 }
    );
    // Expected to reject when B1 dies mid-flight — silence the rejection
    originalPollPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // Kill B1
    brokerProc.kill();
    await brokerProc.exited;

    // Spawn replacement B2 on same port+DB. Reassign module-scoped brokerProc
    // so afterAll cleans up B2.
    brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(TEST_PORT),
        CLAUDE_PEERS_DB: TEST_DB,
        CLAUDE_PEERS_HOME: TEST_HOME,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Wait for B2 health (same pattern as beforeAll)
    let b2Ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`${BROKER_URL}/health`);
        if (res.ok) { b2Ready = true; break; }
      } catch { /* not yet */ }
    }
    expect(b2Ready).toBe(true);

    // B2 starts with empty waiter map
    const { data: debugAfterRestart } = await brokerFetch<DebugWaitersResponse>(
      "/debug/waiters"
    );
    expect(debugAfterRestart.size).toBe(0);

    // New waiter installs on B2; new send resolves it
    const newPollPromise = brokerFetch<LongPollResponse>(
      "/poll-messages",
      { id: aid, wait_ms: 5000 }
    );
    await new Promise((r) => setTimeout(r, 50));
    await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "post-restart" });

    const { data } = await newPollPromise;
    expect(data.events.length).toBe(1);
    expect(data.events[0]!.payload.text).toBe("post-restart");

    // Waiter cleared after resolution
    const { data: debugAfterResolve } = await brokerFetch<DebugWaitersResponse>(
      "/debug/waiters"
    );
    expect(debugAfterResolve.peers.find((p) => p.peer_id === aid)).toBeUndefined();

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });
});
