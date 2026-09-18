/**
 * Pure decision logic for the work guard: config normalization, task list snapshots and the
 * decision the extension acts on. No I/O, no timers, no state: callers own persistence and
 * delivery, which keeps these rules deterministic and testable.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoItem {
  id: number;
  subject: string;
  status: TodoStatus;
}

export interface GuardConfig {
  enabled: boolean;
  staleSteps: number;
  maxForcedTurns: number;
  noticeOnSessionStart: boolean;
  systemPromptNotice: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  staleSteps: 12,
  maxForcedTurns: 3,
  noticeOnSessionStart: true,
  systemPromptNotice: true,
};

/** Longest subject rendered in full; longer ones are cut so a message stays readable. */
const MAX_SUBJECT_LENGTH = 120;

/** Hard cap for the injected system prompt block, rule lines included. */
const MAX_SYSTEM_PROMPT_LINES = 8;

/** Open items listed by default when a caller passes no limit. */
const DEFAULT_LIST_LIMIT = 10;

/**
 * Defensive merge over DEFAULT_CONFIG: keeps only known fields of the expected type, and drops
 * non-finite or negative numbers. Anything unusable falls back to the default for that field.
 */
export function normalizeConfig(raw: unknown): GuardConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG };

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    staleSteps: isCount(raw.staleSteps) ? raw.staleSteps : DEFAULT_CONFIG.staleSteps,
    maxForcedTurns: isCount(raw.maxForcedTurns)
      ? raw.maxForcedTurns
      : DEFAULT_CONFIG.maxForcedTurns,
    noticeOnSessionStart:
      typeof raw.noticeOnSessionStart === "boolean"
        ? raw.noticeOnSessionStart
        : DEFAULT_CONFIG.noticeOnSessionStart,
    systemPromptNotice:
      typeof raw.systemPromptNotice === "boolean"
        ? raw.systemPromptNotice
        : DEFAULT_CONFIG.systemPromptNotice,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function openItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => item.status === "pending" || item.status === "in_progress");
}

/** Identity of the open set, sorted by id so two callers with the same items agree. */
export function fingerprint(items: readonly TodoItem[]): string {
  return [...items]
    .sort((left, right) => left.id - right.id)
    .map((item) => `${item.id}:${item.status}`)
    .join(",");
}

export function hasInProgress(items: readonly TodoItem[]): boolean {
  return items.some((item) => item.status === "in_progress");
}

/**
 * Rule lines plus the open items, re-injected on every turn. Empty when the guard is off or there
 * is nothing open, and byte-identical for identical input so provider prompt caching keeps working.
 */
export function systemPromptBlock(items: readonly TodoItem[], config: GuardConfig): string {
  if (!config.enabled || !config.systemPromptNotice) return "";

  const open = openItems(items);
  if (open.length === 0) return "";

  const ruleLines = [
    "[work-guard] Keep the task list current: update it on every phase change and before any report.",
    "[work-guard] Close a task only with an executed check, never with a sentence.",
  ];
  const itemLines = formatTaskList(open, MAX_SYSTEM_PROMPT_LINES - ruleLines.length - 1);

  return [...ruleLines, ...itemLines].join("\n");
}

export type NoticeTrigger = "stale" | "session-start" | "compaction";

const NOTICE_REASONS: Record<NoticeTrigger, string> = {
  stale: "The task list has not been updated for several steps.",
  "session-start": "This session started with open tasks inherited from a previous one.",
  compaction: "The context was compacted and open tasks are still on the list.",
};

export function formatNotice(
  items: readonly TodoItem[],
  trigger: NoticeTrigger,
  limit: number = DEFAULT_LIST_LIMIT,
): string {
  const open = openItems(items);
  return [NOTICE_REASONS[trigger], "Open tasks:", ...formatTaskList(open, limit)].join("\n");
}

export function formatFollowUp(items: readonly TodoItem[], maxForcedTurns: number): string {
  const open = openItems(items);
  const turns = `${maxForcedTurns} forced turn${maxForcedTurns === 1 ? "" : "s"}`;

  return [
    "Open tasks remain and the session went idle.",
    "Decide now: continue the task, close it with executed evidence, or declare a handoff.",
    `This reminder is suppressed after ${turns}.`,
    "Open tasks:",
    ...formatTaskList(open, DEFAULT_LIST_LIMIT),
  ].join("\n");
}

/** `- #id [status] subject` lines, with an "(and N more)" suffix when the list is cut short. */
function formatTaskList(open: readonly TodoItem[], limit: number): string[] {
  const maxListed = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_LIST_LIMIT;
  const shown = open.slice(0, maxListed);
  const lines = shown.map((task) =>
    `- #${task.id} [${task.status}] ${shortenSubject(task.subject)}`.trimEnd(),
  );

  const hidden = open.length - shown.length;
  if (hidden > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} (and ${hidden} more)`;

  return lines;
}

/** Subjects are agent-authored: collapse whitespace so one item stays on one line. */
function shortenSubject(subject: string): string {
  const compact = subject.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SUBJECT_LENGTH) return compact;
  return `${compact.slice(0, MAX_SUBJECT_LENGTH - 3).trimEnd()}...`;
}

export type GuardDecision =
  | { kind: "none"; reason: string }
  | { kind: "notice"; trigger: NoticeTrigger; message: string }
  | { kind: "force"; message: string };

export interface DecisionInput {
  config: GuardConfig;
  openItems: readonly TodoItem[];
  /** Items known in the current session only, not inherited from a previous one. */
  sessionOpenItems: readonly TodoItem[];
  stepsSinceLastTodoUpdate: number;
  trigger: "stale-check" | "session-start" | "compaction" | "agent-settled";
  hasActiveGoal: boolean;
  forcedTurnsForFingerprint: number;
  notifiedFingerprint: string | null;
}

export function decide(input: DecisionInput): GuardDecision {
  const {
    config,
    openItems: open,
    sessionOpenItems,
    stepsSinceLastTodoUpdate,
    trigger,
    hasActiveGoal,
    forcedTurnsForFingerprint,
    notifiedFingerprint,
  } = input;

  if (!config.enabled) return { kind: "none", reason: "disabled" };
  if (open.length === 0) return { kind: "none", reason: "no-open-items" };

  switch (trigger) {
    case "session-start": {
      if (!config.noticeOnSessionStart) {
        return { kind: "none", reason: "session-start-notice-disabled" };
      }
      return {
        kind: "notice",
        trigger: "session-start",
        message: formatNotice(open, "session-start"),
      };
    }
    case "compaction":
      return { kind: "notice", trigger: "compaction", message: formatNotice(open, "compaction") };
    case "stale-check": {
      if (stepsSinceLastTodoUpdate < config.staleSteps) return { kind: "none", reason: "fresh" };
      if (notifiedFingerprint === fingerprint(open)) {
        return { kind: "none", reason: "already-notified" };
      }
      return { kind: "notice", trigger: "stale", message: formatNotice(open, "stale") };
    }
    case "agent-settled": {
      if (hasActiveGoal) return { kind: "none", reason: "goal-active" };
      if (!hasInProgress(sessionOpenItems)) return { kind: "none", reason: "nothing-in-progress" };
      if (forcedTurnsForFingerprint >= config.maxForcedTurns) {
        return { kind: "none", reason: "forced-turn-limit" };
      }
      return { kind: "force", message: formatFollowUp(open, config.maxForcedTurns) };
    }
  }
}
