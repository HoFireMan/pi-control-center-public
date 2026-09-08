import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectIndexedUsage, collectLegacyUsage, summarizeUsageRecords, usageIndexDiagnostics } from "./usage-index.js";

export { collectLegacyUsage, summarizeUsageRecords };

const HOME = os.homedir();
const CODE_ROOT = path.join(HOME, "code");
const PI_AGENT_ROOT = path.join(HOME, ".pi", "agent");
const SESSION_ROOT = path.join(PI_AGENT_ROOT, "sessions");
const MAX_SESSION_ITEMS = 60;
const MAX_SUBAGENT_ITEMS = 60;
const MAX_RECENT_EVIDENCE_ITEMS = 40;
const RECENT_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_SAMPLE_BYTES = 128 * 1024;
const SUBAGENTS_PACKAGE_CANDIDATES = [
  path.join(PI_AGENT_ROOT, "npm", "node_modules", "pi-subagents", "package.json"),
  path.join(process.cwd(), "node_modules", "pi-subagents", "package.json"),
];
const SAFE_GLOBAL_SETTING_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "theme",
];
const SAFE_ROLE_KEYS = ["name", "description", "model", "thinking", "defaultContext", "runner", "tools"];
const SAFE_SETTINGS_DEFINITIONS = [
  { id: "defaultProvider", category: "provider/model", name: "Default provider", path: ["defaultProvider"], type: "identifier" },
  { id: "defaultModel", category: "provider/model", name: "Default model", path: ["defaultModel"], type: "identifier" },
  { id: "defaultThinkingLevel", category: "provider/model", name: "Default thinking level", path: ["defaultThinkingLevel"], type: "thinking", values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "theme", category: "appearance", name: "Theme", path: ["theme"], type: "theme", defaultValue: "dark" },
  { id: "defaultProjectTrust", category: "project trust", name: "Default project trust", path: ["defaultProjectTrust"], type: "enum", values: ["ask", "always", "never"], defaultValue: "ask", globalOnly: true },
  { id: "quietStartup", category: "display", name: "Quiet startup", path: ["quietStartup"], type: "boolean", defaultValue: false },
  { id: "enableInstallTelemetry", category: "privacy", name: "Install telemetry", path: ["enableInstallTelemetry"], type: "boolean", defaultValue: true },
  { id: "enableAnalytics", category: "privacy", name: "Analytics opt-in", path: ["enableAnalytics"], type: "boolean", defaultValue: false },
  { id: "hideThinkingBlock", category: "display", name: "Hide thinking block", path: ["hideThinkingBlock"], type: "boolean", defaultValue: false },
  { id: "showCacheMissNotices", category: "display", name: "Cache-miss notices", path: ["showCacheMissNotices"], type: "boolean", defaultValue: false },
  { id: "steeringMode", category: "message delivery", name: "Steering mode", path: ["steeringMode"], type: "enum", values: ["all", "one-at-a-time"], defaultValue: "one-at-a-time" },
  { id: "followUpMode", category: "message delivery", name: "Follow-up mode", path: ["followUpMode"], type: "enum", values: ["all", "one-at-a-time"], defaultValue: "one-at-a-time" },
  { id: "transport", category: "message delivery", name: "Provider transport", path: ["transport"], type: "enum", values: ["sse", "websocket", "websocket-cached", "auto"], defaultValue: "auto" },
  { id: "httpIdleTimeoutMs", category: "message delivery", name: "HTTP idle timeout", path: ["httpIdleTimeoutMs"], type: "number", minimum: 0, maximum: 3_600_000, defaultValue: 300_000 },
  { id: "websocketConnectTimeoutMs", category: "message delivery", name: "WebSocket connect timeout", path: ["websocketConnectTimeoutMs"], type: "number", minimum: 0, maximum: 3_600_000, defaultValue: 15_000 },
  { id: "compaction.enabled", category: "compaction", name: "Auto-compaction", path: ["compaction", "enabled"], type: "boolean", defaultValue: true },
  { id: "compaction.reserveTokens", category: "compaction", name: "Compaction reserve tokens", path: ["compaction", "reserveTokens"], type: "number", minimum: 0, maximum: 100_000_000, defaultValue: 16_384 },
  { id: "compaction.keepRecentTokens", category: "compaction", name: "Compaction recent tokens", path: ["compaction", "keepRecentTokens"], type: "number", minimum: 0, maximum: 100_000_000, defaultValue: 20_000 },
  { id: "branchSummary.reserveTokens", category: "branch summary", name: "Branch-summary reserve tokens", path: ["branchSummary", "reserveTokens"], type: "number", minimum: 0, maximum: 100_000_000, defaultValue: 16_384 },
  { id: "branchSummary.skipPrompt", category: "branch summary", name: "Skip branch-summary prompt", path: ["branchSummary", "skipPrompt"], type: "boolean", defaultValue: false },
  { id: "retry.enabled", category: "retry", name: "Agent retry", path: ["retry", "enabled"], type: "boolean", defaultValue: true },
  { id: "retry.maxRetries", category: "retry", name: "Maximum agent retries", path: ["retry", "maxRetries"], type: "number", minimum: 0, maximum: 100, defaultValue: 3 },
  { id: "retry.baseDelayMs", category: "retry", name: "Retry base delay", path: ["retry", "baseDelayMs"], type: "number", minimum: 0, maximum: 86_400_000, defaultValue: 2_000 },
  { id: "terminal.showImages", category: "terminal", name: "Terminal images", path: ["terminal", "showImages"], type: "boolean", defaultValue: true },
  { id: "terminal.imageWidthCells", category: "terminal", name: "Terminal image width", path: ["terminal", "imageWidthCells"], type: "number", minimum: 1, maximum: 1_000, defaultValue: 60 },
  { id: "terminal.clearOnShrink", category: "terminal", name: "Clear terminal rows on shrink", path: ["terminal", "clearOnShrink"], type: "boolean", defaultValue: false },
  { id: "images.autoResize", category: "images", name: "Auto-resize images", path: ["images", "autoResize"], type: "boolean", defaultValue: true },
  { id: "images.blockImages", category: "images", name: "Block images", path: ["images", "blockImages"], type: "boolean", defaultValue: false },
  { id: "enableSkillCommands", category: "resources", name: "Skill commands", path: ["enableSkillCommands"], type: "boolean", defaultValue: true },
  { id: "defaultTools", category: "tools", name: "Default built-in tools", path: ["defaultTools"], type: "stringArray" },
  { id: "enabledModels", category: "provider/model", name: "Enabled model patterns", path: ["enabledModels"], type: "stringArray" },
];
const PROJECT_CANDIDATE_MARKERS = ["package.json", "README.md", "AGENTS.md", "CONTEXT.md", ".pi", "src", "public", "test"];
const MAX_SKILL_FILES = 500;
const SKILL_FRONTMATTER_BYTES = 64 * 1024;
const SAFE_SKILL_NAME = /^[a-z0-9-]{1,64}$/;
const SUSPICIOUS_SKILL_METADATA = /(-----BEGIN .*PRIVATE KEY-----|(?:api[_ -]?key|token|password|secret|authorization|bearer)\s*[:=]\s*\S+)/i;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function run(command, args, cwd = undefined) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function metadataForSettings(filePath, includeSafeValues = false) {
  const settings = readJson(filePath);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { present: false, safeKeys: [] };
  }

  const result = {
    present: true,
    safeKeys: Object.keys(settings).sort(),
  };
  if (includeSafeValues) {
    result.safeValues = Object.fromEntries(
      SAFE_GLOBAL_SETTING_KEYS
        .filter((key) => typeof settings[key] === "string")
        .map((key) => [key, settings[key]]),
    );
    result.packageCount = Array.isArray(settings.packages) ? settings.packages.length : 0;
  }
  return result;
}

function hasSettingPath(settings, settingPath) {
  let current = settings;
  for (const key of settingPath) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = current[key];
  }
  return true;
}

function getSettingPath(settings, settingPath) {
  let current = settings;
  for (const key of settingPath) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function mergeSettingObjects(base, overrides) {
  const result = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return result;
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = result[key];
    if (baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergeSettingObjects(baseValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function safeSettingValue(value, definition) {
  if (definition.type === "boolean") return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (definition.type === "number") {
    return typeof value === "number" && Number.isFinite(value) && value >= definition.minimum && value <= definition.maximum
      ? { ok: true, value: Math.floor(value) } : { ok: false };
  }
  if (definition.type === "stringArray") {
    if (!Array.isArray(value) || value.length > 64) return { ok: false };
    const values = value.map((entry) => safeSettingString(entry, 128));
    return values.every((entry) => entry !== null) ? { ok: true, value: values } : { ok: false };
  }
  const stringValue = safeSettingString(value, 256);
  if (stringValue === null) return { ok: false };
  if (definition.values && !definition.values.includes(stringValue)) return { ok: false };
  if (definition.type === "theme" && !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)?$/.test(stringValue)) return { ok: false };
  return { ok: true, value: stringValue };
}

function safeSettingString(value, maximum) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized || normalized.length > maximum || SUSPICIOUS_SKILL_METADATA.test(normalized)) return null;
  return normalized;
}

function readSettingsDocument(filePath, scope, location) {
  const base = { id: `pi-${scope}-settings`, scope, location, data: {}, exists: false, readable: false, parseable: false, state: "NOT_PRESENT", configuredKeyCount: 0, safeSettingCount: 0, omittedKeyCount: 0 };
  try {
    const stat = fs.statSync(filePath);
    base.exists = true;
    if (!stat.isFile()) {
      base.state = "UNREADABLE";
      return base;
    }
    fs.accessSync(filePath, fs.constants.R_OK);
    base.readable = true;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      base.state = "INVALID";
      return base;
    }
    base.data = parsed;
    base.parseable = true;
    base.state = "AVAILABLE";
    base.configuredKeyCount = Object.keys(parsed).length;
    base.safeSettingCount = SAFE_SETTINGS_DEFINITIONS.filter((definition) => hasSettingPath(parsed, definition.path) && (!definition.globalOnly || scope === "global")).length;
    base.omittedKeyCount = Math.max(0, base.configuredKeyCount - base.safeSettingCount);
    return base;
  } catch {
    if (base.exists) {
      base.state = base.readable ? "INVALID" : "UNREADABLE";
      return base;
    }
    return base;
  }
}

function configuredSettingValue(settings, definition) {
  if (!hasSettingPath(settings.data, definition.path)) return { present: false, valid: true, value: undefined };
  const safe = safeSettingValue(getSettingPath(settings.data, definition.path), definition);
  return { present: true, valid: safe.ok, value: safe.ok ? safe.value : undefined };
}

function settingRow(definition, globalSettings, projectSettings) {
  const globalValue = configuredSettingValue(globalSettings, definition);
  const projectValue = definition.globalOnly ? { present: false, valid: true, value: undefined } : configuredSettingValue(projectSettings, definition);
  const configuredValues = {};
  if (globalValue.present && globalValue.valid) configuredValues.global = globalValue.value;
  if (projectValue.present && projectValue.valid) configuredValues.project = projectValue.value;
  const staticSourcesAvailable = [globalSettings, projectSettings].every((source) => source.state === "AVAILABLE" || source.state === "NOT_PRESENT");
  const merged = staticSourcesAvailable ? mergeSettingObjects(globalSettings.data, definition.globalOnly ? {} : projectSettings.data) : null;
  const mergedValue = merged && hasSettingPath(merged, definition.path) ? safeSettingValue(getSettingPath(merged, definition.path), definition) : { ok: false };
  const defaultValue = definition.defaultValue === undefined ? undefined : safeSettingValue(definition.defaultValue, definition).value;
  const hasConfigured = globalValue.present || projectValue.present;
  const invalidConfigured = (globalValue.present && !globalValue.valid) || (projectValue.present && !projectValue.valid);
  const staticValue = mergedValue.ok ? mergedValue.value : (defaultValue !== undefined && staticSourcesAvailable ? defaultValue : undefined);
  const staticSource = projectValue.present && projectValue.valid ? "project settings" : (globalValue.present && globalValue.valid ? "global settings" : (defaultValue !== undefined ? "Pi documented default" : null));
  const effective = staticValue === undefined
    ? { status: staticSourcesAvailable && !invalidConfigured ? "NOT_CONFIGURED" : "UNSUPPORTED", value: null, source: null }
    : { status: "EFFECTIVE_STATIC", value: staticValue, source: staticSource };
  const state = invalidConfigured ? "INVALID" : (hasConfigured ? "CONFIGURED" : (defaultValue !== undefined ? "DEFAULT" : "NOT_CONFIGURED"));
  return {
    id: definition.id,
    category: definition.category,
    name: definition.name,
    scope: projectValue.present ? "project" : (globalValue.present ? "global" : (defaultValue !== undefined ? "default" : "global/project")),
    source: staticSource,
    value: staticValue ?? null,
    configured: { global: globalValue.present, project: projectValue.present },
    configuredValues,
    defaultValue: defaultValue ?? null,
    state,
    effective,
    note: invalidConfigured ? "A configured value was omitted because it did not match the safe supported shape." : "Static file precedence is shown only; CLI overrides, environment overrides, project trust, and active Pi process state are not observed.",
  };
}

