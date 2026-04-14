# Role Framework Spec v1

> **Status:** v1, draft. Authored 2026-04-09 by `foggy-river` claiming the
> architect role. Subject to revision as the framework is exercised.
>
> **Purpose:** Canonical spec for the two-tier role framework that runs on top
> of `claude-peers-mcp`. New projects bootstrap from this spec; future
> architects revise it.
>
> **Audience:** Anyone (Claude session or human) who needs to understand
> how role-conditional context loading works in this system.

## Overview

The role framework provides **role-conditional context loading** for Claude
Code sessions communicating via `claude-peers-mcp`. When a session is
launched with `CLAUDE_PEER_ROLE=<role>` in its environment, the global
wakeup directive in `~/.claude/CLAUDE.md` loads role-specific context files
from a curated location, restoring the session's working knowledge without
requiring full conversation replay.

### Why this exists

The pre-roles era of `claude-peers-mcp` had three problems:

1. **No context continuity across sessions.** When a peer session died (or
   was compacted), the next session in its place started fresh, with no
   knowledge of decisions made or work in progress.
2. **Random naming.** Peer IDs were short random strings (`yvueok6c`,
   `5d6l1hq3`) with no stable role binding. Cross-references in docs went
   stale immediately on any restart.
3. **Vault sprawl.** Without role curation, autonomous agents created
   "everything for everyone": 168KB plans, 44KB decision logs, 17 docs for
   ~3 days of work. See `_example-vault/` in any project that has one as
   the historical record of this failure mode.

The role framework addresses all three:

1. **Context continuity** via `_index.md` files that act as curated wakeup
   sequences for inheriting sessions
2. **Stable naming** via `set_role` (Patch-2 of `claude-peers-mcp`) so peer
   IDs persist across restarts when the same role is re-claimed
3. **Anti-sprawl curation** via per-role reading lists capped at 5 files,
   forcing the role-holder to choose what's actually load-bearing

## Two-tier role system

The framework distinguishes **global** and **project-scoped** roles:

| Tier | Examples | Where the role string lives | Where context lives |
|---|---|---|---|
| **Global** | `architect`, `broker-maintainer` | Bare role string (no `/`) | `~/.claude/roles/<role>/` |
| **Project** | `multi-agent/coordinator`, `myproject/planner-A` | Namespaced: `<project-slug>/<role>` | `<project-root>/vault/<role>/` |

### How the directive distinguishes them

The wakeup directive in `~/.claude/CLAUDE.md` parses `$CLAUDE_PEER_ROLE`:

```
if "/" in role:
    project_slug, role_name = role.split("/", 1)
    # project-scoped: load from <cwd-project-root>/vault/<role_name>/
else:
    role_name = role
    # global: load from ~/.claude/roles/<role_name>/
```

The `/` is the only signifier. The broker stores all roles as flat strings
and doesn't know the difference. The convention is enforced entirely at the
shell-wrapper layer and the wakeup directive layer.

### Project root detection

For project-scoped roles, the directive needs to find the project root from
the cwd. Convention: the project root is the nearest ancestor containing a
`vault/` subdirectory whose basename equals the project slug.

Example: If `$CLAUDE_PEER_ROLE=multi-agent/coordinator` and
`$PWD=/home/user/code/multi-agent/src/agents/`, the directive walks up
looking for a directory whose basename is `multi-agent` AND contains a
`vault/` directory. Found at `/home/user/code/multi-agent/`. Loads from
`/home/user/code/multi-agent/vault/coordinator/_index.md`.

If no matching project root is found, the directive errors out and tells
the user the role doesn't match the cwd.

## Canonical roles

See `~/.claude/role-vocabulary.md` for the full list. Summary table:

| Role | Tier | Job | Pairing |
|---|---|---|---|
| `architect` | Global | Cross-project meta-system design | None |
| `broker-maintainer` | Global | `claude-peers-mcp` source maintenance | None |
| `coordinator` | Project | Project manager, dispatch authorization | None (singleton) |
| `planner[-<instance>]` | Project | Plan author, cross-domain, heavy human dialogue | None |
| `implementer[-<domain>][-<instance>]` | Project | Code execution per plan | Reviewer (mandatory, domain-matched) |
| `reviewer[-<domain>][-<instance>]` | Project | Code review (Claude-eye + codex) | Implementer (mandatory, domain-matched) |
| `auditor` | Project | Meta-review of coordinator decisions | None (optional, periodic) |

