// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  role: string | null;
  status: "active" | "dead";
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// Transport-agnostic event envelope. Used by long-poll (Slice 2) and
// will be shared with SSE (Slice 6). Slice 2 only emits type: "message";
// Slice 4 will add type: "task_event" with payload: TaskEvent.
export type EventType = "message" | "task_event";

export interface Event<P = unknown> {
  event_id: number;
  type: EventType;
  payload: P;
  // Slice 5: whether the receiving MCP server should fire a channel
  // notification (interrupt the session) or include-in-state-only.
  // Absence == true (backwards-compat for slice-4 producers; slice-5+
  // always sets it explicitly). See shared/push-policy.ts for the rules.
  push?: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  // Optional role claim. When set, the broker will reuse the peer ID previously
  // bound to this role (if the prior holder is dead) or reject if a live peer
  // currently holds it. Typically set from the CLAUDE_PEER_ROLE env var.
  role?: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetRoleRequest {
  id: PeerId;
  role: string | null; // null releases the current role
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
  // Max milliseconds to long-poll before returning an empty batch.
  // Default 30_000. Value 0 = fast path (return immediately).
  // Values exceeding broker's MAX_WAIT_MS return HTTP 400.
  wait_ms?: number;
  // Replay mode: return events with id > since_id regardless of the
  // `delivered` flag. Read-only — does NOT mark events delivered.
  // When undefined, existing semantics apply (undelivered only, marked on return).
  since_id?: number;
}

export interface PollMessagesResponse {
  events: Event<Message>[];
  // Max event_id in this batch, or null if empty. Caller may use this
  // as the since_id for a subsequent replay poll.
  next_cursor: number | null;
}

// --- A2A-lite types (Slice 3) ---
//
// These mirror the DB schema introduced in broker.ts's slice-3 DDL. No code
// consumes them yet — they exist so Slice 4's handlers and any future CLI
// audit view can type-check against a single source of truth.

export type TaskState = "open" | "waiting" | "done" | "failed";

export type TaskIntent =
  | "dispatch"
  | "state_change"
  | "question"
  | "answer"
  | "complete"
  | "cancel";

export type RoleAtJoin =
  | "dispatcher"
  | "assignee"
  | "reviewer"
  | "collaborator"
  | "observer";

export interface Task {
  id: string;
  context_id: string | null;
  state: TaskState;
  title: string | null;
  created_at: string; // ISO timestamp
  created_by: PeerId;
}

export interface TaskParticipant {
  task_id: string;
  peer_id: PeerId;
  role_at_join: RoleAtJoin | null;
  joined_at: string; // ISO timestamp
}

export interface TaskEvent {
  id: number;
  task_id: string;
  from_id: PeerId;
  intent: TaskIntent;
  text: string | null;
  // Serialized JSON. Application layer parses via JSON.parse. Column is
  // TEXT in SQLite; typed as `string | null` here rather than `unknown`
  // so the serialization boundary is explicit in the type system.
  data: string | null;
  sent_at: string; // ISO timestamp
}

export interface TaskEventCursor {
  peer_id: PeerId;
  last_event_id: number;
}

// --- A2A-lite wire types (Slice 4) ---

export interface DispatchTaskRequest {
  from_id: PeerId;
  title: string;
  participants: string[]; // peer_ids OR role names
  // Slice 5: optional overlay — resolved peer_ids in this array get
  // role_at_join='observer' in task_participants. They receive delivery
  // but never push (rule 1 in shouldPush). Dispatchers cannot observe
  // their own tasks — if from_id appears here, the 'dispatcher' role wins.
  observers?: string[];
  context_id?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface DispatchTaskResponse {
  task_id: string;
  participants: PeerId[];
  event_id: number;
}

export interface SendTaskEventRequest {
  from_id: PeerId;
  task_id: string;
  intent: "state_change" | "question" | "answer" | "complete" | "cancel";
  text?: string;
  data?: Record<string, unknown>;
}

export interface SendTaskEventResponse {
  event_id: number;
}

// Shape of a row from the `audit_stream` view. Discriminated union by
// `source`: 'message' rows always have `task_id === null` and `data === null`;
// 'task_event' rows always have `to_id === null`.
export type AuditStreamRow =
  | {
      source: "message";
      source_id: number;
      from_id: PeerId;
      to_id: PeerId;
      sent_at: string;
      intent: "text";
      task_id: null;
      body: string;
      data: null;
    }
  | {
      source: "task_event";
      source_id: number;
      from_id: PeerId;
      to_id: null;
      sent_at: string;
      intent: TaskIntent;
      task_id: string;
      body: string | null;
      data: string | null;
    };
