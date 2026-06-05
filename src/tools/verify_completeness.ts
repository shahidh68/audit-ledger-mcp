/**
 * verify_completeness tool — detect missing audit records.
 *
 * Sister tool to verify_decision. verify_decision proves a record that exists
 * matches its S3 copy (tampering check). verify_completeness proves no
 * records have been deleted by comparing the tenant's monotonic sequence
 * counter against the rows actually present in DynamoDB. A gap in the
 * returned `missing` array represents a record that was deleted, lost during
 * SQS redelivery, or otherwise never stored — combine with the processor's
 * burned_sequence log entries to tell those apart.
 */

import { z } from "zod";

import type { AuditLedgerClient, CompletenessResult } from "../client.js";

export const verifyCompletenessInputSchema = z.object({
  from: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Inclusive lower bound on sequence_no. Defaults to 1."),
  to: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Inclusive upper bound on sequence_no. Defaults to the tenant's current counter value.",
    ),
  tenant_id: z
    .string()
    .optional()
    .describe(
      "Required only when calling with the admin read key. Ignored when called with a regular tenant read key — the tenant is inferred from the key.",
    ),
});

export type VerifyCompletenessInput = z.infer<typeof verifyCompletenessInputSchema>;

export const verifyCompletenessToolDefinition = {
  name: "verify_completeness",
  description:
    "Detect whether any audit records have been deleted or omitted for the caller's tenant. Each successfully stored decision receives a per-tenant monotonic sequence number. This tool compares the ledger's counter against the rows actually present in DynamoDB and returns any sequence numbers that are missing. Use this when a regulator or compliance team asks 'can you prove the log is complete?' — verify_decision only proves an existing record was not altered; this proves no record has disappeared.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: {
        type: "integer",
        minimum: 1,
        description: verifyCompletenessInputSchema.shape.from.description,
      },
      to: {
        type: "integer",
        minimum: 1,
        description: verifyCompletenessInputSchema.shape.to.description,
      },
      tenant_id: {
        type: "string",
        description: verifyCompletenessInputSchema.shape.tenant_id.description,
      },
    },
  },
} as const;

export async function executeVerifyCompleteness(
  client: AuditLedgerClient,
  rawInput: unknown,
): Promise<CompletenessResult> {
  const input = verifyCompletenessInputSchema.parse(rawInput ?? {});
  return client.verifyCompleteness({
    from: input.from,
    to: input.to,
    tenantId: input.tenant_id,
  });
}
