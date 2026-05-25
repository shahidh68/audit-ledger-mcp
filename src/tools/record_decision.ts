/**
 * record_decision tool — agent logs an AI decision to the audit ledger.
 *
 * PII (raw_system_prompt and raw_user_input) is hashed locally inside this
 * tool before any payload leaves the MCP server. The ledger never sees the
 * raw values — only SHA-256 hashes, the structured decision output, and
 * metadata.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AuditLedgerClient } from "../client.js";
import { hashPii, hashPrompt } from "../hashing.js";

export const recordDecisionInputSchema = z.object({
  model_version: z
    .string()
    .min(1)
    .describe(
      "The model and version that produced the decision (e.g. 'claude-sonnet-4.7', 'gpt-4o-2024-08-06'). Required for traceability and model risk audits.",
    ),
  raw_system_prompt: z
    .string()
    .describe(
      "The system prompt used. Hashed locally before transit — the raw text never leaves this MCP server.",
    ),
  raw_user_input: z
    .string()
    .describe(
      "The user input the model decided on (CV text, transaction, customer message, etc.). Hashed locally before transit — raw PII never leaves this MCP server.",
    ),
  ai_decision_output: z
    .record(z.unknown())
    .describe(
      "The structured decision the model produced. Stored verbatim. Should NOT contain raw PII — only the decision itself (score, classification, recommendation, reasoning summary).",
    ),
  human_in_loop: z
    .boolean()
    .describe(
      "Whether a human reviewed or approved this decision before it took effect. Critical for EU AI Act Article 14 (human oversight) compliance.",
    ),
  event_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Optional UUID v4 to identify this decision. Auto-generated if omitted. Useful when the calling system already has its own decision ID.",
    ),
  timestamp: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Optional ISO 8601 timestamp of when the decision was made. Defaults to the current time. Use this only if recording a backfilled decision.",
    ),
});

export type RecordDecisionInput = z.infer<typeof recordDecisionInputSchema>;

export const recordDecisionToolDefinition = {
  name: "record_decision",
  description:
    "Record an AI decision to the audit ledger. Stores model version, hashed inputs, structured output, and human-review flag. The record is immutably sealed in S3 Object Lock for 7 years and queryable for the lifetime of the decision. Use this immediately after any AI decision that may need to be audited later — credit, hiring, fraud, customer routing, content moderation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      model_version: { type: "string", description: recordDecisionInputSchema.shape.model_version.description },
      raw_system_prompt: { type: "string", description: recordDecisionInputSchema.shape.raw_system_prompt.description },
      raw_user_input: { type: "string", description: recordDecisionInputSchema.shape.raw_user_input.description },
      ai_decision_output: { type: "object", description: recordDecisionInputSchema.shape.ai_decision_output.description, additionalProperties: true },
      human_in_loop: { type: "boolean", description: recordDecisionInputSchema.shape.human_in_loop.description },
      event_id: { type: "string", format: "uuid", description: recordDecisionInputSchema.shape.event_id.description },
      timestamp: { type: "string", format: "date-time", description: recordDecisionInputSchema.shape.timestamp.description },
    },
    required: ["model_version", "raw_system_prompt", "raw_user_input", "ai_decision_output", "human_in_loop"],
  },
} as const;

export async function executeRecordDecision(
  client: AuditLedgerClient,
  rawInput: unknown,
): Promise<{ event_id: string; recorded_at: string; note: string }> {
  const input = recordDecisionInputSchema.parse(rawInput);
  const eventId = input.event_id ?? randomUUID();
  const timestamp = input.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const result = await client.recordDecision({
    event_id: eventId,
    timestamp,
    model_version: input.model_version,
    system_prompt_hash: hashPrompt(input.raw_system_prompt),
    input_data_hash: hashPii(input.raw_user_input),
    ai_decision_output: input.ai_decision_output,
    human_in_loop: input.human_in_loop,
  });

  return {
    event_id: result.event_id,
    recorded_at: timestamp,
    note:
      "Decision recorded. PII was hashed locally — only the SHA-256 hashes were sent to the ledger. The record is now immutably stored in S3 Object Lock and queryable via verify_decision and list_decisions.",
  };
}