function safePackageIdentifier(value) {
  const source = typeof value === "string" ? value : value?.source;
  const name = packageName(source);
  if (typeof source === "string" && source.startsWith("npm:") && name && /^[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9._+-]+)?$/.test(name)) return `npm:${name}`;
  if (typeof source === "string" && source.startsWith("git+")) return "git package";
  return "configured package";
}

export function collectSettings(globalSettingsPath, projectSettingsPath, subagentsPackage, subagentsPackageRoot) {
  const globalSettings = readSettingsDocument(globalSettingsPath, "global", "~/.pi/agent/settings.json");
  const projectSettings = readSettingsDocument(projectSettingsPath, "project", ".pi/settings.json (canonical project only)");
  const configuredPackages = [
    ...configuredPackageEntries(globalSettings.data, "global"),
    ...configuredPackageEntries(projectSettings.data, "project"),
  ];
  const packageIdentifiers = configuredPackages.map(({ pkg }) => safePackageIdentifier(pkg));
  const sources = [
    {
      id: globalSettings.id,
      name: "Pi global settings",
      scope: "global",
      source: "settings file",
      location: globalSettings.location,
      state: globalSettings.state,
      exists: globalSettings.exists,
      readable: globalSettings.readable,
      parseable: globalSettings.parseable,
      configuredKeyCount: globalSettings.configuredKeyCount,
      safeSettingCount: globalSettings.safeSettingCount,
      omittedKeyCount: globalSettings.omittedKeyCount,
      note: globalSettings.state === "AVAILABLE" ? "Readable JSON source; only curated safe settings are inspected." : (globalSettings.state === "NOT_PRESENT" ? "Optional source is absent; documented Pi defaults may apply." : "Global settings could not be safely parsed."),
    },
    {
      id: projectSettings.id,
      name: "Canonical project settings",
      scope: "project",
      source: "settings file",
      location: projectSettings.location,
      state: projectSettings.state,
      exists: projectSettings.exists,
      readable: projectSettings.readable,
      parseable: projectSettings.parseable,
      configuredKeyCount: projectSettings.configuredKeyCount,
      safeSettingCount: projectSettings.safeSettingCount,
      omittedKeyCount: projectSettings.omittedKeyCount,
      note: projectSettings.state === "AVAILABLE" ? "Only the canonical project's local settings source is inspected." : (projectSettings.state === "NOT_PRESENT" ? "Optional project source is absent; global or documented defaults may apply." : "Project settings could not be safely parsed."),
    },
    {
      id: "pi-defaults",
      name: "Pi documented defaults",
      scope: "default",
      source: "Pi settings documentation and SettingsManager getters",
      location: null,
      state: "SUPPORTED",
      exists: true,
      readable: true,
      parseable: true,
      configuredKeyCount: 0,
      safeSettingCount: SAFE_SETTINGS_DEFINITIONS.filter((definition) => definition.defaultValue !== undefined).length,
      omittedKeyCount: 0,
      note: "Only documented defaults for the curated safe inventory are represented.",
    },
    {
      id: "pi-runtime",
      name: "Pi runtime / CLI overrides",
      scope: "runtime",
      source: "standalone dashboard boundary",
      location: null,
      state: "UNSUPPORTED",
      exists: false,
      readable: false,
      parseable: false,
      configuredKeyCount: 0,
      safeSettingCount: 0,
      omittedKeyCount: 0,
      note: "The dashboard cannot observe another Pi process's CLI overrides or runtime-effective settings.",
    },
    {
      id: "pi-environment",
      name: "Pi environment overrides",
      scope: "environment",
      source: "standalone dashboard boundary",
      location: null,
      state: "UNSUPPORTED",
      exists: false,
      readable: false,
      parseable: false,
      configuredKeyCount: 0,
      safeSettingCount: 0,
      omittedKeyCount: 0,
      note: "Environment names and values are not enumerated or exposed.",
    },
    {
      id: "pi-packages",
      name: "Configured Pi packages",
      scope: "global/project",
      source: "settings package entries",
      location: null,
      state: configuredPackages.length > 0 ? "CONFIGURED_METADATA" : "NOT_CONFIGURED",
      exists: true,
      readable: true,
      parseable: true,
      configuredKeyCount: configuredPackages.length,
      safeSettingCount: configuredPackages.length,
      omittedKeyCount: 0,
      configuredPackages: packageIdentifiers,
      note: "Package identifiers are bounded metadata; installed does not mean enabled in every runtime.",
    },
  ];
  const settings = SAFE_SETTINGS_DEFINITIONS.map((definition) => settingRow(definition, globalSettings, projectSettings));
  const roles = collectRoles(subagentsPackageRoot).map((role) => ({
    name: safeSettingString(role.name, 128) ?? "unknown role",
    model: safeSettingString(role.model, 128),
    thinking: safeSettingString(role.thinking, 32),
    runner: safeSettingString(role.runner, 64),
    tools: safeSettingString(role.tools, 256),
    scope: "package",
    source: "installed pi-subagents role metadata",
    state: "AVAILABLE_METADATA",
    note: "Role frontmatter metadata only; instruction bodies and prompt templates are omitted.",
  }));
  return {
    sources,
    settings,
    packages: configuredPackages.map(({ pkg, scope }, index) => ({
      id: `package-${index + 1}`,
      identifier: safePackageIdentifier(pkg),
      scope,
      source: `${scope} settings`,
      state: "CONFIGURED",
      note: "Only a bounded package identifier is exposed; package configuration details are omitted.",
    })),
    roles,
    resolution: {
      static: {
        status: "SUPPORTED_SCOPED",
        precedence: "Project settings override global settings; nested objects merge recursively.",
        source: "Pi settings documentation and SettingsManager deep-merge implementation",
        note: "Static file resolution does not establish another Pi process's runtime-effective settings.",
      },
      runtime: {
        status: "UNSUPPORTED",
        source: "standalone dashboard boundary",
        note: "CLI flags, project trust decisions, environment overrides, and active process state are not observed.",
      },
    },
    limitations: [
      "Only the global Pi settings file and the canonical project's optional .pi/settings.json are inspected; other projects are not expanded into this Settings view.",
      "Only curated safe settings are returned. Paths, commands, credentials, authentication, proxy values, environment values, and unknown configuration fields are omitted.",
      "Static project-over-global resolution follows Pi's documented deep-merge semantics; runtime-effective values remain unsupported.",
      "Configured package and role output is metadata only; installed or configured does not prove runtime activation.",
      "This area is read-only and provides no save, apply, reset, import, export, authentication, or configuration control operation.",
    ],
    diagnostics: {
      global: globalSettings.state,
      project: projectSettings.state,
      safeInventory: settings.length > 0 ? "PASS" : "ERROR",
    },
  };
}

function inspectJsonFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: true, readable: false, valid: false };
    fs.accessSync(filePath, fs.constants.R_OK);
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { exists: true, readable: true, valid: value !== null && typeof value === "object" && !Array.isArray(value) };
  } catch (error) {
    try {
      fs.statSync(filePath);
      return { exists: true, readable: false, valid: false };
    } catch {
      return { exists: false, readable: false, valid: false };
    }
  }
}

function parseRoleMetadata(filePath) {
  const text = readText(filePath);
  if (text === null) return null;
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const fields = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!field || !SAFE_ROLE_KEYS.includes(field[1])) continue;
      const value = field[2].trim();
      if (value && value !== "|" && value !== ">") fields[field[1]] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  const name = fields.name ?? path.basename(filePath, ".md");
  return {
    name,
    description: fields.description ?? null,
    model: fields.model ?? null,
    thinking: fields.thinking ?? null,
    defaultContext: fields.defaultContext ?? null,
    runner: fields.runner || "native Pi",
    tools: fields.tools ?? null,
  };
}

function findSubagentsPackage() {
  for (const candidate of SUBAGENTS_PACKAGE_CANDIDATES) {
    const manifest = readJson(candidate);
    if (manifest?.name === "pi-subagents") return { path: candidate, manifest };
  }
  return null;
}

