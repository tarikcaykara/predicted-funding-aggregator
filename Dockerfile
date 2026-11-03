FROM oven/bun:1.4.4-debian
ENV NODE_ENV=production \
    DATA_FILE=/app/data/funding_rate.json \
    HISTORY_FILE=/app/data/history.sqlite
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
# Code stays root-owned; the non-root `bun` user can write only the data directory.
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "start"]
