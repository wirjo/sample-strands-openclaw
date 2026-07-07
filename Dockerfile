# ============================================================
# Stage 1: Builder — install dependencies
# ============================================================
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl git && \
    rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally (provides gateway + SDK)
RUN npm install -g openclaw

# App dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --production || true
COPY . .

# Build TypeScript
RUN npx tsc || true

# ============================================================
# Stage 2: Runtime — minimal image
# ============================================================
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq && \
    rm -rf /var/lib/apt/lists/*

# Copy OpenClaw from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/openclaw/openclaw.mjs /usr/local/bin/openclaw

# Copy app
WORKDIR /app
COPY --from=builder /app /app

# Pre-create OpenClaw workspace
RUN mkdir -p /root/.openclaw

# Copy entrypoint
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# AgentCore Runtime requires port 8080
EXPOSE 8080

ENTRYPOINT ["/app/start.sh"]