function collectRoles(packageRoot) {
  if (!packageRoot) return [];
  const rolesDirectory = path.join(packageRoot, "agents");
  try {
    return fs.readdirSync(rolesDirectory)
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .map((entry) => parseRoleMetadata(path.join(rolesDirectory, entry)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function projectMetadata(projectDirectory) {
  const relativePath = path.relative(HOME, projectDirectory);
  const settingsPath = path.join(projectDirectory, ".pi", "settings.json");
  const settings = metadataForSettings(settingsPath);
  return {
    name: path.basename(projectDirectory),
    path: relativePath.startsWith("..") ? relativePath : `~/${relativePath}`,
    governance: {
      AGENTS: fs.existsSync(path.join(projectDirectory, "AGENTS.md")),
      CONTEXT: fs.existsSync(path.join(projectDirectory, "CONTEXT.md")),
      README: fs.existsSync(path.join(projectDirectory, "README.md")),
      piSettings: fs.existsSync(settingsPath),
    },
    piConfig: {
      present: settings.present,
      safeKeys: settings.safeKeys,
      roleOverridePresent: settings.safeKeys.includes("subagents"),
    },
  };
}

function collectProject(projectDirectory) {
  const metadata = projectMetadata(projectDirectory);
  const isRepository = run("git", ["rev-parse", "--is-inside-work-tree"], projectDirectory) === "true";
  if (!isRepository && !PROJECT_CANDIDATE_MARKERS.some((marker) => fs.existsSync(path.join(projectDirectory, marker)))) return null;

  if (!isRepository) {
    return {
      ...metadata,
      classification: "NON_GIT_CANDIDATE",
      gitRepository: false,
      branch: null,
      head: null,
      dirty: null,
      trackedModification: null,
      untracked: null,
    };
  }

  const branch = run("git", ["branch", "--show-current"], projectDirectory) || "detached HEAD";
  const head = run("git", ["rev-parse", "--short", "HEAD"], projectDirectory);
  const porcelainStatus = run("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], projectDirectory);
  const statusLines = porcelainStatus ? porcelainStatus.split("\n").filter(Boolean) : [];
  const untracked = statusLines.some((line) => line.startsWith("?? "));
  const trackedModification = statusLines.some((line) => !line.startsWith("?? "));
  return {
    ...metadata,
    classification: "GIT_PROJECT",
    gitRepository: true,
    branch,
    head,
    dirty: porcelainStatus !== null && porcelainStatus.length > 0,
    trackedModification,
    untracked,
  };
}

export function collectProjects() {
  try {
    return fs.readdirSync(CODE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => collectProject(path.join(CODE_ROOT, entry.name)))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function safeGitValue(value, fallback = null) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized.length > 0 ? normalized.slice(0, 256) : fallback;
}

function safeWorktreeReason(value, kind) {
  const reason = safeGitValue(value);
  if (!reason) return null;
  if (reason.includes("/") || reason.includes("\\") || /^[A-Za-z]:/.test(reason)) return `Git reported a ${kind} reason with path detail (redacted)`;
  return reason;
}

function safeWorktreePath(value) {
  if (typeof value !== "string" || value.length === 0) return { path: null, pathState: "UNAVAILABLE" };
  const resolved = path.resolve(value);
  const relativeToCode = path.relative(CODE_ROOT, resolved);
  if (!relativeToCode || (!relativeToCode.startsWith("..") && !path.isAbsolute(relativeToCode))) {
    return { path: `~/${path.relative(HOME, resolved)}`, pathState: fs.existsSync(resolved) ? "AVAILABLE" : "MISSING" };
  }
  return { path: "outside ~/code", pathState: fs.existsSync(resolved) ? "OUTSIDE_SAFE_SCOPE" : "MISSING_OUTSIDE_SAFE_SCOPE" };
}

export function parseWorktreePorcelain(output) {
  if (typeof output !== "string") return [];
  const records = [];
  let current = null;
  const finish = () => {
    if (current) records.push(current);
    current = null;
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      finish();
      current = { rawPath: line.slice("worktree ".length), head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, prunableReason: null };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim() || null;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableReason = line.slice("prunable".length).trim() || null;
    }
  }
  finish();
  return records;
}

function normalizeWorktreeBranch(branch) {
  const value = safeGitValue(branch);
  if (!value) return null;
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length).slice(0, 128) : value.slice(0, 128);
}

function normalizeWorktreeHead(head) {
  const value = safeGitValue(head);
  return value && /^[0-9a-f]{7,64}$/i.test(value) ? value.slice(0, 12) : null;
}

function collectWorktreeStatus(worktreePath, pathState, bare) {
  if (bare || !worktreePath || pathState === "MISSING" || pathState === "MISSING_OUTSIDE_SAFE_SCOPE") {
    return { status: "UNAVAILABLE", staged: null, trackedModifications: null, untracked: null, note: "Working-tree status is unavailable because the worktree path is missing or the record is bare." };
  }
  const porcelain = run("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], worktreePath);
  if (porcelain === null) return { status: "UNAVAILABLE", staged: null, trackedModifications: null, untracked: null, note: "Git working-tree status could not be collected." };
  const lines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
  let staged = 0;
  let trackedModifications = 0;
  let untracked = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === "??") { untracked += 1; continue; }
    if (code[0] && code[0] !== " ") staged += 1;
    if (code[1] && code[1] !== " ") trackedModifications += 1;
  }
  return {
    status: lines.length === 0 ? "CLEAN" : "DIRTY",
    staged,
    trackedModifications,
    untracked,
    note: "Git status --porcelain counts only; file names and diffs are omitted.",
  };
}

function worktreeNote(record, pathState) {
  const notes = [];
  if (record.bare) notes.push("bare repository record");
  if (record.detached || !record.branch) notes.push("detached HEAD");
  if (record.locked) notes.push("locked; no lock or unlock operation is available");
  if (record.prunable) notes.push("prunable administrative metadata; this does not imply safe deletion");
  if (pathState !== "AVAILABLE") notes.push(`path state: ${pathState}`);
  return notes.join(" · ") || "Git worktree metadata is available.";
}

export function collectWorktrees(projects) {
  const repositories = new Map();
  let identityFailures = 0;
  let commandFailures = 0;
  let statusFailures = 0;
  for (const project of projects.filter((candidate) => candidate.gitRepository)) {
    const projectPath = path.join(CODE_ROOT, project.name);
    const commonDirectory = run("git", ["rev-parse", "--git-common-dir"], projectPath);
    if (!commonDirectory) {
      identityFailures += 1;
      repositories.set(`unavailable:${project.name}`, { project, status: "UNAVAILABLE", rawWorktrees: [], note: "Git common-directory identity could not be resolved." });
      continue;
    }
    const identity = path.resolve(projectPath, commonDirectory);
    if (repositories.has(identity)) continue;
    const porcelain = run("git", ["worktree", "list", "--porcelain"], projectPath);
    if (porcelain === null) {
      commandFailures += 1;
      repositories.set(identity, { project, status: "UNAVAILABLE", rawWorktrees: [], note: "Git worktree list could not be collected." });
      continue;
    }
    const rawWorktrees = parseWorktreePorcelain(porcelain);
    repositories.set(identity, { project, status: rawWorktrees.length > 0 ? "AVAILABLE" : "DEGRADED", rawWorktrees, note: rawWorktrees.length > 0 ? "Grouped by Git common-directory identity; Git porcelain order identifies the main worktree." : "Git returned no parseable worktree records." });
  }
  const output = [];
  for (const repository of repositories.values()) {
    const worktrees = repository.rawWorktrees.map((record, index) => {
      const location = safeWorktreePath(record.rawPath);
      const branch = normalizeWorktreeBranch(record.branch);
      const detached = Boolean(record.detached || (!branch && !record.bare));
      const status = collectWorktreeStatus(record.rawPath, location.pathState, record.bare);
      if (status.status === "UNAVAILABLE" && location.pathState === "AVAILABLE" && !record.bare) statusFailures += 1;
      return {
        id: `worktree-${index + 1}`,
        path: location.path,
        pathState: location.pathState,
        kind: index === 0 ? "MAIN" : "LINKED",
        branch,
        head: normalizeWorktreeHead(record.head),
        detached,
        bare: record.bare,
        locked: record.locked,
        lockReason: record.locked ? safeWorktreeReason(record.lockReason, "lock") : null,
        prunable: record.prunable,
        prunableReason: record.prunable ? safeWorktreeReason(record.prunableReason, "prune") : null,
        status: status.status,
        staged: status.staged,
        trackedModifications: status.trackedModifications,
        untracked: status.untracked,
        statusNote: status.note,
        note: worktreeNote(record, location.pathState),
      };
    });
    const main = worktrees.find((worktree) => worktree.kind === "MAIN") ?? null;
    output.push({
      id: `repository-${output.length + 1}`,
      displayName: repository.project.name,
      status: repository.status,
      mainWorktree: main ? { id: main.id, path: main.path } : null,
      worktreeCount: worktrees.length,
      linkedWorktreeCount: worktrees.filter((worktree) => worktree.kind === "LINKED").length,
      worktrees,
      note: repository.note,
    });
  }
  output.sort((left, right) => left.displayName.localeCompare(right.displayName));
  const allWorktrees = output.flatMap((repository) => repository.worktrees);
  return {
    source: "Git worktree list --porcelain for Git repositories discovered as direct ~/code projects",
    scope: "Direct-child ~/code project discovery; linked paths are included only when Git reports them.",
    summary: {
      repositoryCount: output.length,
      worktreeCount: allWorktrees.length,
      linkedWorktreeCount: allWorktrees.filter((worktree) => worktree.kind === "LINKED").length,
      mainWorktreeCount: allWorktrees.filter((worktree) => worktree.kind === "MAIN").length,
      detachedCount: allWorktrees.filter((worktree) => worktree.detached).length,
      lockedCount: allWorktrees.filter((worktree) => worktree.locked).length,
      prunableCount: allWorktrees.filter((worktree) => worktree.prunable).length,
      dirtyCount: allWorktrees.filter((worktree) => worktree.status === "DIRTY").length,
      unavailableCount: allWorktrees.filter((worktree) => worktree.status === "UNAVAILABLE").length,
    },
    repositories: output,
    commandFailures,
    identityFailures,
    statusFailures,
    limitations: [
      "Git worktree metadata is inventory evidence; no create, remove, prune, move, lock, unlock, checkout, or branch operation is available.",
      "The first record in Git worktree porcelain output is treated as the main worktree; subsequent records are linked worktrees.",
      "Prunable means Git reports administrative metadata eligible for pruning; it does not imply safe deletion.",
      "Working-tree status exposes bounded counts only; file names, ignored files, and diffs are never returned.",
    ],
  };
}

function safeIsoTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeLocation(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const resolved = path.resolve(value);
  if (resolved === HOME || resolved.startsWith(`${HOME}${path.sep}`)) {
    return `~${resolved.slice(HOME.length)}`;
  }
  return `outside home · ${path.basename(resolved) || "unknown location"}`;
}

function projectId(name) {
  return typeof name === "string" && name.length > 0 ? `project:${name}` : "project:unattributed";
}

function pathContains(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeWorkspaceLabel(worktreePath) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("~/")) return null;
  const label = path.basename(worktreePath);
  return label && label !== "." ? label.slice(0, 128) : null;
}

function displayPathToAbsolute(displayPath) {
  if (typeof displayPath !== "string" || !displayPath.startsWith("~/")) return null;
  return path.resolve(HOME, displayPath.slice(2));
}

export function attributeProject(cwd, projects = [], worktrees = { repositories: [] }) {
  if (typeof cwd !== "string" || cwd.length === 0) return { project: "UNATTRIBUTED", projectId: projectId(null), workspace: null, method: "UNATTRIBUTED" };
  const resolved = path.resolve(cwd);
  const worktreeMatches = [];
  for (const repository of worktrees.repositories ?? []) {
    for (const worktree of repository.worktrees ?? []) {
      const worktreeRoot = displayPathToAbsolute(worktree.path);
      if (worktreeRoot && pathContains(worktreeRoot, resolved)) {
        worktreeMatches.push({ root: worktreeRoot, repository, worktree });
      }
    }
  }
  worktreeMatches.sort((left, right) => right.root.length - left.root.length);
  const worktreeMatch = worktreeMatches[0];
  if (worktreeMatch && projects.some((project) => project.name === worktreeMatch.repository.displayName)) {
    return {
      project: worktreeMatch.repository.displayName,
      projectId: projectId(worktreeMatch.repository.displayName),
      workspace: worktreeMatch.worktree.kind === "LINKED" ? safeWorkspaceLabel(worktreeMatch.worktree.path) : null,
      method: "GIT_WORKTREE_IDENTITY",
    };
  }
  const directMatches = projects
    .map((project) => ({ project, root: path.join(CODE_ROOT, project.name) }))
    .filter(({ project, root }) => project && pathContains(root, resolved))
    .sort((left, right) => right.root.length - left.root.length);
  const directMatch = directMatches[0];
  if (directMatch) {
    return {
      project: directMatch.project.name,
      projectId: projectId(directMatch.project.name),
      workspace: null,
      method: "DIRECT_PROJECT_PATH",
    };
  }
  return { project: "UNATTRIBUTED", projectId: projectId(null), workspace: null, method: "UNATTRIBUTED" };
}

export function lifecycleResult(state) {
  const normalized = typeof state === "string" ? state.toLowerCase() : "";
  if (["complete", "completed", "success", "succeeded"].includes(normalized)) return "COMPLETED";
  if (["failed", "failure", "error"].includes(normalized)) return "FAILED";
  return "UNKNOWN";
}

function readWindow(filePath, position, length) {
  let descriptor;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, Math.min(position, size));
    const bytesToRead = Math.min(length, Math.max(0, size - start));
    const buffer = Buffer.alloc(bytesToRead);
    descriptor = fs.openSync(filePath, "r");
    fs.readSync(descriptor, buffer, 0, bytesToRead, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function parseLines(sample) {
  const records = [];
  for (const line of sample.split("\n")) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* partial sample line */ }
  }
  return records;
}

function listSessionFiles(directory, result = []) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) listSessionFiles(filePath, result);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(filePath);
  }
  return result;
}

function readSessionHeader(filePath) {
  const header = parseLines(readWindow(filePath, 0, 4096))[0];
  return header?.type === "session" && typeof header.id === "string" ? header : null;
}

function collectOneSession(filePath, header, stat, projects, worktrees, includeDetail = true) {
  if (!header) return null;

  let provider = null;
  let model = null;
  let thinking = null;
  if (includeDetail) {
    const tail = readWindow(filePath, Math.max(0, stat.size - SESSION_SAMPLE_BYTES), SESSION_SAMPLE_BYTES);
    for (const entry of parseLines(tail)) {
      if (entry.type === "model_change") {
        if (typeof entry.provider === "string") provider = entry.provider;
        if (typeof entry.modelId === "string") model = entry.modelId;
      } else if (entry.type === "thinking_level_change") {
        if (typeof entry.thinkingLevel === "string") thinking = entry.thinkingLevel;
      } else if (entry.type === "message" && entry.message?.role === "assistant") {
        if (typeof entry.message.provider === "string") provider = entry.message.provider;
        if (typeof entry.message.model === "string") model = entry.message.model;
      }
    }
  }

  const attribution = attributeProject(header.cwd, projects, worktrees);
  return {
    id: header.id,
    version: typeof header.version === "number" ? header.version : 1,
    project: attribution.project,
    projectId: attribution.projectId,
    workspace: attribution.workspace,
    attribution: attribution.method,
    createdAt: typeof header.timestamp === "string" ? header.timestamp : null,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    updatedSource: "filesystem mtime",
    provider,
    model,
    thinking,
    fileSizeBytes: stat.size,
    status: "unknown",
  };
}

