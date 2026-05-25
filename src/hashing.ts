/**
 * SHA-256 helpers — mirror the hashing behaviour of the Python and Node SDKs
 * shipped in the main audit-ledger repo. PII is hashed locally before any
 * payload leaves the MCP server, so raw personal data never reaches the
 * audit ledger API.
 */

import { createHash } from "node:crypto";

/** SHA-256 hex digest of a UTF-8 string. Lowercased, 64 chars. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash a system prompt before sending. Whitespace is normalised so that
 * formatting-only changes do not produce a different hash — this matches
 * the behaviour of the SDKs in the main repo and keeps prompt-version
 * tracking stable across minor edits.
 */
export function hashPrompt(rawPrompt: string): string {
  const normalised = rawPrompt.replace(/\s+/g, " ").trim();
  return sha256(normalised);
}

/**
 * Hash raw user input (e.g. a CV, a transaction payload, a customer record)
 * before sending. No normalisation — the input is hashed verbatim so any
 * change in the input produces a different hash, which is the right
 * behaviour for an audit trail of model inputs.
 */
export function hashPii(rawInput: string): string {
  return sha256(rawInput);
}
