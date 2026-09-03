import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectProjects, collectWorktrees, attributeProject } from "./evidence.js";

export const LIVE_BRIDGE_HEARTBEAT_INTERVAL_MS = 5_000;
export const LIVE_STALE_THRESHOLD_MS = 15_000;
export const MAX_LIVE_SNAPSHOT_FILES = 128;
export const MAX_LIVE_SNAPSHOT_BYTES = 16 * 1024;
export const MAX_LIVE_STRING_LENGTH = 4_096;
const SAFE_AGENT_LOOP_STATES = new Set(["BUSY", "IDLE", "UNKNOWN"]);
const SAFE_SESSION_REASONS = new Set(["startup", "reload", "new", "resume", "fork"]);
const RUNTIME_DIRECTORY_NAME = "pi-control-center";
const SNAPSHOT_FILE_PATTERN = /^instance-[a-f0-9]{16,64}\.json$/;

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isSafeDirectory(directory, uid) {
  if (uid === null) return false;
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === uid
      && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function ensurePrivateChildren(parent, segments, uid, create) {
  if (!isSafeDirectory(parent, uid)) return null;
  let current = parent;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return null;
    } catch (error) {
      if (!create || error?.code !== "ENOENT") return null;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch { return null; }
    }
  }
  return isSafeDirectory(current, uid) ? current : null;
}

function ensureRuntimeChild(parent, uid, create) {
  if (!isSafeDirectory(parent, uid)) return null;
  const child = path.join(parent, RUNTIME_DIRECTORY_NAME);
  try {
    const stat = fs.lstatSync(child);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0 ? child : null;
  } catch (error) {
    if (!create || error?.code !== "ENOENT") return null;
    try { fs.mkdirSync(child, { mode: 0o700 }); } catch { return null; }
    return isSafeDirectory(child, uid) ? child : null;
  }
}

export function resolveRuntimeDirectory({ env = process.env, home = os.homedir(), uid = currentUid(), create = true } = {}) {
  const xdg = typeof env.XDG_RUNTIME_DIR === "string" && path.isAbsolute(env.XDG_RUNTIME_DIR)
    ? ensureRuntimeChild(env.XDG_RUNTIME_DIR, uid, create)
    : null;
  if (xdg) return xdg;

  return ensurePrivateChildren(home, [".cache", RUNTIME_DIRECTORY_NAME, "runtime"], uid, create);
}

function normalizeSafeString(value, maximum = MAX_LIVE_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) return null;
  return value;
}

export function parseProcessStartIdentity(statText) {
  if (typeof statText !== "string") return null;
  const closingParen = statText.lastIndexOf(")");
  if (closingParen < 0) return null;
  const fields = statText.slice(closingParen + 1).trim().split(/\s+/);
  const startTime = fields[19];
  return /^\d+$/.test(startTime ?? "") ? `linux:${startTime}` : null;
}

export function readProcessStartIdentity(pid = process.pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return parseProcessStartIdentity(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function processIdentityMatches(snapshot, { readStart = readProcessStartIdentity, isAlive = processIsAlive } = {}) {
  if (!snapshot || !Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (!normalizeSafeString(snapshot.processStartIdentity, 128)) return false;
  if (!isAlive(snapshot.pid)) return false;
  return readStart(snapshot.pid) === snapshot.processStartIdentity;
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateLiveSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== 1) return null;
  if (!normalizeSafeString(value.bridgeVersion, 128)) return null;
  if (!normalizeSafeString(value.instanceId, 128)) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (!normalizeSafeString(value.processStartIdentity, 128)) return null;
  if (!normalizeSafeString(value.sessionId, 256)) return null;
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || value.cwd.length > MAX_LIVE_STRING_LENGTH || value.cwd.includes("\u0000")) return null;
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.heartbeatAt)) return null;
  if (!SAFE_AGENT_LOOP_STATES.has(value.agentLoopState)) return null;
  if (value.sessionStartReason !== undefined && !SAFE_SESSION_REASONS.has(value.sessionStartReason)) return null;
  return {
    version: 1,
    bridgeVersion: value.bridgeVersion,
    instanceId: value.instanceId,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
    sessionId: value.sessionId,
    cwd: value.cwd,
    startedAt: value.startedAt,
    heartbeatAt: value.heartbeatAt,
    agentLoopState: value.agentLoopState,
    ...(value.sessionStartReason ? { sessionStartReason: value.sessionStartReason } : {}),
  };
}

export function deriveLivePresence(snapshot, nowMs = Date.now(), identityValidator = (value) => processIdentityMatches(value)) {
  const heartbeatAgeMs = Math.max(0, nowMs - snapshot.heartbeatAt);
  const processValid = identityValidator(snapshot);
  if (!processValid) return { presenceState: "EXITED", agentLoopState: "UNKNOWN", heartbeatAgeMs };
  if (heartbeatAgeMs > LIVE_STALE_THRESHOLD_MS) return { presenceState: "STALE", agentLoopState: "UNKNOWN", heartbeatAgeMs };
  return { presenceState: "LIVE", agentLoopState: SAFE_AGENT_LOOP_STATES.has(snapshot.agentLoopState) ? snapshot.agentLoopState : "UNKNOWN", heartbeatAgeMs };
}

function safeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readSnapshotFiles(runtimeDirectory, uid = currentUid()) {
  const result = { snapshots: [], diagnostics: { runtimeDirectoryStatus: "AVAILABLE", filesSeen: 0, malformedFiles: 0, oversizedFiles: 0, unsafeFiles: 0, duplicateInstances: 0 } };
  if (!runtimeDirectory || !isSafeDirectory(runtimeDirectory, uid)) {
    result.diagnostics.runtimeDirectoryStatus = "UNSUPPORTED";
    return result;
  }
  let entries;
  try {
    entries = fs.readdirSync(runtimeDirectory, { withFileTypes: true });
  } catch {
    result.diagnostics.runtimeDirectoryStatus = "ERROR";
    return result;
  }
  const candidates = entries.filter((entry) => entry.isFile() && SNAPSHOT_FILE_PATTERN.test(entry.name)).slice(0, MAX_LIVE_SNAPSHOT_FILES);
  result.diagnostics.filesSeen = candidates.length;
  const instances = new Set();
  for (const entry of candidates) {
    const filePath = path.join(runtimeDirectory, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
        result.diagnostics.unsafeFiles += 1;
        continue;
      }
      if (stat.size > MAX_LIVE_SNAPSHOT_BYTES) {
        result.diagnostics.oversizedFiles += 1;
        continue;
      }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(filePath, flags);
      let text;
      try {
        text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      const snapshot = validateLiveSnapshot(JSON.parse(text));
      if (!snapshot) {
        result.diagnostics.malformedFiles += 1;
        continue;
      }
      if (instances.has(snapshot.instanceId)) {
        result.diagnostics.duplicateInstances += 1;
        continue;
      }
      instances.add(snapshot.instanceId);
      result.snapshots.push(snapshot);
    } catch {
      result.diagnostics.malformedFiles += 1;
    }
  }
  return result;
}

function safeDisplayInstance(snapshot, derived, attribution) {
  return {
    opaqueLiveInstanceId: snapshot.instanceId,
    session: snapshot.sessionId.slice(0, 12),
    projectId: attribution.projectId,
    projectName: attribution.project,
    workspace: attribution.workspace,
    presenceState: derived.presenceState,
    agentLoopState: derived.agentLoopState,
    startedAt: safeIso(snapshot.startedAt),
    heartbeatAt: safeIso(snapshot.heartbeatAt),
    heartbeatAgeMs: derived.heartbeatAgeMs,
  };
}

export function collectLiveObservability({
  runtimeDirectory = resolveRuntimeDirectory({ create: false }),
  nowMs = Date.now(),
  projects,
  worktrees,
  processInspector = (snapshot) => processIdentityMatches(snapshot),
} = {}) {
  const inventory = readSnapshotFiles(runtimeDirectory);
  const projectInventory = projects ?? (inventory.snapshots.length > 0 ? collectProjects() : []);
  const worktreeInventory = worktrees ?? (inventory.snapshots.length > 0 ? collectWorktrees(projectInventory) : { repositories: [] });
  const instances = inventory.snapshots.map((snapshot) => {
    const derived = deriveLivePresence(snapshot, nowMs, processInspector);
    const attribution = attributeProject(snapshot.cwd, projectInventory, worktreeInventory);
    return safeDisplayInstance(snapshot, derived, attribution);
  });
  const projectRows = new Map();
  for (const instance of instances) {
    const row = projectRows.get(instance.projectId) ?? {
      projectId: instance.projectId,
      projectName: instance.projectName,
      liveCount: 0,
      busyCount: 0,
      idleCount: 0,
      lastHeartbeatAt: null,
    };
    if (instance.presenceState === "LIVE") {
      row.liveCount += 1;
      if (instance.agentLoopState === "BUSY") row.busyCount += 1;
      if (instance.agentLoopState === "IDLE") row.idleCount += 1;
    }
    if (!row.lastHeartbeatAt || (instance.heartbeatAt && instance.heartbeatAt > row.lastHeartbeatAt)) row.lastHeartbeatAt = instance.heartbeatAt;
    projectRows.set(instance.projectId, row);
  }
  const summary = {
    liveInstances: instances.filter((item) => item.presenceState === "LIVE").length,
    busyInstances: instances.filter((item) => item.presenceState === "LIVE" && item.agentLoopState === "BUSY").length,
    idleInstances: instances.filter((item) => item.presenceState === "LIVE" && item.agentLoopState === "IDLE").length,
    staleInstances: instances.filter((item) => item.presenceState === "STALE").length,
    exitedInstances: instances.filter((item) => item.presenceState === "EXITED").length,
  };
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    availability: inventory.diagnostics.runtimeDirectoryStatus === "AVAILABLE" && inventory.snapshots.length > 0 ? "AVAILABLE" : "UNSUPPORTED",
    timing: { heartbeatIntervalMs: LIVE_BRIDGE_HEARTBEAT_INTERVAL_MS, staleThresholdMs: LIVE_STALE_THRESHOLD_MS },
    summary,
    projects: [...projectRows.values()].sort((left, right) => left.projectName.localeCompare(right.projectName)),
    instances,
    limitations: [
      "Live Pi presence is available only for Pi processes running the repository Bridge extension.",
      "Historical sessions without a Bridge snapshot are not classified as live, stale, exited, or unsupported runtime processes.",
      "Phase B live pi-subagents fleet observability is not implemented.",
    ],
    diagnostics: inventory.diagnostics,
  };
}
