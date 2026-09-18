# Pi Control Center

Pi Control Center is a local browser dashboard for inspecting bounded Pi workstation evidence.

## Requirements

- Node.js 22 or newer
- Git for Git-backed Project and Worktree evidence
- Pi installed for meaningful Pi evidence
- `pi-subagents` is optional for related metadata and capabilities

## Install and run

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

## Features

The dashboard provides local read-only or read-mostly views for Overview, Projects, historical Agents observability, optional live Pi presence, MCP and Skills inventories, Usage analytics, Worktrees, Settings, and Diagnostics.

Usage analytics read Pi-persisted Usage fields as local evidence and retain normalized facts in private durable SQLite history at `$XDG_DATA_HOME/pi-control-center/usage-history.sqlite`, falling back to `~/.local/share/pi-control-center/usage-history.sqlite`. Durable history includes bounded Usage facts, observation-time Context / Request Footprint metadata, and actual compaction occurrences. Request context uses assistant `Usage.totalTokens`; runtime context requires the optional Bridge and Pi `ctx.getContextUsage()` observations. Context policy values are observation-time evidence and do not establish billing or account-complete usage. The GPT-5.6 `>272K` value is an input-footprint diagnostic, not billing evidence. No raw paths, IDs, prompts, responses, thinking, tool payloads, or transcripts are stored. Committed facts survive source JSONL disappearance. The old cache is non-authoritative. Monitoring and indexing make no LLM calls, provider requests, or network requests.

Codex quota is a separate last-observed rate-limit surface from sanitized `x-codex-*` headers on normal Pi SSE traffic. It reports 5-hour and weekly windows only when authoritative duration evidence is available. It is not provider billing or account-complete usage, and it does not poll a provider or make an extra request.

Some evidence sources are optional. The dashboard can start when sources are unavailable and reports unavailable, unsupported, warning, or degraded capabilities according to the available evidence. It provides no Agent control, LAN access, remote management, live subagent fleet monitoring, or provider billing integration.

## Optional Bridge

Live Pi Presence and runtime Context observations require the included Bridge installed in Pi's documented global extension location:

```bash
mkdir -p ~/.pi/agent/extensions/pi-control-center-live-bridge
cp extensions/pi-control-center-live-bridge/index.ts ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
chmod 700 ~/.pi/agent/extensions/pi-control-center-live-bridge
chmod 600 ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
```

Start a new Pi process after installation. Existing Pi processes are not retroactively instrumented. Bridge installation is optional and is not required to start Pi Control Center. The Bridge provides bounded local presence and Context telemetry only; it has no remote-control capability, network listener, extra provider request, or LLM call.

## Runtime boundary

The server is localhost-only, uses an OS-assigned dynamic port, and exposes read-only evidence APIs. It does not provide billing authority, account-complete usage, prompt/response inspection, transcript viewing, Agent control, or remote management.

## License

MIT. See LICENSE.
