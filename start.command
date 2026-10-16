#!/bin/bash
# klik dua kali untuk menjalankan Encore (Playlist + Bedah Bass) di http://localhost:8765
cd "$(dirname "$0")"
( sleep 3; open "http://localhost:8765" ) &
./run.sh
