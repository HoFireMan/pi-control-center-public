import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEARTBEAT_INTERVAL_MS = 5_000;
const RUNTIME_DIRECTORY_NAME = "pi-control-center";
const SNAPSHOT_PREFIX = "instance-";
const QUOTA_SNAPSHOT_PREFIX = "quota-";
const BRIDGE_VERSION = "0.3.0";
const CONTEXT_OBSERVATION_TYPE = "pi-control-center-context-observation-v1";
const COMPACTION_OBSERVATION_TYPE = "pi-control-center-compaction-observation-v1";
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const CODEX_QUOTA_SOURCE = "PI_PROVIDER_RESPONSE_HEADERS";
const CODEX_SESSION_WINDOW_MINUTES = 300;
const CODEX_WEEKLY_WINDOW_MINUTES = 10080;
const MAX_QUOTA_SNAPSHOT_BYTES = 8 * 1024;
const QUOTA_FILE_PATTERN = /^quota-[a-f0-9]{16,64}\.json$/;
const SAFE_REASONS = new Set(["startup", "reload", "new", "resume", "fork"]);
const SAFE_LOOP_STATES = new Set(["BUSY", "IDLE", "UNKNOWN"]);
const MAX_CWD_LENGTH = 4_096;
const MAX_SESSION_ID_LENGTH = 256;

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function safeDirectory(directory, owner) {
  if (owner === null) return false;
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === owner
      && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function ensurePrivateChildren(parent, segments, owner) {
  if (!safeDirectory(parent, owner)) return null;
  let current = parent;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o022) !== 0) return null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch { return null; }
    }
  }
  return safeDirectory(current, owner) ? current : null;
}

function runtimeDirectory() {
  const owner = uid();
  const xdg = typeof process.env.XDG_RUNTIME_DIR === "string" && path.isAbsolute(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : null;
  if (xdg && safeDirectory(xdg, owner)) {
    const target = path.join(xdg, RUNTIME_DIRECTORY_NAME);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === owner && (stat.mode & 0o022) === 0) return target;
    } catch (error) {
      if (error?.code === "ENOENT") {
        try { fs.mkdirSync(target, { mode: 0o700 }); } catch { /* try the fallback */ }
        if (safeDirectory(target, owner)) return target;
      }
    }
  }

  return ensurePrivateChildren(os.homedir(), [".cache", RUNTIME_DIRECTORY_NAME, "runtime"], owner);
}

function processStartIdentity() {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return null;
    const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return /^\d+$/.test(startTime ?? "") ? `linux:${startTime}` : null;
  } catch {
    return null;
  }
}

function instanceId(startIdentity) {
  return `instance-${crypto.createHash("sha256").update(`${process.pid}:${startIdentity}`).digest("hex")}`;
}

function safeCwd(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CWD_LENGTH && path.isAbsolute(value) && !value.includes("\u0000")
    ? value
    : null;
}

function safeSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !value.includes("\u0000")
    ? value
    : null;
}

function safeReason(reason) {
  return SAFE_REASONS.has(reason) ? reason : "startup";
}

function safeObservationInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hashIdentity(domain, value) {
  return crypto.createHash("sha256").update(`${domain}\0${value}`).digest("hex");
}

function entryKeyHash(value) {
  return typeof value === "string" && value.length > 0 ? hashIdentity("pi-control-center:entry", value) : null;
}

function safeModelValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\u0000") ? value : null;
}

export function agentDirectory() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

function policySource(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const compaction = parsed?.compaction;
    if (compaction !== undefined && (!compaction || typeof compaction !== "object" || Array.isArray(compaction))) {
      return { state: "INVALID", reserveTokens: null, fingerprint: hashIdentity("pi-context-policy-source", raw) };
    }
    const reserve = compaction?.reserveTokens;
    if (reserve !== undefined && safeObservationInteger(reserve) === null) {
      return { state: "INVALID", reserveTokens: null, fingerprint: hashIdentity("pi-context-policy-source", raw) };
    }
    return {
      state: "VALID",
      reserveTokens: reserve === undefined ? null : reserve,
      fingerprint: hashIdentity("pi-context-policy-source", raw),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "ABSENT", reserveTokens: null, fingerprint: "ABSENT" };
    return { state: "INVALID", reserveTokens: null, fingerprint: "INVALID" };
  }
}

