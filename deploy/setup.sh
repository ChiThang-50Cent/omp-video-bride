#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(dirname "$here")
OMP_VIDEO_STATE_DIR=${OMP_VIDEO_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/omp-video-bridge-docker}
case "$OMP_VIDEO_STATE_DIR" in
  /*) ;;
  *) echo 'OMP_VIDEO_STATE_DIR must be absolute.' >&2; exit 1 ;;
esac
OMP_VIDEO_STATE_DIR=$(realpath -m -- "$OMP_VIDEO_STATE_DIR")
case "$OMP_VIDEO_STATE_DIR/" in
  "$repo/"*) echo 'State/assets/secrets must be outside the repository.' >&2; exit 1 ;;
esac
export OMP_VIDEO_STATE_DIR
umask 077
mkdir -p "$OMP_VIDEO_STATE_DIR"

dc() { docker compose -f "$here/compose.yaml" "$@"; }
build() {
  dc --profile build build worker-runtime
  dc build video-worker hermes
}
initialize() {
  dc --profile bootstrap run --rm init-state
  dc run --rm init-assets
}
case "${1:-all}" in
  all) build; initialize; dc up -d --wait video-worker hermes ;;
  build) build ;;
  init) initialize ;;
  up) dc up -d --wait video-worker hermes ;;
  down) dc down ;;
  *) echo "Usage: sh $0 [all|build|init|up|down]" >&2; exit 1 ;;
esac
