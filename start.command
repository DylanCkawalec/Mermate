#!/bin/bash
#
# MERMATE Desktop Launcher
# Double-click this file to start the MERMATE server at http://localhost:3333
#

MERMATE_APP="$(cd "$(dirname "$0")" && pwd)"
SERVER_ENTRY="$MERMATE_APP/server/index.js"
AGENTS_DIR="$MERMATE_APP/agents"
PORT="${PORT:-3333}"

export MERMATE_AGENTS_DIR="$AGENTS_DIR"
# Run dumps stay on the Desktop volume (large artifacts, not repo material).
export MERMATE_DUMP_DIR="${MERMATE_DUMP_DIR:-$HOME/Desktop/MERMATE/dumps}"

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "ERROR: MERMATE app not found at $MERMATE_APP"
  echo "Expected server entry: $SERVER_ENTRY"
  echo ""
  echo "Press any key to close."
  read -n 1
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed or not in PATH."
  echo "Install Node.js >= 20: https://nodejs.org"
  echo ""
  echo "Press any key to close."
  read -n 1
  exit 1
fi

existing_pid=$(lsof -ti :"$PORT" 2>/dev/null)
if [ -n "$existing_pid" ]; then
  echo "Port $PORT is in use (pid $existing_pid). Killing it..."
  kill "$existing_pid" 2>/dev/null
  sleep 1
fi

if [ -f "$MERMATE_APP/.env" ]; then
  set -a
  source "$MERMATE_APP/.env"
  set +a
fi

echo ""
echo "  Starting MERMATE server..."
echo "  App:    $MERMATE_APP"
echo "  Agents: $AGENTS_DIR"
echo "  Dumps:  $MERMATE_DUMP_DIR"
echo "  Port:   $PORT"
echo ""

cd "$MERMATE_APP"
node "$SERVER_ENTRY"

echo ""
echo "Server stopped. Press any key to close."
read -n 1
