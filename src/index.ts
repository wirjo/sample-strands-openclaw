/**
 * Approach 1: OpenClaw Gateway SDK (Recommended — no execSync)
 *
 * Uses GatewayClient from openclaw/plugin-sdk/gateway-runtime to invoke
 * the OpenClaw agent via WebSocket — no subprocess, no shell, type-safe.
 */
import { randomUUID } from "node:crypto";

// In production, import from the package:
// import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
// import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

// Types for demonstration
interface InvocationPayload {
  prompt?: string;
}

interface InvocationContext {
  requestId?: string;
}

interface AgentResult {
  reply: string;
  sessionKey?: string;
  runId?: string;
}

/**
 * OpenClaw GatewayClient usage pattern.
 *
 * The GatewayClient connects via WebSocket to the running OpenClaw gateway
 * and exposes a typed `request(method, params)` API.
 *
 * The "agent" method runs a full agent turn:
 * - Processes the message through the full agentic loop
 * - Has access to tools, memory, skills, MCP servers
 * - Returns the assistant's response
 *
 * Available parameters (AgentParamsSchema):
 *   message        - The prompt (required)
 *   sessionKey     - Persist conversation context across calls
 *   agentId        - Target a specific OpenClaw agent
 *   model          - Override the model
 *   provider       - Override the provider
 *   thinking       - Thinking level (off/on/stream)
 *   timeout        - Timeout in seconds
 *   deliver        - Also deliver to a channel
 *   to             - Channel delivery target
 *   channel        - Channel name (telegram/discord/etc.)
 *   idempotencyKey - Deduplication key (required)
 */

// --- SDK Approach ---
// const client = new GatewayClient({
//   url: `ws://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}`,
//   clientName: "strands-agentcore",
//   clientDisplayName: "Strands AgentCore Handler",
// });
// client.start();
//
// async function invokeOpenClaw(message: string, sessionKey?: string): Promise<string> {
//   const result = await client.request<AgentResult>("agent", {
//     message,
//     sessionKey: sessionKey || "agentcore-default",
//     idempotencyKey: randomUUID(),
//     timeout: 120,
//   });
//   return result.reply;
// }

// --- Fallback: CLI approach (for environments without SDK import) ---
import { execSync } from "node:child_process";

function invokeOpenClaw(message: string, _sessionKey?: string): string {
  const result = execSync(
    `openclaw agent --message ${JSON.stringify(message)} --json`,
    { encoding: "utf-8", timeout: 120_000 }
  );

  try {
    const parsed = JSON.parse(result);
    return parsed.reply || parsed.response || result;
  } catch {
    return result.trim();
  }
}

/**
 * AgentCore invocation handler that delegates to OpenClaw.
 */
async function handleInvocation(payload: InvocationPayload, context: InvocationContext) {
  const prompt = payload.prompt || "Hello";
  const sessionKey = `agentcore-${context.requestId || "default"}`;
  const result = invokeOpenClaw(prompt, sessionKey);
  return { content: [{ text: result }] };
}

// — Entry point —
// In production with BedrockAgentCoreApp:
//
// import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
// const app = new BedrockAgentCoreApp({ invocationHandler: { process: handleInvocation } });
// app.run();

// For local testing:
async function main() {
  const testPrompt = process.argv[2] || "What is 2+2?";
  console.log(`Invoking OpenClaw with: "${testPrompt}"`);
  const result = await handleInvocation({ prompt: testPrompt }, { requestId: "test-1" });
  console.log("Result:", result.content[0].text);
}

main().catch(console.error);
