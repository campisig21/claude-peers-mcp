# A2A-lite Slice 6 — SSE CLI-Tail Byproduct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a live audit stream for humans + future remote transports. Broker exposes `GET /events/stream` as Server-Sent Events (SSE) emitting the same transport-agnostic `Event<Message | TaskEvent>` envelope used by `/poll-messages`. New `bun cli.ts tail` subcommand consumes it for `tail -f`-style live viewing. Validates that the envelope truly carries across transports and lays the landing pad for a future remote-transport flip.

**Architecture:** In-memory `Set<Subscriber>` in broker mirroring `pendingWaiters`'s ownership model. Every `/send-message`, `/dispatch-task`, `/send-task-event` handler fan-outs the new event to active subscribers after its DB write. SSE body is a `ReadableStream` assembled from each subscriber's own `ReadableStreamDefaultController`. CLI subcommand uses `fetch` with streaming body + `TextDecoderStream` to split on `\n\n` boundaries.

**Tech Stack:** `Bun.serve` (already used), native `ReadableStream` / `TextDecoderStream`. No new dependencies.

---

## HOLD-UNTIL-GREENLIGHT Notice (Task 2.5)

Same hard-hold semantics as slices 4 and 5. Failing tests land; ping reviewer; STOP until explicit "GREENLIT for Task 3." Rationale: slice 6 adds a new long-lived HTTP connection model + cross-process streaming — small surface but new concurrency shape (connection lifecycle, stream backpressure, graceful disconnect).

---

## Scope Boundary

**In scope:**
- Broker endpoint `GET /events/stream` — SSE connection emitting new events as they land.
- Broker in-memory `sseSubscribers: Set<Subscriber>` with install + teardown hooks.
- Broker event-insert paths (`/send-message`, `/dispatch-task`, `/send-task-event`) fan-out to subscribers after DB commit.
- SSE event frame format: single event type, JSON-encoded `Event<Message | TaskEvent>` envelope on the `data:` line.
- `cli.ts tail` subcommand: open SSE connection, pretty-print each event as it arrives, exit on Ctrl-C (stream close).
- Tests: broker-side SSE behavior (handshake + fan-out + disconnect cleanup + no push-policy filter), CLI subprocess integration test.

**Out of scope (explicitly — deferred):**
- `?from=<cursor>` query param / historical replay. This is slice 7's `bun cli.ts replay` responsibility. SSE endpoint is live-only in slice 6. Subscribing emits no backfill; only events inserted AFTER the connection comes up flow through.
- Any filtering by participant, role, or task. The audit tail sees EVERY event regardless of `shouldPush`. Rationale: the tail is a forensic view for the operator running the broker; suppressing events would defeat the purpose.
- Authentication or origin checks. Endpoint remains localhost-only via `Bun.serve({ hostname: "127.0.0.1" })`. Same posture as the rest of the broker.
- Reconnect / heartbeat / keep-alive beacons. Curl + browsers tolerate long-idle SSE fine; if we observe intermediary proxy drops in a future remote-transport slice, heartbeats get added then.
- `cli.ts tail` filters (by task_id, by type, etc.). Future ergonomics.

**Risk class:** Low. Pure additive endpoint. No changes to existing behavior of `/send-message`, `/dispatch-task`, `/send-task-event`, `/poll-messages`. New failure mode (subscriber fan-out error) is localized and logs-only.

---

## Design Decisions (slice-local)

### D1. SSE endpoint is live-only — no `?from=<cursor>` backfill in slice 6

The parent spec mentions `?from=<cursor>` as part of the SSE shape. Slice 6 ships without it because:
- Event IDs are per-type (messages.id and task_events.id are independent AUTOINCREMENT sequences). A single-integer cursor is ambiguous. Resolving it either requires a composite cursor (`from=msg:42,te:17`) or a cross-type ordering (sent_at timestamp, with ms-collision caveats).
- Either resolution is a design surface in its own right. Better to ship live-only first (smaller surface, proves transport-agnosticity), and land backfill in a later slice when the cursor semantics can be designed in isolation.
- Slice 7's `bun cli.ts replay` will already read from DB directly (not via SSE). The replay use case is covered without SSE backfill.

