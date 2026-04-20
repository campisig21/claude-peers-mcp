import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import path from "path";
import os from "os";
import fs from "fs";

// Slice 7 tests: cli.ts replay subcommand. Each test seeds a fresh temp DB
// + temp $CLAUDE_PEERS_HOME, runs `bun cli.ts replay ...` as a subprocess,
// and asserts on file contents or exit codes. No broker runs — the CLI
// operates directly against the DB, which is the whole point of the
// safety-net subcommand.

const CLI_SCRIPT = path.join(import.meta.dir, "cli.ts");

interface SeededEvent {
  intent: string;
  from_id: string;
  text?: string | null;
  data?: string | null;
  sent_at?: string;
}

interface SeededTask {
  id: string;
  title: string;
  created_by: string;
  context_id?: string | null;
  state?: string;
  created_at?: string;
  participants: Array<{ peer_id: string; role_at_join: string | null }>;
  events: SeededEvent[];
}

let TEST_DB: string;
let TEST_HOME: string;

function initSchema(db: Database): void {
  // Minimal subset of the broker's schema needed for replay. Mirrors slices
  // 1-5 CREATE statements; we don't need messages or task_event_cursors.
  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      tty TEXT,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      title TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS task_participants (
      task_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      role_at_join TEXT,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (task_id, peer_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      text TEXT,
      data TEXT,
      sent_at TEXT NOT NULL
    )
  `);
}

function seedPeer(db: Database, id: string, role: string | null = null): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, role, status)
     VALUES (?, 0, '/tmp', NULL, NULL, '', ?, ?, ?, 'active')`,
    [id, now, now, role]
  );
}

