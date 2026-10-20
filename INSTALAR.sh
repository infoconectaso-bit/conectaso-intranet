#!/usr/bin/env bash
# Instalador de la intranet de Conecta So (servidor de pruebas).
# CORREO DESACTIVADO por seguridad: no se envía ningún email a nadie.
set -e
echo ">> Actualizando sistema e instalando Docker..."
apt-get update -y && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null || true
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
echo ">> Preparando la aplicación..."
cd "$(dirname "$0")"
# fuerza correo desactivado pase lo que pase
grep -q '^MAIL_DISABLED=' .env 2>/dev/null || echo 'MAIL_DISABLED=true' >> .env
sed -i 's/^MAIL_DISABLED=.*/MAIL_DISABLED=true/' .env
echo ">> Arrancando (puerto 80)..."
docker compose up -d --build
echo ""
echo "================================================================"
echo "  LISTO. Abre en el navegador:  http://TU_IP_PUBLICA"
echo "  El correo está DESACTIVADO (no se envia nada a clientes)."
echo "  Crear admin:   docker compose exec app npm run create-admin"
echo "================================================================"
