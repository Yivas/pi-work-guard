/**
 * Minimal fake Pi host for the effect layer.
 *
 * `src/index.ts` only needs a handful of host methods, so the tests build one host that records what
 * the extension sends and writes, and replays a session branch made of plain entries. Nothing here
 * touches a real Pi session or the real agent directory.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SessionEntryLike } from "../src/state.ts";

export interface SentCustomMessage {
  customType: string;
  content: string;
  display?: boolean;
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

export interface SentUserMessage {
  content: string;
  options?: { deliverAs?: string };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface FakeHostOptions {
  entries?: SessionEntryLike[];
  hasUI?: boolean;
  /** Session directory the extension scans; defaults to an empty directory inside the temp agent dir. */
  sessionDir?: string;
  /** Current session file, which must never be read as the previous one. */
  sessionFile?: string | null;
}

export interface FakeHost {
  pi: ExtensionAPI;
  agentDir: string;
  /** Working directory handed to the extension, left empty so a write into it is visible. */
  cwd: string;
  sessionDir: string;
  entries: SessionEntryLike[];
  customMessages: SentCustomMessage[];
  userMessages: SentUserMessage[];
  appended: Array<{ customType: string; data: unknown }>;
  notifications: string[];
  emit(event: string, payload: unknown): Promise<unknown>;
  runCommand(args: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const agentDir = await mkdtemp(join(tmpdir(), "work-guard-host-"));
  const cwd = join(agentDir, "project");
  const sessionDir = options.sessionDir ?? join(agentDir, "sessions");
  await mkdir(cwd, { recursive: true });
  const entries = options.entries ?? [];
  const customMessages: SentCustomMessage[] = [];
  const userMessages: SentUserMessage[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();

  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push(`${type ?? "info"}: ${message}`);
      },
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionDir: () => sessionDir,
      getSessionFile: () => options.sessionFile ?? null,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
    sendMessage: (message: SentCustomMessage, sendOptions?: SentCustomMessage["options"]) => {
      customMessages.push({ ...message, options: sendOptions });
    },
    sendUserMessage: (content: string, sendOptions?: SentUserMessage["options"]) => {
      userMessages.push({ content, options: sendOptions });
    },
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: ExtensionContext) => unknown },
    ) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    agentDir,
    cwd,
    sessionDir,
    entries,
    customMessages,
    userMessages,
    appended,
    notifications,
    emit: async (event, payload) => {
      const handler = handlers.get(event);
      if (!handler) {
        throw new Error(`the extension registered no handler for ${event}`);
      }
      return await handler(payload, ctx);
    },
    runCommand: async (args) => {
      const command = commands.get("work-guard");
      if (!command) {
        throw new Error("the extension registered no work-guard command");
      }
      await command.handler(args, ctx);
    },
    dispose: async () => {
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}

export interface FakeTask {
  id: number;
  subject: string;
  status: string;
}

export const todoResult = (tasks: FakeTask[]): SessionEntryLike => ({
  type: "message",
  message: { role: "toolResult", toolName: "todo", details: { action: "update", tasks } },
});

export const userMessage = (): SessionEntryLike => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "Go on" }] },
});

export const assistantTurn = (): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
});

export const assistantAbort = (): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [], stopReason: "aborted" },
});

/** One `goal-state` entry as pi-goal 0.55.3 appends it. */
export const goalState = (goal: unknown): SessionEntryLike => ({
  type: "custom",
  customType: "goal-state",
  data: { goal },
});

export const workGuardState = (fingerprint: string | null, turns: number): SessionEntryLike => ({
  type: "custom",
  customType: "work-guard-state",
  data: { fingerprint, turns },
});

/** One line of a session file on disk carrying a task list. */
export const todoSessionLine = (id: number, status: string): string =>
  JSON.stringify(todoResult([{ id, subject: `Task ${id}`, status }]));