function collectSessionMetadata(projects = [], worktrees = { repositories: [] }) {
  const files = listSessionFiles(SESSION_ROOT);
  const candidates = files.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      const header = readSessionHeader(filePath);
      return header ? { filePath, stat, header, mtimeMs: stat.mtimeMs } : null;
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const allItems = candidates
    .map((candidate, index) => collectOneSession(candidate.filePath, candidate.header, candidate.stat, projects, worktrees, index < MAX_SESSION_ITEMS))
    .filter(Boolean);
  const items = allItems.slice(0, MAX_SESSION_ITEMS);
  return {
    source: "~/.pi/agent/sessions/**/*.jsonl · documented Pi JSONL session artifacts (session headers only; transcript artifacts excluded)",
    totalDiscovered: allItems.length,
    returned: items.length,
    truncated: allItems.length > MAX_SESSION_ITEMS,
    liveState: {
      status: "unsupported",
      note: "A standalone process cannot reliably identify whether a session is currently active from session files alone.",
    },
    items,
    aggregationItems: allItems,
  };
}

function artifactRoots() {
  try {
    return fs.readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-subagents-"))
      .map((entry) => path.join(os.tmpdir(), entry.name, "async-subagent-runs"))
      .filter((directory) => fs.existsSync(directory));
  } catch {
    return [];
  }
}

function collectOneSubagentRun(statusPath, projects, worktrees) {
  const status = readJson(statusPath);
  if (!status || typeof status !== "object") return null;
  const cwd = typeof status.cwd === "string" ? path.resolve(status.cwd) : null;
  if (!cwd || (cwd !== CODE_ROOT && !cwd.startsWith(`${CODE_ROOT}${path.sep}`))) return null;
  const attribution = attributeProject(cwd, projects, worktrees);
  const startedAt = safeIsoTime(status.startedAt);
  const endedAt = safeIsoTime(status.endedAt);
  const durationMs = typeof status.durationMs === "number"
    ? status.durationMs
    : (typeof status.startedAt === "number" && typeof status.endedAt === "number" ? Math.max(0, status.endedAt - status.startedAt) : null);
  const steps = Array.isArray(status.steps) ? status.steps.map((step) => ({
    agent: typeof step.agent === "string" ? step.agent : null,
    model: typeof step.model === "string" ? step.model : null,
    thinking: typeof step.thinking === "string" ? step.thinking : null,
    state: typeof step.status === "string" ? step.status : "unknown",
    startedAt: safeIsoTime(step.startedAt),
    endedAt: safeIsoTime(step.endedAt),
    durationMs: typeof step.durationMs === "number" ? step.durationMs : null,
    turnCount: typeof step.turnCount === "number" ? step.turnCount : null,
    toolCount: typeof step.toolCount === "number" ? step.toolCount : null,
  })) : [];
  return {
    id: typeof status.runId === "string" ? status.runId : null,
    state: typeof status.state === "string" ? status.state : "unknown",
    result: lifecycleResult(status.state),
    mode: typeof status.mode === "string" ? status.mode : null,
    project: attribution.project,
    projectId: attribution.projectId,
    workspace: attribution.workspace,
    attribution: attribution.method,
    startedAt,
    endedAt,
    updatedAt: (() => {
      try { return new Date(fs.statSync(statusPath).mtimeMs).toISOString(); } catch { return endedAt ?? startedAt; }
    })(),
    durationMs,
    processTerminalProof: typeof status.processTerminal?.state === "string" ? status.processTerminal.state : "unknown",
    steps,
  };
}

function collectSubagentArtifacts(projects = [], worktrees = { repositories: [] }) {
  const statusPaths = [];
  for (const root of artifactRoots()) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statusPath = path.join(root, entry.name, "status.json");
      if (fs.existsSync(statusPath)) statusPaths.push(statusPath);
    }
  }
  const allItems = statusPaths.map((statusPath) => collectOneSubagentRun(statusPath, projects, worktrees)).filter(Boolean);
  const stateCounts = {};
  for (const item of allItems) stateCounts[item.state] = (stateCounts[item.state] ?? 0) + 1;
  allItems.sort((left, right) => (right.updatedAt ?? right.startedAt ?? "").localeCompare(left.updatedAt ?? left.startedAt ?? ""));
  const items = allItems.slice(0, MAX_SUBAGENT_ITEMS);
  return {
    source: "scoped pi-subagents status.json files under the documented temporary async-run roots",
    scope: "runs whose recorded cwd is under ~/code",
    totalDiscovered: allItems.length,
    returned: items.length,
    truncated: allItems.length > MAX_SUBAGENT_ITEMS,
    stateCounts,
    liveCrossProcess: {
      status: "unsupported",
      note: "pi-subagents RPC and event-bus surfaces are process-local; status artifacts are historical/scoped evidence, not a live attachment.",
    },
    items,
    aggregationItems: allItems,
  };
}

function activityTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function createProjectActivity(projects, worktrees, sessions, lifecycleArtifacts, generatedAt) {
  const nowMs = Date.parse(generatedAt) || Date.now();
  const recentCutoff = nowMs - RECENT_EVIDENCE_WINDOW_MS;
  const rows = new Map();
  for (const project of projects) {
    rows.set(projectId(project.name), {
      projectId: projectId(project.name),
      projectName: project.name,
      normalizedPath: project.path,
      sessionCount: 0,
      recentSessionCount: 0,
      lastEvidenceAt: null,
      historicalLifecycleCount: 0,
      completedCount: 0,
      failedCount: 0,
      unknownLifecycleCount: 0,
      unresolvedLifecycleCount: 0,
      worktreeActivityCount: 0,
      liveState: { status: "UNSUPPORTED", note: "Live running state is unavailable from this standalone process." },
    });
  }
  const ensureRow = (item) => {
    const id = item.projectId ?? projectId(null);
    if (!rows.has(id)) rows.set(id, {
      projectId: id,
      projectName: "UNATTRIBUTED",
      normalizedPath: "UNATTRIBUTED",
      sessionCount: 0,
      recentSessionCount: 0,
      lastEvidenceAt: null,
      historicalLifecycleCount: 0,
      completedCount: 0,
      failedCount: 0,
      unknownLifecycleCount: 0,
      unresolvedLifecycleCount: 0,
      worktreeActivityCount: 0,
      liveState: { status: "UNSUPPORTED", note: "Live running state is unavailable from this standalone process." },
    });
    return rows.get(id);
  };
  const recentActivity = [];
  const sessionItems = new Map();
  for (const session of sessions.aggregationItems ?? sessions.items ?? []) {
    if (!sessionItems.has(session.id)) sessionItems.set(session.id, session);
  }
  for (const session of sessionItems.values()) {
    const row = ensureRow(session);
    const time = activityTime(session.updatedAt);
    row.sessionCount += 1;
    if (time !== null && time >= recentCutoff) row.recentSessionCount += 1;
    if (time !== null && (!row.lastEvidenceAt || time > activityTime(row.lastEvidenceAt))) row.lastEvidenceAt = session.updatedAt;
    if (session.workspace) row.worktreeActivityCount += 1;
    if (time !== null && time >= recentCutoff) recentActivity.push({
      id: `session:${session.id}`,
      projectId: session.projectId,
      project: session.project,
      type: "Pi session",
      identifier: session.id,
      role: null,
      workspace: session.workspace,
      updatedAt: session.updatedAt,
      historicalResult: "UNKNOWN",
    });
  }
  const lifecycleItems = lifecycleArtifacts.aggregationItems ?? lifecycleArtifacts.items ?? [];
  const lifecycleIds = new Set();
  for (const run of lifecycleItems) {
    const row = ensureRow(run);
    const time = activityTime(run.updatedAt ?? run.endedAt ?? run.startedAt);
    if (run.workspace) row.worktreeActivityCount += 1;
    if (time !== null && (!row.lastEvidenceAt || time > activityTime(row.lastEvidenceAt))) row.lastEvidenceAt = run.updatedAt ?? run.endedAt ?? run.startedAt;
    const stableId = typeof run.id === "string" && run.id.length > 0 ? run.id : null;
    if (stableId && lifecycleIds.has(stableId)) continue;
    if (stableId) {
      lifecycleIds.add(stableId);
      row.historicalLifecycleCount += 1;
      if (run.result === "COMPLETED") row.completedCount += 1;
      else if (run.result === "FAILED") row.failedCount += 1;
      else row.unknownLifecycleCount += 1;
    } else {
      row.unresolvedLifecycleCount += 1;
    }
    if (time !== null && time >= recentCutoff) recentActivity.push({
      id: `lifecycle:${stableId ?? `${row.projectId}:${recentActivity.length}`}`,
      projectId: run.projectId,
      project: run.project,
      type: "Subagent lifecycle",
      identifier: stableId ?? "UNRESOLVED",
      role: run.steps?.find((step) => typeof step.agent === "string")?.agent ?? null,
      workspace: run.workspace,
      updatedAt: run.updatedAt ?? run.endedAt ?? run.startedAt,
      historicalResult: run.result,
    });
  }
  const projectRows = [...rows.values()].sort((left, right) => {
    if (left.projectName === "UNATTRIBUTED") return 1;
    if (right.projectName === "UNATTRIBUTED") return -1;
    return left.projectName.localeCompare(right.projectName);
  });
  recentActivity.sort((left, right) => (activityTime(right.updatedAt) ?? 0) - (activityTime(left.updatedAt) ?? 0));
  const summary = projectRows.reduce((total, row) => ({
    projectCount: total.projectCount + (row.projectName === "UNATTRIBUTED" ? 0 : 1),
    projectsWithEvidence: total.projectsWithEvidence + (row.projectName !== "UNATTRIBUTED" && row.sessionCount + row.historicalLifecycleCount > 0 ? 1 : 0),
    sessionCount: total.sessionCount + row.sessionCount,
    recentSessionCount: total.recentSessionCount + row.recentSessionCount,
    historicalLifecycleCount: total.historicalLifecycleCount + row.historicalLifecycleCount,
    completedCount: total.completedCount + row.completedCount,
    failedCount: total.failedCount + row.failedCount,
    unknownLifecycleCount: total.unknownLifecycleCount + row.unknownLifecycleCount,
    unresolvedLifecycleCount: total.unresolvedLifecycleCount + row.unresolvedLifecycleCount,
    unattributedEvidenceCount: total.unattributedEvidenceCount + (row.projectName === "UNATTRIBUTED" ? row.sessionCount + row.historicalLifecycleCount + row.unresolvedLifecycleCount : 0),
  }), { projectCount: 0, projectsWithEvidence: 0, sessionCount: 0, recentSessionCount: 0, historicalLifecycleCount: 0, completedCount: 0, failedCount: 0, unknownLifecycleCount: 0, unresolvedLifecycleCount: 0, unattributedEvidenceCount: 0 });
  return {
    summary: { ...summary, recentEvidenceCount: recentActivity.length },
    projects: projectRows,
    recentEvidence: recentActivity.slice(0, MAX_RECENT_EVIDENCE_ITEMS),
    recentEvidenceWindow: {
      hours: 24,
      timezone: "local",
      label: "Last 24 hours",
      definition: "Evidence whose persisted update timestamp is within the previous 24 hours; this does not indicate live execution.",
    },
    lifecycle: {
      identity: "status.json runId",
      entity: "one uniquely identified historical pi-subagents lifecycle artifact/run; not a current Agent count",
      resultEvidence: "COMPLETED and FAILED are counted only from explicit lifecycle state values; other states remain UNKNOWN.",
    },
    liveState: { status: "UNSUPPORTED", note: "Live running state is unavailable. Recent activity represents persisted evidence, not confirmed running processes." },
    limitations: [
      "Pi Sessions and pi-subagents lifecycle evidence are separate populations and are never added together as Agent counts.",
      "Project attribution uses known direct project paths or Git-reported worktree identity; unresolved evidence is UNATTRIBUTED.",
      "Historical lifecycle counts use stable status.json runId values; lifecycle artifacts without runId are not counted as unique entities.",
      "The recent evidence window is the previous 24 hours by persisted update timestamp and is not a live-state heuristic.",
    ],
  };
}

const MAX_MCP_CONFIG_BYTES = 512 * 1024;
const MAX_MCP_SERVER_DEFINITIONS = 256;
const MAX_MCP_PROCESS_ENTRIES = 4096;

