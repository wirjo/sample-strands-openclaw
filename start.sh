#!/bin/bash
# start.sh — run OpenClaw gateway in background, then start Strands handler
set -euo pipefail

# Start OpenClaw gateway in background
openclaw gateway start &
OPENCLAW_PID=$!

# Wait for gateway to be healthy
echo "Waiting for OpenClaw gateway..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:18789/health > /dev/null 2>&1; then
    echo "OpenClaw gateway ready (took ${i}s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: OpenClaw gateway failed to start within 30s"
    exit 1
  fi
  sleep 1
done

# Start the Strands AgentCore handler (foreground)
exec node dist/index.js
