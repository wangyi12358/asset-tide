# syntax=docker/dockerfile:1
FROM postgres:15-bookworm AS pgtools
# Reuse official PostgreSQL clients and their shared libraries, without apt downloads.
RUN mkdir -p /pg-client/bin /pg-client/lib \
    && cp /usr/lib/postgresql/15/bin/pg_dump /usr/lib/postgresql/15/bin/pg_restore /pg-client/bin/ \
    && ldd /usr/lib/postgresql/15/bin/pg_dump | awk '/=> \// {print $3}' | xargs -I '{}' cp '{}' /pg-client/lib/ \
    && rm -f /pg-client/lib/libc.so.* /pg-client/lib/libm.so.* /pg-client/lib/libpthread.so.* /pg-client/lib/libdl.so.* /pg-client/lib/librt.so.*

FROM node:22-bookworm AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,id=atlas-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN ENABLE_SCHEDULER=false pnpm build

# One-shot initialization image: Prisma deploy migrations and idempotent seed.
FROM build AS migrate
CMD ["pnpm", "db:setup"]

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 BACKUP_PATH=/app/backups
COPY --from=build /etc/ssl/certs /etc/ssl/certs
COPY --from=pgtools /pg-client /opt/pg-client
RUN printf '#!/bin/sh\nLD_LIBRARY_PATH=/opt/pg-client/lib exec /opt/pg-client/bin/pg_dump "$@"\n' > /usr/local/bin/pg_dump \
    && printf '#!/bin/sh\nLD_LIBRARY_PATH=/opt/pg-client/lib exec /opt/pg-client/bin/pg_restore "$@"\n' > /usr/local/bin/pg_restore \
    && chmod +x /usr/local/bin/pg_dump /usr/local/bin/pg_restore
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node scripts/docker-entrypoint.mjs ./docker-entrypoint.mjs
RUN mkdir -p /app/backups && chown -R node:node /app/backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "docker-entrypoint.mjs"]
