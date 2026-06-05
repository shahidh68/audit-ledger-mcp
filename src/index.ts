#!/usr/bin/env node
/**
 * audit-ledger-mcp — Model Context Protocol server for AI Audit Ledger.
 *
 * Stdio transport — designed to be spawned by an MCP client (Claude Desktop,
 * Cursor, LangGraph adapter, custom). Three tools exposed: record_decision,
 * verify_decision, list_decisions.
 *
 * Configuration via environment variables — see .env.example. The server
 * reads them at startup and refuses to start if AUDIT_API_URL is missing,
 * since no tool can do anything useful without it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AuditLedgerClient, AuditLedgerError } from "./client.js";
import { SANDBOX_CONFIG, isSandboxMode, sandboxBanner } from "./sandbox.js";
import {
  executeRecordDecision,
  recordDecisionToolDefinition,
} from "./tools/record_decision.js";
import {
  executeVerifyDecision,
  verifyDecisionToolDefinition,
} from "./tools/verify_decision.js";
import {
  executeVerifyCompleteness,
  verifyCompletenessToolDefinition,
} from "./tools/verify_completeness.js";
import {
  executeListDecisions,
  listDecisionsToolDefinition,
} from "./tools/list_decisions.js";

// Read package.json at startup so PKG_NAME and PKG_VERSION cannot drift from
// the published package version. dist/index.js lives one level below the
// package root, so package.json is at "../package.json" relative to here.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { name: string; version: string };
const PKG_NAME = PKG.name;
const PKG_VERSION = PKG.version;

function buildClient(): AuditLedgerClient {
  const timeoutMs = process.env.AUDIT_TIMEOUT_MS
    ? Number(process.env.AUDIT_TIMEOUT_MS)
    : undefined;
  const retryAttempts = process.env.AUDIT_RETRY_ATTEMPTS
    ? Number(process.env.AUDIT_RETRY_ATTEMPTS)
    : undefined;

  // Sandbox mode: no AUDIT_API_URL configured. Fall back to the public
  // sandbox so the package works zero-config. Records go to a shared
  // public tenant that anyone can read — do NOT write real data.
  if (isSandboxMode()) {
    process.stderr.write(sandboxBanner(PKG_NAME, PKG_VERSION) + "\n");
    return new AuditLedgerClient({
      apiUrl: SANDBOX_CONFIG.apiUrl,
      writeKey: SANDBOX_CONFIG.writeKey,
      readKey: SANDBOX_CONFIG.readKey,
      timeoutMs,
      retryAttempts,
    });
  }

  // Production mode: developer has explicitly configured an endpoint.
  const apiUrl = process.env.AUDIT_API_URL!;
  const writeKey = process.env.AUDIT_WRITE_KEY;
  const readKey = process.env.AUDIT_READ_KEY;

  if (!writeKey && !readKey) {
    process.stderr.write(
      `[${PKG_NAME}] AUDIT_API_URL is set but neither AUDIT_WRITE_KEY nor\n` +
        `[${PKG_NAME}] AUDIT_READ_KEY is set — all tools will fail. Set at\n` +
        `[${PKG_NAME}] least one. See .env.example.\n`,
    );
  }
  return new AuditLedgerClient({ apiUrl, writeKey, readKey, timeoutMs, retryAttempts });
}

async function main(): Promise<void> {
  const client = buildClient();
  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      recordDecisionToolDefinition,
      verifyDecisionToolDefinition,
      verifyCompletenessToolDefinition,
      listDecisionsToolDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let result: unknown;
      switch (name) {
        case "record_decision":
          result = await executeRecordDecision(client, args);
          break;
        case "verify_decision":
          result = await executeVerifyDecision(client, args);
          break;
        case "verify_completeness":
          result = await executeVerifyCompleteness(client, args);
          break;
        case "list_decisions":
          result = await executeListDecisions(client, args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message =
        err instanceof AuditLedgerError
          ? `${err.message}${err.status ? ` (HTTP ${err.status})` : ""}${err.body ? `\n${err.body}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${PKG_NAME}] ${PKG_VERSION} listening on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`[${PKG_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