Alternative considered: emit backfill using `audit_stream` view sorted by `sent_at`. Rejected because the slice 3 design note explicitly left audit_stream unordered (callers order at query time). Embedding a tiebreaker in slice 6 is out of scope.

### D2. Event frame format — JSON-encoded envelope, no `event:` field

SSE frames look like:
```
data: {"event_id":42,"type":"message","payload":{...},"push":true}

```

(Blank line terminates each frame per SSE spec.) We do NOT use the optional `event:` field; the `type` inside the JSON envelope is already the discriminator. Keeps the parser trivial on the CLI side (`split('\n\n')` → `JSON.parse(frame.slice(5))`), and matches how `/poll-messages` consumers already parse Events.

### D3. Fan-out happens AFTER DB commit, mirroring the fs-audit-write pattern from slice 4

The three event-insert handlers (`/send-message`, `/dispatch-task`, `/send-task-event`) already write to DB + fs + resolve pending waiters in a fixed order. Slice 6 adds `broadcastToSubscribers(event)` as the final step in each. If a subscriber's controller errors (closed connection, backpressure overflow), the error is caught per-subscriber, logged, and that subscriber is dropped from the set. No failure mode propagates back to the event producer.

### D4. Subscriber lifecycle — added on request, removed on abort/close/error

Each SSE connection registers its `ReadableStreamDefaultController` with the broker at request time. Three teardown paths:
- Client disconnect: `request.signal` fires abort → controller.close() + set.delete(subscriber).
- Stream.close() throws: per-subscriber try/catch in broadcast handler → set.delete(subscriber).
- Broker shutdown: afterAll-style hook iterates set.forEach(s => s.controller.close()) (wired in tests; production never explicitly shuts down).

No keepalive / ping frames in slice 6 (out of scope per §Scope Boundary).

### D5. No push-policy filtering on the audit tail

`shouldPush` does NOT apply on SSE. Every event goes to every subscriber. The tail is a forensic view that needs to see the full event history to be useful — a "silent" task_event hiding from the operator would defeat the purpose.

