import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { collectDurableUsage } from "./usage-history.js";

const HOME = os.homedir();
const CODE_ROOT = path.join(HOME, "code");
const SESSION_ROOT = path.join(HOME, ".pi", "agent", "sessions");
const USAGE_TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"];
const USAGE_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"];
const USAGE_WINDOW_DAYS = { last7: 7, last30: 30 };
const USAGE_RECORD_KINDS = ["assistant", "toolResult", "compaction", "branch_summary"];
const CONTEXT_OBSERVATION_TYPE = "pi-control-center-context-observation-v1";
const COMPACTION_OBSERVATION_TYPE = "pi-control-center-compaction-observation-v1";
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const INDEX_SCHEMA_VERSION = "1";
const EXTRACTOR_VERSION = "2";
const AGGREGATOR_VERSION = "3";
const APPLICATION_ID = 0x50434355;
const APPLICATION_NAME = "PI_CONTROL_CENTER_USAGE";
const INDEX_DIRECTORY_NAME = "pi-control-center";
const DATABASE_NAME = "usage-index.sqlite";
const BUSY_TIMEOUT_MS = 2_000;

let DatabaseSync = null;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

export const USAGE_INDEX_VERSIONS = Object.freeze({
  schema: INDEX_SCHEMA_VERSION,
  extractor: EXTRACTOR_VERSION,
  aggregator: AGGREGATOR_VERSION,
});

export function sqliteAvailable() {
  return typeof DatabaseSync === "function";
}

function hashIdentity(domain, value) {
  return crypto.createHash("sha256").update(`${domain}\0${value}`).digest("hex");
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function safePathKey(filePath, sessionRoot) {
  const relative = normalizeRelativePath(path.relative(sessionRoot, filePath));
  return hashIdentity("pi-control-center:source-file", relative);
}

function safeSessionKey(value) {
  return typeof value === "string" && value.length > 0 ? hashIdentity("pi-control-center:session", value) : null;
}

function safeEntryKey(value) {
  return typeof value === "string" && value.length > 0 ? hashIdentity("pi-control-center:entry", value) : null;
}

function safeSignatureKey(value) {
  return typeof value === "string" && value.length > 0 ? hashIdentity("pi-control-center:entry-signature", value) : null;
}

function usageFromEntry(entry) {
  if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
    return { kind: "assistant", usage: entry.message.usage, provider: entry.message.provider, model: entry.message.responseModel ?? entry.message.model, attributionConfidence: "DIRECT_PERSISTED" };
  }
  if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
    return { kind: "toolResult", usage: entry.message.usage, provider: null, model: null, attributionConfidence: null };
  }
  if (entry.type === "compaction" && entry.usage) {
    return { kind: "compaction", usage: entry.usage, provider: null, model: null, attributionConfidence: null, fromHook: entry.fromHook };
  }
  if (entry.type === "branch_summary" && entry.usage) {
    return { kind: "branch_summary", usage: entry.usage, provider: null, model: null, attributionConfidence: null, fromHook: entry.fromHook };
  }
  return null;
}

function validString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function modelStateFromEntry(entry) {
  if (entry.type === "model_change") {
    return { provider: entry.provider, model: entry.modelId };
  }
  if (entry.type === "message" && entry.message?.role === "assistant") {
    return { provider: entry.message.provider, model: entry.message.model };
  }
  return null;
}

function sessionEntryState(entry) {
  const message = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? entry.message : null;
  return {
    type: entry.type,
    parentId: typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : null,
    role: typeof message?.role === "string" ? message.role : null,
    modelState: modelStateFromEntry(entry),
  };
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeObservationInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observationHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function boundedObservationLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\u0000") ? value : null;
}

function normalizedContextObservation(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const assistantEntryKeyHash = observationHash(data.assistantEntryKeyHash);
  if (!assistantEntryKeyHash) return null;
  const values = ["runtimeContextTokens", "contextWindowTokens", "compactionReserveTokens"];
  const result = { assistantEntryKeyHash };
  for (const field of values) {
    if (data[field] !== null && data[field] !== undefined && safeObservationInteger(data[field]) === null) return null;
    result[field] = data[field] === null || data[field] === undefined ? null : data[field];
  }
  return result;
}

function normalizedCompactionObservation(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const compactionEntryKeyHash = observationHash(data.compactionEntryKeyHash);
  if (!compactionEntryKeyHash) return null;
  const result = { compactionEntryKeyHash };
  result.reason = data.reason === null || data.reason === undefined ? null : (COMPACTION_REASONS.has(data.reason) ? data.reason : null);
  if (data.reason !== null && data.reason !== undefined && result.reason === null) return null;
  for (const field of ["contextWindowTokens", "compactionReserveTokens"]) {
    if (data[field] !== null && data[field] !== undefined && safeObservationInteger(data[field]) === null) return null;
    result[field] = data[field] === null || data[field] === undefined ? null : data[field];
  }
  result.provider = data.provider === null || data.provider === undefined ? null : boundedObservationLabel(data.provider);
  result.model = data.model === null || data.model === undefined ? null : boundedObservationLabel(data.model);
  if ((data.provider !== null && data.provider !== undefined && result.provider === null)
    || (data.model !== null && data.model !== undefined && result.model === null)) return null;
  return result;
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const field of USAGE_TOKEN_FIELDS) {
    if (usage[field] === undefined) continue;
    const value = finiteNonNegative(usage[field]);
    if (value === null) return null;
    result[field] = value;
  }
  if (typeof usage.cost !== "object" || usage.cost === null || Array.isArray(usage.cost)) return null;
  result.cost = {};
  for (const field of USAGE_COST_FIELDS) {
    const value = finiteNonNegative(usage.cost[field]);
    if (value === null) return null;
    result.cost[field] = value;
  }
  if (result.totalTokens === undefined) return null;
  return result;
}

function listSessionFiles(directory, result = [], state = { complete: true }) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    state.complete = false;
    return result;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) listSessionFiles(filePath, result, state);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(filePath);
  }
  return result;
}

export function readUsageArtifact(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { readable: false, header: null, entryIds: new Set(), entrySignatures: new Map(), entryStates: new Map(), entryOrder: [], entryPositions: new Map(), duplicateEntryIds: new Set(), records: [], compactions: [], contextObservations: [], compactionObservations: [], parseErrors: 0 };
  }
  const records = [];
  const compactions = [];
  const contextObservations = [];
  const compactionObservations = [];
  const entryIds = new Set();
  const entrySignatures = new Map();
  const entryStates = new Map();
  const entryOrder = [];
  const entryPositions = new Map();
  const duplicateEntryIds = new Set();
  let header = null;
  let parseErrors = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { parseErrors += 1; continue; }
    if (entry.type === "session" && !header) {
      header = entry;
      continue;
    }
    const signature = typeof entry.id === "string" && entry.id.length > 0
      ? `${entry.type ?? ""}|${entry.parentId ?? ""}|${entry.timestamp ?? ""}`
      : null;
    if (signature) {
      if (entryIds.has(entry.id)) duplicateEntryIds.add(entry.id);
      entryIds.add(entry.id);
      entrySignatures.set(entry.id, signature);
      entryStates.set(entry.id, sessionEntryState(entry));
      entryPositions.set(entry.id, entryOrder.length);
      entryOrder.push(entry.id);
    }
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (entry.type === "compaction" && typeof entry.id === "string" && entry.id.length > 0 && Number.isFinite(timestamp)) {
      compactions.push({
        id: entry.id,
        signature,
        timestampMs: timestamp,
        tokensBefore: safeObservationInteger(entry.tokensBefore),
        fromHook: entry.fromHook === true ? true : entry.fromHook === false ? false : undefined,
      });
    }
    if (entry.type === "custom" && entry.customType === CONTEXT_OBSERVATION_TYPE) {
      const observation = normalizedContextObservation(entry.data);
      if (observation) contextObservations.push(observation);
    }
    if (entry.type === "custom" && entry.customType === COMPACTION_OBSERVATION_TYPE) {
      const observation = normalizedCompactionObservation(entry.data);
      if (observation) compactionObservations.push(observation);
    }
    const extracted = usageFromEntry(entry);
    if (!extracted) continue;
    const usage = normalizedUsage(extracted.usage);
    records.push({
      id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
      signature,
      kind: extracted.kind,
      usage,
      provider: typeof extracted.provider === "string" ? extracted.provider : null,
      model: typeof extracted.model === "string" ? extracted.model : null,
      timestampMs: Number.isFinite(timestamp) ? timestamp : null,
      sessionId: typeof header?.id === "string" ? header.id : null,
      cwd: typeof header?.cwd === "string" ? header.cwd : null,
      attributionConfidence: extracted.attributionConfidence,
      fromHook: extracted.fromHook,
    });
  }
  return { readable: true, header, entryIds, entrySignatures, entryStates, entryOrder, entryPositions, duplicateEntryIds, records, compactions, contextObservations, compactionObservations, parseErrors };
}

