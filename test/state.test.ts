import assert from "node:assert/strict";
import test from "node:test";

import {
  countStepsAfter,
  isGoalActive,
  lastRunAborted,
  parseTodoDetails,
  readTodoSnapshot,
  selectPreviousSessionFile,
  type SessionEntryLike,
} from "../src/state.ts";

const todoResult = (details: unknown): SessionEntryLike => ({
  type: "message",
  message: { role: "toolResult", toolName: "todo", details },
});

const assistantTurn = (): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
});

const assistantText = (): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
});

const userMessage = (): SessionEntryLike => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "Go on" }] },
});

/** One `goal-state` entry as pi-goal 0.55.3 appends it. */
const goalState = (goal: unknown): SessionEntryLike => ({
  type: "custom",
  customType: "goal-state",
  data: { goal },
});

test("parseTodoDetails reads the rpiv-todo shape", () => {
  const items = parseTodoDetails({
    action: "create",
    nextId: 3,
    tasks: [
      { id: 1, subject: "Ship the guard", status: "in_progress" },
      { id: 2, subject: "Write docs", status: "pending" },
    ],
  });

  assert.deepEqual(items, [
    { id: 1, subject: "Ship the guard", status: "in_progress" },
    { id: 2, subject: "Write docs", status: "pending" },
  ]);
});

test("parseTodoDetails reads the SDK example shape and maps done to completed", () => {
  const items = parseTodoDetails({
    todos: [
      { id: 7, text: "Old task", done: true },
      { id: 8, text: "New task", done: false },
    ],
  });

  assert.deepEqual(items, [
    { id: 7, subject: "Old task", status: "completed" },
    { id: 8, subject: "New task", status: "pending" },
  ]);
});

test("parseTodoDetails stays silent on unknown shapes and unreadable items", () => {
  assert.equal(parseTodoDetails(null), null);
  assert.equal(parseTodoDetails("tasks"), null);
  assert.equal(parseTodoDetails({ action: "list" }), null);
  // No recognised list key, or an item without a numeric id: silence, never an empty list.
  assert.equal(parseTodoDetails({ tasks: [{ subject: "no id", status: "pending" }] }), null);
  assert.equal(
    parseTodoDetails({ tasks: [{ id: 1, subject: "ok", status: "pending" }, "nonsense"] }),
    null,
  );
  assert.deepEqual(parseTodoDetails({ tasks: [{ id: 1, subject: "x", status: "weird" }] }), [
    { id: 1, subject: "x", status: "pending" },
  ]);
});

test("parseTodoDetails ignores a result that reports an error", () => {
  // rpiv-todo sends the unchanged tasks with `details.error` when a call fails.
  assert.equal(
    parseTodoDetails({ tasks: [{ id: 1, subject: "Kept", status: "pending" }], error: "#9 not" }),
    null,
  );
  assert.deepEqual(parseTodoDetails({ tasks: [], error: null }), []);
});

test("readTodoSnapshot keeps the last task list and its position", () => {
  const entries: SessionEntryLike[] = [
    assistantTurn(),
    todoResult({ tasks: [{ id: 1, subject: "First", status: "pending" }] }),
    assistantTurn(),
    assistantText(),
    todoResult({ tasks: [{ id: 1, subject: "First", status: "completed" }] }),
    assistantTurn(),
  ];

  const snapshot = readTodoSnapshot(entries);

  assert.deepEqual(snapshot.items, [{ id: 1, subject: "First", status: "completed" }]);
  assert.equal(snapshot.lastUpdateIndex, 4);
});

test("readTodoSnapshot reads the rpiv-todo-state custom entry when no tool result exists", () => {
  const entries: SessionEntryLike[] = [
    assistantTurn(),
    {
      type: "custom",
      customType: "rpiv-todo-state",
      data: { action: "update", tasks: [{ id: 4, subject: "Routed", status: "in_progress" }] },
    },
    assistantTurn(),
  ];

  const snapshot = readTodoSnapshot(entries);

  assert.deepEqual(snapshot.items, [{ id: 4, subject: "Routed", status: "in_progress" }]);
  assert.equal(snapshot.lastUpdateIndex, 1);
});

test("readTodoSnapshot does not count an errored call as a list update", () => {
  const entries: SessionEntryLike[] = [
    todoResult({ tasks: [{ id: 1, subject: "Kept", status: "in_progress" }] }),
    assistantTurn(),
    todoResult({
      tasks: [{ id: 1, subject: "Kept", status: "in_progress" }],
      error: "illegal transition in_progress → in_progress",
    }),
    assistantTurn(),
  ];

  const snapshot = readTodoSnapshot(entries);

  assert.deepEqual(snapshot.items, [{ id: 1, subject: "Kept", status: "in_progress" }]);
  // The step count still runs from the real update, two entries earlier.
  assert.equal(snapshot.lastUpdateIndex, 0);
  assert.equal(countStepsAfter(entries, snapshot.lastUpdateIndex), 2);
});

