#!/bin/bash
# claude-peers shell wrappers — sourced by .zshrc between BEGIN/END markers
# Canonical definitions; regenerate from claude-peers-mcp/global-claude-template/zshrc-wrappers.sh

alias claudepeers="claude --dangerously-load-development-channels server:claude-peers"

claudepeers-architect() {
  CLAUDE_PEER_ROLE=architect claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-broker-maintainer() {
  CLAUDE_PEER_ROLE=broker-maintainer claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-coordinator() {
  local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  CLAUDE_PEER_ROLE="${slug}/coordinator" claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-planner() {
  local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  CLAUDE_PEER_ROLE="${slug}/planner" claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-implementer() {
  local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  local domain=""
  if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then domain="-$1"; shift; fi
  CLAUDE_PEER_ROLE="${slug}/implementer${domain}" claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-reviewer() {
  local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  local domain=""
  if [ -n "${1:-}" ] && [[ "$1" != -* ]]; then domain="-$1"; shift; fi
  CLAUDE_PEER_ROLE="${slug}/reviewer${domain}" claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}

claudepeers-auditor() {
  local slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  CLAUDE_PEER_ROLE="${slug}/auditor" claude \
    --dangerously-load-development-channels server:claude-peers "$@"
}
