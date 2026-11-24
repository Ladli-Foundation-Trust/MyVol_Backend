# api.myvol.org — production image.
#   docker build -t myvol-api .
#   docker run -p 3000:3000 --env-file .env -v myvol-uploads:/data/uploads myvol-api
#
# Debian slim, not Alpine: the ffmpeg/ffprobe binaries from ffmpeg-static and
# @ffprobe-installer are built for glibc. Migrations run on every start
# (`prisma migrate deploy` is idempotent), so the prisma CLI (a devDependency)
# stays in the image.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# prisma.config.js reads DATABASE_URL even for `prisma generate`; any value
# works at build time, the real one comes from the runtime env.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/uploads && chown -R node:node /data
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
COPY --from=deps --chown=node:node /app/src/generated ./src/generated
USER node
VOLUME ["/data/uploads"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD wget -qO- http://127.0.0.1:3000/health/ready >/dev/null || exit 1
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
