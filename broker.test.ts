import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";

const TEST_PORT = 17899;
const TEST_DB = path.join(os.tmpdir(), `claude-peers-test-${Date.now()}.db`);
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

    const { data: poll } = await brokerFetch<{ messages: { from_id: string; text: string }[] }>(
      "/poll-messages",
      { id: recvId }
    );
    expect(poll.messages.length).toBeGreaterThan(0);
    const found = poll.messages.find((m) => m.text === msgText);
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
    const { data: firstPoll } = await brokerFetch<{ messages: unknown[] }>("/poll-messages", {
      id: recvId,
    });
    expect(firstPoll.messages.length).toBeGreaterThan(0);

    // Second poll — should be empty (message already delivered)
    const { data: secondPoll } = await brokerFetch<{ messages: unknown[] }>("/poll-messages", {
      id: recvId,
    });
    expect(secondPoll.messages.length).toBe(0);

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
    const { data: poll } = await brokerFetch<{ messages: unknown[] }>("/poll-messages", {
      id: newRecvId,
    });
    expect(poll.messages.length).toBe(0);

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

    const { data: poll } = await brokerFetch<{ messages: { text: string; from_id: string }[] }>(
      "/poll-messages", { id }
    );
    const found = poll.messages.find((m) => m.text === "hello via exact match");
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

    const { data: poll } = await brokerFetch<{ messages: { text: string; from_id: string }[] }>(
      "/poll-messages", { id }
    );
    const found = poll.messages.find((m) => m.text === "hook-attributed message");
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

type LongPollEvent = {
  event_id: number;
  type: "message" | "task_event";
  payload: {
    id: number;
    from_id: string;
    to_id: string;
    text: string;
    sent_at: string;
    delivered: boolean | number;
  };
};

type LongPollResponse = {
  events: LongPollEvent[];
  next_cursor: number | null;
};

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

    await brokerFetch("/unregister", { id: aid });
    await brokerFetch("/unregister", { id: bid });
    await killPeer(pa);
    await killPeer(pb);
  });

  test("T5 — waiter replacement: second poll supersedes first", async () => {
    const { id: aid, proc: pa } = await registerPeer({ cwd: "/tmp/t5-a" });
    const { id: bid, proc: pb } = await registerPeer({ cwd: "/tmp/t5-b" });

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

    expect(pollReturnedAt - unregisterStart).toBeLessThan(500);
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
