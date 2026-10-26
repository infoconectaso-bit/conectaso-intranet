# Reforma: app independiente (otro contenedor, otro puerto, otros datos).
# Lleva Tesseract (lector de texto gratuito) para leer las fotos de los tickets.
FROM node:22-bookworm-slim
# (Si la instalación fallara, la app funciona igual: solo no leería los tickets solos.)
RUN (apt-get update \
 && (apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-spa tesseract-ocr-cat \
     || apt-get install -y --no-install-recommends tesseract-ocr)) || true; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ticket.js ./
COPY public ./public
ENV DATA_DIR=/data
ENV PORT=8082
VOLUME ["/data"]
EXPOSE 8082
CMD ["node", "server.js"]