function policySnapshot(ctx) {
  const global = policySource(path.join(agentDirectory(), "settings.json"));
  let trusted = false;
  try { trusted = ctx.isProjectTrusted() === true; } catch { trusted = false; }
  const project = trusted && typeof ctx.cwd === "string" && path.isAbsolute(ctx.cwd)
    ? policySource(path.join(ctx.cwd, ".pi", "settings.json"))
    : { state: "IGNORED", reserveTokens: null, fingerprint: "IGNORED" };
  const invalid = global.state === "INVALID" || project.state === "INVALID";
  const reserveTokens = invalid
    ? null
    : project.reserveTokens ?? global.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
  return {
    reserveTokens,
    valid: !invalid && safeObservationInteger(reserveTokens) !== null,
    fingerprint: hashIdentity("pi-context-policy", JSON.stringify({ trusted, global: global.fingerprint, project: project.fingerprint })),
  };
}

function stableReserveTokens(state, ctx) {
  if (!state?.policySnapshot?.valid) return null;
  const current = policySnapshot(ctx);
  return current.valid && current.fingerprint === state.policySnapshot.fingerprint ? current.reserveTokens : null;
}

function currentModel(ctx) {
  try {
    return {
      provider: safeModelValue(ctx.model?.provider),
      model: safeModelValue(ctx.model?.id ?? ctx.model?.model),
    };
  } catch {
    return { provider: null, model: null };
  }
}

function appendCustomEntry(pi, customType, data) {
  try { pi.appendEntry(customType, data); } catch { /* telemetry must not affect Pi */ }
}

