#!/usr/bin/env bash
# Rebuild the yepanywhere server bundle from the monorepo and restart the
# running server process so the new code takes effect.
#
# Usage:
#   scripts/redeploy-server.sh           # full rebuild + restart
#   scripts/redeploy-server.sh --restart # restart only (skip rebuild)
#   scripts/redeploy-server.sh --no-restart # rebuild only (skip restart)
#
# Assumes:
#   - Global `yepanywhere` command is pnpm-linked to dist/npm-package
#     (one-time: `pnpm link --global` from repo root).
#   - You want to keep the relay process and frp tunnel running. This script
#     only touches the yepanywhere server itself.
#
# Side effects of restart:
#   - APK / web clients disconnect for ~3-5s (auto-reconnect, no relogin).
#   - In-progress SDK sessions (running claude subprocesses) are killed.
#   - Persisted session jsonl is unaffected.

set -euo pipefail

# Resolve repo root from script location so this works no matter where it's invoked.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Color helpers (skipped if not a tty).
if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

# ----- args -----
DO_BUILD=true
DO_RESTART=true
SERVER_PORT="${YEP_DEPLOY_PORT:-8022}"
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"
if [[ "$SERVER_BASE_PATH" == "/" ]]; then
  SERVER_BASE_PATH=""
else
  SERVER_BASE_PATH="/${SERVER_BASE_PATH#/}"
  SERVER_BASE_PATH="${SERVER_BASE_PATH%/}"
fi
SERVER_BASE_URL="http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
for arg in "$@"; do
  case "$arg" in
    --restart)    DO_BUILD=false ;;
    --no-restart) DO_RESTART=false ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      err "Unknown arg: $arg"
      exit 2
      ;;
  esac
done

# ----- preflight -----
# Pull version from the monorepo root package.json so the bundle reports the
# real version (build-bundle.ts otherwise falls back to a hardcoded string).
NPM_VERSION="$(node -p "require('./package.json').version")"
log "Monorepo version: ${NPM_VERSION}"

# Count running SDK children before we kill the server so the user knows
# what they're about to interrupt. Shown only, not used to abort.
if $DO_RESTART; then
  SDK_COUNT="$(pgrep -fa 'claude-agent-sdk' 2>/dev/null | grep -c . || true)"
  if [[ "$SDK_COUNT" -gt 0 ]]; then
    warn "About to kill the running yepanywhere server. ${SDK_COUNT} active SDK claude subprocess(es) will be terminated."
  fi
fi

# ----- build -----
if $DO_BUILD; then
  log "Building bundle (NPM_VERSION=${NPM_VERSION}) ..."
  NPM_VERSION="$NPM_VERSION" pnpm build:bundle

  # The build sometimes drops the +x bit on the CLI entry — restore it so
  # node's shebang launcher works.
  if [[ -f dist/npm-package/dist/cli.js ]]; then
    chmod +x dist/npm-package/dist/cli.js
  else
    err "Expected dist/npm-package/dist/cli.js after build, but it's missing."
    exit 1
  fi

  # build-bundle.ts only stages the package for publishing — it doesn't
  # install runtime dependencies. When npm publishes, `npm i -g yepanywhere`
  # installs the dependencies for end users; for local dev we have to do
  # it ourselves, otherwise `yepanywhere` boots with ERR_MODULE_NOT_FOUND.
  log "Installing runtime dependencies in dist/npm-package ..."
  (cd dist/npm-package && npm install --omit=dev --no-audit --no-fund --silent)

  # Sanity-check the linked global command resolves to our bundle.
  GLOBAL_BIN="$(command -v yepanywhere 2>/dev/null || true)"
  if [[ -z "$GLOBAL_BIN" ]]; then
    warn "'yepanywhere' command not on PATH. Run 'pnpm link --global' from the repo root, then re-run this script."
  else
    RESOLVED="$(readlink -f "$GLOBAL_BIN" 2>/dev/null || echo "$GLOBAL_BIN")"
    EXPECTED="$REPO_ROOT/dist/npm-package/dist/cli.js"
    if [[ "$RESOLVED" != "$EXPECTED" ]]; then
      warn "'yepanywhere' resolves to $RESOLVED, not $EXPECTED"
      warn "Restart will launch the wrong build. Run 'pnpm link --global' to fix."
    fi
  fi

  # Verify the bundle actually reports the version we asked for. Catches
  # silent build issues (e.g. NPM_VERSION not picked up by build-bundle).
  ACTUAL_VERSION="$(yepanywhere --version 2>&1 | head -1 | awk '{print $NF}' || true)"
  if [[ "$ACTUAL_VERSION" != "v${NPM_VERSION}" && "$ACTUAL_VERSION" != "${NPM_VERSION}" ]]; then
    warn "Bundle reports version '${ACTUAL_VERSION}' but expected 'v${NPM_VERSION}'."
  fi
