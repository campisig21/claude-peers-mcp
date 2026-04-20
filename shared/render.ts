// Markdown renderer for task audit files.
//
// renderTaskFile is a PURE FUNCTION of DB state (task row + participants +
// events). This is the critical invariant locked in by F5 — slice 7's replay
// CLI must be able to regenerate any file from the DB alone. No filesystem,
// no timestamps from wall clock, no role lookups outside the explicit input.
//
// The broker composes its runtime fs writes from the same functions: initial
// file creation on dispatch, per-event appends on send_task_event. Writing
// those paths on top of renderTaskFile's event-render helpers keeps the two
// paths in lockstep — a mismatch between runtime writes and replay output
// would surface as "replay changes the file after a restart", which is a
// violation of append-only semantics.

import type { Task, TaskParticipant, TaskEvent } from "./types.ts";

// Caller-supplied lookup: peer_id → role, for the participants header and
// per-event actor annotation. Passed in (not queried inside render) so the
// renderer stays pure. The broker builds this map from its live peers table
// at render time; slice-7 replay builds it from the snapshot at each event's
// sent_at (future work) or from the current peers table as a simplification.
export type PeerRoleLookup = (peer_id: string) => string | null;

function isoToHms(iso: string): string {
  // Extract HH:MM:SS from an ISO-8601 timestamp. Defensive against non-ISO
  // inputs: if the slice doesn't match, return the original string so the
  // user sees something rather than an empty cell.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

function labelPeer(peer_id: string, roleLookup: PeerRoleLookup): string {
  const role = roleLookup(peer_id);
  return role ? `${peer_id} (${role})` : peer_id;
}

function formatDataLine(data: string | null): string {
  if (!data) return "";
  // Attempt to re-serialize compactly. If the stored JSON is invalid, keep the
  // raw string — better to render something imperfect than fail the write.
  try {
    return `\ndata: ${JSON.stringify(JSON.parse(data))}`;
  } catch {
    return `\ndata: ${data}`;
  }
}

// Render a single task_event as a "### ..." block. Does not include a
// leading newline; callers control spacing.
export function renderTaskEvent(
  event: TaskEvent,
  participants: TaskParticipant[],
  roleLookup: PeerRoleLookup
): string {
  const ts = isoToHms(event.sent_at);
  const actor = labelPeer(event.from_id, roleLookup);
  let header: string;

  switch (event.intent) {
    case "dispatch": {
      const others = participants
        .filter((p) => p.peer_id !== event.from_id)
        .map((p) => labelPeer(p.peer_id, roleLookup))
        .join(", ");
      header = `### ${ts} — dispatch (${actor} → ${others})`;
      break;
    }
    case "state_change": {
      let parsed: { to?: unknown } | null = null;
      try { parsed = event.data ? JSON.parse(event.data) : null; } catch { parsed = null; }
      const to = typeof parsed?.to === "string" ? parsed.to : "?";
      header = `### ${ts} — state_change (${actor}: ${to})`;
      break;
    }
    case "question": {
      let parsed: { to?: unknown } | null = null;
      try { parsed = event.data ? JSON.parse(event.data) : null; } catch { parsed = null; }
      const target = typeof parsed?.to === "string"
        ? ` → ${labelPeer(parsed.to, roleLookup)}`
        : "";
      header = `### ${ts} — question (${actor}${target})`;
      break;
    }
    case "answer": {
      let parsed: { reply_to_from?: unknown } | null = null;
      try { parsed = event.data ? JSON.parse(event.data) : null; } catch { parsed = null; }
      const target = typeof parsed?.reply_to_from === "string"
        ? ` → ${labelPeer(parsed.reply_to_from, roleLookup)}`
        : "";
      header = `### ${ts} — answer (${actor}${target})`;
      break;
    }
    case "complete":
      header = `### ${ts} — complete (${actor})`;
      break;
    case "cancel":
      header = `### ${ts} — cancel (${actor})`;
      break;
  }

  const body = event.text ? `\n${event.text}` : "";
  const dataLine = formatDataLine(event.data);
  return `${header}${body}${dataLine}`;
}

// Render the full task file from task + participants + events. Pure function.
export function renderTaskFile(
  task: Task,
  participants: TaskParticipant[],
  events: TaskEvent[],
  roleLookup: PeerRoleLookup = () => null
): string {
  const createdTs = isoToHms(task.created_at);
  const dispatcher = participants.find((p) => p.role_at_join === "dispatcher");
  const dispatcherLabel = dispatcher
    ? labelPeer(dispatcher.peer_id, roleLookup)
    : labelPeer(task.created_by, roleLookup);
  const participantsLine = participants
    .map((p) => labelPeer(p.peer_id, roleLookup))
    .join(", ");
  const contextLine = task.context_id ? `\n- context: ${task.context_id}` : "";

  // Header. state comes from task.state at render time — on initial dispatch
  // writes that's always 'open'. Slice 7 replay will reflect the current
  // terminal state accurately.
  const header = [
    `# ${task.id}${task.title ? ` — ${task.title}` : ""}`,
    `${contextLine}`.trimStart(),
    `- state: ${task.state}  (as of ${task.created_at} — append-only; run \`bun cli.ts replay ${task.id}\` to refresh)`,
    `- created: ${task.created_at} by ${dispatcherLabel}`,
    `- participants: ${participantsLine}`,
    "",
    "## Events",
    "",
  ].filter((l) => l !== undefined).join("\n");

  const eventBlocks = events.map((e) => renderTaskEvent(e, participants, roleLookup)).join("\n\n");

  return `${header}${eventBlocks}\n`;
}
