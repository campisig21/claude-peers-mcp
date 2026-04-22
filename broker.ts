#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetRoleRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  PeerId,
  Message,
  Task,
  TaskParticipant,
  TaskEvent,
  DispatchTaskRequest,
  DispatchTaskResponse,
  SendTaskEventRequest,
  SendTaskEventResponse,
  Event as PeerEvent,
} from "./shared/types.ts";
import { formatTaskId, parseTaskId } from "./shared/task-ids.ts";
import { renderTaskFile, renderTaskEvent } from "./shared/render.ts";
import { shouldPush } from "./shared/push-policy.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const CLAUDE_PEERS_HOME =
  process.env.CLAUDE_PEERS_HOME ?? `${process.env.HOME}/.claude-peers`;
const TASKS_DIR = path.join(CLAUDE_PEERS_HOME, "tasks");

// Version fingerprint: hash of broker.ts content at startup. Lets MCP servers
// detect when the running daemon is stale relative to the code on disk.
const BROKER_VERSION = Bun.hash(await Bun.file(new URL("./broker.ts", import.meta.url).pathname).text()).toString(16);

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

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

// Additive migration for pre-existing DBs: add role + status columns if missing.
// SQLite lacks ADD COLUMN IF NOT EXISTS, so inspect the schema and only ALTER
// the columns that don't exist yet. Distinguishes "already applied" from real errors.
{
  const existingCols = new Set(
    (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!existingCols.has("role")) {
    db.run("ALTER TABLE peers ADD COLUMN role TEXT");
  }
  if (!existingCols.has("status")) {
    db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- A2A-lite schema (Slice 3) ---
//
// Additive landing pad for typed agent-to-agent events. No handler in the
// broker produces rows in these tables yet — Slice 4 will add /dispatch-task
// and /send-task-event. The audit_stream view is the stable consumer-facing
// shape: callers read the unified feed without needing to know that
// `messages` and `task_events` are physically separate tables.
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

// Mark stale peers as dead (PIDs that no longer exist). Runs on startup + interval.
//
// Dead rows are retained — not deleted — so that role bindings survive process
// death and can be reclaimed by a new session registering with the same role.
// A separate (future) purge task should reap ancient dead rows to cap growth.
// Undelivered messages to dead peers are still dropped (dead-letter semantics).
function cleanStalePeers() {
  const peers = db.query(
    "SELECT id, pid FROM peers WHERE status = 'active'"
  ).all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks).
      // Note: on non-root, kill(1, 0) raises EPERM and we'll mark init-owned
      // rows dead. That's fine — real peers are never pid 1.
      process.kill(peer.pid, 0);
    } catch {
      db.run(
        "UPDATE peers SET status = 'dead' WHERE id = ? AND status = 'active'",
        [peer.id]
      );
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// Reap ancient dead rows so the peers table doesn't grow unboundedly. Dead
// rows are retained as role-binding audit trail, but rows older than 30 days
// are effectively forgotten — no one is going to rotate a role that long after
// the prior holder died and expect reclaim to work.
//
// The cutoff is computed in JS as an ISO string so it exactly matches the
// format of `last_seen` (also ISO). SQLite's built-in datetime() returns a
// space-separated string that would compare oddly against ISO timestamps.
const DEAD_PEER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function purgeAncientDeadPeers() {
  const cutoff = new Date(Date.now() - DEAD_PEER_TTL_MS).toISOString();
  db.run(
    "DELETE FROM peers WHERE status = 'dead' AND last_seen < ?",
    [cutoff]
  );
}
purgeAncientDeadPeers();
setInterval(purgeAncientDeadPeers, 24 * 60 * 60 * 1000);

// --- Tasks directory ---
// Ensure the audit directory exists at startup. `fs/promises.mkdir` recursive
// mode is idempotent — safe on both fresh installs and existing deployments.
await fs.mkdir(TASKS_DIR, { recursive: true });

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, role, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active')
`);

const insertPeerWithRole = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, role, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

// Revive an existing dead row as the same peer ID, replacing its process
// metadata. Used when a new session claims a role previously bound to a
// now-dead peer.
const revivePeerByRole = db.prepare(`
  UPDATE peers
     SET pid = ?, cwd = ?, git_root = ?, tty = ?, summary = ?,
         last_seen = ?, registered_at = ?, status = 'active'
   WHERE id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateRole = db.prepare(`
  UPDATE peers SET role = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

// Mark-dead replaces DELETE for peer teardown so role bindings can survive.
// The guard on status prevents redundant writes if the peer is already dead.
const markPeerDead = db.prepare(`
  UPDATE peers SET status = 'dead' WHERE id = ? AND status = 'active'
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers WHERE status = 'active'
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ? AND status = 'active'
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ? AND status = 'active'
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

// ORDER BY id (not sent_at) so next_cursor is monotonic with event_id,
// matching the since_id replay path's ordering. id is AUTOINCREMENT so this
// is also insertion-order-stable when two sends land in the same millisecond.
const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY id ASC
`);

// Replay mode: return all messages for a peer with id > since_id, regardless
// of `delivered` flag. Read-only — does NOT mark events delivered.
const selectSinceId = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND id > ? ORDER BY id ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// Used by handleSendMessage to fetch the just-inserted row by its id.
// Capturing the id from insertMessage.run().lastInsertRowid (rather than
// calling SQLite's last_insert_rowid() later) avoids a fragility class:
// any future write between the INSERT and this SELECT would return the
// wrong row. Pass the id explicitly instead.
const selectMessageById = db.prepare(`
  SELECT * FROM messages WHERE id = ?
`);

// --- A2A-lite prepared statements (Slice 4) ---

// Task id lookup for sequential generation. `id` is TEXT (e.g. "T-10"),
// so lexical sort would rank "T-10" before "T-9". We fetch all ids and
// pick the max numerically in generateTaskId. Small-N is fine — typical
// installations have dozens of tasks, and any future scale-up can swap in
// a dedicated counter table.
const selectAllTaskIds = db.prepare(`
  SELECT id FROM tasks
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (id, context_id, state, title, created_at, created_by)
  VALUES (?, ?, 'open', ?, ?, ?)
`);

const insertTaskParticipant = db.prepare(`
  INSERT INTO task_participants (task_id, peer_id, role_at_join, joined_at)
  VALUES (?, ?, ?, ?)
`);

const insertTaskEvent = db.prepare(`
  INSERT INTO task_events (task_id, from_id, intent, text, data, sent_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const selectTaskById = db.prepare(`
  SELECT * FROM tasks WHERE id = ?
`);

const selectTaskEventById = db.prepare(`
  SELECT * FROM task_events WHERE id = ?
`);

const selectTaskParticipants = db.prepare(`
  SELECT * FROM task_participants WHERE task_id = ?
`);

const selectTaskParticipantExists = db.prepare(`
  SELECT 1 AS present FROM task_participants WHERE task_id = ? AND peer_id = ?
`);

const selectTaskEvents = db.prepare(`
  SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC
`);

// Task events the polling peer should receive: id > cursor AND peer is a
// participant on the event's task. Ordered by id ASC so next_cursor is
// monotonic with the tail of the batch.
const selectTaskEventsSincePeer = db.prepare(`
  SELECT te.* FROM task_events te
  INNER JOIN task_participants tp ON tp.task_id = te.task_id
  WHERE tp.peer_id = ? AND te.id > ? AND te.from_id != ?
  ORDER BY te.id ASC
`);

// Slice 5: same as selectTaskEventsSincePeer but also projects the polling
// peer's role_at_join so shouldPush can apply rule 1 (observer) without a
// second per-event SELECT. role_at_join is broker-internal — stripped from
// the TaskEvent payload before wire serialization.
const selectTaskEventsSincePeerWithRole = db.prepare(`
  SELECT te.*, tp.role_at_join AS _role_at_join FROM task_events te
  INNER JOIN task_participants tp ON tp.task_id = te.task_id
  WHERE tp.peer_id = ? AND te.id > ? AND te.from_id != ?
  ORDER BY te.id ASC
`);

const selectTaskEventCursor = db.prepare(`
  SELECT last_event_id FROM task_event_cursors WHERE peer_id = ?
`);

const upsertTaskEventCursor = db.prepare(`
  INSERT INTO task_event_cursors (peer_id, last_event_id) VALUES (?, ?)
  ON CONFLICT(peer_id) DO UPDATE SET last_event_id = excluded.last_event_id
  WHERE excluded.last_event_id > task_event_cursors.last_event_id
`);

const selectPeerRoles = db.prepare(`
  SELECT id, role FROM peers WHERE role IS NOT NULL
`);

// --- Long-poll waiter state ---
//
// In-memory map of peers currently blocked on /poll-messages. When
// /send-message inserts a row for a target in this map, the waiter is
// resolved immediately — zero-latency delivery. When the timeout fires
// or /unregister is called, the waiter is cancelled with an empty
// response. One waiter per peer; a second poll from the same peer
// cancels and replaces the first (connection-reset reconnect safety).

class BadRequestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadRequestError";
  }
}

type PendingWaiter = {
  resolve: (response: PollMessagesResponse) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  installedAt: number; // ms epoch — surfaced as age_ms in /debug/waiters
};

const pendingWaiters = new Map<PeerId, PendingWaiter>();
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 120_000; // hard cap; requests exceeding this return 400

function cancelWaiter(id: PeerId): void {
  const w = pendingWaiters.get(id);
  if (!w) return;
  clearTimeout(w.timeoutHandle);
  pendingWaiters.delete(id);
  w.resolve({ events: [], next_cursor: null });
}

// --- SSE subscriber state (Slice 6) ---
//
// GET /events/stream subscribers are broadcast-only consumers that see
// every event insert (message or task_event) as it's committed to the DB.
// Subscribers do NOT participate in delivery semantics — no pendingWaiters
// entry, no cursor advance, no delivered-flag flip. They are a forensic
// tail for the broker's operator.

type SseSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Encoded once per subscriber so backpressure/close errors are isolated
  // to the single subscriber that threw. (Not strictly required since the
  // encoder is stateless for UTF-8, but keeps cleanup logic uniform.)
  encoder: TextEncoder;
};

const sseSubscribers = new Set<SseSubscriber>();

// Close the subscriber's controller and remove it from the set. Paired
// operation — D10 cleanup invariant. Safe to call multiple times; the
// controller's close() throws on a closed controller, caught and ignored.
function removeSubscriber(sub: SseSubscriber): void {
  sseSubscribers.delete(sub);
  try { sub.controller.close(); } catch { /* already closed */ }
}

// Slice 6 D10: push value on SSE frames reflects only the receiver-
// independent portion of shouldPush — currently just rule 3
// (state_change→working universally suppressed). Rules 1 (observer),
// 2 (sender), 4 (targeted question), 5 (targeted answer) require
// receiver.peer_id and cannot be evaluated in a broadcast. The
// semantic: "would this event push to a generic non-sender, non-target,
// non-observer participant?"
function ssePushValue(event: PeerEvent<Message | TaskEvent>): boolean {
  if (event.type !== "task_event") return true;
  const te = event.payload as TaskEvent;
  if (te.intent === "state_change" && te.data) {
    try {
      const parsed = JSON.parse(te.data);
      if (parsed?.to === "working") return false;
    } catch { /* malformed data → default push */ }
  }
  return true;
}

// Broadcast an event to all active subscribers. Per-subscriber errors
// are isolated (try/catch around the enqueue), and a throwing subscriber
// is removed from the set so subsequent broadcasts skip it.
//
// Set iteration + delete-during-iteration is safe per ECMAScript: the
// Set's iteration order is insertion-stable, and removing the current
// element during forEach/for-of is well-defined. Subsequent elements
// still visit normally.
function broadcastToSubscribers(event: PeerEvent<Message | TaskEvent>): void {
  if (sseSubscribers.size === 0) return;
  // D10: SSE frame's push is the receiver-independent value, regardless
  // of what the peer-directed poll response carried for the same event.
  const sseFrame = { ...event, push: ssePushValue(event) };
  const serialized = `data: ${JSON.stringify(sseFrame)}\n\n`;
  for (const sub of sseSubscribers) {
    try {
      sub.controller.enqueue(sub.encoder.encode(serialized));
    } catch (err) {
      console.error(
        `[claude-peers broker] SSE fan-out failed for subscriber: ${err instanceof Error ? err.message : String(err)}`
      );
      removeSubscriber(sub);
    }
  }
}

// --- Generate peer ID ---
//
// Peer IDs are human-readable adjective-noun pairs (e.g. "swift-comet").
// The format is private to the broker — every consumer treats PeerId as an
// opaque string, so old-format random IDs from sessions registered against a
// previous broker version continue to coexist without special handling.

const ADJECTIVES = [
  "swift", "quiet", "bright", "brave", "calm", "clever", "eager", "gentle", "happy", "jolly",
  "kind", "lively", "merry", "noble", "proud", "silent", "sleepy", "witty", "bold", "fierce",
  "golden", "silver", "crimson", "azure", "violet", "scarlet", "amber", "jade", "ivory", "cobalt",
  "ruby", "copper", "frosty", "misty", "sunny", "stormy", "dusty", "hazy", "foggy", "breezy",
  "snowy", "starry", "vivid", "wild", "fuzzy", "sharp", "smooth", "fluffy", "lucky", "nimble",
  "sturdy", "mellow", "plucky", "zesty", "glossy", "sleek", "cosmic", "electric", "royal", "dapper",
];

const NOUNS = [
  "otter", "comet", "lantern", "falcon", "cedar", "willow", "river", "meadow", "harbor", "canyon",
  "glacier", "summit", "valley", "forest", "ember", "ocean", "island", "prairie", "tundra", "fox",
  "wolf", "bear", "lynx", "hawk", "owl", "eagle", "raven", "swan", "heron", "robin",
  "finch", "sparrow", "badger", "beaver", "rabbit", "moose", "panda", "tiger", "dolphin", "whale",
  "seal", "crane", "puffin", "kestrel", "marten", "lily", "clover", "fern", "maple", "birch",
  "oak", "pine", "juniper", "quartz", "opal", "nebula", "meteor", "aurora", "breeze", "peak",
];

const idExists = db.prepare("SELECT 1 FROM peers WHERE id = ?");

function generateId(): string {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

  // 60 × 60 = 3600 combinations; collisions are vanishingly rare with the
  // typical handful of live peers, but check anyway since the pool is finite.
  for (let i = 0; i < 50; i++) {
    const id = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!idExists.get(id)) return id;
  }

  // Fallback for the (effectively impossible) case where 50 random picks all
  // collided: append a numeric suffix to a fresh base.
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!idExists.get(id)) return id;
  }

  throw new Error("could not generate unique peer id");
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();

  // Mark any existing ACTIVE registration for this PID as dead (re-registration).
  // Only active rows match: dead rows with the same (reused) PID are unrelated
  // audit trail and must not be touched, or we'd wipe their role bindings.
  const existing = db.query(
    "SELECT id FROM peers WHERE pid = ? AND status = 'active'"
  ).get(body.pid) as { id: string } | null;
  if (existing) {
    markPeerDead.run(existing.id);
  }

  // Role-aware path: claim or reclaim a role-bound ID.
  if (body.role) {
    // A LIVE peer already holding this role is a hard conflict. The caller
    // must either pick a different role or tear the other session down first.
    const liveWithRole = db.query(
      "SELECT id FROM peers WHERE role = ? AND status = 'active'"
    ).get(body.role) as { id: string } | null;
    if (liveWithRole) {
      throw new Error(
        `role '${body.role}' already held by active peer ${liveWithRole.id}`
      );
    }

    // A DEAD peer previously bound to this role: revive its row so the new
    // session inherits the same peer ID. Most-recent dead holder wins if
    // there are multiple (shouldn't happen under normal use).
    const deadWithRole = db.query(
      "SELECT id FROM peers WHERE role = ? AND status = 'dead' ORDER BY last_seen DESC LIMIT 1"
    ).get(body.role) as { id: string } | null;
    if (deadWithRole) {
      revivePeerByRole.run(
        body.pid,
        body.cwd,
        body.git_root,
        body.tty,
        body.summary,
        now,
        now,
        deadWithRole.id
      );
      return { id: deadWithRole.id };
    }

    // First-time claim of this role: fresh ID, bind the role on insert.
    const id = generateId();
    insertPeerWithRole.run(
      id,
      body.pid,
      body.cwd,
      body.git_root,
      body.tty,
      body.summary,
      now,
      now,
      body.role
    );
    return { id };
  }

  // No role — original role-less path.
  const id = generateId();
  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    now,
    now
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetRole(body: SetRoleRequest): { ok: boolean; error?: string } {
  // Reject if another ACTIVE peer already holds this role. Dead holders are
  // fine — setting the role on a live peer will simply shadow the dead row's
  // binding (the next revive lookup prefers the most-recent dead holder, and
  // since this live peer is about to die with the role still set, that's
  // correct).
  if (body.role) {
    const conflict = db.query(
      "SELECT id FROM peers WHERE role = ? AND status = 'active' AND id != ?"
    ).get(body.role, body.id) as { id: string } | null;
    if (conflict) {
      return {
        ok: false,
        error: `role '${body.role}' already held by active peer ${conflict.id}`,
      };
    }
  }
  updateRole.run(body.role, body.id);
  return { ok: true };
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive. Filter out any that are gone and
  // mark them dead inline so the next list_peers doesn't re-check them. Role
  // bindings on the dead row are preserved for reclamation.
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      markPeerDead.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target is an ACTIVE peer. Dead rows (role audit trail) are not
  // routable — pretend they don't exist as far as messaging is concerned.
  const target = db.query(
    "SELECT id FROM peers WHERE id = ? AND status = 'active'"
  ).get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  // Capture the inserted row's id directly from the run result so any
  // future intervening INSERT (e.g. an audit-log write added later) can't
  // alias last_insert_rowid() and return the wrong message to the waiter.
  const insertResult = insertMessage.run(
    body.from_id,
    body.to_id,
    body.text,
    new Date().toISOString()
  );
  const insertedId = Number(insertResult.lastInsertRowid);
  const row = selectMessageById.get(insertedId) as Message;

  // INVARIANT: no `await` between pendingWaiters.get and the delete+resolve
  // that follows. Atomicity here is the reason T6's concurrent-send test
  // passes deterministically in single-threaded JS. Future refactors that
  // introduce an await in this window MUST reintroduce atomicity (e.g.
  // compare-and-swap pattern) or T6 will start flaking.
  const waiter = pendingWaiters.get(body.to_id);
  if (waiter) {
    clearTimeout(waiter.timeoutHandle);
    pendingWaiters.delete(body.to_id);
    markDelivered.run(row.id);
    waiter.resolve({
      events: [{ event_id: row.id, type: "message", payload: row }],
      next_cursor: row.id,
    });
  }

  // Slice 6: SSE fan-out happens after DB commit AND after waiter resolve.
  // Tail subscribers see every event including ones consumed by the
  // long-poll waiter — see D7 (SSE is not a peer).
  broadcastToSubscribers({ event_id: row.id, type: "message", payload: row, push: true });

  return { ok: true };
}

