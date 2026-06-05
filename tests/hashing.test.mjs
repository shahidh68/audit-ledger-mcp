/**
 * Unit tests for src/hashing.ts (run against the built dist/).
 *
 * Run from the audit-ledger-mcp root:
 *   npm run build
 *   node --test tests/hashing.test.mjs
 *
 * Covers:
 *   - HMAC path when AUDIT_HMAC_KEY is set
 *   - Plain SHA-256 fallback when AUDIT_HMAC_KEY is absent (back-compat)
 *   - One-time stderr warning on fallback
 *   - Output shape stability (64-char lowercase hex)
 *   - hashPrompt whitespace normalisation preserved across both paths
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  sha256,
  hashPii,
  hashPrompt,
  _resetFallbackWarnedForTests,
} from "../dist/hashing.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function withEnv(envOverrides, fn) {
  const prev = {};
  for (const key of Object.keys(envOverrides)) {
    prev[key] = process.env[key];
    const v = envOverrides[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function captureWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return calls;
}

// ── plain sha256 helper is unchanged ─────────────────────────────────────────

test("sha256 helper still returns plain SHA-256 hex", () => {
  const got = sha256("hello");
  const expected = createHash("sha256").update("hello", "utf8").digest("hex");
  assert.equal(got, expected);
});

// ── fallback path ────────────────────────────────────────────────────────────

test("hashPii fallback matches plain SHA-256 for back-compat", () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    captureWarn(() => {
      const got = hashPii("alice@example.com");
      const expected = createHash("sha256")
        .update("alice@example.com", "utf8")
        .digest("hex");
      assert.equal(got, expected);
    });
  });
});

test("hashPrompt fallback matches plain SHA-256 over normalised text", () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    captureWarn(() => {
      const got = hashPrompt("  hello   world\n");
      const expected = createHash("sha256")
        .update("hello world", "utf8")
        .digest("hex");
      assert.equal(got, expected);
    });
  });
});

test("fallback warns exactly once across multiple calls", () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    const warnings = captureWarn(() => {
      hashPii("one");
      hashPii("two");
      hashPrompt("three");
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /AUDIT_HMAC_KEY/);
  });
});

test("empty/whitespace AUDIT_HMAC_KEY treated as unset", () => {
  withEnv({ AUDIT_HMAC_KEY: "   " }, () => {
    _resetFallbackWarnedForTests();
    captureWarn(() => {
      const got = hashPii("x");
      assert.equal(
        got,
        createHash("sha256").update("x", "utf8").digest("hex"),
      );
    });
  });
});

// ── HMAC path ────────────────────────────────────────────────────────────────

test("hashPii uses HMAC when key set", () => {
  const key = "k".repeat(64);
  withEnv({ AUDIT_HMAC_KEY: key }, () => {
    _resetFallbackWarnedForTests();
    const got = hashPii("alice@example.com");
    const expected = createHmac("sha256", key)
      .update("alice@example.com", "utf8")
      .digest("hex");
    assert.equal(got, expected);
  });
});

test("hashPrompt uses HMAC over normalised text when key set", () => {
  const key = "secret";
  withEnv({ AUDIT_HMAC_KEY: key }, () => {
    _resetFallbackWarnedForTests();
    const got = hashPrompt("  hello   world\n");
    const expected = createHmac("sha256", key)
      .update("hello world", "utf8")
      .digest("hex");
    assert.equal(got, expected);
  });
});

test("HMAC output differs from plain SHA-256 for same input", () => {
  withEnv({ AUDIT_HMAC_KEY: "secret" }, () => {
    _resetFallbackWarnedForTests();
    const keyed = hashPii("alice@example.com");
    const plain = createHash("sha256")
      .update("alice@example.com", "utf8")
      .digest("hex");
    assert.notEqual(keyed, plain);
  });
});

test("HMAC path does not warn", () => {
  withEnv({ AUDIT_HMAC_KEY: "secret" }, () => {
    _resetFallbackWarnedForTests();
    const warnings = captureWarn(() => {
      hashPii("payload");
      hashPrompt("payload");
    });
    assert.equal(warnings.length, 0);
  });
});

// ── shape ────────────────────────────────────────────────────────────────────

test("output shape stable across both paths (64-char lowercase hex)", () => {
  for (const env of [
    { AUDIT_HMAC_KEY: undefined },
    { AUDIT_HMAC_KEY: "abc" },
  ]) {
    withEnv(env, () => {
      _resetFallbackWarnedForTests();
      captureWarn(() => {
        const out = hashPii("payload");
        assert.match(out, /^[0-9a-f]{64}$/);
      });
    });
  }
});

test("sha256 helper does not warn (unkeyed by design)", () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    const warnings = captureWarn(() => {
      sha256("payload");
    });
    assert.equal(warnings.length, 0);
  });
});
