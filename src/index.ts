/**
 * Approach 1: CLI Invocation (Recommended)
 *
 * Invokes OpenClaw via its CLI to run a single agent turn through the
 * already-running gateway. Most stable and well-documented interface.
 */
import { execSync } from "node:child_process";

// Note: BedrockAgentCoreApp and Agent imports require the actual packages
// This file demonstrates the pattern — install dependencies to run.

interface InvocationPayload {
  prompt?: string;
}

interface InvocationContext {
  requestId?: string;
}

/**
 * Invoke OpenClaw agent via CLI.
 * Requires: openclaw gateway running on localhost.
 */
function invokeOpenClaw(message: string, timeoutMs = 120_000): string {
  const result = execSync(
    `openclaw agent --message ${JSON.stringify(message)} --json`,
    {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env },
    }
  );

  try {
    const parsed = JSON.parse(result);
    return parsed.reply || parsed.response || result;
  } catch {
    // If JSON parsing fails, return raw output
    return result.trim();
  }
}

/**
 * AgentCore invocation handler that delegates to OpenClaw.
 */
async function handleInvocation(payload: InvocationPayload, context: InvocationContext) {
  const prompt = payload.prompt || "Hello";
  const result = invokeOpenClaw(prompt);
  return { content: [{ text: result }] };
}

// — Entry point —
// In production, wrap with BedrockAgentCoreApp:
//
// import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
// const app = new BedrockAgentCoreApp({ invocationHandler: { process: handleInvocation } });
// app.run();

// For local testing:
async function main() {
  const testPrompt = process.argv[2] || "What is 2+2?";
  console.log(`Invoking OpenClaw with: "${testPrompt}"`);
  const result = await handleInvocation({ prompt: testPrompt }, {});
  console.log("Result:", result.content[0].text);
}

main().catch(console.error);