// --- A2A-lite handlers (Slice 4) ---

// Build a role→peer_id lookup from the current peers table.
// Used by render functions to annotate participant rows with `[role]`.
function buildRoleLookup(): (peer_id: string) => string | null {
  const rows = selectPeerRoles.all() as { id: string; role: string }[];
  const map = new Map(rows.map((r) => [r.id, r.role]));
  return (peer_id: string) => map.get(peer_id) ?? null;
}

// Resolve a participants array — a mix of peer IDs and role names — to
// peer IDs. Role entries must match exactly one live peer.
//
// Invariant: /set-role at broker.ts's handleSetRole rejects live-role
// conflicts (two active peers cannot hold the same role). So a role
// lookup here either returns zero or one row; ambiguity is structurally
// prevented upstream. If you're reading this later and considering
// relaxing that invariant, you'll need to add tiebreak logic here.
//
// Precedence (M3, slice-5 follow-up): peer_id match is attempted FIRST,
// role lookup falls through. If a role name happens to collide with an
// existing peer_id string, the peer_id match wins — the request would
// be targeting that specific peer, not the role holder. In practice
// peer IDs use a bounded adjective-noun format (e.g. "swift-otter") and
// role names are typically longer slash-separated paths (e.g.
// "multi-agent/reviewer-backend-A"), so collisions are effectively
// impossible — but the precedence is deterministic if one ever arises.
function resolveParticipants(raw: string[]): PeerId[] {
  const resolved: PeerId[] = [];
  for (const entry of raw) {
    // Try peer_id first (active peers only).
    const byId = db.query(
      "SELECT id FROM peers WHERE id = ? AND status = 'active'"
    ).get(entry) as { id: string } | null;
    if (byId) {
      resolved.push(byId.id);
      continue;
    }
    // Fall through to role lookup.
    const byRole = db.query(
      "SELECT id FROM peers WHERE role = ? AND status = 'active'"
    ).get(entry) as { id: string } | null;
    if (byRole) {
      resolved.push(byRole.id);
      continue;
    }
    // Check for a DEAD role holder — improves the error message.
    const deadHolder = db.query(
      "SELECT id FROM peers WHERE role = ? AND status = 'dead' ORDER BY last_seen DESC LIMIT 1"
    ).get(entry) as { id: string } | null;
    if (deadHolder) {
      throw new BadRequestError(
        `role '${entry}' not found (held by dead peer ${deadHolder.id}; reclaim by starting a session with CLAUDE_PEER_ROLE=${entry})`
      );
    }
    throw new BadRequestError(
      `participant '${entry}' is neither an active peer id nor a live role name`
    );
  }
  return resolved;
}

