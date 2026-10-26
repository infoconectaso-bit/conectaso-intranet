#!/usr/bin/env bash
# ============================================================================
#  RESTAURACIÓN RÁPIDA (recuperación ante desastre)
#  Se ejecuta en un SERVIDOR NUEVO, NO desde dentro de la intranet.
#  Descarga la última copia de seguridad desde Backblaze y arranca la intranet.
#  Antes: rellena el archivo  .env.restore  con tus claves de Backblaze (ver RESTAURAR.md).
# ============================================================================
set -e
cd "$(dirname "$0")"

if [ ! -f .env.restore ]; then
  echo "❌ Falta el archivo .env.restore con las claves de Backblaze."
  echo "   Copia .env.restore.example a .env.restore y rellénalo. Mira RESTAURAR.md."
  exit 1
fi
set -a; . ./.env.restore; set +a

echo ">> 1/2 Descargando la última copia de seguridad desde Backblaze…"
node --no-warnings=ExperimentalWarning scripts/restaurar.js

echo ">> 2/2 Arrancando la intranet…"
bash ACTUALIZAR.sh

echo ""
echo "================================================================"
echo "  RESTAURADO. La intranet está levantada con la última copia."
echo "  Último paso: apunta el dominio (o Caddy) a este servidor."
echo "================================================================"
