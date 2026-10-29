# Gestor de eventos de Conecta So
# Imagen ligera: Node 22 trae SQLite integrado, así que no hacen falta dependencias nativas.
FROM node:22-alpine

# Chromium (headless) para generar el PDF de la hoja de ruta. Se usa por CLI, sin dependencias npm.
# Las fuentes (incl. emojis Noto) hacen que el texto y los iconos salgan bien en el PDF.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto font-noto-emoji

WORKDIR /app
# Copiamos primero el manifiesto (capa cacheable). No hay dependencias externas que instalar.
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public

# Los datos (base de datos + archivos subidos) viven en un volumen persistente.
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

# El usuario 'node' ya existe en la imagen; evitamos ejecutar como root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
