/**
 * Bounded reads of session files on disk.
 *
 * A previous session is only consulted to recover an unfinished task list when a new session
 * starts. Session files grow to tens of megabytes, so lines are streamed and only the last `todo`
 * tool result is kept; message text is neither kept nor reported.
 *
 * The bounds are real but not absolute, and the wording here is the honest limit: the line reader
 * buffers one complete line before the per-line cap can be checked, so a single very long line is
 * materialised once. A file above the total cap yields no list at all: reading stops there, and a
 * list seen before the cap is dropped, because a list the file contradicts later is worse than no
 * notice.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { TodoItem } from "./guard.ts";
import { parseTodoDetails, TODO_STATE_ENTRY_TYPE, type SessionFileCandidate } from "./state.ts";

const TODO_TOOL_NAME = "todo";
/** A single line above this size is skipped instead of parsed. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Reading stops after this many bytes; a longer file produces no inherited-work notice. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Session file names start with an ISO timestamp, so only the newest of them are worth reading. */
export const MAX_SESSION_FILES = 50;

interface JsonLine {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; toolName?: string; details?: unknown };
}

/**
 * Task list carried by one line, or null when it carries none. Both carriers `rpiv-todo` writes
 * are read, as on a live branch: the `todo` tool result and the `rpiv-todo-state` entry a call
 * routed through another tool leaves without a `toolResult`.
 */
function detailsFromLine(line: string): TodoItem[] | null {
  if (!line.includes(`"${TODO_TOOL_NAME}"`) && !line.includes(`"${TODO_STATE_ENTRY_TYPE}"`)) {
    return null;
  }
  let parsed: JsonLine;
  try {
    parsed = JSON.parse(line) as JsonLine;
  } catch {
    return null;
  }
  if (parsed.type === "custom") {
    return parsed.customType === TODO_STATE_ENTRY_TYPE ? parseTodoDetails(parsed.data) : null;
  }
  const message = parsed.message;
  if (parsed.type !== "message" || message?.role !== "toolResult") {
    return null;
  }
  if (message.toolName !== TODO_TOOL_NAME) {
    return null;
  }
  return parseTodoDetails(message.details);
}

/**
 * Returns the last task list written by a session file, or null when it has none.
 *
 * A read-only `list` or `get` is skipped like a failed call, for the same reason as on a live
 * branch: it carries a list but changes nothing. Only the last list is kept here, so dropping a read
 * that repeats the tasks of the last write cannot change the result.
 */
export async function readLastTodoDetails(path: string): Promise<TodoItem[] | null> {
  let latest: TodoItem[] | null = null;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let totalBytes = 0;

  try {
    for await (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      totalBytes += lineBytes;
      if (totalBytes > MAX_FILE_BYTES) {
        latest = null;
        break;
      }
      if (lineBytes > MAX_LINE_BYTES) {
        continue;
      }
      const parsed = detailsFromLine(line);
      if (parsed) {
        latest = parsed;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return latest;
}

/** Lists the session files of one project directory, newest metadata only. */
export async function listSessionCandidates(directory: string): Promise<SessionFileCandidate[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const newestNames = names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .slice(-MAX_SESSION_FILES);

  const candidates: SessionFileCandidate[] = [];
  for (const name of newestNames) {
    const path = join(directory, name);
    try {
      const stats = await stat(path);
      if (stats.isFile()) {
        candidates.push({ path, mtimeMs: stats.mtimeMs });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}
