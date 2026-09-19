import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  discoverUsageSources,
  readUsageArtifact,
  selectUsageRecords,
  usageResultFromRecords,
  USAGE_INDEX_VERSIONS,
} from "./usage-index.js";

const HOME = os.homedir();
const HISTORY_DIRECTORY_NAME = "pi-control-center";
const HISTORY_DATABASE_NAME = "usage-history.sqlite";
const HISTORY_APPLICATION = "PI_CONTROL_CENTER_USAGE_HISTORY";
const HISTORY_APPLICATION_ID = 0x50434348;
const HISTORY_SCHEMA_VERSION = "3";
const CONTEXT_BACKFILL_VERSION = "1";
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const BUSY_TIMEOUT_MS = 2_000;
const UNATTRIBUTED = "UNATTRIBUTED";

let DatabaseSync = null;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

function hashIdentity(domain, value) {
  return crypto.createHash("sha256").update(`${domain}\0${value}`).digest("hex");
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function pathKey(filePath, sessionRoot) {
  const relative = normalizeRelativePath(path.relative(sessionRoot, filePath));
  return hashIdentity("pi-control-center:source-file", relative);
}

function sessionKey(value) {
  return typeof value === "string" && value.length > 0
    ? hashIdentity("pi-control-center:session", value)
    : null;
}

function sourceKeyFor(session, filePathKey) {
  return session
    ? hashIdentity("pi-control-center:source-session", session)
    : filePathKey;
}

function rootLineageKey(sourceKey) {
  return hashIdentity("pi-control-center:lineage-root", sourceKey);
}

function entryKey(value) {
  return typeof value === "string" && value.length > 0
    ? hashIdentity("pi-control-center:entry", value)
    : null;
}

function signatureKey(value) {
  return typeof value === "string" && value.length > 0
    ? hashIdentity("pi-control-center:entry-signature", value)
    : null;
}

function eventKey(lineageKey, entryKeyValue) {
  return hashIdentity("pi-usage-event", `${lineageKey}\0${entryKeyValue}`);
}

function compactionKey(lineageKey, entryKeyValue) {
  return hashIdentity("pi-context-compaction", `${lineageKey}\0${entryKeyValue}`);
}

function factSignature(record, provider, model, project) {
  return hashIdentity("pi-usage-fact-signature", JSON.stringify({
    signature: record.signature,
    kind: record.kind,
    timestampMs: record.timestampMs,
    provider,
    model,
    project,
    usage: record.usage,
  }));
}

function safeLabel(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().slice(0, 128);
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeDurableUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!tokenFields.every((field) => validInteger(usage[field]))) return null;
  if (usage.reasoning !== undefined && !validInteger(usage.reasoning)) return null;
  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) return null;
  const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (!costFields.every((field) => typeof usage.cost[field] === "number" && Number.isFinite(usage.cost[field]) && usage.cost[field] >= 0)) return null;
  return usage;
}

