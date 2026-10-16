#!/bin/bash
# klik dua kali untuk menjalankan Encore di http://localhost:8765 (butuh node)
cd "$(dirname "$0")"
( sleep 2; open "http://localhost:8765" ) &
node dev.mjs
