/**
 * Derived session state.
 *
 * Everything in this module is a pure function over the entries of a session branch. The guard
 * keeps no counters of its own: the number of steps since the task list was last touched is
 * recomputed from the branch, so a reload, a branch switch or a compaction cannot desynchronise it.
 */

import { resolve } from "node:path";

import type { TodoItem, TodoStatus } from "./guard.ts";

const TODO_TOOL_NAME = "todo";
const TODO_STATE_ENTRY_TYPE = "rpiv-todo-state";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "deleted"];
/** Statuses pi-goal writes; anything outside this list is an unknown payload. */
const GOAL_STATUSES: readonly string[] = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
];

/** Structural subset of a Pi session entry that this extension needs. */
export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
    content?: unknown;
    stopReason?: string;
  };
}

export interface TodoSnapshot {
  items: TodoItem[];
  /** Index of the entry that produced this state, or -1 when the branch has no task list yet. */
  lastUpdateIndex: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeStatus(raw: unknown, done: unknown): TodoStatus {
  if (typeof raw === "string" && (TODO_STATUSES as readonly string[]).includes(raw)) {
    return raw as TodoStatus;
  }
  return done === true ? "completed" : "pending";
}

function normalizeItem(raw: unknown): TodoItem | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const rawId = record.id;
  if (typeof rawId !== "number" || !Number.isFinite(rawId)) {
    return null;
  }
  const rawSubject = record.subject ?? record.text ?? record.content;
  const subject = typeof rawSubject === "string" ? rawSubject : "";
  return {
    id: rawId,
    subject,
    status: normalizeStatus(record.status, record.done),
  };
}

/**
 * Reads the task list out of a `todo` tool result.
 *
 * Two shapes are accepted because the tool is replaceable: `rpiv-todo` stores `{ tasks, nextId }`
 * and the SDK example stores `{ todos, nextId }`. Anything else is ignored instead of guessed,
 * including a list with an item this module cannot read: an unknown payload means silence, and the
 * caller keeps the previous state.
 */
export function parseTodoDetails(details: unknown): TodoItem[] | null {
  const record = asRecord(details);
  if (!record) {
    return null;
  }
  const rawList = Array.isArray(record.tasks)
    ? record.tasks
    : Array.isArray(record.todos)
      ? record.todos
      : null;
  if (!rawList) {
    return null;
  }
  const items: TodoItem[] = [];
  for (const raw of rawList) {
    const item = normalizeItem(raw);
    if (!item) {
      return null;
    }
    items.push(item);
  }
  return items;
}

/**
 * Payload carried by an entry that may describe the task list, or null when it carries none.
 *
 * `rpiv-todo` writes a `toolResult` for every call it runs itself, but a call routed through
 * another tool produces only the `rpiv-todo-state` custom entry, so both carriers count.
 */
function todoDetailsAt(entry: SessionEntryLike): unknown {
  if (entry.type === "message") {
    const message = entry.message;
    if (message?.role === "toolResult" && message.toolName === TODO_TOOL_NAME) {
      return message.details;
    }
    return null;
  }
  if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) {
    return entry.data;
  }
  return null;
}

/** Replays the branch and returns the task list as of its last update. */
export function readTodoSnapshot(entries: readonly SessionEntryLike[]): TodoSnapshot {
  let items: TodoItem[] = [];
  let lastUpdateIndex = -1;

  entries.forEach((entry, index) => {
    const parsed = parseTodoDetails(todoDetailsAt(entry));
    if (parsed) {
      items = parsed;
      lastUpdateIndex = index;
    }
  });

  return { items, lastUpdateIndex };
}

function isToolCallTurn(entry: SessionEntryLike): boolean {
  if (entry.type !== "message") {
    return false;
  }
  const message = entry.message;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => asRecord(block)?.type === "toolCall");
}

/** Counts agent steps that happened after the entry at `index`. */
export function countStepsAfter(entries: readonly SessionEntryLike[], index: number): number {
  if (index < 0) {
    return 0;
  }
  let steps = 0;
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && isToolCallTurn(entry)) {
      steps += 1;
    }
  }
  return steps;
}

/** Index of the last user message on the branch, or -1 when the branch has none. */
function lastUserMessageIndex(entries: readonly SessionEntryLike[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user") {
      return index;
    }
  }
  return -1;
}

/**
 * Reports whether the task list was touched after the last user message, that is, during the run
 * that just ended. A list the agent has just updated is current by definition.
 */
export function updatedDuringCurrentTurn(
  entries: readonly SessionEntryLike[],
  lastUpdateIndex: number,
): boolean {
  return lastUpdateIndex >= 0 && lastUpdateIndex > lastUserMessageIndex(entries);
}

/** Reports whether the last assistant message on the branch belongs to an aborted run. */
export function lastRunAborted(entries: readonly SessionEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    return entry.message.stopReason === "aborted";
  }
  return false;
}

/**
 * Reads one `goal-state` payload written by pi-goal.
 *
 * The payload is `{ goal: { status, ... } | null }`, where `null` means the goal was cleared. An
 * unrecognised payload is reported as active: guessing "inactive" there would queue a second
 * continuation next to pi-goal's own.
 */
function goalEntryIsActive(data: unknown): boolean {
  const record = asRecord(data);
  if (!record || !("goal" in record)) {
    return true;
  }
  if (record.goal === null) {
    return false;
  }
  const status = asRecord(record.goal)?.status;
  if (typeof status !== "string" || !GOAL_STATUSES.includes(status)) {
    return true;
  }
  return status === "active";
}

/**
 * Reports whether pi-goal currently owns continuation in this session, taking the last
 * `goal-state` entry on the branch as the answer.
 *
 * When a goal is active, pi-goal already continues from the settled boundary, so the guard must
 * stay out of the way instead of queueing a second continuation.
 */
export function isGoalActive(entries: readonly SessionEntryLike[]): boolean {
  let active = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY_TYPE) {
      continue;
    }
    active = goalEntryIsActive(entry.data);
  }
  return active;
}

export interface SessionFileCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * Paths are compared resolved, and case-insensitively on Windows, where one file has two spellings.
 */
function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Picks the most recent session file that is not the current one. */
export function selectPreviousSessionFile(
  candidates: readonly SessionFileCandidate[],
  currentSessionFile: string | null,
): string | null {
  const current = currentSessionFile ? pathKey(currentSessionFile) : null;
  let best: SessionFileCandidate | null = null;
  for (const candidate of candidates) {
    if (current !== null && pathKey(candidate.path) === current) {
      continue;
    }
    if (!best || candidate.mtimeMs > best.mtimeMs) {
      best = candidate;
    }
  }
  return best?.path ?? null;
}
