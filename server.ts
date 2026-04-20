#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// Expected broker version: hash of broker.ts on disk. Compared against the
// running daemon's /health response to detect stale brokers.
const EXPECTED_BROKER_VERSION = Bun.hash(
  await Bun.file(BROKER_SCRIPT).text()
).toString(16);
let brokerVersionWarned = false;

// --- Broker communication ---

const HEAL_COOLDOWN_MS = 10_000;
let lastHealAttempt = 0;
let healInProgress: Promise<void> | null = null;

function isConnectionError(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch throws TypeError on network failure
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    return msg.includes("econnrefused") ||
      msg.includes("connection refused") ||
      msg.includes("fetch failed") ||
      msg.includes("unable to connect");
  }
  return false;
}

async function attemptSelfHeal(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealAttempt < HEAL_COOLDOWN_MS) {
    return false;
  }

  // Deduplicate concurrent heal attempts — poll, heartbeat, and tool calls
  // can all fail at once when the broker goes down.
  if (healInProgress) {
    try { await healInProgress; return true; } catch { return false; }
  }

  lastHealAttempt = now;
  log("Broker unreachable, attempting self-heal...");
  healInProgress = ensureBroker();
  try {
    await healInProgress;
    log("Self-heal succeeded — broker is back");
    return true;
  } catch (e) {
    log(`Self-heal failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    healInProgress = null;
  }
}

async function rawBrokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  try {
    return await rawBrokerFetch<T>(path, body);
  } catch (e) {
    if (!isConnectionError(e)) throw e;

    const healed = await attemptSelfHeal();
    if (!healed) throw e;

    // Retry once after successful heal
    return await rawBrokerFetch<T>(path, body);
  }
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkBrokerVersion(): Promise<void> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json() as { status: string; peers: number; version?: string };
    if (!data.version) {
      if (!brokerVersionWarned) {
        log("WARNING: broker /health has no version field — daemon predates version check");
        brokerVersionWarned = true;
      }
      return;
    }
    if (data.version !== EXPECTED_BROKER_VERSION) {
      if (!brokerVersionWarned) {
        log(`WARNING: broker version mismatch — running=${data.version} disk=${EXPECTED_BROKER_VERSION}. Broker daemon is stale.`);
        brokerVersionWarned = true;
      }
    } else {
      brokerVersionWarned = false; // Reset if versions match (e.g. after a restart healed it)
    }
  } catch {
    // Non-critical
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `claude-peers mesh: when a <channel source="claude-peers" …> arrives, pause current work, reply, then resume — like a coworker tapping your shoulder. Use send_message to reply (their from_id is in the channel meta). Call set_summary on startup so peers can see what you're working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List active peer Claude instances. Excludes your own row — use get_self_id for that.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send ad-hoc message to a peer by ID. Pushed immediately to their session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a 1-2 sentence summary of your current work, visible to peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Pull any unread messages manually. Fallback — messages normally arrive as channel pushes.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_self_id",
    description:
      "Return your own peer ID, PID, cwd, git root, role. list_peers excludes your own row; use this for self-identity.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_role",
    description:
      "Claim a stable role name. A future session with CLAUDE_PEER_ROLE=<role> inherits this peer ID on revival. Pass null to release.",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: {
          type: ["string", "null"] as const,
          description:
            "The role name to claim, or null to release the current role.",
        },
      },
      required: ["role"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as Record<string, unknown>)?.scope;
      if (typeof scope !== "string" || !["machine", "directory", "repo"].includes(scope)) {
        return {
          content: [{ type: "text" as const, text: 'Invalid scope. Must be "machine", "directory", or "repo".' }],
          isError: true,
        };
      }
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: scope as "machine" | "directory" | "repo",
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        // Role-first sort: peers with roles sorted alphabetically by role,
        // roleless peers last (by id). Keeps the mesh structure legible.
        const sorted = [...peers].sort((a, b) => {
          if (a.role && b.role) return a.role.localeCompare(b.role);
          if (a.role && !b.role) return -1;
          if (!a.role && b.role) return 1;
          return a.id.localeCompare(b.id);
        });

        const lines = sorted.map((p) => {
          const tag = p.role ? `[${p.role}]` : "(no role)";
          const summary = p.summary ? `  — ${p.summary}` : "";
          return `${tag} ${p.id}  ${p.cwd}${summary}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const rawArgs = args as Record<string, unknown>;
      const to_id = rawArgs?.to_id;
      const message = rawArgs?.message;
      if (typeof to_id !== "string" || to_id.trim() === "") {
        return {
          content: [{ type: "text" as const, text: 'Invalid to_id. Must be a non-empty string.' }],
          isError: true,
        };
      }
      if (typeof message !== "string" || message.trim() === "") {
        return {
          content: [{ type: "text" as const, text: 'Invalid message. Must be a non-empty string.' }],
          isError: true,
        };
      }
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id: to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const summary = (args as Record<string, unknown>)?.summary;
      if (typeof summary !== "string") {
        return {
          content: [{ type: "text" as const, text: 'Invalid summary. Must be a string.' }],
          isError: true,
        };
      }
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_role": {
      const role = (args as Record<string, unknown>)?.role ?? null;
      if (role !== null && typeof role !== "string") {
        return {
          content: [{ type: "text" as const, text: 'Invalid role. Must be a string or null.' }],
          isError: true,
        };
      }
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>(
          "/set-role",
          { id: myId, role }
        );
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to set role: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                role === null
                  ? "Role released."
                  : `Role set to '${role}'. This peer ID will be reused by future sessions registering with CLAUDE_PEER_ROLE=${role}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting role: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "get_self_id": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      const role = process.env.CLAUDE_PEER_ROLE?.trim() || null;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `ID: ${myId}`,
              `PID: ${process.pid}`,
              `CWD: ${myCwd}`,
              `Git root: ${myGitRoot ?? "(none)"}`,
              `Role: ${role ?? "(none)"}`,
            ].join("\n"),
          },
        ],
      };
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running + check version parity
  await ensureBroker();
  await checkBrokerVersion();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  const role = process.env.CLAUDE_PEER_ROLE?.trim() || undefined;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);
  if (role) log(`Role claim: ${role}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker. If CLAUDE_PEER_ROLE is set, the broker will either
  //    revive the dead peer previously bound to that role (same ID returned) or
  //    throw if another live peer currently holds it.
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    ...(role ? { role } : {}),
  });
  myId = reg.id;
  log(`Registered as peer ${myId}${role ? ` (role: ${role})` : ""}`);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat + periodic version check
  let heartbeatCount = 0;
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
    // Check broker version every ~5 minutes (20 heartbeats × 15s)
    if (++heartbeatCount % 20 === 0) {
      await checkBrokerVersion();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
