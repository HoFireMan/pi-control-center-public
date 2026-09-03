# Pi Control Center

Pi Control Center is a local browser dashboard for inspecting Pi workstation evidence.

## Requirements

- Node.js 22 or newer
- Git for Git-backed Project and Worktree evidence
- Pi installed for meaningful Pi evidence
- `pi-subagents` is optional for its related metadata and capabilities

## Install and run

For the intended future public distribution:

```bash
git clone https://github.com/HoFireMan/pi-control-center-public.git
cd pi-control-center-public
npm start
```

The current version has no runtime npm dependencies, so `npm install` is not required. Startup binds only to `127.0.0.1` and requests an OS-assigned dynamic port. Open the URL printed in the terminal, similar to `http://127.0.0.1:<dynamic-port>`, in a browser.

To update an existing installation:

```bash
git pull
npm start
```

## Features

The dashboard provides local read-only or read-mostly views for Overview, Projects, historical Agents observability, Phase A live Pi presence, MCP and Skills inventories, Usage analytics, Worktrees, Settings, and Diagnostics.

Usage analytics read Pi-persisted `Usage` fields; Pi JSONL remains authoritative. A local SQLite-derived Usage index may reuse unchanged source files. It is private, rebuildable, and non-authoritative. Changed source files are conservatively reprocessed in full. Monitoring and indexing make no LLM calls.

Some evidence sources are optional. The dashboard can start when sources are unavailable, and reports unavailable, unsupported, warning, or degraded capabilities according to the available evidence. This does not provide Agent control, LAN access, remote management, live subagent fleet monitoring, or provider billing integration.

## Optional Phase A live presence

Live Pi Presence requires installing the included Bridge into Pi's documented global extension discovery location:

```bash
mkdir -p ~/.pi/agent/extensions/pi-control-center-live-bridge
cp extensions/pi-control-center-live-bridge/index.ts ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
chmod 700 ~/.pi/agent/extensions/pi-control-center-live-bridge
chmod 600 ~/.pi/agent/extensions/pi-control-center-live-bridge/index.ts
```

Start a new Pi process after installation. Pi processes that were already running before installation are not retroactively instrumented. Bridge installation is optional and is not required to start Pi Control Center. The Bridge provides scoped local presence telemetry only; it has no remote-control capability or network listener.

## License

MIT. See LICENSE.
