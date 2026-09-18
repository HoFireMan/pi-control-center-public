# Pi Control Center

**Local-first, read-mostly observability for Pi workstations.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-success)
![Network: localhost only](https://img.shields.io/badge/network-localhost--only-informational)

Pi Control Center is a local browser dashboard for inspecting bounded Pi workstation evidence: sessions, usage, context pressure, Codex quota, MCP, Skills, Worktrees, Settings, and diagnostics.

## Quick start

### Requirements

- Node.js 22 or newer
- Git for Git-backed Project and Worktree evidence
- Pi installed for meaningful Pi evidence
- `pi-subagents` is optional for related metadata and capabilities

### Run

```bash
git clone https://github.com/HoFireMan/pi-control-center-public.git
cd pi-control-center-public
npm start
```

The runtime has no npm dependencies, so `npm install` is not required. Startup binds only to `127.0.0.1` and requests an OS-assigned dynamic port. Open the URL printed in the terminal, such as `http://127.0.0.1:<dynamic-port>`.

To update an existing installation:

```bash
git pull
npm start
```

## What it shows

| Area | Evidence |
| --- | --- |
| Usage & Context | Pi-persisted token usage, durable local history, Context / Request Footprint, and actual compaction occurrences |
| Codex quota | Last-observed 5-hour and weekly rate-limit evidence from sanitized `x-codex-*` response headers on normal Pi SSE traffic |
| Agents | Historical Pi session inventory plus optional Bridge-backed live Pi presence |
| Projects & Worktrees | Local project inventory and bounded Git worktree topology |
| MCP & Skills | Metadata inventories from supported Pi configuration/discovery surfaces |
| Settings & Diagnostics | Curated safe configuration metadata and point-in-time evidence health |

## Usage and Context observability

Usage analytics read Pi-persisted `Usage` fields as local evidence and retain normalized facts in private durable SQLite history at `$XDG_DATA_HOME/pi-control-center/usage-history.sqlite`, falling back to `~/.local/share/pi-control-center/usage-history.sqlite`.

Durable history includes bounded Usage facts, observation-time Context / Request Footprint metadata, and actual compaction occurrences. Request context uses assistant `Usage.totalTokens`; runtime context requires the optional Bridge and Pi `ctx.getContextUsage()` observations. Context policy values are observation-time evidence and do not establish billing or account-complete usage. The GPT-5.6 `>272K` value is an input-footprint diagnostic, not billing evidence.

Committed facts survive source JSONL disappearance. The old cache is non-authoritative.

## Codex quota

Codex quota is a separate last-observed rate-limit surface from sanitized `x-codex-*` headers on normal Pi SSE traffic. It reports 5-hour and weekly windows only when authoritative duration evidence is available.

It is **not** provider billing or account-complete usage, and it does not poll a provider or make an extra request.

## Optional Bridge

Live Pi Presence and runtime Context observations require the included Bridge installed in Pi's documented global extension location:

```bash
mkdir -p ~/.pi/agent/extensions/pi-control-center-live-bridge
cp extensions/pi-control-center-live-bridge/index.ts ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
chmod 700 ~/.pi/agent/extensions/pi-control-center-live-bridge
chmod 600 ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
```

Start a new Pi process after installation. Existing Pi processes are not retroactively instrumented. Bridge installation is optional and is not required to start Pi Control Center.

The Bridge provides bounded local presence and Context telemetry only; it has no remote-control capability, network listener, extra provider request, or LLM call.

## Privacy and runtime boundary

Pi Control Center is intentionally local and evidence-bounded:

- binds only to `127.0.0.1`;
- uses an OS-assigned dynamic port;
- stores no raw prompts, responses, thinking, tool payloads, or transcripts in durable Usage history;
- does not provide Agent control, LAN access, or remote management;
- does not claim provider billing authority or account-complete usage;
- makes no extra provider requests or LLM calls for monitoring/indexing.

Some evidence sources are optional. When evidence is unavailable, the dashboard reports unavailable, unsupported, warning, or degraded states rather than inventing data.

## License

MIT. See [LICENSE](LICENSE).
