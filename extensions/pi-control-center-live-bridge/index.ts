import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEARTBEAT_INTERVAL_MS = 5_000;
const RUNTIME_DIRECTORY_NAME = "pi-control-center";
const SNAPSHOT_PREFIX = "instance-";
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

function writeSnapshot(state) {
  if (!state.directory || !state.filePath || !state.sessionId || !state.processStartIdentity || !state.cwd) return;
  const snapshot = {
    version: 1,
    bridgeVersion: "0.1.0",
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
    if (!directory || !startIdentity || !sessionId || !cwd) return;

    state = {
      directory,
      filePath: path.join(directory, `${SNAPSHOT_PREFIX}${instanceId(startIdentity).slice(SNAPSHOT_PREFIX.length)}.json`),
      instanceId: instanceId(startIdentity),
      processStartIdentity: startIdentity,
      sessionId,
      cwd,
      startedAt: Date.now(),
      sessionStartReason: safeReason(_event?.reason),
      agentLoopState: "UNKNOWN",
      timer: null,
    };
    setLoopState(ctx);
    writeSnapshot(state);
    state.timer = setInterval(() => writeSnapshot(state), HEARTBEAT_INTERVAL_MS);
    state.timer.unref?.();
  });

  pi.on("agent_start", (_event, ctx) => setLoopState(ctx, "BUSY"));
  pi.on("agent_settled", (_event, ctx) => setLoopState(ctx));
  pi.on("session_shutdown", shutdown);
}
