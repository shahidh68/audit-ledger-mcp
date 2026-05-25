/**
 * list_decisions tool — query recent decisions for the calling tenant. Useful
 * for an agent to review its own recent activity, for compliance dashboards,
 * and for spot-checks during an audit.
 *
 * Defaults: last 7 days, sorted newest first. Tenant scope is enforced by the
 * read key — a tenant key only returns that tenant's records.
 */

import { z } from "zod";

import type { AuditLedgerClient } from "../client.js";

export const listDecisionsInputSchema = z.object({
  from: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ISO 8601 start of the time window (inclusive). Defaults to 7 days before now.",
    ),
  to: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ISO 8601 end of the time window (inclusive). Defaults to now.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      "Maximum number of records to return (default 100, max 500). Returned newest-first.",
    ),
});

export type ListDecisionsInput = z.infer<typeof listDecisionsInputSchema>;

export const listDecisionsToolDefinition = {
  name: "list_decisions",
  description:
    "List recorded AI decisions for the calling tenant within a time window. Returns newest first. The read key scopes the result to the caller's tenant — cross-tenant reads require an admin read key. Use this for compliance review, audit prep, or agent self-inspection of recent activity.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: { type: "string", format: "date-time", description: listDecisionsInputSchema.shape.from.description },
      to: { type: "string", format: "date-time", description: listDecisionsInputSchema.shape.to.description },
      limit: { type: "number", minimum: 1, maximum: 500, description: listDecisionsInputSchema.shape.limit.description },
    },
    required: [],
  },
} as const;

export async function executeListDecisions(
  client: AuditLedgerClient,
  rawInput: unknown,
): Promise<{
  count: number;
  from: string;
  to: string;
  decisions: unknown[];
}> {
  const input = listDecisionsInputSchema.parse(rawInput ?? {});
  const to = input.to ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const from =
    input.from ??
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  const limit = input.limit ?? 100;

  const all = await client.listDecisions({ from, to });
  const decisions = all.slice(0, limit);
  return {
    count: decisions.length,
    from,
    to,
    decisions,
  };
}
