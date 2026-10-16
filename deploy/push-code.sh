#!/usr/bin/env bash
# copy the app code (not data, venv or secrets) to the server: deploy/push-code.sh user@host [ssh-key]
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:?pakai: deploy/push-code.sh user@host [ssh-key.pem]}"
SSH="ssh${2:+ -i $2}"
rsync -az --delete -e "$SSH" \
  --exclude .git --exclude .venv --exclude data --exclude .claude --exclude "publish.env" \
  --exclude "*.log" --exclude __pycache__ --exclude .DS_Store --exclude .vercel \
  ./ "$TARGET:encore/"
echo "kode terkirim ke $TARGET:~/encore"