function seedTask(db: Database, t: SeededTask): void {
  const now = t.created_at ?? new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, context_id, state, title, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [t.id, t.context_id ?? null, t.state ?? "open", t.title, now, t.created_by]
  );
  for (const p of t.participants) {
    db.run(
      `INSERT INTO task_participants (task_id, peer_id, role_at_join, joined_at)
       VALUES (?, ?, ?, ?)`,
      [t.id, p.peer_id, p.role_at_join, now]
    );
  }
  for (const e of t.events) {
    db.run(
      `INSERT INTO task_events (task_id, from_id, intent, text, data, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [t.id, e.from_id, e.intent, e.text ?? null, e.data ?? null, e.sent_at ?? now]
    );
  }
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PEERS_DB: TEST_DB,
    CLAUDE_PEERS_HOME: TEST_HOME,
  } as Record<string, string>;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI_SCRIPT, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, stdout, stderr };
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  TEST_DB = path.join(os.tmpdir(), `claude-peers-replay-test-${stamp}.db`);
  TEST_HOME = path.join(os.tmpdir(), `claude-peers-replay-home-${stamp}`);
  const db = new Database(TEST_DB);
  db.run("PRAGMA journal_mode = WAL");
  initSchema(db);
  db.close();
});

afterEach(() => {
  try { fs.unlinkSync(TEST_DB); } catch { /* noop */ }
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch { /* noop */ }
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch { /* noop */ }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("cli.ts replay (Slice 7)", () => {
  // ---- S: Single-task replay ----

  test("S1: replay <T-n> writes the task file with expected structure", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedPeer(db, "bob");
    seedTask(db, {
      id: "T-1",
      title: "Test task",
      created_by: "alice",
      participants: [
        { peer_id: "alice", role_at_join: "dispatcher" },
        { peer_id: "bob", role_at_join: null },
      ],
      events: [
        { intent: "dispatch", from_id: "alice", text: "do it" },
        { intent: "state_change", from_id: "bob", data: JSON.stringify({ to: "done" }) },
      ],
    });
    db.close();

    const res = await runCli(["replay", "T-1"]);
    expect(res.exitCode).toBe(0);

    const filePath = path.join(TEST_HOME, "tasks", "T-1.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const contents = fs.readFileSync(filePath, "utf8");
    expect(contents).toContain("# T-1");
    expect(contents).toContain("Test task");
    expect(contents).toContain("## Events");
    expect(contents).toMatch(/dispatch/);
    expect(contents).toMatch(/state_change/);
  });

  test("S2: replay is idempotent — two runs produce identical contents", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedTask(db, {
      id: "T-2",
      title: "Idempotent",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "first" }],
    });
    db.close();

    await runCli(["replay", "T-2"]);
    const filePath = path.join(TEST_HOME, "tasks", "T-2.md");
    const first = fs.readFileSync(filePath, "utf8");
    await runCli(["replay", "T-2"]);
    const second = fs.readFileSync(filePath, "utf8");
    expect(second).toBe(first);
  });

  test("S3: replay overwrites drifted existing file content", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedTask(db, {
      id: "T-3",
      title: "Overwrite",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "real content" }],
    });
    db.close();

    const filePath = path.join(TEST_HOME, "tasks", "T-3.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "GARBAGE\nSTALE\nDATA\n");
    await runCli(["replay", "T-3"]);
    const contents = fs.readFileSync(filePath, "utf8");
    expect(contents).not.toContain("GARBAGE");
    expect(contents).toContain("real content");
  });

  test("S4: replay <nonexistent-T-n> exits non-zero with task-not-found message", async () => {
    const res = await runCli(["replay", "T-9999"]);
    expect(res.exitCode).not.toBe(0);
    const output = res.stderr + res.stdout;
    expect(output).toMatch(/T-9999/);
    expect(output).toMatch(/not found/i);
  });

  test("S5: replay with invalid id exits non-zero with invalid-id message", async () => {
    const res = await runCli(["replay", "not-a-task-id"]);
    expect(res.exitCode).not.toBe(0);
    const output = res.stderr + res.stdout;
    expect(output).toMatch(/invalid task id/i);
  });

  // ---- A: All-replay ----

  test("A1: replay all writes one file per task in DB", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedTask(db, {
      id: "T-10",
      title: "One",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "one" }],
    });
    seedTask(db, {
      id: "T-11",
      title: "Two",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "two" }],
    });
    seedTask(db, {
      id: "T-12",
      title: "Three",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "three" }],
    });
    db.close();

    const res = await runCli(["replay", "all"]);
    expect(res.exitCode).toBe(0);

    for (const tid of ["T-10", "T-11", "T-12"]) {
      const fp = path.join(TEST_HOME, "tasks", `${tid}.md`);
      expect(fs.existsSync(fp)).toBe(true);
    }
  });

  test("A2: replay all with empty DB exits 0 with informational message", async () => {
    const res = await runCli(["replay", "all"]);
    expect(res.exitCode).toBe(0);
    const output = res.stderr + res.stdout;
    expect(output).toMatch(/no tasks/i);
  });

  // ---- E: Error modes ----

  test("E1: DB missing — replay reports friendly error, exits non-zero", async () => {
    const res = await runCli(["replay", "all"], {
      CLAUDE_PEERS_DB: "/tmp/nonexistent-claude-peers-db-slice7.db",
    });
    expect(res.exitCode).not.toBe(0);
    const output = res.stderr + res.stdout;
    expect(output).toMatch(/no persisted peers database|not found/i);
  });

  test("E2: replay with no args prints usage + exits non-zero", async () => {
    const res = await runCli(["replay"]);
    expect(res.exitCode).not.toBe(0);
    const output = res.stderr + res.stdout;
    expect(output).toMatch(/usage|task_id|all/i);
  });

  // ---- R: Role lookup ----

  test("R1: participant labels include (role) when peer has a role set", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice", "coordinator");
    seedPeer(db, "bob", "impl-backend-A");
    seedTask(db, {
      id: "T-20",
      title: "Role labels",
      created_by: "alice",
      participants: [
        { peer_id: "alice", role_at_join: "dispatcher" },
        { peer_id: "bob", role_at_join: null },
      ],
      events: [{ intent: "dispatch", from_id: "alice", text: "go" }],
    });
    db.close();

    await runCli(["replay", "T-20"]);
    const contents = fs.readFileSync(path.join(TEST_HOME, "tasks", "T-20.md"), "utf8");
    expect(contents).toMatch(/alice\s*\(coordinator\)/);
    expect(contents).toMatch(/bob\s*\(impl-backend-A\)/);
  });

  test("R2: role lookup is read-at-replay-time, not snapshot-at-event-time (D4)", async () => {
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedPeer(db, "bob", "impl-v1");
    seedTask(db, {
      id: "T-21",
      title: "Rebind",
      created_by: "alice",
      participants: [
        { peer_id: "alice", role_at_join: "dispatcher" },
        { peer_id: "bob", role_at_join: null },
      ],
      events: [{ intent: "dispatch", from_id: "alice", text: "v1 era" }],
    });
    // Bob rebinds to a new role AFTER the event was written.
    db.run("UPDATE peers SET role = 'impl-v2' WHERE id = 'bob'");
    db.close();

    await runCli(["replay", "T-21"]);
    const contents = fs.readFileSync(path.join(TEST_HOME, "tasks", "T-21.md"), "utf8");
    // D4: replay labels bob with the CURRENT role, not v1.
    expect(contents).toContain("impl-v2");
    expect(contents).not.toContain("impl-v1");
  });

  // ---- C: Coexistence smoke (broker running) ----

  test("C1: replay succeeds against a DB that has schema + rows (no broker running)", async () => {
    // This slice's broker-running-at-same-time coexistence is documented as
    // safe via WAL readonly. The slice-level smoke is that we can at least
    // operate cleanly on a live-schema DB. A full broker-coexistence test
    // would spawn the broker and duplicate broker.test.ts infrastructure —
    // out of scope for this focused slice.
    const db = new Database(TEST_DB);
    seedPeer(db, "alice");
    seedTask(db, {
      id: "T-30",
      title: "Coexist",
      created_by: "alice",
      participants: [{ peer_id: "alice", role_at_join: "dispatcher" }],
      events: [{ intent: "dispatch", from_id: "alice", text: "ok" }],
    });
    db.close();

    const res = await runCli(["replay", "T-30"]);
    expect(res.exitCode).toBe(0);
    const contents = fs.readFileSync(path.join(TEST_HOME, "tasks", "T-30.md"), "utf8");
    expect(contents).toContain("T-30");
  });
});
