---
title: "<project> Vault — HOME (role framework v1)"
aliases:
  - HOME
  - MOC
  - index
date: 2026-04-09
version: cross-cutting
type: moc
status: active
tags:
  - moc
  - index
  - home
  - role-framework
peer: null
related:
  - "[[_peer-roster]]"
---

# <project> Vault — HOME (Role Framework v1)

This vault uses the **role framework v1** — a curated, role-conditional
context loading system on top of `claude-peers-mcp`. Cross-project concepts
live in the master vault at `~/code/vault/`. This project vault holds
project-specific content.

## Project context

<!-- vault-init will fill this section with project-specific info -->

**Tech stack:** (fill in during init)

**Current state:** (fill in during init)

## Vault structure

### `_shared/` — cross-role content

| Directory | Purpose | Who writes |
|---|---|---|
| `_shared/` (root) | `HOME.md`, `_peer-roster.md` — framework infrastructure | Framework / coordinator |
| `_shared/concepts/` | Glossary, architectural patterns, domain knowledge | Any role (planner, architect) |
| `_shared/process/` | Cross-role conventions, checklists, workflow docs | Coordinator, architect |
| `_shared/visual/` | Obsidian canvases, Bases dashboards, graphs | Auditor (presentation owner) |

### Role workspaces — per-role artifacts

Each role folder is a workspace, not just a config file. The `_index.md` is
the wakeup config; subdirectories hold that role's work products.

| Role folder | Workspace contents | Purpose |
|---|---|---|
| `coordinator/` | `dispatch-log.md` | Dispatch decisions, authorizations, refusals |
| `planner/` | `active/`, `completed/` | Plan tracking: in-flight status and finished summaries |
| `implementer/` | `progress/` | Per-task plan-diff logs: what changed from the plan during implementation |
| `reviewer/` | `findings/` | Review findings per task/PR (Claude-eye + codex) |
| `auditor/` | `reports/` | Audit reports per pass |

## Roles in this project

### Singleton roles

| Role | Wakeup index |
|---|---|
| `coordinator` | [[../coordinator/_index\|coordinator/_index.md]] |
| `auditor` | [[../auditor/_index\|auditor/_index.md]] |

### Cross-domain roles

| Role | Wakeup index | Notes |
|---|---|---|
| `planner[-<instance>]` | [[../planner/_index\|planner/_index.md]] | Cross-domain, no pairing requirement |

### Domain-specialized roles (paired: implementer + reviewer)

<!-- vault-init will filter this table to active domains -->

| Domain | Implementer config | Reviewer config |
|---|---|---|
| *(domain)* | [[../implementer/_index\|implementer/_index.md]] | [[../reviewer/_index\|reviewer/_index.md]] |

## Reference material

- `CLAUDE.md` — project commands, architecture, database schema
- `~/code/vault/` — master vault (cross-project reference material)
- `~/.claude/role-vocabulary.md` — global canonical role taxonomy
- `~/.claude/roles/architect/role-framework-spec.md` — the framework spec

## Vault infrastructure

- [[_peer-roster]] — current role-to-peer-ID bindings
