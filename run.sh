#!/usr/bin/env bash
# start encore with bass analysis on http://localhost:8765
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
if [ ! -x .venv/bin/uvicorn ]; then
  echo "Menyiapkan Python (sekali saja, butuh beberapa menit)…"
  uv venv --python 3.14 .venv
  if [ "${ENCORE_ANALYSIS:-on}" = "off" ]; then
    # view-only server: small install, no ai models
    uv pip install --python .venv/bin/python -r requirements-server.txt
  else
    uv pip install --python .venv/bin/python -r requirements.txt
    # basic-pitch pins tensorflow on macos; we only use its onnx model
    uv pip install --python .venv/bin/python --no-deps basic-pitch
  fi
fi
# ENCORE_MODE=server (link youtube ditolak, hanya upload & google drive) · HOST=0.0.0.0 agar bisa diakses dari luar
export ENCORE_MODE="${ENCORE_MODE:-local}"
echo "Encore (${ENCORE_MODE}) jalan di http://localhost:${PORT:-8765}  (tutup jendela ini untuk berhenti)"
exec "$ROOT/.venv/bin/uvicorn" --app-dir "$ROOT/backend" app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8765}" --log-level warning
