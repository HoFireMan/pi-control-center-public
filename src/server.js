import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDiagnostics, collectEvidence } from "./evidence.js";
import { collectIndexedUsage } from "./usage-index.js";
import { collectLiveObservability } from "./live-observability.js";

const BIND_ADDRESS = "127.0.0.1";
const STATIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function overviewApiResponse(evidence) {
  return {
    generatedAt: evidence.generatedAt,
    runtime: {
      status: evidence.runtime.status,
      nodeVersion: evidence.runtime.nodeVersion,
      uptimeSeconds: evidence.runtime.uptimeSeconds,
      bindAddress: evidence.runtime.bindAddress,
      port: evidence.runtime.port,
      readOnly: evidence.runtime.readOnly,
    },
    pi: {
      version: evidence.pi.version,
      globalSettings: evidence.pi.globalSettings,
      projectSettings: evidence.pi.projectSettings,
    },
    piSubagents: {
      installed: evidence.piSubagents.installed,
      version: evidence.piSubagents.version,
      roles: evidence.piSubagents.roles,
      config: evidence.piSubagents.config,
    },
    projects: evidence.projects,
    surfaces: evidence.surfaces,
  };
}

function worktreeResponse(worktree) {
  return {
    id: worktree.id,
    path: worktree.path,
    pathState: worktree.pathState,
    kind: worktree.kind,
    branch: worktree.branch,
    head: worktree.head,
    detached: worktree.detached,
    bare: worktree.bare,
    locked: worktree.locked,
    lockReason: worktree.lockReason,
    prunable: worktree.prunable,
    prunableReason: worktree.prunableReason,
    status: worktree.status,
    staged: worktree.staged,
    trackedModifications: worktree.trackedModifications,
    untracked: worktree.untracked,
    statusNote: worktree.statusNote,
    note: worktree.note,
  };
}

function worktreeRepositoryResponse(repository) {
  return {
    id: repository.id,
    displayName: repository.displayName,
    status: repository.status,
    mainWorktree: repository.mainWorktree ? { id: repository.mainWorktree.id, path: repository.mainWorktree.path } : null,
    worktreeCount: repository.worktreeCount,
    linkedWorktreeCount: repository.linkedWorktreeCount,
    worktrees: repository.worktrees.map((worktree) => worktreeResponse(worktree)),
    note: repository.note,
  };
}

function worktreesApiResponse(worktrees) {
  return {
    generatedAt: worktrees.generatedAt,
    source: worktrees.source,
    scope: worktrees.scope,
    summary: {
      repositoryCount: worktrees.summary.repositoryCount,
      worktreeCount: worktrees.summary.worktreeCount,
      linkedWorktreeCount: worktrees.summary.linkedWorktreeCount,
      mainWorktreeCount: worktrees.summary.mainWorktreeCount,
      detachedCount: worktrees.summary.detachedCount,
      lockedCount: worktrees.summary.lockedCount,
      prunableCount: worktrees.summary.prunableCount,
      dirtyCount: worktrees.summary.dirtyCount,
      unavailableCount: worktrees.summary.unavailableCount,
    },
    repositories: worktrees.repositories.map((repository) => worktreeRepositoryResponse(repository)),
    limitations: worktrees.limitations.map((limitation) => String(limitation)),
  };
}

function sessionApiResponse(session) {
  return {
    id: session.id,
    version: session.version,
    project: session.project,
    projectId: session.projectId,
    workspace: session.workspace,
    attribution: session.attribution,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    updatedSource: session.updatedSource,
    provider: session.provider,
    model: session.model,
    thinking: session.thinking,
    fileSizeBytes: session.fileSizeBytes,
    status: "UNKNOWN",
  };
}

function lifecycleApiResponse(run) {
  return {
    id: run.id,
    state: run.state,
    result: run.result,
    mode: run.mode,
    project: run.project,
    projectId: run.projectId,
    workspace: run.workspace,
    attribution: run.attribution,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    updatedAt: run.updatedAt,
    durationMs: run.durationMs,
    processTerminalProof: run.processTerminalProof,
    steps: run.steps,
  };
}

function projectActivityApiResponse(activity) {
  return {
    summary: { ...activity.summary },
    projects: activity.projects.map((project) => ({ ...project, liveState: { ...project.liveState } })),
    recentEvidence: activity.recentEvidence.map((item) => ({ ...item })),
    recentEvidenceWindow: { ...activity.recentEvidenceWindow },
    lifecycle: { ...activity.lifecycle },
    liveState: { ...activity.liveState },
    limitations: activity.limitations.map((limitation) => String(limitation)),
  };
}

