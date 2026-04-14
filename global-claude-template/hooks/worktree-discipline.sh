#!/bin/bash
# Worktree-discipline hook for claude-peers implementer roles.
#
# Blocks Edit, Write, and NotebookEdit tool calls when ALL hold:
#   1. CLAUDE_PEER_ROLE matches "<slug>/implementer" or "<slug>/implementer-..."
#   2. Target file is inside the project root (vault-bearing ancestor of cwd)
#   3. cwd is the main git checkout, not a worktree
#
# Rationale: implementers MUST work in git worktrees per the role framework.
# Direct edits on the main checkout bypass the per-task review isolation the
# framework depends on. This hook turns the discipline into enforcement.
#
# Non-implementer sessions, edits outside a vault-bearing project, and
# worktree-resident sessions all pass through as cheap no-ops.
#
# Registered globally in ~/.claude/settings.json alongside role-wakeup.sh.

set -euo pipefail

# Fast path: only fire for project-scoped implementer roles
role="${CLAUDE_PEER_ROLE:-}"
if [[ ! "$role" =~ ^[^/]+/implementer(-|$) ]]; then
    exit 0
fi

# Read hook input JSON from stdin
input="$(cat)"

# Only care about file-mutation tools
tool_name="$(echo "$input" | jq -r '.tool_name // empty')"
case "$tool_name" in
    Edit|Write|NotebookEdit) ;;
    *) exit 0 ;;
esac

# Extract target path (Edit/Write use file_path, NotebookEdit uses notebook_path)
file_path="$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
if [ -z "$file_path" ]; then
    exit 0
fi

# Locate project root: nearest ancestor of cwd containing vault/
project_root=""
current="$PWD"
while [ "$current" != "/" ]; do
    if [ -d "$current/vault" ]; then
        project_root="$current"
        break
    fi
    current="$(dirname "$current")"
done

if [ -z "$project_root" ]; then
    exit 0  # not inside a vault-bearing project
fi

# Resolve target path to absolute
case "$file_path" in
    /*) abs_file="$file_path" ;;
    *)  abs_file="$PWD/$file_path" ;;
esac

# Only enforce on files inside the project root
case "$abs_file" in
    "$project_root"/*) ;;
    *) exit 0 ;;
esac

# Determine whether cwd is a worktree or the main checkout via absolute git dir
git_dir_abs="$(git -C "$PWD" rev-parse --absolute-git-dir 2>/dev/null || echo "")"
if [ -z "$git_dir_abs" ]; then
    exit 0  # not in a git repo — let the tool call surface its own error
fi

case "$git_dir_abs" in
    */.git/worktrees/*) exit 0 ;;  # inside a worktree, allowed
    */.git) : ;;                    # main checkout — fall through to block
    *) exit 0 ;;                    # unusual git layout, don't interfere
esac

# Block with explanatory message
reason="[WORKTREE DISCIPLINE] Implementer role '$role' attempted to edit '$abs_file' on the main checkout at '$project_root'.

Per the role framework, implementers MUST work in a git worktree. Direct
edits on the main checkout bypass per-task review isolation.

Create a worktree and switch into it:

  cd $project_root
  git worktree add .worktrees/<branch-name> -b <branch-name>
  cd .worktrees/<branch-name>

Then retry. Merge to main only after reviewer approval."

jq -n --arg reason "$reason" '{decision: "block", reason: $reason}'
exit 0
