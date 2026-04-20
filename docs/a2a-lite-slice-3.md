# A2A-lite Slice 3 — Schema + UNION View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the additive DDL from the parent spec (`docs/a2a-lite.md`) — four new tables (`tasks`, `task_participants`, `task_events`, `task_event_cursors`), one index (`idx_task_events_task`), and the `audit_stream` UNION view — with corresponding TypeScript types. No new broker handlers; no new MCP tools. The typed lane exists in the DB but is unreachable from outside until Slice 4 wires the first endpoint.

**Architecture:** Pure additive migration, embedded in the broker's existing startup DDL block (`broker.ts:41-82`). `CREATE TABLE IF NOT EXISTS` / `CREATE VIEW IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` make the migration idempotent — new installs and existing DBs (pre-slice-3) converge to the same schema. Rollback is `DROP` in reverse dependency order; existing `peers` and `messages` tables are untouched throughout.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` — no new runtime dependencies.

---

## Scope Boundary

**In scope:**
- DDL additions in `broker.ts` (one cohesive block, colocated with existing schema).
- Types in `shared/types.ts` (`Task`, `TaskParticipant`, `TaskEvent`, `TaskEventCursor`, `AuditStreamRow`, plus literal-union aliases `TaskState`, `TaskIntent`, `RoleAtJoin`).
- Schema-verification tests in `broker.test.ts` under a new describe block `"A2A-lite schema (Slice 3)"`.
- `audit_stream` behavioral test restricted to the `messages` side (task_events side is unreachable until Slice 4).

**Out of scope (explicitly — deferred to Slice 4):**
- Any `/dispatch-task` or `/send-task-event` endpoint.
- Any prepared statement that INSERTs into task_events (we don't need them yet).
- Any MCP tool exposing the typed lane.
- Any filesystem audit writes.
- Any push-policy logic (slice 5).

**Risk class:** Low. Pure additive DDL, idempotent creation, reversible DROP. No production data migration (all existing tables untouched).

---

## Design Decisions (slice-local, inherited from parent spec)

1. **Foreign keys are declared but not enforced.** `broker.ts` does not set `PRAGMA foreign_keys = ON`, and slice 3 does not change that. FK declarations serve as documentation and machine-readable schema intent; the broker enforces the invariants that matter (active-peer routing) at the application layer. Changing the FK enforcement mode is out of scope.
2. **`task_events.data` stored as TEXT (JSON string), not SQLite's native JSON type.** Matches the parent spec's wire format. Application layer will `JSON.stringify` / `JSON.parse` around the column. This keeps the column portable and sidesteps `bun:sqlite`'s handling of JSON1 extension quirks.
3. **`audit_stream` column set:** `source_id`, `source` (`'message'|'task_event'`), `from_id`, `to_id` (NULL for task_events), `sent_at`, `intent` (`'text'` literal for messages, actual intent for task_events), `task_id` (NULL for messages), `body`, `data` (NULL for messages). This shape matches the parent spec §Schema verbatim.
4. **Ordering inside `audit_stream`:** The view itself does NOT include an `ORDER BY`. Callers order at query time (typically `ORDER BY sent_at ASC` or `ORDER BY sent_at DESC LIMIT N`). Embedding `ORDER BY` in a view forces a sort even when the caller just wants a subset. Slice 7's `replay` CLI will `ORDER BY sent_at ASC`; any future streaming consumer will apply its own ordering.
5. **Index strategy for slice 3:** Only `idx_task_events_task` (on `(task_id, id)`) is created now — this is the lookup pattern Slice 4's audit-file renderer needs. A future `idx_task_events_from` or `idx_task_participants_peer` may be added in Slice 4/5 when their access patterns are confirmed. No premature indexing.
6. **Migration mechanism:** Same pattern as the existing peers-table migration at `broker.ts:59-69` — `CREATE TABLE IF NOT EXISTS` is safe on both fresh DBs and pre-slice-3 DBs. No version column; no up/down migration scripts; SQLite's idempotent DDL is the migration.
7. **No CLI subcommand for audit view in slice 3.** `cli.ts messages` continues to read the `messages` table directly (pre-slice-3 behavior preserved). A `cli.ts audit` subcommand that reads `audit_stream` could ship later; deferring it keeps slice 3 a pure DB-layer change.

---

## Schema (from parent spec §3, reproduced verbatim for implementer convenience)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  title TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES peers(id)
);

