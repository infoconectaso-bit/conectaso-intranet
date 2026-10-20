# Gestor de eventos · Conecta So

Aplicación web para gestionar bodas y eventos: fichas de evento con su música,
equipo (DJs, técnicos, planners), clientes, control horario, vacaciones,
facturación y vehículos. Rediseñada con la identidad de marca de Conecta So.

Reemplaza a la intranet antigua y añade **acceso con usuario y contraseña por
perfil**, de modo que cada persona ve solo lo que le corresponde:

| Perfil | Qué puede hacer |
|--------|-----------------|
| **Administración** | Todo: eventos, usuarios, localizaciones, horario, facturación, beneficios, vehículos, TYC. |
| **DJ / Técnico** | Sus eventos asignados (sin importes), su control horario, sus vacaciones, sus pagos y el uso de vehículos. |
| **Wedding planner** | Las bodas donde está asignado, en solo lectura. |
| **Cliente (novios)** | Su evento: rellena música, momentos, extras y sus datos, cuando administración lo habilita. |

El servidor es quien decide los permisos: aunque alguien manipule la interfaz,
no puede ver ni cambiar lo que no le corresponde.

---

## Requisitos

- **Node.js 22.13 o superior** (usa el módulo SQLite integrado; no hay
  dependencias externas que instalar), **o**
- **Docker** (recomendado si no quieres instalar Node).

---

## Puesta en marcha rápida con Docker (recomendado)

```bash
# 1. Prepara la configuración
cp .env.example .env
#    edita .env y pon APP_URL con la dirección real cuando la tengas

# 2. Arranca
docker compose up -d --build

# 3. Importa los datos reales (solo la primera vez)
docker compose exec gestor npm run import

# 4. Crea el primer administrador
docker compose exec gestor npm run create-admin tu-email@conectaso.es "Tu nombre"
#    te dará un enlace: ábrelo en el navegador para poner tu contraseña
```

La aplicación queda en **http://localhost:3000**

---

## Puesta en marcha sin Docker

```bash
# 1. Configuración
cp .env.example .env

# 2. Importa los datos reales (solo la primera vez)
npm run import

# 3. Crea el primer administrador
npm run create-admin tu-email@conectaso.es "Tu nombre"

# 4. Arranca
npm start
```

Abre **http://localhost:3000**.

Para dejarlo funcionando de forma permanente en un servidor, usa un gestor de
procesos como `pm2` (`pm2 start npm --name conectaso -- start`) o un servicio
`systemd`, y ponlo detrás de nginx/Caddy para el HTTPS y el dominio.

---

## Cómo dar acceso a la gente

1. Entra como administrador → **Usuarios**.
2. Cada usuario importado aparece como **"Sin activar"** (no tiene contraseña).
3. Pulsa **Invitar**: se genera un enlace de activación.
   - Si has configurado el correo (SMTP en `.env`), el enlace se envía por email.
   - Si no, te muestra el enlace en pantalla para que lo compartas tú.
4. La persona abre el enlace, crea su contraseña y ya puede entrar.

Para crear a alguien nuevo: **Usuarios → Crear usuario**.

---

## Los datos

- Todo vive en la carpeta **`data/`**: la base de datos (`conectaso.db`) y los
  archivos subidos a los eventos (`data/uploads/`). Haz copias de seguridad de
  esa carpeta.
- Los datos se cargan desde **`data/seed.json`**, que es la extracción de la
  intranet antigua (2.328 eventos, 1.981 usuarios, localizaciones, fichajes,
  históricos de pago, etc.), incluidos DNIs y teléfonos de los clientes.
  **Trátalo como información confidencial.**
- `npm run import` es seguro de repetir: vuelve a escribir cada registro con su
  id original. Las contraseñas ya creadas **no** se borran al reimportar.

### Actualizar los datos más adelante

Si quieres volver a volcar la intranet antigua, genera un nuevo `seed.json` con
el conversor (`conectaso-convert.py`, que te entregué aparte) y ejecútalo de
nuevo con `npm run import ruta/al/seed.json`.

---

## Comandos útiles

| Comando | Qué hace |
|---------|----------|
| `npm start` | Arranca el servidor. |
| `npm run import [archivo]` | Importa/actualiza los datos desde `seed.json`. |
| `npm run create-admin <email> [nombre]` | Crea o promueve un administrador y da un enlace de activación. |
| `npm run create-admin <email> --password <clave>` | Fija la contraseña directamente (sin enlace). |
| `npm run create-admin --invite <email>` | Genera un enlace de activación para alguien que ya existe. |

---

## Qué NO incluye (respecto a la intranet antigua)

- Los archivos que había subidos a 83 eventos (solo se migró la lista, no los ficheros).
- Las contraseñas antiguas: todo el mundo crea una nueva al activarse.

## Estructura del proyecto

```
server/      API y lógica (Node, sin dependencias externas)
  index.js       servidor HTTP y rutas de la API
  db.js          base de datos SQLite
  auth.js        contraseñas, sesiones, invitaciones
  permissions.js reglas de acceso por perfil
  mail.js        envío de correo opcional (SMTP)
public/      interfaz web (la marca Conecta So)
  index.html, assets/app*.js, assets/app.css, assets/fonts, assets/brand
scripts/     import.js, create-admin.js
data/        seed.json + base de datos y uploads (se crea al usar)
```