function observabilityApiResponse(evidence) {
  return {
    generatedAt: evidence.generatedAt,
    projectActivity: projectActivityApiResponse(evidence.projectActivity),
    sessions: {
      source: evidence.sessions.source,
      totalDiscovered: evidence.sessions.totalDiscovered,
      returned: evidence.sessions.returned,
      truncated: evidence.sessions.truncated,
      liveState: { ...evidence.sessions.liveState },
      items: evidence.sessions.items.map(sessionApiResponse),
    },
    piSubagents: {
      version: evidence.piSubagents.version,
      installed: evidence.piSubagents.installed,
      roles: evidence.piSubagents.roles,
      lifecycleArtifacts: {
        source: evidence.piSubagents.lifecycleArtifacts.source,
        scope: evidence.piSubagents.lifecycleArtifacts.scope,
        totalDiscovered: evidence.piSubagents.lifecycleArtifacts.totalDiscovered,
        returned: evidence.piSubagents.lifecycleArtifacts.returned,
        truncated: evidence.piSubagents.lifecycleArtifacts.truncated,
        stateCounts: { ...evidence.piSubagents.lifecycleArtifacts.stateCounts },
        liveCrossProcess: { ...evidence.piSubagents.lifecycleArtifacts.liveCrossProcess },
        items: evidence.piSubagents.lifecycleArtifacts.items.map(lifecycleApiResponse),
      },
    },
  };
}

function settingsApiResponse(settings) {
  return {
    generatedAt: settings.generatedAt,
    sources: settings.sources.map((source) => ({
      id: source.id,
      name: source.name,
      scope: source.scope,
      source: source.source,
      location: source.location,
      state: source.state,
      exists: source.exists,
      readable: source.readable,
      parseable: source.parseable,
      configuredKeyCount: source.configuredKeyCount,
      safeSettingCount: source.safeSettingCount,
      omittedKeyCount: source.omittedKeyCount,
      configuredPackages: source.configuredPackages,
      note: source.note,
    })),
    settings: settings.settings.map((setting) => ({
      id: setting.id,
      category: setting.category,
      name: setting.name,
      scope: setting.scope,
      source: setting.source,
      value: setting.value,
      configured: setting.configured,
      configuredValues: setting.configuredValues,
      defaultValue: setting.defaultValue,
      state: setting.state,
      effective: setting.effective,
      note: setting.note,
    })),
    packages: settings.packages.map((pkg) => ({
      id: pkg.id,
      identifier: pkg.identifier,
      scope: pkg.scope,
      source: pkg.source,
      state: pkg.state,
      note: pkg.note,
    })),
    roles: settings.roles.map((role) => ({
      name: role.name,
      model: role.model,
      thinking: role.thinking,
      runner: role.runner,
      tools: role.tools,
      scope: role.scope,
      source: role.source,
      state: role.state,
      note: role.note,
    })),
    resolution: {
      static: { ...settings.resolution.static },
      runtime: { ...settings.resolution.runtime },
    },
    limitations: settings.limitations.map((limitation) => String(limitation)),
  };
}

function usageTokensResponse(tokens) {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: tokens.reasoning,
    total: tokens.total,
  };
}

function usageCostResponse(cost) {
  return {
    inputUsd: cost.inputUsd,
    outputUsd: cost.outputUsd,
    cacheReadUsd: cost.cacheReadUsd,
    cacheWriteUsd: cost.cacheWriteUsd,
    totalUsd: cost.totalUsd,
  };
}

function usageBucketResponse(bucket) {
  return {
    recordCount: bucket.recordCount,
    sessionCount: bucket.sessionCount,
    dateRange: { start: bucket.dateRange.start, end: bucket.dateRange.end },
    tokens: usageTokensResponse(bucket.tokens),
    cost: usageCostResponse(bucket.cost),
    byModel: bucket.byModel.map((row) => usageModelResponse(row)),
    byProject: bucket.byProject.map((row) => usageProjectResponse(row)),
  };
}

function usageModelResponse(row) {
  return {
    provider: row.provider,
    model: row.model,
    recordCount: row.recordCount,
    tokens: usageTokensResponse(row.tokens),
    cost: usageCostResponse(row.cost),
  };
}

function usageProjectResponse(row) {
  return {
    project: row.project,
    recordCount: row.recordCount,
    tokens: usageTokensResponse(row.tokens),
    cost: usageCostResponse(row.cost),
  };
}

