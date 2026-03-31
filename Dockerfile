# Mermate — Mermaid-GPT Architecture Pipeline
# Idea -> Diagram -> TLA+ -> TypeScript -> Bundle
#
# Build:  docker build -t mermate:v5 .
# Run:    docker run -p 3333:3333 --env-file .env mermate:v5

FROM node:22-slim AS builder

WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        # Java for TLA+ (SANY + TLC)
        default-jre-headless \
        # Chromium + deps for mmdc (Mermaid CLI / Puppeteer)
        chromium \
        fonts-liberation \
        libgbm1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libdrm2 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r mermate && useradd -r -g mermate -d /app -s /usr/sbin/nologin mermate

WORKDIR /app

COPY --from=builder /build/node_modules/ ./node_modules/
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
COPY .cursor/assets/ ./.cursor/assets/

# TLA+ toolchain
COPY vendor/ ./vendor/

RUN mkdir -p flows runs && chown -R mermate:mermate /app

USER mermate

ENV NODE_ENV=production
ENV PORT=3333
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV OPSEEQ_URL=http://host.docker.internal:9090

EXPOSE 3333

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=8s \
    CMD curl -f http://localhost:3333/api/copilot/health || exit 1

LABEL org.opencontainers.image.title="Mermate" \
      org.opencontainers.image.description="Mermaid-GPT: Idea to Architecture to TLA+ to TypeScript" \
      org.opencontainers.image.version="5.0.0" \
      org.opencontainers.image.source="https://github.com/DylanCkawalec/mermaid"

CMD ["node", "server/index.js"]
