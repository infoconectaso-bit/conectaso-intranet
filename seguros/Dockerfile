# Conecta Seguros: app independiente (otro contenedor, otro puerto, otros datos).
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY semilla ./semilla
ENV DATA_DIR=/data
ENV PORT=8081
VOLUME ["/data"]
EXPOSE 8081
CMD ["node", "server.js"]
