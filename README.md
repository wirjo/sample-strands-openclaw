# Sample: Invoke OpenClaw from Strands SDK on AgentCore Runtime

This sample demonstrates how to invoke [OpenClaw](https://openclaw.ai) from within a [Strands Agents SDK](https://github.com/strands-agents/harness-sdk) invocation handler, deployed on [Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/bedrock/agentcore/).

> **OpenClaw ships a built-in SDK** — `GatewayClient` from `openclaw/plugin-sdk/gateway-runtime` — so you don't need `execSync`. See [Approach 1](#approach-1-gateway-sdk-recommended--no-execsync) below.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│              AgentCore Runtime (microVM)               │
│                                                       │
│  ┌─────────────────┐       ┌───────────────────────┐ │
│  │  Strands Agent   │──────→│  OpenClaw Gateway     │ │
│  │  (invocation     │       │  (openclaw gateway)   │ │
│  │   handler)       │←──────│  localhost:18789      │ │
│  └─────────────────┘       └───────────────────────┘ │
│         ↑                           ↑                 │
│         │ AgentCore                 │ Bedrock         │
│         │ Invocation                │ (IAM role)      │
└─────────┼───────────────────────────┼─────────────────┘
          │                           │
    Client Request              Amazon Bedrock
```

Both the Strands handler and OpenClaw gateway run on the **same EC2 instance / microVM**. The Strands handler receives invocations from AgentCore and delegates to OpenClaw via its CLI or local HTTP API.

## Prerequisites

- AWS account with Bedrock model access
- Node.js 22+
- OpenClaw installed (`npm install -g openclaw`)
- OpenClaw gateway running (`openclaw gateway start`)

## Approaches

### Approach 1: Gateway SDK (Recommended — no execSync)

OpenClaw ships `GatewayClient` in the `openclaw` npm package under `openclaw/plugin-sdk/gateway-runtime`. This connects to the already-running gateway via WebSocket and calls the `agent` method directly — **no subprocess, no shell, no serialization overhead.**

```typescript
// src/index.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { randomUUID } from "node:crypto";

// Connect to the local OpenClaw gateway (same machine)
const client = new GatewayClient({
  url: `ws://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}/ws`,
  clientName: "strands-agentcore",
  clientDisplayName: "Strands AgentCore Handler",
});
client.start();

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const prompt = payload.prompt || "Hello";

      // Call the "agent" method on the gateway — runs a full agent turn
      const result = await client.request<{ reply: string }>("agent", {
        message: prompt,
        sessionKey: `agentcore-${context.requestId || "default"}`,
        idempotencyKey: randomUUID(),
        timeout: 120,
      });

      return { content: [{ text: result.reply }] };
    },
  },
});

app.run();
```

**How it works:**
- `GatewayClient` connects via WebSocket to the OpenClaw gateway
- `client.request("agent", params)` sends a JSON-RPC request to run one agent turn
- The gateway runs the full agentic loop (tools, memory, skills, MCP servers)
- Returns the response as a typed object — no parsing needed
- Session key provides context persistence across invocations

**Agent method parameters** (from `AgentParamsSchema`):

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | The prompt (required) |
| `sessionKey` | string | Persist conversation context across calls |
| `agentId` | string | Target a specific OpenClaw agent |
| `model` | string | Override the model |
| `thinking` | string | Thinking level (off/on/stream) |
| `timeout` | number | Timeout in seconds |
| `deliver` | boolean | Also deliver to a channel |
| `to` | string | Channel delivery target |
| `idempotencyKey` | string | Deduplication key |

### Approach 2: CLI Invocation (Simpler, shell-based)

If you prefer not to manage a WebSocket connection, use `openclaw agent --message` via subprocess:

```typescript
// src/index-cli.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { execSync } from "node:child_process";

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const prompt = payload.prompt || "Hello";

      const result = execSync(
        `openclaw agent --message ${JSON.stringify(prompt)} --json`,
        { encoding: "utf-8", timeout: 120_000 }
      );

      const parsed = JSON.parse(result);
      return { content: [{ text: parsed.reply || result }] };
    },
  },
});

app.run();
```

**Trade-offs vs SDK:**
- ✅ Simpler (no connection management)
- ❌ ~1-2s process spawn overhead per invocation
- ❌ Not streaming
- ❌ Shell escaping concerns with complex prompts

### Approach 3: Hybrid — Strands Agent + OpenClaw as Tool

Use the Strands SDK agent loop for orchestration, but delegate complex tasks to OpenClaw:

```typescript
// src/index-hybrid.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { Agent } from "@strands-agents/sdk";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { randomUUID } from "node:crypto";

// OpenClaw SDK client
const client = new GatewayClient({
  url: `ws://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}/ws`,
  clientName: "strands-tool",
});
client.start();

// Define OpenClaw as a Strands tool
const openclawTool = {
  name: "openclaw",
  description:
    "Invoke the OpenClaw AI agent for complex tasks requiring tools, memory, " +
    "web search, file access, or multi-step reasoning. OpenClaw has access to " +
    "MCP servers, persistent memory, and can execute code.",
  schema: {
    type: "object" as const,
    properties: {
      task: {
        type: "string" as const,
        description: "The task or question to send to OpenClaw",
      },
    },
    required: ["task"],
  },
  handler: async (input: { task: string }) => {
    const result = await client.request<{ reply: string }>("agent", {
      message: input.task,
      idempotencyKey: randomUUID(),
      timeout: 120,
    });
    return result.reply;
  },
};

