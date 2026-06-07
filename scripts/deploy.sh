#!/usr/bin/env bash
# Unified local deploy entrypoint for Yep Anywhere.
#
# Default behavior matches the historical `yep-deploy` alias:
#   server rebuild + restart + build verification, then APK rebuild + install.
#
# Usage:
#   scripts/deploy.sh
#   scripts/deploy.sh --server-only
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
  sed -n '2,13p' "$0" | sed 's/^# \?//'
  cat <<'EOF'

Options:
  --server-only       Deploy only the server bundle
  --apk-only          Build/install only the APK
  --no-server         Skip server deploy
  --no-apk            Skip APK build/install
  --restart-only      Restart existing server bundle without rebuilding it
  --server-build-only Build server bundle but do not restart
  --skip-checks       Skip pnpm lint/typecheck preflight

APK options passed through:
  --debug, --release, --no-install, --no-build, -s/--device <device-id>
EOF
}

DO_SERVER=true
DO_APK=true
RUN_CHECKS=true
SERVER_ARGS=()
APK_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-only)
      DO_SERVER=true
      DO_APK=false
      shift
      ;;
    --apk-only)
      DO_SERVER=false
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

if ! $DO_SERVER && ! $DO_APK; then
  err "Nothing to deploy: both server and APK are disabled."
  exit 2
fi

log "Deploy plan"
dim "server: $DO_SERVER ${SERVER_ARGS[*]:-}"
dim "apk:    $DO_APK ${APK_ARGS[*]:-}"
dim "checks: $RUN_CHECKS"

if $RUN_CHECKS && $DO_SERVER; then
  log "Running preflight checks ..."
  pnpm lint
  pnpm typecheck
fi

if $DO_SERVER; then
  log "Deploying server ..."
  if [[ ${#SERVER_ARGS[@]} -gt 0 ]]; then
    scripts/redeploy-server.sh "${SERVER_ARGS[@]}"
  else
    scripts/redeploy-server.sh
  fi
else
  warn "Skipping server deploy."
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
