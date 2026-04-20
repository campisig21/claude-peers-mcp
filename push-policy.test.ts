import { test, expect, describe } from "bun:test";
// Intentional import of a module that does not yet exist. Slice 5's Task 3a
// lands shared/push-policy.ts; these tests fail with a module-resolution
// error until then. This is the deliberate failing baseline.
import { shouldPush } from "./shared/push-policy.ts";
import type { TaskEvent, TaskParticipant } from "./shared/types.ts";

// Lightweight fixture builders. Only the fields shouldPush reads need to be
// well-formed; we leave timestamps and ids nominal since the function is
// pure and does not touch anything beyond intent/data/from_id/role_at_join.
function mkEvent(overrides: Partial<TaskEvent> & { intent: TaskEvent["intent"]; from_id: string }): TaskEvent {
  return {
    id: 1,
    task_id: "T-1",
    text: null,
    data: null,
    sent_at: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function mkParticipant(
  peer_id: string,
  role_at_join: TaskParticipant["role_at_join"] = null
): TaskParticipant {
  return {
    task_id: "T-1",
    peer_id,
    role_at_join,
    joined_at: "2026-04-20T00:00:00Z",
  };
}

describe("shouldPush (Slice 5 pure function)", () => {
  test("U1: observer rule — observer never receives push", () => {
    const event = mkEvent({ intent: "dispatch", from_id: "a" });
    const receiver = mkParticipant("b", "observer");
    expect(shouldPush(event, receiver)).toBe(false);
  });

  test("U2: sender rule — sender excluded even if delivery somehow reaches them", () => {
    const event = mkEvent({ intent: "complete", from_id: "a" });
    const receiver = mkParticipant("a", "dispatcher");
    expect(shouldPush(event, receiver)).toBe(false);
  });

  test("U3: state_change → working suppressed universally", () => {
    const event = mkEvent({
      intent: "state_change",
      from_id: "a",
      data: JSON.stringify({ to: "working" }),
    });
    const receiver = mkParticipant("b");
    expect(shouldPush(event, receiver)).toBe(false);
  });

  test("U3b: state_change → done NOT suppressed", () => {
    const event = mkEvent({
      intent: "state_change",
      from_id: "a",
      data: JSON.stringify({ to: "done" }),
    });
    const receiver = mkParticipant("b");
    expect(shouldPush(event, receiver)).toBe(true);
  });

  test("U4: targeted question — only named target receives push", () => {
    const event = mkEvent({
      intent: "question",
      from_id: "a",
      data: JSON.stringify({ to: "b" }),
    });
    expect(shouldPush(event, mkParticipant("b"))).toBe(true);
    expect(shouldPush(event, mkParticipant("c"))).toBe(false);
  });

  test("U4b: untargeted question — pushes to all non-sender participants", () => {
    const event = mkEvent({
      intent: "question",
      from_id: "a",
      text: "anyone?",
      data: null,
    });
    expect(shouldPush(event, mkParticipant("b"))).toBe(true);
    expect(shouldPush(event, mkParticipant("c"))).toBe(true);
  });

  test("U5: targeted answer — only original asker receives push", () => {
    const event = mkEvent({
      intent: "answer",
      from_id: "a",
      data: JSON.stringify({ reply_to_from: "b" }),
    });
    expect(shouldPush(event, mkParticipant("b"))).toBe(true);
    expect(shouldPush(event, mkParticipant("c"))).toBe(false);
  });

  test("U6: default — no rule matches, push = true", () => {
    const event = mkEvent({ intent: "complete", from_id: "a" });
    expect(shouldPush(event, mkParticipant("b"))).toBe(true);
  });

  test("U7: rule ordering — observer wins over targeted question", () => {
    // observer would normally be the target of a question; observer rule
    // must fire first so the observer still gets no push.
    const event = mkEvent({
      intent: "question",
      from_id: "a",
      data: JSON.stringify({ to: "b" }),
    });
    const observerB = mkParticipant("b", "observer");
    expect(shouldPush(event, observerB)).toBe(false);
  });
});