const MCP_SOURCE_ORDER = [
  { id: "global-config", name: "Global MCP configuration", scope: "global", source: "global-config", category: "global" },
  { id: "agents-global-config", name: "Global .agents MCP configuration", scope: "global", source: "global-config", category: "global" },
  { id: "agents-nested-global-config", name: "Global nested .agents MCP configuration", scope: "global", source: "global-config", category: "global" },
  { id: "pi-global-config", name: "Pi global MCP configuration", scope: "global", source: "global-config", category: "global" },
  { id: "project-config", name: "Project MCP configuration", scope: "project", source: "project-config", category: "project" },
  { id: "pi-project-config", name: "Project Pi MCP configuration", scope: "project", source: "project-config", category: "project" },
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mcpSourcePathMap(globalSettingsPath, projectSettingsPath) {
  const agentRoot = globalSettingsPath ? path.dirname(globalSettingsPath) : path.join(HOME, ".pi", "agent");
  const projectRoot = projectSettingsPath ? path.dirname(path.dirname(projectSettingsPath)) : process.cwd();
  const globalConfigRoot = path.join(HOME, ".config", "mcp");
  const agentsRoot = path.join(HOME, ".agents");
  return [
    path.join(globalConfigRoot, "mcp.json"),
    path.join(agentsRoot, "mcp.json"),
    path.join(agentsRoot, "mcp", "mcp.json"),
    path.join(agentRoot, "mcp.json"),
    path.join(projectRoot, ".mcp.json"),
    path.join(projectRoot, ".pi", "mcp.json"),
  ];
}

function defaultMcpSourceSpecs(globalSettingsPath, projectSettingsPath) {
  return MCP_SOURCE_ORDER.map((source, index) => ({
    ...source,
    path: mcpSourcePathMap(globalSettingsPath, projectSettingsPath)[index],
    precedence: index + 1,
  }));
}

function readMcpConfigFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_MCP_CONFIG_BYTES) return { state: "INVALID_CONFIG", servers: [], invalid: true };
    fs.accessSync(filePath, fs.constants.R_OK);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(raw)) return { state: "INVALID_CONFIG", servers: [], invalid: true };
    const rawServers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
    if (!isRecord(rawServers)) return { state: "INVALID_CONFIG", servers: [], invalid: true };
    const servers = [];
    let invalidEntries = 0;
    for (const [name, definition] of Object.entries(rawServers)) {
      if (servers.length >= MAX_MCP_SERVER_DEFINITIONS) {
        invalidEntries += 1;
        continue;
      }
      if (!isRecord(definition)) {
        invalidEntries += 1;
        continue;
      }
      servers.push({ name, definition });
    }
    return { state: "AVAILABLE", servers, invalidEntries, invalid: false };
  } catch {
    try {
      fs.statSync(filePath);
      return { state: "INVALID_CONFIG", servers: [], invalid: true };
    } catch {
      return { state: "UNAVAILABLE", servers: [], invalid: false };
    }
  }
}

function mcpTransport(definition) {
  if (typeof definition.command === "string" && definition.command.trim()) return "stdio";
  if (typeof definition.url === "string" && definition.url.trim()) return definition.httpTransport === "sse" ? "sse" : "http";
  return "unknown";
}

function executableAvailable(command, cwd) {
  if (typeof command !== "string" || !command.trim()) return false;
  const candidates = [];
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    candidates.push(path.resolve(cwd || process.cwd(), command));
  } else {
    for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
      if (directory) candidates.push(path.join(directory, command));
    }
  }
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function inspectMcpProcesses(definition) {
  if (typeof definition.command !== "string" || !definition.command.trim()) return "UNSUPPORTED";
  const expected = path.isAbsolute(definition.command) ? path.resolve(definition.cwd || process.cwd(), definition.command) : path.basename(definition.command);
  let processEntries;
  try {
    processEntries = fs.readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .sort((left, right) => Number(left.name) - Number(right.name))
      .slice(0, MAX_MCP_PROCESS_ENTRIES);
  } catch {
    return "UNSUPPORTED";
  }
  const configuredArgs = Array.isArray(definition.args) ? definition.args.filter((arg) => typeof arg === "string") : [];
  if (configuredArgs.length === 0) return "UNSUPPORTED";
  for (const processEntry of processEntries) {
    try {
      const args = fs.readFileSync(path.join("/proc", processEntry.name, "cmdline")).toString("utf8").split("\0").filter(Boolean);
      const executable = fs.realpathSync(path.join("/proc", processEntry.name, "exe"));
      const commandMatches = path.isAbsolute(definition.command)
        ? (args.includes(expected) || executable === expected)
        : (path.basename(args[0] || executable) === expected || path.basename(executable) === expected);
      const argsMatch = configuredArgs.every((arg, index) => args.includes(arg) || args[index + 1] === arg);
      if (commandMatches && argsMatch) return "OBSERVED";
    } catch {
      // Processes can disappear or be unreadable during the bounded scan.
    }
  }
  return "NOT_OBSERVED";
}

function mcpLoadability(definition) {
  if (mcpTransport(definition) !== "stdio") return "UNSUPPORTED";
  return executableAvailable(definition.command, definition.cwd) ? true : false;
}

function safeMcpName(name) {
  const value = String(name).trim();
  if (!value || /^(?:~|[A-Za-z]:[\\/]|[\\/])/.test(value)) return "redacted-server-name";
  return value.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, " ").slice(0, 128) || "server";
}

function safeMcpId(sourceId, name) {
  const normalized = safeMcpName(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "server";
  return `mcp:${sourceId}:${normalized}`;
}

function mcpEntryFromDefinition(source, name, definition, shadowedDefinitions, processInspector) {
  const transport = mcpTransport(definition);
  const disabled = definition.disabled === true;
  const configured = true;
  const state = disabled ? "UNAVAILABLE" : "CONFIGURED";
  const running = disabled ? "UNSUPPORTED" : processInspector(definition);
  const note = disabled
    ? "Configured MCP is disabled in the winning source; live connectivity is unsupported."
    : `Configured from the winning ${source.scope} MCP source; live connectivity is unsupported.`;
  return {
    id: safeMcpId(source.id, name),
    name: safeMcpName(name),
    scope: source.scope,
    source: source.source,
    state,
    transport,
    provider: "pi-mcp-adapter",
    configured,
    loadable: disabled ? "UNSUPPORTED" : mcpLoadability(definition),
    running,
    connected: "UNSUPPORTED",
    shadowedDefinitions,
    note,
  };
}

function configuredMcpAdapterPackage(globalSettingsPath, projectSettingsPath) {
  for (const [settingsPath, scope] of [[globalSettingsPath, "global"], [projectSettingsPath, "project"]]) {
    const settings = settingsPath ? readJson(settingsPath) : null;
    const packages = configuredPackageEntries(settings, scope);
    for (const entry of packages) {
      const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg?.source;
      if (packageName(source) !== "pi-mcp-adapter") continue;
      const root = installedPackageRoot(source, scope);
      const manifest = root ? readJson(path.join(root, "package.json")) : null;
      if (manifest?.name === "pi-mcp-adapter") return { scope, version: typeof manifest.version === "string" ? manifest.version : null };
    }
  }
  return null;
}

function mcpPiSettingsSource(globalSettingsPath) {
  const health = inspectJsonFile(globalSettingsPath);
  const settings = globalSettingsPath ? readJson(globalSettingsPath) : null;
  const packages = configuredPackageEntries(settings, "global");
  const adapterConfigured = packages.some((entry) => packageName(typeof entry.pkg === "string" ? entry.pkg : entry.pkg?.source) === "pi-mcp-adapter");
  return {
    id: "pi-global-settings-mcp",
    name: "Pi global package/settings source",
    scope: "global",
    source: "pi-settings",
    state: !health.exists ? "UNAVAILABLE" : (health.readable && health.valid ? "AVAILABLE_METADATA" : "INVALID_CONFIG"),
    configured: adapterConfigured,
    transport: null,
    note: adapterConfigured
      ? "Pi global settings select the pi-mcp-adapter package; explicit MCP configuration is read separately."
      : "Pi global settings were inspected for bounded MCP adapter package metadata; no adapter selection was observed.",
  };
}

function mcpPackageSource(globalSettingsPath, projectSettingsPath) {
  const adapter = configuredMcpAdapterPackage(globalSettingsPath, projectSettingsPath);
  const state = adapter ? "AVAILABLE_METADATA" : "UNAVAILABLE";
  return {
    id: "pi-mcp-adapter-package",
    name: "Pi MCP adapter package",
    scope: "extension/package",
    source: "package",
    state,
    configured: Boolean(adapter),
    transport: null,
    note: adapter
      ? `The configured pi-mcp-adapter package is readable; explicit MCP configuration is inspected without loading extensions or connecting servers.`
      : "The configured pi-mcp-adapter package was not found in the bounded Pi package locations.",
  };
}

export function collectMcpInventory(globalSettingsPath, projectSettingsPath, subagentsPackage, options = {}) {
  const sourceSpecs = options.sourceSpecs ?? defaultMcpSourceSpecs(globalSettingsPath, projectSettingsPath);
  const processInspector = options.processInspector ?? inspectMcpProcesses;
  const runningCache = new Map();
  const observeRunning = (definition) => {
    const key = JSON.stringify({ command: definition.command, args: definition.args, cwd: definition.cwd });
    if (!runningCache.has(key)) runningCache.set(key, processInspector(definition));
    return runningCache.get(key);
  };
  const sources = [];
  const effective = new Map();
  for (const source of sourceSpecs) {
    const health = readMcpConfigFile(source.path);
    const configured = health.state === "AVAILABLE" && health.servers.length > 0;
    const invalidEntryNote = health.invalidEntries > 0 ? ` ${health.invalidEntries} invalid server definition(s) were omitted.` : "";
    const note = health.state === "UNAVAILABLE"
      ? "This optional explicit MCP configuration source is not present."
      : health.state === "INVALID_CONFIG"
        ? "This explicit MCP configuration source is unreadable or malformed; raw configuration is omitted."
        : `This explicit MCP configuration source is readable; ${health.servers.length} server definition(s) were inspected.${invalidEntryNote}`;
    const sourceRecord = {
      id: source.id,
      name: source.name,
      scope: source.scope,
      source: source.source,
      precedence: source.precedence,
      state: health.state,
      configured,
      transport: null,
      note,
    };
    sources.push(sourceRecord);
    if (health.state !== "AVAILABLE") continue;
    for (const server of health.servers) {
      const previous = effective.get(server.name);
      effective.set(server.name, {
        source,
        definition: server.definition,
        shadowedDefinitions: (previous?.shadowedDefinitions ?? 0) + (previous ? 1 : 0),
      });
    }
  }
  sources.push(mcpPiSettingsSource(globalSettingsPath));
  sources.push(mcpPackageSource(globalSettingsPath, projectSettingsPath));
  const entries = [...effective.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => mcpEntryFromDefinition(value.source, name, value.definition, value.shadowedDefinitions, observeRunning));
  return {
    sourcePolicy: "Pi MCP adapter explicit configuration sources only; raw configuration and runtime MCP contents are never exposed.",
    entries,
    sources,
    connectivity: {
      status: "UNSUPPORTED",
      note: "Live MCP connectivity is intentionally unsupported; no initialize, handshake, tool, resource, prompt, or protocol probe is performed.",
    },
    resolution: {
      status: "SUPPORTED_SCOPED",
      note: "Explicit MCP configuration precedence is resolved in the documented pi-mcp-adapter order; package/plugin-defined MCP servers and runtime-effective state remain outside this scope.",
    },
  };
}

function parseSkillFrontmatter(filePath) {
  const sample = readWindow(filePath, 0, SKILL_FRONTMATTER_BYTES);
  const match = sample.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { valid: false, name: null, description: null, disableModelInvocation: false, reason: "missing or malformed frontmatter" };
  const fields = {};
  let multiline = null;
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field) {
      multiline = null;
      const value = field[2].trim();
      if (value === "|" || value === ">") {
        multiline = { key: field[1], folded: value === ">", values: [] };
      } else {
        fields[field[1]] = value.replace(/^['\"]|['\"]$/g, "");
      }
    } else if (multiline && /^\s+/.test(line)) {
      multiline.values.push(line.trim());
    }
  }
  if (multiline) fields[multiline.key] = multiline.values.join(multiline.folded ? " " : "\n");
  const directoryName = path.basename(path.dirname(filePath));
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : directoryName;
  const description = typeof fields.description === "string" && fields.description.trim() ? fields.description.trim() : null;
  const nameValid = SAFE_SKILL_NAME.test(name);
  const descriptionValid = typeof description === "string" && description.length <= 1024;
  return {
    valid: Boolean(description) && nameValid && descriptionValid,
    name: nameValid ? name : null,
    description: description && description.length <= 1024 && !SUSPICIOUS_SKILL_METADATA.test(description) ? description : null,
    descriptionPresent: Boolean(description),
    nameValid,
    descriptionValid,
    metadataRedacted: Boolean(description && SUSPICIOUS_SKILL_METADATA.test(description)),
    disableModelInvocation: fields["disable-model-invocation"] === "true",
    reason: !description ? "required description is missing" : (!nameValid ? "name violates Pi Skill naming rules" : (!descriptionValid ? "description exceeds Pi Skill metadata limits" : null)),
  };
}

function collectSkillFiles(root, mode, result = [], state = { count: 0 }, isRoot = true) {
  if (state.count >= MAX_SKILL_FILES) return result;
  let entries;
  try {
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (root.endsWith(".md")) { result.push(root); state.count += 1; }
      return result;
    }
    if (!stat.isDirectory()) return result;
    entries = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return result;
  }
  const declared = entries.find((entry) => entry.name === "SKILL.md");
  if (declared && (declared.isFile() || declared.isSymbolicLink())) {
    const skillPath = path.join(root, declared.name);
    try {
      if (fs.statSync(skillPath).isFile()) { result.push(skillPath); state.count += 1; }
    } catch { /* unreadable Skill is reported by the source, not opened here */ }
    return result;
  }
  for (const entry of entries) {
    if (state.count >= MAX_SKILL_FILES) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(root, entry.name);
    let stat;
    try { stat = fs.statSync(child); } catch { continue; }
    if (stat.isDirectory()) {
      collectSkillFiles(child, mode, result, state, false);
    } else if (stat.isFile() && entry.name.endsWith(".md") && ((mode === "pi" && isRoot) || (mode === "agents" && !isRoot) || (mode === "explicit" && isRoot))) {
      result.push(child);
      state.count += 1;
    }
  }
  return result;
}

