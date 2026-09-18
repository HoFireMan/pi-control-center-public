import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeDirectory } from "./live-observability.js";

export const CODEX_QUOTA_SOURCE = "PI_PROVIDER_RESPONSE_HEADERS";
export const CODEX_QUOTA_BRIDGE_VERSION = "0.2.0";
export const CODEX_SESSION_WINDOW_MINUTES = 300;
export const CODEX_WEEKLY_WINDOW_MINUTES = 10_080;
export const CODEX_QUOTA_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
export const MAX_CODEX_QUOTA_SNAPSHOT_FILES = 128;
export const MAX_CODEX_QUOTA_SNAPSHOT_BYTES = 8 * 1024;

const QUOTA_FILE_PATTERN = /^quota-[a-f0-9]{16,64}\.json$/;
const HEADER_NAMES = [
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-at",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-at",
];
const HEADER_NAME_SET = new Set(HEADER_NAMES);
const AVAILABILITIES = new Set(["AVAILABLE", "STALE", "EXPIRED", "AMBIGUOUS", "UNAVAILABLE", "UNSUPPORTED"]);
const WINDOW_STATES = new Set(["AVAILABLE", "STALE", "EXPIRED", "UNAVAILABLE"]);

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function safeDirectory(directory, uid) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || uid === null) return false;
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function validIso(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function normalizedHeaderRecord(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (!HEADER_NAME_SET.has(normalized)) continue;
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 128 || value.includes("\u0000")) return null;
    if (result[normalized] !== undefined && result[normalized] !== value) return null;
    result[normalized] = value;
  }
  return result;
}

