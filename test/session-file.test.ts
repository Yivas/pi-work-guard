import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessionCandidates, readLastTodoDetails } from "../src/session-file.ts";

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

test("readLastTodoDetails ignores oversized lines without buffering the conversation", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "session.jsonl");
    const huge = JSON.stringify({ type: "message", message: { role: "user", content: "x" } });
    await writeFile(
      path,
      [huge.replace("x", "y".repeat(3)), todoLine(9, "in_progress"), ""].join("\n"),
      "utf8",
    );

    assert.deepEqual(await readLastTodoDetails(path), [
      { id: 9, subject: "Task 9", status: "in_progress" },
    ]);
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
