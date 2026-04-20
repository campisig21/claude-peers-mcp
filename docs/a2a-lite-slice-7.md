# A2A-lite Slice 7 — Replay CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safety net for crash-mid-write / fs-write-failure scenarios. `bun cli.ts replay [task_id|all]` reads `tasks` + `task_participants` + `task_events` from the DB and regenerates `~/.claude-peers/tasks/<task_id>.md` using `shared/render.ts`'s pure `renderTaskFile` function (locked-in byte-for-byte equality by slice 4's F5 test). Final slice of the parent-spec rollout.

**Architecture:** Pure CLI subcommand — no broker changes, no MCP server changes, no wire protocol addition. Opens DB read-only (WAL mode permits concurrent readers alongside the running broker). Builds role lookup from the `peers` table at replay time — mirrors broker's runtime behavior so replayed files match what the broker would write today.

**Tech Stack:** `bun:sqlite` read-only, `node:fs/promises`, existing `shared/render.ts`. Zero new dependencies.

---

## HOLD-UNTIL-GREENLIGHT Notice (Task 2.5)

Same semantics as prior slices. Ping reviewer after Task 2; STOP; wait for explicit greenlight.

Rationale for slice 7: scope is tight but the command mutates the filesystem (overwrites user-visible `.md` files). Wrong render contract, wrong file path, wrong overwrite semantic → user confusion at best, data loss at worst. Pre-review catches these before users run the command against a production broker.

---

## Scope Boundary

**In scope:**
- New CLI case in `cli.ts`: `replay <task_id>` and `replay all`.
- Opens `CLAUDE_PEERS_DB` (or default `~/.claude-peers.db`) in read-only mode.
- Writes to `${CLAUDE_PEERS_HOME}/tasks/<task_id>.md` (default `~/.claude-peers/tasks/<task_id>.md`).
- Creates the tasks directory idempotently if missing (mirrors broker startup behavior).
- Overwrites existing files — the DB is truth, existing file content is unconditionally replaced.
- Builds a role lookup from the `peers` table so participant labels carry `(role)` annotations.
- Summary output: `Replayed T-34` per task + `Replayed N task file(s)` at the end.
- Tests in a new file `replay.test.ts` (mirrors `push-policy.test.ts` split-by-file pattern from slice 5).

**Out of scope:**
- Broker-side replay triggers. If the broker wants replay, it shells out to the CLI (not in this slice).
- Partial replay (replay events i..j only). `all` + `<task_id>` are the only shapes.
- Dry-run mode. Scope creep; add later if users ask.
- Concurrency hardening against a broker actively appending to the same file during replay. Acceptable race window for a safety-net tool; documented under §Interaction with running broker.
- Deletion of `.md` files for tasks no longer in the DB. DB is additive (no task deletion in slices 1-6); the divergence shouldn't arise in practice.

**Risk class:** Low. Pure read from DB, pure write to fs, single entry point, no concurrency state of its own.

---

## Design Decisions (slice-local)

### D1. `replay <task_id>` and `replay all` — two shapes, no others

Scope-locked to exactly these two invocations. `<task_id>` must match `/^T-\d+$/`; any other string errors with a friendly message pointing to `all`. The `all` literal is a sentinel — tasks named "all" (if someone ever names one) would shadow, but `T-<n>` format prevents that collision.

### D2. Idempotent overwrite — DB is always truth

`renderTaskFile` is deterministic given the same (task, participants, events, roleLookup) inputs. Running `replay` twice back-to-back produces identical files. Existing file content is NOT merged or diffed — it's unconditionally overwritten via `fs.writeFile`. Users who want before/after diffs can use git or `diff` externally.

Rationale: a safety-net tool with surprising non-idempotent behavior is worse than no tool. Overwrite semantic matches the F5 lock-in: "byte-for-byte equal to what the broker would write."

### D3. Interaction with running broker — acceptable race, documented

Replay opens the DB read-only. Bun:sqlite WAL mode permits this alongside the broker's write connection. DB reads are snapshot-consistent.

For fs writes, there's a narrow window: broker is mid-`appendFile` on a task file while `replay <task_id>` is mid-`writeFile` on the same file. Both complete; the file ends up in one of two states — broker's append on top of replay's rewrite (coherent, since broker's append would have been valid either way), OR replay's rewrite without the broker's append (coherent, missing the most recent event until the next replay). The file is never corrupted — both operations produce valid UTF-8 — only potentially out-of-date.

Operational guidance (goes in `bun cli.ts` help text): for a fully-synchronized replay, stop the broker first (`bun cli.ts kill-broker`), replay, then restart. For ad-hoc recovery, replay while the broker runs is safe.

### D4. Role lookup is read-at-replay-time, not snapshot-at-event-time

