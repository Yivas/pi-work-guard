/**
 * pi-work-guard — keeps the task list current and refuses silent stops.
 *
 * The extension watches the session branch instead of keeping its own bookkeeping. On every turn it
 * asks one question: does the task list still describe what is happening? When it does not, it
 * injects a reminder; when the agent goes idle with work still marked in progress, it asks for an
 * explicit decision instead of letting the turn end quietly.
 *
 * Everything runs locally. There is no network access, no telemetry, and the only file written is
 * the extension's own configuration under the agent directory.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CONFIG,
  decide,
  fingerprint,
  normalizeConfig,
  openItems,
  systemPromptBlock,
  type GuardConfig,
  type TodoItem,
} from "./guard.ts";
import { listSessionCandidates, readLastTodoDetails } from "./session-file.ts";
import {
  countStepsAfter,
  isGoalActive,
  readTodoSnapshot,
  sanitizeProjectDirName,
  selectPreviousSessionFile,
  type SessionEntryLike,
} from "./state.ts";

const CUSTOM_MESSAGE_TYPE = "work-guard";
const STATE_ENTRY_TYPE = "work-guard-state";
const CONFIG_FILE_NAME = "work-guard.json";

interface ForcedTurnState {
  fingerprint: string | null;
  turns: number;
}

interface GuardSnapshot {
  entries: SessionEntryLike[];
  sessionItems: TodoItem[];
  openList: TodoItem[];
  stepsSinceUpdate: number;
  goalActive: boolean;
}

function readConfig(): GuardConfig {
  try {
    const raw = readFileSync(join(getAgentDir(), CONFIG_FILE_NAME), "utf8");
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(config: GuardConfig): void {
  writeFileSync(
    join(getAgentDir(), CONFIG_FILE_NAME),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export default function workGuard(pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let sessionStartedAt = Date.now();
  let forced: ForcedTurnState = { fingerprint: null, turns: 0 };
  let notifiedFingerprint: string | null = null;
  let inheritedItems: TodoItem[] = [];
  let currentBlock = "";

  const snapshot = (ctx: ExtensionContext): GuardSnapshot => {
    const entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    const todoState = readTodoSnapshot(entries);
    return {
      entries,
      sessionItems: todoState.items,
      openList: openItems(todoState.items),
      stepsSinceUpdate: countStepsAfter(entries, todoState.lastUpdateIndex),
      goalActive: isGoalActive(entries),
    };
  };

  const refreshBlock = (state: GuardSnapshot): void => {
    currentBlock = systemPromptBlock(state.openList, config);
  };

  const restoreForcedTurns = (entries: SessionEntryLike[]): void => {
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
        continue;
      }
      const data = entry.data as ForcedTurnState | undefined;
      if (data && typeof data.turns === "number" && typeof data.fingerprint === "string") {
        forced = { fingerprint: data.fingerprint, turns: data.turns };
      } else if (data && data.fingerprint === null) {
        forced = { fingerprint: null, turns: 0 };
      }
    }
  };

  const loadPreviousItems = async (ctx: ExtensionContext): Promise<TodoItem[]> => {
    const directory = join(getAgentDir(), "sessions", sanitizeProjectDirName(ctx.cwd));
    const candidates = await listSessionCandidates(directory);
    const previous = selectPreviousSessionFile(candidates, sessionStartedAt);
    if (!previous) {
      return [];
    }
    const items = await readLastTodoDetails(previous);
    return items ? openItems(items) : [];
  };

  const notify = (message: string, triggerTurn: boolean): void => {
    pi.sendMessage(
      { customType: CUSTOM_MESSAGE_TYPE, content: message, display: true },
      { triggerTurn },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionStartedAt = Date.now();
    config = readConfig();
    const state = snapshot(ctx);
    restoreForcedTurns(state.entries);
    refreshBlock(state);

    inheritedItems = await loadPreviousItems(ctx);
    const decision = decide({
      config,
      openItems: inheritedItems,
      sessionOpenItems: state.sessionItems,
      stepsSinceLastTodoUpdate: state.stepsSinceUpdate,
      trigger: "session-start",
      hasActiveGoal: state.goalActive,
      forcedTurnsForFingerprint: 0,
      notifiedFingerprint: null,
    });
    if (decision.kind === "notice") {
      pi.sendMessage(
        { customType: CUSTOM_MESSAGE_TYPE, content: decision.message, display: true },
        { deliverAs: "nextTurn" },
      );
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const state = snapshot(ctx);
    restoreForcedTurns(state.entries);
    refreshBlock(state);
  });

  pi.on("session_compact", async (_event, ctx) => {
    const state = snapshot(ctx);
    refreshBlock(state);
    const decision = decide({
      config,
      openItems: state.openList,
      sessionOpenItems: state.sessionItems,
      stepsSinceLastTodoUpdate: state.stepsSinceUpdate,
      trigger: "compaction",
      hasActiveGoal: state.goalActive,
      forcedTurnsForFingerprint: forced.turns,
      notifiedFingerprint,
    });
    if (decision.kind === "notice") {
      notify(decision.message, false);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const state = snapshot(ctx);
    refreshBlock(state);
    const decision = decide({
      config,
      openItems: state.openList,
      sessionOpenItems: state.sessionItems,
      stepsSinceLastTodoUpdate: state.stepsSinceUpdate,
      trigger: "stale-check",
      hasActiveGoal: state.goalActive,
      forcedTurnsForFingerprint: forced.turns,
      notifiedFingerprint,
    });
    if (decision.kind === "notice") {
      notifiedFingerprint = fingerprint(state.openList);
      notify(decision.message, false);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const state = snapshot(ctx);
    refreshBlock(state);

    const currentFingerprint = fingerprint(state.openList);
    if (forced.fingerprint !== currentFingerprint) {
      forced = { fingerprint: currentFingerprint, turns: 0 };
    }

    const decision = decide({
      config,
      openItems: state.openList,
      sessionOpenItems: state.sessionItems,
      stepsSinceLastTodoUpdate: state.stepsSinceUpdate,
      trigger: "agent-settled",
      hasActiveGoal: state.goalActive,
      forcedTurnsForFingerprint: forced.turns,
      notifiedFingerprint,
    });

    if (decision.kind !== "force" || !ctx.hasUI) {
      return;
    }

    forced = { fingerprint: currentFingerprint, turns: forced.turns + 1 };
    pi.appendEntry(STATE_ENTRY_TYPE, forced);
    pi.sendUserMessage(decision.message, { deliverAs: "followUp" });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = snapshot(ctx);
    refreshBlock(state);
    if (!currentBlock) {
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${currentBlock}` };
  });

  pi.registerCommand("work-guard", {
    description: "Show or change how aggressively the task list is watched.",
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase();

      if (action === "on" || action === "off") {
        config = { ...config, enabled: action === "on" };
        writeConfig(config);
        refreshBlock(snapshot(ctx));
        ctx.ui.notify(`work-guard is now ${config.enabled ? "on" : "off"}`, "info");
        return;
      }

      if (action === "reset") {
        const state = snapshot(ctx);
        forced = { fingerprint: fingerprint(state.openList), turns: 0 };
        notifiedFingerprint = null;
        pi.appendEntry(STATE_ENTRY_TYPE, forced);
        ctx.ui.notify("work-guard counters reset for the current task list", "info");
        return;
      }

      const state = snapshot(ctx);
      ctx.ui.notify(
        [
          `enabled: ${config.enabled}`,
          `stale after: ${config.staleSteps} steps (${state.stepsSinceUpdate} now)`,
          `forced turns: ${forced.turns}/${config.maxForcedTurns}`,
          `open items: ${state.openList.length}`,
        ].join(" | "),
        "info",
      );
    },
  });
}