function usageApiResponse(usage) {
  return {
    generatedAt: usage.generatedAt,
    scope: {
      classification: usage.scope.classification,
      source: usage.source,
      sessionFilesDiscovered: usage.scope.sessionFilesDiscovered,
      sessionFilesScanned: usage.scope.sessionFilesScanned,
      unreadableFiles: usage.scope.unreadableFiles,
      parseErrors: usage.scope.parseErrors,
      malformedUsageRecords: usage.scope.malformedUsageRecords,
      rawUsageRecords: usage.scope.rawUsageRecords,
      selectedRecords: usage.scope.selectedRecords,
      duplicateRecordsSuppressed: usage.scope.duplicateRecordsSuppressed,
      ambiguousRecordsExcluded: usage.scope.ambiguousRecordsExcluded,
      invalidTimestampRecords: usage.scope.invalidTimestampRecords,
      dateRange: { ...usage.scope.dateRange },
      note: usage.scope.note,
    },
    window: {
      selected: usage.selectedWindow,
      label: usage.windowLabels[usage.selectedWindow],
      timezone: "local",
      dateRange: { ...usage.selected.dateRange },
      note: "Windows are local calendar-day views of usage represented by local evidence; they are not billing periods.",
    },
    summary: usageBucketResponse(usage.selected),
    windows: Object.fromEntries(Object.entries(usage.windows).map(([id, bucket]) => [id, usageBucketResponse(bucket)])),
    tokenCategories: usage.tokenCategories.map((category) => ({ key: category.key, status: category.status, note: category.note })),
    cost: {
      status: usage.cost.status,
      currency: usage.cost.currency,
      amount: usage.cost.amount,
      source: usage.cost.source,
      note: usage.cost.note,
    },
    modelAttribution: {
      status: usage.modelAttribution.status,
      unknownRecords: usage.modelAttribution.unknownRecords,
      note: usage.modelAttribution.note,
    },
    projectAttribution: {
      status: usage.projectAttribution.status,
      unattributedRecords: usage.projectAttribution.unattributedRecords,
      note: usage.projectAttribution.note,
    },
    roleAttribution: {
      status: usage.roleAttribution.status,
      note: usage.roleAttribution.note,
    },
    completeness: {
      classification: usage.completeness.classification,
      accountComplete: usage.completeness.accountComplete,
      note: usage.completeness.note,
    },
    limitations: usage.limitations.map((limitation) => String(limitation)),
    performance: {
      sourceFilesScanned: usage.performance.sourceFilesScanned,
      inMemoryOnly: usage.performance.inMemoryOnly,
      persistence: usage.performance.persistence,
      indexBackend: usage.performance.indexBackend,
      indexState: usage.performance.indexState,
      sourceFilesDiscovered: usage.performance.sourceFilesDiscovered,
      sourceFilesReused: usage.performance.sourceFilesReused,
      sourceFilesReindexed: usage.performance.sourceFilesReindexed,
      sourceFilesRemoved: usage.performance.sourceFilesRemoved,
      sourceBytesReindexed: usage.performance.sourceBytesReindexed,
      databaseSizeBytes: usage.performance.databaseSizeBytes,
      rebuildReason: usage.performance.rebuildReason,
    },
  };
}