function usageProject(cwd, codeRoot = CODE_ROOT) {
  if (typeof cwd !== "string") return "UNATTRIBUTED";
  const resolved = path.resolve(cwd);
  const relative = path.relative(codeRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "UNATTRIBUTED";
  const [project] = relative.split(path.sep);
  return project && project !== "." ? project : "UNATTRIBUTED";
}

function safeUsageLabel(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().slice(0, 128);
}

function outputUsageTotals(totals) {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
    total: totals.totalTokens,
  };
}

function outputUsageCost(totals) {
  return {
    inputUsd: roundMetric(totals.cost.input),
    outputUsd: roundMetric(totals.cost.output),
    cacheReadUsd: roundMetric(totals.cost.cacheRead),
    cacheWriteUsd: roundMetric(totals.cost.cacheWrite),
    totalUsd: roundMetric(totals.cost.total),
  };
}

function effectiveUsdPerMillion(cost, tokens) {
  return tokens > 0 ? roundMetric(cost / tokens * 1_000_000) : null;
}

function effectiveCostPerMillion(totals) {
  return {
    inputUsd: effectiveUsdPerMillion(totals.cost.input, totals.input),
    outputUsd: effectiveUsdPerMillion(totals.cost.output, totals.output),
    cacheUsd: effectiveUsdPerMillion(totals.cost.cacheRead + totals.cost.cacheWrite, totals.cacheRead + totals.cacheWrite),
    totalUsd: effectiveUsdPerMillion(totals.cost.total, totals.totalTokens),
  };
}

function usageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    reasoningRecords: 0,
    costRecords: 0,
  };
}

function addUsageTotals(target, usage) {
  for (const field of USAGE_TOKEN_FIELDS) {
    if (field === "reasoning") {
      if (typeof usage.reasoning === "number") {
        target.reasoning += usage.reasoning;
        target.reasoningRecords += 1;
      }
      continue;
    }
    target[field] += usage[field];
  }
  for (const field of USAGE_COST_FIELDS) target.cost[field] += usage.cost[field];
  target.costRecords += 1;
}

function roundMetric(value) {
  return Math.round(value * 1e8) / 1e8;
}

function localStartOfDay(nowMs, daysAgo = 0) {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
}

function nearestRankP95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

function averageRounded(values) {
  return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function contextAnalytics(records, contextCompactions, startMs, endMs) {
  const assistants = records.filter((record) => record.kind === "assistant"
    && record.timestampMs !== null
    && (startMs === null || record.timestampMs >= startMs)
    && (endMs === null || record.timestampMs <= endMs)
    && record.usage);
  const requestValues = assistants.map((record) => record.usage.totalTokens).filter((value) => Number.isSafeInteger(value) && value >= 0);
  const runtimeRows = assistants.filter((record) => Number.isSafeInteger(record.runtimeContextTokens) && record.runtimeContextTokens >= 0);
  const runtimeValues = runtimeRows.map((record) => record.runtimeContextTokens);
  const policyRows = assistants.filter((record) => Number.isSafeInteger(record.contextWindowTokens)
    && record.contextWindowTokens >= 0
    && Number.isSafeInteger(record.compactionReserveTokens)
    && record.compactionReserveTokens >= 0
    && record.compactionReserveTokens <= record.contextWindowTokens);
  const policyTuples = new Set(policyRows.map((record) => `${record.contextWindowTokens}\u0000${record.compactionReserveTokens}`));
  const policyMode = assistants.length === 0 || policyRows.length === 0
    ? "UNKNOWN"
    : policyTuples.size > 1
      ? "MIXED"
      : policyRows.length < assistants.length ? "PARTIAL" : "KNOWN";
  const tuple = policyTuples.size === 1 ? [...policyTuples][0].split("\u0000").map(Number) : null;
  const contextWindowTokens = tuple?.[0] ?? null;
  const compactionReserveTokens = tuple?.[1] ?? null;
  const compactionThresholdTokens = tuple ? tuple[0] - tuple[1] : null;
  let runtimeOver80PercentCeiling = 0;
  let runtimeAboveCompactionThreshold = 0;
  for (const record of runtimeRows) {
    if (Number.isSafeInteger(record.contextWindowTokens) && record.contextWindowTokens >= 0 && record.runtimeContextTokens > 0.8 * record.contextWindowTokens) runtimeOver80PercentCeiling += 1;
    if (Number.isSafeInteger(record.contextWindowTokens) && record.contextWindowTokens >= 0
      && Number.isSafeInteger(record.compactionReserveTokens) && record.compactionReserveTokens >= 0
      && record.compactionReserveTokens <= record.contextWindowTokens
      && record.runtimeContextTokens > record.contextWindowTokens - record.compactionReserveTokens) runtimeAboveCompactionThreshold += 1;
  }
  const gpt56InputFootprintOver272K = assistants.filter((record) => /^gpt-5\.6-/i.test(record.model ?? "")
    && record.usage.input + record.usage.cacheRead + record.usage.cacheWrite > 272_000).length;
  const selectedCompactions = (contextCompactions ?? []).filter((compaction) => compaction.timestampMs !== null
    && (startMs === null || compaction.timestampMs >= startMs)
    && (endMs === null || compaction.timestampMs <= endMs));
  const compactionsByReason = { manual: 0, threshold: 0, overflow: 0, unknown: 0 };
  for (const compaction of selectedCompactions) compactionsByReason[COMPACTION_REASONS.has(compaction.reason) ? compaction.reason : "unknown"] += 1;
  return {
    assistantObservations: assistants.length,
    runtimeContextObservations: runtimeRows.length,
    knownPolicyObservations: policyRows.length,
    peakRequestContextTokens: requestValues.length ? Math.max(...requestValues) : null,
    p95RequestContextTokens: nearestRankP95(requestValues),
    averageRequestContextTokens: averageRounded(requestValues),
    peakRuntimeContextTokens: runtimeValues.length ? Math.max(...runtimeValues) : null,
    p95RuntimeContextTokens: nearestRankP95(runtimeValues),
    averageRuntimeContextTokens: averageRounded(runtimeValues),
    gpt56InputFootprintOver272K,
    runtimeOver80PercentCeiling,
    runtimeAboveCompactionThreshold,
    actualCompactions: selectedCompactions.length,
    compactionsByReason,
    policyMode,
    contextWindowTokens,
    compactionReserveTokens,
    compactionThresholdTokens,
  };
}

function aggregateUsageRecords(records, nowMs, startMs = null, endMs = nowMs, codeRoot = CODE_ROOT, contextCompactions = []) {
  const totals = usageTotals();
  const sessions = new Set();
  const models = new Map();
  const projects = new Map();
  let earliest = null;
  let latest = null;
  let unknownModelRecords = 0;
  let deterministicallyRecoveredRecords = 0;
  let unattributedProjectRecords = 0;
  const unattributedByKind = new Map();
  for (const record of records) {
    if (record.timestampMs === null || (startMs !== null && record.timestampMs < startMs) || (endMs !== null && record.timestampMs > endMs)) continue;
    if (!record.usage) continue;
    addUsageTotals(totals, record.usage);
    const sessionKey = record.sessionKey ?? record.sessionId;
    if (sessionKey) sessions.add(sessionKey);
    earliest = earliest === null ? record.timestampMs : Math.min(earliest, record.timestampMs);
    latest = latest === null ? record.timestampMs : Math.max(latest, record.timestampMs);
    const provider = safeUsageLabel(record.provider, "UNATTRIBUTED");
    const model = safeUsageLabel(record.model, "UNATTRIBUTED");
    const modelKey = `${provider}\u0000${model}`;
    if (provider === "UNATTRIBUTED" || model === "UNATTRIBUTED") {
      unknownModelRecords += 1;
      if (USAGE_RECORD_KINDS.includes(record.kind)) {
        unattributedByKind.set(record.kind, (unattributedByKind.get(record.kind) ?? 0) + 1);
      }
    }
    if (record.attributionConfidence === "DETERMINISTIC") deterministicallyRecoveredRecords += 1;
    const modelBucket = models.get(modelKey) ?? { provider, model, recordCount: 0, totals: usageTotals(), recordKinds: new Map() };
    modelBucket.recordCount += 1;
    if (USAGE_RECORD_KINDS.includes(record.kind)) modelBucket.recordKinds.set(record.kind, (modelBucket.recordKinds.get(record.kind) ?? 0) + 1);
    addUsageTotals(modelBucket.totals, record.usage);
    models.set(modelKey, modelBucket);
    const project = record.project ?? usageProject(record.cwd, codeRoot);
    if (project === "UNATTRIBUTED") unattributedProjectRecords += 1;
    const projectBucket = projects.get(project) ?? { project, recordCount: 0, totals: usageTotals() };
    projectBucket.recordCount += 1;
    addUsageTotals(projectBucket.totals, record.usage);
    projects.set(project, projectBucket);
  }
  const rows = (map) => [...map.values()].sort((left, right) => right.totals.totalTokens - left.totals.totalTokens || `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`));
  const outputKinds = (kinds) => USAGE_RECORD_KINDS.filter((kind) => kinds.get(kind)).map((kind) => ({ kind, recordCount: kinds.get(kind) }));
  const outputUnknownKinds = () => USAGE_RECORD_KINDS.filter((kind) => unattributedByKind.get(kind)).map((kind) => ({ kind, recordCount: unattributedByKind.get(kind) }));
  return {
    recordCount: records.filter((record) => record.timestampMs !== null && (startMs === null || record.timestampMs >= startMs) && (endMs === null || record.timestampMs <= endMs) && record.usage).length,
    sessionCount: sessions.size,
    dateRange: { start: earliest === null ? null : new Date(earliest).toISOString(), end: latest === null ? null : new Date(latest).toISOString() },
    tokens: outputUsageTotals(totals),
    cost: outputUsageCost(totals),
    byModel: rows(models).map((row) => ({ provider: row.provider, model: row.model, recordCount: row.recordCount, recordKinds: outputKinds(row.recordKinds), tokens: outputUsageTotals(row.totals), cost: outputUsageCost(row.totals), effectiveCostPerMillion: effectiveCostPerMillion(row.totals) })),
    deterministicallyRecoveredRecords,
    unattributedByKind: outputUnknownKinds(),
    byProject: rows(projects).map((row) => ({ project: row.project, recordCount: row.recordCount, tokens: outputUsageTotals(row.totals), cost: outputUsageCost(row.totals) })),
    reasoningRecords: totals.reasoningRecords,
    costRecords: totals.costRecords,
    unknownModelRecords,
    unattributedProjectRecords,
    context: contextAnalytics(records, contextCompactions, startMs, endMs),
  };
}

