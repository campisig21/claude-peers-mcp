# A2A-lite Slice 5 — Role-Aware Push Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate delivery (universal, cursor-driven, already shipping in slice 4) from push (selective channel notification). Implement `shouldPush(event, receiver)` as a pure function applying the parent spec's five suppression rules. Broker tags each Event in a poll batch with a `push: boolean` flag; MCP server fires channel notification only when `push === true`. This is where the headline "~60-67% pushes suppressed per role" impact lands.

**Architecture:** Pure filter function in a new `shared/push-policy.ts`. Broker computes `push` per-(event, receiver) in two sites: the poll-batch builder in `handlePollMessages` and the immediate-waiter-resolve path in `deliverTaskEventToPeer`. The Event envelope grows one optional field — `push?: boolean` — defaulting to `true` when absent (backwards-compat for message events, which never require suppression).

**Tech Stack:** No new dependencies. Extending existing broker + server + shared modules.

---

## HOLD-UNTIL-GREENLIGHT Notice (Task 2.5)

Same hard-hold semantics as slice 4. After Task 2's failing tests land, ping the reviewer and STOP. No timeout fallback. No auto-proceed on silence. Only a reviewer "GREENLIT" (or equivalent) unblocks Task 3.

Rationale for slice 5: although the concurrency surface is smaller than slice 4 (pure-function filter + two integration sites already covered by slice-4 tests), the semantic surface is where the user-facing behavior change lives. Wrong rule ordering, missed observer case, or off-by-one on question/answer targeting would produce silently-dropped pushes — harder to catch than crashes.

---

## Scope Boundary

**In scope:**
- `shared/push-policy.ts`: pure function `shouldPush(event, receiver_participant)` applying the five rules.
- `shared/types.ts`: extend `Event<P>` with optional `push?: boolean`.
- Broker: compute `push` flag per-(event, receiver) in `handlePollMessages` and `deliverTaskEventToPeer`. Message events never suppress (always `push: true`); task_events apply shouldPush.
- Broker `dispatch_task` endpoint: accept optional `observers?: string[]` field — overlay that forces `role_at_join='observer'` on those participants. Provides the test surface for rule 1 and is a small UX win (dispatcher can explicitly designate observers at dispatch).
- MCP server: `pollAndPushMessages` checks `event.push` and skips the channel notification when `false`. Event still gets normal internal handling.
- Tests: new `describe("A2A-lite push policy (Slice 5)", ...)` block with unit-like (per-rule) + integration (Appendix A worked example) coverage.

**Out of scope:**
- Changing delivery semantics. Sender exclusion + cursor advancement remain slice-4 behavior.
- SSE endpoint (`/events/stream`) and `cli.ts tail` — slice 6.
- `cli.ts replay` — slice 7.
- Dynamic role_at_join changes mid-task (participants are pinned at dispatch per D1 from slice 4).
- Per-peer notification-mute preferences or per-task push overrides. The five-rule filter is the single source of truth.

**Risk class:** Low-Medium. Pure-function filter with a small blast radius. Integration points are two call sites, both in broker paths already test-covered by slice 4. Risk is correctness of the rules themselves (rule ordering, subtle truthiness, JSON parsing).

---

## The Five Rules (verbatim from parent spec §Push Policy)

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

Per-rule rationale:
1. **Observer rule:** Observers are participants for audit purposes but are not expected to respond. Push would be noise.
2. **Sender rule:** The sender already knows about their own event. Redundant with slice-4's delivery-level sender exclusion, kept as defense-in-depth.
3. **state_change→working suppression:** "X is working on it" is low-value for everyone except the actor themselves. Universally suppressed.
4. **Targeted question:** A question with `data.to = X` is directed at X. Other participants receive it for audit but don't need an interrupt.
5. **Targeted answer:** An answer with `data.reply_to_from = X` replies to a question X asked. Only X needs the push.

Default (no rule fires): push.

---

## Design Decisions (slice-local)

### D1. `Event<P>` gets an optional `push?: boolean` field; absence = `true`

