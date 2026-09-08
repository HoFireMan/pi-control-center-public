const $ = (selector) => document.querySelector(selector);

function text(value, fallback = "Unavailable") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function html(value, fallback = "Unavailable") {
  return text(value, fallback)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function date(value) {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unavailable" : parsed.toLocaleString();
}

function duration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function fileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unavailable";
}

function usd(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "Unavailable";
}

function listItems(selector, values) {
  $(selector).innerHTML = values.map((value) => `<li>${html(value)}</li>`).join("");
}

function governanceBadges(governance = {}) {
  return Object.entries(governance)
    .map(([name, present]) => `<span class="${present ? "present" : ""}">${html(name)}</span>`).join("");
}

function projectState(project) {
  if (project.classification !== "GIT_PROJECT") return "not applicable";
  return project.dirty ? "dirty" : "clean";
}

function projectConfig(project) {
  if (!project.piConfig?.present) return "none";
  const keys = project.piConfig.safeKeys?.length ? ` · ${project.piConfig.safeKeys.join(", ")}` : "";
  return `${project.piConfig.roleOverridePresent ? "role override" : "present"}${keys}`;
}

function renderProjects(projects) {
  $("#project-count").textContent = `${projects.length} entries`;
  $("#projects-body").innerHTML = projects.length
    ? projects.map((project) => `<tr>
        <td class="project-name">${html(project.name)}<small>${html(project.path)}</small></td>
        <td>${html(project.branch)}</td>
        <td>${html(project.head)}</td>
        <td class="state ${project.dirty ? "dirty" : ""}">${html(projectState(project))}</td>
        <td><div class="governance">${governanceBadges(project.governance)}</div></td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="empty">No relevant project evidence found under ~/code.</td></tr>';
}

function renderProjectInventory(data) {
  const projects = data.projects ?? [];
  const gitProjects = projects.filter((project) => project.classification === "GIT_PROJECT").length;
  const candidates = projects.filter((project) => project.classification === "NON_GIT_CANDIDATE").length;
  $("#projects-total").textContent = projects.length;
  $("#projects-git").textContent = gitProjects;
  $("#projects-candidates").textContent = candidates;
  $("#projects-source").textContent = `${text(data.discovery?.source)} · ${text(data.discovery?.note)}`;
  $("#projects-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#projects-page-body").innerHTML = projects.length
    ? projects.map((project) => `<tr>
        <td class="project-name">${html(project.name)}<small>${html(project.path)}</small></td>
        <td><span class="classification">${html(project.classification.replaceAll("_", " "))}</span></td>
        <td>${project.gitRepository ? "yes" : "no"}</td>
        <td>${html(project.branch)}</td>
        <td>${html(project.head)}</td>
        <td class="state ${project.dirty ? "dirty" : ""}">${html(projectState(project))}</td>
        <td><div class="governance">${governanceBadges(project.governance)}</div></td>
        <td class="config-cell">${html(projectConfig(project))}</td>
      </tr>`).join("")
    : '<tr><td colspan="8" class="empty">No relevant project evidence found under ~/code.</td></tr>';
}

function diagnosticClass(status) {
  return `diagnostic-status status-${String(status).toLowerCase()}`;
}

function renderDiagnostics(data) {
  const checks = data.checks ?? [];
  const supported = checks.filter((check) => check.status !== "UNSUPPORTED").length;
  const unsupported = checks.filter((check) => check.status === "UNSUPPORTED").length;
  const overall = data.overall ?? { status: "ERROR", explanation: "Diagnostics unavailable." };
  $("#diagnostics-overall-status").textContent = text(overall.status);
  $("#diagnostics-overall-detail").textContent = text(overall.explanation);
  $("#diagnostics-overall-status").className = diagnosticClass(overall.status);
  $("#diagnostics-dot").className = `status-dot dot-${String(overall.status).toLowerCase()}`;
  $("#diagnostics-supported").textContent = supported;
  $("#diagnostics-unsupported").textContent = unsupported;
  $("#diagnostics-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#diagnostics-body").innerHTML = checks.length
    ? checks.map((check) => `<tr>
        <td class="diagnostic-label">${html(check.label)}</td>
        <td><span class="${diagnosticClass(check.status)}">${html(check.status)}</span></td>
        <td>${html(check.explanation)}</td>
        <td class="source-cell">${html(check.source)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="empty">No diagnostic checks returned.</td></tr>';
}

function renderMcp(data) {
  const entries = data.entries ?? [];
  const sources = data.sources ?? [];
  $("#mcp-entry-count").textContent = entries.length;
  $("#mcp-source-count").textContent = sources.length;
  $("#mcp-connectivity").textContent = text(data.connectivity?.status);
  $("#mcp-connectivity").className = diagnosticClass(data.connectivity?.status ?? "UNSUPPORTED");
  $("#mcp-policy").textContent = text(data.sourcePolicy);
  $("#mcp-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#mcp-entries-body").innerHTML = entries.length
    ? entries.map((entry) => `<tr>
        <td class="diagnostic-label">${html(entry.name)}<small class="small-meta">${html(entry.id)}</small></td>
        <td>${html(entry.scope)}</td>
        <td>${html(entry.source)}</td>
        <td><span class="${diagnosticClass(entry.state)}">${html(entry.state)}</span></td>
        <td>${html(entry.transport)}</td>
        <td>${entry.configured ? "yes" : "no"}</td>
        <td>${html(entry.loadable)}</td>
        <td>${html(entry.running)}</td>
        <td>${html(entry.connected)}</td>
        <td>${html(entry.note)}${entry.shadowedDefinitions ? ` <small class="small-meta">${entry.shadowedDefinitions} shadowed definition(s)</small>` : ""}</td>
      </tr>`).join("")
    : '<tr><td colspan="10" class="empty">No MCP entries were discovered from the supported Pi adapter configuration surface.</td></tr>';
  $("#mcp-sources-body").innerHTML = sources.length
    ? sources.map((source) => `<tr>
        <td class="diagnostic-label">${html(source.name)}<small class="small-meta">${html(source.id)}</small></td>
        <td>${html(source.scope)}</td>
        <td>${html(source.source)}</td>
        <td>${html(source.precedence, "—")}</td>
        <td><span class="${diagnosticClass(source.state)}">${html(source.state)}</span></td>
        <td>${source.configured ? "yes" : "no"}</td>
        <td>${html(source.note)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No MCP configuration surfaces were available.</td></tr>';
}

function renderUsage(data) {
  const summary = data.summary ?? {};
  const tokens = summary.tokens ?? {};
  const cost = data.cost ?? {};
  const selected = data.window?.selected ?? "all";
  const selector = $("#usage-window");
  if (selector && selector.value !== selected) selector.value = selected;
  $("#usage-window-label").textContent = text(data.window?.label);
  $("#usage-total").textContent = number(tokens.total);
  $("#usage-input").textContent = number(tokens.input);
  $("#usage-output").textContent = number(tokens.output);
  $("#usage-cache").textContent = number((tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0));
  $("#usage-cost").textContent = cost.status === "UNSUPPORTED" ? "Unsupported" : usd(cost.amount);
  $("#usage-cost-detail").textContent = cost.status === "UNSUPPORTED" ? text(cost.note) : `${text(cost.currency)} · ${text(cost.status)}`;
  $("#usage-records").textContent = `${number(summary.recordCount)} records · ${number(summary.sessionCount)} sessions`;
  $("#usage-date-range").textContent = summary.dateRange?.start && summary.dateRange?.end
    ? `${date(summary.dateRange.start)} → ${date(summary.dateRange.end)}` : "No valid event timestamps";
  $("#usage-scope").textContent = text(data.scope?.note);
  const completeness = `${text(data.completeness?.classification)} · account-complete: ${text(data.completeness?.accountComplete)}`;
  $("#usage-completeness-value").textContent = completeness;
  $("#usage-completeness").textContent = completeness;
  $("#usage-source-detail").textContent = `${number(data.scope?.sessionFilesScanned)} files scanned · ${number(data.scope?.duplicateRecordsSuppressed)} copied records suppressed · ${number(data.scope?.parseErrors)} parse errors`;
  $("#usage-model-detail").textContent = `${number(data.modelAttribution?.unknownRecords)} records have no reliable model attribution.`;
  $("#usage-project-detail").textContent = `${number(data.projectAttribution?.unattributedRecords)} records remain UNATTRIBUTED.`;
  $("#usage-token-categories").innerHTML = (data.tokenCategories ?? []).map((category) => `<tr><td>${html(category.key)}</td><td><span class="${diagnosticClass(category.status)}">${html(category.status)}</span></td><td>${html(category.note)}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">No token categories available.</td></tr>';
  $("#usage-models-body").innerHTML = (summary.byModel ?? []).map((row) => `<tr><td>${html(row.provider)}</td><td>${html(row.model)}</td><td>${number(row.recordCount)}</td><td>${number(row.tokens?.total)}</td><td>${usd(row.cost?.totalUsd)}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No model-attributed usage found.</td></tr>';
  $("#usage-projects-body").innerHTML = (summary.byProject ?? []).map((row) => `<tr><td>${html(row.project)}</td><td>${number(row.recordCount)}</td><td>${number(row.tokens?.total)}</td><td>${usd(row.cost?.totalUsd)}</td></tr>`).join("") || '<tr><td colspan="4" class="empty">No project-attributed usage found.</td></tr>';
  $("#usage-limitations").innerHTML = (data.limitations ?? []).map((limitation) => `<li>${html(limitation)}</li>`).join("") || "<li>No additional limitations reported.</li>";
  $("#usage-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
}

function worktreeState(worktree) {
  const states = [];
  if (worktree.status === "DIRTY") states.push("dirty");
  if (worktree.detached) states.push("detached");
  if (worktree.bare) states.push("bare");
  if (worktree.status === "UNAVAILABLE") states.push("status unavailable");
  return states.join(" · ") || text(worktree.status, "Unavailable").toLowerCase();
}

function renderWorktrees(data) {
  const summary = data.summary ?? {};
  $("#worktrees-repositories").textContent = number(summary.repositoryCount);
  $("#worktrees-total").textContent = number(summary.worktreeCount);
  $("#worktrees-linked").textContent = number(summary.linkedWorktreeCount);
  $("#worktrees-special").textContent = number((summary.detachedCount ?? 0) + (summary.lockedCount ?? 0) + (summary.prunableCount ?? 0));
  $("#worktrees-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#worktrees-source").textContent = `${text(data.source)} · ${text(data.scope)}`;
  const rows = (data.repositories ?? []).flatMap((repository) => (repository.worktrees ?? []).map((worktree) => ({ repository, worktree })));
  $("#worktrees-body").innerHTML = rows.length
    ? rows.map(({ repository, worktree }) => `<tr>
        <td class="project-name">${html(repository.displayName)}<small>${html(repository.status)} · ${html(repository.id)}</small></td>
        <td><span class="classification">${html(worktree.kind)}</span></td>
        <td>${html(worktree.path)}<small class="small-meta">${html(worktree.pathState)}</small></td>
        <td>${html(worktree.branch, worktree.detached ? "detached HEAD" : "Unavailable")}</td>
        <td class="session-id">${html(worktree.head)}</td>
        <td class="state ${worktree.status === "DIRTY" ? "dirty" : ""}">${html(worktreeState(worktree))}<small class="small-meta">${html(worktree.statusNote)}</small></td>
        <td>${worktree.staged === null ? "—" : `${html(worktree.status)} · ${number((worktree.staged ?? 0) + (worktree.trackedModifications ?? 0) + (worktree.untracked ?? 0))} entries`}</td>
        <td>${worktree.locked ? `yes${worktree.lockReason ? ` · ${html(worktree.lockReason)}` : ""}` : "no"}</td>
        <td>${worktree.prunable ? `yes${worktree.prunableReason ? ` · ${html(worktree.prunableReason)}` : ""}` : "no"}</td>
        <td>${html(worktree.note)}</td>
      </tr>`).join("")
    : '<tr><td colspan="10" class="empty">No Git worktree records were available from discovered repositories.</td></tr>';
}

function settingDisplay(value) {
  if (Array.isArray(value)) return value.join(", ");
  return text(value, "—");
}

function renderSettings(data) {
  const sources = data.sources ?? [];
  const settings = data.settings ?? [];
  const packages = data.packages ?? [];
  const roles = data.roles ?? [];
  const configured = settings.filter((setting) => setting.state === "CONFIGURED").length;
  const effective = settings.filter((setting) => setting.effective?.status === "EFFECTIVE_STATIC").length;
  $("#settings-sources-count").textContent = number(sources.length);
  $("#settings-configured-count").textContent = number(configured);
  $("#settings-effective-count").textContent = number(effective);
  $("#settings-runtime-state").textContent = text(data.resolution?.runtime?.status, "UNSUPPORTED");
  $("#settings-policy").textContent = `Static file evidence only · ${text(data.resolution?.runtime?.note)}`;
  $("#settings-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#settings-sources-body").innerHTML = sources.length
    ? sources.map((source) => `<tr>
        <td class="project-name">${html(source.name)}<small>${html(source.location, "metadata boundary")}</small></td>
        <td>${html(source.scope)}</td>
        <td><span class="${diagnosticClass(source.state)}">${html(source.state)}</span></td>
        <td>${number(source.configuredKeyCount)}</td>
        <td>${number(source.safeSettingCount)}</td>
        <td>${number(source.omittedKeyCount)}</td>
        <td>${html(source.note)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No settings sources were available.</td></tr>';
  $("#settings-body").innerHTML = settings.length
    ? settings.map((setting) => {
      const configuredValues = Object.entries(setting.configuredValues ?? {}).map(([scope, value]) => `${scope}: ${settingDisplay(value)}`).join(" · ") || "none";
      const staticEffective = setting.effective?.status === "EFFECTIVE_STATIC" ? settingDisplay(setting.effective.value) : setting.effective?.status;
      return `<tr>
        <td class="project-name">${html(setting.name)}<small>${html(setting.category)} · ${html(setting.id)}</small></td>
        <td>${html(configuredValues)}</td>
        <td>${html(settingDisplay(setting.defaultValue))}</td>
        <td>${html(staticEffective)}<small class="small-meta">${html(setting.effective?.source)}</small></td>
        <td>${html(setting.scope)}</td>
        <td><span class="${diagnosticClass(setting.state)}">${html(setting.state)}</span></td>
        <td>${html(setting.note)}</td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="7" class="empty">No curated safe settings were available.</td></tr>';
  $("#settings-packages-body").innerHTML = packages.length
    ? packages.map((pkg) => `<tr><td>${html(pkg.identifier)}</td><td>${html(pkg.scope)}</td><td><span class="${diagnosticClass(pkg.state)}">${html(pkg.state)}</span></td><td>${html(pkg.note)}</td></tr>`).join("")
    : '<tr><td colspan="4" class="empty">No configured package identifiers were found.</td></tr>';
  $("#settings-roles-body").innerHTML = roles.length
    ? roles.map((role) => `<tr><td>${html(role.name)}</td><td>${html(role.model)}</td><td>${html(role.thinking)}</td><td>${html(role.runner)}</td><td>${html(role.tools)}</td><td><span class="${diagnosticClass(role.state)}">${html(role.state)}</span></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">No installed role metadata was found.</td></tr>';
  $("#settings-resolution").innerHTML = `<div class="info-row"><span class="info-key">Static resolution</span><span class="info-value">${html(data.resolution?.static?.status)} · ${html(data.resolution?.static?.precedence)}</span></div><div class="info-row"><span class="info-key">Runtime resolution</span><span class="info-value">${html(data.resolution?.runtime?.status)} · ${html(data.resolution?.runtime?.note)}</span></div><div class="info-row"><span class="info-key">Evidence source</span><span class="info-value">${html(data.resolution?.static?.source)}</span></div>`;
  $("#settings-limitations").innerHTML = (data.limitations ?? []).map((limitation) => `<li>${html(limitation)}</li>`).join("") || "<li>No additional limitations reported.</li>";
}

function renderSkills(data) {
  const summary = data.summary ?? {};
  const sources = data.sources ?? [];
  const skills = data.skills ?? [];
  $("#skills-discovered").textContent = summary.discovered ?? 0;
  $("#skills-invalid").textContent = summary.invalid ?? 0;
  $("#skills-shadowed").textContent = summary.shadowed ?? 0;
  $("#skills-runtime").textContent = text(data.runtimeUsage?.status, "UNSUPPORTED");
  $("#skills-runtime").className = diagnosticClass(data.runtimeUsage?.status ?? "UNSUPPORTED");
  $("#skills-policy").textContent = text(data.sourcePolicy);
  $("#skills-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#skills-sources-body").innerHTML = sources.length
    ? sources.map((source) => `<tr>
        <td class="diagnostic-label">${html(source.name)}<small class="small-meta">${html(source.source)}</small></td>
        <td>${html(source.scope)}</td>
        <td>${html(source.provider)}</td>
        <td>${html(source.pathCategory)}</td>
        <td><span class="${diagnosticClass(source.state)}">${html(source.state)}</span></td>
        <td>${html(source.discovered, "0")}</td>
        <td>${html(source.note)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No Skill sources were discovered.</td></tr>';
  $("#skills-body").innerHTML = skills.length
    ? skills.map((skill) => `<tr>
        <td class="diagnostic-label">${html(skill.name)}<small class="small-meta">${html(skill.id)}</small></td>
        <td>${html(skill.description)}</td>
        <td>${html(skill.scope)}</td>
        <td>${html(skill.source)}</td>
        <td>${html(skill.provider)}</td>
        <td><span class="${diagnosticClass(skill.state)}">${html(skill.state)}</span></td>
        <td>${html(skill.note)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No Skill metadata was discovered from supported Pi surfaces.</td></tr>';
}

function renderConfiguration(data) {
  const rows = [
    ["Global file", data.globalSettings.present ? "present · ~/.pi/agent/settings.json" : "not found"],
    ["Global safe values", Object.entries(data.globalSettings.safeValues ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "none collected"],
    ["Global top-level keys", data.globalSettings.safeKeys.join(", ") || "none"],
    ["This project file", data.projectSettings.present ? "present · .pi/settings.json" : "not found"],
    ["This project keys", data.projectSettings.safeKeys.join(", ") || "none"],
    ["pi-subagents config", data.subagentsConfig.present ? `present · keys: ${data.subagentsConfig.safeKeys.join(", ") || "none"}` : "not found"],
  ];
  $("#pi-config").innerHTML = rows.map(([key, value]) => `<div class="info-row"><span class="info-key">${html(key)}</span><span class="info-value">${html(value)}</span></div>`).join("");
}

function renderRoles(roles) {
  $("#role-count").textContent = `${roles.length} roles`;
  $("#roles-list").innerHTML = roles.length
    ? roles.map((role) => `<div class="role-row"><div class="role-name">${html(role.name)}</div><div class="role-meta">${html(role.description, "No description")}${role.thinking ? ` · thinking: ${html(role.thinking)}` : ""}${role.defaultContext ? ` · context: ${html(role.defaultContext)}` : ""}</div></div>`).join("")
    : '<p class="muted">No installed role definitions were found.</p>';
}

function renderOverview(data) {
  const runtime = data.runtime;
  $("#runtime-status").textContent = text(runtime.status);
  $("#runtime-detail").textContent = `Node ${text(runtime.nodeVersion)} · uptime ${runtime.uptimeSeconds}s · read-only`;
  $("#pi-version").textContent = text(data.pi.version);
  $("#subagents-version").textContent = data.piSubagents.version ? `v${data.piSubagents.version}` : "Not found";
  $("#subagents-detail").textContent = data.piSubagents.installed ? "Installed local package" : "Package not found";
  $("#dashboard-address").textContent = `${runtime.bindAddress}:${runtime.port}`;
  $("#refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  $("#generated-at").textContent = new Date(data.generatedAt).toLocaleString();
  renderProjects(data.projects);
  renderConfiguration({ ...data.pi, subagentsConfig: data.piSubagents.config });
  renderRoles(data.piSubagents.roles);
  listItems("#supported-list", data.surfaces.supportedNow);
  listItems("#stable-list", data.surfaces.stableLocalEvidence);
  listItems("#unsupported-list", data.surfaces.unsupportedOrNotAttached);
}

function agentProjectSelection() {
  const source = window.location.hash ? window.location.hash.slice(1) : `${window.location.pathname.slice(1)}${window.location.search}`;
  const [page, query = ""] = source.split("?");
  if (page !== "agents") return "all";
  return new URLSearchParams(query).get("project") || "all";
}

function projectFilterOptions(projects, selected) {
  const options = ['<option value="all">All Projects</option>'];
  for (const project of projects.filter((entry) => entry.projectName !== "UNATTRIBUTED")) {
    options.push(`<option value="${html(project.projectId)}">${html(project.projectName)}</option>`);
  }
  if (projects.some((project) => project.projectName === "UNATTRIBUTED")) options.push('<option value="project:unattributed">Unattributed</option>');
  $("#agent-project-filter").innerHTML = options.join("");
  $("#agent-project-filter").value = projects.some((project) => project.projectId === selected) || selected === "all" ? selected : "all";
}

function resultBadge(result) {
  const value = result ?? "UNKNOWN";
  return `<span class="lifecycle-result result-${String(value).toLowerCase()}">${html(value)}</span>`;
}

function liveBadge(value) {
  const normalized = value ?? "UNKNOWN";
  const className = String(normalized).toLowerCase().replaceAll("_", "-");
  return `<span class="live-badge live-${html(className)}">${html(normalized)}</span>`;
}

let liveObservabilityData = null;
function renderLiveObservability(data) {
  liveObservabilityData = data;
  const summary = data.summary ?? {};
  const available = data.availability === "AVAILABLE";
  $("#live-runtime-status").textContent = text(data.availability, "UNSUPPORTED");
  $("#live-runtime-status").className = `count-badge ${available ? "live-available" : "live-unsupported"}`;
  $("#live-pi-count").textContent = number(summary.liveInstances);
  $("#live-busy-count").textContent = number(summary.busyInstances);
  $("#live-idle-count").textContent = number(summary.idleInstances);
  $("#live-stale-exited-count").textContent = `${number(summary.staleInstances)} / ${number(summary.exitedInstances)}`;
  $("#live-instance-count").textContent = `${number((data.instances ?? []).length)} instances`;
  $("#live-observability-notice").innerHTML = available
    ? "<strong>Live Pi runtime available.</strong><span>Presence uses fresh heartbeat plus PID/process identity validation. Agent loop state is independent.</span>"
    : "<strong>Live Pi runtime unavailable.</strong><span>Install/load the repository Bridge in a Pi process. Historical evidence below remains separate.</span>";
  $("#live-runtime-source").textContent = `${text(data.timing?.heartbeatIntervalMs / 1000, "5")}s heartbeat · ${text(data.timing?.staleThresholdMs / 1000, "15")}s stale threshold · ${text(data.limitations?.[0])}`;
  const selected = agentProjectSelection();
  const projects = (data.projects ?? []).filter((project) => selected === "all" || project.projectId === selected);
  $("#live-projects-body").innerHTML = projects.length
    ? projects.map((project) => `<tr><td class="project-name">${html(project.projectName)}</td><td>${number(project.liveCount)}</td><td>${number(project.busyCount)}</td><td>${number(project.idleCount)}</td><td>${html(date(project.lastHeartbeatAt))}</td></tr>`).join("")
    : '<tr><td colspan="5" class="empty">No live Project telemetry is available.</td></tr>';
  const instances = (data.instances ?? []).filter((instance) => selected === "all" || instance.projectId === selected);
  $("#live-instances-body").innerHTML = instances.length
    ? instances.map((instance) => `<tr><td>${html(instance.projectName)}</td><td>${html(instance.workspace, "main or unavailable")}</td><td>${liveBadge(instance.presenceState)}</td><td>${liveBadge(instance.agentLoopState)}</td><td><span class="session-id">${html(instance.session)}</span></td><td>${html(date(instance.startedAt))}</td><td>${html(date(instance.heartbeatAt))}<small class="small-meta">${duration(instance.heartbeatAgeMs)} old</small></td></tr>`).join("")
    : '<tr><td colspan="7" class="empty">No live Pi instances are currently reported.</td></tr>';
}

function renderAllSessions(sessions, selected = "all") {
  const items = selected === "all" ? sessions.items : sessions.items.filter((session) => session.projectId === selected);
  const count = sessions.truncated ? `${sessions.returned} of ${sessions.totalDiscovered}` : `${sessions.returned}`;
  $("#session-count").textContent = `${count} sessions`;
  $("#session-source").textContent = `Source: ${text(sessions.source)} · ${sessions.liveState?.note ?? "Live state unavailable."}`;
  $("#sessions-body").innerHTML = items.length
    ? items.map((session) => `<tr>
        <td><span class="session-id">${html(session.id.slice(0, 12))}</span><small class="small-meta">JSONL v${html(session.version)}</small></td>
        <td>${html(session.project)}</td>
        <td>${html(session.workspace, "main or unavailable")}</td>
        <td>${html(date(session.createdAt))}</td>
        <td>${html(date(session.updatedAt))}<small class="small-meta">${html(session.updatedSource)}</small></td>
        <td>${html(session.provider)}<small class="small-meta">${html(session.model)}</small></td>
        <td>${html(session.thinking)}</td>
        <td>${html(fileSize(session.fileSizeBytes))}</td>
      </tr>`).join("")
    : '<tr><td colspan="8" class="empty">No readable Pi session headers match this Project.</td></tr>';
}

function renderProjectDetail(data, selected) {
  const projects = data.projectActivity.projects ?? [];
  const selectedProject = projects.find((project) => project.projectId === selected);
  const summary = selectedProject ?? {
    sessionCount: data.projectActivity.summary.sessionCount,
    historicalLifecycleCount: data.projectActivity.summary.historicalLifecycleCount,
    completedCount: data.projectActivity.summary.completedCount,
    failedCount: data.projectActivity.summary.failedCount,
    unknownLifecycleCount: data.projectActivity.summary.unknownLifecycleCount,
    projectName: "All Projects",
  };
  const lifecycleItems = data.piSubagents.lifecycleArtifacts.items.filter((run) => selected === "all" || run.projectId === selected);
  const sessionItems = data.sessions.items.filter((session) => selected === "all" || session.projectId === selected);
  $("#agent-detail-title").textContent = summary.projectName;
  $("#agent-detail-count").textContent = selectedProject?.normalizedPath ?? "all bounded evidence";
  $("#agent-detail-sessions").textContent = number(summary.sessionCount);
  $("#agent-detail-lifecycle").textContent = number(summary.historicalLifecycleCount);
  $("#agent-detail-results").textContent = `${number(summary.completedCount)} / ${number(summary.failedCount)}`;
  $("#agent-detail-unknown").textContent = number(summary.unknownLifecycleCount + (selectedProject?.unresolvedLifecycleCount ?? data.projectActivity.summary.unresolvedLifecycleCount));
  $("#agent-detail-lifecycle-body").innerHTML = lifecycleItems.length
    ? lifecycleItems.map((run) => `<tr><td><span class="run-id">${html((run.id ?? "UNRESOLVED").slice(0, 12))}</span></td><td>${html(run.project)}</td><td>${resultBadge(run.result)}</td><td>${html(run.steps?.find((step) => step.agent)?.agent)}</td><td>${html(date(run.updatedAt))}</td></tr>`).join("")
    : '<tr><td colspan="5" class="empty">No lifecycle evidence returned for this Project.</td></tr>';
  $("#agent-detail-sessions-body").innerHTML = sessionItems.length
    ? sessionItems.map((session) => `<tr><td><span class="session-id">${html(session.id.slice(0, 12))}</span></td><td>${html(session.workspace, "main or unavailable")}</td><td>${html(date(session.updatedAt))}</td><td>${html(session.provider)}<small class="small-meta">${html(session.model)}</small></td><td>${html(fileSize(session.fileSizeBytes))}</td></tr>`).join("")
    : '<tr><td colspan="5" class="empty">No session headers returned for this Project.</td></tr>';
}

function renderProjectActivity(data) {
  const activity = data.projectActivity;
  const selected = agentProjectSelection();
  const projects = activity.projects ?? [];
  projectFilterOptions(projects, selected);
  const visibleProjects = selected === "all" ? projects : projects.filter((project) => project.projectId === selected);
  $("#agent-projects-with-evidence").textContent = number(activity.summary.projectsWithEvidence);
  $("#agent-session-total").textContent = number(activity.summary.sessionCount);
  $("#agent-recent-total").textContent = number(activity.summary.recentEvidenceCount);
  $("#agent-recent-window").textContent = `${text(activity.recentEvidenceWindow?.label)} · persisted updates only`;
  $("#agent-lifecycle-total").textContent = number(activity.summary.historicalLifecycleCount);
  $("#agent-lifecycle-results").textContent = `${number(activity.summary.completedCount)} completed · ${number(activity.summary.failedCount)} failed`;
  $("#agent-project-source").textContent = `${text(activity.liveState?.note)} ${text(activity.limitations?.[1])}`;
  $("#agent-projects-body").innerHTML = visibleProjects.length
    ? visibleProjects.map((project) => `<tr>
        <td class="project-name">${html(project.projectName)}<small>${html(project.normalizedPath)}</small></td>
        <td>${number(project.sessionCount)}</td><td>${number(project.recentSessionCount)}</td><td>${number(project.completedCount)}</td><td>${number(project.failedCount)}</td>
        <td>${html(date(project.lastEvidenceAt))}</td><td><span class="lifecycle-result result-unsupported">UNSUPPORTED</span></td>
        <td><button type="button" class="link-button" data-agent-project="${html(project.projectId)}">View</button></td>
      </tr>`).join("")
    : '<tr><td colspan="8" class="empty">No Project activity matches this filter.</td></tr>';
  const recent = selected === "all" ? activity.recentEvidence : activity.recentEvidence.filter((item) => item.projectId === selected);
  $("#agent-recent-count").textContent = `${recent.length} of ${number(activity.summary.recentEvidenceCount)}`;
  $("#agent-recent-source").textContent = `${text(activity.recentEvidenceWindow?.definition)} Live state remains ${text(activity.liveState?.status)}.`;
  $("#agent-recent-body").innerHTML = recent.length
    ? recent.map((item) => `<tr><td>${html(item.project)}</td><td>${html(item.type)}</td><td><span class="session-id">${html(item.identifier?.slice(0, 16))}</span></td><td>${html(item.role)}</td><td>${html(item.workspace)}</td><td>${html(date(item.updatedAt))}</td><td>${resultBadge(item.historicalResult)}</td></tr>`).join("")
    : '<tr><td colspan="7" class="empty">No recent persisted evidence matches this Project.</td></tr>';
  renderProjectDetail(data, selected);
  renderAllSessions(data.sessions, selected);
  if (liveObservabilityData) renderLiveObservability(liveObservabilityData);
}

async function loadLiveObservability() {
  if (currentPage() !== "agents" || document.visibilityState === "hidden") return;
  try {
    const response = await fetch("/api/live-observability", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderLiveObservability(await response.json());
  } catch (error) {
    $("#live-runtime-status").textContent = "ERROR";
    $("#live-runtime-status").className = "count-badge live-error";
    $("#live-observability-notice").innerHTML = "<strong>Live telemetry temporarily unavailable.</strong><span>Historical Agents content is preserved; the next poll will retry.</span>";
    console.error(error);
  }
}

let livePollTimer = null;
function stopLivePolling() {
  if (livePollTimer !== null) clearInterval(livePollTimer);
  livePollTimer = null;
}

function startLivePolling() {
  stopLivePolling();
  if (currentPage() !== "agents" || document.visibilityState === "hidden") return;
  loadLiveObservability();
  livePollTimer = setInterval(loadLiveObservability, 5_000);
}

async function loadOverview() {
  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderOverview(await response.json());
  } catch (error) {
    $("#refresh-status").textContent = "Evidence unavailable";
    $("#runtime-status").textContent = "error";
    $("#runtime-detail").textContent = "Could not read local evidence.";
    console.error(error);
  }
}

async function loadObservability() {
  $("#observability-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/observability", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderProjectActivity(data);
    $("#observability-refresh-status").textContent = `Evidence refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`;
  } catch (error) {
    $("#observability-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadProjects() {
  $("#projects-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderProjectInventory(await response.json());
  } catch (error) {
    $("#projects-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadUsage() {
  $("#usage-refresh-status").textContent = "Refreshing…";
  try {
    const windowId = $("#usage-window")?.value ?? "all";
    const response = await fetch(`/api/usage?window=${encodeURIComponent(windowId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderUsage(await response.json());
  } catch (error) {
    $("#usage-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadSettings() {
  $("#settings-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/settings", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderSettings(await response.json());
  } catch (error) {
    $("#settings-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadWorktrees() {
  $("#worktrees-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/worktrees", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderWorktrees(await response.json());
  } catch (error) {
    $("#worktrees-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadSkills() {
  $("#skills-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/skills", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderSkills(await response.json());
  } catch (error) {
    $("#skills-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

async function loadDiagnostics() {
  $("#diagnostics-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/diagnostics", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderDiagnostics(await response.json());
  } catch (error) {
    $("#diagnostics-refresh-status").textContent = "Evidence unavailable";
    $("#diagnostics-overall-status").textContent = "ERROR";
    $("#diagnostics-overall-detail").textContent = "Could not read diagnostic evidence.";
    console.error(error);
  }
}

async function loadMcp() {
  $("#mcp-refresh-status").textContent = "Refreshing…";
  try {
    const response = await fetch("/api/mcp", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderMcp(await response.json());
  } catch (error) {
    $("#mcp-refresh-status").textContent = "Evidence unavailable";
    console.error(error);
  }
}

let loadedPage = null;
function currentPage() {
  const requested = (window.location.hash.slice(1) || window.location.pathname.slice(1)).split("?")[0];
  return ["agents", "skills", "projects", "diagnostics", "mcp", "usage", "worktrees", "settings"].includes(requested) ? requested : "overview";
}

function showPage() {
  const page = currentPage();
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("hidden", element.id !== `${page}-page`));
  document.querySelectorAll("[data-page]").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
  if (loadedPage === page && page !== "agents") return;
  loadedPage = page;
  if (page === "agents") {
    loadObservability();
    startLivePolling();
  } else {
    stopLivePolling();
    if (page === "settings") loadSettings();
    else if (page === "skills") loadSkills();
    else if (page === "worktrees") loadWorktrees();
    else if (page === "usage") loadUsage();
    else if (page === "projects") loadProjects();
    else if (page === "diagnostics") loadDiagnostics();
    else if (page === "mcp") loadMcp();
    else loadOverview();
  }
}

$("#refresh-overview").addEventListener("click", loadOverview);
$("#refresh-settings").addEventListener("click", loadSettings);
$("#refresh-observability").addEventListener("click", loadObservability);
$("#refresh-skills").addEventListener("click", loadSkills);
$("#refresh-worktrees").addEventListener("click", loadWorktrees);
$("#refresh-usage").addEventListener("click", loadUsage);
$("#usage-window").addEventListener("change", loadUsage);
$("#refresh-projects").addEventListener("click", loadProjects);
$("#refresh-diagnostics").addEventListener("click", loadDiagnostics);
$("#refresh-mcp").addEventListener("click", loadMcp);
$("#agent-project-filter").addEventListener("change", (event) => {
  window.location.hash = `agents?project=${encodeURIComponent(event.target.value)}`;
});
$("#agent-projects-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-agent-project]");
  if (button) window.location.hash = `agents?project=${encodeURIComponent(button.dataset.agentProject)}`;
});
window.addEventListener("hashchange", showPage);
document.addEventListener("visibilitychange", () => {
  if (currentPage() === "agents") {
    if (document.visibilityState === "hidden") stopLivePolling();
    else startLivePolling();
  }
});
showPage();
