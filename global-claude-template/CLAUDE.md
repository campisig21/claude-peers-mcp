# Claude Code — Global Instructions

> These instructions are loaded into every Claude Code session you start
> on this machine, regardless of project. They establish the role-conditional
> context loading protocol used with `claude-peers-mcp`.

## Role-conditional wakeup (claude-peers integration)

If the environment variable `CLAUDE_PEER_ROLE` is set when this session
starts, a `SessionStart` hook (`~/.claude/hooks/role-wakeup.sh`) automatically
detects it and injects your role's `_index.md` content into your session
context. You will see it as a `===== ROLE WAKEUP =====` block. When you
see this block, your **first action** before responding to any user request
is to execute the wakeup sequence below — do NOT skip it, do NOT treat it
as documentation.

### Wakeup sequence

1. **Read `$CLAUDE_PEER_ROLE`.** The value is one of:
   - **A bare role name** (e.g., `architect`, `broker-maintainer`) → this is a
     **global role**. Its content lives in `~/.claude/roles/<role>/`.
   - **A namespaced role** (e.g., `multi-agent/coordinator`,
     `myproject/planner-A`) → this is a **project-scoped role**. The string
     before `/` is the project slug; the string after is the role within
     that project.

2. **For global roles:**
   - Read `~/.claude/role-vocabulary.md` to confirm the role exists in the
     canonical vocabulary.
   - Read `~/.claude/roles/<role>/_index.md` — your role's wakeup file.
   - Read every file listed in the `_index.md` "Reading list" section, in
     the order listed.
   - Read `~/.claude/roles/<role>/decision-log.md` if it exists — recent
     entries are highest priority.

3. **For project-scoped roles:**
   - Verify your current working directory is inside the named project. The
     project root is the nearest ancestor directory containing a `vault/`
     subdirectory whose basename matches the project slug. If the cwd does
     not match, STOP and tell the user you're in the wrong project for this
     role.
   - Read `<project-root>/vault/_shared/_peer-roster.md` to learn the
     current role bindings in this project.
   - Read `<project-root>/vault/_shared/HOME.md` for the project MOC.
   - Read `<project-root>/vault/<role>/_index.md` — your role's wakeup file.
     The wakeup hook resolves the `_index.md` via **cascading fallback**:
     1. Try exact role name (e.g., `vault/implementer-backend-A/_index.md`)
     2. Strip instance suffix `-[A-Z]` (e.g., `vault/implementer-backend/_index.md`)
     3. Strip domain suffix `-[a-z-]+` (e.g., `vault/implementer/_index.md`)
     This allows domain-specialized instances to share a single config.
   - Read every file listed in the `_index.md` "Reading list" section, in
     the order listed.
   - **Instance auto-claim:** if your `_index.md` has an "Instance auto-claim"
     section, follow it: query `list_peers`, find existing instances of your
     role, and claim the next available letter via `set_role`.

4. **Invoke mandatory skills.** Each `_index.md` has a `## Mandatory skills`
   section. Invoke each listed skill via the Skill tool BEFORE responding to
   the user. The `## Recommended skills` section lists optional skills you
   may invoke as the work calls for them.

5. **Discover the live peer mesh.** Call `mcp__claude-peers__list_peers`
   with `scope='repo'` (project roles) or `scope='machine'` (global roles)
   to see who else is online. Refresh your assumption of the current peer
   roster.

6. **(Optional)** Call `mcp__claude-peers__set_summary` with a 1-2 sentence
   announcement of your role and current focus.

After step 6, you have full role context. NOW respond to the user's request.

### When `CLAUDE_PEER_ROLE` is NOT set

This entire directive is a no-op. Sessions without a role behave as normal
Claude Code sessions. Most ad-hoc work falls into this category.

## Canonical role types

See `~/.claude/role-vocabulary.md` for the full list of roles, their scope
(global vs project), responsibilities, default mandatory skills, and the
shell function snippets to set `CLAUDE_PEER_ROLE` correctly per role.

## Pairing rules

The role framework includes hard pairing rules enforced by convention, not
code. The most important:

- **Implementer ↔ Reviewer (mandatory, domain-matched):** Every active
  `implementer-<domain>-*` requires an active `reviewer-<domain>-*` in the
  same domain. The coordinator MUST refuse to authorize implementer dispatch
  without a paired reviewer claim. The reviewer runs two simultaneous review
  passes (Claude-eye + codex) per implementation.
- **Planner (independent):** The planner is cross-domain and has no mandatory
  pairing constraint.

See `~/.claude/roles/architect/role-framework-spec.md` for the full
ruleset and the rationale behind each.

## Memory and persistence

This directive concerns *role-conditional context loading*, which is one of
several persistence mechanisms available to a Claude Code session:

- **Role wakeup** (this directive) — restores role-specific working context
  on session start when `CLAUDE_PEER_ROLE` is set
- **Auto-memory** (`~/.claude/projects/.../memory/`) — your own deliberate
  facts about a specific project, written by you for future sessions
- **Vault docs** (`<project>/vault/`, `<project>/_example-vault/`) — design
  docs, plans, decision logs that humans and agents both read
- **Peer mesh** (`mcp__claude-peers__*`) — live coordination with other
  Claude sessions on this machine

These are independent layers. Role wakeup does NOT replace auto-memory;
they cooperate. Use auto-memory for facts about the user, the project, and
recurring feedback. Use role wakeup for in-flight work continuity within a
specific role.
