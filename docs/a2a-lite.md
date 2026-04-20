# claude-peers A2A-lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve claude-peers from free-form text messaging into a typed agent-to-agent coordination protocol that slashes per-session context cost (~85-90%), cuts event-delivery latency (~10×), and emits a human-readable audit trail as a natural by-product.

**Architecture:** Adopt the *shape* (not the spec) of Google/Linux-Foundation A2A — Task + TaskState + contextId + structured DataPart — while staying localhost-first and keeping the existing broker/MCP-server split. Two-lane wire (text + data) with the audit renderer owning human-legibility. Long-poll transport replaces 1 Hz polling. Delivery is universal across task participants; push (channel interrupt) is selective via a five-rule suppression policy. DB is ground truth; per-task markdown files are a derived view that Claude reads with standard tools.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `Bun.serve` (HTTP + SSE), `@modelcontextprotocol/sdk`.

---

## Table of Contents

1. [Background & Motivation](#background--motivation)
2. [Design Decisions (Locked)](#design-decisions-locked)
3. [Schema](#schema)
4. [Tool Surface](#tool-surface)
5. [Push Policy](#push-policy)
6. [Audit Filesystem Layout](#audit-filesystem-layout)
7. [File Structure](#file-structure)
8. [Rollout: 7 Slices](#rollout-7-slices)
9. [Slice 1 Tasks (this PR)](#slice-1-tasks-this-pr)
10. [Future Slices (summary)](#future-slices-summary)
11. [Impact Estimates](#impact-estimates)

---

## Background & Motivation

Current overhead sources (measured against `broker.ts`, `server.ts` at HEAD):

- **Polling:** `POLL_INTERVAL_MS = 1000` (server.ts:39) — every MCP server polls `/poll-messages` once per second, indefinitely.
- **Extra RTT per inbound message:** `pollAndPushMessages` calls `/list-peers` to enrich sender info (server.ts:631) before pushing channel notification.
- **Process-kill liveness scan:** `handleListPeers` runs `process.kill(p.pid, 0)` over every peer on every call (broker.ts:388-396).
- **Fat MCP surface:** 700-char `instructions` block (server.ts:241) + 6 tool descriptions loaded into every session, including sessions that never coordinate.
- **Verbose `list_peers` output:** seven fields per row (server.ts:386-396), most forensic rather than operational.
- **Unstructured messages:** raw `text` column (broker.ts:75). No intent, task, thread, correlation. Audit is SQLite-only.
- **Blocking auto-summary:** `Promise.race` on OpenAI API at startup with 3 s timeout (server.ts:707).
- **Channel push per event:** every arriving message fires `mcp.notification` (server.ts:646). Coordinator acking "ok" sends the same push-cost as coordinator dispatching real work.

Goals, in priority order:
1. Reduce context cost per coordination cycle
2. Reduce event-delivery latency
3. Preserve human-readable audit for a future engineer or Claude session reconstructing a conversation
4. Enable structured agent-to-agent protocols (A2A shape) without adopting the full A2A spec ceremony

## Design Decisions (Locked)

Each decision was grilled individually. Cross-reference via branch number.

| # | Decision |
|---|---|
| 1 | Adopt A2A *shape*, not the spec. No AgentCard, no JSON-RPC framing, no auth, no SSE incremental streaming, no PushNotificationConfig. |
| 2 | **Keep:** Task, TaskState (reduced to 4 values: `open / waiting / done / failed`), contextId, Artifact-as-ref, DataPart as structured JSON. **Modify:** messages carry two parallel fields — `text TEXT` + `data JSON` — instead of a parts array. **Audit renderer** owns human-legibility; wire can be terse. |
| 3 | Additive schema: keep existing `messages` table untouched for ad-hoc chatter; add `tasks` + `task_participants` + `task_events` + `task_event_cursors` alongside. Expose UNION view `audit_stream`. Unified poll endpoint at the app layer. Split tool surface: `send_message` stays for unstructured, new tools for typed. |
| 4 | Six intents: `dispatch / state_change / question / answer / complete / cancel`. |
| 5 | Long-poll is the primary transport (30 s default). SSE endpoint `/events/stream` exists as a CLI-tail byproduct and future remote-transport candidate. Event envelope is transport-agnostic. Unix socket is a possible later optimization. |
| 6 | Typed events ship a **thin envelope** (task_id, intent, from_id, data, text?, event_id). Unstructured `send_message` keeps the fat envelope for backward compat. |
| 7 | Multicast: task has explicit participants list. Participants may be specified by `peer_id` OR by `role`; broker resolves roles at dispatch. Five `role_at_join` values: `dispatcher / assignee / reviewer / collaborator / observer`. Delivery is cursor-based (one cursor per peer, not per event). |
| 8 | Default-push with 5 suppression rules (observer never pushed; sender never pushed back; `state_change→working` universally suppressed; targeted `question` only pushes to target; `answer` only pushes to original asker). Delivery is universal, push is selective. |
| 9 | Two new MCP tools: `dispatch_task`, `send_task_event`. No new read tools — audit-as-filesystem: Claude reads task history via `Read` on `~/.claude-peers/tasks/<task_id>.md`. Instructions block trimmed from ~700 to ~280 chars. `list_peers` output role-first compact. |
| 10 | Auto-summary non-blocking (drop 3 s race). Broker→filesystem write is synchronous, append-only; DB is ground truth; files are derived view; `bun cli.ts replay` regenerates files from DB on demand. One-file-per-task layout under `~/.claude-peers/tasks/`; no index files, aggregation via standard Unix tools. |
| 11 | Rollout in 7 layered slices. Each slice independently shippable and rollback-able. Slice 1 = pure context-diet (this PR). |

## Schema

**Additions only.** Existing `peers` and `messages` tables are untouched.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                     -- 'T-<seq>' or similar
  context_id TEXT,                         -- groups related tasks
  state TEXT NOT NULL DEFAULT 'open',      -- open|waiting|done|failed
  title TEXT,                              -- short human label
  created_at TEXT NOT NULL,                -- ISO timestamp
  created_by TEXT NOT NULL,                -- peer_id of dispatcher
  FOREIGN KEY (created_by) REFERENCES peers(id)
);

CREATE TABLE IF NOT EXISTS task_participants (
  task_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  role_at_join TEXT,                       -- dispatcher|assignee|reviewer|collaborator|observer
  joined_at TEXT NOT NULL,
  PRIMARY KEY (task_id, peer_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (peer_id) REFERENCES peers(id)
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  intent TEXT NOT NULL,                    -- dispatch|state_change|question|answer|complete|cancel
  text TEXT,                               -- human prose lane (nullable)
  data TEXT,                               -- structured JSON lane (nullable)
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

-- Unified audit stream (Slice 3)
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

**Rollback (Slice 3 only):**

```sql
DROP VIEW IF EXISTS audit_stream;
DROP TABLE IF EXISTS task_event_cursors;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS task_participants;
DROP TABLE IF EXISTS tasks;
```

Existing data untouched.

## Tool Surface

**Existing tools (preserved, descriptions trimmed in Slice 1):**
- `list_peers(scope)` — output format changed to role-first compact in Slice 1
- `send_message(to_id, message)` — unchanged
- `set_summary(summary)` — unchanged
- `set_role(role)` — unchanged
- `get_self_id()` — unchanged
- `check_messages()` — unchanged in Slice 1; will return task events too starting Slice 4

**New tools (Slice 4):**

```typescript
// dispatch_task — creates a task and sends the first `dispatch` event
{
  name: "dispatch_task",
  description:
    "Create a new task and dispatch it to participants. Returns task_id. " +
    "Participants may be specified by peer_id or role; roles resolve to current live peer.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      participants: {
        type: "array",
        items: { type: "string" },
        description: "Array of peer IDs or role names.",
      },
      context_id: { type: "string", description: "Optional grouping ID." },
      text: { type: "string", description: "Human prose describing the dispatch." },
      data: { type: "object", description: "Structured payload (plan_ref, branch, etc.)." },
    },
    required: ["title", "participants"],
  },
}

// send_task_event — emit a non-dispatch intent on an existing task
{
  name: "send_task_event",
  description:
    "Send an event on an existing task. Intents: state_change | question | answer | complete | cancel.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      intent: {
        type: "string",
        enum: ["state_change", "question", "answer", "complete", "cancel"],
      },
      text: { type: "string" },
      data: { type: "object" },
    },
    required: ["task_id", "intent"],
  },
}
```

Reads of task history go through the filesystem, not a tool — Claude uses `Read` on `~/.claude-peers/tasks/<task_id>.md`.

## Push Policy

Universal delivery (all non-sender participants receive every event via their cursor). Push (MCP channel notification) is selective. Single filter function:

```typescript
function shouldPush(event: TaskEvent, receiver: Participant): boolean {
  if (receiver.role_at_join === "observer") return false;
  if (receiver.peer_id === event.from_id) return false;
  if (event.intent === "state_change" && event.data?.to === "working") return false;
  if (event.intent === "question" && event.data?.to && event.data.to !== receiver.peer_id) return false;
  if (event.intent === "answer" && event.data?.reply_to_from !== receiver.peer_id) return false;
  return true;
}
```

## Audit Filesystem Layout

```
~/.claude-peers/
└── tasks/
    └── T-034.md
```

One file per task. No index files. Aggregation via `ls`, `grep`, `find`. Broker appends to the file on every `task_events` INSERT, synchronously, after the DB write. DB is ground truth; files are derived. `bun cli.ts replay [task_id|all]` regenerates files from DB.

Example task file:

```markdown
# T-034 — Scaffold schema migrations
- context: multi-agent/2026-04-18-schema-refactor
- state: done
- created: 2026-04-18T14:02Z by coordinator (swift-otter)
- participants: coordinator (swift-otter), impl-backend-A (quiet-comet), reviewer-backend-A (bright-falcon)

## Events

### 14:02 — dispatch (coordinator → impl-backend-A, reviewer-backend-A)
Implement schema migrations per plans/schema-refactor.md#t3 on branch feat/schema.

### 14:02 — state_change (impl-backend-A: working)

### 14:17 — question (impl-backend-A → coordinator)
Should I keep the old columns nullable or drop them?

### 14:18 — answer (coordinator → impl-backend-A)
Keep nullable; drop in a follow-up PR.

### 14:42 — state_change (impl-backend-A: done)
artifacts: branch:feat/schema-impl, tests passing

### 14:43 — state_change (reviewer-backend-A: working)

### 15:10 — complete (reviewer-backend-A: approved)
review-notes: minor nits, see inline PR comments
```

## File Structure

**Slice 1 touches:**
- `server.ts` — instructions block, tool descriptions, `list_peers` handler, startup sequence (4 distinct edit regions)
- `docs/a2a-lite.md` — this document

**Slice 1 does NOT touch:**
- `broker.ts` — no broker changes in Slice 1
- `shared/types.ts` — no type changes in Slice 1
- `cli.ts` — no CLI changes in Slice 1
- `broker.test.ts` — no test changes; existing tests must continue to pass

**Future slices:**
- Slice 2: `broker.ts` (add `wait_ms`/`since_id` to `/poll-messages`, add cursor map, resolve on new message); `server.ts` (adapt poll loop to long-poll semantics).
- Slice 3: `broker.ts` (create tables, view, prepared statements); `shared/types.ts` (new types).
- Slice 4: `broker.ts` (handle `/dispatch-task`, `/send-task-event`, filesystem write); `server.ts` (new MCP tools); `cli.ts` (optional `tasks` subcommand).
- Slice 5: `broker.ts` or `server.ts` (push-policy hook into long-poll resolve path).
- Slice 6: `broker.ts` (`/events/stream` SSE endpoint); `cli.ts` (`tail` subcommand).
- Slice 7: `cli.ts` (`replay` subcommand).

## Rollout: 7 Slices

| Slice | Scope | Risk | Shippable Alone? |
|---|---|---|---|
| 1 | Instructions trim + tool description trim + `list_peers` output + non-blocking auto-summary | None (pure reduction) | Yes — pure context diet |
| 2 | Long-poll transport (`wait_ms`/`since_id`, cursor map on broker) | Low — self-heal catches failures | Yes — measurable latency win |
| 3 | Schema + UNION view — new tables exist but no tool exposes typed lane yet | Low — additive, reversible by DROP | Yes — `cli.ts messages` reads view, no behavior change for users |
| 4 | `dispatch_task` + `send_task_event` tools + broker→filesystem audit writes | Medium — new user-facing behavior | Yes — first end-to-end typed flow |
| 5 | Role-aware push-policy | Low — filter function, additive | Yes — biggest context win lands |
| 6 | SSE CLI-tail endpoint + `bun cli.ts tail` | Low — new transport endpoint, opt-in use | Yes — remote-ready byproduct |
| 7 | `bun cli.ts replay` recovery tool | None | Yes — safety net, should ideally precede slice 4 |

## Slice 1 Tasks (this PR)

All tasks modify `server.ts`. No new files. Existing tests in `broker.test.ts` must continue to pass throughout. Manual smoke test after final task: start a session, confirm it registers and connects without error.

---

### Task 1: Commit this spec doc

**Files:**
- Create: `docs/a2a-lite.md` (already written)

- [x] **Step 1: Verify file exists**

```bash
ls -la docs/a2a-lite.md
```

Expected: file exists, ~400+ lines.

- [ ] **Step 2: Commit the spec**

```bash
git add docs/a2a-lite.md
git commit -m "$(cat <<'EOF'
docs: add A2A-lite design spec and slice plan

Captures the full design grill: 11 locked-in branches, schema DDL,
tool signatures, push-policy, audit filesystem layout, 7-slice
rollout. This PR implements Slice 1 (pure context-diet changes
in server.ts); future slices reference this spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Trim the MCP instructions block

**Files:**
- Modify: `server.ts:241-255` (the `instructions` property on the `Server` constructor)

**Current block** (~700 chars):

```
You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo). Note: this excludes your own row — use get_self_id to check your own identity.
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- set_role: Claim a stable role name (e.g. 'overseer') so a future session with CLAUDE_PEER_ROLE=<role> inherits this peer ID
- get_self_id: Returns your own peer ID, PID, working directory, git root, and role
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.
```

Rationale for trim:
- "Available tools" list duplicates the tool descriptions (doubled context cost for zero new information).
- Reply-by-send_message guidance is redundant with the tool's own description.
- Metaphor ("coworker tapping on your shoulder") is preserved — tested well in practice per user.

- [ ] **Step 1: Apply the edit**

Replace the multi-line instructions string at `server.ts:241-255` with the trimmed version below. Preserve the backtick template literal syntax.

New block (~310 chars):

```
claude-peers mesh: when a <channel source="claude-peers" …> arrives, pause current work, reply, then resume — like a coworker tapping your shoulder. Use send_message to reply (their from_id is in the channel meta). Call set_summary on startup so peers can see what you're working on.
```

- [ ] **Step 2: Typecheck**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: exits 0, no type errors.

- [ ] **Step 3: Run broker tests (sanity)**

```bash
bun test broker.test.ts
```

Expected: all tests pass (broker tests don't exercise `server.ts` directly, but this confirms nothing in the broker depends on anything we might have moved).

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "$(cat <<'EOF'
server: trim MCP instructions block (~700 → ~310 chars)

Removes redundant "Available tools" list (duplicates tool descriptions
registered in TOOLS array) and reply-via-send_message reminder
(redundant with send_message's own description). Preserves the
"coworker tapping your shoulder" metaphor. Slice 1 of A2A-lite plan.

See docs/a2a-lite.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Trim tool descriptions in the TOOLS array

**Files:**
- Modify: `server.ts:261-347` (the TOOLS constant)

Each description is cut by ~40-60% while preserving semantics. Long parameter-by-parameter reiteration is removed; descriptions that duplicate the `inputSchema` verbatim are trimmed to what the schema can't express.

**Current and new descriptions:**

| Tool | Current description | New description |
|---|---|---|
| `list_peers` | "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary." | "List active peer Claude instances. Excludes your own row — use get_self_id for that." |
| `send_message` | "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification." | "Send ad-hoc message to a peer by ID. Pushed immediately to their session." |
| `set_summary` | "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers." | "Set a 1-2 sentence summary of your current work, visible to peers." |
| `check_messages` | "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback." | "Pull any unread messages manually. Fallback — messages normally arrive as channel pushes." |
| `get_self_id` | "Returns this session's own peer ID, working directory, git root, and role. Use this to verify your identity — list_peers excludes your own row, so this is the only reliable way to check your own ID." | "Return your own peer ID, PID, cwd, git root, role. list_peers excludes your own row; use this for self-identity." |
| `set_role` | "Claim a stable role name (e.g. 'overseer', 'planner', 'reviewer'). When this session dies and a new session registers with the same role via the CLAUDE_PEER_ROLE environment variable, the broker will reuse the current peer ID. Only one active peer may hold a given role at a time. Pass null to release the current role." | "Claim a stable role name. A future session with CLAUDE_PEER_ROLE=<role> inherits this peer ID on revival. Pass null to release." |

- [ ] **Step 1: Apply edits**

Update the `description` field on each tool in the `TOOLS` array to match the "New description" column above. Leave `name`, `inputSchema`, and parameter-level descriptions untouched.

- [ ] **Step 2: Typecheck**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: exits 0.

- [ ] **Step 3: Run broker tests**

```bash
bun test broker.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "$(cat <<'EOF'
server: trim tool descriptions (~40-60% reduction each)

Strip verbosity that duplicates the inputSchema or re-explains
parameter semantics that the schema already carries. Semantics
preserved; this is pure context-diet. Slice 1 of A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Role-first compact `list_peers` output

**Files:**
- Modify: `server.ts:386-406` (the `list_peers` tool handler's output formatting block)

**Current output format:**

```
ID: swift-otter
  PID: 12345
  CWD: /Users/g/project
  Repo: /Users/g/project
  TTY: ttys001
  Summary: working on the refactor
  Last seen: 2026-04-19T10:02:15.000Z
```

**New output format:**

```
[coordinator] swift-otter  /Users/g/project  — working on the refactor
[impl-backend-A] quiet-comet  /Users/g/project  — scaffolding schema
(no role) dusty-fox  /Users/g/other  — ad-hoc work
```

Sort order: rows with a role first, alphabetically by role; roleless rows at the bottom. `PID`, `TTY`, and `last_seen` are dropped from the tool output (still available via `bun cli.ts peers` for forensic use — the CLI is unchanged).

- [ ] **Step 1: Apply the edit**

Replace the `peers.map((p) => { ... })` block at `server.ts:386-397` with the following:

```typescript
// Sort: roles first (alphabetical by role), roleless peers last.
const sorted = [...peers].sort((a, b) => {
  if (a.role && b.role) return a.role.localeCompare(b.role);
  if (a.role && !b.role) return -1;
  if (!a.role && b.role) return 1;
  return a.id.localeCompare(b.id);
});

const lines = sorted.map((p) => {
  const tag = p.role ? `[${p.role}]` : "(no role)";
  const summary = p.summary ? `  — ${p.summary}` : "";
  return `${tag} ${p.id}  ${p.cwd}${summary}`;
});
```

The surrounding return block (`return { content: [{ type: "text", text: ... }] }`) retains its overall shape, but the `lines.join("\n\n")` at the end becomes `lines.join("\n")` — the new compact format is one line per peer, so a blank line between rows would just waste vertical space. The sort + `lines` computation are also new.

- [ ] **Step 2: Typecheck**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: exits 0.

- [ ] **Step 3: Run broker tests**

```bash
bun test broker.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Manual smoke test**

Start the broker and register a couple of peers (or rely on already-running sessions). From one Claude session, invoke `list_peers` with `scope: "machine"`. Confirm output matches the new compact format — one line per peer, role-tagged, PID/TTY/last_seen absent.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "$(cat <<'EOF'
server: compact list_peers output (role-first, drop PID/TTY/last_seen)

Reshape the list_peers tool response to a one-line-per-peer format
sorted by role. Drops PID, TTY, last_seen — forensic fields still
available via `bun cli.ts peers`. Puts the structure of the mesh
(who holds which role) at the top of the output. Slice 1 of
A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Non-blocking auto-summary

**Files:**
- Modify: `server.ts:707` (the `Promise.race` line in `main()`)

**Current behavior:** On startup, `main()` kicks off `summaryPromise` (async OpenAI call) and then **blocks for up to 3 seconds** via `Promise.race([summaryPromise, setTimeout(3000)])` before proceeding to broker registration. If OpenAI responds within 3 s, the initial registration carries the summary; otherwise the summary fills in asynchronously via the existing `summaryPromise.then(...)` block at server.ts:725.

**New behavior:** Remove the 3 s race entirely. Register immediately with an empty summary; the existing async fill-in handles it when it eventually resolves. Net effect: startup latency drops from up-to-3 s to ~0 ms in the summary path.

- [ ] **Step 1: Apply the edit**

At `server.ts:707`, replace:

```typescript
  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);
```

with:

```typescript
  // Auto-summary is non-blocking — the summaryPromise.then block below
  // applies the summary via /set-summary when it eventually resolves.
```

- [ ] **Step 2: Typecheck**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: exits 0. (Note: `summaryPromise` is still referenced later at server.ts:725 in the `if (!initialSummary) { summaryPromise.then(...) }` block, so the variable stays alive and TypeScript is happy.)

- [ ] **Step 3: Verify the late-fill path still works**

Visually confirm that server.ts:725-735 (the `if (!initialSummary) { summaryPromise.then(...) }` block) is unchanged. This is the path that now carries 100% of the summary application since we removed the fast path. Since `initialSummary` is always empty after our edit (nothing could have populated it before registration), the `.then` branch always runs. That's the intended behavior.

- [ ] **Step 4: Run broker tests**

```bash
bun test broker.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Manual smoke test**

Start a fresh Claude Code session (or invoke `bun server.ts` with mocked stdio). Time the startup:

```bash
time (echo '' | bun server.ts &)
```

Expected: process establishes broker connection in <500 ms. Previously would block for up to 3 s if OpenAI was slow or the API key wasn't set.

Check stderr output: should see `Registered as peer <id>` within ~200 ms. If `OPENAI_API_KEY` is set and reachable, `Late auto-summary applied: …` follows asynchronously a moment later.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "$(cat <<'EOF'
server: make auto-summary non-blocking (drop 3s startup race)

Remove the Promise.race([summaryPromise, setTimeout(3000)]) that
blocks session startup waiting for OpenAI's summary response. The
existing summaryPromise.then(...) block at the bottom of main()
already handles late-arriving summaries via /set-summary, so
dropping the race simply lets registration proceed immediately.

Net: up to 3s startup latency reduction per session. Slice 1 of
A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: End-of-slice verification

- [ ] **Step 1: Clean build**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: both exit 0.

- [ ] **Step 2: Full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: End-to-end smoke test**

Start the broker (`bun broker.ts` in one terminal). In another terminal, spawn an MCP server manually (`bun server.ts` with stdin closed). Confirm:

1. Broker logs `listening on 127.0.0.1:7899`
2. MCP server logs `Registered as peer <id>` within <500 ms
3. `bun cli.ts peers` shows the registered peer with the new compact format

If any of these fail, investigate before moving on.

- [ ] **Step 4: Tag the slice**

```bash
git log --oneline origin/main..HEAD
```

Expected output (5 commits):

```
<sha> server: make auto-summary non-blocking (drop 3s startup race)
<sha> server: compact list_peers output (role-first, drop PID/TTY/last_seen)
<sha> server: trim tool descriptions (~40-60% reduction each)
<sha> server: trim MCP instructions block (~700 → ~310 chars)
<sha> docs: add A2A-lite design spec and slice plan
```

- [ ] **Step 5: Stop and surface for review**

Do not push. Do not open a PR. Report to the user:
- Commits on the branch
- Summary of what changed
- Ask whether to push + open PR, or iterate first

## Future Slices (summary)

Detailed task plans for future slices should live in their own plan documents (`docs/a2a-lite-slice-2.md`, etc.) written when that slice is about to be implemented. This spec reserves them as the agreed roadmap; the below is a summary only.

### Slice 2: Long-poll transport

`/poll-messages` accepts optional `wait_ms` (default 30_000) and `since_id` fields. Broker maintains in-memory `Map<PeerId, { resolve: (events: Event[]) => void, timeoutHandle }>` of pending waiters. New message insertion checks the map and resolves the matching waiter immediately. On timeout, return `{ events: [] }` and peer reconnects. MCP server's poll loop becomes `while (true) { await pollOnce(); }` with pollOnce returning immediately on events and after 30 s on idle.

**Event envelope (transport-agnostic):**

```typescript
type Event = {
  event_id: number;
  type: "message" | "task_event";
  payload: Message | TaskEvent;
};
```

### Slice 3: Schema + UNION view

Apply the DDL from the [Schema](#schema) section. No new handlers, no new tools exposed — typed lane exists in the DB but is unreachable from outside. `cli.ts messages` continues to work (reads the view). `cli.ts audit` or similar new subcommand may be added to render the view more richly.

### Slice 4: A2A tools + broker→filesystem audit

- New broker endpoints: `/dispatch-task`, `/send-task-event`.
- New MCP tools: `dispatch_task`, `send_task_event`.
- Broker's event-insert path appends a rendered line to `~/.claude-peers/tasks/<task_id>.md` synchronously after the DB write.
- Event envelope (typed events): `{ event_id, type: "task_event", payload: { task_id, intent, from_id, data, text?, sent_at } }`. Fat envelope fields (`from_summary`, `from_cwd`) are **not** included on typed events.
- Participants pinned at dispatch; `participants` input may contain peer IDs or role names; broker resolves roles to current live peer ID at dispatch time.

### Slice 5: Role-aware push policy

Implement `shouldPush(event, receiver)` per the five-rule filter. Hook into the long-poll resolve path so the broker decides per-(event, receiver) whether to emit a channel notification, while still including the event in the poll batch for all participants. Measurable context-win lands here.

### Slice 6: SSE CLI-tail byproduct

Add `GET /events/stream?from=<cursor>` SSE endpoint emitting the same `Event` envelope. New `bun cli.ts tail` subcommand consumes it for live audit streaming. Validates that the envelope is truly transport-agnostic and creates the landing pad for a future remote-transport flip.

### Slice 7: Replay CLI

Add `bun cli.ts replay [task_id|all]` that regenerates `~/.claude-peers/tasks/<task_id>.md` from the DB. Safety net for crash-mid-write scenarios and any future file-corruption. Should ideally precede Slice 4 but can ship retroactively.

## Impact Estimates

| Lever | Mechanism | Estimated impact | Slice |
|---|---|---|---|
| Startup latency | Non-blocking auto-summary | 3 s → ~0 ms per session boot | 1 |
| Fixed MCP surface context | Instructions + tool description trim | ~400 fewer tokens per session | 1 |
| `list_peers` response size | Drop PID/TTY/last_seen, role-first | ~30% smaller per call | 1 |
| Event-delivery latency | Long-poll | avg 500 ms → <50 ms | 2 |
| Idle broker load | Long-poll | N req/s → N req / 30 s (~30× reduction) | 2 |
| Per-event context (typed) | Thin envelope | ~250 tokens → ~50 tokens per pushed event | 4 |
| Channel pushes per cycle | Role-aware suppression | ~60-67% fewer interrupts per role | 5 |
| Audit context cost | Filesystem audit | 0 tool-cost for task history | 4 (Read-based) |
| **Aggregate per coordination cycle** | All composed | **~85-90% context reduction, ~10× latency improvement** | after 5 |

---

## Appendix A — Push policy worked example

Cycle: coordinator dispatches T-034 to impl-backend-A + reviewer-backend-A. Impl starts, asks a question, coordinator answers, impl completes, reviewer reviews, reviewer completes.

**Events generated (9 total):**

1. `dispatch` from coordinator
2. `state_change→working` from impl
3. `question (to: coordinator)` from impl
4. `answer (reply_to_from: impl)` from coordinator
5. `state_change→done` from impl
6. `state_change→working` from reviewer
7. `state_change→done` from reviewer (or `complete`)
8. `complete` from reviewer (optional; or the above)
9. Task auto-closes

**Delivery** (all 9 events go to all 3 participants via cursor — universal delivery).

**Pushes** per participant (applying `shouldPush`):

| Event | coord | impl | reviewer |
|---|---|---|---|
| 1 dispatch | sender (no) | push | push |
| 2 state_change→working | no (rule 3) | sender (no) | no (rule 3) |
| 3 question (to coord) | push (target) | sender (no) | no (rule 4) |
| 4 answer (reply_to impl) | sender (no) | push (target) | no (rule 5) |
| 5 state_change→done | push | sender (no) | push |
| 6 state_change→working | no (rule 3) | no (rule 3) | sender (no) |
| 7 state_change→done | push | push | sender (no) |
| 8 complete | push | push | sender (no) |

**Pushes per role:** coord = 4, impl = 3, reviewer = 2. Total = 9 pushes delivered across 3 participants × 9 events = 27 possible; 9 actual. Suppression rate = 67%.

## Appendix B — Rollback procedures

**Slice 1 rollback:** `git revert <sha>` on any of the five commits independently; no state outside the repo.

**Slice 2 rollback:** `git revert`; in-memory waiter map disappears with the broker process. No persistent state change.

**Slice 3 rollback:** `git revert` + `DROP VIEW audit_stream; DROP TABLE task_event_cursors; DROP TABLE task_events; DROP TABLE task_participants; DROP TABLE tasks;` Existing `messages` and `peers` tables untouched throughout.

**Slice 4 rollback:** `git revert` + DDL from Slice 3 rollback. Markdown files in `~/.claude-peers/tasks/` can be deleted with `rm -rf` at the user's discretion — they're not load-bearing for any other slice.

**Slice 5 rollback:** `git revert` — push-policy is a pure function with no state.

**Slice 6 rollback:** `git revert` — SSE endpoint has no persistent side effects.

**Slice 7 rollback:** `git revert` — CLI subcommand removal.

---

*End of spec.*
