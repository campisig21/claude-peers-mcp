#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status            — Show broker status and all peers
 *   bun cli.ts peers             — List all peers
 *   bun cli.ts messages [id|all] — Show message history
 *   bun cli.ts send <id> <msg>   — Send a message to a peer
 *   bun cli.ts kill-broker       — Stop the broker daemon
 */

import { Database } from "bun:sqlite";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
            role: string | null;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          const roleTag = p.role ? `  [${p.role}]` : "";
          console.log(`  ${p.id}${roleTag}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
          role: string | null;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const roleTag = p.role ? `  [${p.role}]` : "";
          const parts = [`${p.id}${roleTag}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "send-by-role": {
    const role = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!role || !msg) {
      console.error("Usage: bun cli.ts send-by-role <role> <message>");
      console.error("       The role may be bare ('auditor') or namespaced ('multi-agent/auditor').");
      process.exit(1);
    }
    const fromId = process.env.CLAUDE_PEERS_FROM_ID || "cli";
    try {
      const peers = await brokerFetch<Array<{ id: string; role: string | null }>>(
        "/list-peers",
        { scope: "machine", cwd: "/", git_root: null }
      );
      // Exact match first; if none, try suffix match for project-scoped roles
      // so `send-by-role auditor` resolves `multi-agent/auditor`. Warn on ambiguity.
      const exact = peers.filter((p) => p.role === role);
      const suffix = exact.length > 0
        ? exact
        : peers.filter((p) => p.role?.endsWith(`/${role}`));
      if (suffix.length === 0) {
        console.error(`No active peer holds role '${role}'.`);
        process.exit(2);
      }
      if (suffix.length > 1) {
        console.error(
          `Ambiguous: multiple peers hold a role matching '${role}':\n  ` +
          suffix.map((p) => `${p.id} (${p.role})`).join("\n  ") +
          "\nUse the fully-qualified role name (e.g. 'multi-agent/auditor')."
        );
        process.exit(3);
      }
      const target = suffix[0]!;
      const result = await brokerFetch<{ ok: boolean; error?: string }>(
        "/send-message",
        { from_id: fromId, to_id: target.id, text: msg }
      );
      if (result.ok) {
        console.log(`Message sent to ${target.id} (role: ${target.role})`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(4);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(5);
    }
    break;
  }

  case "roles": {
    // Read the persisted DB directly — works even if the broker is dead,
    // which is the whole point of a forensic inspect command. The broker is
    // the single writer (WAL mode in broker.ts:33), so concurrent readers
    // are safe.
    if (!(await Bun.file(DB_PATH).exists())) {
      console.log(`No persisted peers database at ${DB_PATH}`);
      break;
    }

    const db = new Database(DB_PATH, { readonly: true });
    try {
      // Guard against pre-migration schemas. The broker adds `role` and
      // `status` columns on startup (broker.ts:54-64), but this CLI opens
      // the file read-only and can't run that migration itself. If the
      // broker hasn't started since the migration landed, there are no
      // role bindings by definition — report and exit.
      const cols = new Set(
        (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!cols.has("role") || !cols.has("status")) {
        console.log("No role bindings persisted (DB predates the role column — start the broker to migrate).");
        break;
      }

      const rows = db.query(`
        SELECT id, role, status, pid, cwd, summary, last_seen
        FROM peers
        WHERE role IS NOT NULL
        ORDER BY
          CASE status WHEN 'active' THEN 0 ELSE 1 END,
          last_seen DESC
      `).all() as Array<{
        id: string;
        role: string;
        status: "active" | "dead";
        pid: number;
        cwd: string;
        summary: string;
        last_seen: string;
      }>;

      if (rows.length === 0) {
        console.log("No role bindings persisted.");
        break;
      }

      // Mirror the broker's revive lookup (broker.ts:278): the most-recent
      // dead row per role wins on reclaim. Compute which row that is for
      // each role so we can mark it in the output.
      const nextRevive = new Map<string, string>();
      for (const r of rows) {
        if (r.status === "dead" && !nextRevive.has(r.role)) {
          nextRevive.set(r.role, r.id);
        }
      }

      const active = rows.filter((r) => r.status === "active");
      const dead = rows.filter((r) => r.status === "dead");

      if (active.length > 0) {
        console.log("Active role bindings:");
        for (const r of active) {
          console.log(`  ${r.role}  →  ${r.id}  PID:${r.pid}`);
          console.log(`         ${r.cwd}`);
          if (r.summary) console.log(`         ${r.summary}`);
        }
      }

      if (dead.length > 0) {
        if (active.length > 0) console.log();
        console.log("Dead role bindings (reclaimable via CLAUDE_PEER_ROLE=<role>):");
        for (const r of dead) {
          const marker = nextRevive.get(r.role) === r.id ? "  ← next revive target" : "";
          console.log(`  ${r.role}  →  ${r.id}${marker}`);
          console.log(`         Last seen: ${r.last_seen}`);
          console.log(`         ${r.cwd}`);
        }
      }
    } finally {
      db.close();
    }
    break;
  }

  case "messages": {
    if (!(await Bun.file(DB_PATH).exists())) {
      console.log(`No persisted peers database at ${DB_PATH}`);
      break;
    }

    const db = new Database(DB_PATH, { readonly: true });
    try {
      const cols = new Set(
        (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!cols.has("from_id") || !cols.has("to_id")) {
        console.log("No messages table found (DB predates messaging — start the broker to migrate).");
        break;
      }

      const peerArg = process.argv[3];
      const showAll = peerArg === "all";
      const peerId = peerArg && !showAll ? peerArg : null;
      const limit = showAll ? null : 50;

      // Build role lookup for display
      const peerCols = new Set(
        (db.query("PRAGMA table_info(peers)").all() as { name: string }[]).map((c) => c.name)
      );
      const roleMap = new Map<string, string>();
      if (peerCols.has("role")) {
        const peers = db.query("SELECT id, role FROM peers WHERE role IS NOT NULL").all() as {
          id: string;
          role: string;
        }[];
        for (const p of peers) roleMap.set(p.id, p.role);
      }

      let query: string;
      const params: string[] = [];
      if (peerId) {
        query = `SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY sent_at DESC`;
        params.push(peerId, peerId);
        if (limit) query += ` LIMIT ${limit}`;
      } else {
        query = `SELECT * FROM messages ORDER BY sent_at DESC`;
        if (limit) query += ` LIMIT ${limit}`;
      }

      const rows = db.query(query).all(...params) as Array<{
        id: number;
        from_id: string;
        to_id: string;
        text: string;
        sent_at: string;
        delivered: number;
      }>;

      if (rows.length === 0) {
        console.log(peerId ? `No messages involving peer '${peerId}'.` : "No messages.");
        break;
      }

      // Reverse so oldest-first for reading order
      rows.reverse();

      const label = (id: string) => {
        const role = roleMap.get(id);
        return role ? `${id} [${role}]` : id;
      };

      console.log(
        peerId
          ? `Messages involving ${label(peerId)} (${rows.length} shown):`
          : `Messages (${rows.length} shown${!showAll ? ", latest 50 — use 'all' for full history" : ""}):`
      );
      console.log();

      for (const m of rows) {
        const status = m.delivered ? "✓" : "•";
        const ts = m.sent_at.replace("T", " ").replace(/\.\d+Z$/, "Z");
        console.log(`  ${status} ${ts}  ${label(m.from_id)} → ${label(m.to_id)}`);
        const lines = m.text.split("\n");
        for (const line of lines) {
          console.log(`    ${line}`);
        }
        console.log();
      }
    } finally {
      db.close();
    }
    break;
  }

  case "tail": {
    // Live-tail the broker's SSE audit stream. Connects to /events/stream,
    // decodes each SSE frame, pretty-prints a one-liner per event. Exits
    // on stream close or SIGINT.
    try {
      const res = await fetch(`${BROKER_URL}/events/stream`);
      if (!res.ok || !res.body) {
        console.error(`Broker rejected tail: ${res.status}`);
        process.exit(1);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";

      const sigHandler = async () => {
        try { await reader.cancel(); } catch { /* already done */ }
        process.exit(0);
      };
      process.on("SIGINT", sigHandler);
      process.on("SIGTERM", sigHandler);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          idx = buf.indexOf("\n\n");

          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(5).trim());
            const ts = typeof parsed?.payload?.sent_at === "string"
              ? parsed.payload.sent_at.replace("T", " ").replace(/\.\d+Z$/, "Z")
              : "";
            if (parsed.type === "message") {
              const p = parsed.payload as { from_id: string; to_id: string; text: string };
              console.log(`${ts}  [message]    from ${p.from_id}  to ${p.to_id}  "${p.text}"`);
            } else if (parsed.type === "task_event") {
              const p = parsed.payload as {
                task_id: string;
                intent: string;
                from_id: string;
                text: string | null;
              };
              const textPart = p.text ? ` — ${p.text}` : "";
              console.log(`${ts}  [task_event] ${p.task_id} ${p.intent} from ${p.from_id}${textPart}`);
            } else {
              console.log(`${ts}  [${parsed.type}]  ${dataLine.slice(5).trim()}`);
            }
          } catch (e) {
            console.error(`[tail] frame parse error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers
  bun cli.ts roles           Show all persisted role bindings (active + dead)
  bun cli.ts messages        Show recent messages (last 50)
  bun cli.ts messages <id>   Messages to/from a specific peer
  bun cli.ts messages all    Show full message history
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts tail            Live-tail the broker's audit stream (SSE)
  bun cli.ts kill-broker     Stop the broker daemon`);
}