Wire shape grows minimally. Existing `message` events do not need suppression (point-to-point, sender excluded from delivery, always push) — they can omit the field, and consumers treat absence as `push: true` (backwards-compat). Task_events emitted by slice 5's handlers always set the field explicitly — `true` or `false` — so a test can assert `event.push === true` or `=== false` unambiguously, not `=== undefined`.

Alternative considered: add `push` as a required field on `Event`. Rejected: breaks backwards-compat with any external consumer reading slice-4 events; no functional benefit.

### D2. `shouldPush` lives in `shared/push-policy.ts`, pure and dependency-free

Keeps the rule matrix in one file with dedicated unit tests (pure function is trivial to test). Slice 7's replay may need to re-derive push decisions for historical events if we ever log them — same import.

### D3. Participant `role_at_join` is looked up once per event and passed to `shouldPush`

Broker fetches `task_participants` for the event's task (already happens in slice-4 `handleSendTaskEvent` for waiter resolution). Each row carries `role_at_join`. Pass the row to `shouldPush` directly. No extra queries.

For the poll-batch path (`handlePollMessages` + `selectTaskEventsSincePeer`), the receiver is the polling peer; we need THEIR `role_at_join` for each task the event belongs to. A single JOIN'd query is cleanest:

```sql
SELECT te.*, tp.role_at_join
FROM task_events te
INNER JOIN task_participants tp ON tp.task_id = te.task_id
WHERE tp.peer_id = ? AND te.id > ? AND te.from_id != ?
ORDER BY te.id ASC
```

The `role_at_join` rides along with the event row into `shouldPush`. Row is projected out of the response payload — only broker-internal consumption.

### D4. Message events always `push: true`; task_events always explicit

In `handlePollMessages`, when building the union batch, message events get `push: true` added explicitly. Task_events get the shouldPush result. Keeps the Event envelope uniform — every event in a slice-5+ batch has an explicit `push` field, never `undefined`. Absence is reserved for pre-slice-5 producers (none currently, but future-proof).

### D5. `dispatch_task.observers` is an optional string[] overlay

Participants in `participants[]` default to `role_at_join = null` (or `'dispatcher'` for the caller). If `observers[]` is present, resolved observer IDs get `role_at_join = 'observer'` in `task_participants`. An ID in both lists is reconciled to `'observer'` (observers takes precedence). Dispatchers cannot observe their own tasks — `from_id` appears as `'dispatcher'` even if listed in `observers`.

Alternative considered: allow `participants: Array<string | {id, role_at_join}>`. Rejected: more ergonomic via a separate `observers` field — dispatcher can use roles mixed with peer_ids freely without switching shape mid-array.

### D6. MCP server skips channel notification when `event.push === false`; internal state unchanged

In `pollAndPushMessages`'s task_event branch, skip the `mcp.notification` call when push is false. Event still gets logged via the existing `log(...)` line (for debugging/audit). No channel-side behavior change when push is true.

For message events, the server ignores `push` entirely (always pushes). If a future slice wants to suppress messages, it'll introduce an explicit opt-in — slice 5 stays focused on task_events.

### D8. Appendix A counts corrected during Task 2.5 (I1 pins A=4, B=4, C=2, total=10)

Parent spec §Appendix A summary ("impl=3, total=9, suppression=67%") is inconsistent with its own rule-by-event table. Re-derivation: impl receives pushes on events 1 (dispatch), 4 (answer reply_to_from=impl), 7 (reviewer state_change→done), and 8 (reviewer complete) — that's 4 pushes, not 3. Total across all three peers is 10, not 9. Parent spec's "9 events" count was also off — "event 9 task auto-closes" isn't a real event row.

Resolution (co-decided with reviewer yb6oeqry during Task 2.5 pre-review):
- Test `I1` asserts the rule-derived counts: A=4, B=4, C=2, total=10. Suppression ≈ 58% of possible receiver-event pairs, ≈ 63% of post-sender-exclusion deliveries.
- Parent spec `docs/a2a-lite.md` §Appendix A gets an in-place correction in the same slice-5 branch: trim "9 events" to "8 events", update counts, add a spec-correction-history note explaining the fix-up.
- The impact estimate in parent spec's "Impact Estimates" table ("~60-67% pushes suppressed per role") is still broadly accurate; the table-derived 58-63% fits within that range. No change to that table.