Render uses current `peers.role` values — same as the broker's runtime writes. If Bob was `impl-backend-A` when event 42 was written, but later rebinds to `impl-backend-B`, replay will label event 42 with `(impl-backend-B)`. This matches broker runtime behavior; a future "historical-accurate replay" feature could snapshot role-at-send-time via a `task_events.sender_role_at_send` column, but that's out of scope.

Documented as a known limitation — users who need strict historical fidelity can reconstruct from `bun cli.ts messages` which shows raw peer_ids, or query the DB directly.

### D5. No --dry-run flag in slice 7

Scope creep. Add if users ask. Current behavior: always writes. Users who want to see output without side effects can redirect: `bun cli.ts replay T-34 && cat ~/.claude-peers/tasks/T-34.md`.

### D6. Error modes — friendly, exit codes matter

- `replay` with no args → usage message + exit 1.
- `replay <bad-id>` where id doesn't match `/^T-\d+$/` and isn't "all" → "invalid task id: expected 'T-<n>' or 'all'" + exit 1.
- `replay T-9999` where task doesn't exist in DB → "task T-9999 not found" + exit 2.
- `replay all` with empty tasks table → "No tasks to replay." + exit 0 (not an error).
- DB file missing → "No persisted peers database at <path>" + exit 1 (consistent with existing `cli.ts roles` / `cli.ts messages`).

### D7. Tests live in `replay.test.ts` (new file), mirroring `push-policy.test.ts` split

`broker.test.ts` is already 2800+ lines. `push-policy.test.ts` established the split-by-concern pattern (slice 5, reviewer-concurred). Slice 7's tests don't need a running broker at all (pure DB + fs read/write); a dedicated file keeps the test surface isolated and the suite organized.

Tests spin up their own temp DB, seed rows directly (no need to run the broker), invoke the CLI subcommand as a subprocess, and assert on file contents.

---

## File Structure

**Modify:**
- `cli.ts` — add `replay` case to the switch. Small addition; no helper-module extraction needed.

**Create:**
- `replay.test.ts` — new test file with seeded-DB fixtures and subprocess assertions.
- `docs/a2a-lite-slice-7.md` — this document.

**Not touched:**
- `broker.ts`, `server.ts`, `shared/*` — replay is a pure CLI consumer; no broker / server / shared changes.

---

## Test Plan (for Task 2.5 pre-review)

All tests live in `replay.test.ts`. Each test builds a fresh temp DB + temp tasks home, seeds task/participant/event rows directly, spawns the CLI subcommand as a subprocess, asserts on file contents or exit codes.

### S. Single-task replay

**S1: `replay T-<n>` creates the task file with expected contents.**
Seed one task (T-1) with 1 dispatcher + 1 assignee + 2 events (dispatch + state_change→done). Run `bun cli.ts replay T-1`. Assert the file exists at `$TEST_HOME/tasks/T-1.md`. Assert contents match `renderTaskFile(task, participants, events)` byte-for-byte.

**S2: replay is idempotent.**
Run S1 setup, replay once, replay again. Assert the file contents are identical between runs. Assert mtime changes (overwrite fired both times) OR use content hash (mtime-independent).

**S3: replay overwrites an existing file whose content drifted from DB.**
Seed task T-1, pre-write `$TEST_HOME/tasks/T-1.md` with garbage content, run `replay T-1`. Assert file contents match rendered (garbage replaced).

**S4: replay with task_id not in DB exits 2.**
Seed empty DB. Run `replay T-999`. Assert exit code = 2. Assert stderr contains "T-999 not found".

**S5: replay with invalid id exits 1.**
Run `replay not-a-task-id`. Assert exit code = 1. Assert stderr contains "invalid task id".

### A. All-replay

**A1: `replay all` with N tasks writes N files.**
Seed 3 tasks with assorted events. Run `replay all`. Assert 3 files exist. Assert each file's contents match `renderTaskFile` for its task.

**A2: `replay all` with empty DB exits 0 cleanly.**
Seed empty tasks table. Run `replay all`. Assert exit code = 0. Assert stdout contains "No tasks to replay." (or equivalent — exact text locked by the test).

### E. Error modes

**E1: DB file missing exits 1 with friendly message.**
Unset CLAUDE_PEERS_DB, point it at a non-existent path. Run `replay all`. Assert exit code = 1. Assert stderr/stdout mentions "No persisted peers database".

**E2: no args → usage.**
Run `replay` with no arguments. Assert exit code = 1. Assert stderr contains "Usage" or "task_id|all".

### R. Role lookup

**R1: participant labels include (role) when peer has a role set.**
Seed a task with a participant peer who has role=`reviewer-backend-A` in the peers table. Run `replay T-1`. Assert the file header's `participants:` line includes `(reviewer-backend-A)` next to the peer's id.

