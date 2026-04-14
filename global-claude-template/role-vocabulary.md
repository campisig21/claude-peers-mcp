# Role Vocabulary (Canonical)

> Authoritative list of canonical role types in the claude-peers role framework.
> This file is referenced by the global wakeup directive in `~/.claude/CLAUDE.md`
> and by per-role `_index.md` files in `~/.claude/roles/<role>/` (global) and
> `<project>/vault/<role>/` (project).
>
> The architect role owns this file. To extend it: append a new row to the
> appropriate table, write a default `_index.md` template, and append to
> `~/.claude/roles/architect/decision-log.md` with the rationale.

## Two-tier role system

| Tier | Where defined | Where context lives | Examples |
|---|---|---|---|
| **Global** | bare role string | `~/.claude/roles/<role>/` | `architect`, `broker-maintainer` |
| **Project** | `<project-slug>/<role>` | `<project-root>/vault/<role>/` | `multi-agent/coordinator`, `myproject/planner-A` |

The broker stores all roles as flat strings; the convention is enforced by:

- Shell wrappers (functions) that set `CLAUDE_PEER_ROLE` correctly
- The wakeup directive in `~/.claude/CLAUDE.md` that splits on `/`

## Canonical roles

### Global roles

| Role | Job | Default mandatory skills |
|---|---|---|
| `architect` | Designs cross-cutting infrastructure (the role framework itself, peer-mesh protocols, global conventions). Heavy human dialogue. Output: frameworks, vocabularies, templates, spec docs. NOT a planner — architect operates above any single project. | `writing-plans`, `brainstorming`, `dispatching-parallel-agents` |
| `broker-maintainer` | Owns `claude-peers-mcp` source. Different from general infra work because the broker is shared across all projects on this machine. Patches the broker, restarts it, owns the schema. | `systematic-debugging` |

### Project roles

**Role string grammar:** `<base-role>[-<domain>][-<instance>]`
- `<domain>` is optional, lowercase hyphenated (e.g., `backend`, `pipeline`,
  `model-tuner`). Omitted for domain-agnostic roles.
- `<instance>` is an auto-claimed single uppercase letter (`A`, `B`, `C`).
  The session detects the next available letter on wakeup — never specified
  in shell wrappers.
- All instances of a base role share a single `_index.md` with a domain
  lookup table. The wakeup hook resolves via cascading fallback.

| Role | Job | Default mandatory skills |
|---|---|---|
| `coordinator` | Project manager. Cross-peer alignment, scope validation, dispatch authorization, grilling-gate authority. **One per project (singleton).** | `dispatching-parallel-agents`, `using-superpowers` |
| `planner[-<instance>]` | Implementation plan author. **Cross-domain** — plans may span multiple domains. Heavy human dialogue. Writes plans, NOT code. No mandatory pairing. | `writing-plans`, `brainstorming`, `grill-me` |
| `implementer[-<domain>][-<instance>]` | Writes code per a plan. Routes task groups by dependency: `executing-plans` for sequential/overlapping work, `subagent-driven-development` for 3+ independent tasks. May use both in one plan. Self-reviews via skill before handing off. Domain-matched with paired reviewer. | `executing-plans` and/or `subagent-driven-development` (per task group), plus `test-driven-development`, `verification-before-completion` |
| `reviewer[-<domain>][-<instance>]` | Reviews implementer's work. Runs **two simultaneous review passes**: Claude-eye (own analysis) AND codex (`skill-codex:codex`). Domain-matched with paired implementer. | `skill-codex:codex`, `pr-review-toolkit:code-reviewer` |
| `auditor` | Meta-review of the coordinator's decisions. Spawned periodically, not continuous. Reports to the human. | `pr-review-toolkit:code-reviewer` |

## Mandatory pairing rules

### Implementer ↔ Reviewer (HARD, domain-matched)

Every active `implementer-<domain>-*` requires an active
`reviewer-<domain>-*` in the same domain. The coordinator MUST refuse to
authorize implementer dispatch without a paired reviewer claim.

Pairing matches on **domain**, not on instance letter —
`implementer-backend-A` can be paired with any `reviewer-backend-*`.
Domain-crossed pairings (e.g., `reviewer-frontend-A` reviewing
`implementer-backend-A`) are not allowed.

The reviewer runs **two simultaneous review passes** per implementation:

1. **Claude-eye review**: the reviewer's own analytical reading of the diff
2. **Codex review**: triggered via `skill-codex:codex`, runs concurrently

The two passes happen *after* the implementer's own self-review.

**Total review surfaces per implementation: 3** (1 implementer self-review
+ 2 concurrent reviewer passes).

### Planner (independent)

The planner is cross-domain and has no mandatory pairing constraint. When
a plan spans multiple domains, the coordinator routes each task to the
appropriate domain implementer.

