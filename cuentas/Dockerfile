# Cuentas: app independiente (otro contenedor, otro puerto, otros datos). Sin dependencias npm.
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data
ENV PORT=8083
VOLUME ["/data"]
EXPOSE 8083
CMD ["node", "server.js"]
