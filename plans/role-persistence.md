---
title: "Plan — claude-peers-mcp role-persistence patch"
aliases:
  - broker role persistence plan
  - Patch-2
  - role-stable peer IDs
date: 2026-04-08
version: cross-cutting
type: plan
status: draft
tags:
  - plan
  - claude-peers-mcp
  - broker
  - patch
  - role-persistence
peer: null
related:
  - "[[_peer-roster]]"
  - "[[Peer coordination protocol]]"
  - "[[HOME]]"
---

# Plan — `claude-peers-mcp` role-persistence patch

> [!note] Where this plan will live during implementation
> This plan is authored in the vault for visibility. When implementation begins, **copy it to `~/claude-peers-mcp/plans/2026-04-08-role-persistence.md`** and work from there. The claude-peers-mcp repo is the target of the patch, so its own `plans/` directory is the correct final home (create it if it doesn't exist).

## Goal

Add **role-based ID persistence** to `claude-peers-mcp` so that when a peer session dies and a new session registers with the same explicit role (e.g., `overseer`, `v0.1.1-author`, `plan-a-holder`), it **reuses the prior peer ID** instead of getting a fresh random adjective-noun name. Net effect: if Greg starts a new overseer session in `pts/7`, the broker recognizes the role claim and hands back the same `rough-bear` (or whatever the role was bound to), making role ↔ name stable across restarts.

## Non-goals

- **Not changing the ID format.** The adjective-noun generator at `broker.ts:132-171` is fine as-is. This patch only changes *which* ID a registering peer receives — not how new IDs are generated.
- **Not breaking backward compatibility.** Clients that don't pass a `role` field work unchanged. Existing sessions without a role keep their current behavior.
- **Not implementing role-based messaging.** `send_message` still targets peer IDs, not roles. Role → ID resolution happens at register time, not per-message. A future enhancement could add `send_to_role`, but it's out of scope here.
- **Not enforcing a role enum.** Role strings are free-form. Conventions live in docs, not code.
- **Not supporting multiple roles per peer.** One role per peer. Simpler semantics.

## Current state

### Files touched by this patch

| File | Current LOC | Role |
|---|---:|---|
| `~/claude-peers-mcp/broker.ts` | 310 | Broker daemon, SQLite schema, HTTP handlers |
| `~/claude-peers-mcp/server.ts` | 555 | Per-session MCP server, tool registration + dispatch |
| `~/claude-peers-mcp/shared/types.ts` | 67 | Shared types for broker ↔ server JSON API |
| `~/claude-peers-mcp/README.md` | 120 | Docs — needs an updated Tools table + Role section |

### Current schema (`broker.ts:35-46`)

```sql
CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  git_root TEXT,
  tty TEXT,
  summary TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
)
```

Rows currently have no `role` column and no `status` column. Dead peers are **deleted entirely** by `cleanStalePeers` (`broker.ts:62-74`), which means role bindings would be lost on process death if we stored role in the row alone.

### Current register flow (`broker.ts:175-187`)

```ts
function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();                          // always fresh
  const now = new Date().toISOString();
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) ...;
  if (existing) deletePeer.run(existing.id);        // PID-based dedup only
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}
```

Key observation: `generateId()` is called unconditionally. There's no path to reuse a prior ID.

### Current `RegisterRequest` (`shared/types.ts:26-32`)

```ts
export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}
```

No `role` field.

### Current MCP tools (`server.ts:169-230`)

Four tools: `list_peers`, `send_message`, `set_summary`, `check_messages`. No `set_role`.

### Current HTTP routes (`broker.ts:282-302`)

`/register`, `/heartbeat`, `/set-summary`, `/list-peers`, `/send-message`, `/poll-messages`, `/unregister`. No `/set-role`.

## Target state

### New schema (additive migration)

```sql
-- New columns, nullable, safe to apply to existing DB:
ALTER TABLE peers ADD COLUMN role TEXT;
ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
```

`role` is nullable (pre-patch peers have null). `status` is `'active'` or `'dead'`; `'dead'` replaces the DELETE behavior so role bindings survive process death and can be reclaimed.

### New register flow

Pseudocode:

```ts
function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();

  // PID dedup unchanged
  const existingByPid = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid);
  if (existingByPid) deletePeer.run(existingByPid.id);

  // Role-based ID reuse: if role specified and a dead peer with same role exists,
  // revive that row instead of generating a new ID.
  if (body.role) {
    const deadWithRole = db.query(`
      SELECT id FROM peers
       WHERE role = ? AND status = 'dead'
       ORDER BY last_seen DESC
       LIMIT 1
    `).get(body.role);

    if (deadWithRole) {
      // Revive the dead row with new process metadata, same ID
      db.run(`
        UPDATE peers
           SET pid = ?, cwd = ?, git_root = ?, tty = ?, summary = ?,
               last_seen = ?, status = 'active', registered_at = ?
         WHERE id = ?
      `, [body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now, deadWithRole.id]);
      return { id: deadWithRole.id };
    }

    // Role specified but no prior dead peer with that role.
    // Check for a LIVE conflict — another active peer already holds this role.
    const liveWithRole = db.query(`
      SELECT id FROM peers WHERE role = ? AND status = 'active'
    `).get(body.role);
    if (liveWithRole) {
      // Reject: caller must pick a different role or kill the live holder first.
      throw new Error(`role '${body.role}' already held by peer ${liveWithRole.id}`);
    }

    // Fresh ID with role bound on insert
    const id = generateId();
    insertPeerWithRole.run(id, body.pid, body.cwd, body.git_root, body.tty,
                           body.summary, now, now, body.role);
    return { id };
  }

  // No role — original behavior, fresh random ID, role = null
  const id = generateId();
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty,
                 body.summary, now, now);  // role defaults to null
  return { id };
}
```

### New `cleanStalePeers` flow

Instead of `DELETE FROM peers WHERE id = ?`, mark status:

```ts
db.run("UPDATE peers SET status = 'dead' WHERE id = ? AND status = 'active'", [peer.id]);
db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
// Messages still cleaned up — dead-letter semantics preserved.
```

Add a **separate** periodic purge (e.g., weekly) that deletes `status = 'dead'` rows older than 30 days. This caps DB growth without losing recent role bindings.

### New `list_peers` filter

`handleListPeers` currently selects from `peers` with no status filter. Must add `WHERE status = 'active'` to every `SELECT * FROM peers ...` query.

### New `set_role` MCP tool + broker endpoint

**`shared/types.ts` additions:**

```ts
export interface SetRoleRequest {
  id: PeerId;
  role: string | null;  // null to clear the role
}

// Extend RegisterRequest:
export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  role?: string;  // NEW — optional, set at startup from CLAUDE_PEER_ROLE env var
}

// Extend Peer:
export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
  role: string | null;   // NEW
  status: "active" | "dead";  // NEW
}
```

**`broker.ts` additions:**

```ts
// New prepared statements
const insertPeerWithRole = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, role, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const updateRole = db.prepare(`
  UPDATE peers SET role = ? WHERE id = ?
`);

function handleSetRole(body: SetRoleRequest): { ok: boolean; error?: string } {
  // Reject if another ACTIVE peer already holds this role
  if (body.role) {
    const conflict = db.query(`
      SELECT id FROM peers WHERE role = ? AND status = 'active' AND id != ?
    `).get(body.role, body.id);
    if (conflict) {
      return { ok: false, error: `role '${body.role}' already held by peer ${(conflict as any).id}` };
    }
  }
  updateRole.run(body.role, body.id);
  return { ok: true };
}

// HTTP router addition:
case "/set-role":
  return Response.json(handleSetRole(body as SetRoleRequest));
```

**`server.ts` additions:**

1. Read `process.env.CLAUDE_PEER_ROLE` at startup in `main()` (or wherever `register` is called) and pass it to the broker in the register request body.
2. Add a new entry to the `TOOLS` array for `set_role`.
3. Add a new `case "set_role":` in the `CallToolRequestSchema` handler that POSTs to `/set-role`.

TOOLS entry sketch:

```ts
{
  name: "set_role",
  description:
    "Claim a stable role name (e.g., 'overseer', 'planner', 'reviewer'). When this session dies and a new session registers with the same role via CLAUDE_PEER_ROLE, the broker will reuse the current peer ID. Only one active peer may hold a given role at a time.",
  inputSchema: {
    type: "object" as const,
    properties: {
      role: {
        type: ["string", "null"] as const,
        description: "The role name to claim, or null to release the current role",
      },
    },
    required: ["role"],
  },
},
```

### Startup ergonomics

Two entry points for setting a role:

1. **Env var at session start** (set before register): `CLAUDE_PEER_ROLE=overseer claude --dangerously-load-development-channels server:claude-peers`
2. **Post-register via MCP tool**: call `set_role(role: "overseer")` from within Claude.

Path 1 triggers the ID-reuse path during register. Path 2 sets the role for a session that's already registered, so the binding only matters after that session dies.

Suggested alias in the user's shell rc:

```bash
alias claude-overseer='CLAUDE_PEER_ROLE=overseer claude --dangerously-load-development-channels server:claude-peers'
alias claude-planner='CLAUDE_PEER_ROLE=planner  claude --dangerously-load-development-channels server:claude-peers'
# ...etc
```

## Tasks

**Execute strictly sequentially.** Each task ends with a manual-test checkpoint; do NOT move to task N+1 until task N's manual test passes.

### Task 1 — Schema migration + type additions

**Files:** `broker.ts`, `shared/types.ts`

1. Add the two `ALTER TABLE` statements to the schema setup block at `broker.ts:35-46`. Use `try { ... } catch {}` around each because SQLite errors if the column already exists and there's no `ADD COLUMN IF NOT EXISTS` in SQLite. Alternatively, check `PRAGMA table_info(peers)` first.
2. Update `shared/types.ts`: add `role?: string` to `RegisterRequest`; add `role: string | null` and `status: "active" | "dead"` to `Peer`; add new `SetRoleRequest` interface.
3. Update `insertPeer` prepared statement to include the new columns (role defaults to null, status defaults to 'active').

**Manual test:** Kill broker. Restart with `bun broker.ts`. Run:
```bash
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database(process.env.HOME + '/.claude-peers.db');
console.log(db.query('PRAGMA table_info(peers)').all());
"
```
Expect to see the two new columns in the schema output.

### Task 2 — `cleanStalePeers` UPDATE instead of DELETE

**File:** `broker.ts:62-74`

Replace `DELETE FROM peers WHERE id = ?` with `UPDATE peers SET status = 'dead' WHERE id = ?`. Keep the `DELETE FROM messages` line for dead-letter cleanup. Update `handleListPeers` and all `SELECT * FROM peers` queries (lines 100-110) to add `WHERE status = 'active'`.

**Manual test:** Start a peer session with `CLAUDE_PEER_ROLE=test-role`. Verify it appears in `list_peers`. Kill the peer process. Wait 30s (or restart broker to force cleanup). Query the DB directly — the row should still exist but `status = 'dead'`. `list_peers` from another session should NOT return it.

### Task 3 — Role-aware `handleRegister`

**File:** `broker.ts:175-187`

Implement the pseudocode above. Add the `insertPeerWithRole` prepared statement. Keep the original `insertPeer` path for role-less registrations to minimize diff.

**Manual test:** 
1. Start session A with `CLAUDE_PEER_ROLE=test-role`. Note its peer ID (e.g., `swift-otter`).
2. Kill session A. Wait for `cleanStalePeers`.
3. Start session B with `CLAUDE_PEER_ROLE=test-role`. Its peer ID should also be `swift-otter`.
4. Start session C with `CLAUDE_PEER_ROLE=test-role` while session B is still alive. Session C should get an **error** at register time about the role conflict.

### Task 4 — `handleSetRole` endpoint + `set_role` MCP tool

**Files:** `broker.ts`, `server.ts`, `shared/types.ts`

1. Add `handleSetRole` function and `/set-role` HTTP route to `broker.ts`.
2. Add `updateRole` prepared statement.
3. Add `set_role` entry to `TOOLS` array in `server.ts`.
4. Add `case "set_role":` handler to the CallToolRequestSchema switch.

**Manual test:** Start a peer session WITHOUT `CLAUDE_PEER_ROLE`. Call `set_role` from within Claude to claim a role. Kill the session. Start a new session with `CLAUDE_PEER_ROLE=<same role>`. The new session should reuse the prior ID.

### Task 5 — README update

**File:** `README.md`

- Add `set_role` to the Tools table (line ~64).
- Add a new "Stable role names" section explaining the `CLAUDE_PEER_ROLE` env var + alias pattern.
- Update the "How it works" section to mention role binding + `status` column.

**Manual test:** Re-read the README end-to-end and confirm the role flow is discoverable and accurate.

### Task 6 — Stale-row purge (optional, can ship in a follow-up)

Add a `purgeAncientDeadPeers` function to `broker.ts` that deletes `status = 'dead' AND last_seen < now - 30 days` rows. Schedule via `setInterval`, daily.

**Manual test:** Insert a synthetic dead row with `last_seen` 31 days ago. Run the purge. Confirm it's gone.

## Risk and mitigation

| Risk | Mitigation |
|---|---|
| **Broker restart kills all active peer registrations.** The moment we deploy the patch and restart the broker, every MCP server needs to re-register. | Schedule the restart at a coordination pause (e.g., between dispatching v0.1.1 Task 1 and Task 2). Warn in `claude-peers-mcp/CLAUDE.md` that deploying changes requires a broker restart. |
| **Race: two peers try to claim the same role simultaneously.** | Broker is single-threaded via Bun.serve — requests are serialized at the event loop. First-come-first-served is deterministic. The loser gets the `role '...' already held` error cleanly. |
| **Role bound to a stale session that was killed ungracefully.** Dead peer is detected within 30 s by `cleanStalePeers`, so after that window, new claims of the same role reclaim the ID. | Document the 30 s window. If a user is impatient, they can poke the broker via a new `/force-clean` endpoint (out of scope for this patch but trivial to add). |
| **DB grows unboundedly** because dead peers are no longer deleted. | Task 6's weekly 30-day purge. If skipped, even ~100 rotations/day × 365 days = 36k rows, which is negligible. |
| **A user copy/pastes old references to peer IDs from historical docs** and expects them to still resolve. | Document in `CLAUDE.md` that peer IDs are temporal; historical references in docs are audit trail, not live pointers. [[_peer-roster]] is the canonical mapping source. |
| **Migration applied to a corrupt existing DB.** | The `ALTER TABLE` statements in Task 1 should be wrapped in try/catch to tolerate pre-applied state or missing table. Test against a fresh DB and against the current live DB. |
| **Tool definition change breaks Claude's cached tool schema.** | After deploying, Claude sessions may need to be re-initialized to pick up the new `set_role` tool. Document this. |
| **Concurrent broker instances if the daemon is started twice.** | Out of scope — the existing auto-launch mechanism in `server.ts:67-95` (`ensureBroker`) handles this. Don't regress. |

## Testing strategy

**Unit-level** (if the project gains a test runner):
- `handleRegister` with role → dead-peer reuse path
- `handleRegister` with role → live conflict rejection
- `handleRegister` without role → unchanged behavior
- `handleSetRole` → role update + active-conflict rejection
- `cleanStalePeers` → UPDATE status instead of DELETE

**Integration-level** (shell + bun scripts, no test runner needed):

Create `scripts/test-role-persistence.sh` that:
1. Kills any running broker
2. Starts a fresh broker in the background
3. Spawns peer A with `CLAUDE_PEER_ROLE=test-role-$$` (PID-namespaced to avoid collisions)
4. Captures A's peer ID via direct broker HTTP call
5. Kills peer A
6. Waits 35 s for cleanStalePeers tick
7. Spawns peer B with the same `CLAUDE_PEER_ROLE`
8. Captures B's peer ID
9. Asserts A.id == B.id
10. Tears down the broker

**Manual smoke test** (always-run final gate): 
1. Restart broker after the patch lands
2. Open two terminals
3. Terminal 1: `CLAUDE_PEER_ROLE=overseer claude --dangerously-load-development-channels server:claude-peers`
4. Note the peer ID via `list_peers` from Terminal 2
5. Quit Terminal 1's Claude session
6. Wait 35 s
7. Reopen Terminal 1 with the same alias
8. Verify the new session has the same peer ID

## Rollout coordination

1. **Pre-merge:** review this plan + the patch diff with Greg.
2. **Merge:** commit to `~/claude-peers-mcp/` main branch (or a feature branch, pending its git setup).
3. **Broker restart window:** pick a moment when `jrmqliz0` (vault organizer) and the v0.1.1 review gate are both quiet. Avoid mid-L4 review dispatch.
4. **Announce:** `send_message` to all currently-live peers warning of the restart and the 1-2 minute re-registration gap.
5. **Restart:** `kill $(pgrep -f 'broker.ts')` — the next MCP server to register auto-relaunches the broker per `server.ts:67-95`.
6. **Verify:** all existing sessions re-register with fresh IDs (since no role is bound yet). Update [[_peer-roster]] with the new names.
7. **Claim roles:** each long-running session calls `set_role` with its canonical role, OR restarts with `CLAUDE_PEER_ROLE=<role>` set. Subsequent rotations respect the binding.

## Open questions

1. **Should roles auto-release on `handleUnregister` (clean shutdown) vs. only on `cleanStalePeers` (unclean death)?** Clean shutdown currently deletes the row entirely via `deletePeer`. If we keep that behavior, clean shutdown loses the role binding — a user restarting a session deliberately wouldn't get the prior ID back. **Recommendation:** clean shutdown should also UPDATE status='dead' rather than DELETE, so the role binding survives. This is a one-line change to `handleUnregister`.

2. **Should `list_peers` optionally show dead peers with bound roles?** Useful for "who WAS the overseer before this restart?" Probably add a `include_dead: bool` scope qualifier in a follow-up.

3. **Role namespace conventions.** Where do we document "the canonical roles are `overseer`, `planner`, `reviewer`, ..." — in the vault's [[_peer-roster]]? In `~/claude-peers-mcp/README.md`? Both? **Recommendation:** README has the mechanism, vault's `_peer-roster` has the project-specific role vocabulary.

4. **Should role conflicts be a soft warning instead of a hard error?** Hard error is safer for correctness; soft warning is more forgiving for concurrent startup races. The plan uses hard error; revisit if the UX is painful.

## Related

- [[_peer-roster]] — current peer roster; will be updated post-patch with the actual stable names
- [[Peer coordination protocol]] — concept note that motivates this patch (the stale-ID failure class)
- [[HOME]] — vault MOC
