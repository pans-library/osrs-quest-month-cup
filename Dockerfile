FROM node:26-alpine

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY server.js ./
COPY public ./public
COPY seed ./seed

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
