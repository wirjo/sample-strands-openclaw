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
# 1. Install dependencies (openclaw provides both the gateway + SDK)
npm install

# 2. Configure OpenClaw for Bedrock
# Option A: AWS env vars (auto-detected by OpenClaw)
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

# Option B: EC2/AgentCore instance role (opt-in discovery)
openclaw config set plugins.entries.amazon-bedrock.config.discovery.enabled true
openclaw config set plugins.entries.amazon-bedrock.config.discovery.region us-east-1

# Set the model
openclaw models set "amazon-bedrock/global.anthropic.claude-sonnet-4-6"

# 3. Ensure OpenClaw gateway is running
openclaw gateway start

# 4. Verify OpenClaw is healthy
curl http://localhost:18789/health

# 5. Run the handler
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

# Provider configured via openclaw.json at runtime (not env var)
# See "Bedrock Configuration" section below

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

## Alternative: Direct AgentCore Contract (No Strands)

If you don't need Strands SDK at all, you can implement the AgentCore HTTP contract directly with a raw bridge to OpenClaw. This is the approach used by [`aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore`](https://github.com/aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore).

### How the AgentCore Runtime Contract Works

AgentCore Runtime expects a container serving HTTP on `:8080` with:

| Endpoint | Method | Purpose |
|----------|--------|--------|
| `/ping` | GET | Health check — return `{"status": "Healthy"}` or `{"status": "HealthyBusy"}` |
| `/invocations` | POST | Agent invocation — receive prompt, return response |

The container lifecycle is controlled by `/ping`:
- `"Healthy"` → idle, AgentCore may terminate the microVM
- `"HealthyBusy"` → processing, AgentCore will NOT terminate

### Architecture (3-layer stack from aws-samples)

```
┌───────────────────────────────────────────────────────────────────┐
│ Layer 1: AgentCore Contract Server (:8080)                        │
│   GET /ping → health status                                       │
│   POST /invocations → route by action (chat/cron/warmup)          │
│   Secrets prefetch, lifecycle management, cold start shim         │
├───────────────────────────────────────────────────────────────────┤
│ Layer 2: Inference Proxy (:18790)                                  │
│   OpenAI-compatible API → Bedrock ConverseStream                  │
│   STS scoped creds, model routing, image injection                │
├───────────────────────────────────────────────────────────────────┤
│ Layer 3: OpenClaw Gateway (:18789)                                 │
│   Full agent engine: tools, memory, skills, MCP, sessions         │
│   Configured to use proxy as its "provider"                       │
└───────────────────────────────────────────────────────────────────┘
```

OpenClaw thinks it's talking to an OpenAI-compatible provider at `localhost:18790`, but the proxy translates to Bedrock `ConverseStream` with STS-scoped credentials.

### Chat invocation flow

```
POST /invocations { action: "chat", message: "...", userId, actorId }
    │
    ├── If OpenClaw NOT ready → lightweight-agent shim (direct Bedrock call)
    │     └── Immediate response while gateway starts (~1-2 min cold start)
    │
    └── If OpenClaw ready → WebSocket bridge:
          1. Connect to ws://127.0.0.1:18789
          2. Handle connect.challenge → authenticate with gateway token
          3. Send chat.send { sessionKey: "global", message }
          4. Collect chat events (delta → streaming, final → done)
          5. Return response text
```

### Minimal implementation (without Strands)

```typescript
// No Strands SDK — raw HTTP server implementing AgentCore contract
import http from "node:http";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { randomUUID } from "node:crypto";

const client = new GatewayClient({
  url: "ws://127.0.0.1:18789/ws",
  clientName: "agentcore-bridge",
});
client.start();

let activeTaskCount = 0;

const server = http.createServer(async (req, res) => {
  // GET /ping — required by AgentCore
  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: activeTaskCount > 0 ? "HealthyBusy" : "Healthy",
      time_of_last_update: Math.floor(Date.now() / 1000),
    }));
    return;
  }

  // POST /invocations — agent invocation
  if (req.method === "POST" && req.url === "/invocations") {
    const body = await readBody(req);
    const { message } = JSON.parse(body);

    activeTaskCount++;
    try {
      const result = await client.request<{ reply: string }>("agent", {
        message,
        sessionKey: "agentcore-session",
        idempotencyKey: randomUUID(),
        timeout: 120,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: result.reply }));
    } finally {
      activeTaskCount--;
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(8080, "0.0.0.0");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
```

### Comparison: Strands vs Direct Contract

| | **Strands SDK** (this repo's main approach) | **Direct Contract** (aws-samples style) |
|---|---|---|
| **Framework** | `BedrockAgentCoreApp` (Fastify, managed) | Raw `http.createServer()` |
| **Validation** | Zod schema on request body | Manual parsing |
| **Streaming** | Built-in SSE via async generators | Implement SSE yourself |
| **Health tracking** | `asyncTask()` decorator, auto HealthyBusy | Manual `activeTaskCount` |
| **Context propagation** | `AsyncLocalStorage` + `getContext()` | Manual threading |
| **Cold start handling** | Not handled (assumes gateway ready) | Lightweight agent shim |
| **Multi-user** | Single session | Per-user identity + DynamoDB |
| **Boilerplate** | ~10 lines | ~50+ lines (minimal) / ~2000 lines (production) |
| **Use when** | Focused SDK integration | Full production system with custom lifecycle |

**Bottom line:** Use `BedrockAgentCoreApp` (Strands) when you want managed HTTP plumbing. Go direct when you need full control over request lifecycle, cold start handling, or multi-user routing.

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

## Comparison with aws-samples Reference Architecture

AWS provides a full production deployment sample at [`aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore`](https://github.com/aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore). Here's how the two repos compare:

| | **This repo** (wirjo/sample-strands-openclaw) | **aws-samples** (full deployment) |
|---|---|---|
| **Purpose** | SDK integration guide | Production reference architecture |
| **Bridge method** | `GatewayClient` SDK (typed, ~20 LOC) | Raw WebSocket protocol (~2000 LOC) |
| **Framework** | Strands SDK + `BedrockAgentCoreApp` | Custom `http.createServer()` |
| **Multi-user** | Single session | Per-user microVM + DynamoDB identity |
| **Channels** | AgentCore invocation only | Telegram + Slack (webhook routing) |
| **Cold start** | Assumes gateway running | Lightweight agent shim during ~1-2 min startup |
| **Persistence** | OpenClaw native (local) | S3-backed workspace sync |
| **Security** | Basic | STS scoped creds, VPC, Guardrails, KMS, HMAC |
| **Infra** | Single Dockerfile | Full CDK (VPC, Lambda, DDB, S3, EventBridge) |
| **Multimodal** | Text only | Images via Telegram/Slack → S3 → Claude |
| **Complexity** | ~200 LOC total | ~5000+ LOC (bridge + CDK + Lambda + scripts) |

**When to use which:**
- **This repo** → You want the simplest integration pattern, are building your own infra, or want to understand the SDK approach
- **aws-samples** → You want a deployable multi-user production system with channels, security hardening, and CDK

Both repos solve the same core problem (bridging OpenClaw's WebSocket protocol to AgentCore's HTTP contract) — this repo does it with the typed SDK in 20 lines; aws-samples does it with a hand-rolled protocol bridge plus full operational concerns.

## Related

- [aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore](https://github.com/aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore) — full CDK production deployment
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Strands Agents SDK](https://github.com/strands-agents/harness-sdk)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)
- [NemoClaw (NVIDIA)](https://github.com/NVIDIA/NemoClaw) — OpenClaw in sandboxed NVIDIA OpenShell environments

## License

MIT
