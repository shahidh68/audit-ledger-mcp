/**
 * HTTP client for the AI Audit Ledger API.
 *
 * Mirrors the retry behaviour of the Python SDK in the main repo: exponential
 * backoff with full jitter, retry on network errors and 5xx only. 4xx (including
 * 429) returns immediately because retrying a rate-limited or auth-failed
 * request just burns quota.
 */

export interface ClientConfig {
  apiUrl: string;
  writeKey?: string;
  readKey?: string;
  timeoutMs?: number;
  retryAttempts?: number;
}

export class AuditLedgerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(`[audit-ledger] ${message}`);
    this.name = "AuditLedgerError";
  }
}

export interface DecisionRecord {
  event_id: string;
  timestamp: string;
  tenant_id?: string;
  model_version: string;
  system_prompt_hash: string;
  input_data_hash: string;
  ai_decision_output: Record<string, unknown>;
  human_in_loop: boolean;
}

export interface TamperCheckResult {
  integrity_verified: boolean;
  note: string;
  dynamodb_record: DecisionRecord;
  s3_record: DecisionRecord;
}

export class AuditLedgerClient {
  private readonly apiUrl: string;
  private readonly writeKey?: string;
  private readonly readKey?: string;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;

  constructor(config: ClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.writeKey = config.writeKey;
    this.readKey = config.readKey;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.retryAttempts = config.retryAttempts ?? 3;
  }

  async recordDecision(payload: Omit<DecisionRecord, "tenant_id">): Promise<{ event_id: string }> {
    if (!this.writeKey) {
      throw new AuditLedgerError("AUDIT_WRITE_KEY is not set — record_decision unavailable");
    }
    const res = await this.fetchWithRetry(`${this.apiUrl}/audit/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-api-key": this.writeKey,
      },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 && res.status !== 202) {
      throw new AuditLedgerError(
        `record_decision failed: HTTP ${res.status}`,
        res.status,
        await safeText(res),
      );
    }
    const data = await safeJson(res);
    return { event_id: (data?.event_id as string) ?? payload.event_id };
  }

  async verifyDecision(eventId: string): Promise<TamperCheckResult> {
    if (!this.readKey) {
      throw new AuditLedgerError("AUDIT_READ_KEY is not set — verify_decision unavailable");
    }
    const url = `${this.apiUrl}/audit/events/${encodeURIComponent(eventId)}/history`;
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: { "Accept": "application/json", "x-api-key": this.readKey },
    });
    if (res.status !== 200) {
      throw new AuditLedgerError(
        `verify_decision failed: HTTP ${res.status}`,
        res.status,
        await safeText(res),
      );
    }
    return (await res.json()) as TamperCheckResult;
  }

  async listDecisions(opts: { from?: string; to?: string }): Promise<DecisionRecord[]> {
    if (!this.readKey) {
      throw new AuditLedgerError("AUDIT_READ_KEY is not set — list_decisions unavailable");
    }
    const params = new URLSearchParams();
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    const url = `${this.apiUrl}/audit/logs${params.toString() ? `?${params}` : ""}`;
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: { "Accept": "application/json", "x-api-key": this.readKey },
    });
    if (res.status !== 200) {
      throw new AuditLedgerError(
        `list_decisions failed: HTTP ${res.status}`,
        res.status,
        await safeText(res),
      );
    }
    const data: unknown = await res.json();
    if (Array.isArray(data)) return data as DecisionRecord[];
    if (data && typeof data === "object" && "items" in data && Array.isArray((data as { items: unknown }).items)) {
      return (data as { items: DecisionRecord[] }).items;
    }
    return [];
  }

  /**
   * Exponential backoff with full jitter. Retries network errors and 5xx only.
   * 4xx is returned to the caller immediately.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(url, { ...init, signal: controller.signal });
          if (res.status < 500) return res;
          lastErr = new AuditLedgerError(`HTTP ${res.status}`, res.status, await safeText(res));
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
      }
      if (attempt < this.retryAttempts - 1) {
        const baseMs = 200;
        const jitter = Math.random() * baseMs;
        const delay = baseMs * 2 ** attempt + jitter;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new AuditLedgerError("retry attempts exhausted");
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
}