function safeSkillId(sourceId, name, index) {
  const safeName = typeof name === "string" && name.length > 0 ? name : `invalid-${index}`;
  return `${sourceId}:${safeName}`;
}

function skillSourceRecord(id, name, scope, source, provider, pathCategory, configured, state, note, rank) {
  return { id, name, scope, source, provider, pathCategory, configured, state, discoverable: state !== "UNSUPPORTED", loadable: state === "AVAILABLE", discovered: 0, note, rank };
}

function packageName(source) {
  if (typeof source !== "string") return null;
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    if (spec.startsWith("@")) {
      const slash = spec.indexOf("/");
      return slash > 0 ? `${spec.slice(0, slash + 1)}${spec.slice(slash + 1).split("@")[0]}` : null;
    }
    return spec.split("@")[0] || null;
  }
  return source.startsWith("git+") ? "git package" : null;
}

function installedPackageRoot(source, scope) {
  if (typeof source !== "string") return null;
  if (source.startsWith("npm:")) {
    const name = packageName(source);
    if (!name) return null;
    const candidates = scope === "project"
      ? [path.join(process.cwd(), "node_modules", name), path.join(process.cwd(), ".pi", "node_modules", name)]
      : [path.join(PI_AGENT_ROOT, "npm", "node_modules", name), path.join(PI_AGENT_ROOT, "node_modules", name)];
    return candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json"))) ?? null;
  }
  return null;
}

function configuredPackageEntries(settings, scope) {
  return Array.isArray(settings?.packages) ? settings.packages.map((pkg) => ({ pkg, scope })) : [];
}

function collectSkills() {
  const sources = [];
  const candidates = [];
  const seenFiles = new Set();
  let sourceIndex = 0;
  const addRoot = ({ id, name, scope, source, provider = null, pathCategory, configured = false, root, mode = "pi", rank, note }) => {
    let state = "UNAVAILABLE";
    try {
      const stat = fs.statSync(root);
      fs.accessSync(root, fs.constants.R_OK);
      state = stat.isFile() || stat.isDirectory() ? "AVAILABLE" : "UNREADABLE";
    } catch {
      if (fs.existsSync(root)) state = "UNREADABLE";
    }
    const record = skillSourceRecord(id, name, scope, source, provider, pathCategory, configured, state, note, rank);
    sources.push(record);
    if (state !== "AVAILABLE") return;
    const files = collectSkillFiles(root, mode);
    for (const filePath of files) {
      const canonical = path.resolve(filePath);
      if (seenFiles.has(canonical)) continue;
      seenFiles.add(canonical);
      candidates.push({ filePath, source: record });
    }
    record.discovered = files.length;
    if (files.length >= MAX_SKILL_FILES) record.note = `${record.note} Discovery is bounded at ${MAX_SKILL_FILES} files.`;
  };
  const addConfiguredPaths = (settings, scope, baseDir) => {
    if (!Array.isArray(settings?.skills)) return;
    for (const configuredPath of settings.skills) {
      if (typeof configuredPath !== "string" || !configuredPath.trim()) continue;
      const root = path.resolve(baseDir, configuredPath);
      addRoot({
        id: `configured-${scope}-${sourceIndex++}`,
        name: `${scope === "project" ? "Project" : "Global"} configured Skill path`,
        scope,
        source: "configured path",
        pathCategory: `${scope} configured Skill path`,
        configured: true,
        root,
        mode: "explicit",
        rank: scope === "project" ? 0 : 2,
        note: "Configured through a documented Pi Skill path setting; only Skill metadata is inspected.",
      });
    }
  };
  const globalSettingsPath = path.join(PI_AGENT_ROOT, "settings.json");
  const projectSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
  const globalSettings = readJson(globalSettingsPath);
  const projectSettings = readJson(projectSettingsPath);
  addConfiguredPaths(projectSettings, "project", path.join(process.cwd(), ".pi"));
  addRoot({ id: "project-pi-skills", name: "Project Pi Skills", scope: "project", source: "project directory", pathCategory: ".pi/skills", root: path.join(process.cwd(), ".pi", "skills"), rank: 1, note: "Pi project Skills are available after the project is trusted by Pi." });
  let ancestor = process.cwd();
  const projectRoot = run("git", ["rev-parse", "--show-toplevel"]) || process.cwd();
  while (true) {
    addRoot({ id: `project-agents-skills-${sourceIndex++}`, name: "Project .agents Skills", scope: "project", source: "project directory", pathCategory: ".agents/skills", root: path.join(ancestor, ".agents", "skills"), mode: "agents", rank: 1, note: "Ancestor .agents Skills are discovered only within the current project scope and after project trust." });
    if (path.resolve(ancestor) === path.resolve(projectRoot)) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  addConfiguredPaths(globalSettings, "global", PI_AGENT_ROOT);
  addRoot({ id: "global-pi-skills", name: "Global Pi Skills", scope: "global", source: "global directory", pathCategory: "~/.pi/agent/skills", root: path.join(PI_AGENT_ROOT, "skills"), rank: 3, note: "Pi global Skill directory discovered by the documented ResourceLoader defaults." });
  addRoot({ id: "global-agents-skills", name: "Global .agents Skills", scope: "global", source: "global directory", pathCategory: "~/.agents/skills", root: path.join(HOME, ".agents", "skills"), mode: "agents", rank: 3, note: "Global .agents Skill directory discovered by the documented ResourceLoader defaults." });
  const packageEntries = [...configuredPackageEntries(projectSettings, "project"), ...configuredPackageEntries(globalSettings, "global")];
  for (const { pkg, scope } of packageEntries) {
    const packageSource = typeof pkg === "string" ? pkg : pkg?.source;
    const provider = packageName(packageSource) ?? "configured package";
    const packageRoot = installedPackageRoot(packageSource, scope);
    const id = `package-${scope}-${sourceIndex++}`;
    const record = skillSourceRecord(id, `${provider} package Skills`, scope, "package", provider, "package skills/", true, packageRoot ? "AVAILABLE" : "UNAVAILABLE", packageRoot ? "Configured package metadata and its declared Skill resources are readable." : "Configured package is not installed in the supported local package location.", 4);
    sources.push(record);
    if (!packageRoot) continue;
    const manifest = readJson(path.join(packageRoot, "package.json"));
    const declared = Array.isArray(manifest?.pi?.skills) ? manifest.pi.skills : ["skills"];
    const packageFiles = [];
    for (const entry of declared) {
      if (typeof entry !== "string" || entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) continue;
      packageFiles.push(...collectSkillFiles(path.resolve(packageRoot, entry), "pi"));
    }
    for (const filePath of packageFiles) {
      const canonical = path.resolve(filePath);
      if (seenFiles.has(canonical)) continue;
      seenFiles.add(canonical);
      candidates.push({ filePath, source: record });
    }
    record.discovered = packageFiles.length;
  }
  sources.push(skillSourceRecord(
    "extension-runtime-skills",
    "Extension-provided Skills",
    "runtime",
    "extension",
    null,
    "process-local extension resources",
    false,
    "UNSUPPORTED",
    "Extensions can contribute Skill paths through the process-local ResourceLoader event surface; this standalone dashboard does not load or attach to extensions.",
    5,
  ));

  candidates.sort((left, right) => left.source.rank - right.source.rank);
  const skills = [];
  const winners = new Map();
  const diagnostics = [];
  for (const [index, candidate] of candidates.entries()) {
    const metadata = parseSkillFrontmatter(candidate.filePath);
    const validName = typeof metadata.name === "string";
    const base = {
      id: safeSkillId(candidate.source.id, metadata.name, index),
      name: validName ? metadata.name : null,
      description: metadata.description,
      scope: candidate.source.scope,
      source: candidate.source.source,
      provider: candidate.source.provider,
      pathCategory: candidate.source.pathCategory,
      state: metadata.valid ? (metadata.metadataRedacted ? "DISCOVERED_LIMITED_METADATA" : "DISCOVERED") : "INVALID",
      note: metadata.reason ?? (metadata.metadataRedacted ? "Description omitted by the privacy boundary." : "Skill metadata is discoverable through Pi's Skill loader rules."),
    };
    if (!metadata.valid) diagnostics.push("invalid Skill metadata");
    if (metadata.valid && winners.has(metadata.name)) {
      base.state = "SHADOWED";
      base.note = "A higher-precedence Skill with the same name is selected by Pi's first-wins collision behavior.";
      diagnostics.push("duplicate Skill name");
    } else if (metadata.valid) {
      winners.set(metadata.name, base);
    }
    skills.push(base);
  }
  const discovered = skills.filter((skill) => ["DISCOVERED", "DISCOVERED_LIMITED_METADATA"].includes(skill.state)).length;
  const invalid = skills.filter((skill) => skill.state === "INVALID").length;
  const shadowed = skills.filter((skill) => skill.state === "SHADOWED").length;
  return {
    sourcePolicy: "Pi ResourceLoader-compatible Skill locations and configured package Skill resources only; Skill bodies are never returned.",
    summary: { total: skills.length, discovered, invalid, shadowed },
    sources: sources.map(({ rank, ...source }) => source),
    skills,
    precedence: {
      status: "SUPPORTED_SCOPED",
      note: "Pi resolves project settings entries, project auto-discovered resources, global settings entries, global auto-discovered resources, then package resources; Skill name collisions keep the first discovered resource.",
    },
    runtimeUsage: {
      status: "UNSUPPORTED",
      note: "A standalone dashboard cannot determine whether a Skill is loaded, active, or used in another Pi process or session.",
    },
    limitations: [
      "Skill content, scripts, references, and linked files are not returned.",
      "Project Skill discovery depends on Pi project trust; this independent process does not resolve another Pi process's trust state.",
      "Extension-emitted runtime Skill paths are process-local and unsupported here.",
    ],
    diagnostics,
  };
}

function directoryIsReadable(directory) {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) return false;
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
    fs.readdirSync(directory);
    return true;
  } catch {
    return false;
  }
}

function diagnostic(id, label, status, explanation, source) {
  return { id, label, status, explanation, source };
}

