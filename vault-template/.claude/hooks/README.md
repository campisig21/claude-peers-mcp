# Project-level hooks

This directory is the conventional home for project-specific Claude Code
hook scripts in the role framework. If you write a hook that is only
meaningful inside this project, it goes here and is registered via
`.claude/settings.local.json` (user-local) or a future committed
`.claude/settings.json`.

## Framework hooks live globally

Hooks that behave identically across every role-framework project are
registered once in `~/.claude/settings.json` and their scripts live at
`~/.claude/hooks/`. As of framework v1 that is:

| Hook | Event | Script | Purpose |
|---|---|---|---|
| role-wakeup | SessionStart | `~/.claude/hooks/role-wakeup.sh` | Resolves `CLAUDE_PEER_ROLE` and injects the role's `_index.md` context |
| worktree-discipline | PreToolUse (Edit/Write/NotebookEdit) | `~/.claude/hooks/worktree-discipline.sh` | Blocks implementer roles from editing files on the main checkout |

You do not need to register these per-project; they fire for every Claude
Code session automatically and early-exit when they don't apply.

## When to add a project-specific hook

Add one here only when:

- The check is meaningful only in *this* project's domain (not across the
  framework)
- The discipline can't be enforced by convention alone
- The check is cheap — early-exit for the 99% case

Before writing a hook, check if the behavior can live in a role
`_index.md` instead. Role configs communicate intent without runtime cost.

## How to add a project-specific hook

1. Write the script in this directory (e.g., `my-hook.sh`). `chmod +x` it.
2. Lead with a comment block describing: what it does, when it fires,
   what it blocks or allows, and why.
3. Register it in `.claude/settings.local.json` under the appropriate event
   (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`).
4. Keep it fast. Early-exit on the env check, tool-name check, path
   check — in that order — before doing any expensive work.

## Anti-sprawl reminder

Hooks add cost to every matching tool call and are harder to debug than
documentation. A rule that lives in an `_index.md` is readable, version-
controlled, and transparent to the role-holder. A hook is invisible until
it fires. Prefer the readable option unless enforcement is truly required.
