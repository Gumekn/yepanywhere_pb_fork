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
#
# Optional local deploy config:
#   .env.deploy.local                         # git-ignored KEY=value file
#   ./google-services.json                    # copied into the Android app if present
#   ./firebase-service-account*.json          # used for server FCM if env is unset

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

LOADED_DEPLOY_ENV_FILE=""
DISCOVERED_FCM_SERVICE_ACCOUNT_FILE=""

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_deploy_env_file() {
  local env_file="${YEP_DEPLOY_ENV_FILE:-$REPO_ROOT/.env.deploy.local}"

  if [[ ! -f "$env_file" ]]; then
    if [[ -n "${YEP_DEPLOY_ENV_FILE:-}" ]]; then
      err "YEP_DEPLOY_ENV_FILE was set, but the file does not exist: $env_file"
      exit 1
    fi
    return
  fi

  local raw_line line key value
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line="$(trim_whitespace "$raw_line")"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="$(trim_whitespace "${line#export}")"
    fi
    if [[ "$line" != *=* ]]; then
      warn "Skipping invalid deploy env line in $env_file: $raw_line"
      continue
    fi

    key="$(trim_whitespace "${line%%=*}")"
    value="$(trim_whitespace "${line#*=}")"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      warn "Skipping invalid deploy env key in $env_file: $key"
      continue
    fi
    if [[ -n "${!key+x}" ]]; then
      continue
    fi

    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:$((${#value} - 2))}"
    elif [[ ${#value} -ge 2 && "$value" == \'* && "$value" == *\' ]]; then
      value="${value:1:$((${#value} - 2))}"
    fi
    export "$key=$value"
  done <"$env_file"

  LOADED_DEPLOY_ENV_FILE="$env_file"
}

resolve_local_path() {
  local value="$1"
  case "$value" in
    "") return 1 ;;
    /*) printf '%s' "$value" ;;
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${value#~/}" ;;
    *) printf '%s/%s' "$REPO_ROOT" "$value" ;;
  esac
}

normalize_path_env_var() {
  local key="$1"
  local value="${!key:-}"
  [[ -z "$value" ]] && return
  export "$key=$(resolve_local_path "$value")"
}

discover_fcm_service_account_file() {
  if [[ -n "${YEP_FCM_SERVICE_ACCOUNT_FILE:-}" ||
    -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ||
    -n "${YEP_FCM_SERVICE_ACCOUNT_JSON:-}" ]]; then
    return
  fi

  local candidate
  for candidate in "$REPO_ROOT/firebase-service-account.json" "$REPO_ROOT"/firebase-service-account*.json; do
    [[ -f "$candidate" ]] || continue
    export YEP_FCM_SERVICE_ACCOUNT_FILE="$candidate"
    DISCOVERED_FCM_SERVICE_ACCOUNT_FILE="$candidate"
    return
  done
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# *//'
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

Native push deploy config:
  YEP_DEPLOY_ENV_FILE              Env file to load (default: .env.deploy.local)
  YEP_ANDROID_GOOGLE_SERVICES_JSON Source path copied to Android app google-services.json
  YEP_FCM_SERVICE_ACCOUNT_FILE     Firebase service account JSON path for server FCM
  YEP_FCM_SERVICE_ACCOUNT_JSON     Raw Firebase service account JSON for server FCM
  GOOGLE_APPLICATION_CREDENTIALS   Fallback Firebase service account JSON path
  YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT=false
                                    Disable automatic server LaunchAgent FCM env sync
  YEP_REQUIRE_NATIVE_PUSH=true     Fail deploy when native push prerequisites are missing
EOF
}

load_deploy_env_file
normalize_path_env_var "YEP_ANDROID_GOOGLE_SERVICES_JSON"
normalize_path_env_var "YEP_ANDROID_GOOGLE_SERVICES_TARGET"
normalize_path_env_var "YEP_FCM_SERVICE_ACCOUNT_FILE"
normalize_path_env_var "GOOGLE_APPLICATION_CREDENTIALS"
discover_fcm_service_account_file

DO_SERVER=true
DO_CODEX_BRIDGE=false
DO_APK=true
RUN_CHECKS=true
SERVER_ARGS=()
APK_ARGS=()
ANDROID_GOOGLE_SERVICES_TARGET="${YEP_ANDROID_GOOGLE_SERVICES_TARGET:-$REPO_ROOT/packages/mobile/src-tauri/gen/android/app/google-services.json}"
ANDROID_GOOGLE_SERVICES_SOURCE="${YEP_ANDROID_GOOGLE_SERVICES_JSON:-$REPO_ROOT/google-services.json}"
REQUIRE_NATIVE_PUSH="${YEP_REQUIRE_NATIVE_PUSH:-false}"
SYNC_NATIVE_PUSH_LAUNCHAGENT="${YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT:-true}"
NEED_SERVER_LAUNCHAGENT_SYNC=false

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

shell_quote() {
  printf '%q' "$1"
}

server_args_contain() {
  local needle="$1"
  local arg
  for arg in "${SERVER_ARGS[@]-}"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

apk_args_contain() {
  local needle="$1"
  local arg
  for arg in "${APK_ARGS[@]-}"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

server_deploy_restarts() {
  $DO_SERVER || return 1
  ! server_args_contain "--no-restart"
}

apk_builds() {
  $DO_APK || return 1
  ! apk_args_contain "--no-build"
}

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

sync_android_google_services() {
  if ! apk_builds; then
    return 0
  fi

  if [[ -n "${YEP_ANDROID_GOOGLE_SERVICES_JSON:-}" && ! -f "$ANDROID_GOOGLE_SERVICES_SOURCE" ]]; then
    err "YEP_ANDROID_GOOGLE_SERVICES_JSON was set, but the file does not exist: $ANDROID_GOOGLE_SERVICES_SOURCE"
    exit 1
  fi

  if [[ ! -f "$ANDROID_GOOGLE_SERVICES_SOURCE" ]]; then
    return
  fi
  if [[ "$ANDROID_GOOGLE_SERVICES_SOURCE" == "$ANDROID_GOOGLE_SERVICES_TARGET" ]]; then
    return
  fi

  mkdir -p "$(dirname "$ANDROID_GOOGLE_SERVICES_TARGET")"
  if [[ ! -f "$ANDROID_GOOGLE_SERVICES_TARGET" ]] ||
    ! cmp -s "$ANDROID_GOOGLE_SERVICES_SOURCE" "$ANDROID_GOOGLE_SERVICES_TARGET"; then
    cp "$ANDROID_GOOGLE_SERVICES_SOURCE" "$ANDROID_GOOGLE_SERVICES_TARGET"
    dim "native push APK config: copied $(shell_quote "$ANDROID_GOOGLE_SERVICES_SOURCE") -> $(shell_quote "$ANDROID_GOOGLE_SERVICES_TARGET")"
  fi
}

check_native_push_preflight() {
  local missing=0

  if apk_builds; then
    if [[ -f "$ANDROID_GOOGLE_SERVICES_TARGET" ]]; then
      dim "native push APK config: $ANDROID_GOOGLE_SERVICES_TARGET"
    else
      warn "native push APK config is missing: $ANDROID_GOOGLE_SERVICES_TARGET"
      warn "APK build can continue, but Android native push token registration will be unavailable."
      missing=1
    fi
  elif $DO_APK; then
    dim "native push APK config: skipped because APK build is disabled by --no-build"
  fi

  if $DO_SERVER; then
    local fcm_file="${YEP_FCM_SERVICE_ACCOUNT_FILE:-${GOOGLE_APPLICATION_CREDENTIALS:-}}"
    local fcm_json="${YEP_FCM_SERVICE_ACCOUNT_JSON:-}"
    local shell_has_fcm=false

    if [[ -n "$fcm_file" ]]; then
      if [[ ! -f "$fcm_file" ]]; then
        err "FCM service account file does not exist: $fcm_file"
        exit 1
      fi
      shell_has_fcm=true
    elif [[ -n "$fcm_json" ]]; then
      shell_has_fcm=true
    fi

    local server_label="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"
    local launchd_loaded=false
    local launchd_has_fcm=false
    local launchd_has_current_fcm=false

    if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
      local user_domain="gui/$(id -u)"
      local launchd_state
      launchd_state="$(launchctl print "$user_domain/$server_label" 2>/dev/null || true)"
      if [[ -n "$launchd_state" ]]; then
        launchd_loaded=true
        case "$launchd_state" in
          *YEP_FCM_SERVICE_ACCOUNT_FILE*|*YEP_FCM_SERVICE_ACCOUNT_JSON*|*GOOGLE_APPLICATION_CREDENTIALS*)
            launchd_has_fcm=true
            ;;
        esac
        if [[ -n "$fcm_file" && "$launchd_state" == *"$fcm_file"* ]]; then
          launchd_has_current_fcm=true
        elif [[ -n "$fcm_json" && "$launchd_state" == *YEP_FCM_SERVICE_ACCOUNT_JSON* ]]; then
          launchd_has_current_fcm=true
        elif ! $shell_has_fcm && $launchd_has_fcm; then
          launchd_has_current_fcm=true
        fi
      fi
    fi

    if $launchd_loaded; then
      if $launchd_has_current_fcm; then
        dim "native push server config: LaunchAgent $server_label has FCM credentials"
      elif $shell_has_fcm && server_deploy_restarts && is_truthy "$SYNC_NATIVE_PUSH_LAUNCHAGENT"; then
        NEED_SERVER_LAUNCHAGENT_SYNC=true
        if $launchd_has_fcm; then
          dim "native push server config: LaunchAgent $server_label will be refreshed before server restart"
        else
          dim "native push server config: LaunchAgent $server_label will be updated before server restart"
        fi
      else
        warn "native push server config is missing from loaded LaunchAgent $server_label."
        warn "Redeploy uses the LaunchAgent environment, so current shell FCM variables will not affect the restarted server."
        missing=1
        if [[ -n "$fcm_file" ]]; then
          if ! server_deploy_restarts; then
            dim "server deploy is build-only, so LaunchAgent env was not auto-synced"
          elif ! is_truthy "$SYNC_NATIVE_PUSH_LAUNCHAGENT"; then
            dim "YEP_SYNC_NATIVE_PUSH_LAUNCHAGENT is disabled"
          else
            dim "persist it with: YEP_FCM_SERVICE_ACCOUNT_FILE=$(shell_quote "$fcm_file") scripts/install-launchagents.sh --server-only"
          fi
        else
          dim "persist it with: YEP_FCM_SERVICE_ACCOUNT_FILE=/path/to/firebase-service-account.json scripts/install-launchagents.sh --server-only"
        fi
      fi
    elif $shell_has_fcm; then
      dim "native push server config: FCM credentials supplied in current environment"
    else
      warn "native push server config is missing from the current environment."
      warn "Native Android devices can subscribe locally, but server-side FCM delivery will fail until credentials are configured."
      missing=1
      dim "set one of: YEP_FCM_SERVICE_ACCOUNT_FILE, YEP_FCM_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS"
    fi
  fi

  if [[ "$missing" -ne 0 ]]; then
    dim "set YEP_REQUIRE_NATIVE_PUSH=true to make deploy fail fast when native push prerequisites are missing"
    if is_truthy "$REQUIRE_NATIVE_PUSH"; then
      err "Native push prerequisites are missing and YEP_REQUIRE_NATIVE_PUSH=true."
      exit 1
    fi
  fi
}

ensure_server_bundle_for_launchagent_sync() {
  local cli_js="$REPO_ROOT/dist/npm-package/dist/cli.js"

  if server_args_contain "--restart"; then
    [[ -f "$cli_js" ]] && return
    err "Cannot sync the server LaunchAgent before restart because $cli_js is missing."
    err "Run a non-restart-only server deploy once so the bundle can be built."
    exit 1
  fi

  log "Building server bundle before LaunchAgent env sync ..."
  scripts/redeploy-server.sh --no-restart
  SERVER_ARGS+=("--restart")
}

sync_server_launchagent_env_if_needed() {
  if ! $NEED_SERVER_LAUNCHAGENT_SYNC; then
    return 0
  fi
  ensure_server_bundle_for_launchagent_sync

  log "Syncing native push env into the 8022 server LaunchAgent ..."
  dim "4510 Codex bridge is not touched"
  scripts/install-launchagents.sh --server-only
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
if [[ -n "$LOADED_DEPLOY_ENV_FILE" ]]; then
  dim "deploy env:        $LOADED_DEPLOY_ENV_FILE"
fi
if [[ -n "$DISCOVERED_FCM_SERVICE_ACCOUNT_FILE" ]]; then
  dim "server FCM:        auto-detected $DISCOVERED_FCM_SERVICE_ACCOUNT_FILE"
fi

log "Checking native push deploy prerequisites ..."
sync_android_google_services
check_native_push_preflight

if $RUN_CHECKS && { $DO_SERVER || $DO_CODEX_BRIDGE; }; then
  log "Running preflight checks ..."
  pnpm lint
  pnpm typecheck
fi

sync_server_launchagent_env_if_needed

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
