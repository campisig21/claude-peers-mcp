---
name: vault-init
description: Bootstrap a new project with the role framework vault structure. Use when setting up a new project for claude-peers role-based coordination, when the user says "init vault", "set up roles", "bootstrap project for peers", or wants to enable the role framework in a repository. Also trigger when the user mentions needing coordinator/planner/implementer/reviewer roles in a new project.
---

# Vault Init

## Overview

One-shot skill that bootstraps a new project with the role framework vault
structure by copying from the **init template** at
`${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template/`.
After running, the project is ready for role-based coordination via
`claude-peers-mcp`.

Two separate locations serve different purposes:
- `${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template/` — static init template (role skeletons, copied into new projects)
- `~/code/vault/` — master vault (living cross-project reference material, linked not copied)

**Announce at start:** "I'm using the vault-init skill to bootstrap this project's vault."

## Prerequisites

Before starting, verify:

```bash
# Resolve the vault-template location via env var (default: ~/claude-peers-mcp)
TMPL="${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template"

# Init template must exist
ls "$TMPL/_shared/HOME.md"
ls "$TMPL/coordinator/_index.md"
ls "$TMPL/planner/_index.md"
ls "$TMPL/implementer/_index.md"
ls "$TMPL/reviewer/_index.md"
ls "$TMPL/auditor/_index.md"
```

If the template is missing or incomplete, stop and tell the user:
"The vault init template at ${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template/
is missing or incomplete. Run `./setup/bootstrap.sh` in a project that uses
claude-peers to install it, or set CLAUDE_PEERS_MCP_PATH to the correct path."

## Process

> **Template path note:** All steps below use `$TMPL` as a shorthand for
> `${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template/`. Set the
> `CLAUDE_PEERS_MCP_PATH` environment variable if you cloned `claude-peers-mcp`
> somewhere other than `~/claude-peers-mcp`.

### 1. Detect project context

```bash
# Must be in a git repo
project_root=$(git rev-parse --show-toplevel 2>/dev/null)
slug=$(basename "$project_root")
TMPL="${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template"
```

If not in a git repo, stop: "This directory isn't a git repository. Initialize
one first with `git init`, then run vault-init again."

### 2. Check for existing vault

```bash
ls "$project_root/vault" 2>/dev/null
```

If a `vault/` directory already exists, stop and ask:
"This project already has a vault/ directory. Do you want to:
1. Abort (keep existing vault)
2. Back up existing vault to vault.bak/ and create fresh"

Do not silently overwrite or merge — the user decides.

### 3. Gather project info

Ask the user three questions, one at a time:

**Question 1 — Tech stack:**
"What's the tech stack for this project? (e.g., Python 3.13+, FastAPI, Pydantic v2, pytest)"

**Question 2 — Current state:**
"Brief summary of the project's current state? (e.g., 'v0.1.0 delivered, v0.2.0 in design')"

**Question 3 — Relevant domains:**
"Which domains apply to this project? Pick from the defaults or add custom ones:
- backend
- pipeline
- frontend
- model-tuner
- rag
- (custom — specify)"

### 4. Copy the vault skeleton

Copy the role skeleton from the init template:

```bash
TMPL="${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template"

# Shared infrastructure with subdirs
mkdir -p "$project_root/vault/_shared"/{concepts,process,visual}

# Role workspaces with subdirs
mkdir -p "$project_root/vault/coordinator"
mkdir -p "$project_root/vault/planner"/{active,completed}
mkdir -p "$project_root/vault/implementer/progress"
mkdir -p "$project_root/vault/reviewer/findings"
mkdir -p "$project_root/vault/auditor/reports"

# Project-level hook surface (for any future project-specific hooks)
mkdir -p "$project_root/.claude/hooks"

# Copy role configs
for role in coordinator planner implementer reviewer auditor; do
  cp "$TMPL/$role/_index.md" "$project_root/vault/$role/_index.md"
done

# Copy coordinator dispatch log template
cp "$TMPL/coordinator/dispatch-log.md" "$project_root/vault/coordinator/dispatch-log.md"

# Copy shared infrastructure
cp "$TMPL/_shared/HOME.md" "$project_root/vault/_shared/HOME.md"
cp "$TMPL/_shared/_peer-roster.md" "$project_root/vault/_shared/_peer-roster.md"

# Preserve empty dirs in git
for dir in _shared/concepts _shared/process _shared/visual planner/active planner/completed implementer/progress reviewer/findings auditor/reports; do
  touch "$project_root/vault/$dir/.gitkeep"
done

# Copy the project-level hooks README and .gitkeep from the template
cp "$TMPL/.claude/hooks/README.md" "$project_root/.claude/hooks/README.md"
touch "$project_root/.claude/hooks/.gitkeep"
```