CREATE TABLE IF NOT EXISTS task_participants (
  task_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  role_at_join TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (task_id, peer_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (peer_id) REFERENCES peers(id)
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  text TEXT,
  data TEXT,
  sent_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (from_id) REFERENCES peers(id)
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS task_event_cursors (
  peer_id TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (peer_id) REFERENCES peers(id)
);

CREATE VIEW IF NOT EXISTS audit_stream AS
  SELECT
    id AS source_id,
    'message' AS source,
    from_id,
    to_id,
    sent_at,
    'text' AS intent,
    NULL AS task_id,
    text AS body,
    NULL AS data
  FROM messages
  UNION ALL
  SELECT
    id AS source_id,
    'task_event' AS source,
    from_id,
    NULL AS to_id,
    sent_at,
    intent,
    task_id,
    text AS body,
    data
  FROM task_events;
```

---

## Test Plan (for Task 2.5 pre-review)

All tests live in a new `describe("A2A-lite schema (Slice 3)", ...)` block in `broker.test.ts`, inserted **before** the existing `describe("Long-poll broker restart (T8 — LAST in file)", ...)` block (which must remain last). Tests open a second read-only `bun:sqlite` connection to the same DB path used by the broker subprocess — WAL mode permits concurrent readers.

**S1. `tasks` table exists with expected columns.**
Opens the test DB read-only. `PRAGMA table_info(tasks)` returns rows for `id`, `context_id`, `state`, `title`, `created_at`, `created_by`. `id` has `pk=1`. `state` has `dflt_value='open'`. `created_at` and `created_by` are `notnull=1`.

**S2. `task_participants` table exists with composite primary key.**
`PRAGMA table_info(task_participants)` returns columns `task_id`, `peer_id`, `role_at_join`, `joined_at`. Both `task_id` and `peer_id` report `pk > 0` (composite PK — SQLite uses ordinal positions, not a single pk=1 row).

**S3. `task_events` table exists with AUTOINCREMENT id.**
`PRAGMA table_info(task_events)` returns columns `id`, `task_id`, `from_id`, `intent`, `text`, `data`, `sent_at`. `id` has `pk=1`. Verify AUTOINCREMENT by checking that `sqlite_sequence` has (or will have) a row for `task_events` after inserts — in slice 3 we don't have inserts, so verify the CREATE path instead: `SELECT sql FROM sqlite_master WHERE name='task_events'` contains `AUTOINCREMENT`.

**S4. `task_event_cursors` table exists with `peer_id` PK.**
`PRAGMA table_info(task_event_cursors)` returns `peer_id` (pk=1) and `last_event_id` (notnull=1, default 0).

**S5. `idx_task_events_task` index exists on `(task_id, id)`.**
`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name='idx_task_events_task'` returns exactly one row with `tbl_name='task_events'`. `PRAGMA index_info(idx_task_events_task)` returns two rows in order: column `task_id` at seqno 0, column `id` at seqno 1.

**S6. `audit_stream` view exists.**
`SELECT type, sql FROM sqlite_master WHERE name='audit_stream'` returns one row with `type='view'`. The SQL definition contains the 9 expected columns (`source_id`, `source`, `from_id`, `to_id`, `sent_at`, `intent`, `task_id`, `body`, `data`).

**S7. `audit_stream` reflects messages inserted via `/send-message`.**
Register two peers via HTTP. Send a message from A to B. Query `SELECT source, from_id, to_id, body, intent, task_id, data FROM audit_stream WHERE from_id = ?` with A's id. Assert one row with `source='message'`, `intent='text'`, `task_id=null`, `data=null`, `body=<the text>`.

**S8. `audit_stream` starts empty on the task_event side in slice 3.**
After S7 (which put rows into `messages`), query `SELECT COUNT(*) FROM audit_stream WHERE source='task_event'`. Assert 0. This documents that slice 3 does NOT produce task_events on its own; any future test that sees task_event rows must come from slice-4+ behavior.

**S9. Idempotency on restart.**
After S1-S8 run against broker #1, kill the broker subprocess and start a second broker pointing at the same DB path. Assert the second `/health` call succeeds (no DDL error). Re-run a reduced form of S1 (just the existence check) and assert schema is identical.

**S10. Types file compiles.**
Not a runtime test — run `bun build shared/types.ts --target=bun --outdir=/tmp/claude-peers-typecheck` as a step in Task 5 to confirm all new type exports are well-formed. No `.d.ts` generation needed; Bun's bundle step surfaces type errors.

**Pre-review questions for reviewer (yb6oeqry):**
1. Is the S8 assertion worth keeping, or is it obvious enough to skip? Intent is to lock in the "no task_events in slice 3" invariant so a future slice can't silently leak task_event behavior here.
2. Should slice 3 add `PRAGMA foreign_keys = ON`? I've argued no (decision #1 above) — FKs are documentation, and flipping enforcement is a behavior change that could surface latent bugs in the peers/messages tables, which is out of scope for a schema-additive slice. But worth a second look.
3. Should `audit_stream` include an `ORDER BY` in the view definition? I've argued no (decision #4). The alternative is callers forget to sort and get surprising output — but forcing a sort in the view taxes the common case (pagination / `LIMIT N`) to catch a caller error that a type-checked wrapper helper could prevent at the app layer.
4. S3 currently verifies AUTOINCREMENT via `sqlite_master.sql` string match. Cleaner alternative?

---

## File Structure

- **Modify:** `broker.ts` — append the slice-3 DDL block after the existing `messages` table DDL (currently ending at broker.ts:82).
- **Modify:** `shared/types.ts` — append new type declarations after the existing `PollMessagesResponse` interface.
- **Modify:** `broker.test.ts` — insert new `describe` block before the `T8 — LAST in file` block.
- **Create:** `docs/a2a-lite-slice-3.md` — this document.

**Not touched in slice 3:** `server.ts`, `cli.ts`, `server.test.ts`, `README.md`. (README may get a schema reference in slice 4 when the typed tools become user-visible.)

---

## Tasks

### Task 1: Commit the spec doc

**Files:**
- Create: `docs/a2a-lite-slice-3.md` (this file)

- [ ] **Step 1: Verify file exists**

```bash
ls -la docs/a2a-lite-slice-3.md
```

- [ ] **Step 2: Commit**

```bash
git add docs/a2a-lite-slice-3.md
git commit -m "$(cat <<'EOF'
docs: add A2A-lite slice 3 design doc (schema + UNION view)

Plan for additive DDL — four new tables, one index, audit_stream
view, and corresponding TypeScript types. No new handlers, no new
MCP tools. Test plan included for pre-impl review by reviewer-backend.

See docs/a2a-lite.md for parent spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Write failing tests

**Files:**
- Modify: `broker.test.ts` — insert new describe block before `T8 — LAST in file`

- [ ] **Step 1: Add imports**

At the top of `broker.test.ts`, verify `Database` is available — we'll need it for the readonly DB connection. Add:

```typescript
import { Database } from "bun:sqlite";
```

(If already imported, skip.)

- [ ] **Step 2: Add the describe block**

Insert the following block at broker.test.ts, immediately before `describe("Long-poll broker restart (T8 — LAST in file)", ...)`:

```typescript
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
      expect(byName.state!.dflt_value).toMatch(/'open'/);
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
      // Composite PK: both task_id and peer_id have pk > 0 (ordinal position)
      expect(byName.task_id!.pk).toBeGreaterThan(0);
      expect(byName.peer_id!.pk).toBeGreaterThan(0);
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

      // Execute against the view to confirm the column set is what we promise.
      // Using LIMIT 0 keeps this cheap and independent of row content.
      const cols = db.query("SELECT * FROM audit_stream LIMIT 0").columnNames;
      expect(cols.sort()).toEqual(
        ["body", "data", "from_id", "intent", "sent_at", "source", "source_id", "task_id", "to_id"].sort()
      );
    } finally {
      db.close();
    }
  });

  test("S7: audit_stream reflects messages inserted via /send-message", async () => {
    // Use HTTP surface for the producer side — slice 3 doesn't change it.
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
});
```

- [ ] **Step 3: Run the new tests — expect them to FAIL**

```bash
bun test broker.test.ts -t "A2A-lite schema"
```

Expected: S1-S8 all fail with `SQLiteError: no such table: tasks` (or similar) or "view audit_stream does not exist" for S6-S8. S7 also relies on audit_stream existing.

- [ ] **Step 4: Commit the failing tests**

```bash
git add broker.test.ts
git commit -m "$(cat <<'EOF'
test: add slice-3 schema tests (failing)

Add S1-S8 for broker.test.ts under new describe block. Tests open
a readonly bun:sqlite connection to the broker's DB (WAL mode
permits concurrent readers) and verify:
- tasks / task_participants / task_events / task_event_cursors
  tables exist with expected columns and constraints
- idx_task_events_task indexes (task_id, id) in that column order
- audit_stream view exists and exposes the 9 expected columns
- messages inserted via /send-message show up in the view
- no task_event rows in slice 3 (landing-pad invariant)

These fail until the DDL lands in broker.ts in Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.5: Pre-review checkpoint

Ping reviewer yb6oeqry with a short message:

> **slice-3 pre-review:** failing tests landed on `feat/a2a-lite-slice-3`. Scope = schema + view only, no handlers. Test shape: S1-S6 inspect `PRAGMA table_info` / `sqlite_master`, S7 inserts via /send-message and reads via audit_stream (readonly DB connection, WAL-safe), S8 locks in "no task_event rows yet" as a slice-local invariant. Pre-review questions in docs/a2a-lite-slice-3.md §Test Plan. Holding implementation until you greenlight the test shape.

Wait for reviewer feedback. If reviewer asks for test changes, iterate on Task 2 until greenlight.

---

### Task 3: Apply the DDL in broker.ts

**Files:**
- Modify: `broker.ts:71-82` — append the slice-3 DDL block after the `messages` CREATE TABLE

- [ ] **Step 1: Apply the edit**

Insert the following block into `broker.ts` immediately after the `messages` CREATE TABLE (currently ending `)` at line 82, before the `cleanStalePeers` function declaration or similar — find the right anchor):

```typescript
// --- A2A-lite schema (Slice 3) ---
//
// Additive landing pad for typed agent-to-agent events. No handler in the
// broker produces rows in these tables yet — Slice 4 will add /dispatch-task
// and /send-task-event. The audit_stream view is the stable consumer-facing
// shape: callers read the unified feed without needing to know that `messages`
// and `task_events` are physically separate tables.
//
// Foreign keys are declared but not enforced (broker.ts does not set
// PRAGMA foreign_keys = ON). Treat the FK clauses as machine-readable
// schema documentation rather than runtime guarantees.

db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    context_id TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    title TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_participants (
    task_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    role_at_join TEXT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (task_id, peer_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (peer_id) REFERENCES peers(id)
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
    sent_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (from_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_task_events_task
    ON task_events(task_id, id)
`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_event_cursors (
    peer_id TEXT PRIMARY KEY,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (peer_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE VIEW IF NOT EXISTS audit_stream AS
    SELECT
      id AS source_id,
      'message' AS source,
      from_id,
      to_id,
      sent_at,
      'text' AS intent,
      NULL AS task_id,
      text AS body,
      NULL AS data
    FROM messages
    UNION ALL
    SELECT
      id AS source_id,
      'task_event' AS source,
      from_id,
      NULL AS to_id,
      sent_at,
      intent,
      task_id,
      text AS body,
      data
    FROM task_events
`);
```

- [ ] **Step 2: Typecheck**

```bash
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: exits 0.

- [ ] **Step 3: Run slice-3 tests — expect them to PASS**

```bash
bun test broker.test.ts -t "A2A-lite schema"
```

Expected: S1-S8 all pass.

- [ ] **Step 4: Commit**

```bash
git add broker.ts
git commit -m "$(cat <<'EOF'
broker: add A2A-lite schema (tasks, task_events, audit_stream)

Additive DDL for slice 3 per docs/a2a-lite-slice-3.md:
- CREATE TABLE tasks / task_participants / task_events / task_event_cursors
- CREATE INDEX idx_task_events_task ON task_events(task_id, id)
- CREATE VIEW audit_stream (UNION ALL over messages + task_events)

All CREATE statements use IF NOT EXISTS — safe on fresh DBs and
pre-slice-3 DBs alike. Foreign keys declared as schema documentation;
enforcement remains off (PRAGMA foreign_keys unchanged).

No new handlers. The typed lane is unreachable from outside until
slice 4 wires the first endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add TypeScript types

**Files:**
- Modify: `shared/types.ts` — append new types after `PollMessagesResponse`

- [ ] **Step 1: Apply the edit**

Append to `shared/types.ts`:

```typescript
// --- A2A-lite types (Slice 3) ---
//
// These mirror the DB schema introduced in broker.ts's slice-3 DDL. No code
// consumes them yet — they exist so Slice 4's handlers and the CLI audit
// view can type-check against a single source of truth.

export type TaskState = "open" | "waiting" | "done" | "failed";

export type TaskIntent =
  | "dispatch"
  | "state_change"
  | "question"
  | "answer"
  | "complete"
  | "cancel";

export type RoleAtJoin =
  | "dispatcher"
  | "assignee"
  | "reviewer"
  | "collaborator"
  | "observer";

export interface Task {
  id: string;
  context_id: string | null;
  state: TaskState;
  title: string | null;
  created_at: string; // ISO timestamp
  created_by: PeerId;
}

export interface TaskParticipant {
  task_id: string;
  peer_id: PeerId;
  role_at_join: RoleAtJoin | null;
  joined_at: string; // ISO timestamp
}

export interface TaskEvent {
  id: number;
  task_id: string;
  from_id: PeerId;
  intent: TaskIntent;
  text: string | null;
  // Serialized JSON. Application layer parses via JSON.parse. Column is
  // TEXT in SQLite; typed as `string | null` here rather than `unknown`
  // so the serialization boundary is explicit in the type system.
  data: string | null;
  sent_at: string; // ISO timestamp
}

export interface TaskEventCursor {
  peer_id: PeerId;
  last_event_id: number;
}

// Shape of a row from the `audit_stream` view. Discriminated union by
// `source`: 'message' rows always have `task_id === null` and `data === null`;
// 'task_event' rows always have `to_id === null`.
export type AuditStreamRow =
  | {
      source: "message";
      source_id: number;
      from_id: PeerId;
      to_id: PeerId;
      sent_at: string;
      intent: "text";
      task_id: null;
      body: string;
      data: null;
    }
  | {
      source: "task_event";
      source_id: number;
      from_id: PeerId;
      to_id: null;
      sent_at: string;
      intent: TaskIntent;
      task_id: string;
      body: string | null;
      data: string | null;
    };
```

- [ ] **Step 2: Typecheck**

```bash
bun build shared/types.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: all three exit 0. Types shouldn't break anything because nothing imports them yet.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "$(cat <<'EOF'
types: add A2A-lite slice-3 type exports

Add TaskState, TaskIntent, RoleAtJoin literal unions and Task,
TaskParticipant, TaskEvent, TaskEventCursor, AuditStreamRow
interfaces. No consumers in slice 3 — these are the type-level
landing pad for slice 4's handlers.

AuditStreamRow is a discriminated union on `source`, matching
the UNION ALL shape of the audit_stream view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Run full test suite + smoke

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: all tests pass (both slice-3 additions and all prior slices).

- [ ] **Step 2: Clean build of all entry points**

```bash
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build cli.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build shared/types.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: all four exit 0.

- [ ] **Step 3: Idempotency smoke test (S9-equivalent)**

Point the broker at a dedicated smoke DB path, start it, kill it, start again, and verify no DDL errors:

```bash
SMOKE_DB=$(mktemp -u)/smoke.db
mkdir -p "$(dirname "$SMOKE_DB")"
CLAUDE_PEERS_DB="$SMOKE_DB" bun broker.ts &
BROKER_PID=$!
sleep 1
kill "$BROKER_PID"; wait "$BROKER_PID" 2>/dev/null
CLAUDE_PEERS_DB="$SMOKE_DB" bun broker.ts &
BROKER_PID=$!
sleep 1
curl -sS http://127.0.0.1:7899/health | grep -q '"status":"ok"' && echo "idempotent restart OK"
kill "$BROKER_PID"; wait "$BROKER_PID" 2>/dev/null
rm -f "$SMOKE_DB"* 2>/dev/null
```

Expected: prints `idempotent restart OK` twice is fine; at minimum the second run must not crash.

- [ ] **Step 4: git log sanity check**

```bash
git log --oneline origin/main..HEAD
```

Expected: 4 commits (design doc, failing tests, broker DDL, types).

---

### Task 6: Push + open PR for post-impl review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/a2a-lite-slice-3
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: A2A-lite slice 3 — schema + UNION view" --body "$(cat <<'EOF'
## Summary

- Additive DDL: `tasks`, `task_participants`, `task_events`, `task_event_cursors` + `idx_task_events_task` index + `audit_stream` UNION view.
- New TypeScript types: `Task`, `TaskParticipant`, `TaskEvent`, `TaskEventCursor`, `AuditStreamRow`, plus `TaskState` / `TaskIntent` / `RoleAtJoin` literal unions.
- No new broker handlers. No new MCP tools. The typed lane is unreachable from outside until slice 4.
- New test block `"A2A-lite schema (Slice 3)"` with S1-S8 covering schema shape, index definition, and view behavior.

## Test plan

- [x] Failing tests pre-impl (captured as separate commit)
- [x] All tests passing post-impl (`bun test`)
- [x] Idempotency: broker restart on an existing slice-3 DB does not error
- [x] No regressions in pre-existing broker/server tests
- [ ] Reviewer codex pass (medium profile per schema-scope default)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Ping reviewer with PR URL**

Send to yb6oeqry:

> **slice-3 PR open:** `<url>`. 4 commits, ~120 LOC DDL + ~50 LOC types + ~150 LOC tests. Codex profile medium (schema additive; no transactions, no index hot-path changes). Ready for pass-through.

Wait for review. Iterate on findings.

---

### Task 7: Merge

On reviewer greenlight:

```bash
gh pr merge <num> --rebase --delete-branch
git checkout main
git pull --rebase
```

Post-merge ack to reviewer with commit range.

---

## Rollback Procedure

If slice 3 needs to be reverted after merge:

```bash
git revert <sha-of-types-commit>
git revert <sha-of-broker-ddl-commit>
git revert <sha-of-tests-commit>
# Doc revert optional; the design doc is harmless to retain.
```

For any DBs in the wild that already ran slice-3 startup, drop the new schema (safe — no data of record flows through these tables in slice 3):

```sql
DROP VIEW IF EXISTS audit_stream;
DROP INDEX IF EXISTS idx_task_events_task;
DROP TABLE IF EXISTS task_event_cursors;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS task_participants;
DROP TABLE IF EXISTS tasks;
```

Existing `peers` and `messages` tables are untouched throughout.

---

## Impact

Slice 3 is a zero-user-visible change. Its value is entirely as the landing pad for slice 4's `dispatch_task` / `send_task_event` tools and the filesystem-audit renderer. The `audit_stream` view shipping now (before any writer exists for the `task_events` side) means slice 4's tests can be written against a stable read shape: the test for "dispatch_task produces an audit_stream row with source='task_event'" becomes a one-liner query instead of a view-join fixture.

---

*End of slice 3 plan.*
