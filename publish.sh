#!/usr/bin/env bash
# push songs analysed on this mac to the view-only server (see README "Publish ke server")
set -e
cd "$(dirname "$0")"
[ -f publish.env ] && { set -a; . ./publish.env; set +a; }
exec .venv/bin/python backend/publish.py "$@"