### D9. R2 test scope documented explicitly (pre-review spot-check S3)

`R2` — "sender-exclusion regression" — tests slice-4's delivery-layer filter (`te.from_id != ?` in `selectTaskEventsSincePeer`, sender-skip in `deliverTaskEventToPeer`). It does NOT exercise the `shouldPush` sender rule (D7), which is unreachable on this code path. Test name and comment updated to make this explicit so a future reader doesn't conclude R2 is testing shouldPush's sender branch.

### D7. Sender-exclusion rule in shouldPush is defense-in-depth, NOT the primary enforcement

Slice 4 already excludes sender from delivery via `te.from_id != ?` in `selectTaskEventsSincePeer` and the sender-skip in `deliverTaskEventToPeer`. The shouldPush sender rule kicks in if a future slice accidentally delivers to the sender (e.g., someone removes the SQL filter). Keeping both layers makes the "sender never sees own event" invariant robust against single-site refactors.

---

## Integration Points

### `handlePollMessages` (broker.ts)

Before: builds union of messages + task_events, assembles Event envelopes, returns.

After: same, but:
- message events get `push: true` literal
- task_events get `push: shouldPush(te, { peer_id: id, role_at_join: te.role_at_join })` where te is the JOIN'd row from `selectTaskEventsWithRole`
- `role_at_join` is projected out of the task_event payload before returning (payload shape preserves parent-spec TaskEvent, no leaked `role_at_join`)

### `deliverTaskEventToPeer` (broker.ts)

Before: resolves waiter with `{ events: [event], next_cursor }`. Event has no push field.

After: accepts a `participant: { peer_id, role_at_join }` argument (caller has it from the `task_participants` query). Computes `push = shouldPush(event.payload, participant)`. Returns envelope with `push`.

### `handleDispatchTask` (broker.ts)

Before: accepts `participants[]`, inserts each with `role_at_join = 'dispatcher'` for sender, else null.

After: accepts `participants[]` + optional `observers[]`. Resolves both. Builds `role_at_join` map:
- sender → 'dispatcher'
- observer peer_id → 'observer' (overrides participant default)
- else → null

### `pollAndPushMessages` (server.ts)

Before: in `else if (event.type === "task_event")` branch, always fires `mcp.notification`.

After: checks `event.push`. If `false`, log but skip notification:
```typescript
if (event.push === false) {
  log(`Suppressed task_event ${te.id} (${te.intent}) on ${te.task_id} — shouldPush=false`);
  continue;
}
// … existing notification code
```

Message branch unchanged.

---

## File Structure

**Create:**
- `shared/push-policy.ts` — `shouldPush` function + small docstring explaining the five rules.
- `docs/a2a-lite-slice-5.md` — this document.

**Modify:**
- `shared/types.ts` — add `push?: boolean` to `Event<P>`.
- `broker.ts` — extend `handleDispatchTask` with observers, `handleSendTaskEvent` + `deliverTaskEventToPeer` with push compute, `handlePollMessages` to JOIN role_at_join into task_event queries, new prepared statement `selectTaskEventsSincePeerWithRole`.
- `server.ts` — add `push === false` skip to task_event notification branch.
- `broker.test.ts` — new `describe("A2A-lite push policy (Slice 5)", ...)` before T8 LAST describe.

---

## Test Plan (for Task 2.5 pre-review)

New describe block in `broker.test.ts`. Tests hit the broker's poll endpoint directly and read the `push` flag from returned events.

### R. Pure-function rules (via broker integration)

Each test dispatches a task with specific participants/observers, fires an event from one of them, and polls as each recipient to read the `push` flag. Name the tests for the rule they exercise.

**R1: observer receives event with push=false.**
A dispatches to [B, observer=C]. A sends state_change→done (not the suppressed `working`). C polls. Assert: 1 task_event, `push === false`. B polls. Assert: 1 task_event, `push === true`.

**R2: sender never receives delivery at all (slice-4 regression).**
A dispatches to [B]. A polls (wait_ms=0). Assert: no task_events in batch. (Regression check that rule 2 is enforced at delivery layer, not push layer.)