function generateTaskId(): string {
  const rows = selectAllTaskIds.all() as { id: string }[];
  let max = 0;
  for (const r of rows) {
    const n = parseTaskId(r.id);
    if (n !== null && n > max) max = n;
  }
  return formatTaskId(max + 1);
}

function formatEventEnvelope(event: TaskEvent): PeerEvent<TaskEvent> {
  return { event_id: event.id, type: "task_event", payload: event };
}

// Synchronously write the initial task markdown file. Logs to stderr on
// failure and continues — the DB is ground truth per D3; slice 7's
// `cli.ts replay` regenerates missing or stale files from DB state.
async function writeDispatchFile(
  task: Task,
  participants: TaskParticipant[],
  events: TaskEvent[]
): Promise<void> {
  try {
    const rendered = renderTaskFile(task, participants, events, buildRoleLookup());
    const filePath = path.join(TASKS_DIR, `${task.id}.md`);
    await fs.writeFile(filePath, rendered, { encoding: "utf8" });
  } catch (err) {
    console.error(
      `[claude-peers broker] audit write failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Append a rendered event to an existing task file. Log on failure + return.
async function appendTaskEventFile(
  taskId: string,
  event: TaskEvent,
  participants: TaskParticipant[]
): Promise<void> {
  try {
    const rendered = renderTaskEvent(event, participants, buildRoleLookup());
    const filePath = path.join(TASKS_DIR, `${taskId}.md`);
    await fs.appendFile(filePath, `\n\n${rendered}\n`, { encoding: "utf8" });
  } catch (err) {
    console.error(
      `[claude-peers broker] audit write failed for ${taskId} event ${event.id}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Deliver a task_event to a single receiver: if they have a pending long-poll
// waiter, resolve it with the event and advance their cursor atomically. If
// they don't have a waiter, we do NOT advance their cursor here — their next
// poll will pick it up via selectTaskEventsSincePeer and advance at delivery
// time. INVARIANT: cursor write and waiter resolve are paired — C5 locks
// this in. The cursor upsert is synchronous (bun:sqlite is sync) and no
// await sits between the upsert and the resolve call, so the next poll
// from this peer cannot see the event as unread.
//
// Slice 5: push flag is computed here from the receiver's task_participants
// row (passed in by caller). The envelope's push field is always set
// explicitly — matches D4's always-explicit discipline.
function deliverTaskEventToPeer(
  receiver: TaskParticipant,
  event: PeerEvent<TaskEvent>
): void {
  const waiter = pendingWaiters.get(receiver.peer_id);
  if (!waiter) return;
  clearTimeout(waiter.timeoutHandle);
  pendingWaiters.delete(receiver.peer_id);
  upsertTaskEventCursor.run(receiver.peer_id, event.event_id);
  const push = shouldPush(event.payload, receiver);
  waiter.resolve({
    events: [{ ...event, push }],
    next_cursor: event.event_id,
  });
}

// Dispatch a new task. Creates tasks, task_participants, first task_events
// row (intent='dispatch'), writes the audit file, and resolves waiters for
// non-sender participants.
//
// D10 footnote: if a role participant resolves to a peer_id that previously
// held the role and was later reclaimed by a new session (via revive), the
// new session inherits participation — this is intentional (role identity
// is stable across revives). See docs/a2a-lite-slice-4.md §D10.
async function handleDispatchTask(
  body: DispatchTaskRequest
): Promise<DispatchTaskResponse> {
  if (!body.from_id) {
    throw new BadRequestError("from_id is required");
  }
  if (!body.title || typeof body.title !== "string") {
    throw new BadRequestError("title is required");
  }
  if (!Array.isArray(body.participants)) {
    throw new BadRequestError("participants must be an array");
  }
  // Slice 5: participants[] alone OR observers[] alone is acceptable.
  // The combined set must be non-empty — dispatching to yourself is not
  // a task, it's a note-to-self.
  const observerCount = Array.isArray(body.observers) ? body.observers.length : 0;
  if (body.participants.length === 0 && observerCount === 0) {
    throw new BadRequestError(
      "at least one participant or observer is required"
    );
  }
  const fromActive = db.query(
    "SELECT id FROM peers WHERE id = ? AND status = 'active'"
  ).get(body.from_id) as { id: string } | null;
  if (!fromActive) {
    throw new BadRequestError(`from_id '${body.from_id}' is not an active peer`);
  }

  const resolved = resolveParticipants(body.participants);
  // Slice 5: observers overlay — resolved separately, same peer_id /
  // role-name mixing allowed. Observers overlay the participants set:
  // any id listed as observer gets role_at_join='observer'. Dispatcher
  // role wins over observer if from_id is in both.
  const resolvedObservers = body.observers
    ? new Set(resolveParticipants(body.observers))
    : new Set<PeerId>();

  // Ensure the dispatcher is in the participants set.
  const participantsSet = new Set<PeerId>(resolved);
  participantsSet.add(body.from_id);
  // Observers are also participants (so they appear in task_participants
  // and receive delivery). Merge them in.
  for (const o of resolvedObservers) participantsSet.add(o);
  const allParticipants = Array.from(participantsSet);

  const now = new Date().toISOString();
  const dataStr = body.data ? JSON.stringify(body.data) : null;

  // Single transaction: generate id + INSERT task + INSERT participants +
  // INSERT first task_event. bun:sqlite is synchronous — no await between
  // generateTaskId's SELECT MAX and the final INSERT — so sequential IDs
  // (D7) are safe even under concurrent /dispatch-task arrivals. Future
  // refactors introducing async inside this block MUST wrap the ID+INSERT
  // in a compare-and-swap or serial queue.
  let taskId: string;
  let eventId: number;
  let taskRow: Task;
  let participantRows: TaskParticipant[];
  let eventRow: TaskEvent;

  const txn = db.transaction(() => {
    taskId = generateTaskId();
    insertTask.run(taskId, body.context_id ?? null, body.title, now, body.from_id);
    for (const p of allParticipants) {
      // Dispatcher wins: from_id is 'dispatcher' even if they appear in
      // observers. Non-dispatcher + observer-listed → 'observer'. Else null.
      let role: string | null;
      if (p === body.from_id) role = "dispatcher";
      else if (resolvedObservers.has(p)) role = "observer";
      else role = null;
      insertTaskParticipant.run(taskId, p, role, now);
    }
    const evRes = insertTaskEvent.run(
      taskId,
      body.from_id,
      "dispatch",
      body.text ?? null,
      dataStr,
      now
    );
    eventId = Number(evRes.lastInsertRowid);
  });
  txn();

  taskRow = selectTaskById.get(taskId!) as Task;
  participantRows = selectTaskParticipants.all(taskId!) as TaskParticipant[];
  eventRow = selectTaskEventById.get(eventId!) as TaskEvent;

  // FS write happens AFTER DB commit. If it fails, DB is still consistent;
  // slice 7 replay can regenerate the file. writeDispatchFile swallows
  // errors internally (logs to stderr).
  await writeDispatchFile(taskRow, participantRows, [eventRow]);

  // Resolve waiters for all non-sender participants. Slice 5 passes the
  // full participant row to deliverTaskEventToPeer so shouldPush can
  // read role_at_join.
  const envelope = formatEventEnvelope(eventRow);
  for (const p of participantRows) {
    if (p.peer_id === body.from_id) continue;
    deliverTaskEventToPeer(p, envelope);
  }

  // Slice 6: SSE fan-out. D10 push-field semantic is applied inside
  // broadcastToSubscribers (ssePushValue computes the receiver-independent
  // value). Dispatch is not state_change→working, so push=true on SSE.
  broadcastToSubscribers(envelope);

  return {
    task_id: taskId!,
    participants: allParticipants,
    event_id: eventId!,
  };
}

async function handleSendTaskEvent(
  body: SendTaskEventRequest
): Promise<SendTaskEventResponse> {
  if (!body.from_id) throw new BadRequestError("from_id is required");
  if (!body.task_id) throw new BadRequestError("task_id is required");
  if (!body.intent) throw new BadRequestError("intent is required");

  const allowedIntents = new Set([
    "state_change",
    "question",
    "answer",
    "complete",
    "cancel",
  ]);
  if (!allowedIntents.has(body.intent)) {
    throw new BadRequestError(
      `intent '${body.intent}' not allowed on /send-task-event (dispatch lives on /dispatch-task)`
    );
  }

  const fromActive = db.query(
    "SELECT id FROM peers WHERE id = ? AND status = 'active'"
  ).get(body.from_id) as { id: string } | null;
  if (!fromActive) {
    throw new BadRequestError(`from_id '${body.from_id}' is not an active peer`);
  }

  const task = selectTaskById.get(body.task_id) as Task | null;
  if (!task) {
    throw new BadRequestError(`task_id '${body.task_id}' not found`);
  }

  const isParticipant = selectTaskParticipantExists.get(body.task_id, body.from_id) as
    | { present: number }
    | null;
  if (!isParticipant) {
    throw new BadRequestError(
      `from_id '${body.from_id}' is not a participant on task ${body.task_id}`
    );
  }

  const hasText = typeof body.text === "string" && body.text.length > 0;
  const hasData = body.data && Object.keys(body.data).length > 0;
  if (!hasText && !hasData) {
    throw new BadRequestError("event must carry at least text or data");
  }

  const now = new Date().toISOString();
  const dataStr = body.data ? JSON.stringify(body.data) : null;

  const evRes = insertTaskEvent.run(
    body.task_id,
    body.from_id,
    body.intent,
    body.text ?? null,
    dataStr,
    now
  );
  const eventId = Number(evRes.lastInsertRowid);
  const eventRow = selectTaskEventById.get(eventId) as TaskEvent;
  const participants = selectTaskParticipants.all(body.task_id) as TaskParticipant[];

  await appendTaskEventFile(body.task_id, eventRow, participants);

  const envelope = formatEventEnvelope(eventRow);
  for (const p of participants) {
    if (p.peer_id === body.from_id) continue;
    deliverTaskEventToPeer(p, envelope);
  }

  // Slice 6: SSE fan-out after waiter resolves.
  broadcastToSubscribers(envelope);

  return { event_id: eventId };
}

function handlePollMessages(body: PollMessagesRequest): Promise<PollMessagesResponse> {
  const { id, wait_ms, since_id } = body;

  // Fail loud on protocol misuse rather than silent clamp. BadRequestError
  // is mapped to HTTP 400 in the fetch handler; generic Error maps to 500.
  // Both the > MAX and the < 0 branch stay consistent with F4's
  // fail-loud-on-protocol-misuse philosophy.
  if (wait_ms !== undefined && wait_ms > MAX_WAIT_MS) {
    throw new BadRequestError(
      `wait_ms=${wait_ms} exceeds MAX_WAIT_MS=${MAX_WAIT_MS}`
    );
  }
  if (wait_ms !== undefined && wait_ms < 0) {
    throw new BadRequestError(
      `wait_ms=${wait_ms} must be >= 0 (use 0 for fast-path)`
    );
  }

  // Gather any immediately-available events. Replay mode (since_id) is
  // read-only — does NOT mark events delivered; task_events are NOT included
  // in replay mode (existing slice-2 behavior preserved for messages only).
  // Normal mode consumes the `delivered=0` queue for messages AND returns
  // any task_events above the peer's task_event_cursor that they participate
  // in.
  const pendingMessages = since_id !== undefined
    ? (selectSinceId.all(id, since_id) as Message[])
    : (selectUndelivered.all(id) as Message[]);

  const cursorRow = since_id === undefined
    ? (selectTaskEventCursor.get(id) as { last_event_id: number } | null)
    : null;
  const taskCursor = cursorRow?.last_event_id ?? 0;
  // Slice 5: JOIN'd query pulls the polling peer's role_at_join for
  // shouldPush rule 1. `_role_at_join` is broker-internal and is not
  // emitted on the wire — stripped before push into the envelope.
  type TaskEventWithRole = TaskEvent & { _role_at_join: string | null };
  const pendingTaskEvents = since_id === undefined
    ? (selectTaskEventsSincePeerWithRole.all(id, taskCursor, id) as TaskEventWithRole[])
    : [];

  const totalCount = pendingMessages.length + pendingTaskEvents.length;
  if (totalCount > 0) {
    if (since_id === undefined) {
      for (const m of pendingMessages) markDelivered.run(m.id);
    }

    const events: PeerEvent<Message | TaskEvent>[] = [];
    // D4: always set push explicitly on slice-5+ events. Message events
    // always push: true (existing behavior). Task events apply shouldPush.
    for (const m of pendingMessages) {
      events.push({ event_id: m.id, type: "message", payload: m, push: true });
    }
    for (const teWithRole of pendingTaskEvents) {
      const { _role_at_join, ...te } = teWithRole;
      const push = shouldPush(te, {
        task_id: te.task_id,
        peer_id: id,
        role_at_join: _role_at_join as TaskParticipant["role_at_join"],
        joined_at: "",
      });
      events.push({ event_id: te.id, type: "task_event", payload: te, push });
    }

    // Advance task_event_cursor to the max task_event id we just delivered.
    if (since_id === undefined && pendingTaskEvents.length > 0) {
      const maxTe = pendingTaskEvents[pendingTaskEvents.length - 1]!.id;
      upsertTaskEventCursor.run(id, maxTe);
    }

    const maxEventId = events.reduce(
      (acc, e) => (e.event_id > acc ? e.event_id : acc),
      0
    );
    return Promise.resolve({
      events: events as PeerEvent<Message>[],
      next_cursor: maxEventId,
    });
  }

  const waitMs = wait_ms ?? DEFAULT_WAIT_MS;
  if (waitMs <= 0) {
    return Promise.resolve({ events: [], next_cursor: null });
  }

  // Install waiter, replacing any prior one for this peer. Replacement
  // exists for the connection-reset-reconnect case: a peer whose previous
  // long-poll connection died will retry; the second poll cancels the
  // first (resolving it with empty events) and installs fresh.
  cancelWaiter(id);

  return new Promise<PollMessagesResponse>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      // Guard against resolve-vs-timeout race: if the current entry in
      // the map isn't this one, someone else (send-message resolve or
      // cancelWaiter) got here first; no-op.
      if (pendingWaiters.get(id)?.timeoutHandle === timeoutHandle) {
        pendingWaiters.delete(id);
        resolve({ events: [], next_cursor: null });
      }
    }, waitMs);
    pendingWaiters.set(id, {
      resolve,
      timeoutHandle,
      installedAt: Date.now(),
    });
  });
}

