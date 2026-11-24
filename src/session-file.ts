/**
 * Bounded reads of session files on disk.
 *
 * A previous session is only consulted to recover an unfinished task list when a new session
 * starts. Session files grow to tens of megabytes, so lines are streamed and only the last `todo`
 * tool result is kept; message text is neither kept nor reported.
 *
 * The bounds are real but not absolute, and the wording here is the honest limit: the line reader
 * buffers one complete line before the per-line cap can be checked, so a single very long line is
 * materialised once, and a file above the total cap stops being read and yields no notice.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { TodoItem } from "./guard.ts";
import { parseTodoDetails, type SessionFileCandidate } from "./state.ts";

const TODO_TOOL_NAME = "todo";
/** A single line above this size is skipped instead of parsed. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Reading stops after this many bytes; a longer file produces no inherited-work notice. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Session file names start with an ISO timestamp, so only the newest of them are worth reading. */
export const MAX_SESSION_FILES = 50;

interface JsonLine {
  type?: string;
  message?: { role?: string; toolName?: string; details?: unknown };
}

function detailsFromLine(line: string): TodoItem[] | null {
  if (!line.includes(`"${TODO_TOOL_NAME}"`)) {
    return null;
  }
  let parsed: JsonLine;
  try {
    parsed = JSON.parse(line) as JsonLine;
  } catch {
    return null;
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

/** Returns the last task list written by a session file, or null when it has none. */
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
