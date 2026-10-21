#!/usr/bin/env bash
# ============================================================================
#  Despliegue automático de la intranet.
#  Comprueba si hay una versión nueva en GitHub y, si la hay, actualiza sola
#  (git pull + ACTUALIZAR.sh). No hace nada si ya está al día.
#
#  Pensado para ejecutarse cada pocos minutos desde cron. Deja un registro de
#  lo que hace en  auto-deploy.log  (dentro de la carpeta del proyecto).
#
#  Activarlo (UNA sola vez, en el servidor):
#    (crontab -l 2>/dev/null; echo "*/2 * * * * /bin/bash $HOME/conectaso-intranet/scripts/auto-deploy.sh >/dev/null 2>&1") | crontab -
#
#  Desactivarlo:  crontab -e   y borra esa línea.
# ============================================================================
set -e
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$(dirname "$0")/.."
LOG="auto-deploy.log"
BRANCH="main"

# Evita que se solapen dos ejecuciones (si una actualización tarda).
exec 9>.auto-deploy.lock
flock -n 9 || exit 0

git fetch --quiet origin "$BRANCH" 2>>"$LOG" || { echo "$(date '+%F %T')  fetch falló (¿sin conexión?)" >>"$LOG"; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0   # ya está al día

echo "$(date '+%F %T')  Nueva versión detectada ($REMOTE). Actualizando..." >>"$LOG"
git pull --quiet origin "$BRANCH" >>"$LOG" 2>&1
bash ACTUALIZAR.sh >>"$LOG" 2>&1
echo "$(date '+%F %T')  Actualizado correctamente a $REMOTE" >>"$LOG"
