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
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

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

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

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

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
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
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
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
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