**Role string grammar:** `<base-role>[-<domain>][-<instance>]`
- `<base-role>` — from the canonical vocabulary
- `<domain>` — optional, lowercase hyphenated (e.g., `backend`, `pipeline`,
  `model-tuner`). When omitted, the role is domain-agnostic.
- `<instance>` — optional single uppercase letter (`A`, `B`, `C`, ...).
  Auto-claimed by the session on wakeup — never specified in shell wrappers.

**Cascading config resolution:** the wakeup hook resolves `_index.md` by
trying the full role name, then stripping the instance suffix, then
stripping the domain suffix. All instances of a domain-role share one
`_index.md` — domain-specific context is selected from a lookup table
within the shared config.

## Folder structure

Four distinct paths participate in the framework. Keep them distinct — the
2026-04-13 audit §7c surfaced real confusion between the init template and
the master vault (see decision-log `2026-04-14T05:55Z`):

| Tier | Path | Kind | Owner |
|---|---|---|---|
| 1 | `~/.claude/roles/<role>/` | Global role wakeup content (architect, broker-maintainer) | architect |
| 1b | `~/.claude/vault-template/` | Default `_index.md` skeletons copied into new projects by `/vault-init` | architect |
| 2 | `~/code/vault/` | Master vault — living cross-project reference content (linked, never copied) | architect + contributing projects |
| 3 | `<project>/vault/` | Project vault — project-specific roles and state | project coordinator + role-holders |

**Template (1b) vs master vault (2)** — the two were cleanly split on
2026-04-09. The **template** is static scaffolding that changes only when
the role framework itself changes; `/vault-init` copies it once per new
project. The **master vault** is living content that changes as
cross-project concepts emerge; projects *link* into it (absolute paths)
and never copy from it. A change to the template affects future projects;
a change to the master vault is visible to all projects immediately.

### Global roles (`~/.claude/roles/`)

```
~/.claude/
  CLAUDE.md                       # global wakeup directive
  role-vocabulary.md              # canonical role list
  roles/
    architect/
      _index.md                   # wakeup file
      decision-log.md             # append-only decisions
      role-framework-spec.md      # this file
    broker-maintainer/
      _index.md                   # currently a stub
```

### Project vault (`<project>/vault/`)

```
<project>/
  _example-vault/                 # legacy vault, frozen as reference (optional)
  vault/
    _shared/
      HOME.md                     # project MOC
      _peer-roster.md             # current role-to-peer-ID bindings
    coordinator/
      _index.md                   # wakeup file (singleton)
      decision-log.md             # (created on first claim)
    planner/
      _index.md                   # cross-domain planner config
    implementer/
      _index.md                   # shared config for ALL domain implementers
      progress-A.md               # instance-specific state (created on claim)
    reviewer/
      _index.md                   # shared config for ALL domain reviewers
      findings-A.md               # instance-specific state (created on claim)
    auditor/
      _index.md                   # periodic meta-reviewer
      audit-YYYY-MM-DD.md         # per-audit findings
```

Domain-specialized instances (e.g., `implementer-backend-A`) resolve to
the shared `vault/implementer/_index.md` via cascading fallback. The
`_index.md` contains a domain lookup table for context and skills.

## Wakeup directive contract

The directive in `~/.claude/CLAUDE.md` does the following on every session
start where `CLAUDE_PEER_ROLE` is set:

1. **Parse role** — split on `/` to determine tier
2. **Verify cwd** (project roles only) — confirm project root matches slug
3. **Resolve `_index.md` via cascading fallback** (project roles only):
   - Try exact: `vault/<role_name>/_index.md`
   - Strip instance suffix (`-[A-Z]$`): try again
   - Strip domain suffix (`-[a-z][-a-z]*$`): try again
   - Error if none found
4. **Read shared files** (project roles only): `_shared/_peer-roster.md` and
   `_shared/HOME.md`
5. **Read role index** — the resolved `_index.md`
6. **Read curated reading list** — every file listed in the index's
   "Reading list" section, in order