function serveStatic(response, pathname) {
  const relativeFile = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^([A-Za-z0-9_-]+)(\.[A-Za-z0-9_-]+)?$/.test(relativeFile)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const filePath = path.join(STATIC_ROOT, relativeFile);
  if (!filePath.startsWith(`${STATIC_ROOT}${path.sep}`) || !fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
}

export function createServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${BIND_ADDRESS}`);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const apiPaths = new Set(["/api/overview", "/api/observability", "/api/live-observability", "/api/projects", "/api/diagnostics", "/api/mcp", "/api/skills", "/api/usage", "/api/worktrees", "/api/settings"]);
    if (apiPaths.has(requestUrl.pathname)) {
      try {
        if (requestUrl.pathname === "/api/live-observability") {
          sendJson(response, 200, collectLiveObservability());
          return;
        }
        if (requestUrl.pathname === "/api/usage") {
          sendJson(response, 200, usageApiResponse(collectIndexedUsage(requestUrl.searchParams.get("window") ?? "all")));
          return;
        }
        const address = response.socket?.localAddress;
        const port = response.socket?.localPort;
        const evidence = collectEvidence(typeof port === "number" ? port : address, {
          includeObservability: requestUrl.pathname === "/api/observability" || requestUrl.pathname === "/api/diagnostics",
          includeDiagnostics: requestUrl.pathname === "/api/diagnostics",
          includeUsage: requestUrl.pathname === "/api/usage",
          includeWorktrees: requestUrl.pathname === "/api/worktrees" || requestUrl.pathname === "/api/diagnostics",
          includeSettings: requestUrl.pathname === "/api/settings" || requestUrl.pathname === "/api/diagnostics",
          usageWindow: requestUrl.searchParams.get("window") ?? "all",
        });
        const live = requestUrl.pathname === "/api/diagnostics"
          ? collectLiveObservability({ projects: evidence.projects, worktrees: evidence.worktrees })
          : null;
        if (live) evidence.diagnostics = collectDiagnostics(evidence, live);
        if (requestUrl.pathname === "/api/observability") {
          sendJson(response, 200, observabilityApiResponse(evidence));
        } else if (requestUrl.pathname === "/api/projects") {
          sendJson(response, 200, {
            generatedAt: evidence.generatedAt,
            discovery: {
              source: "direct child directories under ~/code",
              note: "Git repositories and marker-backed non-Git candidates only; unrelated directories are omitted.",
            },
            projects: evidence.projects.map((project) => ({
              name: project.name,
              path: project.path,
              classification: project.classification,
              gitRepository: project.gitRepository,
              branch: project.branch,
              head: project.head,
              dirty: project.dirty,
              trackedModification: project.trackedModification,
              untracked: project.untracked,
              governance: project.governance,
              piConfig: project.piConfig,
            })),
          });
        } else if (requestUrl.pathname === "/api/diagnostics") {
          sendJson(response, 200, {
            generatedAt: evidence.generatedAt,
            overall: evidence.diagnostics.overall,
            checks: evidence.diagnostics.checks,
            live: live?.diagnostics ?? null,
          });
        } else if (requestUrl.pathname === "/api/skills") {
          sendJson(response, 200, {
            generatedAt: evidence.generatedAt,
            sourcePolicy: evidence.skills.sourcePolicy,
            summary: {
              total: evidence.skills.summary.total,
              discovered: evidence.skills.summary.discovered,
              invalid: evidence.skills.summary.invalid,
              shadowed: evidence.skills.summary.shadowed,
            },
            sources: evidence.skills.sources.map((source) => ({
              id: source.id,
              name: source.name,
              scope: source.scope,
              source: source.source,
              provider: source.provider,
              pathCategory: source.pathCategory,
              configured: source.configured,
              state: source.state,
              discoverable: source.discoverable,
              loadable: source.loadable,
              discovered: source.discovered,
              note: source.note,
            })),
            skills: evidence.skills.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              source: skill.source,
              provider: skill.provider,
              pathCategory: skill.pathCategory,
              state: skill.state,
              note: skill.note,
            })),
            precedence: {
              status: evidence.skills.precedence.status,
              note: evidence.skills.precedence.note,
            },
            runtimeUsage: {
              status: evidence.skills.runtimeUsage.status,
              note: evidence.skills.runtimeUsage.note,
            },
            limitations: evidence.skills.limitations.map((limitation) => String(limitation)),
          });
        } else if (requestUrl.pathname === "/api/worktrees") {
          sendJson(response, 200, worktreesApiResponse({ ...evidence.worktrees, generatedAt: evidence.generatedAt }));
        } else if (requestUrl.pathname === "/api/settings") {
          sendJson(response, 200, settingsApiResponse({ ...evidence.settings, generatedAt: evidence.generatedAt }));
        } else if (requestUrl.pathname === "/api/mcp") {
          sendJson(response, 200, {
            generatedAt: evidence.generatedAt,
            sourcePolicy: evidence.mcp.sourcePolicy,
            entries: evidence.mcp.entries.map((entry) => ({
              id: entry.id,
              name: entry.name,
              scope: entry.scope,
              source: entry.source,
              state: entry.state,
              configured: entry.configured,
              transport: entry.transport,
              note: entry.note,
            })),
            sources: evidence.mcp.sources.map((source) => ({
              id: source.id,
              name: source.name,
              scope: source.scope,
              source: source.source,
              state: source.state,
              configured: source.configured,
              transport: source.transport,
              note: source.note,
            })),
            connectivity: {
              status: evidence.mcp.connectivity.status,
              note: evidence.mcp.connectivity.note,
            },
            resolution: {
              status: evidence.mcp.resolution.status,
              note: evidence.mcp.resolution.note,
            },
          });
        } else {
          sendJson(response, 200, overviewApiResponse(evidence));
        }
      } catch {
        sendJson(response, 500, { error: "Unable to collect local evidence" });
      }
      return;
    }
    if (["/agents", "/projects", "/diagnostics", "/mcp", "/skills", "/usage", "/worktrees", "/settings"].includes(requestUrl.pathname)) {
      serveStatic(response, "/");
      return;
    }
    serveStatic(response, requestUrl.pathname);
  });
}

export function startServer() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine the assigned dashboard port"));
        return;
      }
      resolve({ server, url: `http://${BIND_ADDRESS}:${address.port}` });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: BIND_ADDRESS, port: 0 });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, url } = await startServer();
  console.log("Pi Control Center started\n\nDashboard:\n" + url);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
