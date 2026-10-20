#!/usr/bin/env bash
# Actualiza la intranet con el código nuevo SIN perder datos (la base de datos y los archivos subidos persisten).
set -e
cd "$(dirname "$0")"
chmod -R 777 data 2>/dev/null || true
echo ">> Reconstruyendo y reiniciando..."
docker compose up -d --build
echo ""
echo "================================================"
echo "  ACTUALIZADO. Abre: http://200.234.226.246"
echo "  (Tus datos y archivos se han conservado.)"
echo "================================================"