**R2: role lookup uses current peers, not historical.**
Seed task T-1 with events from peer `bob`. Initially peer `bob` has role=`impl-v1`. Update the peers table so `bob` now has role=`impl-v2`. Run `replay T-1`. Assert the rendered output labels `bob` as `(impl-v2)` throughout — this is D4 documented behavior.

### C. Broker-coexistence (smoke)

**C1: replay while broker is running does not crash.**
Spawn a broker subprocess pointed at the test DB + home. Seed a task via direct DB insert (not via the broker's /dispatch-task, to keep the test pure fs + DB). Run `replay T-1`. Assert exit code = 0 and file contents are correct. Kill broker.

This test locks in the "WAL readonly coexistence is safe" invariant. No assertion on the race window — D3 documents it as acceptable.

### Pre-review questions for reviewer (yb6oeqry)

1. **Split into `replay.test.ts`** per D7 — same pattern as slice 5's `push-policy.test.ts`. Agree?
2. **Subprocess-based CLI tests** — same pattern as slice 6's C1/C2 but simpler (no streaming). Use try/finally per test for cleanup. Agree?
3. **Exit code matrix** per D6 — 0 success / 1 usage-or-config error / 2 task-not-found. Cleanly distinguishes user errors (1) from data-absence (2). Worth it, or collapse into 1 for all error paths?
4. **D3 race documentation-only** — no code-level coordination between running broker and replay CLI. Replay-while-running-broker is safe but may race the most-recent appendFile. For "perfect" sync, user kills broker first. Documented in help text. Acceptable?
5. **D4 role-at-render-time semantic** — labels reflect current peers.role values, not history. Any concern about this subtly confusing users reading a replayed file for a task with rebinds? I lean "match broker runtime + document." Historical-accurate replay is a separate (unplanned) slice if ever needed.
6. **No `--dry-run` in slice 7.** Add on user demand. Agree?
7. **Overwrite semantic (D2)** — unconditional replace, no diff/merge/backup. Matches safety-net framing. Any push-back?

---

## Tasks

### Task 1: Commit design doc

- [ ] Verify + commit.

### Task 2: Write failing tests

Create `replay.test.ts` with S/A/E/R/C test series. All fail initially because the `replay` case doesn't exist in `cli.ts`.

- [ ] Create fixtures helper: `seedTask(dbPath, { id, title, participants, events })` builds all the rows.
- [ ] Create subprocess runner helper: `runCli(dbPath, homePath, ...args)` returns `{ exitCode, stdout, stderr }`.
- [ ] Implement S1-S5, A1-A2, E1-E2, R1-R2, C1.
- [ ] Run `bun test replay.test.ts` — expect all to fail.
- [ ] Commit.

### Task 2.5: HARD HOLD for reviewer pre-review

Ping reviewer with test-shape + 7 open questions. STOP.

### Task 3: Implement

Single `cli.ts` edit — new `case "replay":` block. Approximately 60-80 LOC.

- [ ] **3a:** Argument parsing — `T-<n>` vs `all` vs error.
- [ ] **3b:** DB open (readonly) + fetch task rows + participants + events + build role lookup.
- [ ] **3c:** renderTaskFile import + write file(s) to `$CLAUDE_PEERS_HOME/tasks/`.
- [ ] **3d:** Usage help text + exit codes per D6.

All in one commit — small surface, no meaningful sub-commit boundaries.

### Task 4: Verify

- [ ] `bun test` — all green (existing 115 + new ~11 from slice 7).
- [ ] Manual smoke: run the broker, dispatch a task, `rm ~/.claude-peers/tasks/T-N.md`, run `bun cli.ts replay T-N`, verify file reappears with correct contents.

### Task 5: Post-impl review

PR with medium codex (reviewer's recommendation — the lightest slice in the rollout).

### Task 6: Merge

`gh pr merge --rebase --delete-branch` on greenlight.

---

## Rollback

`git revert` the impl commit. Pure CLI addition; nothing else depends on it. No persistent state.

---

## Closeout

Slice 7 is the final slice in the original parent-spec rollout. Completing it ships:
- Slices 1–2: Context diet + long-poll (shipped)
- Slice 3: Schema + UNION view (shipped)
- Slice 4: Typed tools + fs audit (shipped)
- Slice 5: Role-aware push policy (shipped)
- Slice 6: SSE tail + `cli.ts tail` (shipped)
- Slice 7: `cli.ts replay` (this slice)

All seven branches of the parent-spec grill resolve. Any follow-up slices (rule 4/5 asymmetry from slice-5 post-impl review, composite-cursor backfill for SSE per slice-6 D1, push-policy per-peer overrides, etc.) are out of the original scope and would warrant a fresh parent spec.

---

*End of slice 7 plan.*
