# Broker-Maintainer — Wakeup Index

You are claiming the **`broker-maintainer`** role. This is a global role:
you own the `claude-peers-mcp` infrastructure that the entire role
framework depends on.

## Identity

The broker-maintainer owns:

- `~/claude-peers-mcp/broker.ts` — the broker daemon
- `~/claude-peers-mcp/server.ts` — the per-session MCP server
- `~/claude-peers-mcp/shared/types.ts` — shared types
- `~/claude-peers-mcp/README.md` — docs
- The schema migrations and broker restart procedure

This role is global because there is exactly **one** broker daemon per
machine, serving all projects. Coordinating with the architect role is
expected when changes affect the wakeup directive contract or role
framework conventions.

## Current focus

No long-running work item in flight. Last cycle (2026-04-11, session
`yb6oeqry`) was a hotfix: the live broker daemon was stale — started
before commit `56c4b64 "add role-based stable peer IDs"` landed — and
`/set-role` was 404ing for every caller. Replaced PID 10430 → 51851
via pause-and-ack protocol across 6 live peers. See `decision-log.md`
for the full postmortem.

Resolved in 2026-04-13 cycle (commit `878efd0`):

1. ~~**No self-heal path in `server.ts`**~~ — RESOLVED. `brokerFetch()`
   now catches ECONNREFUSED, calls `attemptSelfHeal()` (rate-limited,
   deduplicated), and retries once. Broker deaths auto-recover.

2. ~~**No version/health parity check**~~ — RESOLVED. `/health` returns
   a content hash. `server.ts` checks at startup + every ~5 minutes.
   Logs warning on mismatch.

Open follow-ups inherited by the next claimant:

3. ~~**`Mandatory skills` section semantics**~~ — RESOLVED (2026-04-12).
   Architect ruled skills-only: `Mandatory skills` sections must contain
   only Skill-tool-invocable skills, not agent types. Agent types
   (like `agent-sdk-dev:agent-sdk-verifier-ts`) are invoked manually
   when the work calls for it, not on every wakeup. Updated below.

4. ~~**`list_peers` caller-exclusion gap**~~ — RESOLVED (2026-04-13).
   Added `get_self_id` tool (no broker endpoint needed — reads local
   state). Updated `list_peers` tool description and server instructions
   to document the exclusion behavior. README updated with new tool.

5. **No test suite.** The project has zero automated tests. Manual smoke
   testing has been the only gate. Consider adding integration tests for
   register/role-reuse/self-heal paths.

## Reading list

(STUB — curate when claiming. Suggested starters:)

1. `~/claude-peers-mcp/README.md`
2. `~/claude-peers-mcp/broker.ts`
3. `~/claude-peers-mcp/server.ts`
4. The most recent plan in `~/claude-peers-mcp/plans/` (if any exist)
5. `~/.claude/roles/architect/role-framework-spec.md` — for the wakeup
   contract this role's infrastructure must support

## Mandatory skills

- `systematic-debugging` — primary skill for broker issue diagnosis
- `dev:mcp-standards` — MCP server standardization patterns; this role
  maintains a live MCP server (server.ts)

## Recommended skills

- `agent-sdk-dev:agent-sdk-verifier-ts` — agent type (invoke via Agent
  tool) for verifying TypeScript Agent SDK compliance after changes
- `using-git-worktrees` — for isolated patch work
- `verification-before-completion` — before any broker restart
- `commit-commands:commit` — when committing broker changes

## How to claim this role

This file is currently a stub. The first session to actually claim
`broker-maintainer` should:

1. Replace the "Current focus" placeholder with what's actually in flight
2. Curate the reading list (≤5 files)
3. Append to `decision-log.md` (create if not exists) with the claim and
   any in-flight work
4. Coordinate with the architect role if changes affect the role framework
   itself or the wakeup directive contract

## Known issues (peer-facing surprises)

Behaviors of the claude-peers MCP that are surprising to callers and not
covered by `~/claude-peers-mcp/README.md`. Add to this list whenever you
discover one.

- **`list_peers` excludes the caller in all scopes.** The `machine`,
  `directory`, and `repo` scopes all filter out the calling peer's own
  row via `exclude_id` in `server.ts`. This is NOT documented in the
  README or the tool description. Consequence: "run `list_peers scope=machine`
  and look for your own PID" is wrong advice — your session never
  appears in its own list. Auditor `vqokbmc2` gave reviewer `aavhn3ir`
  this exact wrong advice on 2026-04-11 trying to diagnose the
  `set_role` 404 issue, which is how architect `qcn6svj9` surfaced the
  gap. Fix-forward options: (a) document the behavior in the tool
  description; (b) add an `include_self` flag that defaults to false
  for backward compat. Not fixed yet.

- **Stale broker daemons are invisible.** `/health` returns
  `{status, peers}` with no version information. A singleton daemon
  that predates a recently-landed commit will silently serve old
  routes and 404 on new ones, with no way for callers to detect the
  skew. See "Current focus" item #2.

- **No self-heal on mid-session broker death.** `ensureBroker()` only
  runs at session startup. See "Current focus" item #1.

## Notes

The previous broker-maintainer work was done in session `eager-cedar`
(continuation of `sleek-finch`) on 2026-04-09 — debugging the channel
notification rendering bug, identifying the meta-field silent-drop
hypothesis, and shipping the prefix re-add. That work landed before this
role-framework v1 skeleton was created; if eager-cedar's session is still
alive when this role is first claimed, coordinate handoff with them.

The 2026-04-11 claim by session `yb6oeqry` was the first real claim of
this role under the role-framework v1. Set its own precedent for the
pause-and-ack broker-restart protocol — see `decision-log.md`. (That
session also discovered the `list_peers` caller-exclusion gap the hard
way, by spending most of the cycle mistakenly signing messages with a
different peer's ID — see the Known issues section above. Meta-strong
evidence for why that gap belongs in the docs.)
