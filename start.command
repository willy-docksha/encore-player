#!/bin/bash
# Klik dua kali untuk menjalankan Encore Player di http://localhost:8765
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:8765" ) &
python3 server.py 8765
