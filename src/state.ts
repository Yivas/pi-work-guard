/**
 * Derived session state.
 *
 * Everything in this module is a pure function over the entries of a session branch. The guard
 * keeps no counters of its own: the number of steps since the task list was last touched is
 * recomputed from the branch, so a reload, a branch switch or a compaction cannot desynchronise it.
 */

import type { TodoItem, TodoStatus } from "./guard.ts";

const TODO_TOOL_NAME = "todo";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "deleted"];

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
 * and the SDK example stores `{ todos, nextId }`. Anything else is ignored instead of guessed.
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
    if (item) {
      items.push(item);
    }
  }
  return items;
}

/** Replays the branch and returns the task list as of its last update. */
export function readTodoSnapshot(entries: readonly SessionEntryLike[]): TodoSnapshot {
  let items: TodoItem[] = [];
  let lastUpdateIndex = -1;

  entries.forEach((entry, index) => {
    if (entry.type !== "message") {
      return;
    }
    const message = entry.message;
    if (!message || message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) {
      return;
    }
    const parsed = parseTodoDetails(message.details);
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

/**
 * Reports whether pi-goal currently owns continuation in this session.
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
    active = asRecord(entry.data)?.status === "active";
  }
  return active;
}

/** Session files are grouped per working directory in the agent directory. */
export function sanitizeProjectDirName(cwd: string): string {
  return `--${cwd.replace(/[^A-Za-z0-9.-]/g, "-")}--`;
}

export interface SessionFileCandidate {
  path: string;
  mtimeMs: number;
}

/** Picks the most recent session file written before the current session started. */
export function selectPreviousSessionFile(
  candidates: readonly SessionFileCandidate[],
  currentSessionStartedAt: number,
): string | null {
  let best: SessionFileCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.mtimeMs >= currentSessionStartedAt) {
      continue;
    }
    if (!best || candidate.mtimeMs > best.mtimeMs) {
      best = candidate;
    }
  }
  return best?.path ?? null;
}
