# Role Etiquette

> Rules of engagement inside the role framework vault. Read once on first claim of
> any role; re-read when you catch yourself about to violate one of these rules.
>
> This file is the **practical companion** to the two design docs:
> - `~/.claude/role-framework-spec.md` lives at `~/.claude/roles/architect/role-framework-spec.md` — *what* the system is
> - `~/.claude/role-vocabulary.md` — *which* roles exist
> - **This file** — *how to behave* inside a vault once you've claimed a role
>
> Owner: `architect`. Changes require a decision-log entry.

## 1. File ownership — who writes what, where

Every role gets a workspace directory. One role writes it; all roles may read it.
No cross-role edits.

| Role | Writes |
|---|---|
| coordinator | `coordinator/_index.md`, `coordinator/dispatch-log.md`, `_shared/_peer-roster.md` |
| planner | `planner/_index.md`, `planner/active/*.md`, `planner/completed/*.md` |
| implementer | `implementer/_index.md`, `implementer/progress/*.md` (plan-diff logs) |
| reviewer | `reviewer/_index.md`, `reviewer/findings/*.md` |
| auditor | `auditor/_index.md`, `auditor/reports/*.md`, `_shared/visual/*` |
| architect (global) | `~/.claude/roles/architect/*`, `~/.claude/role-vocabulary.md`, this file, init template |

**`_shared/` writes are coordinator-authorized only** (except `_shared/visual/`,
which the auditor owns). Never edit another role's workspace. If you need to
communicate something to them, use `send_message` or file it in your own workspace.

**Decision logs are append-only forever.** No retroactive edits. No rewriting
history. If a decision turns out wrong, append a new entry that supersedes it
and cross-links the old one.

## 2. Size caps (hard)

- `_index.md` ≤ **175 lines.** Longer means the role is doing too much.
  (Cap raised from 100 on 2026-04-14 after templates settled into actual
  useful content — reading list, mandatory skills, workspace docs — that
  didn't compress below ~140 lines without losing signal. See architect
  decision `2026-04-14T05:50Z`. The ≤5-file reading list cap below is
  the stronger anti-sprawl constraint; this is a secondary signal.)
- Reading list ≤ **5 files per role.** More means the role-holder is overwhelmed.
- No file in `_shared/` over ~300 lines. Split if it grows beyond that.
- `MEMORY.md` index entries ≤ 200 lines (lines after 200 are truncated from context).

If any cap is hit, **trim before adding new content.** Never raise a cap to fit
new content — that's how `_example-vault/` got to 168KB in three days.

## 3. Cross-vault referencing

Three tiers of context live on this machine:

1. `~/.claude/roles/` — global role configs (framework definition, architect-owned)
2. `~/code/vault/` — master vault (living cross-project reference material)
3. `<project>/vault/` — project vault (project-specific roles and state)

**Rules:**
- Link to master vault with absolute paths (`~/code/vault/_shared/...`) when
  referencing cross-project concepts. Never copy master vault content into a
  project vault.
- Within a single vault, use relative paths or Obsidian wikilinks (`[[Note Title]]`).
- When you reference framework infrastructure from a project vault, link to
  `~/.claude/roles/architect/role-framework-spec.md`, not a local copy.
- If a concept is only used by one project, it lives in that project's vault.
  If it's used by two or more, it belongs in the master vault.

## 4. Peer mesh etiquette

- Call `mcp__claude-peers__set_summary` proactively after completing the wakeup
  sequence. Peers need to know what you're doing without having to ask.
- Incoming `<channel source="claude-peers">` messages: **respond immediately.**
  Pause current work, reply via `send_message`, then resume. A coworker tapped
  you on the shoulder — don't leave them waiting.
- The coordinator maintains `_shared/_peer-roster.md`. Other roles read it; they
  never write it. If you claim a role, the coordinator updates the roster.
- Release stale claims. Before exiting a long-running session, call
  `set_role(null)` so the next session can inherit your peer ID cleanly.
- Use `scope='repo'` when listing peers inside a project, `scope='machine'` for
  global roles (architect, broker-maintainer).

## 5. Commit etiquette for vault changes

- Vault edits commit at natural task boundaries (same rule as code).
- **Plan completion commits use the `[plan-complete]` message tag.** The
  tag is consumed by exactly one piece of tooling: the project-level
  `.githooks/post-merge` hook, which on match sends a `send-by-role`
  message to the currently-claimed `auditor` peer (no-op if none is
  running). No new Claude session is spawned — the notify only pokes an
  already-running auditor. See architect decisions `2026-04-13T01:10Z`
  (auto-spawn dropped) and `2026-04-14T05:35Z` (auto-notify ratified).
  The coordinator or human still launches the auditor manually; the
  notify just signals an already-running one that a plan merged.
  **Do not add new consumers of the tag without an architect decision.**
