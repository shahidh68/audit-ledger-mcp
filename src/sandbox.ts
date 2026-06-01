/**
 * Public sandbox configuration.
 *
 * When a developer runs `npx audit-ledger-mcp` with no environment variables,
 * the server falls back to this configuration. Records are written to a
 * shared `sandbox-public` tenant on a hosted audit ledger.
 *
 * Important properties of sandbox mode:
 *
 * 1. The two keys below are baked into the published npm package and are
 *    therefore PUBLIC. They grant access only to the `sandbox-public` tenant
 *    and cannot be used to read or write to any other tenant's records.
 *
 * 2. Records written in sandbox mode persist in the ledger's S3 Object Lock
 *    in COMPLIANCE mode and cannot be deleted before their retention date.
 *    This is intentional — visitors should be able to verify their own
 *    sandbox records later. Do not write real customer data to the sandbox.
 *
 * 3. The sandbox is rate-limited per-tenant at the ledger level (currently
 *    100 requests per minute). Heavy users should provision their own
 *    deployment.
 *
 * 4. The sandbox runs on the same AWS infrastructure as the production
 *    deployment for github.com/shahidh68/audit-ledger. Uptime and durability
 *    are best-effort. If you need an SLA, deploy your own.
 */

export const SANDBOX_CONFIG = {
  apiUrl:
    "https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod",
  writeKey:
    "wk-sandbox-public-0NoHiHBSUUBoan21NWkCMLU5G2d1ijX8",
  readKey:
    "rk-sandbox-public-XaV3aHdmKH1ZbQl7LswUkTJYJLyGmLh8",
  tenantId: "sandbox-public",
  dashboardUrl: "https://d2pfirb2397ixy.cloudfront.net",
} as const;

/**
 * Sandbox mode is triggered when the developer has not configured an audit
 * ledger endpoint. Any explicit AUDIT_API_URL switches off sandbox mode —
 * the server then operates against the configured deployment using whichever
 * keys are present.
 */
export function isSandboxMode(): boolean {
  return !process.env.AUDIT_API_URL;
}

/**
 * Banner shown on stderr when sandbox mode is active. Designed to make it
 * obvious to a developer that they are using shared infrastructure.
 */
export function sandboxBanner(packageName: string, packageVersion: string): string {
  return [
    `[${packageName}] ─────────────── SANDBOX MODE ───────────────`,
    `[${packageName}] No AUDIT_API_URL configured.`,
    `[${packageName}] Using the public sandbox at ${SANDBOX_CONFIG.tenantId}.`,
    ``,
    `[${packageName}]   Records: hosted by github.com/shahidh68/audit-ledger`,
    `[${packageName}]   Tenant:  ${SANDBOX_CONFIG.tenantId}`,
    `[${packageName}]   View:    ${SANDBOX_CONFIG.dashboardUrl}`,
    ``,
    `[${packageName}] Do NOT write real personal data — sandbox keys are`,
    `[${packageName}] public and records are visible to anyone with the`,
    `[${packageName}] sandbox read key. For production use, set:`,
    `[${packageName}]   AUDIT_API_URL    your-deployed-ledger-endpoint`,
    `[${packageName}]   AUDIT_WRITE_KEY  your-tenant-write-key`,
    `[${packageName}]   AUDIT_READ_KEY   your-tenant-read-key`,
    `[${packageName}] Deploy your own from https://github.com/shahidh68/audit-ledger`,
    `[${packageName}] ${packageVersion} ───────────────────────────────────`,
  ].join("\n");
}
