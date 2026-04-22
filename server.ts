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
// Long-poll wait window. Matches (must be <=) broker's MAX_WAIT_MS.
// Broker's default is also 30s, so not sending the field would work,
// but we pass it explicitly as documentation of intent.
const POLL_WAIT_MS = 30_000;
// Client-side HTTP timeout for the long-poll request. Must exceed
// POLL_WAIT_MS or the client aborts before the broker's waiter can
// resolve — that's the exact bug PR #2's first codex pass caught:
// a 5s default timeout was firing against a 30s server wait, silently
// degrading effective poll cadence to ~6s. +5s buffer absorbs broker
// scheduling jitter without risking false positives.
const POLL_HTTP_TIMEOUT_MS = POLL_WAIT_MS + 5_000;
// Backoff after a poll error before retrying — prevents tight error
// loops when the broker is briefly unreachable.
const POLL_ERROR_BACKOFF_MS = 1000;
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

// Default HTTP timeout for broker calls. Long-poll callers pass their own,
// larger value via BrokerFetchOpts.timeoutMs since they legitimately block
// for up to POLL_WAIT_MS on the broker side.
const DEFAULT_BROKER_TIMEOUT_MS = 5000;

type BrokerFetchOpts = {
  timeoutMs?: number;
};

async function rawBrokerFetch<T>(
  path: string,
  body: unknown,
  opts: BrokerFetchOpts = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerFetch<T>(
  path: string,
  body: unknown,
  opts: BrokerFetchOpts = {}
): Promise<T> {
  try {
    return await rawBrokerFetch<T>(path, body, opts);
  } catch (e) {
    if (!isConnectionError(e)) throw e;

    const healed = await attemptSelfHeal();
    if (!healed) throw e;

    // Retry once after successful heal
    return await rawBrokerFetch<T>(path, body, opts);
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

type HealthResponse = {
  status: string;
  peers: number;
  version?: string;
  pid?: number;
};

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

// Kill a stale broker and respawn from disk. Concurrency model: each session
// arrives here independently (no cross-session lock). Safety comes from a
// compare-and-swap re-verify right before SIGTERM — we refetch /health and
// only kill if (a) the broker is still stale AND (b) its pid is still the
// one we originally diagnosed. If another session healed in the meantime,
// the second check fails and we abort cleanly. The local healInProgress
// mutex and HEAL_COOLDOWN_MS gate remain in force to dedupe within a single
// session.
//
// In-flight long-polls: SIGTERM causes Bun.serve to close listening sockets,
// giving connected clients ECONNRESET on their pending requests. The poll
// driver loop treats that as a connection error, calls attemptSelfHeal via
// brokerFetch, and reconnects to the respawned broker. Recovery window is
// typically ~1s (measured empirically on 2026-04-22 when this scenario was
// first hit manually).
async function healStaleBroker(expectedStalePid: number): Promise<void> {
  // CAS re-verify. If version now matches or pid rotated, someone else
  // already healed — do nothing. This is what makes N concurrent heal
  // attempts safe without a shared lockfile.
  const pre = await fetchHealth();
  if (!pre) {
    // Broker is down — let ensureBroker handle the respawn path.
    log("Broker unreachable during heal check; respawning");
    await ensureBroker();
    return;
  }
  if (pre.version === EXPECTED_BROKER_VERSION) {
    log("Broker already healed by another session; skipping");
    return;
  }
  if (pre.pid !== expectedStalePid) {
    log(`Broker pid rotated (${expectedStalePid} -> ${pre.pid}); skipping kill`);
    return;
  }

  log(`Killing stale broker pid=${expectedStalePid} (running=${pre.version} disk=${EXPECTED_BROKER_VERSION})`);
  try {
    process.kill(expectedStalePid, "SIGTERM");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ESRCH = already dead; benign race. Anything else is worth logging.
    if (!msg.includes("ESRCH") && !msg.includes("no such process")) {
      log(`Kill failed: ${msg}`);
    }
  }
  // Wait for the port to actually free. 20 × 150ms = 3s cap; typical
  // shutdown on Bun.serve is sub-100ms.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await isBrokerAlive())) break;
  }
  await ensureBroker();
  log("Stale-broker heal complete");
}

async function checkBrokerVersion(): Promise<void> {
  const data = await fetchHealth();
  if (!data) return;

  if (!data.version) {
    // Pre-version-fingerprint daemon. We can't diagnose staleness without
    // the fingerprint field, and we don't have a trustworthy pid to target
    // the kill (pid field was added in the same patch as version). Log
    // once and require human intervention for this one-shot migration path.
    if (!brokerVersionWarned) {
      log("WARNING: broker /health has no version field — daemon predates version check. Manual restart required.");
      brokerVersionWarned = true;
    }
    return;
  }

  if (data.version === EXPECTED_BROKER_VERSION) {
    brokerVersionWarned = false;
    return;
  }

  // Version mismatch: running broker is stale relative to disk. Attempt
  // auto-heal, gated by the shared in-session cooldown + mutex so a burst
  // of mismatches (e.g., if checkBrokerVersion fires during poll error
  // retries) doesn't stack up kill+respawn cycles.
  const now = Date.now();
  if (now - lastHealAttempt < HEAL_COOLDOWN_MS) {
    if (!brokerVersionWarned) {
      log(`Broker version mismatch (running=${data.version} disk=${EXPECTED_BROKER_VERSION}); heal cooldown active, will retry after ${Math.ceil((HEAL_COOLDOWN_MS - (now - lastHealAttempt)) / 1000)}s`);
      brokerVersionWarned = true;
    }
    return;
  }
  if (healInProgress) {
    try { await healInProgress; } catch { /* ignore — next check will retry */ }
    return;
  }
  if (!data.pid) {
    // Version present but pid missing: shouldn't occur in practice (both
    // landed in the same patch), but defensively handle it rather than
    // sending SIGTERM to a pid we can't trust.
    log(`Broker has version but no pid field — can't target kill. Manual restart required.`);
    return;
  }

  log(`Broker version mismatch — triggering auto-heal (running=${data.version} disk=${EXPECTED_BROKER_VERSION} pid=${data.pid})`);
  lastHealAttempt = now;
  healInProgress = healStaleBroker(data.pid);
  try {
    await healInProgress;
    brokerVersionWarned = false;
    // Reset cooldown on SUCCESS so a second legitimate mismatch (e.g.,
    // another session respawned an old broker within 10s) isn't silenced
    // by the rate-limit. The cooldown exists to prevent tight FAIL loops;
    // a successful heal is not something to rate-limit against. Failed
    // heals leave lastHealAttempt at `now` and correctly cool down.
    lastHealAttempt = 0;
  } catch (e) {
    log(`Auto-heal failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    healInProgress = null;
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
  {
    name: "dispatch_task",
    description:
      "Create a typed task and dispatch to participants. participants accepts peer IDs or role names (live binding at dispatch time). Returns task_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const },
        participants: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Peer IDs or role names (live, resolved at dispatch).",
        },
        context_id: { type: "string" as const },
        text: { type: "string" as const },
        data: { type: "object" as const },
      },
      required: ["title", "participants"],
    },
  },
  {
    name: "send_task_event",
    description:
      "Emit a non-dispatch event on an existing task. intent: state_change|question|answer|complete|cancel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
        intent: {
          type: "string" as const,
          enum: ["state_change", "question", "answer", "complete", "cancel"],
        },
        text: { type: "string" as const },
        data: { type: "object" as const },
      },
      required: ["task_id", "intent"],
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
        // wait_ms=0 is the fast path — returns immediately with whatever
        // is queued. Critical for the check_messages tool: blocking here
        // for 30s would stall the MCP worker.
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
          id: myId,
          wait_ms: 0,
        });
        const messages: Message[] = result.events
          .filter((e) => e.type === "message")
          .map((e) => e.payload);
        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
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

    case "dispatch_task": {
      const rawArgs = args as Record<string, unknown>;
      const title = rawArgs?.title;
      const participants = rawArgs?.participants;
      if (typeof title !== "string" || title.trim() === "") {
        return {
          content: [{ type: "text" as const, text: "Invalid title. Must be a non-empty string." }],
          isError: true,
        };
      }
      if (!Array.isArray(participants) || participants.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Invalid participants. Must be a non-empty array of peer IDs or role names." }],
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
        const result = await brokerFetch<{
          task_id: string;
          participants: string[];
          event_id: number;
        }>("/dispatch-task", {
          from_id: myId,
          title,
          participants,
          context_id: rawArgs?.context_id,
          text: rawArgs?.text,
          data: rawArgs?.data,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Dispatched ${result.task_id} to ${result.participants.length} participant(s): ${result.participants.join(", ")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Failed to dispatch: ${e instanceof Error ? e.message : String(e)}` },
          ],
          isError: true,
        };
      }
    }

    case "send_task_event": {
      const rawArgs = args as Record<string, unknown>;
      const task_id = rawArgs?.task_id;
      const intent = rawArgs?.intent;
      if (typeof task_id !== "string" || task_id.trim() === "") {
        return {
          content: [{ type: "text" as const, text: "Invalid task_id." }],
          isError: true,
        };
      }
      if (typeof intent !== "string") {
        return {
          content: [{ type: "text" as const, text: "Invalid intent." }],
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
        const result = await brokerFetch<{ event_id: number }>("/send-task-event", {
          from_id: myId,
          task_id,
          intent,
          text: rawArgs?.text,
          data: rawArgs?.data,
        });
        return {
          content: [
            { type: "text" as const, text: `Event ${result.event_id} sent on ${task_id}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Failed to send task event: ${e instanceof Error ? e.message : String(e)}` },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Long-poll driver ---
//
// pollAndPushMessages blocks on the broker for up to POLL_WAIT_MS via
// /poll-messages' wait_ms param; the broker resolves the Promise
// immediately when a message arrives for this peer. On timeout, the
// broker returns an empty batch and the driver loop immediately
// reconnects. On transient error (broker temporarily down), we back
// off briefly before retrying — self-heal inside brokerFetch handles
// the restart.

let pollLoopActive = true;

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>(
      "/poll-messages",
      { id: myId, wait_ms: POLL_WAIT_MS },
      { timeoutMs: POLL_HTTP_TIMEOUT_MS }
    );

    for (const event of result.events) {
      if (event.type === "message") {
        const msg: Message = event.payload as Message;

        // Look up the sender's info for channel envelope meta
        let fromSummary = "";
        let fromCwd = "";
        let fromRole: string | null = null;
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
            fromRole = sender.role;
          }
        } catch {
          // Non-critical, proceed without sender info
        }

        const peerName = fromRole ?? msg.from_id;
        // Normalize literal-escaped "\n" sequences (two chars) into real
        // newlines so paragraph breaks render on the receiver.
        const normalizedText = msg.text.replace(/\\n/g, "\n");
        const formattedContent = `claude peers (${peerName}) -> ${normalizedText}`;

        // meta is Record<string, string>; a null value silently drops the whole notification on the receiver. New string-valued keys are fine — they render as <channel> tag attributes.
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: formattedContent,
            meta: {
              from_id: msg.from_id,
              from_summary: fromSummary,
              from_cwd: fromCwd,
              sent_at: msg.sent_at,
            },
          },
        });

        log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      } else if (event.type === "task_event") {
        // Slice 4: typed event notification. Thin envelope per D8 — no
        // from_summary/from_cwd. Receiver can Read the task file or call
        // list_peers if they want more context.
        //
        // Slice 5: respect the broker's shouldPush decision. push=false
        // means the event was delivered (included in the poll batch,
        // cursor advanced) but should not fire a channel notification —
        // it's audit-in-state-only. Absence of the field is treated as
        // push=true for backwards-compat with slice-4 producers.
        const te = event.payload as {
          id: number;
          task_id: string;
          intent: string;
          from_id: string;
          text: string | null;
          data: string | null;
          sent_at: string;
        };
        if (event.push === false) {
          log(`Suppressed task_event ${te.id} (${te.intent}) on ${te.task_id} — shouldPush=false`);
          continue;
        }
        const preview = te.text ? te.text.slice(0, 80) : "";
        const content = `[task ${te.task_id}] ${te.intent} from ${te.from_id}${preview ? ": " + preview : ""}`;

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              from_id: te.from_id,
              task_id: te.task_id,
              intent: te.intent,
              sent_at: te.sent_at,
            },
          },
        });

        log(`Pushed task_event ${te.id} (${te.intent}) on ${te.task_id}`);
      }
      // Unknown types silently ignored (forward-compat).
    }
  } catch (e) {
    // Broker might be down temporarily — brokerFetch's self-heal already
    // fired. Back off briefly before the driver loop retries so we don't
    // spin in a tight error loop if heal failed permanently.
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
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

  // Auto-summary is fully non-blocking — the summaryPromise.then(...) block
  // further down applies the summary via /set-summary when it resolves.

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

  // Always schedule the late-apply. The outer `if (!initialSummary)` guard
  // we previously had here silently dropped the summary in the race where
  // summaryPromise resolved DURING the /register await: initialSummary
  // mutates via closure, the guard then flips false, and the .then never
  // runs — broker stays empty. The inner check below is already idempotent
  // (no-op when summary never produced a value), so scheduling
  // unconditionally costs at most one redundant /set-summary in the
  // "resolved before register" case.
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

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start the long-poll driver loop. Each call blocks on the broker for
  //    up to POLL_WAIT_MS, resolving immediately when a message arrives.
  //    On return (events, timeout, or transient error-with-backoff) the
  //    loop re-enters pollAndPushMessages. Fire-and-forget — cleanup
  //    flips pollLoopActive to false and awaits /unregister to unblock
  //    the currently-in-flight poll.
  (async () => {
    while (pollLoopActive) {
      await pollAndPushMessages();
    }
  })();

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

  // 8. Clean up on exit.
  //
  // Ordering matters: flip pollLoopActive=false BEFORE /unregister. The
  // /unregister call causes the broker to cancelWaiter on our behalf,
  // which resolves the in-flight /poll-messages with an empty batch,
  // which returns control to the driver loop, which checks the flag and
  // exits. Without this ordering, process.exit(0) would race the still-
  // blocked 30s long-poll; with it, the shutdown is near-instant.
  const cleanup = async () => {
    pollLoopActive = false;
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