- Never `git commit --amend` a decision-log entry. Append a correction instead.
- Stage files explicitly (`git add vault/planner/active/foo.md`). Never
  `git add .` inside a project with uncommitted work outside the vault.
- Commit message style: imperative, scoped. `coordinator: authorize dispatch of
  implementer-backend-A` is better than `update vault`.

## 6. Project permissions — `.claude/settings.local.json`

Every project using the role framework must have a `.claude/settings.local.json`
containing at minimum the **framework baseline allowlist**. Without it, peer
roles will stall on approval prompts every time they hit the mesh or run codex.

**Baseline allowlist** (the vault-init skill writes/merges this):

```json
{
  "permissions": {
    "allow": [
      "mcp__claude-peers__list_peers",
      "mcp__claude-peers__set_summary",
      "mcp__claude-peers__set_role",
      "mcp__claude-peers__send_message",
      "mcp__claude-peers__check_messages",
      "Bash(codex exec:*)",
      "Skill(skill-codex:codex)",
      "Bash(git:*)",
      "Bash(grep:*)"
    ]
  }
}
```

**Merge rule, not overwrite rule.** Existing entries are always preserved. The
baseline is a *floor*, not a ceiling. Projects accumulate their own domain-specific
permissions (npm, uv, pytest, railway, etc.) organically; those are outside the
framework's concern. The framework only guarantees its own minimum.

**When to add to this baseline:** only when a new framework-level capability is
introduced (a new MCP tool, a new mandatory skill that needs Bash access). Changes
require an architect decision-log entry and a vault-init skill update.

## 7. Role handoff protocol

- **Planner → Coordinator:** planner writes plan to
  `planner/active/YYYY-MM-DD-*.md`, then messages the coordinator announcing
  the plan exists and listing the domains it touches.
- **Coordinator → Implementer:** coordinator authorizes dispatch only after
  confirming a paired reviewer of the same domain is online. Dispatch message
  names the plan file and the task range.
- **Implementer → Reviewer:** implementer self-reviews via
  `subagent-driven-development` or `executing-plans` skill, commits, then
  messages the domain-matched reviewer with the diff scope (commit range,
  files, LOC).
- **Reviewer → Implementer:** findings go in `reviewer/findings/`. Do not
  inline findings as code comments — the comments persist, the findings file
  gets archived once addressed.
- **Auditor → Human:** audit reports live in `auditor/reports/` and are pushed
  to the human via summary message, not pulled by the human scanning the vault.

## 8. Anti-sprawl discipline

The single rule that matters most: **do not autonomously create vault documents.**

New docs require one of:
- Explicit human request
- A role's workspace rule (e.g., a reviewer creating a findings file as part
  of its pairing loop, or a planner writing a plan as its primary output)

No "I noticed we don't have a doc for X, let me write one" energy. That's how
`_example-vault/` ballooned. If you think a doc should exist but doesn't,
**tell the human** — don't create it. The architect decides what lives in the
framework; coordinators decide what lives in their project's `_shared/`.

## 9. Staleness discipline

Decision log entries are never *wrong* — they're *historical*. If a decision is
superseded, write a new entry that supersedes it and cross-link.

**Before acting on a decision-log entry**, verify the referenced code or files
still exist. Same rule as auto-memory: "the decision log says X exists" is not
the same as "X exists now." A decision from three weeks ago may have been
overtaken by a merge you haven't read yet.

Reading order when claiming a role: latest decision-log entries first, working
backward. The most recent 5–10 entries are highest priority. Entries older than
six months are context, not instructions.

## 10. When you break these rules

Append an entry to `_shared/process/etiquette-violations.md` (create on first
use) with: date, which rule, what you did instead, and why the rule was wrong
or your situation was special. The architect reads these periodically and
either revises the rule or sharpens the wording. Etiquette is living; violation
logs are how it evolves.

## Related

- `~/.claude/role-vocabulary.md` — canonical role list
- `~/.claude/roles/architect/role-framework-spec.md` — full framework spec
- `~/.claude/roles/architect/decision-log.md` — append-only architect decisions
- `~/.claude/vault-template/` — init template (copied into new projects by `/vault-init`)
- `~/code/vault/_shared/HOME.md` — master vault MOC
