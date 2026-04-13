# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` (excludes your own row)           |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)                                    |
| `set_summary`    | Describe what you're working on (visible to other peers)                                                         |
| `set_role`       | Claim a stable role name (e.g. `overseer`) so the next session with `CLAUDE_PEER_ROLE=<role>` inherits this ID   |
| `get_self_id`    | Returns your own peer ID, PID, working directory, git root, and role                                             |
| `check_messages` | Manually check for messages (fallback if not using channel mode)                                                 |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. Everything is localhost-only.

When a peer's process dies, its row is **marked dead** instead of deleted (via a `status` column). This preserves the peer's role binding (see below) so a future session can reclaim the same ID. Dead rows are excluded from `list_peers` and `send_message` routing — they only exist as the source of truth for role → ID mapping.

## Stable role names

By default, each session gets a fresh random adjective-noun ID (`swift-otter`, `bright-comet`, …) every time it starts. If you want a session to get the **same** ID across restarts — so cross-session references in notes, plans, or other peers' memory stay accurate — bind it to a **role**.

A role is a free-form string. Only one active peer may hold a given role at a time. When a role-bound peer dies and a new session registers with the same role, the broker reuses the prior peer ID.

### Claim a role at startup (env var)

```bash
CLAUDE_PEER_ROLE=overseer claude --dangerously-load-development-channels server:claude-peers
```

Handy as a shell alias:

```bash
alias claude-overseer='CLAUDE_PEER_ROLE=overseer claude --dangerously-load-development-channels server:claude-peers'
alias claude-planner='CLAUDE_PEER_ROLE=planner  claude --dangerously-load-development-channels server:claude-peers'
```

If another live peer already holds the role, registration fails with a clear error — pick a different role or tear the other session down first.

### Claim a role from inside a session

If you forgot to set the env var, ask Claude to run the `set_role` tool:

> Set your role to `reviewer`.

The binding takes effect for the *next* restart — the current session keeps its current ID until it dies, at which point the role becomes reclaimable.

### Release a role

Call `set_role` with `null` to clear the current role. The peer keeps its current ID but subsequent restarts won't reuse it.

### Role conflicts

- **Live conflict** (another active peer holds the role): both `/register` with `CLAUDE_PEER_ROLE=x` and the `set_role` tool hard-fail with an error naming the current holder.
- **Dead holder**: if the prior holder is dead, the new session silently reclaims its ID. The dead row is revived in place.
- **Most-recent-dead wins** if there are multiple dead rows for the same role (shouldn't happen under normal use).

Peer IDs are opaque to everything except the broker — no other tool or flow cares about the format. Roles are a peer-owned convention layered on top; document your project's canonical role vocabulary wherever makes sense for your workflow.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                                                               |
| -------------------- | -------------------- | ------------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`  | `7899`               | Broker port                                                               |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path                                                      |
| `CLAUDE_PEER_ROLE`   | —                    | Role claim for stable peer IDs across restarts (see "Stable role names")  |
| `OPENAI_API_KEY`     | —                    | Enables auto-summary via gpt-5.4-nano                                     |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
