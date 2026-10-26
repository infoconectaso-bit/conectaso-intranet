# Restauración rápida de la intranet (si el servidor se cae)

Esta guía sirve para **levantar la intranet en un servidor nuevo** si el actual deja de funcionar
(se cae, se pierde, se corrompe…). **No se hace desde dentro de la intranet** — se hace por fuera,
en un servidor nuevo, porque si la intranet está caída no podrías usarla.

La información **no se pierde**: cada pocos minutos se guarda una copia en Backblaze (base de datos +
archivos). Esta restauración descarga la **última** copia y arranca la intranet con ella.

> Tiempo estimado: **~30-60 minutos**. Lo que más tarda es crear el servidor nuevo.

---

## Lo que necesitas a mano
1. Una cuenta donde crear un servidor (Clouding, Hetzner…).
2. Acceso a tu cuenta de **Backblaze** (para sacar una clave de lectura).
3. Acceso al **dominio** (para apuntarlo al servidor nuevo), cuando toque.

---

## Pasos

### 1. Crea un servidor nuevo
Un VPS con **Ubuntu** y **Docker** instalado (vale uno modesto: 2 núcleos / 4 GB).
Entra por SSH.

### 2. Descarga el código de la intranet
```bash
git clone https://github.com/infoconectaso-bit/conectaso-intranet
cd conectaso-intranet
```

### 3. Pon las claves de Backblaze
- En Backblaze → **App Keys** → crea una clave (con permiso de **lectura** basta) para el bucket
  `conectaso-backups`. Copia el **keyID** y la **applicationKey**.
- Crea el archivo de claves a partir del ejemplo y rellénalo:
```bash
cp .env.restore.example .env.restore
nano .env.restore      # pega keyID y applicationKey, guarda (Ctrl+O, Enter, Ctrl+X)
```

### 4. Restaura y arranca (un solo comando)
```bash
bash RESTAURAR.sh
```
Esto descarga la **última** copia (base de datos + archivos), la coloca en su sitio y **arranca la
intranet**. Verás por pantalla qué copia ha usado y su fecha.

### 5. Apunta el dominio al servidor nuevo
Cambia el DNS del dominio (registro A) a la **IP del servidor nuevo**. Caddy pondrá el HTTPS solo.
Mientras tanto, ya puedes entrar por la IP del servidor para comprobar que todo está.

---

## Comprobaciones al terminar
- Entra y revisa que están tus bodas, usuarios y archivos.
- En **Admin → Copias de seguridad**, que la copia en la nube vuelve a funcionar.
- Las copias automáticas se reanudan solas en el servidor nuevo.

## Notas
- La restauración trae los datos hasta la **última copia** (como mucho de hace unos minutos).
- Si por lo que sea el paquete de archivos no se pudiera restaurar, la **base de datos sí** queda
  restaurada (es lo más importante), y los archivos se pueden recuperar luego desde Backblaze.
- El archivo `.env.restore` con tus claves **no se sube a GitHub** (está en `.gitignore`).
