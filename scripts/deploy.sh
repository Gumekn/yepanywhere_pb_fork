#!/usr/bin/env bash
# Unified local deploy entrypoint for Yep Anywhere.
#
# With no arguments, this script opens an interactive deploy wizard.
# Passing any flag keeps the non-interactive behavior for aliases/automation.
#
# Usage:
#   scripts/deploy.sh                         # interactive wizard
#   scripts/deploy.sh --server-only           # non-interactive server deploy
#   scripts/deploy.sh --codex-bridge-only     # non-interactive 4510 bridge deploy
#   scripts/deploy.sh --apk-only --debug
#   scripts/deploy.sh --restart-only --no-apk
#   scripts/deploy.sh --skip-checks --no-install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

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
  sed -n '2,13p' "$0" | sed 's/^# *//'
  cat <<'EOF'

Options:
  --server-only       Deploy only the server bundle
  --codex-bridge-only Deploy only the 4510 Codex bridge sidecar
  --apk-only          Build/install only the APK
  --no-server         Skip server deploy
  --no-apk            Skip APK build/install
  --restart-only      Restart existing server bundle without rebuilding it
  --server-build-only Build server bundle but do not restart
  --preserve-codex-bridge
                      Keep the Codex bridge sidecar alive while restarting the web server (default)
  --restart-codex-bridge
                      Restart the Codex bridge sidecar too; disconnects active cf sessions
  --embedded-codex-bridge
                      Legacy mode: run the Codex bridge inside the web server
  --skip-checks       Skip pnpm lint/typecheck preflight

APK options passed through:
  --debug, --release, --no-install, --no-build, -s/--device <device-id>
EOF
}

DO_SERVER=true
DO_CODEX_BRIDGE=false
DO_APK=true
RUN_CHECKS=true
SERVER_ARGS=()
APK_ARGS=()

ask_yes_no() {
  local prompt="$1"
  local default="$2"
  local reply
  local reply_lc

  while true; do
    if [[ "$default" == "yes" ]]; then
      read -r -p "$prompt [Y/n] " reply
      reply="${reply:-y}"
    else
      read -r -p "$prompt [y/N] " reply
      reply="${reply:-n}"
    fi

    reply_lc="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    case "$reply_lc" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

choose_apk_build_type() {
  local reply
  local reply_lc

  echo
  log "APK build type"
  dim "release: production-signed build; slower, smaller, requires keystore.properties."
  dim "debug: development-signed build; faster, cannot update over a release-signed install."

  while true; do
    read -r -p "Choose APK build type: 1) release  2) debug  [1] " reply
    reply="${reply:-1}"
    reply_lc="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    case "$reply_lc" in
      1|r|release)
        APK_ARGS+=(--release)
        return
        ;;
      2|d|debug)
        APK_ARGS+=(--debug)
        return
        ;;
      *) warn "Please choose 1/release or 2/debug." ;;
    esac
  done
}

configure_interactive() {
  DO_SERVER=false
  DO_CODEX_BRIDGE=false
  DO_APK=false
  RUN_CHECKS=false
  SERVER_ARGS=()
  APK_ARGS=()

  log "Interactive deploy"
  dim "Press Enter to accept the default shown in brackets."

  echo
  log "8022 web/API server"
  dim "8022 is the main Yep Anywhere service: it serves the /yep web UI, REST APIs,"
  dim "and the browser/mobile WebSocket endpoint used by the frontend."
  dim "Redeploying it rebuilds the server/client bundle and restarts only that web/API service."
  if ask_yes_no "Redeploy 8022 web/API server?" "yes"; then
    DO_SERVER=true
    RUN_CHECKS=true
  fi

  echo
  log "4510 Codex bridge"
  dim "4510 is the local WebSocket bridge used by cf / codex --remote sessions."
  dim "Choosing no leaves the existing 4510 process untouched."
  dim "Choosing yes restarts 4510 and disconnects active cf / codex --remote sessions."
  if ask_yes_no "Redeploy 4510 Codex bridge service?" "no"; then
    DO_CODEX_BRIDGE=true
    RUN_CHECKS=true
    SERVER_ARGS+=(--restart-codex-bridge)
  fi

  echo
  log "Android APK"
  dim "This rebuilds the Tauri Android APK and installs it onto a connected adb device."
  dim "Device selection and signature-mismatch handling are delegated to scripts/rebuild-apk.sh."
  if ask_yes_no "Build APK and install it?" "no"; then
    DO_APK=true
    choose_apk_build_type
  fi
}

