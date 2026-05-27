# audit-ledger-mcp

**MCP server for the [AI Audit Ledger](https://github.com/shahidh68/audit-ledger).** Lets any AI agent — Claude Desktop, Cursor, LangGraph, custom — record decisions to a tamper-evident audit trail with one line of config.

Built for teams shipping AI in regulated contexts: EU AI Act Article 12 logging, FCA SS1/23 model risk evidence, GDPR data minimisation. Personal data is hashed locally before any payload leaves the server — the ledger only ever sees fingerprints.

[![npm](https://img.shields.io/npm/v/audit-ledger-mcp.svg)](https://www.npmjs.com/package/audit-ledger-mcp) [![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE) [![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed.svg)](https://modelcontextprotocol.io)

**[Try the live dashboard →](https://d2pfirb2397ixy.cloudfront.net/?demo=1)** &nbsp;&middot;&nbsp; 30 synthetic decisions written via this MCP server, queryable and verifiable.

<p align="center">
  <img src="./demo.gif" alt="LangGraph agents using audit-ledger-mcp — triage, risk, and human-in-the-loop each calling record_decision" />
</p>

> A LangGraph workflow calls `record_decision` after each agent step. Three audit events written to the live ledger; every one independently verifiable.

---

## What it does

Exposes three tools to any MCP-compatible agent:

| Tool | What it does |
|---|---|
| `record_decision` | Log an AI decision. Hashes inputs locally, then writes through to the ledger. Returns an event ID. |
| `verify_decision` | Cross-check a stored record against the immutable S3 Object Lock copy. Returns `integrity_verified: true/false`. |
| `list_decisions` | Query recent decisions, optionally filtered by time window. Tenant-scoped by API key. |

Each call ends up as a regulator-grade audit record in your deployed ledger — DynamoDB for query, S3 Object Lock COMPLIANCE mode for the immutable copy, 7-year retention by default.

---

## Install

```bash
npm install -g audit-ledger-mcp
```

Or run on demand without installing:

```bash
npx -y audit-ledger-mcp
```

---

## Configure

The server reads its configuration from environment variables. You need a deployed [AI Audit Ledger](https://github.com/shahidh68/audit-ledger) (or access to one) with at least one tenant write key and read key provisioned in Secrets Manager.

```bash
# Required
export AUDIT_API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/prod"
export AUDIT_WRITE_KEY="<your-tenant-write-key>"
export AUDIT_READ_KEY="<your-tenant-read-key>"

# Optional
export AUDIT_TIMEOUT_MS=5000        # default 5000
export AUDIT_RETRY_ATTEMPTS=3       # default 3
```

The full template lives in [`.env.example`](./.env.example).

---

## Wire it into an agent

### Claude Desktop

Edit your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "audit-ledger": {
      "command": "npx",
      "args": ["-y", "audit-ledger-mcp"],
      "env": {
        "AUDIT_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com/prod",
        "AUDIT_WRITE_KEY": "<your-tenant-write-key>",
        "AUDIT_READ_KEY": "<your-tenant-read-key>"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see "audit-ledger" in the MCP tools menu. Ask Claude something like *"Record this decision: I declined the application because…"* and watch it call `record_decision` automatically.

### Cursor

In Cursor settings → MCP → add server:

```json
{
  "mcpServers": {
    "audit-ledger": {
      "command": "npx",
      "args": ["-y", "audit-ledger-mcp"],
      "env": {
        "AUDIT_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com/prod",
        "AUDIT_WRITE_KEY": "<your-tenant-write-key>",
        "AUDIT_READ_KEY": "<your-tenant-read-key>"
      }
    }
  }
}
```

### LangGraph (Python)

Using [`langchain-mcp-adapters`](https://github.com/langchain-ai/langchain-mcp-adapters):

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic
import os

client = MultiServerMCPClient({
    "audit-ledger": {
        "command": "npx",
        "args": ["-y", "audit-ledger-mcp"],
        "transport": "stdio",
        "env": {
            "AUDIT_API_URL": os.environ["AUDIT_API_URL"],
            "AUDIT_WRITE_KEY": os.environ["AUDIT_WRITE_KEY"],
            "AUDIT_READ_KEY": os.environ["AUDIT_READ_KEY"],
        },
    }
})

tools = await client.get_tools()
agent = create_react_agent(
    ChatAnthropic(model="claude-sonnet-4-7-20251022"),
    tools,
)

# The agent can now call record_decision, verify_decision, list_decisions
result = await agent.ainvoke({
    "messages": [{"role": "user", "content": "Triage this loan application…"}]
})
```

### Custom client (raw MCP)

```bash
AUDIT_API_URL=... AUDIT_WRITE_KEY=... npx -y audit-ledger-mcp
```

The server speaks MCP over stdio. Send `initialize`, `tools/list`, and `tools/call` requests per the [MCP specification](https://modelcontextprotocol.io/specification).

---

## How a `record_decision` call flows

```
Agent                  audit-ledger-mcp                  AWS (your ledger)
  |                          |                                 |
  |--- record_decision ----->|                                 |
  |   raw_user_input         | (hash locally — no PII over     |
  |   raw_system_prompt      |  the wire from this point)      |
  |   decision_output        |                                 |
  |   human_in_loop          |                                 |
  |                          |--- HTTPS POST /audit/events --->|
  |                          |    {hashes + decision +         |
  |                          |     x-api-key}                  |
  |                          |                                 |
  |                          |<--- 202 Accepted ---------------|
  |                          |    { event_id, ... }            |
  |<--- event_id ------------|                                 |
  |     recorded_at          |                                 |
  |     note                 |                                 |
```

Storage on the AWS side happens asynchronously through SQS → Processor Lambda → DynamoDB + S3 Object Lock. See the [main repo's ARCHITECTURE.md](https://github.com/shahidh68/audit-ledger/blob/main/ARCHITECTURE.md) for the full path.

---

## Tool reference

### `record_decision`

Record an AI decision to the ledger.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `model_version` | string | Yes | e.g. `"claude-sonnet-4-7-20251022"` |
| `raw_system_prompt` | string | Yes | Hashed locally |
| `raw_user_input` | string | Yes | Hashed locally |
| `ai_decision_output` | object | Yes | Stored verbatim — must not contain raw PII |
| `human_in_loop` | boolean | Yes | Critical for EU AI Act Article 14 |
| `event_id` | uuid v4 | No | Auto-generated if omitted |
| `timestamp` | ISO 8601 | No | Defaults to now |

### `verify_decision`

Tamper-check a stored record.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `event_id` | uuid v4 | Yes | The ID of the record to verify |

Returns the DynamoDB record, the S3 record, and `integrity_verified: true/false`.

### `list_decisions`

List recent decisions for the calling tenant.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `from` | ISO 8601 | No | Defaults to 7 days ago |
| `to` | ISO 8601 | No | Defaults to now |
| `limit` | integer 1–500 | No | Defaults to 100 |

---

## Security

- **PII hashing happens in this process, not in the ledger.** SHA-256 over UTF-8. The ledger only ever stores hashes, the structured decision, and metadata.
- **API keys are never logged.** They come from environment variables, are passed in the `x-api-key` header, and are never echoed back to the agent or written to disk.
- **Two key namespaces.** Write keys cannot read; read keys cannot write. A leaked write key cannot exfiltrate data; a leaked read key cannot plant fake records.
- **Errors are propagated with HTTP status passthrough.** Rate limit, invalid key, and validation errors surface to the agent so it can react appropriately rather than retry blindly.

---

## What this is not

- **Not legal advice.** This is infrastructure that produces audit evidence. Whether that evidence satisfies any specific regulatory obligation is a question for your legal team.
- **Not a substitute for a model risk audit.** It records what the AI did, not whether it was right.
- **Not a bias or fairness testing tool.** It is the audit layer underneath whatever testing you already do.

---

## Development

```bash
git clone https://github.com/shahidh68/audit-ledger-mcp.git
cd audit-ledger-mcp
npm install
npm run build
npm test
```

The server is TypeScript on Node 20+, ESM, stdio transport, using `@modelcontextprotocol/sdk`.

---

## Related

- **[shahidh68/audit-ledger](https://github.com/shahidh68/audit-ledger)** — the AWS infrastructure this server talks to. CDK stack, Python and Node SDKs, compliance dashboard, full architecture documentation.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

The patent grant is intentional. Compliance infrastructure sits adjacent to enterprise legal review and the explicit grant matters there.

---

## Author

Built by [Shahid](https://github.com/shahidh68). Available for Principal AI Engineering and Head of AI Engineering roles, and fractional advisory engagements, in UK regulated fintech.