function contentHash(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function prefixMatches(filePath, size, expectedHash) {
  if (!Number.isSafeInteger(size) || size < 0 || typeof expectedHash !== "string") return false;
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length < size) return false;
    return crypto.createHash("sha256").update(bytes.subarray(0, size)).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

function privateUserId() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function owned(stat) {
  const uid = privateUserId();
  return uid === null || Number(stat.uid) === uid;
}

function ensurePrivateDirectory(directory) {
  try {
    const link = fs.lstatSync(directory);
    if (!link.isDirectory() || link.isSymbolicLink()) return false;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
  }
  try {
    fs.chmodSync(directory, 0o700);
    const stat = fs.statSync(directory);
    return stat.isDirectory() && owned(stat) && (stat.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function safeDatabaseTarget(databasePath, create = false) {
  try {
    const link = fs.lstatSync(databasePath);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    const stat = fs.statSync(databasePath);
    return owned(stat) && (stat.mode & 0o777) === 0o600;
  } catch (error) {
    return error.code === "ENOENT" && create;
  }
}

export function resolveUsageHistoryLocation(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? HOME;
  let dataRoot = options.dataRoot;
  if (!dataRoot) {
    const xdg = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
      ? env.XDG_DATA_HOME.trim()
      : null;
    dataRoot = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  }
  const directory = path.join(dataRoot, HISTORY_DIRECTORY_NAME);
  return { directory, databasePath: path.join(directory, HISTORY_DATABASE_NAME) };
}

function databaseError(message, code = "HISTORY_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      source_key TEXT PRIMARY KEY,
      path_key TEXT NOT NULL,
      session_key TEXT,
      identity_kind TEXT NOT NULL CHECK (identity_kind IN ('SESSION', 'PATH')),
      parent_path_key TEXT,
      parent_source_key TEXT REFERENCES sources(source_key) ON DELETE RESTRICT,
      lineage_key TEXT,
      present INTEGER NOT NULL CHECK (present IN (0, 1)),
      lineage_status TEXT NOT NULL CHECK (lineage_status IN ('RESOLVED', 'UNRESOLVED', 'CONFLICTED', 'ORPHAN_COMPAT')),
      last_content_hash TEXT,
      last_size_bytes INTEGER,
      last_mtime_ns TEXT,
      last_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sources_parent_idx ON sources(parent_source_key);
    CREATE INDEX IF NOT EXISTS sources_reference_idx ON sources(path_key);
    CREATE TABLE IF NOT EXISTS usage_events (
      event_key TEXT PRIMARY KEY,
      lineage_key TEXT NOT NULL,
      entry_key_hash TEXT NOT NULL,
      signature_hash TEXT NOT NULL,
      origin_source_key TEXT NOT NULL REFERENCES sources(source_key) ON DELETE RESTRICT,
      origin_session_key TEXT,
      timestamp_ms INTEGER NOT NULL,
      record_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      project_label TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER,
      total_tokens INTEGER NOT NULL,
      runtime_context_tokens INTEGER,
      context_window_tokens INTEGER,
      compaction_reserve_tokens INTEGER,
      input_cost_usd REAL NOT NULL,
      output_cost_usd REAL NOT NULL,
      cache_read_cost_usd REAL NOT NULL,
      cache_write_cost_usd REAL NOT NULL,
      total_cost_usd REAL NOT NULL,
      UNIQUE (lineage_key, entry_key_hash)
    );
    CREATE INDEX IF NOT EXISTS usage_events_timestamp_idx ON usage_events(timestamp_ms);
    CREATE TABLE IF NOT EXISTS context_compactions (
      compaction_key TEXT PRIMARY KEY,
      lineage_key TEXT NOT NULL,
      origin_source_key TEXT NOT NULL,
      origin_session_key TEXT,
      timestamp_ms INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      project_label TEXT NOT NULL,
      tokens_before INTEGER,
      reason TEXT CHECK (reason IS NULL OR reason IN ('manual', 'threshold', 'overflow')),
      context_window_tokens INTEGER,
      compaction_reserve_tokens INTEGER
    );
  `);
}

function metadataMap(db) {
  return new Map(db.prepare("SELECT key, value FROM history_meta").all().map((row) => [row.key, row.value]));
}

function contextTelemetryStatus(meta, conflictObserved = false) {
  const sticky = meta.get("context_telemetry_conflict_seen") === "1"
    || Number(meta.get("context_telemetry_conflicts") ?? 0) > 0
    || conflictObserved;
  return sticky ? "CONFLICT_SEEN" : "CLEAN";
}

function migrateSchemaV1ToV2(db) {
  const columns = db.prepare("PRAGMA table_info(sources)").all();
  if (columns.some((column) => column.name === "last_mtime_ns")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      ALTER TABLE usage_events RENAME TO usage_events_v1;
      ALTER TABLE sources RENAME TO sources_v1;
      DROP INDEX IF EXISTS sources_parent_idx;
      DROP INDEX IF EXISTS sources_reference_idx;
      DROP INDEX IF EXISTS usage_events_timestamp_idx;
    `);
    createSchema(db);
    db.exec(`
      INSERT INTO sources(
        source_key, path_key, session_key, identity_kind, parent_path_key,
        parent_source_key, lineage_key, present, lineage_status,
        last_content_hash, last_size_bytes, last_mtime_ns, last_seen_at
      )
      SELECT source_key, path_key, session_key, identity_kind, parent_path_key,
        parent_source_key, lineage_key, present, lineage_status,
        last_content_hash, last_size_bytes, NULL, last_seen_at
      FROM sources_v1;
      INSERT INTO usage_events(
        event_key, lineage_key, entry_key_hash, signature_hash,
        origin_source_key, origin_session_key, timestamp_ms, record_kind,
        provider, model, project_label,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens,
        input_cost_usd, output_cost_usd, cache_read_cost_usd,
        cache_write_cost_usd, total_cost_usd
      ) SELECT event_key, lineage_key, entry_key_hash, signature_hash,
        origin_source_key, origin_session_key, timestamp_ms, record_kind,
        provider, model, project_label,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens,
        input_cost_usd, output_cost_usd, cache_read_cost_usd,
        cache_write_cost_usd, total_cost_usd
      FROM usage_events_v1;
      DROP TABLE usage_events_v1;
      DROP TABLE sources_v1;
    `);
    writeMeta(db, { schema_version: HISTORY_SCHEMA_VERSION });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateSchemaV2ToV3(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(usage_events)").all().map((column) => column.name));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const column of ["runtime_context_tokens", "context_window_tokens", "compaction_reserve_tokens"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE usage_events ADD COLUMN ${column} INTEGER`);
    }
    createSchema(db);
    writeMeta(db, { schema_version: HISTORY_SCHEMA_VERSION });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw error;
  }
}

function writeMeta(db, values) {
  const statement = db.prepare("INSERT INTO history_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function openDatabase(location) {
  if (typeof DatabaseSync !== "function") throw databaseError("node:sqlite unavailable", "SQLITE_UNSUPPORTED");
  if (!ensurePrivateDirectory(location.directory) || !safeDatabaseTarget(location.databasePath, true)) {
    throw databaseError("unsafe durable history location", "UNSAFE_HISTORY");
  }
  const existed = fs.existsSync(location.databasePath);
  let db;
  try {
    db = new DatabaseSync(location.databasePath);
    const applicationId = db.prepare("PRAGMA application_id").get().application_id;
    if (applicationId !== 0 && applicationId !== HISTORY_APPLICATION_ID) throw databaseError("wrong durable history application identity", "UNSAFE_HISTORY");
    if (applicationId === 0) {
      if (existed) throw databaseError("unmarked durable history database", "UNSAFE_HISTORY");
      db.exec(`PRAGMA application_id = ${HISTORY_APPLICATION_ID};`);
    }
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
    createSchema(db);
    let meta = metadataMap(db);
    if (meta.size > 0 && meta.get("application") !== HISTORY_APPLICATION) {
      throw databaseError("wrong durable history application identity", "UNSAFE_HISTORY");
    }
    if (meta.size > 0 && meta.get("schema_version") === "1") {
      migrateSchemaV1ToV2(db);
      meta = metadataMap(db);
    }
    if (meta.size > 0 && meta.get("schema_version") === "2") {
      migrateSchemaV2ToV3(db);
      meta = metadataMap(db);
    }
    if (meta.size > 0 && meta.get("schema_version") !== HISTORY_SCHEMA_VERSION) {
      throw databaseError("durable history version mismatch", "HISTORY_VERSION_MISMATCH");
    }
    writeMeta(db, {
      application: HISTORY_APPLICATION,
      schema_version: HISTORY_SCHEMA_VERSION,
      ...(meta.get("extractor_version") ? {} : { extractor_version: USAGE_INDEX_VERSIONS.extractor }),
      history_state: meta.get("history_state") ?? "PREPARING",
      history_revision: meta.get("history_revision") ?? "0",
    });
    fs.chmodSync(location.databasePath, 0o600);
    if (!safeDatabaseTarget(location.databasePath, false)) throw databaseError("unsafe durable history permissions", "UNSAFE_HISTORY");
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* best effort */ }
    throw error;
  }
}

function closeDatabase(db) {
  try { db?.close(); } catch { /* best effort */ }
}

function readSources(db) {
  return new Map(db.prepare("SELECT * FROM sources").all().map((row) => [row.source_key, row]));
}

function sourceByPath(rows) {
  const result = new Map();
  for (const row of rows.values()) {
    const existing = result.get(row.path_key);
    if (existing && existing.source_key !== row.source_key) result.set(row.path_key, null);
    else if (!existing) result.set(row.path_key, row);
  }
  return result;
}

function sourceFingerprint(filePath, metadata = null) {
  try {
    const stat = metadata ?? fs.statSync(filePath, { bigint: true });
    if (!stat.isFile?.() && metadata === null) return null;
    return {
      hash: metadata?.hash ?? contentHash(filePath),
      size: Number(metadata?.size ?? stat.size),
      mtimeNs: metadata?.mtimeNs ?? (stat.mtimeNs?.toString() ?? null),
    };
  } catch {
    return null;
  }
}

function buildObservedSources(evidence, stored) {
  const observed = new Map();
  const byPath = new Map();
  const conflicts = new Set();
  const materialConflicts = new Set();
  for (const artifact of evidence.collected.artifacts) {
    const filePath = path.resolve(artifact.filePath);
    const pKey = pathKey(filePath, evidence.sessionRoot);
    const sKey = sessionKey(artifact.header?.id);
    const sourceKey = sourceKeyFor(sKey, pKey);
    const previous = observed.get(sourceKey);
    const fingerprint = sourceFingerprint(filePath, evidence.fileMetadata?.get(filePath) ?? null);
    const source = {
      sourceKey,
      pathKey: pKey,
      sessionKey: sKey,
      identityKind: sKey ? "SESSION" : "PATH",
      parentPathKey: typeof artifact.header?.parentSession === "string"
        ? pathKey(path.resolve(artifact.header.parentSession), evidence.sessionRoot)
        : null,
      parentSourceKey: null,
      lineageKey: null,
      present: 1,
      lineageStatus: "RESOLVED",
      lastContentHash: fingerprint?.hash ?? null,
      lastSizeBytes: fingerprint?.size ?? null,
      lastMtimeNs: fingerprint?.mtimeNs ?? null,
      lastSeenAt: Date.now(),
      filePath,
      artifact,
    };
    if (previous && previous.pathKey !== source.pathKey) {
      conflicts.add(sourceKey);
      if (previous.artifact.records.some(hasValidUsageRecord) || source.artifact.records.some(hasValidUsageRecord)) materialConflicts.add(sourceKey);
    }
    observed.set(sourceKey, previous ?? source);
    byPath.set(pKey, sourceKey);
  }
  for (const sourceKey of materialConflicts) {
    const source = observed.get(sourceKey);
    source.lineageStatus = "CONFLICTED";
    observed.set(sourceKey, source);
  }
  return { observed, byPath, conflicts, materialConflicts };
}

function resolveLineage(observed, byPath, storedByPath) {
  const resolving = new Set();
  const resolved = new Map();
  function resolve(sourceKey) {
    if (resolved.has(sourceKey)) return resolved.get(sourceKey);
    const source = observed.get(sourceKey);
    if (!source) return null;
    if (source.lineageStatus === "CONFLICTED") {
      resolved.set(sourceKey, null);
      return null;
    }
    if (resolving.has(sourceKey)) {
      source.lineageStatus = "CONFLICTED";
      resolved.set(sourceKey, null);
      return null;
    }
    resolving.add(sourceKey);
    if (!source.parentPathKey) {
      source.lineageKey = rootLineageKey(source.sourceKey);
      source.parentSourceKey = null;
      source.lineageStatus = "RESOLVED";
    } else {
      const parentKey = byPath.get(source.parentPathKey) ?? storedByPath.get(source.parentPathKey)?.source_key ?? null;
      const parent = parentKey ? observed.get(parentKey) : null;
      const storedParent = parentKey && !parent ? storedByPath.get(source.parentPathKey) : null;
      const parentLineage = parent ? resolve(parentKey) : (storedParent?.lineage_key ? { lineageKey: storedParent.lineage_key, sourceKey: storedParent.source_key } : null);
      if (!parentLineage) {
        const storedSource = storedByPath.get(source.pathKey);
        source.lineageKey = storedSource?.lineage_status === "ORPHAN_COMPAT"
          ? storedSource.lineage_key
          : rootLineageKey(source.sourceKey);
        source.parentSourceKey = null;
        source.lineageStatus = "ORPHAN_COMPAT";
      } else {
        source.parentSourceKey = parentLineage.sourceKey;
        source.lineageKey = parentLineage.lineageKey;
        source.lineageStatus = "RESOLVED";
      }
    }
    resolving.delete(sourceKey);
    const result = source.lineageStatus === "RESOLVED"
      ? { sourceKey: source.sourceKey, lineageKey: source.lineageKey }
      : null;
    resolved.set(sourceKey, result);
    return result;
  }
  for (const sourceKey of observed.keys()) resolve(sourceKey);
  return observed;
}

function preserveOrphanLineages(observed, stored, activePathKeys) {
  const reappearedParents = new Set();
  let reappeared = false;
  for (const source of observed.values()) {
    const previous = stored.get(source.sourceKey);
    if (previous?.lineage_status !== "ORPHAN_COMPAT" || !source.parentPathKey) continue;
    if (!activePathKeys.has(source.parentPathKey)) continue;
    source.lineageKey = previous.lineage_key;
    source.parentSourceKey = null;
    source.lineageStatus = "ORPHAN_COMPAT";
    reappeared = true;
    const parentSource = [...observed.values()].find((candidate) => candidate.pathKey === source.parentPathKey);
    if (parentSource) reappearedParents.add(parentSource.sourceKey);
  }
  for (const source of stored.values()) {
    if (source.lineage_status !== "ORPHAN_COMPAT" || !source.parent_path_key || !activePathKeys.has(source.parent_path_key)) continue;
    reappeared = true;
    const parentSource = [...observed.values()].find((candidate) => candidate.pathKey === source.parent_path_key);
    if (parentSource) reappearedParents.add(parentSource.sourceKey);
  }
  return { reappeared, reappearedParents };
}

function sourceDepth(source, observed, visiting = new Set()) {
  if (!source.parentSourceKey || !observed.has(source.parentSourceKey) || visiting.has(source.sourceKey)) return 0;
  visiting.add(source.sourceKey);
  return 1 + sourceDepth(observed.get(source.parentSourceKey), observed, visiting);
}

function hasValidUsageRecord(record) {
  return Boolean(record.id && record.timestampMs !== null && normalizeDurableUsage(record.usage));
}

function durableRecord(record, source) {
  const usage = normalizeDurableUsage(record.usage);
  if (!usage || !record.id || record.timestampMs === null || !source.lineageKey) return null;
  const entryKeyHash = entryKey(record.id);
  if (!entryKeyHash) return null;
  const provider = safeLabel(record.provider, UNATTRIBUTED);
  const model = safeLabel(record.model, UNATTRIBUTED);
  const project = safeLabel(record.project, UNATTRIBUTED);
  return {
    eventKey: eventKey(source.lineageKey, entryKeyHash),
    lineageKey: source.lineageKey,
    entryKeyHash,
    signatureHash: factSignature(record, provider, model, project),
    originSourceKey: source.sourceKey,
    originSessionKey: source.sessionKey,
    timestampMs: record.timestampMs,
    recordKind: record.kind,
    provider,
    model,
    projectLabel: project,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning ?? null,
    totalTokens: usage.totalTokens,
    runtimeContextTokens: record.runtimeContextTokens ?? null,
    contextWindowTokens: record.contextWindowTokens ?? null,
    compactionReserveTokens: record.compactionReserveTokens ?? null,
    inputCostUsd: usage.cost.input,
    outputCostUsd: usage.cost.output,
    cacheReadCostUsd: usage.cost.cacheRead,
    cacheWriteCostUsd: usage.cost.cacheWrite,
    totalCostUsd: usage.cost.total,
  };
}

function readEvents(db) {
  return db.prepare("SELECT * FROM usage_events ORDER BY timestamp_ms, event_key").all().map((row) => ({
    kind: row.record_kind,
    provider: row.provider,
    model: row.model,
    project: row.project_label,
    attributionConfidence: row.record_kind === "compaction" && row.provider !== UNATTRIBUTED && row.model !== UNATTRIBUTED ? "DETERMINISTIC" : null,
    timestampMs: Number(row.timestamp_ms),
    sessionKey: row.origin_session_key,
    runtimeContextTokens: row.runtime_context_tokens === null ? null : Number(row.runtime_context_tokens),
    contextWindowTokens: row.context_window_tokens === null ? null : Number(row.context_window_tokens),
    compactionReserveTokens: row.compaction_reserve_tokens === null ? null : Number(row.compaction_reserve_tokens),
    usage: {
      input: Number(row.input_tokens),
      output: Number(row.output_tokens),
      cacheRead: Number(row.cache_read_tokens),
      cacheWrite: Number(row.cache_write_tokens),
      reasoning: row.reasoning_tokens === null ? undefined : Number(row.reasoning_tokens),
      totalTokens: Number(row.total_tokens),
      cost: {
        input: Number(row.input_cost_usd),
        output: Number(row.output_cost_usd),
        cacheRead: Number(row.cache_read_cost_usd),
        cacheWrite: Number(row.cache_write_cost_usd),
        total: Number(row.total_cost_usd),
      },
    },
  }));
}

function comparableUsage(value) {
  const compactAttribution = (attribution) => ({
    status: attribution.status,
    unknownRecords: attribution.unknownRecords,
    deterministicallyRecoveredRecords: attribution.deterministicallyRecoveredRecords,
    unattributedByKind: attribution.unattributedByKind,
    unattributedRecords: attribution.unattributedRecords,
  });
  return JSON.stringify({
    windows: value.windows,
    selected: value.selected,
    tokenCategories: value.tokenCategories.map(({ key, status }) => ({ key, status })),
    cost: { status: value.cost.status, currency: value.cost.currency, amount: value.cost.amount },
    modelAttribution: compactAttribution(value.modelAttribution),
    projectAttribution: compactAttribution(value.projectAttribution),
    roleAttribution: { status: value.roleAttribution.status },
    completeness: { classification: value.completeness.classification, accountComplete: value.completeness.accountComplete },
  });
}

function historyUsage(records, metadata, selectedWindow, options, state, revision, contextCompactions = []) {
  const usage = usageResultFromRecords(records, metadata, selectedWindow, { ...options, contextCompactions });
  usage.source = "Durable local Usage history derived from Pi JSONL Usage evidence";
  usage.completeness.note = "Totals represent normalized Usage facts retained from local Pi JSONL evidence; deleted source JSONL cannot be reconstructed from this database.";
  usage.limitations = [
    "Durable history is retained local analytics, not raw Pi JSONL or transcript evidence.",
    "Provider billing and account-complete usage remain unsupported.",
    "Prompt, response, tool, transcript, session identity, and filesystem path content is never returned.",
  ];
  usage.generatedAt = new Date().toISOString();
  usage.performance = {
    sourceFilesScanned: metadata.sessionFilesScanned,
    inMemoryOnly: false,
    persistence: "DURABLE_SQLITE",
    indexBackend: "SQLITE_DURABLE",
    indexState: state,
    historyState: state,
    historyRevision: revision,
    sourceFilesDiscovered: metadata.sessionFilesDiscovered,
    sourceFilesParsed: metadata.sourceFilesParsed ?? metadata.sessionFilesScanned,
    sourceFilesHashed: metadata.sourceFilesHashed ?? metadata.sessionFilesScanned,
    sourceFilesReused: metadata.sourceFilesReused ?? 0,
    sourceFilesReindexed: metadata.sourceFilesReindexed ?? metadata.sessionFilesScanned,
    sourceFilesRemoved: metadata.sourceFilesRemoved,
    sourceBytesReindexed: metadata.sourceBytesReindexed,
    databaseSizeBytes: metadata.databaseSizeBytes,
    rebuildReason: metadata.rebuildReason,
    reconciliationReason: metadata.reconciliationReason ?? null,
    contextBackfillVersion: metadata.contextBackfillVersion ?? null,
    contextBackfillPerformed: metadata.contextBackfillPerformed ?? false,
    contextFilesParsed: metadata.contextFilesParsed ?? 0,
    contextFilesHashed: metadata.contextFilesHashed ?? 0,
    contextCompactions: metadata.contextCompactions ?? 0,
    contextTelemetryStatus: metadata.contextTelemetryStatus ?? "CLEAN",
  };
  return usage;
}

function sourceRowValues(source) {
  return [
    source.sourceKey,
    source.pathKey,
    source.sessionKey,
    source.identityKind,
    source.parentPathKey,
    source.parentSourceKey,
    source.lineageKey,
    source.present,
    source.lineageStatus,
    source.lastContentHash,
    source.lastSizeBytes,
    source.lastMtimeNs,
    source.lastSeenAt,
  ];
}

function sameSource(row, source) {
  return row
    && row.path_key === source.pathKey
    && row.session_key === source.sessionKey
    && row.identity_kind === source.identityKind
    && row.parent_path_key === source.parentPathKey
    && row.parent_source_key === source.parentSourceKey
    && row.lineage_key === source.lineageKey
    && Number(row.present) === source.present
    && row.lineage_status === source.lineageStatus
    && row.last_content_hash === source.lastContentHash
    && Number(row.last_size_bytes ?? -1) === Number(source.lastSizeBytes ?? -1)
    && String(row.last_mtime_ns ?? "") === String(source.lastMtimeNs ?? "");
}

function upsertSource(db, source) {
  db.prepare(`
    INSERT INTO sources(
      source_key, path_key, session_key, identity_kind, parent_path_key,
      parent_source_key, lineage_key, present, lineage_status,
      last_content_hash, last_size_bytes, last_mtime_ns, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      path_key = excluded.path_key,
      session_key = excluded.session_key,
      identity_kind = excluded.identity_kind,
      parent_path_key = excluded.parent_path_key,
      parent_source_key = excluded.parent_source_key,
      lineage_key = excluded.lineage_key,
      present = excluded.present,
      lineage_status = excluded.lineage_status,
      last_content_hash = excluded.last_content_hash,
      last_size_bytes = excluded.last_size_bytes,
      last_mtime_ns = excluded.last_mtime_ns,
      last_seen_at = excluded.last_seen_at
  `).run(...sourceRowValues(source));
}

function insertOrCheckEvent(db, event) {
  const existing = db.prepare("SELECT * FROM usage_events WHERE lineage_key = ? AND entry_key_hash = ?").get(event.lineageKey, event.entryKeyHash);
  if (existing) {
    return { inserted: false, duplicate: existing.signature_hash === event.signatureHash, conflict: existing.signature_hash !== event.signatureHash };
  }
  db.prepare(`
    INSERT INTO usage_events(
      event_key, lineage_key, entry_key_hash, signature_hash,
      origin_source_key, origin_session_key, timestamp_ms, record_kind,
      provider, model, project_label,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens,
      runtime_context_tokens, context_window_tokens, compaction_reserve_tokens,
      input_cost_usd, output_cost_usd, cache_read_cost_usd,
      cache_write_cost_usd, total_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventKey,
    event.lineageKey,
    event.entryKeyHash,
    event.signatureHash,
    event.originSourceKey,
    event.originSessionKey,
    event.timestampMs,
    event.recordKind,
    event.provider,
    event.model,
    event.projectLabel,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.reasoningTokens,
    event.totalTokens,
    event.runtimeContextTokens,
    event.contextWindowTokens,
    event.compactionReserveTokens,
    event.inputCostUsd,
    event.outputCostUsd,
    event.cacheReadCostUsd,
    event.cacheWriteCostUsd,
    event.totalCostUsd,
  );
  return { inserted: true, duplicate: false, conflict: false };
}

function fillMissingSessionIdentity(db, event) {
  if (!event.originSessionKey) return;
  db.prepare(`UPDATE usage_events SET origin_session_key = ? WHERE lineage_key = ? AND entry_key_hash = ? AND origin_session_key IS NULL`)
    .run(event.originSessionKey, event.lineageKey, event.entryKeyHash);
}

function readContextCompactions(db) {
  return db.prepare("SELECT * FROM context_compactions ORDER BY timestamp_ms, compaction_key").all().map((row) => ({
    compactionEntryKeyHash: row.compaction_key,
    timestampMs: Number(row.timestamp_ms),
    tokensBefore: row.tokens_before === null ? null : Number(row.tokens_before),
    provider: row.provider,
    model: row.model,
    project: row.project_label,
    reason: row.reason,
    contextWindowTokens: row.context_window_tokens === null ? null : Number(row.context_window_tokens),
    compactionReserveTokens: row.compaction_reserve_tokens === null ? null : Number(row.compaction_reserve_tokens),
  }));
}

function contextCompactionCandidate(compaction, source) {
  if (!compaction?.compactionEntryKeyHash || !source?.lineageKey || compaction.timestampMs === null) return null;
  const observation = compaction.observation ?? compaction;
  return {
    compactionKey: compactionKey(source.lineageKey, compaction.compactionEntryKeyHash),
    lineageKey: source.lineageKey,
    originSourceKey: source.sourceKey,
    originSessionKey: source.sessionKey,
    timestampMs: compaction.timestampMs,
    provider: compaction.provider ?? observation?.provider ?? null,
    model: compaction.model ?? observation?.model ?? null,
    projectLabel: safeLabel(compaction.project, UNATTRIBUTED),
    tokensBefore: validInteger(compaction.tokensBefore) ? compaction.tokensBefore : null,
    reason: COMPACTION_REASONS.has(observation?.reason) ? observation.reason : null,
    contextWindowTokens: validInteger(observation?.contextWindowTokens) ? observation.contextWindowTokens : null,
    compactionReserveTokens: validInteger(observation?.compactionReserveTokens) ? observation.compactionReserveTokens : null,
  };
}

function enrichAssistantEvent(db, source, observation) {
  if (!source?.lineageKey || !observation?.assistantEntryKeyHash) return { conflicts: 0, filled: 0 };
  const existing = db.prepare("SELECT * FROM usage_events WHERE lineage_key = ? AND entry_key_hash = ? AND record_kind = 'assistant'")
    .get(source.lineageKey, observation.assistantEntryKeyHash);
  if (!existing) return { conflicts: 0, filled: 0 };
  let conflicts = 0;
  const updates = [];
  const values = [];
  for (const [column, value] of [
    ["runtime_context_tokens", observation.runtimeContextTokens],
    ["context_window_tokens", observation.contextWindowTokens],
    ["compaction_reserve_tokens", observation.compactionReserveTokens],
  ]) {
    if (!validInteger(value)) continue;
    if (existing[column] === null) {
      updates.push(`${column} = ?`);
      values.push(value);
    } else if (Number(existing[column]) !== value) {
      conflicts += 1;
    }
  }
  if (updates.length > 0) db.prepare(`UPDATE usage_events SET ${updates.join(", ")} WHERE event_key = ?`).run(...values, existing.event_key);
  return { conflicts, filled: updates.length };
}

function insertOrEnrichContextCompaction(db, candidate) {
  if (!candidate) return { inserted: false, conflicts: 0, filled: 0 };
  const existing = db.prepare("SELECT * FROM context_compactions WHERE compaction_key = ?").get(candidate.compactionKey);
  if (!existing) {
    db.prepare(`INSERT INTO context_compactions(
      compaction_key, lineage_key, origin_source_key, origin_session_key,
      timestamp_ms, provider, model, project_label, tokens_before, reason,
      context_window_tokens, compaction_reserve_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidate.compactionKey, candidate.lineageKey, candidate.originSourceKey, candidate.originSessionKey,
        candidate.timestampMs, candidate.provider, candidate.model, candidate.projectLabel, candidate.tokensBefore,
        candidate.reason, candidate.contextWindowTokens, candidate.compactionReserveTokens);
    return { inserted: true, conflicts: 0, filled: 0 };
  }
  let conflicts = 0;
  const updates = [];
  const values = [];
  for (const [column, value] of [
    ["provider", candidate.provider],
    ["model", candidate.model],
    ["tokens_before", candidate.tokensBefore],
    ["reason", candidate.reason],
    ["context_window_tokens", candidate.contextWindowTokens],
    ["compaction_reserve_tokens", candidate.compactionReserveTokens],
  ]) {
    if (value === null || value === undefined) continue;
    if (existing[column] === null) {
      updates.push(`${column} = ?`);
      values.push(value);
    } else if (String(existing[column]) !== String(value)) {
      conflicts += 1;
    }
  }
  if (updates.length > 0) db.prepare(`UPDATE context_compactions SET ${updates.join(", ")} WHERE compaction_key = ?`).run(...values, candidate.compactionKey);
  return { inserted: false, conflicts, filled: updates.length };
}

function incrementalEvidence(discovery, stored, options = {}) {
  const forceContextScan = options.forceContextScan === true;
  const storedByPath = sourceByPath(stored);
  const artifacts = [];
  const fileMetadata = new Map();
  let unreadableFiles = 0;
  let parseErrors = 0;
  let malformedUsageRecords = 0;
  let hashedFiles = 0;
  for (const source of discovery.sources) {
    const previous = storedByPath.get(source.pathKey);
    const unchanged = previous
      && previous.lineage_status !== "CONFLICTED"
      && previous.lineage_status !== "UNRESOLVED"
      && String(previous.last_mtime_ns ?? "") === String(source.mtimeNs)
      && Number(previous.last_size_bytes ?? -1) === source.size;
    if (unchanged && !forceContextScan) continue;
    const raw = readUsageArtifact(source.filePath);
    if (!raw.readable) {
      unreadableFiles += 1;
      continue;
    }
    const fingerprint = sourceFingerprint(source.filePath);
    if (fingerprint) {
      fileMetadata.set(source.filePath, fingerprint);
      hashedFiles += 1;
    }
    parseErrors += raw.parseErrors;
    malformedUsageRecords += raw.records.filter((record) => record.usage === null).length;
    artifacts.push({ filePath: source.filePath, ...raw });
  }
  const selection = selectUsageRecords(artifacts, discovery.codeRoot);
  return {
    sessionRoot: discovery.sessionRoot,
    codeRoot: discovery.codeRoot,
    fileMetadata,
    collected: {
      files: discovery.files,
      artifacts,
      unreadableFiles,
      parseErrors,
      malformedUsageRecords,
      scanComplete: discovery.scanComplete,
      sourceFilesParsed: artifacts.length,
      sourceFilesHashed: hashedFiles,
    },
    selection,
  };
}

export function collectDurableUsage(selectedWindow = "all", options = {}) {
  if (options.forceLegacy || DatabaseSync === null) return null;
  const location = options.historyDirectory
    ? { directory: path.resolve(options.historyDirectory), databasePath: path.join(path.resolve(options.historyDirectory), HISTORY_DATABASE_NAME) }
    : resolveUsageHistoryLocation(options);
  let db;
  try {
    db = openDatabase(location);
    const meta = metadataMap(db);
    const previousState = meta.get("history_state") ?? "PREPARING";
    const previousRevision = Number(meta.get("history_revision") ?? 0);
    const storedExtractor = meta.get("extractor_version");
    const stored = readSources(db);
    const discovery = discoverUsageSources(options);
    if (storedExtractor !== String(USAGE_INDEX_VERSIONS.extractor)) {
      const mismatchState = previousRevision > 0 ? "NEEDS_RECONCILIATION" : "NEEDS_RECONCILIATION";
      writeMeta(db, { history_state: mismatchState, reconciliation_reason: "EXTRACTOR_VERSION_MISMATCH" });
      if (previousRevision === 0) return null;
      const eventRows = readEvents(db);
      return historyUsage(eventRows, {
        sessionFilesDiscovered: discovery.files.length,
        sessionFilesScanned: 0,
        sourceFilesParsed: 0,
        sourceFilesHashed: 0,
        unreadableFiles: 0,
        parseErrors: 0,
        malformedUsageRecords: 0,
        rawUsageRecords: eventRows.length,
        selectedRecords: eventRows.length,
        duplicateRecordsSuppressed: 0,
        ambiguousRecordsExcluded: 0,
        invalidTimestampRecords: 0,
        sourceFilesRemoved: 0,
        sourceBytesReindexed: 0,
        databaseSizeBytes: 0,
        rebuildReason: null,
        reconciliationReason: "EXTRACTOR_VERSION_MISMATCH",
        contextTelemetryStatus: contextTelemetryStatus(meta),
      }, selectedWindow, options, mismatchState, previousRevision, readContextCompactions(db));
    }
    const contextBackfillPending = meta.get("context_backfill_version") !== CONTEXT_BACKFILL_VERSION;
    const evidence = incrementalEvidence(discovery, stored, { forceContextScan: contextBackfillPending });
    const storedByPath = sourceByPath(stored);
    const { observed, byPath, materialConflicts } = buildObservedSources(evidence, stored);
    resolveLineage(observed, byPath, storedByPath);
    const activePathKeys = new Set(discovery.sources.map((source) => source.pathKey));
    const orphanReconciliation = preserveOrphanLineages(observed, stored, activePathKeys);

    const materialUnresolved = [...observed.values()].some((source) =>
      source.lineageStatus !== "RESOLVED"
      && source.lineageStatus !== "ORPHAN_COMPAT"
      && source.artifact.records.some(hasValidUsageRecord));
    let reconciliationReason = materialConflicts.size > 0 ? "SOURCE_IDENTITY_CONFLICT" : null;
    if (orphanReconciliation.reappeared) reconciliationReason = "ORPHAN_PARENT_REAPPEARED";
    if (materialUnresolved) reconciliationReason = reconciliationReason ?? "UNRESOLVED_PARENT_LINEAGE";
    for (const source of observed.values()) {
      const previous = stored.get(source.sourceKey);
      if (previous?.lineage_status === "CONFLICTED" && previous.last_content_hash === source.lastContentHash && source.artifact.records.some(hasValidUsageRecord)) {
        source.lineageStatus = "CONFLICTED";
        reconciliationReason = reconciliationReason ?? "SOURCE_RECONCILIATION_REQUIRED";
        continue;
      }
      if (!previous || !previous.last_content_hash || !source.lastContentHash || previous.last_content_hash === source.lastContentHash) continue;
      const appended = Number(source.lastSizeBytes) > Number(previous.last_size_bytes)
        && prefixMatches(source.filePath, Number(previous.last_size_bytes), previous.last_content_hash);
      if (!appended && source.artifact.records.some(hasValidUsageRecord)) {
        source.lineageStatus = "CONFLICTED";
        reconciliationReason = reconciliationReason ?? "SOURCE_REWRITE_OR_TRUNCATION";
      }
    }

    const currentKeys = new Set(observed.keys());
    for (const discovered of discovery.sources) {
      const previous = storedByPath.get(discovered.pathKey);
      if (previous) currentKeys.add(previous.source_key);
    }
    const missing = [...stored.values()].filter((row) => !currentKeys.has(row.source_key));
    const newlyMissing = missing.filter((row) => Number(row.present) !== 0);
    const sourceChanged = [...observed.values()].some((source) => {
      const previous = stored.get(source.sourceKey);
      return !sameSource(previous, source);
    }) || newlyMissing.length > 0;

    const candidateEvents = [];
    const candidateContextObservations = [];
    const candidateCompactions = [];
    const invalidCandidates = new Set();
    const observedByFilePath = new Map([...observed.values()].map((source) => [source.filePath, source]));
    for (const record of evidence.selection.selectedRecords) {
      const sourcePath = path.resolve(record.sourcePath ?? "");
      const source = observedByFilePath.get(sourcePath);
      if (!source || source.lineageStatus !== "RESOLVED" && source.lineageStatus !== "ORPHAN_COMPAT") continue;
      if (orphanReconciliation.reappearedParents.has(source.sourceKey)) continue;
      const event = durableRecord(record, source);
      if (!event) {
        invalidCandidates.add(source.sourceKey);
        continue;
      }
      candidateEvents.push(event);
    }
    for (const observation of evidence.selection.contextObservations ?? []) {
      const source = observedByFilePath.get(path.resolve(observation.sourcePath ?? ""));
      if (!source || (source.lineageStatus !== "RESOLVED" && source.lineageStatus !== "ORPHAN_COMPAT") || orphanReconciliation.reappearedParents.has(source.sourceKey)) continue;
      candidateContextObservations.push({ observation, source });
    }
    for (const compaction of evidence.selection.contextCompactions ?? []) {
      const source = observedByFilePath.get(path.resolve(compaction.sourcePath ?? ""));
      if (!source || (source.lineageStatus !== "RESOLVED" && source.lineageStatus !== "ORPHAN_COMPAT") || orphanReconciliation.reappearedParents.has(source.sourceKey)) continue;
      const observations = compaction.observations?.length ? compaction.observations : [null];
      for (const observation of observations) {
        const candidate = contextCompactionCandidate({ ...compaction, observation }, source);
        if (candidate) candidateCompactions.push(candidate);
      }
    }

    if (invalidCandidates.size > 0) reconciliationReason = reconciliationReason ?? "INVALID_DURABLE_TOKEN_VALUE";
    const mustBlockInitialReady = previousState !== "READY" && (!evidence.collected.scanComplete || materialUnresolved || materialConflicts.size > 0 || invalidCandidates.size > 0);

    let inserted = 0;
    let duplicateCount = 0;
    let conflictCount = 0;
    let telemetryConflictCount = 0;
    let contextCompactionInserted = 0;
    let contextEnrichmentCount = 0;
    let sourceChangedCount = 0;
    let durableRevision = previousRevision;
    db.exec("BEGIN IMMEDIATE");
    try {
      const orderedSources = [...observed.values()].sort((left, right) => sourceDepth(left, observed) - sourceDepth(right, observed));
      for (const source of orderedSources) {
        const previous = stored.get(source.sourceKey);
        if (!sameSource(previous, source)) {
          upsertSource(db, source);
          sourceChangedCount += 1;
        }
      }
      if (evidence.collected.scanComplete) {
        for (const row of newlyMissing) {
          if (Number(row.present) !== 0) {
            db.prepare("UPDATE sources SET present = 0, last_seen_at = ? WHERE source_key = ?").run(Date.now(), row.source_key);
            sourceChangedCount += 1;
          }
        }
      }
      for (const event of candidateEvents) {
        const result = insertOrCheckEvent(db, event);
        if (result.inserted) inserted += 1;
        else if (result.conflict) conflictCount += 1;
        else duplicateCount += 1;
        fillMissingSessionIdentity(db, event);
        if (!result.conflict) {
          const observation = {
            assistantEntryKeyHash: event.entryKeyHash,
            runtimeContextTokens: event.runtimeContextTokens,
            contextWindowTokens: event.contextWindowTokens,
            compactionReserveTokens: event.compactionReserveTokens,
          };
          const enrichment = enrichAssistantEvent(db, { lineageKey: event.lineageKey }, observation);
          telemetryConflictCount += enrichment.conflicts;
          contextEnrichmentCount += enrichment.filled;
        }
      }
      for (const { observation, source } of candidateContextObservations) {
        const enrichment = enrichAssistantEvent(db, source, observation);
        telemetryConflictCount += enrichment.conflicts;
        contextEnrichmentCount += enrichment.filled;
      }
      for (const candidate of candidateCompactions) {
        const result = insertOrEnrichContextCompaction(db, candidate);
        if (result.inserted) contextCompactionInserted += 1;
        contextEnrichmentCount += result.filled ?? 0;
        telemetryConflictCount += result.conflicts;
      }
      if (conflictCount > 0) reconciliationReason = reconciliationReason ?? "CONFLICTING_EVENT_SIGNATURE";
      const contextBackfillComplete = contextBackfillPending
        && evidence.collected.scanComplete
        && evidence.collected.unreadableFiles === 0;
      const hasChanges = sourceChangedCount > 0 || inserted > 0 || conflictCount > 0 || contextCompactionInserted > 0 || contextEnrichmentCount > 0 || contextBackfillComplete || mustBlockInitialReady;
      const initialBlocked = mustBlockInitialReady || conflictCount > 0;
      const nextState = (previousState === "READY" && !initialBlocked && !materialUnresolved && evidence.collected.scanComplete)
        ? (reconciliationReason ? "NEEDS_RECONCILIATION" : "READY")
        : (previousState === "READY" ? "NEEDS_RECONCILIATION" : (initialBlocked ? "NEEDS_RECONCILIATION" : "READY"));
      if ((hasChanges || (previousState !== "READY" && nextState === "READY")) && (previousRevision > 0 || nextState === "READY")) durableRevision += 1;
      writeMeta(db, {
        history_state: nextState,
        history_revision: durableRevision,
        ...(reconciliationReason ? { reconciliation_reason: reconciliationReason } : { reconciliation_reason: "" }),
        context_telemetry_conflict_seen: contextTelemetryStatus(meta, telemetryConflictCount > 0) === "CONFLICT_SEEN" ? "1" : "0",
        ...(contextBackfillComplete ? { context_backfill_version: CONTEXT_BACKFILL_VERSION } : {}),
      });
      db.exec("COMMIT");
      const stateAfterCommit = nextState;
      const eventRows = readEvents(db);
      const currentMetadata = {
        sessionFilesDiscovered: evidence.collected.files.length,
        sessionFilesScanned: evidence.collected.artifacts.length,
        sourceFilesParsed: evidence.collected.sourceFilesParsed ?? evidence.collected.artifacts.length,
        sourceFilesHashed: evidence.collected.sourceFilesHashed ?? evidence.collected.artifacts.length,
        unreadableFiles: evidence.collected.unreadableFiles,
        parseErrors: evidence.collected.parseErrors,
        malformedUsageRecords: evidence.collected.malformedUsageRecords,
        rawUsageRecords: evidence.selection.rawUsageRecords,
        selectedRecords: eventRows.length,
        duplicateRecordsSuppressed: evidence.selection.duplicateRecordsSuppressed + duplicateCount,
        ambiguousRecordsExcluded: evidence.selection.ambiguousRecordsExcluded,
        invalidTimestampRecords: evidence.selection.invalidTimestampRecords,
        sourceFilesRemoved: newlyMissing.length,
        sourceFilesReused: Math.max(0, discovery.sources.length - (evidence.collected.sourceFilesParsed ?? evidence.collected.artifacts.length)),
        sourceFilesReindexed: evidence.collected.sourceFilesParsed ?? evidence.collected.artifacts.length,
        sourceBytesReindexed: [...observed.values()].reduce((total, source) => total + (source.lastSizeBytes ?? 0), 0),
        databaseSizeBytes: 0,
        rebuildReason: previousRevision === 0 ? "INITIAL_MIGRATION" : (sourceChanged ? "SOURCE_CHANGE" : null),
        reconciliationReason: reconciliationReason ?? null,
        contextBackfillVersion: contextBackfillComplete ? CONTEXT_BACKFILL_VERSION : null,
        contextBackfillPerformed: contextBackfillPending,
        contextFilesParsed: evidence.collected.artifacts.length,
        contextFilesHashed: evidence.collected.sourceFilesHashed ?? evidence.collected.artifacts.length,
        contextCompactions: candidateCompactions.length,
        contextTelemetryStatus: contextTelemetryStatus(meta, telemetryConflictCount > 0),
      };
      currentMetadata.databaseSizeBytes = (() => {
        try { return fs.statSync(location.databasePath).size; } catch { return 0; }
      })();
      const currentUsage = historyUsage(eventRows, currentMetadata, selectedWindow, { nowMs: options.nowMs, codeRoot: evidence.codeRoot, interval: options.interval }, stateAfterCommit, durableRevision, readContextCompactions(db));
      if (previousRevision === 0 && stateAfterCommit === "READY") {
        const legacyUsage = usageResultFromRecords(evidence.selection.selectedRecords, {
          sessionFilesDiscovered: evidence.collected.files.length,
          sessionFilesScanned: evidence.collected.artifacts.length,
          unreadableFiles: evidence.collected.unreadableFiles,
          parseErrors: evidence.collected.parseErrors,
          malformedUsageRecords: evidence.collected.malformedUsageRecords,
          rawUsageRecords: evidence.selection.rawUsageRecords,
          selectedRecords: evidence.selection.selectedRecords.length,
          duplicateRecordsSuppressed: evidence.selection.duplicateRecordsSuppressed,
          ambiguousRecordsExcluded: evidence.selection.ambiguousRecordsExcluded,
          invalidTimestampRecords: evidence.selection.invalidTimestampRecords,
        }, selectedWindow, { nowMs: options.nowMs, codeRoot: evidence.codeRoot, contextCompactions: evidence.selection.contextCompactions, interval: options.interval });
        if (comparableUsage(currentUsage) !== comparableUsage(legacyUsage)) {
          db.exec("BEGIN IMMEDIATE");
          try {
            writeMeta(db, { history_state: "NEEDS_RECONCILIATION", history_revision: previousRevision, reconciliation_reason: "MIGRATION_PARITY_MISMATCH" });
            db.exec("COMMIT");
          } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* best effort */ }
            throw error;
          }
          return null;
        }
      }
      if (stateAfterCommit !== "READY" && previousRevision === 0) return null;
      return currentUsage;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  } catch {
    return null;
  } finally {
    closeDatabase(db);
  }
}

export const usageHistoryConstants = Object.freeze({
  APPLICATION_ID: HISTORY_APPLICATION_ID,
  APPLICATION_NAME: HISTORY_APPLICATION,
  DATABASE_NAME: HISTORY_DATABASE_NAME,
  DIRECTORY_NAME: HISTORY_DIRECTORY_NAME,
});
