FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates awscli \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw
RUN npm install -g openclaw

# Install app dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || true
COPY . .

# Build TypeScript
RUN npx tsc || true

# Pre-configure OpenClaw for Bedrock (IAM role via IMDS)
ENV OPENCLAW_PROVIDER=amazon-bedrock

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080
CMD ["/app/start.sh"]
