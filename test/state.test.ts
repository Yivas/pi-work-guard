import assert from "node:assert/strict";
import test from "node:test";

import {
  countStepsAfter,
  isGoalActive,
  parseTodoDetails,
  readTodoSnapshot,
  sanitizeProjectDirName,
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

test("parseTodoDetails ignores unknown shapes and unusable items", () => {
  assert.equal(parseTodoDetails(null), null);
  assert.equal(parseTodoDetails("tasks"), null);
  assert.equal(parseTodoDetails({ action: "list" }), null);
  assert.deepEqual(parseTodoDetails({ tasks: [{ subject: "no id", status: "pending" }] }), []);
  assert.deepEqual(parseTodoDetails({ tasks: [{ id: 1, subject: "x", status: "weird" }] }), [
    { id: 1, subject: "x", status: "pending" },
  ]);
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

test("isGoalActive follows the last goal-state entry", () => {
  assert.equal(
    isGoalActive([{ type: "custom", customType: "goal-state", data: { status: "active" } }]),
    true,
  );
  assert.equal(
    isGoalActive([
      { type: "custom", customType: "goal-state", data: { status: "active" } },
      { type: "custom", customType: "goal-state", data: { status: "complete" } },
    ]),
    false,
  );
  assert.equal(isGoalActive([{ type: "custom", customType: "unrelated", data: {} }]), false);
});

test("sanitizeProjectDirName matches the directory names Pi creates", () => {
  assert.equal(
    sanitizeProjectDirName("D:\\Documents\\1.Codigo\\yivas-hermes-workbench-ia"),
    "--D--Documents-1.Codigo-yivas-hermes-workbench-ia--",
  );
  assert.equal(
    sanitizeProjectDirName("D:\\Documents\\1.Codigo\\prompt-vault"),
    "--D--Documents-1.Codigo-prompt-vault--",
  );
});

test("selectPreviousSessionFile ignores the running session and picks the newest older file", () => {
  const candidates = [
    { path: "old.jsonl", mtimeMs: 1_000 },
    { path: "middle.jsonl", mtimeMs: 2_000 },
    { path: "current.jsonl", mtimeMs: 5_000 },
  ];

  assert.equal(selectPreviousSessionFile(candidates, 3_000), "middle.jsonl");
  assert.equal(selectPreviousSessionFile(candidates, 1_000), null);
  assert.equal(selectPreviousSessionFile([], 3_000), null);
});
