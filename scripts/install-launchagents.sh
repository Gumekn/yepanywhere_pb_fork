#!/usr/bin/env bash
# Install macOS LaunchAgents that start Yep Anywhere once when this user logs in.
#
# This intentionally does not set KeepAlive. The services start at login, but
# manual stops/redeploys remain under the user's control.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVER_LABEL="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
BRIDGE_LABEL="${YEP_LAUNCHD_BRIDGE_LABEL:-com.yueyuan.yepanywhere.codex-bridge}"
SERVER_PORT="${YEP_DEPLOY_PORT:-8022}"
SERVER_BASE_PATH="${YEP_DEPLOY_BASE_PATH:-/yep}"
BRIDGE_PORT="${YEP_CODEX_BRIDGE_PORT:-${CODEX_BRIDGE_PORT:-4510}}"
BRIDGE_URL="${YEP_CODEX_BRIDGE_CONTROL_URL:-${CODEX_BRIDGE_CONTROL_URL:-http://127.0.0.1:${BRIDGE_PORT}}}"
NODE_BIN="${YEP_LAUNCHD_NODE:-$(command -v node 2>/dev/null || true)}"
CLI_JS="$REPO_ROOT/dist/npm-package/dist/cli.js"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="${YEP_LAUNCHD_LOG_DIR:-$HOME/.yep-anywhere/logs}"
USER_DOMAIN="gui/$(id -u)"
START_NOW=true

if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

log()  { echo -e "${C_GREEN}==>${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!!${C_RESET}  $*" >&2; }
err()  { echo -e "${C_RED}xx${C_RESET}  $*" >&2; }
dim()  { echo -e "${C_DIM}    $*${C_RESET}"; }

usage() {
  sed -n '2,6p' "$0" | sed 's/^# *//'
  cat <<'EOF'

Usage:
  scripts/install-launchagents.sh [--no-start]

Environment overrides:
  YEP_DEPLOY_PORT              Main server port (default: 8022)
  YEP_DEPLOY_BASE_PATH         Main server base path (default: /yep)
  YEP_CODEX_BRIDGE_PORT        Codex bridge port (default: 4510)
  YEP_LAUNCHD_NODE             Absolute node binary path
  YEP_LAUNCHD_PATH             PATH stored in the LaunchAgent environment
  YEP_LAUNCHD_LOG_DIR          LaunchAgent stdout/stderr log directory
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --no-start)
      START_NOW=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown arg: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "LaunchAgents are only available on macOS."
  exit 1
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  err "Could not find an executable node binary. Set YEP_LAUNCHD_NODE=/absolute/path/to/node."
  exit 1
fi

if [[ ! -f "$CLI_JS" ]]; then
  err "Expected bundled CLI at $CLI_JS, but it does not exist."
  err "Run scripts/deploy.sh --server-only once to build dist/npm-package, then retry."
  exit 1
fi

if [[ ! -d "$REPO_ROOT/dist/npm-package/node_modules" ]]; then
  warn "Runtime dependencies are missing from dist/npm-package/node_modules."
  warn "Run scripts/deploy.sh --server-only before relying on the LaunchAgents."
fi

chmod +x "$CLI_JS" 2>/dev/null || true
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

LAUNCHD_PATH="${YEP_LAUNCHD_PATH:-${PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin}}"
NODE_DIR="$(dirname "$NODE_BIN")"
case ":$LAUNCHD_PATH:" in
  *":$NODE_DIR:"*) ;;
  *) LAUNCHD_PATH="$NODE_DIR:$LAUNCHD_PATH" ;;
esac

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_header() {
  local path="$1"
  local label="$2"
  local stdout_path="$3"
  local stderr_path="$4"

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$label")"
    printf '%s\n' '  <key>RunAtLoad</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>WorkingDirectory</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$REPO_ROOT")"
    printf '%s\n' '  <key>StandardOutPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$stdout_path")"
    printf '%s\n' '  <key>StandardErrorPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$stderr_path")"
  } >"$path"
}

append_env() {
  local path="$1"
  shift

  {
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    while [[ $# -gt 0 ]]; do
      local key="$1"
      local value="$2"
      shift 2
      printf '    <key>%s</key>\n' "$(xml_escape "$key")"
      printf '    <string>%s</string>\n' "$(xml_escape "$value")"
    done
    printf '%s\n' '  </dict>'
  } >>"$path"
}

append_program_arguments() {
  local path="$1"
  shift

  {
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$(xml_escape "$arg")"
    done
    printf '%s\n' '  </array>'
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } >>"$path"
}

write_bridge_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist"
  write_header "$plist" "$BRIDGE_LABEL" "$LOG_DIR/codex-bridge-launchd.out.log" "$LOG_DIR/codex-bridge-launchd.err.log"
  append_env "$plist" \
    "NODE_ENV" "production" \
    "PATH" "$LAUNCHD_PATH" \
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT" \
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--codex-bridge-only"
  echo "$plist"
}

write_server_plist() {
  local plist="$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"
  write_header "$plist" "$SERVER_LABEL" "$LOG_DIR/server-launchd.out.log" "$LOG_DIR/server-launchd.err.log"
  append_env "$plist" \
    "NODE_ENV" "production" \
    "PATH" "$LAUNCHD_PATH" \
    "BASE_PATH" "$SERVER_BASE_PATH" \
    "YEP_DEPLOY_REPO_ROOT" "$REPO_ROOT" \
    "YEP_CODEX_BRIDGE_MODE" "external" \
    "YEP_CODEX_BRIDGE_CONTROL_URL" "$BRIDGE_URL" \
    "YEP_CODEX_BRIDGE_PORT" "$BRIDGE_PORT"
  append_program_arguments "$plist" "$NODE_BIN" "$CLI_JS" "--port" "$SERVER_PORT"
  echo "$plist"
}

reload_agent() {
  local label="$1"
  local plist="$2"

  launchctl bootout "$USER_DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootout "$USER_DOMAIN" "$plist" >/dev/null 2>&1 || true
  if ! $START_NOW; then
    dim "wrote $plist; it will load at next login"
    return
  fi
  launchctl bootstrap "$USER_DOMAIN" "$plist"
  launchctl enable "$USER_DOMAIN/$label"
  launchctl kickstart -k "$USER_DOMAIN/$label"
}

log "Installing Yep Anywhere LaunchAgents ..."
BRIDGE_PLIST="$(write_bridge_plist)"
SERVER_PLIST="$(write_server_plist)"

reload_agent "$BRIDGE_LABEL" "$BRIDGE_PLIST"
reload_agent "$SERVER_LABEL" "$SERVER_PLIST"

log "Installed LaunchAgents."
dim "server: $SERVER_LABEL -> http://127.0.0.1:${SERVER_PORT}${SERVER_BASE_PATH}"
dim "bridge: $BRIDGE_LABEL -> $BRIDGE_URL"
dim "logs:   $LOG_DIR/*-launchd.*.log"
dim "KeepAlive is intentionally not set; these agents start at login only."
