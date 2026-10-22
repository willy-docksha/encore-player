#!/bin/bash
# klik dua kali untuk menjalankan Encore App dari source (butuh uv, lihat README "Encore App")
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c "import fastapi, demucs" 2>/dev/null; then
  echo "Menyiapkan Python (sekali saja, butuh beberapa menit)…"
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python -r backend/requirements.txt
  uv pip install --python .venv/bin/python --no-deps basic-pitch
fi
exec .venv/bin/python backend/main.py
