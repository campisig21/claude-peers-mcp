# A2A-lite Slice 2 — Long-Poll Transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1 Hz HTTP poll loop with long-poll semantics on `/poll-messages`, dropping event-delivery latency from ~500 ms avg to <50 ms and idle broker load from N req/sec to N req / 30 s.

**Architecture:** Broker maintains an in-memory `Map<PeerId, PendingWaiter>` of peers currently waiting on `/poll-messages` calls. `/send-message` inserts to the DB and immediately resolves the target's waiter (if any) with the new event. `/poll-messages` accepts optional `wait_ms` (default 30 000) and `since_id` fields — when called with no undelivered events, it installs a waiter and resolves on the first of (a) new event arrival, (b) timeout. The MCP server's poll loop becomes `while (true) { await pollOnce(); }` — tight loop against a broker that itself blocks until work arrives.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `Bun.serve` (HTTP), `@modelcontextprotocol/sdk`.

**Parent spec:** [`docs/a2a-lite.md`](./a2a-lite.md) §"Slice 2: Long-poll transport" + §"Event envelope (transport-agnostic)".

**Revision history:** rev 2 incorporates reviewer yb6oeqry's pre-review feedback: T8 rescoped to broker-subprocess lifecycle only; `/debug/waiters` endpoint added (unconditional, localhost-only); MAX_WAIT_MS excess now fails loud with HTTP 400; cleanup ordering closes the 30 s latency window on SIGTERM; `installedAt` wired into debug output as `age_ms`; invariant comment required at resolver hook; T6 timing hint uses `Promise.all` for determinism; added Task 2.5 checkpoint for reviewer pre-review of failing tests before implementation begins.

---

## Table of Contents

