#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$ROOT_DIR/ui"

HOST="${HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-7001}"
UI_PORT="${UI_PORT:-7000}"
BIN_PATH="${BIN_PATH:-/tmp/mock-ue-server}"
LOG_DIR="${LOG_DIR:-/tmp/mock-ue-demo}"
GO_CACHE="${GOCACHE:-/tmp/mock-ue-go-build}"
GO_MOD_CACHE="${GOMODCACHE:-/tmp/mock-ue-go-mod}"

mkdir -p "$LOG_DIR"

kill_port() {
  local port="$1"
  local pids
  pids="$(ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u)"
  if [[ -n "$pids" ]]; then
    echo "Stopping existing listener on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

echo "Building backend -> $BIN_PATH"
(
  cd "$ROOT_DIR"
  GOCACHE="$GO_CACHE" GOMODCACHE="$GO_MOD_CACHE" go build -o "$BIN_PATH" .
)

echo "Building UI"
(
  cd "$UI_DIR"
  npm run build
)

kill_port "$UI_PORT"
kill_port "$BACKEND_PORT"

echo "Starting backend on $HOST:$BACKEND_PORT"
"$BIN_PATH" --mode control --listen "$HOST:$BACKEND_PORT" >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID="$!"

echo "Starting UI on $HOST:$UI_PORT with API proxy http://127.0.0.1:$BACKEND_PORT"
(
  cd "$UI_DIR"
  VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT" npm run dev -- --host "$HOST" --port "$UI_PORT" --strictPort
) >"$LOG_DIR/ui.log" 2>&1 &
UI_PID="$!"

echo "$BACKEND_PID" >"$LOG_DIR/backend.pid"
echo "$UI_PID" >"$LOG_DIR/ui.pid"

sleep 2

echo "Backend PID: $BACKEND_PID"
echo "UI PID:      $UI_PID"
echo "Backend:     http://127.0.0.1:$BACKEND_PORT"
echo "UI:          http://127.0.0.1:$UI_PORT"
echo "Logs:        $LOG_DIR/backend.log, $LOG_DIR/ui.log"

if ! ss -ltnp "sport = :$BACKEND_PORT" 2>/dev/null | grep -q ":$BACKEND_PORT"; then
  echo "Backend did not open port $BACKEND_PORT. See $LOG_DIR/backend.log" >&2
  exit 1
fi

if ! ss -ltnp "sport = :$UI_PORT" 2>/dev/null | grep -q ":$UI_PORT"; then
  echo "UI did not open port $UI_PORT. See $LOG_DIR/ui.log" >&2
  exit 1
fi