export function summarizeUsageRecords(records, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const codeRoot = options.codeRoot ?? CODE_ROOT;
  const contextCompactions = options.contextCompactions ?? [];
  const all = aggregateUsageRecords(records, nowMs, null, nowMs, codeRoot, contextCompactions);
  const windows = {
    today: aggregateUsageRecords(records, nowMs, localStartOfDay(nowMs), nowMs, codeRoot, contextCompactions),
    last7: aggregateUsageRecords(records, nowMs, localStartOfDay(nowMs, USAGE_WINDOW_DAYS.last7 - 1), nowMs, codeRoot, contextCompactions),
    last30: aggregateUsageRecords(records, nowMs, localStartOfDay(nowMs, USAGE_WINDOW_DAYS.last30 - 1), nowMs, codeRoot, contextCompactions),
    all,
  };
  return { nowMs, all, windows };
}

function legacyArtifacts(sessionRoot, codeRoot) {
  const scanState = { complete: true };
  const files = listSessionFiles(sessionRoot, [], scanState);
  const artifacts = [];
  let unreadableFiles = 0;
  let parseErrors = 0;
  let malformedUsageRecords = 0;
  for (const filePath of files) {
    const artifact = readUsageArtifact(filePath);
    if (!artifact.readable) { unreadableFiles += 1; continue; }
    parseErrors += artifact.parseErrors;
    malformedUsageRecords += artifact.records.filter((record) => record.usage === null).length;
    artifacts.push({ filePath: path.resolve(filePath), ...artifact });
  }
  return { files, artifacts, unreadableFiles, parseErrors, malformedUsageRecords, codeRoot, scanComplete: scanState.complete };
}

function artifactState(artifact, id) {
  if (artifact.entryStates instanceof Map) return artifact.entryStates.get(id) ?? null;
  return artifact.entryStates?.[id] ?? null;
}

function artifactHasDuplicateEntry(artifact, id) {
  if (artifact.duplicateEntryIds instanceof Set) return artifact.duplicateEntryIds.has(id);
  return (artifact.duplicateEntryKeys ?? []).includes(id);
}

function artifactEntryPosition(artifact, id) {
  if (artifact.entryPositions instanceof Map) return artifact.entryPositions.get(id) ?? null;
  const position = artifact.entryPositions?.[id];
  return Number.isInteger(position) ? position : null;
}

function stateParentId(state) {
  return state.parentId ?? state.parentIdKey ?? null;
}

function collectEffectiveModelPath(artifact, targetId) {
  const localStates = [];
  const seenEntryIds = new Set();
  let currentId = targetId;
  while (currentId) {
    if (seenEntryIds.has(currentId) || artifactHasDuplicateEntry(artifact, currentId)) return null;
    seenEntryIds.add(currentId);
    const state = artifactState(artifact, currentId);
    if (!state) return null;
    localStates.push(state);
    const parentId = stateParentId(state);
    if (parentId) {
      const childPosition = artifactEntryPosition(artifact, currentId);
      const parentPosition = artifactEntryPosition(artifact, parentId);
      if (childPosition === null || parentPosition === null || parentPosition >= childPosition) return null;
    }
    currentId = parentId;
  }
  return localStates.reverse();
}

function deterministicCompactionModel(record, artifact) {
  if (record.kind !== "compaction" || (record.fromHook !== undefined && record.fromHook !== false)) return null;
  const states = collectEffectiveModelPath(artifact, record.id ?? record.idKey);
  if (!states) return null;
  let effective = null;
  for (const state of states) {
    if (state.modelState === null || state.modelState === undefined) continue;
    if (!validString(state.modelState.provider) || !validString(state.modelState.model)) return null;
    effective = { provider: state.modelState.provider.trim(), model: state.modelState.model.trim() };
  }
  return effective;
}