**R3: state_change→working suppressed universally.**
A dispatches to [B, C]. B sends state_change with `data: { to: 'working' }`. A and C poll. Both assert `push === false`.

**R4: state_change→done is NOT suppressed.**
A dispatches to [B, C]. B sends state_change with `data: { to: 'done' }`. A and C poll. Both assert `push === true`.

**R5: question targeted to X — only X gets push.**
A dispatches to [B, C]. B sends question with `data: { to: A.id }`. A polls: `push === true`. C polls: `push === false`.

**R6: question without `to` field — push to all non-senders.**
A dispatches to [B, C]. B sends question with `text: 'anyone?'`, no `data.to`. A and C poll. Both `push === true`.

**R7: answer with `reply_to_from` — only that peer gets push.**
A dispatches to [B, C]. B asks question `data: { to: A.id }`. A replies with answer `data: { reply_to_from: B.id }`. B polls: `push === true`. C polls: `push === false`.

**R8: complete intent — pushes to all non-senders.**
A dispatches to [B, C]. C sends complete. A and B poll. Both `push === true`.

**R9: cancel intent — pushes to all non-senders.**
Same as R8 with intent='cancel'.

**R10: observer rule wins over targeted question.**
A dispatches to [B, observer=C]. B sends question `data: { to: C.id }`. C polls: `push === false` (observer overrides target). B polls: sender excluded. A polls: `push === false` (not the target).

Rule ordering lock: observer > sender > state_change → question/answer → default. This test pins it down.

### I. Integration — Appendix A worked example

**I1: full 9-event cycle matches Appendix A push counts.**
Setup: A=coordinator, B=impl, C=reviewer. Dispatch from A to [B, C]. Then run the 8 follow-on events from Appendix A. For each of A/B/C, poll + collect push flags. Assert: total pushes per peer = {A: 4, B: 3, C: 2} and total = 9 across the cycle.

This is the headline measurable: Appendix A predicts 67% push suppression. The test locks in the exact count.

### M. Message events (regression)

**M1: message events in poll batch have `push: true`.**
Pre-existing `/send-message` flow. B polls after A sends message. Assert event has `push === true` (not undefined — D4 requires explicit).

**M2: mixed batch — message has push:true, task_event follows its shouldPush result.**
B is observer on a task; A sends a message to B AND dispatches. B polls. Assert 2 events: message with `push: true`, task_event with `push: false` (observer rule).

### U. Pure-function unit tests (shared/push-policy.ts)

Tests against `shouldPush` imported directly. No broker needed.

**U1-U5:** one test per rule — craft minimal event + participant fixtures and assert the boolean.
**U6:** default case (no rule matches) returns true.
**U7:** rule ordering — observer + sender + rule 3 all apply: observer wins.

These live in a new file `push-policy.test.ts` since they need no broker. Keeps broker.test.ts from ballooning further.

---

## Reviewer pre-review questions

1. **`observers` as a separate dispatch field** (D5) vs. participants-as-object shape. Your lean?
2. **D4 — always-explicit push on slice-5+ events, absent = true for backwards-compat.** Any concern with the discriminated-absence semantic? Alternative: always required, serialize slice-4 historical events with a migration. I lean keep-optional, migration is overkill.
3. **Rule ordering / early returns** — I kept the parent spec's order verbatim (observer first). Sanity check this matches your mental model, especially that "observer wins over targeted question" (R10) is desired behavior, not a bug.
4. **Appendix A verification** — I1 tests the 9-push-total prediction. If I mis-counted the expected push counts per peer (should be A=4, B=3, C=2), that's easy to catch pre-impl.
5. **U-series in a new `push-policy.test.ts` vs. keeping everything in broker.test.ts.** Split tests are usually cleaner but your call.
6. **D7 sender defense-in-depth.** The shouldPush sender rule is never hit under slice-4 + slice-5 wiring. Keep it for resilience? Or delete since the test matrix can't exercise it?
7. **`shared/push-policy.ts` vs. inline in broker.ts.** Pure function, simple enough to inline. I lean shared/ because slice 7 replay may re-derive pushes for historical events.