// GET /events/stream — SSE tail. Opens a ReadableStream, registers the
// controller as a subscriber, wires request.signal.abort to remove the
// subscriber on client disconnect. Stream stays open until client cancels
// or the broker shuts down.
function handleEventsStream(req: Request): Response {
  let subscriber: SseSubscriber | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      subscriber = { controller, encoder };
      sseSubscribers.add(subscriber);
      // Flush the response headers with an initial SSE comment frame.
      // Required because Bun's fetch client closes the connection with
      // ECONNRESET on empty-body streaming responses before any data
      // arrives (observed locally against /events/stream when body
      // starts silent). A leading `:` line is a comment per SSE spec —
      // ignored by compliant consumers including the CLI parser.
      controller.enqueue(encoder.encode(": claude-peers SSE tail\n\n"));
    },
    cancel() {
      if (subscriber) removeSubscriber(subscriber);
    },
  });

  // request.signal fires when the client disconnects. Wiring the listener
  // AFTER subscriber registration ensures we always have the handle to
  // remove, and avoids a race where the client drops before subscriber
  // is assigned (stream.start runs synchronously in practice, but the
  // defensive ordering is cheap insurance).
  req.signal.addEventListener("abort", () => {
    if (subscriber) removeSubscriber(subscriber);
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function handleUnregister(body: { id: string }): void {
  // Cancel any pending long-poll waiter BEFORE marking dead so the poll
  // resolves with empty events. This closes the cleanup-latency window on
  // server-side SIGTERM (MCP server's cleanup handler calls /unregister;
  // the waiter resolve unblocks its driver loop which then exits cleanly).
  cancelWaiter(body.id);

  // Mark dead instead of deleting so that a role bound to this peer can be
  // reclaimed by a future session registering with the same CLAUDE_PEER_ROLE.
  // Without this, a clean SIGTERM/SIGINT would lose the binding and the next
  // session would get a fresh ID despite setting the same role.
  markPeerDead.run(body.id);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [body.id]);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        // `pid` lets MCP servers target a kill when auto-healing a stale
        // broker (version mismatch). Compare-and-swap semantics: clients
        // re-read pid immediately before SIGTERM so two sessions racing
        // the heal can't kill the new broker.
        return Response.json({
          status: "ok",
          peers: (selectAllPeers.all() as Peer[]).length,
          version: BROKER_VERSION,
          pid: process.pid,
        });
      }
      // Debug-only introspection into the long-poll waiter map.
      // Unconditional per slice-2 design — localhost-only broker, non-
      // sensitive data. Format may change without version bump.
      if (path === "/debug/waiters") {
        const now = Date.now();
        const peers = Array.from(pendingWaiters.entries()).map(
          ([peer_id, w]) => ({ peer_id, age_ms: now - w.installedAt })
        );
        // Slice 6: additive field `sse_subscribers` — count of active
        // /events/stream connections. Existing callers continue to read
        // `size` + `peers` unchanged.
        return Response.json({
          size: pendingWaiters.size,
          peers,
          sse_subscribers: sseSubscribers.size,
        });
      }
      // Slice 6: GET /events/stream — SSE tail.
      if (path === "/events/stream") {
        return handleEventsStream(req);
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/set-role":
          return Response.json(handleSetRole(body as SetRoleRequest));
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(await handlePollMessages(body as PollMessagesRequest));
        case "/dispatch-task":
          return Response.json(await handleDispatchTask(body as DispatchTaskRequest));
        case "/send-task-event":
          return Response.json(await handleSendTaskEvent(body as SendTaskEventRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      if (e instanceof BadRequestError) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