### Coordinator (RECOMMENDED)

Any project with 2+ active peer roles should have an active `coordinator`.
Solo-implementer projects can skip the coordinator. The coordinator role is
explicitly singular: never `coordinator-A`/`coordinator-B`.

## Codex review model selection

When invoking `skill-codex:codex` from a reviewer role, default model
selection is:

| Task type | Model | Reasoning effort |
|---|---|---|
| **Standard review** (default) | `gpt-5.4` | `high` |
| **Trivial diff** (one-file, <50 LOC, no logic changes) | `gpt-5.3` | `medium` |
| **Large multi-file review** (>500 LOC, cross-cutting) | `gpt-5.4` | `xhigh` |

## Shell setup

Add these functions to your `~/.bashrc` or `~/.zshrc` to launch role-aware
sessions. They assume your existing `claudepeers` alias expands to
`claude --dangerously-load-development-channels server:claude-peers`; the
functions inline the underlying command for robustness (bash aliases don't
expand reliably inside other functions or aliases).

```bash
# Global role wrappers (no project namespacing)
claudepeers-architect() {
 CLAUDE_PEER_ROLE=architect claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-broker-maintainer() {
 CLAUDE_PEER_ROLE=broker-maintainer claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

# Project role wrappers — slug derived from cwd's git root (or basename if not a git repo)
# Domain-specialized roles (implementer, reviewer) take an optional domain as $1.
# The domain guard `[[ "$1" != -* ]]` prevents a leading Claude Code flag from being
# mistaken for a domain name. Instance letters (-A, -B, ...) are auto-claimed by the
# session on wakeup — never specified in the shell wrapper.

claudepeers-coordinator() {
 local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")";
\
 CLAUDE_PEER_ROLE="${slug}/coordinator" claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-planner() {
 local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")";
\
 CLAUDE_PEER_ROLE="${slug}/planner" claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-implementer() {
 local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")";
\
 local domain="";
\
 if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then domain="-$1"; shift; fi;
\
 CLAUDE_PEER_ROLE="${slug}/implementer${domain}" claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-reviewer() {
 local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")";
\
 local domain="";
\
 if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then domain="-$1"; shift; fi;
\
 CLAUDE_PEER_ROLE="${slug}/reviewer${domain}" claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-auditor() {
 local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")";
\
 CLAUDE_PEER_ROLE="${slug}/auditor" claude \
 --dangerously-load-development-channels server:claude-peers "$@"
}
```

**Usage examples:**
```bash
claudepeers-implementer backend    # → CLAUDE_PEER_ROLE=multi-agent/implementer-backend
claudepeers-reviewer backend       # → CLAUDE_PEER_ROLE=multi-agent/reviewer-backend
claudepeers-implementer pipeline   # → CLAUDE_PEER_ROLE=multi-agent/implementer-pipeline
claudepeers-planner                # → CLAUDE_PEER_ROLE=multi-agent/planner (cross-domain)
```

The session auto-claims the next available instance letter (`-A`, `-B`, ...)
by querying the peer mesh on wakeup. To launch a second backend implementer,
just run `claudepeers-implementer backend` again — it auto-detects `-B`.

## Resolved decisions

### Domain specialization (RESOLVED 2026-04-09 — naming + shared config)

Domain-specialized roles use the grammar `<role>-<domain>-<instance>` but
share a single `_index.md` per base role. The `_index.md` contains a domain
lookup table; the session parses its domain from the role string.

- `implementer-backend-A`, `implementer-pipeline-B` → both resolve to
  `vault/implementer/_index.md`
- `reviewer-frontend-A` → resolves to `vault/reviewer/_index.md`
- Planner is cross-domain (no domain suffix): `planner-A` → `vault/planner/_index.md`

Pairing matches on **domain**: `implementer-backend-*` pairs with
`reviewer-backend-*`. Instance letters are auto-claimed.

See `~/.claude/roles/architect/role-framework-spec.md` for the full spec.

## Skill flexibility note

The "Mandatory skills" lists in role `_index.md` files specify the typical
startup invocations for that role. They are NOT exhaustive: any role can
manually invoke any available skill at any time during its work, as the
task calls for it. The mandatory list is "what you reliably need at
startup," not "the only skills you may use."

## Open questions (remaining)

- **Role rotation across compaction**: When a Claude session compacts and
  resumes, does it inherit its role automatically? See spec Open Question 3.
- **Cross-project broker-maintainer scope**: Currently global. Could subdivide
  if more broker daemons are added beyond `claude-peers-mcp`. See spec Open
  Question 4.

## Related

- `~/.claude/CLAUDE.md` — the global wakeup directive
- `~/.claude/roles/architect/role-framework-spec.md` — full framework spec
- `~/.claude/roles/architect/decision-log.md` — append-only architect log
