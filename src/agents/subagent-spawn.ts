import crypto from "node:crypto";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { getQueueSize } from "../process/command-queue.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import {
  countActiveDescendantRuns,
  countActiveRunsForSession,
  registerSubagentRun,
} from "./subagent-registry.js";
import { readStringParam } from "./tools/common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
};

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "auto-announces on completion, do not poll/sleep. The response will be sent back as an agent message.";

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  note?: string;
  modelApplied?: boolean;
  warning?: string;
  error?: string;
};

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

export function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

function shortenForStatus(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatModelForStatus(modelRef?: string): string {
  const normalized = typeof modelRef === "string" ? modelRef.trim() : "";
  if (!normalized) {
    return "default";
  }
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0 && slash < normalized.length - 1) {
    return normalized.slice(slash + 1);
  }
  return normalized;
}

function buildSpawnProgressMessage(params: {
  runId: string;
  task: string;
  label?: string;
  model?: string;
  activeDescendantRuns: number;
  laneLoad: number;
  laneMaxConcurrent: number;
}) {
  const runShort = params.runId.slice(0, 8);
  const workLabel = shortenForStatus(params.label || params.task, 80);
  const activeLabel = params.activeDescendantRuns === 1 ? "subagent" : "subagents";
  const effectiveConcurrency = Math.max(1, Math.floor(params.laneMaxConcurrent));
  const queuedEstimate = Math.max(0, params.laneLoad - effectiveConcurrency);
  const queueLine =
    queuedEstimate > 0
      ? `Queue: ${queuedEstimate} waiting in subagent lane (${params.laneLoad} total, concurrency ${effectiveConcurrency}).`
      : `Queue: clear (${params.laneLoad} total in subagent lane, concurrency ${effectiveConcurrency}).`;
  return [
    `⏳ Orchestrator progress: started ${workLabel} (run ${runShort}).`,
    `Model: ${formatModelForStatus(params.model)}.`,
    `In progress: ${params.activeDescendantRuns} active ${activeLabel}.`,
    queueLine,
    "I will post completion updates automatically.",
  ].join("\n");
}

async function maybeSendSpawnProgress(params: {
  cfg: ReturnType<typeof loadConfig>;
  callerDepth: number;
  expectsCompletionMessage?: boolean;
  requesterSessionKey: string;
  requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  runId: string;
  task: string;
  label?: string;
  model?: string;
}) {
  const enabled = params.cfg.agents?.defaults?.subagents?.progress?.enabled === true;
  if (!enabled || params.expectsCompletionMessage !== true || params.callerDepth !== 0) {
    return;
  }
  const origin = params.requesterOrigin;
  const channel = typeof origin?.channel === "string" ? origin.channel.trim() : "";
  const to = typeof origin?.to === "string" ? origin.to.trim() : "";
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return;
  }
  const laneLoad = getQueueSize(AGENT_LANE_SUBAGENT);
  const laneMaxConcurrent = params.cfg.agents?.defaults?.subagents?.maxConcurrent ?? 1;
  const activeDescendantRuns = countActiveDescendantRuns(params.requesterSessionKey);
  const message = buildSpawnProgressMessage({
    runId: params.runId,
    task: params.task,
    label: params.label,
    model: params.model,
    activeDescendantRuns,
    laneLoad,
    laneMaxConcurrent,
  });
  await callGateway({
    method: "send",
    params: {
      channel,
      to,
      accountId: origin?.accountId,
      threadId: origin?.threadId != null ? String(origin.threadId) : undefined,
      sessionKey: params.requesterSessionKey,
      message,
    },
    timeoutMs: 15_000,
  });
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId;
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const cleanup =
    params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const runTimeoutSeconds =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : 0;
  let modelWarning: string | undefined;
  let modelApplied = false;

  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (targetAgentId !== requesterAgentId) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const normalizedTargetId = targetAgentId.toLowerCase();
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeAgentId(value).toLowerCase()),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const runtimeDefaultModel = resolveDefaultModelForAgent({
    cfg,
    agentId: targetAgentId,
  });
  const resolvedModel =
    normalizeModelSelection(modelOverride) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.model?.primary) ??
    normalizeModelSelection(`${runtimeDefaultModel.provider}/${runtimeDefaultModel.model}`);

  const resolvedThinkingDefaultRaw =
    readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
    readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

  let thinkingOverride: string | undefined;
  const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      const { provider, model } = splitModelRef(resolvedModel);
      const hint = formatThinkingLevels(provider, model);
      return {
        status: "error",
        error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
      };
    }
    thinkingOverride = normalized;
  }
  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, spawnDepth: childDepth },
      timeoutMs: 10_000,
    });
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      status: "error",
      error: messageText,
      childSessionKey,
    };
  }

  if (resolvedModel) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: resolvedModel },
        timeoutMs: 10_000,
      });
      modelApplied = true;
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      const recoverable =
        messageText.includes("invalid model") || messageText.includes("model not allowed");
      if (!recoverable) {
        return {
          status: "error",
          error: messageText,
          childSessionKey,
        };
      }
      modelWarning = messageText;
    }
  }
  if (thinkingOverride !== undefined) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: {
          key: childSessionKey,
          thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
        },
        timeoutMs: 10_000,
      });
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return {
        status: "error",
        error: messageText,
        childSessionKey,
      };
    }
  }
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    childDepth,
    maxSpawnDepth,
  });
  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    `[Subagent Task]: ${task}`,
  ].join("\n\n");

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: childTaskMessage,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        to: requesterOrigin?.to ?? undefined,
        accountId: requesterOrigin?.accountId ?? undefined,
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        spawnedBy: spawnedByKey,
        groupId: ctx.agentGroupId ?? undefined,
        groupChannel: ctx.agentGroupChannel ?? undefined,
        groupSpace: ctx.agentGroupSpace ?? undefined,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
    };
  }

  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey,
    task,
    cleanup,
    label: label || undefined,
    model: resolvedModel,
    runTimeoutSeconds,
    expectsCompletionMessage: params.expectsCompletionMessage === true,
  });
  try {
    await maybeSendSpawnProgress({
      cfg,
      callerDepth,
      expectsCompletionMessage: params.expectsCompletionMessage,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      runId: childRunId,
      task,
      label: label || undefined,
      model: resolvedModel,
    });
  } catch {
    // Best-effort only; progress notices should not fail spawns.
  }

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    note: SUBAGENT_SPAWN_ACCEPTED_NOTE,
    modelApplied: resolvedModel ? modelApplied : undefined,
    warning: modelWarning,
  };
}
