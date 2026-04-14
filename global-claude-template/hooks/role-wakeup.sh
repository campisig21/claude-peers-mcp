#!/bin/bash
# Role wakeup hook for claude-peers role framework v1
# Runs on SessionStart. If CLAUDE_PEER_ROLE is set, resolves the role's
# _index.md and injects it into the model's context via hookSpecificOutput.
# If CLAUDE_PEER_ROLE is unset, exits silently (no-op).

set -euo pipefail

if [ -z "${CLAUDE_PEER_ROLE:-}" ]; then
    exit 0
fi

role="$CLAUDE_PEER_ROLE"

# --- Determine role tier and resolve index path ---

if [[ "$role" == *"/"* ]]; then
    # Project-scoped role: <slug>/<role_name>
    slug="${role%%/*}"
    role_name="${role#*/}"

    # Walk up from cwd to find project root (directory named $slug containing vault/)
    project_root=""
    current="$PWD"
    while [ "$current" != "/" ]; do
        if [ "$(basename "$current")" = "$slug" ] && [ -d "$current/vault" ]; then
            project_root="$current"
            break
        fi
        current="$(dirname "$current")"
    done

    if [ -z "$project_root" ]; then
        jq -n --arg msg "[ROLE WAKEUP ERROR] CLAUDE_PEER_ROLE=$role but cwd ($PWD) is not inside project '$slug' with a vault/ directory. The wakeup is skipped." \
            '{systemMessage: $msg}'
        exit 0
    fi

    # Cascading resolution: exact role_name → strip instance suffix → strip domain suffix
    # Grammar: <base-role>[-<domain>][-<instance>]
    #   e.g., implementer-backend-A → implementer-backend → implementer
    index=""
    try_name="$role_name"
    for attempt in exact strip_instance strip_domain; do
        candidate="$project_root/vault/$try_name/_index.md"
        if [ -f "$candidate" ]; then
            index="$candidate"
            break
        fi
        case "$attempt" in
            exact)
                # Strip trailing single uppercase letter instance suffix: -A, -B, ...
                try_name="$(echo "$try_name" | sed 's/-[A-Z]$//')"
                ;;
            strip_instance)
                # Strip trailing domain segment: -backend, -pipeline, -model-tuner, ...
                try_name="$(echo "$try_name" | sed 's/-[a-z][-a-z]*$//')"
                ;;
        esac
    done

    if [ -z "$index" ]; then
        jq -n --arg msg "[ROLE WAKEUP ERROR] CLAUDE_PEER_ROLE=$role — no _index.md found. Tried: vault/$role_name/, vault/$(echo "$role_name" | sed 's/-[A-Z]$//')/, vault/$(echo "$role_name" | sed 's/-[A-Z]$//' | sed 's/-[a-z][-a-z]*$//')/. Create the _index.md file, then restart." \
            '{systemMessage: $msg}'
        exit 0
    fi
else
    # Global role: bare name, no slash
    index="$HOME/.claude/roles/$role/_index.md"

    if [ ! -f "$index" ]; then
        jq -n --arg msg "[ROLE WAKEUP ERROR] CLAUDE_PEER_ROLE=$role but $index does not exist. Create the _index.md file, then restart the session." \
            '{systemMessage: $msg}'
        exit 0
    fi
fi

# --- Build context to inject ---

index_content="$(cat "$index")"

context="===== ROLE WAKEUP: $role =====

CLAUDE_PEER_ROLE is set to '$role'. This hook has loaded your role's
_index.md content below. You MUST treat it as mandatory instructions:

1. Read every file listed in the 'Reading list' section (use the Read tool)
2. Invoke every skill listed in the 'Mandatory skills' section (use the Skill tool)
3. Call mcp__claude-peers__list_peers to discover the live peer mesh (if the MCP server is available)
4. Optionally call mcp__claude-peers__set_summary to announce your role
5. Print a 2-line brief of your role: line 1 = your role name and scope (global or project), line 2 = what you do in one sentence. This orients the user immediately.
6. THEN respond to the user's first message

Do NOT skip these steps. Do NOT treat this as documentation. This is your
active role assignment.

--- BEGIN ${index} ---
${index_content}
--- END ${index} ---

===== END ROLE WAKEUP ====="

# --- Output JSON for Claude Code harness ---

jq -n \
    --arg msg "Role wakeup: $role" \
    --arg ctx "$context" \
    '{
        systemMessage: $msg,
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: $ctx
        }
    }'