function attributeRecord(record, artifact) {
  const model = deterministicCompactionModel(record, artifact);
  return model ? { ...record, provider: model.provider, model: model.model, attributionConfidence: "DETERMINISTIC" } : record;
}

function selectRecords(artifacts, codeRoot = CODE_ROOT) {
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.filePath, artifact]));
  const ancestorIds = new Map();
  function idsFromAncestors(artifact, visiting = new Set()) {
    if (ancestorIds.has(artifact.filePath)) return ancestorIds.get(artifact.filePath);
    if (visiting.has(artifact.filePath)) return new Map();
    visiting.add(artifact.filePath);
    const signatures = new Map();
    const parent = typeof artifact.header?.parentSession === "string" ? artifactByPath.get(path.resolve(artifact.header.parentSession)) : null;
    if (parent) {
      for (const [id, signature] of parent.entrySignatures) signatures.set(id, signature);
      for (const [id, signature] of idsFromAncestors(parent, visiting)) signatures.set(id, signature);
    }
    ancestorIds.set(artifact.filePath, signatures);
    return signatures;
  }
  const selectedRecords = [];
  const contextObservations = [];
  const compactionObservations = [];
  const contextCompactions = [];
  let rawUsageRecords = 0;
  let duplicateRecordsSuppressed = 0;
  let ambiguousRecordsExcluded = 0;
  let invalidTimestampRecords = 0;
  for (const artifact of artifacts) {
    const inheritedSignatures = idsFromAncestors(artifact);
    const contextByEntry = new Map();
    for (const observation of artifact.contextObservations ?? []) {
      contextObservations.push({ ...observation, sourcePath: artifact.filePath });
      if (!contextByEntry.has(observation.assistantEntryKeyHash)) contextByEntry.set(observation.assistantEntryKeyHash, observation);
    }
    for (const observation of artifact.compactionObservations ?? []) compactionObservations.push({ ...observation, sourcePath: artifact.filePath });
    for (const record of artifact.records) {
      rawUsageRecords += 1;
      if (!record.id || record.timestampMs === null || !record.usage) {
        ambiguousRecordsExcluded += 1;
        if (record.timestampMs === null) invalidTimestampRecords += 1;
        continue;
      }
      if (record.signature && inheritedSignatures.get(record.id) === record.signature) { duplicateRecordsSuppressed += 1; continue; }
      const attributed = attributeRecord(record, artifact);
      const observation = contextByEntry.get(safeEntryKey(record.id));
      selectedRecords.push({
        ...attributed,
        project: usageProject(record.cwd, codeRoot),
        sourcePath: artifact.filePath,
        runtimeContextTokens: observation?.runtimeContextTokens ?? null,
        contextWindowTokens: observation?.contextWindowTokens ?? null,
        compactionReserveTokens: observation?.compactionReserveTokens ?? null,
      });
    }
    for (const compaction of artifact.compactions ?? []) {
      if (!compaction.id || !compaction.signature || inheritedSignatures.get(compaction.id) === compaction.signature || artifactHasDuplicateEntry(artifact, compaction.id)) continue;
      const observations = (artifact.compactionObservations ?? []).filter((candidate) => candidate.compactionEntryKeyHash === safeEntryKey(compaction.id));
      const observation = observations[0] ?? null;
      const attributed = attributeRecord({ kind: "compaction", id: compaction.id, fromHook: compaction.fromHook, provider: null, model: null }, artifact);
      contextCompactions.push({
        compactionEntryKeyHash: safeEntryKey(compaction.id),
        timestampMs: compaction.timestampMs,
        tokensBefore: compaction.tokensBefore,
        provider: attributed.provider ?? observation?.provider ?? null,
        model: attributed.model ?? observation?.model ?? null,
        project: usageProject(artifact.header?.cwd, codeRoot),
        reason: observation?.reason ?? null,
        contextWindowTokens: observation?.contextWindowTokens ?? null,
        compactionReserveTokens: observation?.compactionReserveTokens ?? null,
        sourcePath: artifact.filePath,
        sessionId: typeof artifact.header?.id === "string" ? artifact.header.id : null,
        observations,
      });
    }
  }
  return { selectedRecords, contextObservations, compactionObservations, contextCompactions, rawUsageRecords, duplicateRecordsSuppressed, ambiguousRecordsExcluded, invalidTimestampRecords };
}

export function usageResultFromRecords(records, metadata, selectedWindow, options = {}) {
  const summary = summarizeUsageRecords(records, { nowMs: options.nowMs, codeRoot: options.codeRoot, contextCompactions: options.contextCompactions });
  const selected = summary.windows[selectedWindow] ?? summary.all;
  const costAvailable = selected.recordCount > 0 && selected.costRecords === selected.recordCount;
  const reasoningAvailable = selected.recordCount > 0 && selected.reasoningRecords > 0;
  const unknownProjectRecords = selected.unattributedProjectRecords;
  return {
    source: "Pi JSONL session artifacts under ~/.pi/agent/sessions; usage-bearing entries only",
    selectedWindow: summary.windows[selectedWindow] ? selectedWindow : "all",
    windowLabels: { today: "Today", last7: "Last 7 days", last30: "Last 30 days", all: "All available evidence" },
    windows: Object.fromEntries(Object.entries(summary.windows).map(([id, value]) => [id, value])),
    selected,
    scope: {
      classification: "LOCAL_EVIDENCE_ONLY",
      sessionFilesDiscovered: metadata.sessionFilesDiscovered,
      sessionFilesScanned: metadata.sessionFilesScanned,
      unreadableFiles: metadata.unreadableFiles,
      parseErrors: metadata.parseErrors,
      malformedUsageRecords: metadata.malformedUsageRecords,
      rawUsageRecords: metadata.rawUsageRecords,
      selectedRecords: records.length,
      duplicateRecordsSuppressed: metadata.duplicateRecordsSuppressed,
      ambiguousRecordsExcluded: metadata.ambiguousRecordsExcluded,
      invalidTimestampRecords: metadata.invalidTimestampRecords,
      dateRange: summary.all.dateRange,
      note: "Totals represent usage persisted in discovered Pi session artifacts, not account-wide or provider billing usage.",
    },
    tokenCategories: [
      { key: "input", status: "SUPPORTED", note: "Pi Usage.input." },
      { key: "output", status: "SUPPORTED", note: "Pi Usage.output." },
      { key: "cacheRead", status: "SUPPORTED", note: "Pi Usage.cacheRead." },
      { key: "cacheWrite", status: "SUPPORTED", note: "Pi Usage.cacheWrite." },
      { key: "reasoning", status: reasoningAvailable ? "SUPPORTED_SCOPED" : "UNSUPPORTED", note: "Provider-reported reasoning tokens; a subset of output, not additive." },
      { key: "total", status: "SUPPORTED", note: "Pi-persisted totalTokens; Pi session totals sum input, output, cacheRead, and cacheWrite." },
    ],
    cost: costAvailable ? {
      status: "SUPPORTED_SCOPED",
      currency: "USD",
      amount: selected.cost.totalUsd,
      source: "Pi-persisted Usage.cost, computed by pi-ai model pricing at request time",
      note: "This is scoped Pi-computed cost, not provider billing or account-complete cost.",
    } : {
      status: "UNSUPPORTED",
      currency: null,
      amount: null,
      source: "Pi session Usage.cost",
      note: "Complete authoritative cost metadata was not available for the selected records.",
    },
    modelAttribution: {
      status: "SUPPORTED_SCOPED",
      unknownRecords: selected.unknownModelRecords,
      deterministicallyRecoveredRecords: selected.deterministicallyRecoveredRecords,
      unattributedByKind: selected.unattributedByKind,
      note: "Assistant records use direct persisted provider/model metadata; eligible standard compactions use deterministic persisted effective-model state; toolResult and branch_summary usage remains UNATTRIBUTED rather than guessed.",
    },
    projectAttribution: {
      status: "SUPPORTED_SCOPED",
      unattributedRecords: unknownProjectRecords,
      note: "Only cwd values under ~/code/<project> are mapped to the first project directory; other cwd values remain UNATTRIBUTED.",
    },
    roleAttribution: {
      status: "UNSUPPORTED",
      note: "Pi session usage records do not provide a reliable deduplicated pi-subagents role or agent-type dimension.",
    },
    completeness: {
      classification: metadata.parseErrors > 0 || metadata.ambiguousRecordsExcluded > 0 ? "PARTIAL" : "COMPLETE_FOR_DISCOVERED_ARTIFACTS",
      accountComplete: "UNSUPPORTED",
      note: "The dashboard scans the discovered local Pi session scope on demand. Missing, malformed, fork-duplicated, or process-local usage outside that scope is not represented.",
    },
    limitations: [
      "Local Pi session artifacts are historical evidence, not a live usage feed.",
      "pi-subagents lifecycle status totals are a duplicate view of child work and are not aggregated with Pi sessions.",
      "Forked session copies are deduplicated only through Pi's parentSession relationship and stable entry IDs; unrelated ID collisions are not merged.",
      "No provider billing API, current pricing lookup, or estimated historical billing is used.",
      "Prompt, response, tool, transcript, session identity, and filesystem path content is never returned.",
    ],
  };
}