function header(headers, name) {
  return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null;
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
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const milliseconds = seconds * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function parseWindow(headers, prefix) {
  const usedPercent = parsePercent(header(headers, `${prefix}-used-percent`));
  const windowMinutes = parseWindowMinutes(header(headers, `${prefix}-window-minutes`));
  const resetsAt = parseResetTimestamp(header(headers, `${prefix}-reset-at`));
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  return {
    usedPercent,
    remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
    windowMinutes,
    resetsAt,
  };
}

function safeObservedAt(observedAtMs) {
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0) return null;
  const date = new Date(observedAtMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parse only the six provider quota headers; no request or response body is accepted. */
export function createCodexQuotaSnapshot(headers, observedAtMs = Date.now(), bridgeVersion = CODEX_QUOTA_BRIDGE_VERSION) {
  const normalized = normalizedHeaderRecord(headers);
  const observedAt = safeObservedAt(observedAtMs);
  if (!normalized || !observedAt) return null;
  const primary = parseWindow(normalized, "x-codex-primary");
  const secondary = parseWindow(normalized, "x-codex-secondary");
  const windows = [primary, secondary].filter(Boolean);
  if (windows.length === 0) return null;
  const session5h = windows.find((window) => window.windowMinutes === CODEX_SESSION_WINDOW_MINUTES) ?? null;
  const weekly = windows.find((window) => window.windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES) ?? null;
  if (session5h && windows.filter((window) => window.windowMinutes === CODEX_SESSION_WINDOW_MINUTES).length > 1) return null;
  if (weekly && windows.filter((window) => window.windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES).length > 1) return null;
  return {
    version: 1,
    bridgeVersion: typeof bridgeVersion === "string" && bridgeVersion.length <= 128 ? bridgeVersion : CODEX_QUOTA_BRIDGE_VERSION,
    provider: "openai-codex",
    observedAt,
    source: CODEX_QUOTA_SOURCE,
    session5h,
    weekly,
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === keys.slice().sort().join("\u0000");
}

function validateWindow(value, expectedMinutes) {
  if (!exactKeys(value, ["usedPercent", "remainingPercent", "windowMinutes", "resetsAt"])) return null;
  if (!Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  if (!Number.isFinite(value.remainingPercent) || value.remainingPercent < 0 || value.remainingPercent > 100) return null;
  if (value.remainingPercent !== Math.min(100, Math.max(0, 100 - value.usedPercent))) return null;
  if (value.windowMinutes !== expectedMinutes) return null;
  if (validIso(value.resetsAt) === null) return null;
  return {
    usedPercent: value.usedPercent,
    remainingPercent: value.remainingPercent,
    windowMinutes: expectedMinutes,
    resetsAt: value.resetsAt,
  };
}

export function validateCodexQuotaSnapshot(value) {
  if (!exactKeys(value, ["version", "bridgeVersion", "provider", "observedAt", "source", "session5h", "weekly"])) return null;
  if (value.version !== 1 || typeof value.bridgeVersion !== "string" || value.bridgeVersion.length === 0 || value.bridgeVersion.length > 128) return null;
  if (value.provider !== "openai-codex" || value.source !== CODEX_QUOTA_SOURCE) return null;
  if (validIso(value.observedAt) === null) return null;
  const session5h = value.session5h === null ? null : validateWindow(value.session5h, CODEX_SESSION_WINDOW_MINUTES);
  const weekly = value.weekly === null ? null : validateWindow(value.weekly, CODEX_WEEKLY_WINDOW_MINUTES);
  if (value.session5h !== null && !session5h) return null;
  if (value.weekly !== null && !weekly) return null;
  if (!session5h && !weekly) return null;
  return {
    version: 1,
    bridgeVersion: value.bridgeVersion,
    provider: "openai-codex",
    observedAt: value.observedAt,
    source: CODEX_QUOTA_SOURCE,
    session5h,
    weekly,
  };
}

function safeQuotaTarget(filePath, directory, uid) {
  if (path.dirname(filePath) !== directory || !QUOTA_FILE_PATTERN.test(path.basename(filePath))) return false;
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/** Atomically write one normalized private snapshot; unsafe targets fail closed. */
export function writeCodexQuotaSnapshot(directory, filePath, value, uid = currentUid()) {
  const snapshot = validateCodexQuotaSnapshot(value);
  if (!snapshot || !safeDirectory(directory, uid) || !safeQuotaTarget(filePath, directory, uid)) return false;
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CODEX_QUOTA_SNAPSHOT_BYTES) return false;
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    return true;
  } catch {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    return false;
  }
}

function readSnapshotFiles(runtimeDirectory, uid = currentUid()) {
  const result = { snapshots: [], filesSeen: 0, snapshotsRead: 0, malformedFiles: 0, oversizedFiles: 0, unsafeFiles: 0 };
  if (!safeDirectory(runtimeDirectory, uid)) return result;
  let entries;
  try { entries = fs.readdirSync(runtimeDirectory, { withFileTypes: true }); } catch { return result; }
  const candidates = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && QUOTA_FILE_PATTERN.test(entry.name));
  result.filesSeen = candidates.length;
  const prioritized = candidates.map((entry) => {
    try {
      return { entry, modifiedAt: fs.lstatSync(path.join(runtimeDirectory, entry.name)).mtimeMs };
    } catch {
      return { entry, modifiedAt: 0 };
    }
  }).sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, MAX_CODEX_QUOTA_SNAPSHOT_FILES);
  for (const { entry } of prioritized) {
    const filePath = path.join(runtimeDirectory, entry.name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        result.unsafeFiles += 1;
        continue;
      }
      if (stat.size > MAX_CODEX_QUOTA_SNAPSHOT_BYTES) {
        result.oversizedFiles += 1;
        continue;
      }
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let text;
      try { text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
      const snapshot = validateCodexQuotaSnapshot(JSON.parse(text));
      if (!snapshot) {
        result.malformedFiles += 1;
        continue;
      }
      result.snapshotsRead += 1;
      result.snapshots.push(snapshot);
    } catch {
      result.malformedFiles += 1;
    }
  }
  return result;
}

function windowExpired(window, nowMs) {
  return Date.parse(window.resetsAt) <= nowMs;
}

function windowStatus(window, nowMs, stale) {
  if (!window) return "UNAVAILABLE";
  if (windowExpired(window, nowMs)) return "EXPIRED";
  return stale ? "STALE" : "AVAILABLE";
}

function quotaPayload(snapshot) {
  return JSON.stringify({ session5h: snapshot.session5h, weekly: snapshot.weekly });
}

function unavailableResult(availability, limitations, diagnostics = {}, nowMs = Date.now()) {
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    availability,
    source: null,
    observedAt: null,
    session5h: null,
    weekly: null,
    windowStatus: { session5h: "UNAVAILABLE", weekly: "UNAVAILABLE" },
    limitations,
    ...diagnostics,
  };
}

