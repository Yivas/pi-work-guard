/**
 * Effect-layer tests: what the extension actually sends and writes on a given session branch.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workGuard from "../src/index.ts";
import {
  assistantAbort,
  assistantTurn,
  createHost,
  goalState,
  todoResult,
  todoSessionLine,
  userMessage,
  workGuardState,
} from "./harness.ts";

const listWithInProgress = () =>
  todoResult([{ id: 1, subject: "Ship the guard", status: "in_progress" }]);

/** A branch whose list was last touched before the user message, so the settling turn is not fresh. */
const settledBranch = () => [listWithInProgress(), userMessage(), assistantTurn()];

test("a non-forcing turn leaves the session untouched", async () => {
  const host = await createHost({ entries: settledBranch() });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("session_start", { type: "session_start", reason: "startup" });
    await host.emit("turn_end", { type: "turn_end" });
    await host.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });

    assert.deepEqual(host.appended, []);
    assert.deepEqual(host.customMessages, []);
    assert.deepEqual(host.userMessages, []);
    // A missing configuration file is not an error worth reporting.
    assert.deepEqual(host.notifications, []);
  } finally {
    await host.dispose();
  }
});

test("forcing stops at maxForcedTurns and increments the counter once per forced turn", async () => {
  const host = await createHost({ entries: settledBranch() });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    for (let run = 0; run < 5; run += 1) {
      await host.emit("agent_settled", { type: "agent_settled", aborted: false });
    }

    assert.equal(host.userMessages.length, 3);
    assert.deepEqual(
      host.appended.map((entry) => (entry.data as { turns: number }).turns),
      [1, 2, 3],
    );
    assert.ok(host.appended.every((entry) => entry.customType === "work-guard-state"));
    assert.ok(host.userMessages.every((message) => message.options?.deliverAs === "followUp"));
    assert.ok(host.userMessages[0]?.content.includes("#1 [in_progress] Ship the guard"));
  } finally {
    await host.dispose();
  }
});

test("no forced turn when the session is not interactive", async () => {
  const host = await createHost({ entries: settledBranch(), hasUI: false });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("agent_settled", { type: "agent_settled", aborted: false });

    assert.deepEqual(host.userMessages, []);
    assert.deepEqual(host.appended, []);
  } finally {
    await host.dispose();
  }
});

test("no forced turn when Pi reports the run was aborted", async () => {
  const host = await createHost({ entries: settledBranch() });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("agent_settled", { type: "agent_settled", aborted: true });

    assert.deepEqual(host.userMessages, []);
  } finally {
    await host.dispose();
  }
});

test("no forced turn when only the last assistant message shows the abort", async () => {
  const host = await createHost({
    entries: [listWithInProgress(), userMessage(), assistantAbort()],
  });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    // Older Pi releases settle without the `aborted` field.
    await host.emit("agent_settled", { type: "agent_settled" });

    assert.deepEqual(host.userMessages, []);
  } finally {
    await host.dispose();
  }
});

test("no forced turn while a pi-goal goal is active, and forcing resumes once it is cleared", async () => {
  const active = await createHost({
    entries: [goalState({ status: "active" }), ...settledBranch()],
  });
  try {
    workGuard(active.pi, { agentDir: active.agentDir });

    await active.emit("agent_settled", { type: "agent_settled", aborted: false });

    assert.deepEqual(active.userMessages, []);
  } finally {
    await active.dispose();
  }

  const cleared = await createHost({
    entries: [goalState({ status: "active" }), goalState(null), ...settledBranch()],
  });
  try {
    workGuard(cleared.pi, { agentDir: cleared.agentDir });

    await cleared.emit("agent_settled", { type: "agent_settled", aborted: false });

    assert.equal(cleared.userMessages.length, 1);
  } finally {
    await cleared.dispose();
  }
});

test("the forced-turn counter is restored from its session entry", async () => {
  const host = await createHost({
    entries: [workGuardState("1:in_progress", 3), ...settledBranch()],
  });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("session_start", { type: "session_start", reason: "startup" });
    await host.emit("agent_settled", { type: "agent_settled", aborted: false });

    assert.deepEqual(host.userMessages, []);
    assert.deepEqual(host.appended, []);
  } finally {
    await host.dispose();
  }
});