export function collectDiagnostics(evidence, live = null) {
  const globalSettingsHealth = inspectJsonFile(path.join(PI_AGENT_ROOT, "settings.json"));
  const codeRootReadable = directoryIsReadable(CODE_ROOT);
  const gitAvailable = run("git", ["--version"]) !== null;
  const sessionRootReadable = directoryIsReadable(SESSION_ROOT);
  const lifecycleRootReadable = directoryIsReadable(os.tmpdir());
  const usage = evidence.usage;
  const settings = evidence.settings;
  const settingsGlobal = settings?.sources?.find((source) => source.id === "pi-global-settings");
  const settingsProject = settings?.sources?.find((source) => source.id === "pi-project-settings");
  const worktrees = evidence.worktrees;
  const worktreeItems = worktrees?.repositories?.flatMap((repository) => repository.worktrees) ?? [];
  const skillSources = evidence.skills?.sources ?? [];
  const skillGlobalSources = skillSources.filter((source) => source.scope === "global");
  const skillProjectSources = skillSources.filter((source) => source.scope === "project");
  const skillPackageSources = skillSources.filter((source) => source.source === "package");
  const mcpGlobalSources = evidence.mcp.sources.filter((source) => source.source === "global-config");
  const mcpProjectSources = evidence.mcp.sources.filter((source) => source.source === "project-config");
  const mcpGlobal = mcpGlobalSources.find((source) => source.id === "global-config") ?? mcpGlobalSources[0];
  const mcpProject = mcpProjectSources.find((source) => source.id === "project-config") ?? mcpProjectSources[0];
  const mcpGlobalInvalid = mcpGlobalSources.some((source) => source.state === "INVALID_CONFIG");
  const mcpProjectInvalid = mcpProjectSources.some((source) => source.state === "INVALID_CONFIG");
  const checks = [
    diagnostic(
      "pi-cli",
      "Pi CLI availability",
      evidence.pi.version === "unavailable" ? "ERROR" : "PASS",
      evidence.pi.version === "unavailable" ? "The Pi CLI could not be queried." : `Pi ${evidence.pi.version} is available.`,
      "local executable",
    ),
    diagnostic(
      "pi-subagents-package",
      "pi-subagents package",
      evidence.piSubagents.installed ? "PASS" : "WARN",
      evidence.piSubagents.installed ? `pi-subagents ${evidence.piSubagents.version ?? "installed"} is available.` : "The optional pi-subagents package was not found.",
      "installed package metadata",
    ),
    diagnostic(
      "pi-global-settings",
      "Global Pi settings",
      !globalSettingsHealth.exists ? "WARN" : (globalSettingsHealth.readable && globalSettingsHealth.valid ? "PASS" : "ERROR"),
      !globalSettingsHealth.exists
        ? "Global settings are not present; Pi defaults may be in use."
        : (globalSettingsHealth.readable && globalSettingsHealth.valid ? "Global settings are readable and valid JSON." : "Global settings exist but are not readable valid JSON."),
      "local filesystem",
    ),
    diagnostic(
      "settings-global-source",
      "Global settings source",
      !settingsGlobal ? "ERROR" : (settingsGlobal.state === "INVALID" || settingsGlobal.state === "UNREADABLE" ? "ERROR" : (settingsGlobal.state === "NOT_PRESENT" ? "WARN" : "PASS")),
      !settingsGlobal ? "Settings evidence was not collected." : settingsGlobal.note,
      "~/.pi/agent/settings.json",
    ),
    diagnostic(
      "settings-project-source",
      "Project settings source",
      !settingsProject ? "ERROR" : (settingsProject.state === "INVALID" || settingsProject.state === "UNREADABLE" ? "ERROR" : "PASS"),
      !settingsProject ? "Settings evidence was not collected." : settingsProject.note,
      "canonical .pi/settings.json",
    ),
    diagnostic(
      "settings-global-parse",
      "Global settings parsing",
      !settingsGlobal ? "ERROR" : (settingsGlobal.state === "INVALID" || settingsGlobal.state === "UNREADABLE" ? "ERROR" : "PASS"),
      !settingsGlobal ? "Settings evidence was not collected." : (settingsGlobal.state === "AVAILABLE" ? "Global settings matched a safe JSON object shape." : "Global settings are absent; documented defaults may apply."),
      "read-only settings parser",
    ),
    diagnostic(
      "settings-project-parse",
      "Project settings parsing",
      !settingsProject ? "ERROR" : (settingsProject.state === "INVALID" || settingsProject.state === "UNREADABLE" ? "ERROR" : "PASS"),
      !settingsProject ? "Settings evidence was not collected." : (settingsProject.state === "AVAILABLE" ? "Canonical project settings matched a safe JSON object shape." : "Canonical project settings are absent; this optional source is not an error."),
      "read-only settings parser",
    ),
    diagnostic(
      "settings-resolution",
      "Settings static resolution",
      !settings ? "ERROR" : (settings.resolution.static.status === "SUPPORTED_SCOPED" ? "PASS" : "WARN"),
      !settings ? "Settings evidence was not collected." : `${settings.resolution.static.precedence} Runtime-effective settings remain unsupported.`,
      "Pi settings documentation and SettingsManager",
    ),
    diagnostic(
      "settings-safe-inventory",
      "Safe settings inventory",
      !settings ? "ERROR" : (Array.isArray(settings.settings) && Array.isArray(settings.packages) && Array.isArray(settings.roles) ? "PASS" : "ERROR"),
      !settings ? "Settings evidence was not collected." : (Array.isArray(settings.settings) && Array.isArray(settings.packages) && Array.isArray(settings.roles) ? "Curated settings, package identifiers, and role metadata were collected without raw configuration." : "Settings inventory did not match the expected safe shape."),
      "allowlisted settings evidence collector",
    ),
    diagnostic(
      "code-root",
      "Project root accessibility",
      codeRootReadable ? "PASS" : "ERROR",
      codeRootReadable ? "The direct ~/code project scope is readable." : "The ~/code project scope could not be read.",
      "local filesystem",
    ),
    diagnostic(
      "git",
      "Git executable",
      gitAvailable ? "PASS" : "ERROR",
      gitAvailable ? "Git is available for non-mutating inspection." : "Git could not be queried.",
      "local executable",
    ),
    diagnostic(
      "project-inventory",
      "Project inventory collection",
      codeRootReadable && Array.isArray(evidence.projects) ? "PASS" : "ERROR",
      codeRootReadable && Array.isArray(evidence.projects) ? "Project metadata was collected from direct ~/code entries." : "Project inventory could not be collected.",
      "filesystem / Git evidence collector",
    ),
    diagnostic(
      "pi-session-artifacts",
      "Pi session artifact root",
      sessionRootReadable ? "PASS" : "WARN",
      sessionRootReadable ? "The Pi session artifact scope is readable." : "Pi session artifacts are unavailable; historical session observability is limited.",
      "documented Pi JSONL artifacts",
    ),
    diagnostic(
      "pi-subagents-artifacts",
      "pi-subagents lifecycle artifact scope",
      lifecycleRootReadable ? "PASS" : "WARN",
      lifecycleRootReadable ? "The local temporary artifact scope is readable." : "The lifecycle artifact scope is unavailable; historical run observability is limited.",
      "scoped status.json artifacts",
    ),
    diagnostic(
      "observability-collection",
      "Observability evidence collection",
      Array.isArray(evidence.sessions?.items) && Array.isArray(evidence.piSubagents?.roles) && Array.isArray(evidence.piSubagents?.lifecycleArtifacts?.items) ? "PASS" : "ERROR",
      Array.isArray(evidence.sessions?.items) && Array.isArray(evidence.piSubagents?.roles) && Array.isArray(evidence.piSubagents?.lifecycleArtifacts?.items)
        ? "Bounded session and lifecycle metadata was collected." : "Observability evidence did not match the expected safe shape.",
      "read-only evidence collector",
    ),
    diagnostic(
      "observability-project-attribution",
      "Observability project attribution",
      !evidence.projectActivity ? "ERROR" : (evidence.projectActivity.summary.unattributedEvidenceCount > Math.max(10, (evidence.projectActivity.summary.sessionCount + evidence.projectActivity.summary.historicalLifecycleCount) / 2) ? "WARN" : "PASS"),
      !evidence.projectActivity
        ? "Project-grouped observability was not collected."
        : `${evidence.projectActivity.summary.unattributedEvidenceCount} evidence records remain UNATTRIBUTED; known direct project paths and Git worktree identities are mapped deterministically.`,
      "Project inventory and Git worktree identity",
    ),
    diagnostic(
      "observability-lifecycle-deduplication",
      "Observability lifecycle deduplication",
      evidence.projectActivity?.lifecycle?.identity === "status.json runId" ? "PASS" : "ERROR",
      evidence.projectActivity?.lifecycle?.identity === "status.json runId"
        ? "Historical lifecycle counts use stable status.json runId values and do not count unresolved identities."
        : "A stable lifecycle identity was not available for project aggregation.",
      "scoped pi-subagents status.json artifacts",
    ),
    diagnostic(
      "observability-project-aggregation",
      "Observability project aggregation",
      evidence.projectActivity && Array.isArray(evidence.projectActivity.projects) && Array.isArray(evidence.projectActivity.recentEvidence) ? "PASS" : "ERROR",
      evidence.projectActivity && Array.isArray(evidence.projectActivity.projects) && Array.isArray(evidence.projectActivity.recentEvidence)
        ? "Project summaries and bounded recent evidence were aggregated in one read-only collection."
        : "Project-grouped observability did not match the expected safe shape.",
      "read-only observability aggregation",
    ),
    diagnostic(
      "network-policy",
      "Network policy",
      evidence.runtime.bindAddress === "127.0.0.1" && Number.isInteger(evidence.runtime.port) && evidence.runtime.port > 0 ? "PASS" : "ERROR",
      evidence.runtime.bindAddress === "127.0.0.1" && Number.isInteger(evidence.runtime.port) && evidence.runtime.port > 0
        ? "Runtime is bound to localhost on an OS-assigned port." : "Runtime bind does not match the localhost dynamic-port policy.",
      "runtime policy",
    ),
    diagnostic(
      "git-worktree-command",
      "Git worktree command",
      !worktrees ? "ERROR" : (worktrees.commandFailures > 0 ? "ERROR" : "PASS"),
      !worktrees ? "Worktree evidence was not collected." : (worktrees.commandFailures > 0 ? "Git worktree list failed for one or more discovered repositories." : "Git worktree porcelain was queried for discovered repositories."),
      "git worktree list --porcelain",
    ),
    diagnostic(
      "worktree-inventory",
      "Worktree inventory",
      !worktrees ? "ERROR" : (worktrees.repositories.some((repository) => repository.status === "DEGRADED") ? "WARN" : "PASS"),
      !worktrees ? "Worktree evidence was not collected." : (worktrees.repositories.some((repository) => repository.status === "DEGRADED") ? "One or more Git worktree responses had no parseable records." : `${worktrees.summary.repositoryCount} Git repository groups were inventoried.`),
      "read-only Git worktree evidence collector",
    ),
    diagnostic(
      "worktree-path-resolution",
      "Worktree path resolution",
      !worktrees ? "ERROR" : (worktreeItems.some((worktree) => worktree.pathState === "MISSING" || worktree.pathState === "MISSING_OUTSIDE_SAFE_SCOPE") ? "WARN" : "PASS"),
      !worktrees ? "Worktree evidence was not collected." : (worktreeItems.some((worktree) => worktree.pathState === "MISSING" || worktree.pathState === "MISSING_OUTSIDE_SAFE_SCOPE") ? "One or more Git-reported worktree paths are missing; the path is not exposed." : "Git-reported worktree paths were normalized to safe display values."),
      "Git worktree paths and local filesystem existence",
    ),
    diagnostic(
      "worktree-status-collection",
      "Worktree status collection",
      !worktrees ? "ERROR" : (worktrees.statusFailures > 0 ? "WARN" : "PASS"),
      !worktrees ? "Worktree evidence was not collected." : (worktrees.statusFailures > 0 ? "Git status could not be collected for one or more available worktree paths." : "Bounded Git status counts were collected without filenames or diffs."),
      "git status --porcelain",
    ),
    diagnostic(
      "usage-index",
      "Usage derived index",
      !usage ? "ERROR" : usageIndexDiagnostics(usage).status === "ERROR" ? "ERROR" : (usageIndexDiagnostics(usage).status === "UNSUPPORTED" ? "UNSUPPORTED" : (usageIndexDiagnostics(usage).status === "FALLBACK_LEGACY" ? "WARN" : "PASS")),
      !usage ? "Usage evidence was not collected." : usageIndexDiagnostics(usage).explanation,
      "private rebuildable SQLite-derived Usage index",
    ),
    diagnostic(
      "usage-source-accessibility",
      "Usage source accessibility",
      !usage ? "ERROR" : (usage.scope.unreadableFiles > 0 ? "WARN" : "PASS"),
      !usage ? "Pi usage evidence was not collected." : (usage.scope.unreadableFiles > 0 ? "Some Pi session artifacts could not be read." : `The discovered Pi session artifact scope was scanned (${usage.scope.sessionFilesScanned} files).`),
      "documented Pi JSONL session artifacts",
    ),
    diagnostic(
      "usage-parsing",
      "Usage artifact parsing",
      !usage ? "ERROR" : (usage.scope.parseErrors > 0 || usage.scope.malformedUsageRecords > 0 ? "WARN" : "PASS"),
      !usage ? "Pi usage evidence was not collected." : (usage.scope.parseErrors > 0 || usage.scope.malformedUsageRecords > 0 ? "Some usage-bearing artifact records were malformed or incomplete." : "Usage-bearing session records matched the supported Pi Usage shape."),
      "read-only usage evidence collector",
    ),
    diagnostic(
      "usage-deduplication",
      "Usage deduplication",
      !usage ? "ERROR" : (usage.scope.ambiguousRecordsExcluded > 0 ? "WARN" : "PASS"),
      !usage ? "Pi usage evidence was not collected." : `Stable Pi entry IDs and parentSession lineage suppressed ${usage.scope.duplicateRecordsSuppressed} copied records; ${usage.scope.ambiguousRecordsExcluded} ambiguous records were excluded.`,
      "Pi session entry identity and parentSession",
    ),
    diagnostic(
      "usage-timestamps",
      "Usage timestamps",
      !usage ? "ERROR" : (usage.scope.invalidTimestampRecords > 0 ? "WARN" : "PASS"),
      !usage ? "Pi usage evidence was not collected." : (usage.scope.invalidTimestampRecords > 0 ? "Some usage records had no valid event timestamp." : "Usage windows use stored Pi entry timestamps."),
      "Pi JSONL entry timestamps",
    ),
    diagnostic(
      "usage-model-attribution",
      "Usage model attribution",
      !usage ? "ERROR" : "PASS",
      !usage ? "Pi usage evidence was not collected." : `${usage.selected.unknownModelRecords} usage records remain UNATTRIBUTED instead of using a current default model.`,
      "stored assistant provider/model metadata",
    ),
    diagnostic(
      "usage-project-attribution",
      "Usage project attribution",
      !usage ? "ERROR" : (usage.selected.unattributedProjectRecords > 0 ? "WARN" : "PASS"),
      !usage ? "Pi usage evidence was not collected." : `${usage.selected.unattributedProjectRecords} usage records remain UNATTRIBUTED because their stored cwd is not under ~/code/<project>.`,
      "stored session cwd",
    ),
    diagnostic(
      "usage-cost",
      "Usage cost metadata",
      !usage || usage.cost.status === "UNSUPPORTED" ? "UNSUPPORTED" : "PASS",
      !usage ? "Pi usage evidence was not collected." : usage.cost.note,
      "Pi-persisted Usage.cost",
    ),
    diagnostic(
      "skills-global-sources",
      "Global Skill sources",
      skillGlobalSources.some((source) => source.state === "UNREADABLE") ? "WARN" : "PASS",
      skillGlobalSources.some((source) => source.state === "UNREADABLE") ? "One or more global Skill sources could not be read." : "Documented global Pi Skill locations were checked without exposing Skill content.",
      "Pi ResourceLoader Skill locations",
    ),
    diagnostic(
      "skills-project-sources",
      "Project Skill sources",
      skillProjectSources.some((source) => source.state === "UNREADABLE") ? "WARN" : "PASS",
      skillProjectSources.some((source) => source.state === "UNREADABLE") ? "One or more project Skill sources could not be read." : "Project Skill locations are optional and are not treated as errors when absent.",
      "Pi ResourceLoader Skill locations",
    ),
    diagnostic(
      "skills-package-sources",
      "Package Skill sources",
      skillPackageSources.some((source) => source.state === "UNREADABLE") ? "WARN" : "PASS",
      skillPackageSources.some((source) => source.state === "UNREADABLE") ? "One or more configured package Skill sources could not be read." : "Configured package Skill metadata was checked without loading package extensions.",
      "Pi package metadata",
    ),
    diagnostic(
      "skills-inventory",
      "Skill inventory collection",
      Array.isArray(evidence.skills?.skills) && Array.isArray(evidence.skills?.sources) ? "PASS" : "ERROR",
      Array.isArray(evidence.skills?.skills) && Array.isArray(evidence.skills?.sources)
        ? "Skill metadata was collected using Pi-compatible discovery rules; invalid or shadowed entries remain visible as bounded states."
        : "Skill inventory did not match the expected safe shape.",
      "read-only Skill evidence collector",
    ),
    diagnostic(
      "skills-runtime-usage",
      "Runtime Skill usage",
      "UNSUPPORTED",
      evidence.skills?.runtimeUsage?.note ?? "A standalone dashboard cannot determine runtime Skill usage.",
      "process-local capability",
    ),
    diagnostic(
      "mcp-global-config",
      "MCP global configuration source",
      mcpGlobalInvalid ? "ERROR" : "PASS",
      mcpGlobalInvalid ? "One or more supported global MCP configuration sources are malformed; raw configuration is omitted." : mcpGlobal.note,
      "documented global MCP configuration",
    ),
    diagnostic(
      "mcp-project-config",
      "MCP project configuration source",
      mcpProjectInvalid ? "ERROR" : "PASS",
      mcpProjectInvalid ? "One or more supported project MCP configuration sources are malformed; raw configuration is omitted." : mcpProject.note,
      "documented project MCP configuration",
    ),
    diagnostic(
      "mcp-inventory",
      "MCP inventory collection",
      Array.isArray(evidence.mcp.entries) && Array.isArray(evidence.mcp.sources) ? "PASS" : "ERROR",
      Array.isArray(evidence.mcp.entries) && Array.isArray(evidence.mcp.sources) ? "MCP configuration surfaces were inspected without exposing raw configuration." : "MCP inventory did not match the expected safe shape.",
      "read-only MCP evidence collector",
    ),
    diagnostic(
      "mcp-live-connectivity",
      "Live MCP connectivity",
      "UNSUPPORTED",
      evidence.mcp.connectivity.note,
      "runtime/process-local capability",
    ),
    diagnostic(
      "live-pi-session-state",
      "Live Pi session state",
      live?.availability === "AVAILABLE" ? "PASS" : "UNSUPPORTED",
      live?.availability === "AVAILABLE"
        ? `${live.summary.liveInstances} Pi Bridge snapshot(s) were collected without historical session scanning.`
        : "No valid Bridge snapshot is available; historical session artifacts are not treated as live state.",
      "private local Bridge snapshot",
    ),
    diagnostic(
      "live-runtime-directory",
      "Live runtime directory",
      live?.diagnostics?.runtimeDirectoryStatus === "AVAILABLE" ? "PASS" : "UNSUPPORTED",
      live?.diagnostics?.runtimeDirectoryStatus === "AVAILABLE"
        ? "The private live runtime directory was readable."
        : "The Bridge-owned runtime directory is absent or unavailable; this is informational when the Bridge is not installed.",
      "private local runtime directory",
    ),
    diagnostic(
      "live-snapshot-schema",
      "Live snapshot schema",
      !live ? "UNSUPPORTED" : (live.diagnostics.malformedFiles || live.diagnostics.oversizedFiles || live.diagnostics.unsafeFiles ? "WARN" : "PASS"),
      !live
        ? "Live snapshot evidence was not collected."
        : `${live.diagnostics.filesSeen} bounded snapshot file(s) inspected; ${live.diagnostics.malformedFiles} malformed, ${live.diagnostics.oversizedFiles} oversized, and ${live.diagnostics.unsafeFiles} unsafe file(s) ignored.`,
      "allowlisted live snapshot parser",
    ),
    diagnostic(
      "live-process-identity",
      "Live process identity",
      !live || live.diagnostics?.runtimeDirectoryStatus !== "AVAILABLE" ? "UNSUPPORTED" : "PASS",
      !live || live.diagnostics?.runtimeDirectoryStatus !== "AVAILABLE" ? "Live process identity is unavailable until a readable Bridge runtime directory exists." : "PID and process-start identity are validated internally; non-live snapshots do not claim current agent state.",
      "PID plus Linux process-start identity",
    ),
    diagnostic(
      "live-project-attribution",
      "Live Project attribution",
      !live ? "UNSUPPORTED" : (live.instances.some((instance) => instance.projectName === "UNATTRIBUTED") ? "WARN" : "PASS"),
      !live ? "Live Project attribution was not collected." : `${live.instances.filter((instance) => instance.projectName === "UNATTRIBUTED").length} live snapshot(s) remain UNATTRIBUTED under the existing Project/Worktree authority.`,
      "existing Project inventory and Git Worktree identity",
    ),
    diagnostic(
      "live-subagent-state",
      "Live cross-process pi-subagents state",
      "UNSUPPORTED",
      "pi-subagents RPC and event-bus surfaces are process-local to their host.",
      "process-local capability",
    ),
  ];
  const hasError = checks.some((check) => check.status === "ERROR");
  const hasWarning = checks.some((check) => check.status === "WARN");
  const status = hasError ? "ERROR" : (hasWarning ? "DEGRADED" : "HEALTHY");
  return {
    overall: {
      status,
      explanation: hasError ? "One or more supported evidence sources failed." : (hasWarning ? "Evidence is available with non-critical limitations." : "Supported evidence sources are available."),
    },
    checks,
  };
}

