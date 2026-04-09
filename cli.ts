#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts kill-broker     — Stop the broker daemon
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
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts kill-broker     Stop the broker daemon`);
}
