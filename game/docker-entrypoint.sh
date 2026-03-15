#!/bin/sh
set -e

# Ensure data directories exist
mkdir -p "${GAME_DATA_DIR}/packs" "${GAME_DATA_DIR}/channels"

# Start game server in background
game-server \
  -port "${GAME_PORT}" \
  -data-dir "${GAME_DATA_DIR}" \
  ${GAME_DEFAULT_PACK:+-pack "$GAME_DEFAULT_PACK"} &

# Start nginx in foreground (template substitution is handled by
# the nginx:alpine image's own entrypoint via /etc/nginx/templates/)
exec nginx -g "daemon off;"