if [[ $# -eq 0 ]]; then
  if [[ -t 0 ]]; then
    configure_interactive
  else
    err "No arguments were provided, and stdin is not a terminal."
    err "Run scripts/deploy.sh from a terminal for the interactive wizard, or pass flags for non-interactive use."
    exit 2
  fi
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-only)
        DO_SERVER=true
        DO_CODEX_BRIDGE=false
        DO_APK=false
        shift
        ;;
      --codex-bridge-only)
        DO_SERVER=false
        DO_CODEX_BRIDGE=true
        DO_APK=false
        SERVER_ARGS+=(--restart-codex-bridge)
        shift
        ;;
      --apk-only)
        DO_SERVER=false
        DO_CODEX_BRIDGE=false
        DO_APK=true
        RUN_CHECKS=false
        shift
        ;;
      --no-server)
        DO_SERVER=false
        shift
        ;;
      --no-apk)
        DO_APK=false
        shift
        ;;
      --restart-only)
        SERVER_ARGS+=(--restart)
        RUN_CHECKS=false
        shift
        ;;
      --server-build-only)
        SERVER_ARGS+=(--no-restart)
        shift
        ;;
      --preserve-codex-bridge)
        SERVER_ARGS+=(--preserve-codex-bridge)
        shift
        ;;
      --restart-codex-bridge)
        DO_CODEX_BRIDGE=true
        SERVER_ARGS+=(--restart-codex-bridge)
        shift
        ;;
      --embedded-codex-bridge|--no-preserve-codex-bridge)
        SERVER_ARGS+=("$1")
        shift
        ;;
      --skip-checks)
        RUN_CHECKS=false
        shift
        ;;
      --debug|--release|--no-install|--no-build)
        APK_ARGS+=("$1")
        shift
        ;;
      -s|--device)
        if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
          err "$1 requires a device id argument."
          exit 2
        fi
        APK_ARGS+=("$1" "$2")
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "Unknown arg: $1"
        err "Run with --help for usage."
        exit 2
        ;;
    esac
  done
fi

if ! $DO_SERVER && ! $DO_CODEX_BRIDGE && ! $DO_APK; then
  err "Nothing to deploy: 8022 server, 4510 bridge, and APK are all disabled."
  exit 2
fi

log "Deploy plan"
dim "8022 web/API:      $DO_SERVER"
dim "4510 Codex bridge: $DO_CODEX_BRIDGE"
dim "server args:       ${SERVER_ARGS[*]:-}"
dim "apk:               $DO_APK ${APK_ARGS[*]:-}"
dim "checks:            $RUN_CHECKS"

if $RUN_CHECKS && { $DO_SERVER || $DO_CODEX_BRIDGE; }; then
  log "Running preflight checks ..."
  pnpm lint
  pnpm typecheck
fi

if $DO_SERVER || $DO_CODEX_BRIDGE; then
  log "Deploying server services ..."
  if ! $DO_SERVER; then
    SERVER_ARGS+=(--no-restart)
  fi
  if [[ ${#SERVER_ARGS[@]} -gt 0 ]]; then
    scripts/redeploy-server.sh "${SERVER_ARGS[@]}"
  else
    scripts/redeploy-server.sh
  fi
else
  warn "Skipping server services deploy."
fi

if $DO_APK; then
  log "Building/installing APK ..."
  if [[ ${#APK_ARGS[@]} -gt 0 ]]; then
    scripts/rebuild-apk.sh "${APK_ARGS[@]}"
  else
    scripts/rebuild-apk.sh
  fi
else
  warn "Skipping APK build/install."
fi

log "Deploy complete."