7. **Invoke mandatory skills** — every skill listed in the index's
   "Mandatory skills" section, via the Skill tool
8. **Discover live mesh** — call `mcp__claude-peers__list_peers`
9. **Instance auto-claim** — if the `_index.md` has an "Instance auto-claim"
   section, query existing peers and claim the next available letter via
   `set_role`
10. **Announce** — call `mcp__claude-peers__set_summary`

After step 10, the session has full role context and may respond to the user.

## Pairing rules

### Implementer ↔ Reviewer (HARD, domain-matched)

Every active `implementer-<domain>-*` requires an active `reviewer-<domain>-*`
in the same domain. The coordinator MUST refuse to authorize implementer
dispatch without a paired reviewer claim. Pairing matches on **domain**, not
on instance letter — `implementer-backend-A` can be paired with any
`reviewer-backend-*`.

### Planner (independent)

The planner is cross-domain and has no mandatory pairing constraint. A
planner may author plans that span multiple domains; the coordinator routes
each task to the appropriate domain implementer.

The reviewer runs **two simultaneous review passes** per implementation:

1. **Claude-eye review**: the reviewer's own analytical reading of the diff
2. **Codex review**: triggered via `skill-codex:codex` skill, runs concurrently

The two passes happen **after** the implementer's own self-review (built
into the implementer's workflow via `subagent-driven-development` or
`executing-plans`).

**Total review surfaces per implementation: 3.**

### Coordinator (RECOMMENDED)

Any project with 2+ active peer roles SHOULD have an active coordinator.
Solo-implementer projects can skip the coordinator. The coordinator is
explicitly singular: never `coordinator-A`/`coordinator-B`. Multiple
coordinators is confusion-by-design — if you need parallel coordinators,
you actually need an architect above them.

## Codex review model selection

When a reviewer invokes `skill-codex:codex`:

| Diff scope | Model | Reasoning effort |
|---|---|---|
| **Standard review** (default) | `gpt-5.4` | `high` |
| **Trivial diff** (one-file, <50 LOC, no logic) | `gpt-5.3` | `medium` |
| **Large multi-file** (>500 LOC, cross-cutting) | `gpt-5.4` | `xhigh` |

The codex skill runs in a read-only sandbox; it cannot modify the codebase.
Its findings are surfaced as a separate review track from the Claude-eye
pass and merged at dedupe time.

Override the default selection only with explicit reason; note in the
reviewer's findings file why you escalated or de-escalated.

## Shell setup

See `~/.claude/role-vocabulary.md` "Shell setup" section for the full
function definitions. Summary: define `claudepeers-<role>` shell functions
that set `CLAUDE_PEER_ROLE` correctly per role and forward to the underlying
`claude --dangerously-load-development-channels server:claude-peers` command.

Domain-specialized wrappers accept an optional domain argument:

```bash
claudepeers-implementer backend   # → CLAUDE_PEER_ROLE=<slug>/implementer-backend
claudepeers-reviewer pipeline     # → CLAUDE_PEER_ROLE=<slug>/reviewer-pipeline
claudepeers-planner               # → CLAUDE_PEER_ROLE=<slug>/planner (cross-domain)
```

**Instance letters are NOT specified in the shell wrapper.** The session
auto-claims the next available letter (`-A`, `-B`, ...) by querying the
peer mesh on wakeup. This eliminates pre-configuration — launching the same
wrapper again auto-detects the next letter.

Project-scoped role wrappers derive the project slug from the cwd:

```bash
local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
```

This means the same wrapper works in any project that uses the framework.

## Bootstrapping a new project

To enable the role framework in a new project:

1. **Verify global infrastructure exists:**
   - `~/.claude/CLAUDE.md` (the wakeup directive)
   - `~/.claude/role-vocabulary.md`
   - `~/.claude/roles/architect/` populated
   - Shell wrappers added to your `~/.bashrc` or `~/.zshrc`

2. **Create the vault skeleton in the new project root:**
   ```bash
   cd /path/to/new-project
   mkdir -p vault/{_shared,coordinator,planner,implementer,reviewer,auditor}
   ```

