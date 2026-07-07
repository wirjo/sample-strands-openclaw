# Sample: Invoke OpenClaw from Strands SDK on AgentCore Runtime

This sample demonstrates how to invoke [OpenClaw](https://openclaw.ai) from within a [Strands Agents SDK](https://github.com/strands-agents/harness-sdk) invocation handler, deployed on [Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/bedrock/agentcore/).

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

### Approach 1: CLI Invocation (Recommended — most stable)

Uses `openclaw agent --message` to run a single agent turn through the running gateway. This is the most reliable interface today.

```typescript
// src/index.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { execSync } from "node:child_process";

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const prompt = payload.prompt || "Hello";

      // Invoke OpenClaw via CLI — runs one agent turn through the gateway
      const result = execSync(
        `openclaw agent --message ${JSON.stringify(prompt)} --json`,
        {
          encoding: "utf-8",
          timeout: 120_000,
          env: { ...process.env },
        }
      );

      // Parse JSON response
      const parsed = JSON.parse(result);
      return {
        content: [{ text: parsed.reply || parsed.response || result }],
      };
    },
  },
});

app.run();
```

**How `openclaw agent` works:**
- Sends a message to the **already-running** OpenClaw gateway
- The gateway runs a full agent turn (with tools, memory, skills, MCP)
- Returns the assistant's response
- Exit code 0 on success

**Flags:**
| Flag | Description |
|------|-------------|
| `--message`, `-m` | The prompt to send (required) |
| `--json` | Output structured JSON |
| `--to` | Optional: deliver response to a channel target |
| `--deliver` | Optional: send the reply to the target |

### Approach 2: HTTP API (Lower latency)

If OpenClaw's gateway HTTP API is accessible locally, you can call it directly without process spawn overhead:

```typescript
// src/index-http.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const OPENCLAW_PORT = process.env.OPENCLAW_PORT || "18789";
const OPENCLAW_URL = `http://127.0.0.1:${OPENCLAW_PORT}`;

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const prompt = payload.prompt || "Hello";

      const response = await fetch(`${OPENCLAW_URL}/api/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });

      if (!response.ok) {
        throw new Error(`OpenClaw error: ${response.status}`);
      }

      const result = await response.json();
      return {
        content: [{ text: result.reply || JSON.stringify(result) }],
      };
    },
  },
});

app.run();
```

> **Note:** The HTTP API endpoint and schema should be validated against your OpenClaw version. The CLI approach (Approach 1) is the documented stable interface.

### Approach 3: Hybrid — Strands Agent + OpenClaw as Tool

Use the Strands SDK agent loop for orchestration, but delegate complex tasks to OpenClaw:

```typescript
// src/index-hybrid.ts
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { Agent } from "@strands-agents/sdk";
import { execSync } from "node:child_process";

// Define OpenClaw as a Strands tool
const openclawTool = {
  name: "openclaw",
  description:
    "Invoke the OpenClaw AI agent for complex tasks requiring tools, memory, web search, file access, or multi-step reasoning. OpenClaw has access to MCP servers, persistent memory, and can execute code.",
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
    const result = execSync(
      `openclaw agent --message ${JSON.stringify(input.task)} --json`,
      { encoding: "utf-8", timeout: 120_000 }
    );
    return JSON.parse(result).reply || result;
  },
};

// Strands agent with OpenClaw as a tool
const agent = new Agent({
  tools: [openclawTool],
  system:
    "You are a helpful assistant. For complex tasks that need web search, file access, code execution, or persistent memory, use the openclaw tool.",
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
| **CLI** (Approach 1) | Reliability, stable interface | ~1-2s overhead | Low |
| **HTTP** (Approach 2) | Low-latency production | Minimal | Medium |
| **Hybrid** (Approach 3) | Mixed workloads (simple + complex) | Varies | Higher |

## Why OpenClaw?

OpenClaw brings capabilities that a bare Strands agent doesn't have out of the box:
- **Persistent memory** across invocations
- **MCP server ecosystem** (GitHub, databases, APIs)
- **Multi-channel delivery** (Telegram, Discord, Slack, WhatsApp)
- **Skills and plugins** for domain-specific workflows
- **Cron scheduling** for autonomous background tasks
- **Tool orchestration** with approval flows

By wrapping OpenClaw inside a Strands invocation handler, you get the best of both worlds: AgentCore's serverless scaling + OpenClaw's rich agent capabilities.

## Related

- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Strands Agents SDK](https://github.com/strands-agents/harness-sdk)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)
- [NemoClaw (NVIDIA)](https://github.com/NVIDIA/NemoClaw) — another integration pattern using OpenClaw in sandboxed environments

## License

MIT