// Strands agent with OpenClaw as a tool
const agent = new Agent({
  tools: [openclawTool],
  system:
    "You are a helpful assistant. For complex tasks that need web search, " +
    "file access, code execution, or persistent memory, use the openclaw tool.",
});

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const prompt = payload.prompt || "Hello";
      const result = await agent.invoke(prompt);
      return { content: [{ text: result.toString() }] };
    },
  },
});

app.run();
```

This pattern lets Strands handle simple queries directly (lower latency) while delegating complex agentic work to OpenClaw.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Ensure OpenClaw is installed and running
openclaw gateway start

# 3. Verify OpenClaw is healthy
curl http://localhost:18789/health

# 4. Run the handler
npm start
```

## Deployment on AgentCore

The Dockerfile runs both OpenClaw gateway and the Strands handler:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates awscli \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw
RUN npm install -g openclaw

# Install app dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

# Pre-configure OpenClaw for Bedrock
ENV OPENCLAW_PROVIDER=amazon-bedrock

# Start script runs both OpenClaw gateway + Strands handler
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080
CMD ["/app/start.sh"]
```

```bash
#!/bin/bash
# start.sh — run OpenClaw gateway in background, then start Strands handler
set -euo pipefail

# Start OpenClaw gateway in background
openclaw gateway start &
OPENCLAW_PID=$!

# Wait for gateway to be healthy
for i in $(seq 1 30); do
  if curl -sf http://localhost:18789/health > /dev/null 2>&1; then
    echo "OpenClaw gateway ready"
    break
  fi
  sleep 1
done

# Start the Strands AgentCore handler
exec node dist/index.js
```

## When to Use Each Approach

| Approach | Best for | Latency | Complexity |
|----------|----------|---------|-----------|
| **SDK** (Approach 1) | Production, low latency, type-safe | Minimal | Low |
| **CLI** (Approach 2) | Quick prototyping, simple setups | ~1-2s overhead | Lowest |
| **Hybrid** (Approach 3) | Mixed workloads (simple + complex) | Varies | Medium |

## Why OpenClaw?

OpenClaw brings capabilities that a bare Strands agent doesn't have out of the box:
- **Persistent memory** across invocations
- **MCP server ecosystem** (GitHub, databases, APIs)
- **Multi-channel delivery** (Telegram, Discord, Slack, WhatsApp)
- **Skills and plugins** for domain-specific workflows
- **Cron scheduling** for autonomous background tasks
- **Tool orchestration** with approval flows

By wrapping OpenClaw inside a Strands invocation handler, you get the best of both worlds: AgentCore's serverless scaling + OpenClaw's rich agent capabilities.

## Current Limitations & Future Direction

All approaches above require **two processes** on the same machine: the AgentCore HTTP handler (`:8080`) and the OpenClaw gateway daemon (`:18789`). This is because OpenClaw's gateway speaks its own WebSocket protocol, not the AgentCore HTTP contract.

### What Would Be Ideal

A native AgentCore mode where OpenClaw serves the `/invoke` + `/ping` HTTP contract directly:

```bash
# Hypothetical future command
openclaw gateway --mode agentcore
# or
openclaw serve --agentcore-runtime
```

This would:
1. Start a Fastify server on `:8080` implementing the [AgentCore Runtime protocol](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
2. Expose `POST /invoke` → runs an embedded agent turn with full tool/memory/MCP access
3. Expose `GET /ping` → returns `{"status": "Healthy"}`
4. Optionally expose `GET /ws` → WebSocket for streaming
5. Use the local OpenClaw workspace, config, memory, and skills as context
6. **Single process, no sidecar gateway needed**

### Alternative: Embedded Engine (In-Memory)

OpenClaw exports `runEmbeddedPiAgent` (aliased as `runEmbeddedAgent`) from `openclaw/extension-api` and `openclaw/plugin-sdk/agent-harness`. This runs a full agent turn **in-process** without a separate gateway:

```typescript
// ⚠️ Deprecated API — internal, undocumented, may break between versions
import { runEmbeddedPiAgent } from "openclaw/extension-api";

const result = await runEmbeddedPiAgent({
  sessionId: "my-session",
  message: "Analyze this data",
  // Requires: config, model registry, auth storage, workspace, tools...
});

// Returns: { payloads: [{ text: "..." }], meta: { ... } }
```

**Status:** This API exists but is:
- Marked as **deprecated** (emits a process warning on import)
- Requires extensive setup context (config, model registry, auth storage, session store, workspace dir, tool definitions)
- Designed for internal gateway use, not external consumers
- No stability guarantees between OpenClaw versions

### Comparison of Integration Depths

| Depth | Mechanism | Processes | Stability | Setup |
|-------|-----------|:---------:|-----------|-------|
| **Sidecar** (current) | GatewayClient SDK → WS → gateway daemon | 2 | ✅ Stable | Low |
| **Embedded** (possible) | `runEmbeddedPiAgent` in-process | 1 | ⚠️ Internal API | High |
| **Native** (future) | `openclaw gateway --mode agentcore` | 1 | 🔮 Not yet available | Lowest |

### Feature Request

For native AgentCore Runtime support, see: [openclaw/openclaw#101627](https://github.com/openclaw/openclaw/issues/101627)

The request would cover:
- Native HTTP mode serving the AgentCore contract (`:8080`, `/invoke`, `/ping`)
- Single-process deployment without sidecar gateway
- Optional: exportable embedded agent function with stable public API

## Related

- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Strands Agents SDK](https://github.com/strands-agents/harness-sdk)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)
- [NemoClaw (NVIDIA)](https://github.com/NVIDIA/NemoClaw) — another integration pattern using OpenClaw in sandboxed environments

## License

MIT
