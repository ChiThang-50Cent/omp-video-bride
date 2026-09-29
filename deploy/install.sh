#!/bin/sh
# Installs the v2 unit in place of v1. Needs root. Running jobs of v1 must be finished first.
# Usage: sudo sh deploy/install.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ -f /home/thangnc/.config/omp-video-bridge/config.json ] || { echo "create ~/.config/omp-video-bridge/config.json first (see deploy/config.example.json)"; exit 1; }
install -m 644 "$here/omp-video-bridge.service" /etc/systemd/system/omp-video-bridge.service
systemctl daemon-reload
systemctl restart omp-video-bridge
systemctl status omp-video-bridge --no-pager | head -8
