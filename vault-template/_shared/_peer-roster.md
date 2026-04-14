---
title: "Peer Roster — <project>"
aliases:
  - peer roster
date: 2026-04-09
type: meta
status: active
tags:
  - vault-infra
  - peers
  - roster
peer: null
related:
  - "[[HOME]]"
---

# Peer Roster — <project>

Authoritative mapping of **role -> peer ID** for this project.

## Current bindings

### Singleton roles

| Role | Peer ID | Status | Claimed |
|---|---|---|---|
| `coordinator` | — | unclaimed | — |
| `auditor` | — | unclaimed | — |

### Planner (cross-domain)

| Role | Peer ID | Status | Claimed |
|---|---|---|---|
| `planner-A` | — | unclaimed | — |

<!-- vault-init will generate domain-specific rows based on selected domains -->

## How to claim a role

1. Launch a Claude Code session with the appropriate shell wrapper:
   `claudepeers-implementer backend` (from inside this project root)
2. The wakeup hook resolves your config via cascading fallback
3. Your session auto-claims the next available instance letter
4. The session updates this file's binding table with its peer ID
5. The session sets its peer summary via `mcp__claude-peers__set_summary`

Active role bindings are updated by sessions on wakeup via `set_role`.