1. [Why long-poll](#why-long-poll)
2. [What changes vs. what stays](#what-changes-vs-what-stays)
3. [Transport-agnostic event envelope](#transport-agnostic-event-envelope)
4. [API contract changes](#api-contract-changes)
5. [Broker in-memory waiter map](#broker-in-memory-waiter-map)
6. [Concurrency & race rules](#concurrency--race-rules)
7. [**Test Plan** (reviewer pre-review target)](#test-plan-reviewer-pre-review-target)
8. [File structure](#file-structure)
9. [Implementation tasks](#implementation-tasks)
10. [Impact & rollback](#impact--rollback)

---

## Why long-poll

Current state (post-slice-1):
- `server.ts:39` — `POLL_INTERVAL_MS = 1000`. Every MCP server pings `/poll-messages` once per second indefinitely.
- `broker.ts:413-422` — handler returns immediately with whatever is undelivered (usually empty).
- Delivery latency = average 500 ms (arrival time + poll lag).
- Idle load = N requests/second where N = live peers. On a typical machine with 3-5 concurrent Claude sessions: 10-18 k requests/hour per peer, most returning empty.

Long-poll flips this:
- Client sends one request, broker holds the connection open until work arrives or the timeout fires.
- Delivery latency = roundtrip + resolver scheduling ≈ 1-10 ms.
- Idle load = N requests / wait_ms. At 30 s default: ~600 requests/hour for 5 peers, all of which resolve with actual data.

Gains are orthogonal to schema changes (those come in Slice 3), so Slice 2 ships a pure transport win.

## What changes vs. what stays

**Changes (broker.ts):**
- `/poll-messages` handler — accepts `wait_ms`, `since_id`; installs waiters when no events pending.
- `/send-message` handler — resolves target waiter immediately after DB insert.
- `/unregister` handler — cancels any pending waiter for the peer being torn down.
- New in-memory `pendingWaiters: Map<PeerId, PendingWaiter>`.
- Broker shutdown handler (optional, if broker ever adds one) drains waiters with empty response.

**Changes (server.ts):**
- `POLL_INTERVAL_MS` → deprecated; replaced by tight `while` loop.
- `pollAndPushMessages` — no longer scheduled on `setInterval`; runs continuously.
- Poll calls pass `wait_ms: 30_000` by default; `check_messages` tool path passes `wait_ms: 0` for instant return.

**Stays the same:**
- Schema: no migrations. Existing `messages` table unchanged, `delivered` flag unchanged.
- Existing `/register`, `/heartbeat`, `/set-summary`, `/set-role`, `/list-peers` endpoints untouched.
- Self-heal logic (`server.ts:68-93`) untouched — connection failures still trigger `attemptSelfHeal`; long-poll timeouts look like ordinary responses, not errors.
- MCP channel-push delivery path (`server.ts:646-657`) untouched.

## Transport-agnostic event envelope

This is the forward-looking data structure shared with future SSE transport (Slice 6). For Slice 2, it's the shape `/poll-messages` returns:

```typescript
// shared/types.ts — NEW
export type EventType = "message" | "task_event";

export interface Event<P = unknown> {
  event_id: number;
  type: EventType;
  payload: P;
}

// Slice 2 only ever emits type: "message" with payload: Message.
// Slice 4 will add type: "task_event" with payload: TaskEvent.
```

The `event_id` is the DB row ID (messages.id for Slice 2, task_events.id for Slice 4). Monotonic per-table; callers treat as opaque ordering cursor.

## API contract changes

**`POST /poll-messages`** — request body extended:

```typescript
// shared/types.ts — MODIFIED
export interface PollMessagesRequest {
  id: PeerId;
  wait_ms?: number;       // NEW: max block time, default 30_000
  since_id?: number;      // NEW: if set, returns events with id > since_id
                          //      (replay mode; bypasses `delivered` flag)
}

export interface PollMessagesResponse {
  events: Event[];                      // NEW: replaces `messages`
  next_cursor: number | null;           // NEW: max event_id in this batch, or null if empty
}
```

**Semantics:**

- **`wait_ms` absent or > 0, no pending events:** install waiter, block up to `wait_ms` ms, resolve on first arrival or timeout. Timeout returns `{ events: [], next_cursor: null }`.
- **`wait_ms = 0`:** fast path — return immediately with whatever is pending (may be empty). Used by `check_messages` tool so the MCP worker doesn't block.
- **`wait_ms > 0`, events already pending:** return immediately; no waiter installed.
- **`since_id` provided:** returns messages where `id > since_id AND to_id = id` (no `delivered` filter). Replay mode. Does NOT mark events delivered — replay is read-only.
- **`since_id` absent:** existing behavior — returns messages where `to_id = id AND delivered = 0`. Marks them delivered on return.

**Backward compat:** a caller that sends only `{ id }` gets the existing semantics with the new response shape (`events` array wrapping the old `messages`, plus `next_cursor`). Old clients would break on the field rename; Slice 2 MCP server is updated in the same PR, no cross-version production scenario.

**`POST /send-message`** — response unchanged; internal behavior changes (resolves waiter on success).

**`POST /unregister`** — response unchanged; cancels any pending waiter for the peer.

## Broker in-memory waiter map

```typescript
// broker.ts
type PendingWaiter = {
  resolve: (response: PollMessagesResponse) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  installedAt: number;        // ms timestamp, for debug/metrics
};

const pendingWaiters = new Map<PeerId, PendingWaiter>();
```

**Install** (in `/poll-messages` when no pending events):
1. If a waiter already exists for this peer, cancel it (clear timeout, resolve with empty).
2. Create new `PendingWaiter` with `setTimeout(timeoutFn, wait_ms)`.
3. Store in `pendingWaiters.set(peerId, waiter)`.
4. Return the Promise to the HTTP handler, which awaits it before sending the response.

**Resolve from `/send-message`** (when target has a waiter):
1. Look up `pendingWaiters.get(to_id)`.
2. If found: clear its timeout, delete from map, call `resolve({ events: [<new event>], next_cursor: <id> })`.
3. HTTP handler for `/poll-messages` sees the resolved promise and returns.

**Timeout firing:**
1. Delete self from map.
2. Resolve with `{ events: [], next_cursor: null }`.

**Cancel from `/unregister`:**
1. Clear timeout, delete from map, resolve with `{ events: [], next_cursor: null }`.
2. Peer's MCP server will hit its own cleanup (SIGTERM handler) and not retry.

## Concurrency & race rules

These race scenarios are the reviewer's primary pre-review target. Each has a named test (see §Test Plan).

1. **Waiter replacement** — if a peer issues a second `/poll-messages` while the first is still blocked (e.g., TCP reset + reconnect), broker cancels the first waiter (resolves it with empty) and installs the second. Map has at most one entry per peer, always.

2. **Resolve-vs-timeout** — broker-initiated resolve (message arrival) races with timeout firing. Mitigation: both code paths first call `pendingWaiters.delete(peerId)` and check whether the waiter is still in the map; if not, no-op. Atomic via JS single-threadedness (no `await` between check and action).

3. **Concurrent sends to same peer** — two `/send-message` calls arrive simultaneously for target P who has a waiter. First resolves the waiter with event A; second finds the waiter gone, inserts to DB, target P picks up event B on next poll. Both events end up delivered; only one benefits from long-poll's zero-latency path.

4. **Broker restart with pending waiters** — broker process dies. All in-memory waiters lost; HTTP connections drop. Peer's `brokerFetch` throws, `attemptSelfHeal` (server.ts:68-93) detects the outage, restarts broker, retries. New waiter installed on the fresh broker. No data loss because the DB is the source of truth for undelivered messages.

5. **Peer unregister with active waiter** — `/unregister` finds the waiter, cancels it, marks peer dead. MCP server's cleanup path already calls `/unregister` on SIGTERM (server.ts:755-773); new behavior is just "also tear down any open waiter."

6. **since_id replay during active waiter** — peer calls `/poll-messages` with `since_id=N` while a prior waiter for the same peer is still active. Same rule as scenario 1: first waiter cancelled, second installed with replay semantics.

7. **wait_ms=0 fast path alongside active waiter** — `check_messages` tool fires `/poll-messages` with `wait_ms=0` while the background poll loop has a long-poll waiter installed. Same replacement rule applies: the 0-wait call replaces the waiter, returns immediately; next background poll reinstalls.

## Test Plan (reviewer pre-review target)

All tests go in `broker.test.ts`. Each scenario gets a named `test(...)` block. Tests use the existing `registerPeer` helper and `brokerFetch` utility (already in the file).

### T1 — Long-poll resolves when a message arrives mid-block

**Scenario:** Peer A sends `/poll-messages` with `wait_ms=5000`. No messages pending. After 50 ms, Peer B sends a message to A via `/send-message`. A's poll returns within ~10 ms of the send.

**Asserts:**
- `elapsed < 200 ms` (well under the 5 s timeout)
- response.events.length === 1
- response.events[0].payload.text === "<sent message>"
- response.next_cursor === message.id

### T2 — Long-poll times out cleanly when no message arrives

**Scenario:** Peer A sends `/poll-messages` with `wait_ms=500`. No messages sent during that window.

**Asserts:**
- Response received after ≥ 500 ms, ≤ 700 ms
- response.events.length === 0
- response.next_cursor === null

### T3 — `wait_ms=0` fast path returns immediately with no pending

**Scenario:** Peer A sends `/poll-messages` with `wait_ms=0`. No pending events.

**Asserts:**
- `elapsed < 50 ms`
- response.events.length === 0
- No waiter installed on broker (verified by subsequent `/send-message` not triggering an early resolve on a non-existent prior poll)

### T4 — `wait_ms=0` with pending events returns them immediately without blocking

**Scenario:** Send 2 messages to Peer A (who is not polling). Then A sends `/poll-messages` with `wait_ms=0`.

**Asserts:**
- `elapsed < 50 ms`
- response.events.length === 2
- Events returned in `sent_at` order
- Both marked delivered after return

### T5 — Waiter replacement: second poll supersedes first

**Scenario:** Peer A sends `/poll-messages` with `wait_ms=5000`. 50 ms later, *before* any message arrives, A sends a second `/poll-messages` with `wait_ms=5000`. 50 ms after the second call, a message arrives.

**Asserts:**
- First poll's response: received quickly after second poll starts, events.length === 0 (cancelled, not timed out)
- Second poll's response: received ~50 ms after the message send, events.length === 1
- Broker's `pendingWaiters.size` returns to 0 after the message resolves the second waiter

### T6 — Concurrent sends to same peer deliver both (one via waiter, one via DB)

**Scenario:** Peer A is long-polling with `wait_ms=5000`. Two `/send-message` calls fire at the broker via `Promise.all([fetch(send1), fetch(send2)])`, both targeting A. Because the broker is single-threaded and `handleSendMessage` has no internal `await` between the waiter lookup and the resolve, the two handlers run to completion sequentially regardless of network dispatch order — the race is deterministic.

**Asserts:**
- A's long-poll returns with events.length === 1 (the first to arrive resolves the waiter)
- A subsequent `/poll-messages` (any wait_ms) from A returns events.length === 1 (the second message, now sitting as undelivered)
- Combined: both messages delivered, no drops

**Invariant being locked in:** the `pendingWaiters.get → delete → resolve` sequence inside `handleSendMessage` must remain atomic (no `await` between those three steps). Future refactors that introduce an `await` in that window MUST reintroduce atomicity (e.g., compare-and-swap pattern) or this test will start flaking.

### T7 — Unregister cancels pending waiter

**Scenario:** Peer A is long-polling with `wait_ms=30000`. 50 ms in, A sends `/unregister`.

**Asserts:**
- A's poll response returns within ~20 ms of the unregister
- response.events.length === 0
- `pendingWaiters.size === 0` after

### T8 — Broker restart cleanly resets waiter state (no zombies after restart)

**Scope (rescoped per reviewer):** broker-side lifecycle only. The test harness already spawns broker as a subprocess via `Bun.spawn(["bun", BROKER_SCRIPT], …)` at `broker.test.ts:74-82`, so killing and respawning is straightforward. This test does NOT cover the full `attemptSelfHeal` integration path in `server.ts` — that requires a server.ts test suite which is a separate gap tracked on the broker-maintainer backlog ("Step B" in the broker-test triage notes).

**Scenario:** Peer A registers against broker instance B1. A fires `/poll-messages` with `wait_ms=30000` (long-poll installed). Test kills `brokerProc` via `brokerProc.kill()`. A's fetch throws (connection drop — expected). Test spawns a replacement broker B2 on the same port with the same DB. Peer A re-registers (new session would do this via self-heal; here we do it manually). A fires a fresh `/poll-messages`, which installs a NEW waiter on B2 — independent of any state B1 had. A message sent after B2 is up reaches A via the new waiter.

**Asserts:**
- A's first poll against B1 throws a `TypeError` (fetch failed on socket close)
- After B2 spawns and A re-registers, a fresh poll succeeds
- Message sent post-restart is delivered via B2's waiter
- `GET /debug/waiters` on B2 shows exactly one entry for A during the poll, zero after resolve

**Placement:** last in the file. `bun test` runs source-order by default and `afterAll` DB cleanup should happen after this test to avoid leaking subprocess state into later tests.

### T9 — `since_id` returns replay without consuming `delivered` flag

**Scenario:** Send 3 messages to Peer A. A polls once with `wait_ms=0` (consumes all, marks them delivered). A polls again with `since_id=<first_message_id - 1>, wait_ms=0`.

**Asserts:**
- First poll: events.length === 3, all marked delivered in DB
- Second poll: events.length === 3 (replay — ignores `delivered` flag)
- Events from second poll have same payloads as first
- After second poll, DB rows still show `delivered=1` (replay is read-only)

### T10 — `since_id=0` returns all messages ever for peer

**Scenario:** Send 5 messages to Peer A over time, some delivered via normal polls, some not. A polls with `since_id=0, wait_ms=0`.

**Asserts:**
- Response contains all 5 messages regardless of delivery status
- Ordered by `id` ascending

### Asymmetry test — Verify send-message response unchanged

**Scenario:** Existing `/send-message` tests should all still pass unchanged. No new test needed; regression is sufficient.

### Coverage summary for reviewer

| Race window | Test |
|---|---|
| Waiter-resolved-mid-timeout | T1 |
| Timeout path | T2 |
| Fast path (wait_ms=0) | T3, T4 |
| Waiter replacement on reconnect | T5 |
| Concurrent send fan-out | T6 |
| Unregister drain | T7 |
| Broker-restart drain (integration) | T8 (may defer) |
| Replay via since_id | T9, T10 |

**Resolved by reviewer (rev 2):**

1. **T8 scope** — land in slice 2, broker-side only (not full self-heal integration). broker.test.ts already runs broker as subprocess (`broker.test.ts:74-82`), so lifecycle control is in-harness. Server.ts `attemptSelfHeal` integration coverage is a separate broker-maintainer backlog item and out of scope here.

2. **`pendingWaiters` introspection** — expose `GET /debug/waiters` UNCONDITIONALLY. No env gate. Returns `{ size: N, peers: [{peer_id, age_ms}, …] }`. Documented as debug-only, may change without version bump. `age_ms` computed from `PendingWaiter.installedAt` — which answers the "unused field" finding (F2) in the same stroke.

3. **Concurrent-send race** — no additional stress test needed; JS single-threading makes the race impossible with the current `handleSendMessage` shape. BUT a mandatory invariant comment must be added at the resolver hook warning future refactors that introduce an `await` between `pendingWaiters.get` and the `delete+resolve` MUST reintroduce atomicity. T6 as revised above locks in the behavioral contract.

## File structure

**Modifies:**
- `shared/types.ts` — new `Event`, updated `PollMessagesRequest` + `PollMessagesResponse`.
- `broker.ts` — waiter map, `/poll-messages` rewrite, `/send-message` + `/unregister` resolver hooks.
- `server.ts` — replace `setInterval(pollAndPushMessages, POLL_INTERVAL_MS)` with tight `while` loop; update `check_messages` tool to pass `wait_ms: 0`.
- `broker.test.ts` — T1-T10 tests added.

**Does not modify:**
- `cli.ts` — CLI semantics unchanged. `cli.ts send` and `cli.ts peers` still work; their poll behavior wasn't long-form, they use direct queries.
- Any existing test — regression suite must remain 24/24.

**Does not create:**
- No new files. Additive types in shared/types.ts only.

## Implementation tasks

*Dependencies: reviewer pre-reviews the Test Plan section above. Wait for greenlight before starting Task 1. All tasks commit individually (frequent commits per writing-plans skill). Run `bun test broker.test.ts` after every code task.*

---

### Task 1: Extend types in shared/types.ts

**Files:**
- Modify: `shared/types.ts` — add `Event`, update `PollMessagesRequest` and `PollMessagesResponse`.

- [ ] **Step 1: Apply the edit**

Append below the existing `Message` interface:

```typescript
// Transport-agnostic event envelope. Used by long-poll (Slice 2) and
// will be shared with SSE (Slice 6). Slice 2 only emits type: "message";
// Slice 4 adds type: "task_event".
export type EventType = "message" | "task_event";

export interface Event<P = unknown> {
  event_id: number;
  type: EventType;
  payload: P;
}
```

Replace `PollMessagesRequest` and `PollMessagesResponse`:

```typescript
export interface PollMessagesRequest {
  id: PeerId;
  wait_ms?: number;       // max block time, default 30_000
  since_id?: number;      // replay from event_id > since_id (ignores `delivered` flag)
}

export interface PollMessagesResponse {
  events: Event<Message>[];
  next_cursor: number | null;
}
```

- [ ] **Step 2: Typecheck both server + broker**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
```

Expected: BOTH fail to typecheck (broker.ts and server.ts still use the old `messages` field). Good — forces us to fix both in downstream tasks.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "types: add transport-agnostic Event envelope + long-poll fields

Pre-wires the Event<P> type that long-poll (Slice 2) and SSE (Slice 6)
will share. PollMessagesRequest gains optional wait_ms + since_id;
PollMessagesResponse now wraps events (typed) + next_cursor. Broker
and server.ts intentionally break typecheck until downstream tasks
land — contract-first.

Slice 2 of A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Write T1-T10 tests (failing)

**Files:**
- Modify: `broker.test.ts` — append T1-T10 tests.

- [ ] **Step 1: Write each test as a named `test(...)` block**

Tests T1-T10 from the Test Plan section, each as its own `test("T{N} — ...", async () => {...})`. Example skeleton for T1:

```typescript
test("T1 — long-poll resolves when a message arrives mid-block", async () => {
  const { id: aid } = await registerPeer({ cwd: "/tmp/t1-a" });
  const { id: bid } = await registerPeer({ cwd: "/tmp/t1-b" });
  const started = Date.now();

  // A starts long-poll in background
  const pollPromise = brokerFetch<{
    events: { event_id: number; type: string; payload: { text: string } }[];
    next_cursor: number | null;
  }>("/poll-messages", { id: aid, wait_ms: 5000 });

  // After 50 ms, B sends to A
  await new Promise((r) => setTimeout(r, 50));
  await brokerFetch("/send-message", { from_id: bid, to_id: aid, text: "hello T1" });

  const { data } = await pollPromise;
  const elapsed = Date.now() - started;

  expect(elapsed).toBeLessThan(200);
  expect(data.events.length).toBe(1);
  expect(data.events[0].payload.text).toBe("hello T1");
  expect(data.next_cursor).toBe(data.events[0].event_id);
});
```

Fill in T2-T10 analogously, matching the "Asserts" bullets from the Test Plan section.

- [ ] **Step 2: Run tests (all should fail)**

```bash
bun test broker.test.ts
```

Expected: T1-T10 fail. Prior 24 tests still pass. Failure messages should indicate "events is undefined" or similar (because the current broker returns `messages`, not `events`).

- [ ] **Step 3: Commit**

```bash
git add broker.test.ts
git commit -m "test: add T1-T10 long-poll scenarios (failing per TDD)

Ten tests covering: resolve-mid-block (T1), timeout (T2), fast-path
(T3, T4), waiter replacement (T5), concurrent fan-out (T6),
unregister drain (T7), broker-restart drain (T8 — may defer to
integration), since_id replay (T9, T10). All currently fail; will
turn green as broker.ts and server.ts catch up in subsequent tasks.

Slice 2 of A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.5: Reviewer pre-review checkpoint (failing tests)

Per reviewer's meta-suggestion: before implementing the broker side, hand off the failing-tests state for a second pre-review pass. This catches test-shape issues (wrong assertion granularity, brittle timing assumptions, missing invariant coverage) when they're cheap to fix — *before* the broker implementation has to match the assertions.

- [ ] **Step 1: Push the current branch state**

Branch should now have two commits beyond the design doc:
```
<sha> test: add T1-T10 long-poll scenarios (failing per TDD)
<sha> types: add transport-agnostic Event envelope + long-poll fields
<sha> docs: add slice-2 design with test plan upfront (rev 2)
```

```bash
git push origin feat/a2a-lite-slice-2
```

- [ ] **Step 2: Ping reviewer**

Send a message via `mcp__claude-peers__send_message` to the reviewer peer ID, confirming: (a) all 10 new tests are present and named per Test Plan, (b) they all currently fail for the right reasons (broker returns `messages` not `events`, missing `wait_ms` parameter, etc.), (c) the prior 24 tests remain passing, (d) ready for test-shape review.

- [ ] **Step 3: Wait for reviewer greenlight on the tests themselves**

Do not start Task 3 until reviewer confirms the failing tests match the plan and are failing for the documented reasons. If reviewer requests test changes, iterate here before touching broker code.

---

### Task 3: Implement broker waiter map + resolver hooks

**Files:**
- Modify: `broker.ts` — add `pendingWaiters` map, update `/poll-messages`, `/send-message`, `/unregister` handlers.

- [ ] **Step 1: Add the waiter map type, constants, and BadRequestError**

Near the top of `broker.ts` (after imports, before handlers):

```typescript
// Thrown by handlers when input is invalid. The HTTP catch layer maps this
// to 400 instead of the generic 500. Keeps protocol misuse distinguishable
// from broker bugs in server logs + client error handling.
class BadRequestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadRequestError";
  }
}

type PendingWaiter = {
  resolve: (response: PollMessagesResponse) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  installedAt: number;        // ms epoch — surfaced as age_ms in /debug/waiters
};

const pendingWaiters = new Map<PeerId, PendingWaiter>();
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 120_000;  // hard cap; requests exceeding this return 400
```

- [ ] **Step 2: Rewrite `handlePollMessages`**

Replace the existing `handlePollMessages` function with:

```typescript
async function handlePollMessages(
  body: PollMessagesRequest,
): Promise<PollMessagesResponse> {
  const { id, wait_ms, since_id } = body;

  // Gather any immediately-available events.
  const pending = since_id !== undefined
    ? (db.query(
        "SELECT * FROM messages WHERE to_id = ? AND id > ? ORDER BY id ASC",
      ).all(id, since_id) as Message[])
    : (selectUndelivered.all(id) as Message[]);

  if (pending.length > 0) {
    // Normal-mode: mark delivered. Replay-mode: read-only.
    if (since_id === undefined) {
      for (const m of pending) markDelivered.run(m.id);
    }
    return {
      events: pending.map((m) => ({
        event_id: m.id,
        type: "message" as const,
        payload: m,
      })),
      next_cursor: pending[pending.length - 1]!.id,
    };
  }

  // Fail loud on protocol misuse rather than silently clamping — a caller
  // asking for wait_ms=3_600_000 and getting back at 2 min would be confused.
  // BadRequestError is caught in the HTTP handler below and mapped to 400;
  // generic Error still maps to 500. See broker.ts fetch handler.
  if (wait_ms !== undefined && wait_ms > MAX_WAIT_MS) {
    throw new BadRequestError(
      `wait_ms=${wait_ms} exceeds MAX_WAIT_MS=${MAX_WAIT_MS}`
    );
  }
  const waitMs = wait_ms ?? DEFAULT_WAIT_MS;
  if (waitMs <= 0) {
    return { events: [], next_cursor: null };
  }

  // Install waiter, replacing any prior one for this peer.
  cancelWaiter(id);

  return new Promise<PollMessagesResponse>((resolve) => {
    const timeoutHandle = setTimeout(() => {
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

function cancelWaiter(id: PeerId): void {
  const w = pendingWaiters.get(id);
  if (!w) return;
  clearTimeout(w.timeoutHandle);
  pendingWaiters.delete(id);
  w.resolve({ events: [], next_cursor: null });
}
```

- [ ] **Step 3: Update `handleSendMessage` to resolve the waiter**

Inside `handleSendMessage`, after the `insertMessage.run(...)` line and before the return, add:

```typescript
  // INVARIANT: no `await` between pendingWaiters.get and the delete+resolve
  // that follows. Atomicity here is the reason T6's concurrent-send test
  // passes deterministically in single-threaded JS. Future refactors that
  // introduce an await in this window MUST reintroduce atomicity (e.g.
  // compare-and-swap pattern) or T6 will start flaking.
  const waiter = pendingWaiters.get(body.to_id);
  if (waiter) {
    clearTimeout(waiter.timeoutHandle);
    pendingWaiters.delete(body.to_id);

    // Fetch the row we just inserted. bun:sqlite's last_insert_rowid() is
    // scoped to this db connection, so it's safe to use inline.
    const row = db.query(
      "SELECT * FROM messages WHERE id = last_insert_rowid()",
    ).get() as Message;

    // Mark delivered — the waiter's HTTP response will carry the payload,
    // so this event is consumed as if the peer had polled normally.
    markDelivered.run(row.id);

    waiter.resolve({
      events: [{ event_id: row.id, type: "message", payload: row }],
      next_cursor: row.id,
    });
  }
```

- [ ] **Step 4: Update `handleUnregister` to cancel the waiter**

At the top of `handleUnregister`, before the existing `markPeerDead.run(...)`:

```typescript
  cancelWaiter(body.id);
```

- [ ] **Step 5: Add `/debug/waiters` GET endpoint and BadRequestError→400 mapping**

Unconditional debug endpoint (localhost-only broker, non-sensitive data, no env gate per reviewer). Add to the `Bun.serve` handler in `broker.ts`:

```typescript
// In the GET branch of the fetch handler, alongside /health:
if (path === "/debug/waiters") {
  const now = Date.now();
  const peers = Array.from(pendingWaiters.entries()).map(([peer_id, w]) => ({
    peer_id,
    age_ms: now - w.installedAt,
  }));
  return Response.json({ size: pendingWaiters.size, peers });
}
```

Update the POST catch layer to map `BadRequestError` to HTTP 400:

```typescript
} catch (e) {
  if (e instanceof BadRequestError) {
    return Response.json({ error: e.message }, { status: 400 });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg }, { status: 500 });
}
```

Document in `README.md` under a new "Debug endpoints" heading:

> `GET /debug/waiters` — localhost-only introspection into the broker's in-memory long-poll waiter map. Returns `{ size: number, peers: [{peer_id, age_ms}, …] }`. Debug-only, format may change without version bump.

- [ ] **Step 6: Run tests**

```bash
bun test broker.test.ts
```

Expected: all of T1-T10 pass (T8 now lands in slice 2 per reviewer rescope). Existing 24 tests still pass.

- [ ] **Step 7: Commit**

```bash
git add broker.ts README.md
git commit -m "broker: long-poll /poll-messages with in-memory waiter map

Install pendingWaiters Map<PeerId, {resolve, timeoutHandle, installedAt}>. 
/poll-messages: if no pending events, install a waiter with wait_ms
timeout; resolve on message arrival or timeout. Second poll from the
same peer cancels the first (connection-reset reconnect safety).
/send-message: resolve target's waiter with the new event before
HTTP response (atomic get/delete/resolve — invariant commented).
/unregister: cancel any pending waiter.

since_id enables read-only replay (ignores delivered flag). wait_ms=0
is the fast path used by check_messages tool. wait_ms > MAX_WAIT_MS
fails loud with HTTP 400 via BadRequestError.

New /debug/waiters GET endpoint (unconditional, localhost-only)
exposes { size, peers: [{peer_id, age_ms}] } for introspection.

Slice 2 of A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Adapt server.ts poll loop to long-poll

**Files:**
- Modify: `server.ts` — replace `setInterval(pollAndPushMessages, ...)` with a tight async loop.

- [ ] **Step 1: Rewrite `pollAndPushMessages`**

Change its signature to return `void` (not a promise that's setInterval-ed), and change the broker call to pass `wait_ms: 30_000`:

```typescript
async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
      id: myId,
      wait_ms: 30_000,
    });
    for (const event of result.events) {
      // Slice 2 only emits type: "message"; future slices expand.
      if (event.type !== "message") continue;
      const msg = event.payload as Message;
      // ... existing enrichment + channel push logic unchanged ...
      // (copy the body of the existing for-of loop over result.messages,
      // substituting `msg` for `m`)
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
    // On connection error, self-heal will have fired inside brokerFetch.
    // Back off briefly before retrying to avoid tight error loops.
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

- [ ] **Step 2: Replace `setInterval` with a driver loop**

At `server.ts:742`, replace:

```typescript
const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
```

with:

```typescript
// Long-poll driver: pollAndPushMessages blocks up to 30s on the broker;
// the `while` loop immediately reconnects on every return (events arrived,
// timeout fired, or transient error after self-heal).
let pollLoopActive = true;
(async () => {
  while (pollLoopActive) {
    await pollAndPushMessages();
  }
})();
```

Update the cleanup handler (`server.ts:755-773`) with explicit ordering so SIGTERM doesn't block for up to 30 s waiting for the long-poll to return on its own:

```typescript
  const cleanup = async () => {
    // Order matters: flip the flag BEFORE /unregister. The /unregister
    // call cancels the broker-side waiter (handleUnregister calls
    // cancelWaiter), which resolves the long-poll with empty events,
    // which unblocks pollAndPushMessages, which returns to the while
    // loop, which sees pollLoopActive=false and exits. Without this
    // ordering the flag-check happens only after the 30s timeout fires.
    pollLoopActive = false;
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };
```

The existing `clearInterval(pollTimer)` line is removed — there's no longer a `pollTimer`; the driver loop replaces it.

Delete the now-unused `POLL_INTERVAL_MS` constant at server.ts:39.

- [ ] **Step 3: Update `check_messages` tool to pass `wait_ms: 0`**

In the `check_messages` handler (server.ts:575 area), update the brokerFetch call:

```typescript
const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
  id: myId,
  wait_ms: 0,
});
```

Update the loop over `result.messages` → `result.events` with the same `if (event.type !== "message") continue;` guard.

- [ ] **Step 4: Typecheck + test**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun test
```

Expected: both builds exit 0; all T1-T10 pass (T8 included per rescope); existing 24 regression tests pass.

- [ ] **Step 5: Manual smoke test**

Start broker in one terminal (`bun broker.ts`). In another, start an MCP server (pipe `server.ts` with minimal stdio). Send a message from a third shell via `bun cli.ts send <peer-id> hello`. Verify the MCP server's stderr shows `Pushed message from …: hello` within <100 ms of the send.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "server: switch to long-poll driver loop (replaces setInterval)

pollAndPushMessages now blocks on the broker for up to 30s via
wait_ms. Driver loop reconnects immediately on every return.
check_messages tool uses wait_ms=0 fast path so the MCP worker
doesn't stall on tool calls. POLL_INTERVAL_MS removed.

Expected impact: delivery latency avg 500ms → <50ms; idle broker
load N req/s → N req/30s (~30x reduction).

Slice 2 of A2A-lite plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: End-of-slice verification + push

- [ ] **Step 1: Full verification**

```bash
bun build server.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun build broker.ts --target=bun --outdir=/tmp/claude-peers-typecheck
bun test
git log --oneline main..HEAD
```

Expected: builds clean; all T1-T10 pass (T8 included); 5 commits on the branch:

```
<sha> server: switch to long-poll driver loop (replaces setInterval)
<sha> broker: long-poll /poll-messages with in-memory waiter map
<sha> test: add T1-T10 long-poll scenarios (failing per TDD)
<sha> types: add transport-agnostic Event envelope + long-poll fields
<sha> docs: add slice-2 design with test plan upfront (rev 2)
```

(The docs commit is the one this task list itself lands under; rev 2 suffix reflects reviewer pre-review incorporation.)

- [ ] **Step 2: Stop and surface for review**

Do not push. Do not merge. Report to the user with:
- Branch name, commit list, test summary (N/M pass)
- Whether T8 landed or was deferred (and why)
- Ask whether to push + open PR, or iterate first

## Impact & rollback

**Impact** (Slice 2 alone, measured against post-slice-1 baseline):

| Metric | Before | After |
|---|---|---|
| Delivery latency (avg) | ~500 ms (poll lag) | <50 ms (waiter resolve + RTT) |
| Delivery latency (p99) | ~1000 ms | <100 ms |
| Idle broker req/sec per peer | 1 | ~0.033 (once per 30s) |
| Idle broker CPU (5 peers) | ~5 req/s | ~0.17 req/s |

**Rollback:**

Slice 2 has no schema changes. Rollback is a pure `git revert` of the 4-5 commits on this branch (after merge) — or `git revert --no-edit HEAD~5..HEAD` in one shot. No DB cleanup, no filesystem cleanup, no stuck state.

The in-memory waiter map disappears with the broker process on every restart, so there's no state to reconcile even during rollback.

---

*End of slice 2 design.*