---

## Tasks

### Task 1: Commit design doc

- [ ] **Step 1: Verify + commit**

```bash
ls -la docs/a2a-lite-slice-5.md
git add docs/a2a-lite-slice-5.md
git commit -m "$(cat <<'EOF'
docs: add A2A-lite slice 5 design doc (role-aware push policy)

Plan for shouldPush five-rule filter + Event envelope push flag +
broker integration + MCP server skip-on-false. Adds dispatch_task
observers field for test surface. All nine decisions locked.

See docs/a2a-lite.md parent spec §Push Policy and Appendix A for
the worked example this slice operationalizes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Write failing tests

Two files get new tests:
- `push-policy.test.ts` (new): U-series unit tests against `shared/push-policy.ts` (which doesn't exist yet — that's the failing baseline).
- `broker.test.ts`: R-series + I-series + M-series in a new describe block before T8.

- [ ] **Step 1: Create `push-policy.test.ts`**

```typescript
import { test, expect, describe } from "bun:test";
import { shouldPush } from "./shared/push-policy.ts";

// U1-U7 as described in the test plan. Fixtures construct minimal
// event + participant shapes; imports only the pure function.
```

- [ ] **Step 2: Add describe block to broker.test.ts**

Insert `describe("A2A-lite push policy (Slice 5)", ...)` before `describe("Long-poll broker restart (T8 — LAST in file)", ...)`. Include R1-R10, I1, M1, M2.

- [ ] **Step 3: Run new tests — expect FAIL**

```bash
bun test -t "push policy"
```

Expected: `push-policy.test.ts` U-series fails with import error. broker.test.ts R/I/M series fails because `event.push` is undefined in slice-4 responses.

- [ ] **Step 4: Commit failing tests**

```bash
git add push-policy.test.ts broker.test.ts
git commit -m "$(cat <<'EOF'
test: add slice-5 push policy tests (failing)

- push-policy.test.ts: U1-U7 pure-function tests against
  shared/push-policy.ts (unimplemented — fails with import error).
- broker.test.ts: R1-R10 per-rule integration tests, I1 Appendix A
  worked example, M1-M2 message-event regression + mixed-batch.

Tests fail against current main (push field not populated).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.5: HARD HOLD — reviewer pre-review

Ping reviewer yb6oeqry with test shape summary + the 7 pre-review questions. HOLD. No timeout fallback.

---

### Task 3: Implement

- [ ] **3a:** Create `shared/push-policy.ts` with `shouldPush` function. Run `bun test push-policy.test.ts` — expect U-series to pass.
- [ ] **3b:** Extend `shared/types.ts` with `push?: boolean` on `Event<P>`.
- [ ] **3c:** Add `selectTaskEventsSincePeerWithRole` prepared statement + update `handlePollMessages` to use it, compute push per event, populate envelope.
- [ ] **3d:** Update `handleSendTaskEvent` + `deliverTaskEventToPeer` to pass the receiver's participant row to shouldPush and include push in the envelope.
- [ ] **3e:** Extend `DispatchTaskRequest` with `observers?: string[]`, update `handleDispatchTask` to set `role_at_join='observer'` for resolved observer ids.
- [ ] **3f:** Update `server.ts` task_event branch to skip notification when `push === false`.

Sub-commits for reviewability — one per 3a-3f or bundle as the reviewer prefers.

---

### Task 4: Full-suite verification

- [ ] `bun test` — all pre-existing + slice-5 tests pass.
- [ ] Clean build all entry points.
- [ ] Manual smoke: spin up broker + two Claude sessions, dispatch with observers, send events, verify channel notifications fire only for non-suppressed events.

---

### Task 5: Post-impl review

PR with xhigh codex (reviewer's earlier pattern). Ping reviewer.

---

### Task 6: Merge

`gh pr merge --rebase --delete-branch` after greenlight.

---

## Rollback

`git revert` the impl commit(s). Event envelope's optional `push` field is backwards-compat safe — slice-4 consumers ignore it; slice-6+ will start depending on it.

---

*End of slice 5 plan.*
