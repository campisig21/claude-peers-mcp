// Push-policy filter for typed events.
//
// Delivery (all non-sender participants receive every event via their
// cursor) and push (MCP channel notification that interrupts the session)
// are separate concerns in the claude-peers model. shouldPush decides the
// push dimension — an event that returns false here is still delivered to
// the receiver's poll batch with `push: false`, so its MCP-server side
// consumer knows to log-and-skip rather than fire a notification.
//
// The five rules apply in order — first match wins. The reasoning behind
// each rule lives in docs/a2a-lite.md §Push Policy; the ordering matters
// especially for rule 1 (observer) which wins over rule 4 (targeted
// question): an observer targeted by a question still gets no push.
//
// Rule 2 (sender) is defense-in-depth — slice-4 delivery already excludes
// the sender at the SQL + Map level, so the sender branch here is never
// reached in the current wiring. Keeping the check makes the invariant
// robust against future refactors that remove the delivery-layer exclusion.

import type { TaskEvent, TaskParticipant } from "./types.ts";

export function shouldPush(event: TaskEvent, receiver: TaskParticipant): boolean {
  if (receiver.role_at_join === "observer") return false;
  if (receiver.peer_id === event.from_id) return false;

  // data is stored as a JSON string on the event row; parse lazily for the
  // rules that need it. A malformed or absent data field is treated as
  // "no targeting hint" — the event pushes by default.
  let data: Record<string, unknown> | null = null;
  if (event.data) {
    try { data = JSON.parse(event.data); } catch { data = null; }
  }

  if (event.intent === "state_change" && data?.to === "working") return false;
  if (event.intent === "question" && typeof data?.to === "string" && data.to !== receiver.peer_id) return false;
  if (event.intent === "answer" && data?.reply_to_from !== receiver.peer_id) return false;

  return true;
}
