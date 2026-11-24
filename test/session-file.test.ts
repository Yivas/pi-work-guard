import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_SESSION_FILES,
  listSessionCandidates,
  readLastTodoDetails,
} from "../src/session-file.ts";

const todoLine = (id: number, status: string): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details: { tasks: [{ id, subject: `Task ${id}`, status }] },
    },
  });

const messageLine = (text: string): string =>
  JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "work-guard-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readLastTodoDetails returns the newest task list in the file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        messageLine("working"),
        todoLine(1, "pending"),
        messageLine("more work"),
        todoLine(1, "completed"),
        "",
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(await readLastTodoDetails(path), [
      { id: 1, subject: "Task 1", status: "completed" },
    ]);
  });
});

test("readLastTodoDetails survives a file without a task list", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    await writeFile(path, [messageLine("hello"), "not json at all", ""].join("\n"), "utf8");

    assert.equal(await readLastTodoDetails(path), null);
  });
});

test("readLastTodoDetails skips a line above the per-line cap", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const oversized = messageLine("y".repeat(MAX_LINE_BYTES));
    await writeFile(
      path,
      [todoLine(9, "in_progress"), oversized, todoLine(10, "pending"), ""].join("\n"),
      "utf8",
    );

    assert.deepEqual(await readLastTodoDetails(path), [
      { id: 10, subject: "Task 10", status: "pending" },
    ]);
  });
});

test("readLastTodoDetails tolerates a truncated trailing line", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const truncated = todoLine(3, "completed").slice(0, 40);
    await writeFile(path, `${todoLine(2, "in_progress")}\n${truncated}`, "utf8");

    assert.deepEqual(await readLastTodoDetails(path), [
      { id: 2, subject: "Task 2", status: "in_progress" },
    ]);
  });
});

test("readLastTodoDetails stays silent once the total byte cap is exceeded", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const filler = `${messageLine("z".repeat(64 * 1024))}\n`;
    const chunks = [filler.repeat(Math.ceil(MAX_FILE_BYTES / filler.length) + 1)];
    chunks.push(`${todoLine(8, "in_progress")}\n`);
    await writeFile(path, chunks.join(""), "utf8");

    assert.equal(await readLastTodoDetails(path), null);
  });
});

test("readLastTodoDetails drops a list read before the total cap was reached", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const filler = `${messageLine("z".repeat(64 * 1024))}\n`;
    const pastCap = filler.repeat(Math.ceil(MAX_FILE_BYTES / filler.length) + 1);
    await writeFile(path, `${todoLine(8, "in_progress")}\n${pastCap}`, "utf8");

    assert.equal(await readLastTodoDetails(path), null);
  });
});

test("readLastTodoDetails reads the rpiv-todo-state entry of a routed call", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const stateLine = JSON.stringify({
      type: "custom",
      customType: "rpiv-todo-state",
      data: { action: "update", tasks: [{ id: 11, subject: "Routed", status: "in_progress" }] },
    });
    await writeFile(path, [messageLine("working"), stateLine, ""].join("\n"), "utf8");

    assert.deepEqual(await readLastTodoDetails(path), [
      { id: 11, subject: "Routed", status: "in_progress" },
    ]);
  });
});

test("readLastTodoDetails ignores another custom entry and an error result", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "custom", customType: "goal-state", data: { goal: null } }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: "todo",
            details: { tasks: [{ id: 3, subject: "Task 3", status: "pending" }], error: "#9 not" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    assert.equal(await readLastTodoDetails(path), null);
  });
});

test("readLastTodoDetails only reads entries that look like a todo tool result", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "prompt mentions todo" }] },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    assert.equal(await readLastTodoDetails(path), null);
  });
});

test("listSessionCandidates returns jsonl files only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.jsonl"), "", "utf8");
    await writeFile(join(dir, "b.txt"), "", "utf8");
    await writeFile(join(dir, "c.jsonl"), "", "utf8");

    const candidates = await listSessionCandidates(dir);
    const names = candidates.map((candidate) => candidate.path.split(/[\\/]/).pop()).sort();

    assert.deepEqual(names, ["a.jsonl", "c.jsonl"]);
    assert.ok(candidates.every((candidate) => Number.isFinite(candidate.mtimeMs)));
    assert.deepEqual(await listSessionCandidates(join(dir, "missing")), []);
  });
});

test("listSessionCandidates inspects only the newest session files", async () => {
  await withTempDir(async (dir) => {
    const total = MAX_SESSION_FILES + 5;
    for (let index = 0; index < total; index += 1) {
      const stamp = String(index).padStart(3, "0");
      await writeFile(join(dir, `2026-01-01T00-00-00-${stamp}Z.jsonl`), "", "utf8");
    }

    const candidates = await listSessionCandidates(dir);

    assert.equal(candidates.length, MAX_SESSION_FILES);
    assert.ok(candidates.every((candidate) => Number.isFinite(candidate.mtimeMs)));
  });
});
