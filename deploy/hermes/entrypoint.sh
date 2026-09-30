#!/bin/sh
set -eu

# Docker secrets remain outside the image and are read only at process startup.
if [ -f /run/secrets/webhook-secret ]; then
  WEBHOOK_SECRET="$(cat /run/secrets/webhook-secret)"
  export WEBHOOK_SECRET
fi
if [ -f /run/secrets/bridge-token ]; then
  OMP_BRIDGE_TOKEN="$(cat /run/secrets/bridge-token)"
  export OMP_BRIDGE_TOKEN
fi
HERMES_HOME="${HERMES_HOME:-/opt/data}"
mkdir -p "$HERMES_HOME" "$HERMES_HOME/backups" "$HERMES_HOME/cron" "$HERMES_HOME/sessions" \
  "$HERMES_HOME/logs" "$HERMES_HOME/memories" "$HERMES_HOME/skills" "$HERMES_HOME/skins" \
  "$HERMES_HOME/plans" "$HERMES_HOME/workspace" "$HERMES_HOME/home" "$HERMES_HOME/pairing" \
  "$HERMES_HOME/platforms/pairing"

# Seed examples only on first boot; operator-provided state and secrets win.
if [ ! -f "$HERMES_HOME/.env" ] && [ -f /opt/hermes/.env.example ]; then
  cp /opt/hermes/.env.example "$HERMES_HOME/.env"
fi
if [ ! -f "$HERMES_HOME/config.yaml" ] && [ -f /opt/hermes/cli-config.yaml.example ]; then
  cp /opt/hermes/cli-config.yaml.example "$HERMES_HOME/config.yaml"
fi
if [ ! -f "$HERMES_HOME/SOUL.md" ] && [ -f /opt/hermes/docker/SOUL.md ]; then
  cp /opt/hermes/docker/SOUL.md "$HERMES_HOME/SOUL.md"
fi

# Generate a local API key only in writable external state, never print or replace it.
if [ -z "${API_SERVER_KEY:-}" ] && ! grep -q '^API_SERVER_KEY=' "$HERMES_HOME/.env" 2>/dev/null; then
  key="$(/opt/hermes/.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
  printf '\nAPI_SERVER_KEY=%s\n' "$key" >> "$HERMES_HOME/.env"
fi

if [ "$#" -eq 0 ]; then set -- hermes; fi
case "$1" in
  hermes|gateway|chat|model|config|doctor|setup|tools|skills|dump|update|--*)
    exec /opt/hermes/.venv/bin/hermes "$@" ;;
  *) exec "$@" ;;
esac