**Why `.claude/hooks/` is seeded at init:** framework hooks (role-wakeup,
worktree-discipline) live globally at `~/.claude/hooks/` and fire for every
session. This project-level directory is a convention for future
project-*specific* hooks, and the README documents the rules for adding one.
Empty at init — you're not meant to fill it unless a project-specific hook
is actually warranted.

### 5. Replace project placeholder in role configs

The template files use `<project>` as a placeholder. Replace all occurrences
with this project's slug:

```bash
sed -i "s/<project>/$slug/g" vault/*/_index.md vault/_shared/*.md
```

Also replace any generic source paths in the domain context tables
(implementer and reviewer `_index.md`) with the project's actual source
layout if known. Otherwise, leave the generic paths and add a comment:
`<!-- Update source paths for this project -->`.

### 6. Adapt HOME.md (replaces template version entirely)

Rewrite `vault/_shared/HOME.md` for this project using the answers from
step 3.

The adapted HOME.md should include:
- Project name and slug in the title
- The tech stack from question 1
- The current state from question 2
- The domain table filtered to only the domains from question 3
- Reference to the master vault: "Cross-project concepts live in the master
  vault at `~/code/vault/`. This project vault holds project-specific content."

Keep the role tables (singleton, cross-domain, domain-specialized) but filter
the domain rows to only the relevant domains.

### 7. Adapt domain tables in role configs

In `vault/implementer/_index.md` and `vault/reviewer/_index.md`, the domain
context tables list all possible domains. Leave the full table — domains the
project doesn't use are harmless, and the table serves as documentation of
what's available. But add a comment at the top of the table noting which
domains are active for this project.

### 8. Initialize peer roster

Write `vault/_shared/_peer-roster.md` with empty bindings. Include rows for
coordinator, planner-A, auditor, and domain-specific implementer/reviewer
pairs based on the domains the user selected in step 3:

```markdown
---
title: "Peer Roster — <project-name>"
date: <today's date>
type: meta
status: active
tags:
  - roster
  - peers
---

# Peer Roster — <project-name>

| Role | Peer ID | Status | Claimed |
|---|---|---|---|
| coordinator | — | unclaimed | — |
| planner-A | — | unclaimed | — |
| implementer-<domain1>-A | — | unclaimed | — |
| reviewer-<domain1>-A | — | unclaimed | — |
| implementer-<domain2>-A | — | unclaimed | — |
| reviewer-<domain2>-A | — | unclaimed | — |
| auditor | — | unclaimed | — |

Active role bindings are updated by sessions on wakeup via `set_role`.
```

Generate one implementer + reviewer row per domain from the user's answer.

### 9. Check for project CLAUDE.md

```bash
ls "$project_root/.claude/CLAUDE.md" 2>/dev/null
```

If no project-level CLAUDE.md exists, create a minimal one:

```markdown
# <Project Name>

## Vault

This project uses the role framework. See `vault/_shared/HOME.md` for the
project MOC and role directory.

## Role wakeup

Launch role-aware sessions with the `claudepeers-*` shell wrappers:
- `claudepeers-coordinator` — project manager
- `claudepeers-planner` — plan author
- `claudepeers-implementer <domain>` — code executor
- `claudepeers-reviewer <domain>` — code reviewer
- `claudepeers-auditor` — periodic meta-reviewer
```

If a CLAUDE.md already exists, do not overwrite it. Instead, append a
"## Vault" section with the same content if no vault reference exists yet.

### 9a. Ensure `.claude/settings.local.json` has the framework baseline allowlist

