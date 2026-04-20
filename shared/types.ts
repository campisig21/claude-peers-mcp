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
