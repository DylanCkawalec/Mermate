#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="/Users/dylanckawalec/Desktop/developer/mermaid/nemoclaw"
MERMATE_DIR="/Users/dylanckawalec/Desktop/developer/mermaid"
MERMATE_ENV="${MERMATE_DIR}/.env"
DUCKDB_BINDING="${MERMATE_DIR}/node_modules/duckdb/lib/binding/duckdb.node"
LOG_DIR="${ROOT_DIR}/logs"
CONSOLE_URL="http://127.0.0.1:8787"
MERMATE_URL="http://127.0.0.1:3333"
CONSOLE_HEALTH_URL="${CONSOLE_URL}/api/status"
MERMATE_HEALTH_URL="${MERMATE_URL}/api/copilot/health"
MERMATE_OPENCLAW_STATUS_URL="${MERMATE_URL}/api/openclaw/status"
PROJECT_MCP_PATH="${ROOT_DIR}/.mcp.json"
ALLOW_DEGRADED_MERMATE="${OPENCLAW_ALLOW_DEGRADED_MERMATE:-0}"

mkdir -p "${LOG_DIR}"

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts=0

  while [ "${attempts}" -lt 60 ]; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  echo "Timed out waiting for ${label} at ${url}" >&2
  return 1
}

wait_for_http_or_exit() {
  local url="$1"
  local label="$2"
  local pid="$3"
  local logfile="$4"
  local attempts=0

  while [ "${attempts}" -lt 60 ]; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi

    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      echo "${label} exited before becoming ready. Check ${logfile}" >&2
      return 1
    fi

    attempts=$((attempts + 1))
    sleep 1
  done

  echo "Timed out waiting for ${label} at ${url}. Check ${logfile}" >&2
  return 1
}

stop_listener() {
  local port="$1"
  local label="$2"
  local pids=()
  local pid

  while IFS= read -r pid; do
    [ -n "${pid}" ] && pids+=("${pid}")
  done < <(lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)

  if [ "${#pids[@]}" -eq 0 ]; then
    return 0
  fi

  echo "Stopping stale ${label} listener on port ${port} (PID(s): ${pids[*]})..."
  kill "${pids[@]}" 2>/dev/null || true

  for _ in {1..10}; do
    if ! lsof -nP -tiTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Force stopping stale ${label} listener on port ${port}..."
  kill -9 "${pids[@]}" 2>/dev/null || true
}

open_app_window() {
  local url="$1"

  for app in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge"; do
    if [ -d "/Applications/${app}.app" ]; then
      open -na "${app}" --args --app="${url}" >/dev/null 2>&1
      return 0
    fi
  done

  open "${url}"
}

ensure_dependencies() {
  local repo_dir="$1"
  local label="$2"

  if [ -d "${repo_dir}/node_modules" ]; then
    return 0
  fi

  echo "Installing dependencies for ${label}..."
  (
    cd "${repo_dir}"
    npm install
  )
}

ensure_console() {
  if curl -fsS "${CONSOLE_HEALTH_URL}" >/dev/null 2>&1; then
    if curl -fsS "${CONSOLE_HEALTH_URL}" | grep -F "\"projectMcpPath\":\"${PROJECT_MCP_PATH}\"" >/dev/null 2>&1; then
      echo "OpenClaw console already running."
      return 0
    fi

    echo "Detected stale OpenClaw console instance that is not serving ${PROJECT_MCP_PATH}."
    stop_listener 8787 "OpenClaw console"
  fi

  ensure_dependencies "${ROOT_DIR}" "OpenClaw console"

  echo "Building OpenClaw console..."
  (
    cd "${ROOT_DIR}"
    npm run build > "${LOG_DIR}/console-build.log" 2>&1
  )

  echo "Starting OpenClaw console..."
  (
    cd "${ROOT_DIR}"
    nohup npm run start:server > "${LOG_DIR}/console-server.log" 2>&1 &
  )

  wait_for_http "${CONSOLE_HEALTH_URL}" "OpenClaw console"
}

ensure_mermate() {
  if curl -fsS "${MERMATE_HEALTH_URL}" >/dev/null 2>&1; then
    if curl -fsS "${MERMATE_OPENCLAW_STATUS_URL}" >/dev/null 2>&1; then
      echo "Mermate already running."
      return 0
    fi

    echo "Detected stale Mermate instance without the OpenClaw bridge route."
    stop_listener 3333 "Mermate"
  fi

  if [ ! -d "${MERMATE_DIR}" ]; then
    echo "Mermate repo not found at ${MERMATE_DIR}" >&2
    return 1
  fi

  if [ ! -f "${MERMATE_ENV}" ]; then
    echo "Mermate env not found at ${MERMATE_ENV}" >&2
    return 1
  fi

  ensure_dependencies "${MERMATE_DIR}" "Mermate"

  if [ ! -f "${DUCKDB_BINDING}" ]; then
    echo "DuckDB native binding missing. Rebuilding Mermate DuckDB..."
    (
      cd "${MERMATE_DIR}"
      npm rebuild duckdb > "${LOG_DIR}/mermate-duckdb-rebuild.log" 2>&1
    ) || {
      echo "DuckDB rebuild failed. Check ${LOG_DIR}/mermate-duckdb-rebuild.log" >&2
      return 1
    }
  fi

  echo "Starting Mermate..."
  local mermate_pid
  (
    cd "${MERMATE_DIR}"
    export OPENCLAW_ARCHITECT_ENV_PATH="${MERMATE_ENV}"
    nohup ./mermaid.sh start > "${LOG_DIR}/mermate.log" 2>&1 &
    echo $! > "${LOG_DIR}/mermate.pid"
  )
  mermate_pid="$(cat "${LOG_DIR}/mermate.pid")"

  wait_for_http_or_exit "${MERMATE_HEALTH_URL}" "Mermate" "${mermate_pid}" "${LOG_DIR}/mermate.log"
}

ensure_console
if ! ensure_mermate; then
  if [ "${ALLOW_DEGRADED_MERMATE}" = "1" ]; then
    echo "Continuing with OpenClaw console only because OPENCLAW_ALLOW_DEGRADED_MERMATE=1"
  else
    echo "Mermate failed to start. Set OPENCLAW_ALLOW_DEGRADED_MERMATE=1 to force a console-only launch." >&2
    exit 1
  fi
fi

open_app_window "${CONSOLE_URL}"

echo "OpenClaw console ready at ${CONSOLE_URL}"
echo "Mermate target: ${MERMATE_URL}"