Peer roles need a baseline set of tool permissions to function without
per-invocation approval prompts (peer mesh calls, codex for reviewers, git/grep
for reading vault state). Merge the baseline into `.claude/settings.local.json`.

**Baseline allowlist:**

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

**Merge procedure:**

```bash
mkdir -p "$project_root/.claude"
settings="$project_root/.claude/settings.local.json"

if [ ! -f "$settings" ]; then
  # Create fresh with baseline only
  cat > "$settings" <<'EOF'
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
EOF
else
  # Merge: parse existing JSON, add any missing baseline entries to
  # permissions.allow, preserve all other fields. Use jq.
  baseline='["mcp__claude-peers__list_peers","mcp__claude-peers__set_summary","mcp__claude-peers__set_role","mcp__claude-peers__send_message","mcp__claude-peers__check_messages","Bash(codex exec:*)","Skill(skill-codex:codex)","Bash(git:*)","Bash(grep:*)"]'
  tmp="$(mktemp)"
  jq --argjson baseline "$baseline" '
    .permissions = (.permissions // {}) |
    .permissions.allow = (.permissions.allow // []) |
    .permissions.allow = (.permissions.allow + $baseline | unique)
  ' "$settings" > "$tmp" && mv "$tmp" "$settings"
fi
```

**Key rules:**
- **Merge, never overwrite.** If the file exists, preserve every entry — only
  add missing baseline entries.
- **Preserve all non-allowlist fields** (`remote`, `deny`, other sections).
- **`unique` deduplicates** so re-running vault-init is idempotent.
- The baseline is a *floor*, not a ceiling. Projects accumulate their own
  domain-specific permissions organically; those are outside the framework's
  concern.

See `~/.claude/role-etiquette.md` §6 for the rationale behind each baseline
entry and the policy for when new entries can be added.

### 10. Commit

```bash
git add vault/ .claude/CLAUDE.md .claude/settings.local.json .claude/hooks/
git commit -m "init: vault skeleton from master vault template"
```

### 11. Confirm and show next steps

Print:

```
Vault initialized for <slug>.

Structure:
  vault/_shared/
    HOME.md                      — project MOC
    _peer-roster.md              — role bindings (empty)
    concepts/                    — glossary, patterns, domain knowledge
    process/                     — cross-role conventions, checklists
    visual/                      — canvases, bases, graphs (auditor-managed)
  vault/coordinator/
    _index.md                    — coordinator wakeup
    dispatch-log.md              — dispatch decisions log
  vault/planner/
    _index.md                    — planner wakeup
    active/                      — in-flight plan trackers
    completed/                   — finished plan summaries with deviations
  vault/implementer/
    _index.md                    — implementer wakeup (worktree mandatory)
    progress/                    — plan-diff logs (what changed from plan)
  vault/reviewer/
    _index.md                    — reviewer wakeup (worktree mandatory)
    findings/                    — review findings per task
  vault/auditor/
    _index.md                    — auditor wakeup
    reports/                     — audit reports per pass
  .claude/hooks/
    README.md                    — convention for project-specific hooks
    (framework hooks live globally at ~/.claude/hooks/)

Next steps — launch roles with:
  claudepeers-coordinator              # project manager (singleton)
  claudepeers-planner                  # plan author (cross-domain)
  claudepeers-implementer backend      # code executor (domain-matched)
  claudepeers-reviewer backend         # code reviewer (paired with implementer)
  claudepeers-auditor                  # periodic meta-reviewer

Master vault (cross-project references): ~/code/vault/
```

## Key Principles

- **Init template is the source of truth for scaffolding.** Always copy from
  `${CLAUDE_PEERS_MCP_PATH:-$HOME/claude-peers-mcp}/vault-template/`, never
  from the master vault or another project.
- **Master vault is for linking, not copying.** Projects reference
  `~/code/vault/` docs — they don't duplicate them.
- **Ask, don't assume.** Gather project info interactively — don't guess the
  tech stack or domains.
- **Never overwrite.** If a vault or CLAUDE.md exists, ask before touching it.
- **One-shot.** This skill runs once per project. After init, roles manage
  their own `_index.md` files.