fi

# ----- restart -----
if $DO_RESTART; then
  log "Stopping running yepanywhere ..."
  # `node ... yepanywhere` is the actual process; pkill matches against the
  # full command line. Suppress error if nothing was running.
  pkill -f "node.*yepanywhere" || true

  # Wait briefly for the old process to release the port.
  for _ in $(seq 1 20); do
    if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "Port ${SERVER_PORT} is still held by PID(s): ${LISTEN_PIDS//$'\n'/, }. Sending SIGTERM ..."
    kill $LISTEN_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi

  LISTEN_PIDS="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTEN_PIDS" ]]; then
    warn "Port ${SERVER_PORT} did not release after SIGTERM. Sending SIGKILL to PID(s): ${LISTEN_PIDS//$'\n'/, }"
    kill -9 $LISTEN_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi

  if lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    err "Port ${SERVER_PORT} is still in use after stopping the old server."
    exit 1
  fi

  log "Starting yepanywhere in background (logs: /tmp/yep-server.log) ..."
  # Mount under /yep so Caddy at air.yueyuan.uk/yep/* reverse-proxies into us
  # cleanly (see INFRA.md). The Hono app + client bundle both pick up BASE_PATH.
  # APK / direct-mode tcp tunnel callers are unaffected — they hit ws://host:8022
  # which still serves /yep/api/ws; only the URL prefix changes, not the port.
  BASE_PATH="${SERVER_BASE_PATH:-/}" nohup yepanywhere --port "$SERVER_PORT" >/tmp/yep-server.log 2>&1 & disown

  # Health-check loop. Tries up to 15s; the server usually answers within 2s
  # but Tauri activity / large data dirs can stretch first-boot.
  # /yep/api/version is a small JSON endpoint that exists on every server build —
  # /api/health doesn't (unmatched routes fall through to the SPA shell).
  # The /yep prefix matches the BASE_PATH set above.
  log "Waiting for ${SERVER_BASE_URL}/api/version ..."
  HEALTH_OK=false
  for _ in $(seq 1 60); do
    if curl -fsS "${SERVER_BASE_URL}/api/version" >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    sleep 0.25
  done

  if $HEALTH_OK; then
    log "Server is up."
    # Show what the freshly started server reports.
    SERVER_VERSION_LINE="$(curl -fsS "${SERVER_BASE_URL}/api/version" 2>/dev/null | node -e 'let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => { const d=JSON.parse(raw); console.log(`current=${d.current} protocol=${d.resumeProtocolVersion} buildId=${d.build?.buildId ?? "missing"}`); })' 2>/dev/null || true)"
    dim "${SERVER_BASE_URL}/api/version → ${SERVER_VERSION_LINE}"

    LISTEN_PID="$(lsof -iTCP:"${SERVER_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ -n "$LISTEN_PID" ]]; then
      LISTEN_CMD="$(ps -p "$LISTEN_PID" -o command= 2>/dev/null || true)"
      dim "pid ${LISTEN_PID}: ${LISTEN_CMD}"
    fi

    log "Verifying deployed server/client build metadata ..."
    node scripts/verify-deploy.mjs \
      --base-url "$SERVER_BASE_URL" \
      --build-info "$REPO_ROOT/dist/npm-package/build-info.json"

    # Relay (4400) was retired in favor of self-hosted frp tcp tunnels.
    # Skipping relay status check — see INFRA.md.
  else
    err "Server didn't answer /yep/api/version within 15s. Check /tmp/yep-server.log for crashes."
    tail -20 /tmp/yep-server.log >&2 || true
    exit 1
  fi
fi

log "Done."