3. **Copy and adapt the templates** from any existing role-framework project
   (e.g., `multi-agent/vault/<role>/_index.md`). Replace project-specific
   placeholders.

4. **Create `vault/_shared/HOME.md`** with the project's MOC. Adapt the
   template from `multi-agent/vault/_shared/HOME.md`.

5. **Create `vault/_shared/_peer-roster.md`** with empty bindings.

6. **Test the wakeup** by launching a fresh session with
   `claudepeers-coordinator` from the new project's root and verifying the
   directive loads the role context cleanly.

## Anti-sprawl discipline

The autonomous-era vault failure mode was "create everything, link
everything, read everything." The role framework fights this with structural
caps that any future architect MUST preserve:

- **`_index.md` files cap at ~175 lines.** Longer = role is doing too
  much. (Raised from ~100 on 2026-04-14 after templates settled into
  actual useful content; see decision-log `2026-04-14T05:50Z`.)
- **Reading lists cap at 5 files.** More = the role-holder is overwhelmed.
  (This is the stronger anti-sprawl constraint; the line cap is a
  secondary signal.)
- **No autonomous concept-note creation.** Vault docs require an explicit
  role owner. The autonomous "I noticed we don't have a doc for X, let me
  create one" energy is exactly what we're avoiding.
- **Per-role decision logs are append-only.** No retroactive rewriting of
  decisions. Audit trail integrity is non-negotiable.
- **Templates point at `_example-vault/`** for legacy reference, but new
  vaults never copy wholesale. Each role pulls only what they actively need
  into their reading list.

## Open questions

### 1. Domain specialization (RESOLVED 2026-04-09, revised 2026-04-09)

**Resolution: naming-based with shared config.** Domain-specialized roles
use the grammar `<role>-<domain>-<instance>`, but all instances of a given
base role share a **single `_index.md`** with a domain lookup table inside.

**Config resolution:** the wakeup hook uses cascading fallback to find the
shared config. For example, `implementer-backend-A` resolves to
`vault/implementer/_index.md`. The `_index.md` contains a domain table
that maps each domain to its focus area, key source paths, and recommended
skills. The session parses its domain from its role string.

**Instance auto-claim:** the instance letter (`-A`, `-B`, ...) is not
specified in the shell wrapper. The session auto-detects the next available
letter by querying `list_peers` on wakeup.

**Pairing:** implementer ↔ reviewer pairing matches on **domain**, not on
instance letter. `implementer-backend-A` can be paired with any
`reviewer-backend-*`. Domain-crossed pairings are not allowed.

**Planner is cross-domain:** unlike implementer/reviewer, the planner role
has no domain suffix and no mandatory pairing. A single planner can author
plans spanning multiple domains; the coordinator routes each task to the
appropriate domain implementer.

**Registered domains** (as of 2026-04-09): `backend`, `pipeline`,
`frontend`, `model-tuner`, `rag`. New domains are added by updating the
domain table in the shared `_index.md` — no new directories needed.

### 2. Auditor and archivist role utility

These are in the canonical vocabulary but no project has spawned them yet.
**Status:** keep in vocabulary, omit from default project skeleton, spawn
templates lazily when first needed.

### 3. Role rotation across compaction

When a Claude session compacts and resumes, does it inherit its role
automatically? Currently the framework relies on the shell wrapper being
re-invoked. If a session compacts mid-conversation and resumes, the env
var is preserved but the wakeup directive only fires on initial session
start, not on resume. **Status:** untested. May need a `set_role` re-claim
on resume to be safe.

### 4. Cross-project broker-maintainer scope

The `broker-maintainer` role is currently global because there's exactly
one `claude-peers-mcp` daemon per machine. If we add other brokers (e.g.,
a future "task-broker" or "vault-broker"), the role might need to subdivide.
**Status:** monitor; revise when more brokers exist.

## Related

- `~/.claude/CLAUDE.md` — the wakeup directive that depends on this spec
- `~/.claude/role-vocabulary.md` — canonical role list
- `~/.claude/roles/architect/_index.md` — wakeup file for architect sessions
- `~/.claude/roles/architect/decision-log.md` — append-only decisions
- `<project>/vault/_shared/HOME.md` — example project MOC for projects
  using the framework