export function collectEvidence(port, options = {}) {
  const globalSettingsPath = path.join(PI_AGENT_ROOT, "settings.json");
  const subagentsConfigPath = path.join(PI_AGENT_ROOT, "extensions", "subagent", "config.json");
  const subagentsPackage = findSubagentsPackage();
  const subagentsPackageRoot = subagentsPackage ? path.dirname(subagentsPackage.path) : null;
  const globalSettings = metadataForSettings(globalSettingsPath, true);
  const projectSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
  const projectSettings = metadataForSettings(projectSettingsPath);
  const subagentsConfig = metadataForSettings(subagentsConfigPath);
  const mcp = collectMcpInventory(globalSettingsPath, projectSettingsPath, subagentsPackage);
  const projects = collectProjects();
  const worktrees = options.includeWorktrees || options.includeDiagnostics || options.includeObservability
    ? collectWorktrees(projects)
    : null;
  const sessions = collectSessionMetadata(projects, worktrees ?? { repositories: [] });
  const lifecycleArtifacts = collectSubagentArtifacts(projects, worktrees ?? { repositories: [] });
  const generatedAt = new Date().toISOString();
  const projectActivity = options.includeObservability || options.includeDiagnostics
    ? createProjectActivity(projects, worktrees ?? { repositories: [] }, sessions, lifecycleArtifacts, generatedAt)
    : null;
  const settings = options.includeSettings || options.includeDiagnostics
    ? collectSettings(globalSettingsPath, projectSettingsPath, subagentsPackage, subagentsPackageRoot)
    : null;
  const evidence = {
    generatedAt,
    runtime: {
      status: "running",
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      bindAddress: "127.0.0.1",
      port,
      readOnly: true,
    },
    pi: {
      version: run("pi", ["--version"]) ?? "unavailable",
      globalSettings,
      projectSettings,
    },
    piSubagents: {
      installed: Boolean(subagentsPackage),
      version: subagentsPackage?.manifest.version ?? null,
      roles: collectRoles(subagentsPackageRoot),
      config: subagentsConfig,
      observability: {
        activeRuns: "not-collected",
        note: "The documented event bus is process-local. This standalone dashboard does not attach to a Pi host process or scrape private runtime state.",
      },
      lifecycleArtifacts,
    },
    sessions,
    projects,
    mcp,
    skills: collectSkills(),
    ...(options.includeUsage || options.includeDiagnostics ? { usage: collectIndexedUsage(options.usageWindow, options.usageOptions) } : {}),
    ...(worktrees ? { worktrees } : {}),
    ...(projectActivity ? { projectActivity } : {}),
    ...(settings ? { settings } : {}),
    surfaces: {
      supportedNow: [
        "Pi CLI version",
        "Pi global/project settings metadata",
        "Pi-subagents installed package version and role-definition metadata",
        "Pi ResourceLoader-compatible Skill discovery metadata",
        "Git worktree topology and bounded status from non-mutating Git CLI evidence",
        "local Git branch, HEAD, dirty flag, and governance-file presence",
      ],
      stableLocalEvidence: [
        "Pi JSONL session files provide bounded historical session metadata without returning message bodies",
        "pi-subagents status.json files provide bounded historical lifecycle metadata when scoped to ~/code",
      ],
      unsupportedOrNotAttached: [
        "live Pi session/event-bus state from this separate process",
        "live pi-subagents fleet control and process-local RPC",
        "live session status inferred from artifact files",
        "live Skill loading, activation, and runtime usage from this separate process",
        "extension-emitted Skill paths from a process-local host",
        "MCP inventory beyond what a future supported Pi host integration exposes",
        "token/cost values are returned only as bounded Usage aggregates, not raw usage or billing data",
      ],
    },
  };
  if (options.includeDiagnostics) evidence.diagnostics = collectDiagnostics(evidence);
  return evidence;
}
