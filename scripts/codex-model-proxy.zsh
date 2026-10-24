#!/bin/zsh
# The private file supplies credentials only to the model relay, not Codex.
set -eu
proxy_env_file="${YEP_CODEX_PROXY_ENV_FILE:-$HOME/.codex_proxy_env}"
if [[ -r "$proxy_env_file" ]]; then
  source "$proxy_env_file"
fi
export YEP_CODEX_MODEL_PROXY_URL="${YEP_CODEX_MODEL_PROXY_URL:-${HTTPS_PROXY:-${https_proxy:-}}}"
if [[ -z "$YEP_CODEX_MODEL_PROXY_URL" ]]; then
  print -u2 -- "Set YEP_CODEX_MODEL_PROXY_URL or configure the private proxy environment file."
  exit 1
fi
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
real_codex="${YEP_CODEX_REAL_PATH:-$(whence -p codex)}"
if [[ -z "$real_codex" || ! -x "$real_codex" || "${real_codex:A}" == "${0:A}" ]]; then
  print -u2 -- "Set YEP_CODEX_REAL_PATH to the real Codex executable."
  exit 1
fi
entrypoint="${YEP_CODEX_MODEL_PROXY_ENTRYPOINT:-${0:A:h:h}/packages/server/resources/codex-model-proxy/launcher.mjs}"
exec "${YEP_CODEX_PROXY_NODE:-node}" "$entrypoint" "$real_codex" "$@"