Implication: the `push` field still ships on each SSE event (it's part of the envelope), but the SSE consumer ignores it. A future feature (e.g. "filter tail to push-worthy events") can layer on `event.push === true` at the CLI level.

### D6. CLI `tail` subcommand — no flags in slice 6

`bun cli.ts tail` takes zero arguments. Opens SSE connection to the broker, pretty-prints each event as it arrives, exits on Ctrl-C (SIGINT) or on stream EOF. One-liner output format per event:

```
14:02:17  [message]    from swift-otter  to quiet-comet  "hello"
14:03:01  [task_event] T-34 dispatch from coordinator (swift-otter) to quiet-comet, bright-falcon
14:04:22  [task_event] T-34 question   from quiet-comet (impl-backend-A) → swift-otter
```

Future ergonomics (filters, richer formatting, JSON output) can land as flags in later slices. Slice 6 ships the plainest useful shape.

### D7. Test strategy — broker-side uses native `fetch` + `ReadableStream.getReader()`; CLI-side spawns subprocess

SSE is a streaming protocol; tests need to start a connection, send events, observe them on the wire, then close. bun's test runner supports `fetch` with body streaming; we read via `getReader()` and assert on decoded chunks.

For the CLI subcommand, spawn `bun cli.ts tail` as a subprocess with piped stdout; send events via broker; assert stdout contains expected lines; kill process.

---

## Broker API — new endpoint

### `GET /events/stream`

**Request:** no body, no query params (slice 6). `Accept: text/event-stream` expected but not enforced — broker sends SSE regardless because this is the only content type it speaks on this path.

**Response:** HTTP 200, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `Connection: keep-alive`. Body is a `ReadableStream` that stays open until the client disconnects or the server shuts down.

**Stream content:** sequence of SSE frames, one per event. Each frame is:

```
data: <JSON-encoded Event envelope>\n
\n
```

(Two trailing `\n` bytes per SSE spec — blank line terminates the frame.)

**Event shape:** identical to `/poll-messages` response's `events[i]`:

```typescript
{
  event_id: number,
  type: "message" | "task_event",
  payload: Message | TaskEvent,
  push: boolean,
}
```

**Error modes:**
- Broker down: connection fails at handshake (ECONNREFUSED). CLI should print a friendly error.
- Client disconnects mid-stream: broker cleans up subscriber from the set (no error propagates).
- Fan-out write error: broker catches per-subscriber, logs, drops that subscriber.

---

## File Structure

**Modify:**
- `broker.ts` — add `sseSubscribers` set + `broadcastToSubscribers()` helper + `handleEventsStream()` Response builder + fan-out calls in three insert handlers.
- `cli.ts` — add `tail` case to the command dispatcher.
- `broker.test.ts` — new `describe("A2A-lite SSE tail (Slice 6)", ...)` block before T8.

**Create:**
- `docs/a2a-lite-slice-6.md` — this document.

**Not touched:**
- `server.ts` — MCP server is a consumer of `/poll-messages`, not `/events/stream`. No changes.
- `shared/*` — no new types (`Event` envelope already has everything needed).

---

## Test Plan (for Task 2.5 pre-review)

Tests live in `broker.test.ts` under new describe before T8. SSE tests need to manage the lifetime of streaming connections explicitly; each test opens a reader, does its assertions, closes cleanly to avoid stranded subscribers affecting subsequent tests.

### H. Handshake

**H1: `GET /events/stream` returns 200 + SSE content-type.**
```typescript
const res = await fetch(`${BROKER_URL}/events/stream`);
expect(res.status).toBe(200);
expect(res.headers.get("content-type")).toContain("text/event-stream");
res.body!.cancel();
```

**H2: broker exposes subscriber count via `/debug/waiters`-like endpoint (or extend `/debug/waiters`).**
Extend existing `/debug/waiters` endpoint to include `sse_subscribers: number`. Test registers one SSE connection, polls debug endpoint, asserts count = 1. Cancels connection, asserts count back to 0 after a small grace window.

### F. Fan-out

**F1: message insert reaches an active SSE subscriber.**
Open SSE connection on peer A's fetch handle. Peer B sends a message via `/send-message`. Assert the subscriber receives a frame within ~500ms containing the message's text.

**F2: dispatch_task reaches the SSE subscriber.**
Open SSE. Dispatch a task. Assert subscriber receives a `task_event` frame with intent=dispatch.

**F3: send_task_event reaches the SSE subscriber.**
Open SSE. Dispatch. Send a state_change. Assert subscriber receives both the dispatch and the state_change events.

**F4: events include the `push` field.**
Open SSE. Dispatch with observers. Send event. Assert the observer's push=false still appears in the SSE frame (the tail sees ALL events including suppressed ones — D5).

### M. Multi-subscriber

**M1: two concurrent subscribers both receive the same event.**
Open two SSE connections. Send one message. Both subscribers receive it.

**M2: subscriber disconnect does not affect remaining subscribers.**
Open two SSE connections. Cancel the first. Send a message. The remaining subscriber receives it. Debug endpoint reports count = 1.

### D. Disconnect cleanup

**D1: subscriber set empties after all disconnect.**
Open SSE. Cancel. Wait briefly. Assert `sse_subscribers` count = 0 via debug endpoint.

**D2: abrupt close (body.cancel without reading) leaves no stragglers.**
Open SSE. Immediately call `res.body!.cancel()`. Assert debug count drops to 0.

### C. CLI integration

**C1: `bun cli.ts tail` subprocess prints events and exits cleanly on SIGTERM.**
Spawn tail subprocess with piped stdout. Send a message via broker. Read subprocess stdout for a few lines. Verify a line containing the message text. Send SIGTERM; wait for exit; assert exit code ≤ 143 (standard SIGTERM handling). Requires a 5s test timeout with early exit on assertion success.

**C2: tail prints both message and task_event lines with correct formatting.**
Spawn tail. Send message A → B. Dispatch task A → [B]. Read stdout. Assert one `[message]` line and one `[task_event]` line. Kill subprocess.

### Pre-review questions for reviewer

1. **D1 — no `?from` backfill in slice 6.** Happy with deferral to a future dedicated cursor-design slice? Alternative: ship with sent_at-timestamp backfill + accept ms-collision caveat.
2. **D2 — no `event:` field on SSE frames.** Keeps parser trivial but breaks a browser `EventSource` consumer that filters by event type. Not a slice-6 use case, flagging for awareness.
3. **D5 — tail sees all events, no shouldPush filter.** Agree tail should be forensic/complete? Alternative: respect push flag (would match MCP server behavior but defeats the purpose of an audit tail).
4. **Extend `/debug/waiters` to include `sse_subscribers` count vs new `/debug/sse` endpoint.** I lean extend — fewer surfaces.
5. **D7 — SSE test strategy.** Testing streams without hanging is fragile. Using `getReader().read()` with a per-chunk timeout + explicit close. Alternative: test via the CLI subprocess which does its own read loop. I'm planning both.
6. **C1/C2 CLI subprocess tests.** Subprocesses in bun test are fine but can accumulate zombies. Want me to add an afterEach cleanup pattern for spawned tails, or rely on test-local try/finally?
7. **Fan-out error handling.** Per-subscriber try/catch + drop on error. A pathological subscriber that ENOMEMs mid-write won't break other subscribers. Agree?

---

## Tasks

### Task 1: Commit design doc

- [ ] Verify + commit.

### Task 2: Write failing tests

- [ ] `broker.test.ts` gains a new `describe("A2A-lite SSE tail (Slice 6)", ...)` block before T8.
- [ ] CLI tests use `Bun.spawn(["bun", "cli.ts", "tail"])` with piped stdout.
- [ ] Run `bun test -t "SSE tail"` — expect all to fail (`/events/stream` returns 404 today).

### Task 2.5: HARD HOLD for reviewer pre-review

Ping yb6oeqry with test shape summary and the 7 open questions. STOP.

### Task 3: Implement

- [ ] **3a:** Add `sseSubscribers: Set<Subscriber>` type + ctor + broadcast helper in broker.ts.
- [ ] **3b:** Add `handleEventsStream(req)` returning `new Response(readableStream, { headers })`. Install subscriber on request, remove on `req.signal` abort.
- [ ] **3c:** Wire `broadcastToSubscribers(event)` into `/send-message`, `/dispatch-task`, `/send-task-event` after DB commit.
- [ ] **3d:** Route `GET /events/stream` in the HTTP handler.
- [ ] **3e:** Extend `/debug/waiters` endpoint response with `sse_subscribers` count.
- [ ] **3f:** Add `tail` case to `cli.ts` that fetches `/events/stream`, decodes with `TextDecoderStream`, splits on `\n\n`, JSON-parses each frame's data line, prints a formatted one-liner.

### Task 4: Full-suite verification

- [ ] `bun test` — all green, no stranded subscribers between tests.
- [ ] Manual smoke: run `bun broker.ts` in one terminal + `bun cli.ts tail` in another + trigger events from a third → confirm live output.

### Task 5: Post-impl review

PR with medium codex. Ping reviewer.

### Task 6: Merge

`gh pr merge --rebase --delete-branch` on greenlight.

---

## Rollback

`git revert` the impl commit(s). SSE endpoint is purely additive; nothing in existing behavior depends on it. In-memory subscriber set disappears with the broker process.

---

*End of slice 6 plan.*
