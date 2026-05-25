/**
 * verify_decision tool — check that a recorded decision has not been tampered
 * with. Hits the read API's tamper-evidence endpoint, which independently
 * fetches the DynamoDB record AND the S3 Object Lock record and compares
 * them. A mismatch is what an integrity failure looks like.
 */

import { z } from "zod";

import type { AuditLedgerClient } from "../client.js";

export const verifyDecisionInputSchema = z.object({
  event_id: z
    .string()
    .uuid()
    .describe("The UUID v4 event ID of the decision to verify."),
});

export type VerifyDecisionInput = z.infer<typeof verifyDecisionInputSchema>;

export const verifyDecisionToolDefinition = {
  name: "verify_decision",
  description:
    "Verify a recorded AI decision has not been altered since it was written. The ledger fetches the queryable copy (DynamoDB) and the immutable copy (S3 Object Lock COMPLIANCE mode) independently and compares them. Returns integrity_verified=true if they match. Use this to satisfy a regulator request or to prove an audit trail to a compliance team.",
  inputSchema: {
    type: "object" as const,
    properties: {
      event_id: { type: "string", format: "uuid", description: verifyDecisionInputSchema.shape.event_id.description },
    },
    required: ["event_id"],
  },
} as const;

export async function executeVerifyDecision(
  client: AuditLedgerClient,
  rawInput: unknown,
): Promise<{
  event_id: string;
  integrity_verified: boolean;
  note: string;
  dynamodb_record: unknown;
  s3_record: unknown;
}> {
  const input = verifyDecisionInputSchema.parse(rawInput);
  const result = await client.verifyDecision(input.event_id);
  return {
    event_id: input.event_id,
    integrity_verified: result.integrity_verified,
    note: result.note,
    dynamodb_record: result.dynamodb_record,
    s3_record: result.s3_record,
  };
}