test("compaction re-injects the open items", async () => {
  const host = await createHost({ entries: settledBranch() });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("session_compact", { type: "session_compact" });

    assert.equal(host.customMessages.length, 1);
    assert.ok(host.customMessages[0]?.content.includes("#1 [in_progress] Ship the guard"));
    assert.equal(host.customMessages[0]?.customType, "work-guard");
  } finally {
    await host.dispose();
  }
});

test("/work-guard off drops the system-prompt block and suppresses notices", async () => {
  const host = await createHost({ entries: settledBranch() });
  try {
    workGuard(host.pi, { agentDir: host.agentDir });

    const before = (await host.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "base",
    })) as { systemPrompt?: string } | undefined;
    const block = before?.systemPrompt ?? "";
    assert.ok(block.includes("[work-guard]"), block);

    await host.runCommand("off");
    assert.ok(host.notifications.some((entry) => entry.includes("work-guard is now off")));
    const saved = JSON.parse(await readFile(join(host.agentDir, "work-guard.json"), "utf8"));
    assert.equal(saved.enabled, false);

    const during = await host.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "base",
    });
    assert.equal(during, undefined);
    await host.emit("session_compact", { type: "session_compact" });
    await host.emit("agent_settled", { type: "agent_settled", aborted: false });
    assert.deepEqual(host.customMessages, []);
    assert.deepEqual(host.userMessages, []);

    await host.runCommand("on");
    const after = (await host.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "base",
    })) as { systemPrompt?: string } | undefined;
    const restored = after?.systemPrompt ?? "";
    assert.ok(restored.includes("[work-guard]"), restored);
  } finally {
    await host.dispose();
  }
});

test("the inherited-work notice belongs to a fresh session only", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "work-guard-sessions-"));
  try {
    const currentFile = join(sessionDir, "2026-02-02T00-00-00-000Z_current.jsonl");
    const previousFile = join(sessionDir, "2026-02-01T00-00-00-000Z_previous.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(currentFile, `${todoSessionLine(9, "in_progress")}\n`, "utf8");
    await writeFile(previousFile, `${todoSessionLine(4, "in_progress")}\n`, "utf8");

    const startup = await createHost({ sessionDir, sessionFile: currentFile });
    try {
      workGuard(startup.pi, { agentDir: startup.agentDir });
      await startup.emit("session_start", { type: "session_start", reason: "startup" });

      assert.equal(startup.customMessages.length, 1);
      assert.ok(startup.customMessages[0]?.content.includes("#4 [in_progress] Task 4"));
      assert.ok(!startup.customMessages[0]?.content.includes("#9 "));
      assert.equal(startup.customMessages[0]?.options?.deliverAs, "nextTurn");
    } finally {
      await startup.dispose();
    }

    for (const reason of ["resume", "fork", "reload"]) {
      const host = await createHost({ sessionDir, sessionFile: currentFile });
      try {
        workGuard(host.pi, { agentDir: host.agentDir });
        await host.emit("session_start", {
          type: "session_start",
          reason,
          previousSessionFile: previousFile,
        });

        assert.deepEqual(host.customMessages, [], reason);
      } finally {
        await host.dispose();
      }
    }

    const split = await createHost({ sessionDir, sessionFile: null });
    try {
      workGuard(split.pi, { agentDir: split.agentDir });
      await split.emit("session_start", {
        type: "session_start",
        reason: "new",
        previousSessionFile: previousFile,
      });

      assert.ok(split.customMessages[0]?.content.includes("#4 [in_progress] Task 4"));
    } finally {
      await split.dispose();
    }
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("a broken configuration falls back to defaults and warns once", async () => {
  const host = await createHost({ entries: [] });
  try {
    await writeFile(join(host.agentDir, "work-guard.json"), "{ not json", "utf8");
    workGuard(host.pi, { agentDir: host.agentDir });

    await host.emit("session_start", { type: "session_start", reason: "startup" });
    await host.emit("session_start", { type: "session_start", reason: "startup" });

    const warnings = host.notifications.filter((entry) => entry.startsWith("warning:"));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes("work-guard.json"));
  } finally {
    await host.dispose();
  }
});
