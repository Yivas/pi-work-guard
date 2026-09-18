import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  decide,
  fingerprint,
  formatFollowUp,
  formatNotice,
  hasInProgress,
  normalizeConfig,
  openItems,
  systemPromptBlock,
  type DecisionInput,
  type TodoItem,
  type TodoStatus,
} from "../src/guard.ts";

function task(id: number, status: TodoStatus, subject = `Task ${id}`): TodoItem {
  return { id, subject, status };
}

const OPEN_TASKS = [task(1, "in_progress", "Fix parser"), task(2, "pending", "Write docs")];

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    config: { ...DEFAULT_CONFIG },
    openItems: OPEN_TASKS,
    sessionOpenItems: OPEN_TASKS,
    stepsSinceLastTodoUpdate: 0,
    trigger: "stale-check",
    hasActiveGoal: false,
    forcedTurnsForFingerprint: 0,
    notifiedFingerprint: null,
    ...overrides,
  };
}

test("normalizeConfig falls back to defaults on junk input", () => {
  const expected = { ...DEFAULT_CONFIG };

  assert.deepEqual(normalizeConfig(null), expected);
  assert.deepEqual(normalizeConfig(undefined), expected);
  assert.deepEqual(normalizeConfig({}), expected);
  assert.deepEqual(normalizeConfig("nonsense"), expected);
  assert.deepEqual(normalizeConfig(7), expected);
  assert.deepEqual(normalizeConfig([1, 2]), expected);
});

test("normalizeConfig drops fields of the wrong type or unusable numbers", () => {
  const expected = { ...DEFAULT_CONFIG };

  assert.deepEqual(
    normalizeConfig({
      enabled: "true",
      staleSteps: "12",
      maxForcedTurns: false,
      noticeOnSessionStart: 1,
      systemPromptNotice: null,
    }),
    expected,
  );
  assert.deepEqual(normalizeConfig({ staleSteps: -1, maxForcedTurns: -5 }), expected);
  assert.deepEqual(
    normalizeConfig({ staleSteps: Number.NaN, maxForcedTurns: Number.POSITIVE_INFINITY }),
    expected,
  );
  assert.deepEqual(normalizeConfig({ staleSteps: Number.NEGATIVE_INFINITY }), expected);
});

test("normalizeConfig keeps valid fields and ignores unknown ones", () => {
  const merged = normalizeConfig({ staleSteps: 0, maxForcedTurns: 9, systemPromptNotice: false });
  assert.deepEqual(merged, {
    enabled: true,
    staleSteps: 0,
    maxForcedTurns: 9,
    noticeOnSessionStart: true,
    systemPromptNotice: false,
  });

  const withUnknown = normalizeConfig({ enabled: false, legacyKnob: 42, staleSteps: 5 });
  assert.deepEqual(Object.keys(withUnknown).sort(), [
    "enabled",
    "maxForcedTurns",
    "noticeOnSessionStart",
    "staleSteps",
    "systemPromptNotice",
  ]);
  assert.equal(withUnknown.enabled, false);
  assert.equal(withUnknown.staleSteps, 5);
});

test("openItems keeps pending and in_progress in input order", () => {
  const items = [
    task(3, "completed"),
    task(1, "pending"),
    task(4, "deleted"),
    task(2, "in_progress"),
  ];

  const open = openItems(items);
  assert.deepEqual(
    open.map((item) => item.id),
    [1, 2],
  );
  // The caller's list must survive untouched.
  assert.equal(items.length, 4);
  assert.equal(items[0].status, "completed");
});

test("hasInProgress only reacts to in_progress", () => {
  assert.equal(hasInProgress([task(1, "in_progress")]), true);
  assert.equal(hasInProgress([task(1, "pending"), task(2, "completed")]), false);
  assert.equal(hasInProgress([]), false);
});

test("fingerprint is stable and ignores input order", () => {
  assert.equal(fingerprint([]), "");
  assert.equal(
    fingerprint([task(1, "pending"), task(2, "in_progress")]),
    "1:pending,2:in_progress",
  );
  assert.equal(
    fingerprint([task(2, "in_progress"), task(1, "pending")]),
    fingerprint([task(1, "pending"), task(2, "in_progress")]),
  );
  assert.equal(fingerprint([task(1, "pending")]), fingerprint([task(1, "pending")]));
});

test("fingerprint changes when an item status changes", () => {
  assert.notEqual(fingerprint([task(1, "pending")]), fingerprint([task(1, "in_progress")]));
});