function writeSnapshot(state) {
  if (!state.directory || !state.filePath || !state.sessionId || !state.processStartIdentity || !state.cwd) return;
  const snapshot = {
    version: 1,
    bridgeVersion: BRIDGE_VERSION,
    instanceId: state.instanceId,
    pid: process.pid,
    processStartIdentity: state.processStartIdentity,
    sessionId: state.sessionId,
    cwd: state.cwd,
    startedAt: state.startedAt,
    heartbeatAt: Date.now(),
    agentLoopState: state.agentLoopState,
    sessionStartReason: state.sessionStartReason,
  };
  const temporary = path.join(state.directory, `.${path.basename(state.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(snapshot));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, state.filePath);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function quotaHeader(headers, name) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length === 0) return null;
  if (matches.some(([, value]) => typeof value !== "string" || value.length > 128 || value.includes("\u0000"))) return null;
  const values = new Set(matches.map(([, value]) => value));
  return values.size === 1 ? matches[0][1] : null;
}

function parsePercent(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function parseWindowMinutes(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseResetTimestamp(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  const milliseconds = seconds * 1000;
  const date = new Date(milliseconds);
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isFinite(milliseconds) && !Number.isNaN(date.getTime())
    ? date.toISOString() : null;
}

function parseQuotaWindow(headers, prefix) {
  const usedPercent = parsePercent(quotaHeader(headers, `${prefix}-used-percent`));
  const windowMinutes = parseWindowMinutes(quotaHeader(headers, `${prefix}-window-minutes`));
  const resetsAt = parseResetTimestamp(quotaHeader(headers, `${prefix}-reset-at`));
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  return { usedPercent, remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)), windowMinutes, resetsAt };
}

function createQuotaSnapshot(headers, observedAt = Date.now()) {
  const observedDate = new Date(observedAt);
  if (!Number.isFinite(observedAt) || observedAt < 0 || Number.isNaN(observedDate.getTime())) return null;
  const primary = parseQuotaWindow(headers, "x-codex-primary");
  const secondary = parseQuotaWindow(headers, "x-codex-secondary");
  const windows = [primary, secondary].filter(Boolean);
  if (windows.length === 0) return null;
  const sessionWindows = windows.filter((window) => window.windowMinutes === CODEX_SESSION_WINDOW_MINUTES);
  const weeklyWindows = windows.filter((window) => window.windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES);
  if (sessionWindows.length > 1 || weeklyWindows.length > 1) return null;
  return {
    version: 1,
    bridgeVersion: BRIDGE_VERSION,
    provider: "openai-codex",
    observedAt: observedDate.toISOString(),
    source: CODEX_QUOTA_SOURCE,
    session5h: sessionWindows[0] ?? null,
    weekly: weeklyWindows[0] ?? null,
  };
}

function writeQuotaSnapshot(state, headers) {
  if (!state?.directory || !state.quotaFilePath) return;
  const snapshot = createQuotaSnapshot(headers);
  if (!snapshot) return;
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_QUOTA_SNAPSHOT_BYTES || !QUOTA_FILE_PATTERN.test(path.basename(state.quotaFilePath))) return;
  try {
    const existing = fs.lstatSync(state.quotaFilePath);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid() || (existing.mode & 0o077) !== 0) return;
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
  const temporary = path.join(state.directory, `.${path.basename(state.quotaFilePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, state.quotaFilePath);
  } catch {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function removeSnapshot(state) {
  if (!state?.filePath) return;
  try { fs.unlinkSync(state.filePath); } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

export default function piControlCenterLiveBridge(pi) {
  let state = null;

  const setLoopState = (ctx, forcedState = null) => {
    if (!state) return;
    if (forcedState) {
      state.agentLoopState = forcedState;
    } else {
      try {
        const idle = ctx.isIdle();
        state.agentLoopState = typeof idle === "boolean" ? (idle ? "IDLE" : "BUSY") : "UNKNOWN";
      } catch {
        state.agentLoopState = "UNKNOWN";
      }
    }
    writeSnapshot(state);
  };

  const shutdown = () => {
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    removeSnapshot(state);
    state = null;
  };

  pi.on("session_start", (_event, ctx) => {
    shutdown();
    const directory = runtimeDirectory();
    const startIdentity = processStartIdentity();
    const sessionId = (() => {
      try { return safeSessionId(ctx.sessionManager.getSessionId()); } catch { return null; }
    })();
    const cwd = safeCwd(ctx.cwd);
    const opaqueInstanceId = startIdentity ? instanceId(startIdentity) : null;
    state = {
      directory,
      filePath: directory && opaqueInstanceId ? path.join(directory, `${SNAPSHOT_PREFIX}${opaqueInstanceId.slice(SNAPSHOT_PREFIX.length)}.json`) : null,
      quotaFilePath: directory && opaqueInstanceId ? path.join(directory, `${QUOTA_SNAPSHOT_PREFIX}${opaqueInstanceId.slice(SNAPSHOT_PREFIX.length)}.json`) : null,
      instanceId: opaqueInstanceId,
      processStartIdentity: startIdentity,
      sessionId,
      cwd,
      startedAt: Date.now(),
      sessionStartReason: safeReason(_event?.reason),
      agentLoopState: "UNKNOWN",
      timer: null,
      policySnapshot: policySnapshot(ctx),
      pendingCompaction: null,
    };
    if (!directory || !startIdentity || !sessionId || !cwd) return;
    setLoopState(ctx);
    writeSnapshot(state);
    state.timer = setInterval(() => writeSnapshot(state), HEARTBEAT_INTERVAL_MS);
    state.timer.unref?.();
  });

  pi.on("agent_start", (_event, ctx) => setLoopState(ctx, "BUSY"));
  pi.on("turn_end", (event, ctx) => {
    if (event?.message?.role !== "assistant" || !state) return;
    let persistedEntry = null;
    try {
      persistedEntry = ctx.sessionManager.getEntries().find((entry) => entry?.type === "message" && entry.message === event.message) ?? null;
    } catch {
      return;
    }
    const assistantEntryKeyHash = entryKeyHash(persistedEntry?.id);
    if (!assistantEntryKeyHash) return;
    let usage;
    try { usage = ctx.getContextUsage(); } catch { usage = undefined; }
    if (!usage || typeof usage !== "object") return;
    appendCustomEntry(pi, CONTEXT_OBSERVATION_TYPE, {
      assistantEntryKeyHash,
      runtimeContextTokens: safeObservationInteger(usage.tokens),
      contextWindowTokens: safeObservationInteger(usage.contextWindow),
      compactionReserveTokens: stableReserveTokens(state, ctx),
    });
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!state) return;
    const model = currentModel(ctx);
    const reserveTokens = safeObservationInteger(event?.preparation?.settings?.reserveTokens);
    state.pendingCompaction = {
      reserveTokens,
      contextWindowTokens: safeObservationInteger(ctx.model?.contextWindow),
      provider: model.provider,
      model: model.model,
      reason: COMPACTION_REASONS.has(event?.reason) ? event.reason : null,
    };
  });
  pi.on("session_compact", (event, ctx) => {
    const pending = state?.pendingCompaction;
    state && (state.pendingCompaction = null);
    const compactionEntryKeyHash = entryKeyHash(event?.compactionEntry?.id);
    if (!compactionEntryKeyHash) return;
    const model = currentModel(ctx);
    appendCustomEntry(pi, COMPACTION_OBSERVATION_TYPE, {
      compactionEntryKeyHash,
      reason: COMPACTION_REASONS.has(event?.reason) ? event.reason : pending?.reason ?? null,
      contextWindowTokens: pending?.contextWindowTokens ?? safeObservationInteger(ctx.model?.contextWindow),
      compactionReserveTokens: pending?.reserveTokens ?? null,
      provider: pending?.provider ?? model.provider,
      model: pending?.model ?? model.model,
    });
  });
  pi.on("session_compact_failed", () => {
    if (state) state.pendingCompaction = null;
  });
  pi.on("agent_settled", (_event, ctx) => setLoopState(ctx));
  pi.on("after_provider_response", (event) => writeQuotaSnapshot(state, event?.headers));
  pi.on("session_shutdown", shutdown);
}