test("readTodoSnapshot keeps the previous list when an update cannot be read", () => {
  const entries: SessionEntryLike[] = [
    todoResult({ tasks: [{ id: 1, subject: "Kept", status: "pending" }] }),
    assistantTurn(),
    todoResult({ tasks: [{ subject: "no id", status: "pending" }] }),
  ];

  const snapshot = readTodoSnapshot(entries);

  assert.deepEqual(snapshot.items, [{ id: 1, subject: "Kept", status: "pending" }]);
  assert.equal(snapshot.lastUpdateIndex, 0);
});

test("readTodoSnapshot returns an empty list on a branch without a todo tool", () => {
  const snapshot = readTodoSnapshot([assistantTurn(), assistantText()]);

  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.lastUpdateIndex, -1);
});

test("countStepsAfter counts only assistant turns with tool calls", () => {
  const entries: SessionEntryLike[] = [
    todoResult({ tasks: [] }),
    assistantText(),
    assistantTurn(),
    { type: "custom", customType: "other", data: {} },
    assistantTurn(),
  ];

  assert.equal(countStepsAfter(entries, 0), 2);
  assert.equal(countStepsAfter(entries, -1), 0);
});

test("isGoalActive reads the real pi-goal payload", () => {
  assert.equal(isGoalActive([goalState({ status: "active" })]), true);
  assert.equal(isGoalActive([goalState({ status: "paused" })]), false);
  assert.equal(isGoalActive([goalState({ status: "blocked" })]), false);
  assert.equal(isGoalActive([goalState({ status: "usage_limited" })]), false);
  assert.equal(isGoalActive([goalState({ status: "budget_limited" })]), false);
  assert.equal(isGoalActive([goalState({ status: "complete" })]), false);
  assert.equal(isGoalActive([goalState(null)]), false);
  assert.equal(isGoalActive([]), false);
  assert.equal(isGoalActive([{ type: "custom", customType: "unrelated", data: {} }]), false);
});

test("isGoalActive follows the last goal-state entry on the branch", () => {
  assert.equal(isGoalActive([goalState({ status: "active" }), goalState(null)]), false);
  assert.equal(isGoalActive([goalState(null), goalState({ status: "active" })]), true);
  assert.equal(
    isGoalActive([goalState({ status: "active" }), goalState({ status: "complete" })]),
    false,
  );
});

test("isGoalActive treats an unrecognised goal-state payload as active", () => {
  assert.equal(isGoalActive([{ type: "custom", customType: "goal-state" }]), true);
  assert.equal(
    isGoalActive([{ type: "custom", customType: "goal-state", data: { status: "active" } }]),
    true,
  );
  assert.equal(isGoalActive([goalState({ status: "rewriting" })]), true);
  assert.equal(isGoalActive([{ type: "custom", customType: "goal-state", data: "junk" }]), true);
});

test("lastRunAborted looks at the last assistant message", () => {
  assert.equal(lastRunAborted([]), false);
  assert.equal(lastRunAborted([userMessage(), assistantText()]), false);
  assert.equal(
    lastRunAborted([
      { type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } },
    ]),
    true,
  );
  // Only the newest assistant message counts; an older abort does not outlive the turn.
  assert.equal(
    lastRunAborted([
      { type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } },
      assistantText(),
    ]),
    false,
  );
});

test("selectPreviousSessionFile skips the running session and picks the newest other file", () => {
  const candidates = [
    { path: "old.jsonl", mtimeMs: 1_000 },
    { path: "middle.jsonl", mtimeMs: 2_000 },
    { path: "current.jsonl", mtimeMs: 5_000 },
  ];

  assert.equal(selectPreviousSessionFile(candidates, "current.jsonl"), "middle.jsonl");
  assert.equal(selectPreviousSessionFile(candidates, null), "current.jsonl");
  assert.equal(selectPreviousSessionFile([], "current.jsonl"), null);
});

test(
  "selectPreviousSessionFile matches the running session case-insensitively on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const candidates = [
      { path: "C:\\Sessions\\OLD.jsonl", mtimeMs: 1_000 },
      { path: "C:\\Sessions\\Current.jsonl", mtimeMs: 5_000 },
    ];

    assert.equal(
      selectPreviousSessionFile(candidates, "c:\\sessions\\current.jsonl"),
      "C:\\Sessions\\OLD.jsonl",
    );
  },
);
