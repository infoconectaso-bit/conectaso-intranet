#!/usr/bin/env bash
# Actualiza la intranet con el código nuevo SIN perder datos (la base de datos y los archivos subidos persisten).
set -e
cd "$(dirname "$0")"
chmod -R 777 data 2>/dev/null || true
echo ">> Reconstruyendo y reiniciando..."
docker compose up -d --build
# Si cambió la configuración del proxy (Caddyfile), recrea Caddy para que la lea (los certificados se conservan).
HASH=$(sha256sum caddy/Caddyfile | cut -d' ' -f1)
if [ "$(cat .caddy-hash 2>/dev/null)" != "$HASH" ]; then
  docker compose up -d --no-deps --force-recreate caddy && echo "$HASH" > .caddy-hash
fi
echo ""
echo "================================================"
echo "  ACTUALIZADO. Abre: http://200.234.226.246"
echo "  (Tus datos y archivos se han conservado.)"
echo "================================================"