export function collectCodexQuota({ runtimeDirectory = resolveRuntimeDirectory({ create: false }), nowMs = Date.now(), uid = currentUid() } = {}) {
  const inventory = readSnapshotFiles(runtimeDirectory, uid);
  const baseDiagnostics = {
    filesSeen: inventory.filesSeen,
    snapshotsRead: inventory.snapshotsRead,
    malformedFiles: inventory.malformedFiles,
    oversizedFiles: inventory.oversizedFiles,
    unsafeFiles: inventory.unsafeFiles,
  };
  if (!safeDirectory(runtimeDirectory, uid)) {
    return unavailableResult("UNSUPPORTED", ["Codex quota snapshots are unavailable because the private Bridge runtime directory is unsupported."], baseDiagnostics, nowMs);
  }
  if (inventory.snapshots.length === 0) {
    return unavailableResult("UNAVAILABLE", ["No valid Pi Codex response-header quota snapshot has been observed."], baseDiagnostics, nowMs);
  }
  const ordered = inventory.snapshots.slice().sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  const freshest = ordered[0];
  const sameTime = ordered.filter((candidate) => candidate.observedAt === freshest.observedAt);
  if (sameTime.some((candidate) => quotaPayload(candidate) !== quotaPayload(freshest))) {
    return unavailableResult("AMBIGUOUS", ["Multiple same-time quota observations conflict; no account identity is exposed or inferred."], baseDiagnostics, nowMs);
  }
  const ageMs = Math.max(0, nowMs - Date.parse(freshest.observedAt));
  const stale = ageMs > CODEX_QUOTA_STALE_THRESHOLD_MS;
  const sessionExpired = freshest.session5h ? windowExpired(freshest.session5h, nowMs) : false;
  const weeklyExpired = freshest.weekly ? windowExpired(freshest.weekly, nowMs) : false;
  const sessionCurrent = freshest.session5h && !sessionExpired ? freshest.session5h : null;
  const weeklyCurrent = freshest.weekly && !weeklyExpired ? freshest.weekly : null;
  const allExpired = (freshest.session5h || freshest.weekly) && !sessionCurrent && !weeklyCurrent;
  const limitations = [
    "Codex quota is last-observed evidence from a normal Pi provider response, not continuously live account truth.",
    "No provider billing, account-completeness, credential, or direct usage endpoint is used.",
  ];
  if (stale) limitations.push("The latest observation is stale after six hours; the dashboard does not invent a provider freshness guarantee.");
  if (sessionExpired || weeklyExpired) limitations.push("A reset timestamp has passed; that window is unavailable until a newer valid Pi response is observed.");
  if (ordered.length > 1) limitations.push("The freshest valid sanitized observation is selected; snapshots are not merged and process identity is not exposed.");
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    availability: allExpired ? "EXPIRED" : stale ? "STALE" : "AVAILABLE",
    source: CODEX_QUOTA_SOURCE,
    observedAt: freshest.observedAt,
    session5h: sessionCurrent,
    weekly: weeklyCurrent,
    windowStatus: {
      session5h: windowStatus(freshest.session5h, nowMs, stale),
      weekly: windowStatus(freshest.weekly, nowMs, stale),
    },
    limitations,
    ...baseDiagnostics,
  };
}

function apiWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
  };
}

export function codexQuotaApiResponse(quota) {
  const availability = AVAILABILITIES.has(quota?.availability) ? quota.availability : "UNAVAILABLE";
  const windowStatus = {
    session5h: WINDOW_STATES.has(quota?.windowStatus?.session5h) ? quota.windowStatus.session5h : "UNAVAILABLE",
    weekly: WINDOW_STATES.has(quota?.windowStatus?.weekly) ? quota.windowStatus.weekly : "UNAVAILABLE",
  };
  return {
    generatedAt: typeof quota?.generatedAt === "string" ? quota.generatedAt : new Date().toISOString(),
    availability,
    source: quota?.source === CODEX_QUOTA_SOURCE ? CODEX_QUOTA_SOURCE : null,
    observedAt: typeof quota?.observedAt === "string" ? quota.observedAt : null,
    session5h: apiWindow(quota?.session5h),
    weekly: apiWindow(quota?.weekly),
    windowStatus,
    limitations: Array.isArray(quota?.limitations) ? quota.limitations.map((value) => String(value)).slice(0, 8) : [],
  };
}

export function quotaSnapshotPath(directory, instanceToken) {
  return path.join(directory, `quota-${instanceToken}.json`);
}