test("systemPromptBlock stays empty when the guard is off or nothing is open", () => {
  assert.equal(systemPromptBlock(OPEN_TASKS, { ...DEFAULT_CONFIG, enabled: false }), "");
  assert.equal(systemPromptBlock(OPEN_TASKS, { ...DEFAULT_CONFIG, systemPromptNotice: false }), "");
  assert.equal(systemPromptBlock([task(1, "completed")], DEFAULT_CONFIG), "");
});

test("systemPromptBlock lists the open items with id, status and subject", () => {
  const block = systemPromptBlock(OPEN_TASKS, DEFAULT_CONFIG);

  assert.ok(block.includes("#1 [in_progress] Fix parser"), block);
  assert.ok(block.includes("#2 [pending] Write docs"), block);
  assert.ok(block.includes("task list"), block);
});

test("systemPromptBlock is byte-identical for identical input", () => {
  const first = systemPromptBlock(OPEN_TASKS, DEFAULT_CONFIG);
  const second = systemPromptBlock(OPEN_TASKS, DEFAULT_CONFIG);

  assert.equal(first, second);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
});

test("systemPromptBlock caps its length and summarises the rest", () => {
  const many = Array.from({ length: 20 }, (_, index) => task(index + 1, "pending"));
  const block = systemPromptBlock(many, DEFAULT_CONFIG);
  const lines = block.split("\n");

  assert.ok(lines.length <= 8, `expected at most 8 lines, got ${lines.length}`);
  assert.ok(block.includes("(and 15 more)"), block);
  assert.ok(!block.includes("#6 "), block);
});

test("formatNotice names the trigger reason and the open items", () => {
  const stale = formatNotice(OPEN_TASKS, "stale");
  assert.ok(stale.includes("not been updated for several steps"), stale);
  assert.ok(stale.includes("#1 [in_progress] Fix parser"), stale);

  const sessionStart = formatNotice(OPEN_TASKS, "session-start");
  assert.ok(sessionStart.includes("inherited from a previous one"), sessionStart);

  const compaction = formatNotice(OPEN_TASKS, "compaction");
  assert.ok(compaction.includes("compacted"), compaction);
});

test("formatNotice honours the listing limit", () => {
  const many = [task(1, "pending"), task(2, "pending"), task(3, "pending")];
  const notice = formatNotice(many, "stale", 2);

  assert.ok(notice.includes("#1 [pending] Task 1"), notice);
  assert.ok(notice.includes("#2 [pending] Task 2"), notice);
  assert.ok(!notice.includes("Task 3"), notice);
  assert.ok(notice.includes("(and 1 more)"), notice);
});

test("formatNotice truncates long subjects and keeps one item per line", () => {
  const messy = task(9, "pending", `  line one\nline two ${"y".repeat(200)}  `);
  const notice = formatNotice([messy], "stale");
  const itemLine = notice.split("\n").find((line) => line.startsWith("- #9 "));

  assert.ok(itemLine, notice);
  const rendered = itemLine.slice("- #9 [pending] ".length);
  assert.equal(rendered.length, 120, rendered);
  assert.ok(rendered.startsWith("line one line two y"), rendered);
  assert.ok(rendered.endsWith("..."), rendered);
});

test("formatFollowUp asks for a decision and states the suppression", () => {
  const followUp = formatFollowUp(OPEN_TASKS, 3);

  assert.ok(followUp.includes("continue"), followUp);
  assert.ok(followUp.includes("executed evidence"), followUp);
  assert.ok(followUp.includes("handoff"), followUp);
  assert.ok(followUp.includes("suppressed after 3 forced turns"), followUp);
  assert.ok(followUp.includes("#1 [in_progress] Fix parser"), followUp);
});

test("decide reports disabled first, even with open items and a firing trigger", () => {
  const disabled = { ...DEFAULT_CONFIG, enabled: false };

  assert.deepEqual(decide(input({ config: disabled, trigger: "compaction" })), {
    kind: "none",
    reason: "disabled",
  });
  assert.deepEqual(decide(input({ config: disabled, openItems: [], trigger: "stale-check" })), {
    kind: "none",
    reason: "disabled",
  });
});

