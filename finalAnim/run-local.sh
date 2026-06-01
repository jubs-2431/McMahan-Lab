#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
REQ_FILE="$ROOT_DIR/requirements.txt"
STAMP_FILE="$VENV_DIR/.requirements-installed"

cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run this app."
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment in $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

if [ ! -f "$STAMP_FILE" ] || [ "$REQ_FILE" -nt "$STAMP_FILE" ]; then
  echo "Installing Python dependencies"
  python -m pip install --disable-pip-version-check -r "$REQ_FILE"
  touch "$STAMP_FILE"
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "Created .env from .env.example"
  echo "Add your OpenAI and Deepgram API keys to enable replies."
fi

PORT="${WEB_APP_PORT:-}"
if [ -z "$PORT" ] && [ -f "$ROOT_DIR/.env" ]; then
  ENV_PORT="$(grep -E '^WEB_APP_PORT=' "$ROOT_DIR/.env" | tail -n 1 | cut -d '=' -f 2- | tr -d '"' | tr -d "'")"
  if [ -n "$ENV_PORT" ]; then
    PORT="$ENV_PORT"
  fi
fi
PORT="${PORT:-8001}"

echo "Starting app at http://127.0.0.1:$PORT"

exec python "$ROOT_DIR/server.py"