export function discoverUsageSources(options = {}) {
  const sessionRoot = path.resolve(options.sessionRoot ?? SESSION_ROOT);
  const codeRoot = path.resolve(options.codeRoot ?? CODE_ROOT);
  const scanState = { complete: true };
  const files = listSessionFiles(sessionRoot, [], scanState);
  const sources = [];
  for (const filePath of files) {
    try {
      const absolute = path.resolve(filePath);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      sources.push({
        filePath: absolute,
        pathKey: safePathKey(absolute, sessionRoot),
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
      });
    } catch {
      scanState.complete = false;
    }
  }
  return { sessionRoot, codeRoot, files, sources, scanComplete: scanState.complete };
}

export function selectUsageRecords(artifacts, codeRoot = CODE_ROOT) {
  return selectRecords(artifacts, codeRoot);
}

export function collectUsageEvidence(options = {}) {
  const sessionRoot = path.resolve(options.sessionRoot ?? SESSION_ROOT);
  const codeRoot = path.resolve(options.codeRoot ?? CODE_ROOT);
  const collected = legacyArtifacts(sessionRoot, codeRoot);
  const selection = selectRecords(collected.artifacts, codeRoot);
  return { sessionRoot, codeRoot, collected, selection };
}

export function collectLegacyUsage(selectedWindow = "all", options = {}) {
  const { sessionRoot, codeRoot, collected, selection } = collectUsageEvidence(options);
  const usage = usageResultFromRecords(selection.selectedRecords, {
    sessionFilesDiscovered: collected.files.length,
    sessionFilesScanned: collected.artifacts.length,
    unreadableFiles: collected.unreadableFiles,
    parseErrors: collected.parseErrors,
    malformedUsageRecords: collected.malformedUsageRecords,
    rawUsageRecords: selection.rawUsageRecords,
    duplicateRecordsSuppressed: selection.duplicateRecordsSuppressed,
    ambiguousRecordsExcluded: selection.ambiguousRecordsExcluded,
    invalidTimestampRecords: selection.invalidTimestampRecords,
  }, selectedWindow, { nowMs: options.nowMs, codeRoot, contextCompactions: selection.contextCompactions });
  usage.generatedAt = new Date().toISOString();
  usage.performance = {
    sourceFilesScanned: collected.artifacts.length,
    inMemoryOnly: true,
    persistence: "NONE",
    indexBackend: "LEGACY_FULL_SCAN",
    indexState: "FALLBACK_LEGACY",
    sourceFilesDiscovered: collected.files.length,
    sourceFilesReused: 0,
    sourceFilesReindexed: collected.artifacts.length,
    sourceFilesRemoved: 0,
    sourceBytesReindexed: collected.files.reduce((total, filePath) => {
      try { return total + fs.statSync(filePath).size; } catch { return total; }
    }, 0),
    databaseSizeBytes: 0,
    rebuildReason: options.fallbackReason ?? "SQLITE_UNAVAILABLE",
  };
  return usage;
}

function privateUserId() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isOwnedByCurrentUser(stat) {
  const uid = privateUserId();
  return uid === null || Number(stat.uid) === uid;
}