test("decide reports no-open-items before any trigger handling", () => {
  assert.deepEqual(decide(input({ openItems: [], stepsSinceLastTodoUpdate: 99 })), {
    kind: "none",
    reason: "no-open-items",
  });
  assert.deepEqual(
    decide(input({ openItems: [], sessionOpenItems: OPEN_TASKS, trigger: "agent-settled" })),
    { kind: "none", reason: "no-open-items" },
  );
});

test("decide notices on session start unless that notice is disabled", () => {
  const on = decide(input({ trigger: "session-start" }));
  assert.equal(on.kind, "notice");
  assert.equal(on.kind === "notice" ? on.trigger : "", "session-start");

  const off = decide(
    input({ trigger: "session-start", config: { ...DEFAULT_CONFIG, noticeOnSessionStart: false } }),
  );
  assert.deepEqual(off, { kind: "none", reason: "session-start-notice-disabled" });
});

test("decide notices on compaction regardless of the session-start flag or an active goal", () => {
  const compacted = decide(
    input({
      trigger: "compaction",
      hasActiveGoal: true,
      config: { ...DEFAULT_CONFIG, noticeOnSessionStart: false },
    }),
  );

  assert.equal(compacted.kind, "notice");
  assert.equal(compacted.kind === "notice" ? compacted.trigger : "", "compaction");
  assert.ok(compacted.kind === "notice" && compacted.message.includes("#1 [in_progress]"));
});

test("decide stays quiet on a fresh list", () => {
  const decision = decide(
    input({ stepsSinceLastTodoUpdate: DEFAULT_CONFIG.staleSteps - 1, notifiedFingerprint: null }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "fresh" });
});

test("decide notices once the list is stale and the fingerprint was not notified", () => {
  const decision = decide(
    input({ stepsSinceLastTodoUpdate: DEFAULT_CONFIG.staleSteps, notifiedFingerprint: null }),
  );

  assert.equal(decision.kind, "notice");
  assert.equal(decision.kind === "notice" ? decision.trigger : "", "stale");
  assert.ok(decision.kind === "notice" && decision.message.includes("#2 [pending] Write docs"));
});

test("decide skips a stale list already notified for the same fingerprint", () => {
  const decision = decide(
    input({
      stepsSinceLastTodoUpdate: 40,
      notifiedFingerprint: fingerprint(OPEN_TASKS),
    }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "already-notified" });
});

test("decide treats freshness as stricter than the notified fingerprint", () => {
  // Same fingerprint as the last notice, but the counter was reset: report fresh, not notified.
  const decision = decide(
    input({ stepsSinceLastTodoUpdate: 0, notifiedFingerprint: fingerprint(OPEN_TASKS) }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "fresh" });
});

test("decide notices again when the list changed after a notice", () => {
  const decision = decide(
    input({
      stepsSinceLastTodoUpdate: 40,
      notifiedFingerprint: fingerprint([task(1, "pending")]),
      openItems: OPEN_TASKS,
    }),
  );

  assert.equal(decision.kind, "notice");
});

test("decide suppresses force while a goal is active", () => {
  const decision = decide(input({ trigger: "agent-settled", hasActiveGoal: true }));

  assert.deepEqual(decision, { kind: "none", reason: "goal-active" });
});

test("decide forces only when the current session still has work in progress", () => {
  const decision = decide(
    input({
      trigger: "agent-settled",
      sessionOpenItems: [task(1, "pending"), task(2, "pending")],
      openItems: OPEN_TASKS,
    }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "nothing-in-progress" });
});

test("decide forces a follow-up below the forced turn limit", () => {
  const decision = decide(
    input({
      trigger: "agent-settled",
      forcedTurnsForFingerprint: DEFAULT_CONFIG.maxForcedTurns - 1,
    }),
  );

  assert.equal(decision.kind, "force");
  assert.ok(decision.kind === "force" && decision.message.includes("suppressed after 3"));
});

test("decide stops forcing at the forced turn limit", () => {
  const decision = decide(
    input({
      trigger: "agent-settled",
      forcedTurnsForFingerprint: DEFAULT_CONFIG.maxForcedTurns,
    }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "forced-turn-limit" });
});

test("decide reads in_progress from the session items, not from the inherited ones", () => {
  const inherited = task(7, "in_progress", "Inherited work");
  const sessionItems = [task(8, "pending", "New work")];

  const decision = decide(
    input({
      trigger: "agent-settled",
      openItems: [...sessionItems, inherited],
      sessionOpenItems: sessionItems,
    }),
  );

  assert.deepEqual(decision, { kind: "none", reason: "nothing-in-progress" });
});
