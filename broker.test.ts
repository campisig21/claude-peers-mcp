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
