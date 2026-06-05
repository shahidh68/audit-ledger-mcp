/**
 * Local hashing — raw PII never leaves the MCP server's process.
 *
 * By default this module uses HMAC-SHA256 keyed off the AUDIT_HMAC_KEY
 * environment variable. Keyed hashing makes the output non-reversible by
 * anyone who does not hold the key, which is what regulators (ICO / EDPB)
 * expect when you describe a value as pseudonymised rather than identifiable.
 *
 * Backwards-compatible fallback:
 *   If AUDIT_HMAC_KEY is not set, the functions fall back to plain SHA-256
 *   so existing MCP installs do not break. A one-time stderr warning is
 *   emitted on first use to nudge operators to upgrade. The default will
 *   flip in a future major version.
 *
 * The key is your tenant's secret. Generate once and store it where you
 * already store AUDIT_WRITE_KEY (env var, .env file, secrets manager):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * The key never leaves your environment and never reaches the ledger API.
 */

import { createHash, createHmac } from "node:crypto";

let _fallbackWarned = false;

function getKey(): string | null {
  const raw = (process.env.AUDIT_HMAC_KEY ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function warnFallbackOnce(): void {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  // stderr, not stdout — stdout is the MCP protocol channel and any extra
  // bytes there will break the client. console.warn goes to stderr in Node.
  console.warn(
    "[audit-ledger-mcp] AUDIT_HMAC_KEY is not set; falling back to plain " +
      "SHA-256 for PII hashing. Plain SHA-256 of low-entropy values (names, " +
      "emails) is brute-forceable and should not be treated as anonymisation " +
      "under ICO/EDPB guidance. Set AUDIT_HMAC_KEY to a 32+ byte secret to " +
      "switch to keyed HMAC-SHA256. This fallback will be removed in a " +
      "future major version.",
  );
}

/** SHA-256 hex digest of a UTF-8 string. Lowercased, 64 chars. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash a system prompt before sending. Whitespace is normalised so that
 * formatting-only changes do not produce a different hash — this matches
 * the behaviour of the SDKs in the main repo and keeps prompt-version
 * tracking stable across minor edits.
 *
 * Uses HMAC-SHA256 when AUDIT_HMAC_KEY is set, plain SHA-256 otherwise.
 */
export function hashPrompt(rawPrompt: string): string {
  const normalised = rawPrompt.replace(/\s+/g, " ").trim();
  const key = getKey();
  if (key === null) {
    warnFallbackOnce();
    return createHash("sha256").update(normalised, "utf8").digest("hex");
  }
  return createHmac("sha256", key).update(normalised, "utf8").digest("hex");
}

/**
 * Hash raw user input (e.g. a CV, a transaction payload, a customer record)
 * before sending. No normalisation — the input is hashed verbatim so any
 * change in the input produces a different hash, which is the right
 * behaviour for an audit trail of model inputs.
 *
 * Uses HMAC-SHA256 when AUDIT_HMAC_KEY is set, plain SHA-256 otherwise.
 */
export function hashPii(rawInput: string): string {
  const key = getKey();
  if (key === null) {
    warnFallbackOnce();
    return createHash("sha256").update(rawInput, "utf8").digest("hex");
  }
  return createHmac("sha256", key).update(rawInput, "utf8").digest("hex");
}

/**
 * Test-only hook. Resets the one-time warned flag so unit tests can assert
 * the warning fires exactly once per process. Not part of the public API.
 * @internal
 */
export function _resetFallbackWarnedForTests(): void {
  _fallbackWarned = false;
}
