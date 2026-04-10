# --- Bun production image for Toptier AI OCR ---
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

FROM oven/bun:1.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY Toptier-AI-OCR-v2.html ./
COPY logo.png ./
COPY package.json ./
COPY tsconfig.json ./

# uploads dir is mounted as a volume in compose
RUN mkdir -p uploads

EXPOSE 3737
CMD ["bun", "run", "src/index.ts"]