function ensurePrivateDirectory(directory) {
  try {
    const link = fs.lstatSync(directory);
    if (!link.isDirectory() || link.isSymbolicLink()) return false;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { return false; }
  }
  try {
    const stat = fs.statSync(directory);
    return stat.isDirectory() && isOwnedByCurrentUser(stat) && (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function safeDatabaseTarget(databasePath, create = false) {
  try {
    const link = fs.lstatSync(databasePath);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    const stat = fs.statSync(databasePath);
    return isOwnedByCurrentUser(stat) && (stat.mode & 0o777) === 0o600;
  } catch (error) {
    if (error.code !== "ENOENT" || !create) return false;
    return true;
  }
}

export function resolveUsageIndexLocation(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? HOME;
  let cacheRoot = options.cacheRoot;
  if (!cacheRoot) {
    const xdg = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim() ? env.XDG_CACHE_HOME.trim() : null;
    cacheRoot = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
  }
  const directory = path.join(cacheRoot, INDEX_DIRECTORY_NAME);
  return { directory, databasePath: path.join(directory, DATABASE_NAME) };
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error("not a regular file");
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: stat.mode.toString(),
  };
}

function fingerprintKey(value) {
  return [value.device, value.inode, value.size, value.mtimeNs, value.ctimeNs, value.mode].join(":");
}

function currentSources(sessionRoot, codeRoot) {
  const files = listSessionFiles(sessionRoot);
  const sources = new Map();
  for (const filePath of files) {
    try {
      const absolute = path.resolve(filePath);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const metadata = fingerprint(absolute);
      const fileKey = safePathKey(absolute, sessionRoot);
      sources.set(fileKey, { fileKey, filePath: absolute, fingerprint: metadata, fingerprintKey: fingerprintKey(metadata), size: Number(metadata.size), codeRoot });
    } catch {
      // The source may disappear during a concurrent scan; it is omitted from this generation.
    }
  }
  return { files, sources };
}

function safeArtifact(filePath, rawArtifact, source, sessionRoot, codeRoot) {
  const header = rawArtifact.header;
  const sessionKey = safeSessionKey(header?.id);
  const parentSessionPath = typeof header?.parentSession === "string" ? path.resolve(header.parentSession) : null;
  const parentFileKey = parentSessionPath ? safePathKey(parentSessionPath, sessionRoot) : null;
  const entrySignatures = {};
  for (const [id, signature] of rawArtifact.entrySignatures) {
    const idKey = safeEntryKey(id);
    if (idKey) entrySignatures[idKey] = safeSignatureKey(signature);
  }
  const entryStates = {};
  for (const [id, state] of rawArtifact.entryStates) {
    const idKey = safeEntryKey(id);
    if (!idKey) continue;
    entryStates[idKey] = {
      type: state.type,
      parentIdKey: safeEntryKey(state.parentId),
      role: state.role,
      modelState: state.modelState ? {
        provider: safeUsageLabel(state.modelState.provider, null),
        model: safeUsageLabel(state.modelState.model, null),
      } : null,
    };
  }
  const records = rawArtifact.records.map((record) => ({
    idKey: safeEntryKey(record.id),
    signatureKey: safeSignatureKey(record.signature),
    kind: record.kind,
    usage: record.usage,
    provider: record.provider,
    model: record.model,
    timestampMs: record.timestampMs,
    attributionConfidence: record.attributionConfidence,
    fromHook: record.fromHook,
    sessionKey,
    project: usageProject(record.cwd, codeRoot),
  }));
  const contextObservations = (rawArtifact.contextObservations ?? []).map((observation) => ({ ...observation }));
  const compactionObservations = (rawArtifact.compactionObservations ?? []).map((observation) => ({ ...observation }));
  const compactions = (rawArtifact.compactions ?? []).map((compaction) => ({
    entryKeyHash: safeEntryKey(compaction.id),
    signatureKey: safeSignatureKey(compaction.signature),
    timestampMs: compaction.timestampMs,
    tokensBefore: compaction.tokensBefore,
    fromHook: compaction.fromHook,
  })).filter((compaction) => compaction.entryKeyHash && compaction.signatureKey && Number.isFinite(compaction.timestampMs));
  return {
    fileKey: source.fileKey,
    sessionKey,
    project: usageProject(header?.cwd, codeRoot),
    parentFileKey,
    entrySignatures,
    entryStates,
    entryOrder: rawArtifact.entryOrder.map(safeEntryKey).filter(Boolean),
    entryPositions: Object.fromEntries([...rawArtifact.entryPositions].filter(([key, value]) => safeEntryKey(key) && Number.isInteger(value)).map(([key, value]) => [safeEntryKey(key), value])),
    attributionMetadataVersion: 2,
    duplicateEntryKeys: [...rawArtifact.duplicateEntryIds].map(safeEntryKey).filter(Boolean),
    records,
    contextObservations,
    compactionObservations,
    compactions,
    readable: rawArtifact.readable,
    parseErrors: rawArtifact.parseErrors,
    malformedUsageRecords: rawArtifact.records.filter((record) => record.usage === null).length,
    sourceSize: source.size,
  };
}

function deserializeArtifact(json) {
  const artifact = JSON.parse(json);
  return {
    ...artifact,
    entrySignatures: artifact.entrySignatures ?? {},
    entryStates: artifact.entryStates ?? {},
    entryOrder: artifact.entryOrder ?? [],
    entryPositions: artifact.entryPositions ?? {},
    attributionMetadataVersion: artifact.attributionMetadataVersion ?? 0,
    duplicateEntryKeys: artifact.duplicateEntryKeys ?? [],
    contextObservations: artifact.contextObservations ?? [],
    compactionObservations: artifact.compactionObservations ?? [],
    compactions: artifact.compactions ?? [],
  };
}

function serializeArtifact(artifact) {
  const entrySignatures = artifact.entrySignatures instanceof Map
    ? Object.fromEntries(artifact.entrySignatures)
    : artifact.entrySignatures ?? {};
  return JSON.stringify({ ...artifact, entrySignatures });
}

function sqliteError(message, code = "INDEX_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function databaseSize(databasePath) {
  try { return fs.statSync(databasePath).size; } catch { return 0; }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_files (
      file_key TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      inode TEXT NOT NULL,
      size TEXT NOT NULL,
      mtime_ns TEXT NOT NULL,
      ctime_ns TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_generation INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS aggregate_snapshot (
      snapshot_key TEXT PRIMARY KEY,
      source_generation INTEGER NOT NULL,
      window_context TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

function metadataMap(db) {
  return new Map(db.prepare("SELECT key, value FROM index_meta").all().map((row) => [row.key, row.value]));
}

function writeMeta(db, values) {
  const statement = db.prepare("INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function validateVersions(db) {
  const meta = metadataMap(db);
  if (meta.get("application") !== APPLICATION_NAME) throw sqliteError("unrecognized application database", "UNSAFE_INDEX");
  const mismatch = ["schema", "extractor", "aggregator"].filter((key) => meta.get(key) !== USAGE_INDEX_VERSIONS[key]);
  if (mismatch.length > 0) throw sqliteError(mismatch.join(","), "VERSION_MISMATCH");
  return meta;
}

function openDatabase(location) {
  if (!sqliteAvailable()) throw sqliteError("node:sqlite unavailable", "SQLITE_UNSUPPORTED");
  if (!ensurePrivateDirectory(location.directory) || !safeDatabaseTarget(location.databasePath, true)) throw sqliteError("unsafe index location", "UNSAFE_INDEX");
  let db;
  const existed = fs.existsSync(location.databasePath);
  try {
    db = new DatabaseSync(location.databasePath);
    const applicationId = db.prepare("PRAGMA application_id").get().application_id;
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) throw sqliteError("wrong SQLite application identity", "UNSAFE_INDEX");
    if (applicationId === 0) {
      if (existed) throw sqliteError("unmarked SQLite database", "UNSAFE_INDEX");
      db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    }
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
    createSchema(db);
    const meta = metadataMap(db);
    if (meta.size > 0) validateVersions(db);
    writeMeta(db, { application: APPLICATION_NAME, schema: INDEX_SCHEMA_VERSION, extractor: EXTRACTOR_VERSION, aggregator: AGGREGATOR_VERSION });
    fs.chmodSync(location.databasePath, 0o600);
    if (!safeDatabaseTarget(location.databasePath, false)) throw sqliteError("unsafe database permissions", "UNSAFE_INDEX");
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* best effort */ }
    throw error;
  }
}

function closeDatabase(db) {
  try { db.close(); } catch { /* best effort */ }
}

function readStoredSources(db, includeArtifacts = false) {
  const columns = includeArtifacts ? "*" : "file_key, device, inode, size, mtime_ns, ctime_ns, mode, source_generation";
  const rows = db.prepare(`SELECT ${columns} FROM source_files`).all();
  return new Map(rows.map((row) => [row.file_key, {
    fileKey: row.file_key,
    fingerprint: { device: row.device, inode: row.inode, size: row.size, mtimeNs: row.mtime_ns, ctimeNs: row.ctime_ns, mode: row.mode },
    fingerprintKey: [row.device, row.inode, row.size, row.mtime_ns, row.ctime_ns, row.mode].join(":"),
    sourceGeneration: Number(row.source_generation),
    ...(includeArtifacts ? { artifact: deserializeArtifact(row.artifact_json) } : {}),
  }]));
}

function readStoredSnapshot(db, generation, context) {
  const row = db.prepare("SELECT payload_json FROM aggregate_snapshot WHERE snapshot_key = ? AND source_generation = ? AND window_context = ?").get("usage", generation, context);
  return row ? JSON.parse(row.payload_json) : null;
}

function allStoredArtifacts(sources) {
  return [...sources.values()].map((source) => source.artifact);
}

function indexedSelectRecords(artifacts) {
  const byKey = new Map(artifacts.map((artifact) => [artifact.fileKey, artifact]));
  const inherited = new Map();
  function getInheritedSignatures(artifact, visiting = new Set()) {
    if (inherited.has(artifact.fileKey)) return inherited.get(artifact.fileKey);
    if (visiting.has(artifact.fileKey)) return new Map();
    visiting.add(artifact.fileKey);
    const result = new Map();
    const parent = artifact.parentFileKey ? byKey.get(artifact.parentFileKey) : null;
    if (parent) {
      for (const [id, signature] of Object.entries(parent.entrySignatures)) result.set(id, signature);
      for (const [id, signature] of getInheritedSignatures(parent, visiting)) result.set(id, signature);
    }
    inherited.set(artifact.fileKey, result);
    return result;
  }
  const records = [];
  const contextCompactions = [];
  let rawUsageRecords = 0;
  let duplicateRecordsSuppressed = 0;
  let ambiguousRecordsExcluded = 0;
  let invalidTimestampRecords = 0;
  let unreadableFiles = 0;
  let parseErrors = 0;
  let malformedUsageRecords = 0;
  for (const artifact of artifacts) {
    if (!artifact.readable) unreadableFiles += 1;
    parseErrors += artifact.parseErrors;
    malformedUsageRecords += artifact.malformedUsageRecords;
    const inheritedSignatures = getInheritedSignatures(artifact);
    const contextByEntry = new Map((artifact.contextObservations ?? []).map((observation) => [observation.assistantEntryKeyHash, observation]));
    for (const record of artifact.records) {
      rawUsageRecords += 1;
      if (!record.idKey || record.timestampMs === null || !record.usage) {
        ambiguousRecordsExcluded += 1;
        if (record.timestampMs === null) invalidTimestampRecords += 1;
        continue;
      }
      if (record.signatureKey && inheritedSignatures.get(record.idKey) === record.signatureKey) {
        duplicateRecordsSuppressed += 1;
        continue;
      }
      const observation = contextByEntry.get(record.idKey);
      records.push({
        ...attributeRecord(record, artifact),
        runtimeContextTokens: observation?.runtimeContextTokens ?? null,
        contextWindowTokens: observation?.contextWindowTokens ?? null,
        compactionReserveTokens: observation?.compactionReserveTokens ?? null,
      });
    }
    for (const compaction of artifact.compactions ?? []) {
      if (!compaction.entryKeyHash || !compaction.signatureKey || inheritedSignatures.get(compaction.entryKeyHash) === compaction.signatureKey || artifact.duplicateEntryKeys.includes(compaction.entryKeyHash)) continue;
      const observations = (artifact.compactionObservations ?? []).filter((candidate) => candidate.compactionEntryKeyHash === compaction.entryKeyHash);
      const observation = observations[0] ?? null;
      const attributed = attributeRecord({ kind: "compaction", idKey: compaction.entryKeyHash, fromHook: compaction.fromHook, provider: null, model: null }, artifact);
      contextCompactions.push({
        compactionEntryKeyHash: compaction.entryKeyHash,
        timestampMs: compaction.timestampMs,
        tokensBefore: compaction.tokensBefore,
        provider: attributed.provider ?? observation?.provider ?? null,
        model: attributed.model ?? observation?.model ?? null,
        project: artifact.project ?? "UNATTRIBUTED",
        reason: observation?.reason ?? null,
        contextWindowTokens: observation?.contextWindowTokens ?? null,
        compactionReserveTokens: observation?.compactionReserveTokens ?? null,
        observations,
      });
    }
  }
  return { records, contextCompactions, rawUsageRecords, duplicateRecordsSuppressed, ambiguousRecordsExcluded, invalidTimestampRecords, unreadableFiles, parseErrors, malformedUsageRecords };
}

function localWindowContext(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}|${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function rebuildOwnedDatabase(location) {
  if (!safeDatabaseTarget(location.databasePath, false)) throw sqliteError("database ownership could not be established", "UNSAFE_INDEX");
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${location.databasePath}${suffix}`;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || !isOwnedByCurrentUser(stat)) throw sqliteError("unsafe derived database sidecar", "UNSAFE_INDEX");
      fs.rmSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeSourceRow(db, source, artifact, generation) {
  db.prepare(`INSERT INTO source_files(file_key, device, inode, size, mtime_ns, ctime_ns, mode, source_generation, artifact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_key) DO UPDATE SET device=excluded.device, inode=excluded.inode, size=excluded.size, mtime_ns=excluded.mtime_ns, ctime_ns=excluded.ctime_ns, mode=excluded.mode, source_generation=excluded.source_generation, artifact_json=excluded.artifact_json`)
    .run(source.fileKey, source.fingerprint.device, source.fingerprint.inode, source.fingerprint.size, source.fingerprint.mtimeNs, source.fingerprint.ctimeNs, source.fingerprint.mode, generation, serializeArtifact(artifact));
}

function writeSnapshot(db, generation, context, payload) {
  db.prepare(`INSERT INTO aggregate_snapshot(snapshot_key, source_generation, window_context, payload_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(snapshot_key) DO UPDATE SET source_generation=excluded.source_generation, window_context=excluded.window_context, payload_json=excluded.payload_json`)
    .run("usage", generation, context, JSON.stringify(payload));
}

function buildSnapshot(artifacts, metadata, options) {
  const selection = indexedSelectRecords(artifacts);
  const summary = summarizeUsageRecords(selection.records, { nowMs: options.nowMs, codeRoot: options.codeRoot, contextCompactions: selection.contextCompactions });
  return {
    windows: summary.windows,
    contextCompactions: selection.contextCompactions.map((compaction) => ({
      compactionEntryKeyHash: compaction.compactionEntryKeyHash,
      timestampMs: compaction.timestampMs,
      tokensBefore: compaction.tokensBefore,
      provider: compaction.provider,
      model: compaction.model,
      project: compaction.project,
      reason: compaction.reason ?? null,
      contextWindowTokens: compaction.contextWindowTokens ?? null,
      compactionReserveTokens: compaction.compactionReserveTokens ?? null,
      observations: compaction.observations ?? [],
    })),
    scope: {
      classification: "LOCAL_EVIDENCE_ONLY",
      sessionFilesDiscovered: metadata.sessionFilesDiscovered,
      sessionFilesScanned: artifacts.length,
      unreadableFiles: selection.unreadableFiles,
      parseErrors: selection.parseErrors,
      malformedUsageRecords: selection.malformedUsageRecords,
      rawUsageRecords: selection.rawUsageRecords,
      selectedRecords: selection.records.length,
      duplicateRecordsSuppressed: selection.duplicateRecordsSuppressed,
      ambiguousRecordsExcluded: selection.ambiguousRecordsExcluded,
      invalidTimestampRecords: selection.invalidTimestampRecords,
      dateRange: summary.all.dateRange,
      note: "Totals represent usage persisted in discovered Pi session artifacts, not account-wide or provider billing usage.",
    },
  };
}

function indexedMetadataPayload(snapshot, selectedWindow, performanceMetadata, options) {
  const selected = snapshot.windows[selectedWindow] ? selectedWindow : "all";
  const selectedBucket = snapshot.windows[selected];
  const usage = usageResultFromRecords([], {
    ...snapshot.scope,
    selectedRecords: snapshot.scope.selectedRecords,
  }, selected, options);
  usage.windows = snapshot.windows;
  usage.selected = selectedBucket;
  usage.selectedWindow = selected;
  usage.scope = snapshot.scope;
  const costAvailable = selectedBucket.recordCount > 0 && selectedBucket.costRecords === selectedBucket.recordCount;
  usage.tokenCategories = usage.tokenCategories.map((category) => category.key === "reasoning"
    ? { ...category, status: selectedBucket.reasoningRecords > 0 ? "SUPPORTED_SCOPED" : "UNSUPPORTED" }
    : category);
  usage.cost = costAvailable ? {
    status: "SUPPORTED_SCOPED",
    currency: "USD",
    amount: selectedBucket.cost.totalUsd,
    source: "Pi-persisted Usage.cost, computed by pi-ai model pricing at request time",
    note: "This is scoped Pi-computed cost, not provider billing or account-complete cost.",
  } : {
    status: "UNSUPPORTED",
    currency: null,
    amount: null,
    source: "Pi session Usage.cost",
    note: "Complete authoritative cost metadata was not available for the selected records.",
  };
  usage.modelAttribution = {
    status: "SUPPORTED_SCOPED",
    unknownRecords: selectedBucket.unknownModelRecords,
    deterministicallyRecoveredRecords: selectedBucket.deterministicallyRecoveredRecords,
    unattributedByKind: selectedBucket.unattributedByKind,
    note: "Assistant records use direct persisted provider/model metadata; eligible standard compactions use deterministic persisted effective-model state; toolResult and branch_summary usage remains UNATTRIBUTED rather than guessed.",
  };
  usage.projectAttribution = {
    status: "SUPPORTED_SCOPED",
    unattributedRecords: selectedBucket.unattributedProjectRecords,
    note: "Only cwd values under ~/code/<project> are mapped to the first project directory; other cwd values remain UNATTRIBUTED.",
  };
  usage.completeness = {
    classification: snapshot.scope.parseErrors > 0 || snapshot.scope.ambiguousRecordsExcluded > 0 ? "PARTIAL" : "COMPLETE_FOR_DISCOVERED_ARTIFACTS",
    accountComplete: "UNSUPPORTED",
    note: "The dashboard scans the discovered local Pi session scope on demand. Missing, malformed, fork-duplicated, or process-local usage outside that scope is not represented.",
  };
  usage.generatedAt = new Date().toISOString();
  usage.performance = performanceMetadata;
  return usage;
}

function fallback(selectedWindow, options, reason) {
  return collectLegacyUsage(selectedWindow, { ...options, fallbackReason: reason });
}

function collectDerivedUsage(selectedWindow = "all", options = {}) {
  if (options.forceLegacy) return fallback(selectedWindow, options, "FORCED_LEGACY_TEST_PATH");
  if (!sqliteAvailable()) return fallback(selectedWindow, options, "SQLITE_UNSUPPORTED");
  const sessionRoot = path.resolve(options.sessionRoot ?? SESSION_ROOT);
  const codeRoot = path.resolve(options.codeRoot ?? CODE_ROOT);
  const location = options.indexDirectory
    ? { directory: path.resolve(options.indexDirectory), databasePath: path.join(path.resolve(options.indexDirectory), DATABASE_NAME) }
    : resolveUsageIndexLocation(options);
  let db;
  try {
    try {
      db = openDatabase(location);
    } catch (error) {
      if (error.code === "VERSION_MISMATCH") {
        rebuildOwnedDatabase(location);
        db = openDatabase(location);
      } else {
        throw error;
      }
    }
    const current = currentSources(sessionRoot, codeRoot);
    const stored = readStoredSources(db, true);
    const attributionMetadataMissing = [...stored.values()].some(({ artifact }) => artifact?.readable && artifact.attributionMetadataVersion !== 2);
    const changed = [];
    let removed = 0;
    for (const source of current.sources.values()) {
      const previous = stored.get(source.fileKey);
      if (!previous || previous.fingerprintKey !== source.fingerprintKey) changed.push(source);
    }
    for (const fileKey of stored.keys()) {
      if (!current.sources.has(fileKey)) removed += 1;
    }
    if (attributionMetadataMissing) {
      for (const source of current.sources.values()) {
        if (!changed.some((candidate) => candidate.fileKey === source.fileKey)) changed.push(source);
      }
    }
    const meta = metadataMap(db);
    let generation = Number(meta.get("sourceGeneration") ?? 0);
    const sourceChanged = changed.length > 0 || removed > 0 || stored.size !== current.sources.size || attributionMetadataMissing;
    if (sourceChanged) generation += 1;
    const context = localWindowContext(options.nowMs ?? Date.now());
    const snapshot = !sourceChanged ? readStoredSnapshot(db, generation, context) : null;
    if (snapshot) {
      const performanceMetadata = {
        sourceFilesScanned: current.sources.size,
        inMemoryOnly: false,
        persistence: "DERIVED_SQLITE",
        indexBackend: "SQLITE_DERIVED",
        indexState: "READY",
        sourceFilesDiscovered: current.files.length,
        sourceFilesReused: current.sources.size,
        sourceFilesReindexed: 0,
        sourceFilesRemoved: 0,
        sourceBytesReindexed: 0,
        databaseSizeBytes: databaseSize(location.databasePath),
        rebuildReason: null,
      };
      return indexedMetadataPayload(snapshot, selectedWindow, performanceMetadata, { nowMs: options.nowMs, codeRoot });
    }
    const working = new Map(readStoredSources(db, true));
    const reindexed = [];
    for (const source of changed) {
      const raw = readUsageArtifact(source.filePath);
      const artifact = safeArtifact(source.filePath, raw, source, sessionRoot, codeRoot);
      working.set(source.fileKey, { ...source, artifact, sourceGeneration: generation });
      reindexed.push(source);
    }
    for (const fileKey of stored.keys()) if (!current.sources.has(fileKey)) working.delete(fileKey);
    const allArtifacts = allStoredArtifacts(working);
    const metadata = { sessionFilesDiscovered: current.files.length };
      const nextSnapshot = buildSnapshot(allArtifacts, metadata, { nowMs: options.nowMs, codeRoot });
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of reindexed) writeSourceRow(db, source, working.get(source.fileKey).artifact, generation);
      for (const fileKey of stored.keys()) if (!current.sources.has(fileKey)) db.prepare("DELETE FROM source_files WHERE file_key = ?").run(fileKey);
      writeMeta(db, { sourceGeneration: generation });
      writeSnapshot(db, generation, context, nextSnapshot);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
    const performanceMetadata = {
      sourceFilesScanned: current.sources.size,
      inMemoryOnly: false,
      persistence: "DERIVED_SQLITE",
      indexBackend: "SQLITE_DERIVED",
      indexState: sourceChanged ? (stored.size === 0 ? "REBUILT" : "RECONCILED") : "RECONCILED",
      sourceFilesDiscovered: current.files.length,
      sourceFilesReused: Math.max(0, current.sources.size - reindexed.length),
      sourceFilesReindexed: reindexed.length,
      sourceFilesRemoved: removed,
      sourceBytesReindexed: reindexed.reduce((total, source) => total + source.size, 0),
      databaseSizeBytes: databaseSize(location.databasePath),
      rebuildReason: stored.size === 0 ? "INITIAL_BUILD" : (attributionMetadataMissing ? "ATTRIBUTION_METADATA_REBUILD" : (sourceChanged ? "SOURCE_CHANGE" : "WINDOW_CONTEXT_CHANGE")),
    };
    return indexedMetadataPayload(nextSnapshot, selectedWindow, performanceMetadata, { nowMs: options.nowMs, codeRoot });
  } catch (error) {
    const reason = error?.code === "VERSION_MISMATCH" ? "VERSION_MISMATCH" : (error?.code === "UNSAFE_INDEX" ? "UNSAFE_INDEX_FALLBACK" : (error?.code === "SQLITE_UNSUPPORTED" ? "SQLITE_UNSUPPORTED" : "SQLITE_ERROR_FALLBACK"));
    return fallback(selectedWindow, { ...options, sessionRoot, codeRoot }, reason);
  } finally {
    closeDatabase(db);
  }
}

export function collectIndexedUsage(selectedWindow = "all", options = {}) {
  if (!options.indexDirectory && !options.forceLegacy) {
    const durable = collectDurableUsage(selectedWindow, options);
    if (durable) return durable;
    return collectLegacyUsage(selectedWindow, { ...options, fallbackReason: "DURABLE_HISTORY_NOT_READY" });
  }
  return collectDerivedUsage(selectedWindow, options);
}

export function usageIndexDiagnostics(usage) {
  const performance = usage?.performance;
  if (!performance || performance.indexBackend === "LEGACY_FULL_SCAN") {
    return {
      status: performance?.rebuildReason === "SQLITE_UNSUPPORTED" ? "UNSUPPORTED" : "FALLBACK_LEGACY",
      explanation: "The legacy Usage collector was used because the durable or derived SQLite index was unavailable or not ready.",
    };
  }
  if (performance.persistence === "DURABLE_SQLITE") {
    return {
      status: performance.historyState === "READY" ? "PASS" : "WARN",
      explanation: performance.historyState === "READY"
        ? "Usage analytics are served from private durable local history derived from Pi JSONL evidence; deleted source JSONL does not remove committed facts."
        : "Usage analytics remain available from committed durable local history, but new source evidence requires reconciliation.",
    };
  }
  return {
    status: performance.indexState,
    explanation: "Usage analytics are served from a private rebuildable SQLite-derived index; Pi JSONL remains authoritative.",
  };
}

export const usageIndexConstants = Object.freeze({
  APPLICATION_ID,
  APPLICATION_NAME,
  DATABASE_NAME,
  INDEX_DIRECTORY_NAME,
});
