// Task ID format: 'T-<n>' where n is a positive integer. Opaque to consumers
// but parseable here for sequence generation and deterministic ordering in
// test assertions. Chosen over UUID for human-readability — "T-34" is easy
// to say aloud; "550e8400-…" is not.

export const TASK_ID_PATTERN = /^T-(\d+)$/;

export function formatTaskId(n: number): string {
  return `T-${n}`;
}

export function parseTaskId(id: string): number | null {
  const m = TASK_ID_PATTERN.exec(id);
  return m ? parseInt(m[1]!, 10) : null;
}
