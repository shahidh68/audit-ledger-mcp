/**
 * End-to-end integration test.
 *
 * Spawns the built MCP server as a child process, connects over stdio using
 * the official MCP client SDK, and exercises all three tools against the live
 * AI Audit Ledger backing it.
 *
 * Required environment variables (read from the user's shell — never logged):
 *   AUDIT_API_URL    Base URL of the deployed ledger API
 *   AUDIT_WRITE_KEY  Tenant write key
 *   AUDIT_READ_KEY   Tenant read key
 *
 * Run:
 *   npm run build               # ensure dist/index.js exists
 *   npx tsx tests/integration.test.ts
 *
 * Exit code: 0 on full pass, 1 on any failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── pretty output ────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};
const PASS = `${C.green}PASS${C.reset}`;
const FAIL = `${C.red}FAIL${C.reset}`;
const STEP = `${C.cyan}→${C.reset}`;

let failures = 0;
function ok(label: string, detail = "") {
  console.log(`  ${PASS}  ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ""}`);
}
function fail(label: string, err: unknown) {
  failures++;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  ${FAIL}  ${label}\n         ${C.red}${msg}${C.reset}`);
}
function step(label: string) {
  console.log(`\n${STEP} ${C.bold}${label}${C.reset}`);
}

// ── environment checks ───────────────────────────────────────────────────────
const REQUIRED = ["AUDIT_API_URL", "AUDIT_WRITE_KEY", "AUDIT_READ_KEY"] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n${C.red}Missing required environment variables:${C.reset}`);
  for (const k of missing) console.error(`  - ${k}`);
  console.error(
    `\nSet them in your shell and re-run.\nSee .env.example for descriptions.\n`,
  );
  process.exit(1);
}

if (!existsSync("dist/index.js")) {
  console.error(
    `\n${C.red}dist/index.js not found.${C.reset}` +
      `\nRun ${C.bold}npm run build${C.reset} first so the server is compiled.\n`,
  );
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function parseToolResult(raw: unknown): unknown {
  // Tool responses come back as { content: [{ type: "text", text: "<json>" }] }
  const r = raw as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (r.isError) {
    const errText = r.content?.[0]?.text ?? "<no error body>";
    throw new Error(`tool returned isError: ${errText}`);
  }
  const text = r.content?.[0]?.text;
  if (!text) throw new Error("tool response had no text content");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollVerify(
  client: Client,
  eventId: string,
  attempts = 10,
  intervalMs = 2000,
): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await client.callTool({
        name: "verify_decision",
        arguments: { event_id: eventId },
      });
      const parsed = parseToolResult(result) as {
        integrity_verified?: boolean;
        integrity_note?: string;
        archived_record?: unknown;
      };
      // Retry when the S3 archive copy is still propagating (the API returns
      // integrity_verified=false with a "may still be processing" note in that
      // case). Otherwise return whatever we got.
      const archiveNotReady =
        parsed.archived_record == null &&
        typeof parsed.integrity_note === "string" &&
        /still be processing/i.test(parsed.integrity_note);
      if (!archiveNotReady) return parsed;
      last = new Error(parsed.integrity_note ?? "archive not yet present");
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw last instanceof Error
    ? last
    : new Error(`verify_decision still failing after ${attempts} attempts`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}audit-ledger-mcp integration test${C.reset}`);
  console.log(`${C.dim}target: ${process.env.AUDIT_API_URL}${C.reset}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      AUDIT_API_URL: process.env.AUDIT_API_URL!,
      AUDIT_WRITE_KEY: process.env.AUDIT_WRITE_KEY!,
      AUDIT_READ_KEY: process.env.AUDIT_READ_KEY!,
      PATH: process.env.PATH ?? "",
    },
  });

  const client = new Client(
    { name: "integration-test", version: "0.0.0" },
    { capabilities: {} },
  );

  try {
    // 1. Connection
    step("Connect to MCP server over stdio");
    try {
      await client.connect(transport);
      ok("Server spawned, MCP handshake completed");
    } catch (e) {
      fail("Could not connect to MCP server", e);
      throw new Error("aborting — connection failed");
    }

    // 2. Tools list
    step("List tools");
    let toolNames: string[] = [];
    try {
      const { tools } = await client.listTools();
      toolNames = tools.map((t) => t.name);
      const expected = ["record_decision", "verify_decision", "verify_completeness", "list_decisions"];
      const missing = expected.filter((n) => !toolNames.includes(n));
      if (missing.length > 0) {
        fail(`Tools missing from listing: ${missing.join(", ")}`, new Error("incomplete tool list"));
      } else {
        ok("All four tools advertised", toolNames.join(", "));
      }
    } catch (e) {
      fail("listTools failed", e);
    }

    // 3. record_decision
    step("Call record_decision");
    const eventId = randomUUID();
    let recorded = false;
    try {
      const raw = await client.callTool({
        name: "record_decision",
        arguments: {
          model_version: "claude-sonnet-4-7-20251022",
          raw_system_prompt:
            "You are a loan triage assistant. Score the application from 0 to 1 " +
            "and recommend either approve, decline, or refer_to_human.",
          raw_user_input:
            "Applicant: TEST_INTEGRATION_DO_NOT_USE — synthetic data for end-to-end test.",
          ai_decision_output: {
            decision: "refer_to_human",
            score: 0.62,
            reason: "borderline credit utilisation, recent address change",
          },
          human_in_loop: true,
          event_id: eventId,
        },
      });
      const result = parseToolResult(raw) as { event_id: string; recorded_at: string };
      if (result.event_id !== eventId) {
        throw new Error(`event_id mismatch — sent ${eventId}, got ${result.event_id}`);
      }
      recorded = true;
      ok("Decision recorded", `event_id=${eventId.slice(0, 8)}…`);
    } catch (e) {
      fail("record_decision failed", e);
    }

    // 4. verify_decision — poll because writes are async (SQS → Processor)
    step("Call verify_decision (polling — writes are async via SQS)");
    if (!recorded) {
      console.log(`  ${C.yellow}SKIP${C.reset}  No record was created — cannot verify`);
    } else {
      try {
        const result = await pollVerify(client, eventId) as {
          integrity_verified: boolean;
          integrity_note: string;
          current_record: unknown;
          archived_record: unknown;
        };
        if (result.integrity_verified === true) {
          ok("Tamper-check passed", "DynamoDB and S3 copies match");
        } else {
          fail("Tamper-check returned false", new Error(result.integrity_note ?? "no note"));
        }
        // v0.3.1: confirm the field-name fix is live (these used to come back undefined)
        if (typeof result.integrity_note === "string" && result.integrity_note.length > 0) {
          ok("Tamper-check response includes integrity_note", result.integrity_note);
        } else {
          fail("integrity_note missing from verify_decision response (regression of 0.3.1 fix)", new Error("undefined integrity_note"));
        }
        if (result.current_record && typeof result.current_record === "object") {
          ok("Tamper-check response includes current_record");
        } else {
          fail("current_record missing from verify_decision response (regression of 0.3.1 fix)", new Error("undefined current_record"));
        }
        if (result.archived_record && typeof result.archived_record === "object") {
          ok("Tamper-check response includes archived_record");
        } else {
          fail("archived_record missing from verify_decision response (regression of 0.3.1 fix)", new Error("undefined archived_record"));
        }
        // v0.3: archived record should carry sequence_no since the processor stamps it
        const seq = (result.archived_record as { sequence_no?: unknown }).sequence_no;
        if (typeof seq === "number" && seq >= 1) {
          ok(`Archived record has sequence_no=${seq}`);
        } else {
          fail("Archived record missing sequence_no (regression of v0.3 sequence allocation)", new Error(`sequence_no was ${String(seq)}`));
        }
      } catch (e) {
        fail("verify_decision failed after retries", e);
      }
    }

    // 4b. verify_completeness — new in v0.3
    step("Call verify_completeness (v0.3)");
    if (!recorded) {
      console.log(`  ${C.yellow}SKIP${C.reset}  No record was created — cannot verify completeness`);
    } else {
      try {
        const raw = await client.callTool({
          name: "verify_completeness",
          arguments: {},
        });
        const result = parseToolResult(raw) as {
          tenant_id: string;
          range: { from: number; to: number };
          expected_count: number;
          found_count: number;
          missing: number[];
        };
        if (typeof result.range?.to === "number" && result.range.to >= 1) {
          ok(`verify_completeness returned counter=${result.range.to}, found=${result.found_count}, missing=${result.missing.length}`);
        } else {
          fail("verify_completeness response shape unexpected", new Error(JSON.stringify(result).slice(0, 200)));
        }
      } catch (e) {
        fail("verify_completeness failed", e);
      }
    }

    // 5. list_decisions
    step("Call list_decisions");
    try {
      const raw = await client.callTool({
        name: "list_decisions",
        arguments: { limit: 10 },
      });
      const result = parseToolResult(raw) as { count: number; decisions: unknown[] };
      if (typeof result.count !== "number") {
        throw new Error("response missing count field");
      }
      if (!Array.isArray(result.decisions)) {
        throw new Error("response missing decisions array");
      }
      if (recorded) {
        const found = result.decisions.some(
          (d) => typeof d === "object" && d !== null && (d as { event_id?: string }).event_id === eventId,
        );
        if (found) {
          ok("List returned recent decisions", `${result.count} total, our test record included`);
        } else {
          ok(
            "List returned recent decisions",
            `${result.count} total — our record may be outside the listing limit`,
          );
        }
      } else {
        ok("List returned recent decisions", `${result.count} total`);
      }
    } catch (e) {
      fail("list_decisions failed", e);
    }
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log();
  if (failures === 0) {
    console.log(
      `${C.green}${C.bold}All checks passed.${C.reset} ` +
        `MCP server is wired correctly to the live ledger.`,
    );
    console.log(
      `${C.dim}Note: a synthetic test record was written to your ledger and ` +
        `cannot be deleted (S3 Object Lock COMPLIANCE mode). This is expected ` +
        `and harmless for the acme/test tenants.${C.reset}\n`,
    );
    process.exit(0);
  } else {
    console.log(
      `${C.red}${C.bold}${failures} check(s) failed.${C.reset} ` +
        `See above for details.\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal error:${C.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Silence "unused import" if the runtime never reaches spawnSync (we keep it
// available for future preflight checks like "is node available on PATH").
void spawnSync;
