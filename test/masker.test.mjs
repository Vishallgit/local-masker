import assert from "node:assert/strict";
import { maskText } from "../src/shared/masker.js";
import {
  getSiteAdapter,
  sanitizeIdentifierToken,
  scoreCandidateMetadata
} from "../src/siteAdapters.js";

const sessionId = "test-session-123456";
const placeholderPattern = /\u27E6LM_[A-Z_]+_TESTSESS_\d{3}\u27E7/;

function mask(input, options = {}) {
  return maskText(input, { sessionId, ...options });
}

function assertMasked(input, label, original) {
  const result = mask(input);
  assert.equal(result.detectedCounts[label], 1);
  assert.match(result.maskedText, placeholderPattern);
  assert.ok(result.maskedText.includes(`LM_${label.toUpperCase()}_`));
  assert.ok(!result.maskedText.includes(original));
  assert.ok(result.entities.some((entity) => entity.label === label && entity.original === original));
  return result;
}

{
  assertMasked("Email john@example.com today.", "private_email", "john@example.com");
}

{
  assertMasked("Call +1 (555) 123-4567 tomorrow.", "private_phone", "+1 (555) 123-4567");
}

{
  assertMasked("Visit https://example.com/private?q=1.", "private_url", "https://example.com/private?q=1");
}

{
  assertMasked("Use key sk-abc123456789.", "secret", "sk-abc123456789");
}

{
  assertMasked("AWS key AKIA1234567890ABCDEF is active.", "secret", "AKIA1234567890ABCDEF");
}

{
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assertMasked(`JWT ${jwt}`, "secret", jwt);
}

{
  assertMasked("api_key = abc123XYZ789", "secret", "abc123XYZ789");
}

{
  assertMasked("Account 1234-5678-9012 is the billing account.", "account_number", "1234-5678-9012");
}

{
  const result = mask("Dates: 2026-05-19, 19/05/2026, 05/19/2026, May 19, 2026.");
  assert.equal(result.detectedCounts.private_date, 4);
  assert.ok(!result.maskedText.includes("2026-05-19"));
  assert.ok(!result.maskedText.includes("19/05/2026"));
  assert.ok(!result.maskedText.includes("05/19/2026"));
  assert.ok(!result.maskedText.includes("May 19, 2026"));
}

{
  const result = mask("Send sk-abc123456789@example.com to nobody.");
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].label, "secret");
  assert.ok(result.maskedText.includes("@example.com"));
  assert.ok(!result.maskedText.includes("sk-abc123456789"));
}

{
  const input = "Email john@example.com and use key sk-abc123456789. Account 1234-5678-9012.";
  const result = mask(input);
  assert.deepEqual(result.detectedCounts, {
    private_email: 1,
    secret: 1,
    account_number: 1
  });
  assert.ok(result.maskedText.includes("\u27E6LM_PRIVATE_EMAIL_TESTSESS_001\u27E7"));
  assert.ok(result.maskedText.includes("\u27E6LM_SECRET_TESTSESS_002\u27E7"));
  assert.ok(result.maskedText.includes("\u27E6LM_ACCOUNT_NUMBER_TESTSESS_003\u27E7"));
  assert.ok(!result.maskedText.includes("john@example.com"));
  assert.ok(!result.maskedText.includes("sk-abc123456789"));
  assert.ok(!result.maskedText.includes("1234-5678-9012"));
}

{
  const original = "john@example.com";
  const result = mask(`Contact ${original}`);
  assert.ok(result.entities.some((entity) => entity.original === original));
  assert.ok(!result.maskedText.includes(original));
}

{
  const result = mask("token: 1234567890123456 expires on 2026-05-19");
  assert.equal(result.detectedCounts.secret, 1);
  assert.equal(result.detectedCounts.private_date, 1);
  assert.equal(result.detectedCounts.account_number, undefined);
  assert.ok(!result.maskedText.includes("1234567890123456"));
  assert.ok(!result.maskedText.includes("2026-05-19"));
}

{
  const result = mask("Open https://example.com/users/12345678?date=2026-05-19.");
  assert.ok(result.entities.length >= 1);
  assert.ok(result.maskedText.includes("LM_"));
  assert.ok(!result.maskedText.includes("https://example.com/users/12345678?date=2026-05-19"));
}

{
  const result = mask("Invoice 2026-05-19 is not account 8765-4321-0000.");
  assert.equal(result.detectedCounts.private_date, 1);
  assert.equal(result.detectedCounts.account_number, 1);
  assert.ok(!result.maskedText.includes("2026-05-19"));
  assert.ok(!result.maskedText.includes("8765-4321-0000"));
}

{
  const result = mask("John Doe lives at 123 Main St.", {
    externalSpans: [
      { label: "private_person", start: 0, end: 8, score: 0.9, source: "mock" },
      { label: "private_address", start: 18, end: 29, score: 0.9, source: "mock" }
    ],
    externalSource: "mock"
  });

  assert.equal(result.detectedCounts.private_person, 1);
  assert.equal(result.detectedCounts.private_address, 1);
  assert.equal(result.sources.mock, 2);
  assert.ok(!result.maskedText.includes("John Doe"));
  assert.ok(!result.maskedText.includes("123 Main St"));
}

{
  const input = "John Doe emailed john@example.com using key sk-abc123456789.";
  const result = mask(input, {
    externalSpans: [
      { label: "private_person", start: 0, end: 8, score: 0.9, source: "mock" }
    ],
    externalSource: "mock"
  });

  assert.equal(result.detectedCounts.private_person, 1);
  assert.equal(result.detectedCounts.private_email, 1);
  assert.equal(result.detectedCounts.secret, 1);
  assert.equal(result.sources.mock, 1);
  assert.equal(result.sources.regex, 2);
  assert.ok(!result.maskedText.includes("John Doe"));
  assert.ok(!result.maskedText.includes("john@example.com"));
  assert.ok(!result.maskedText.includes("sk-abc123456789"));
}

{
  const input = "Account 1234-5678-9012 belongs to John Doe.";
  const result = mask(input, {
    externalSpans: [
      { label: "private_person", start: 8, end: 22, score: 0.99, source: "mock" }
    ],
    externalSource: "mock"
  });

  assert.equal(result.detectedCounts.account_number, 1);
  assert.equal(result.detectedCounts.private_person, undefined);
  assert.ok(!result.maskedText.includes("1234-5678-9012"));
}

{
  assert.equal(getSiteAdapter("chatgpt.com").name, "chatgpt");
  assert.equal(getSiteAdapter("chat.openai.com").name, "chatgpt");
  assert.equal(getSiteAdapter("claude.ai").name, "claude");
  assert.equal(getSiteAdapter("gemini.google.com").name, "gemini");
  assert.equal(getSiteAdapter("127.0.0.1").name, "local-fixture");
  assert.equal(getSiteAdapter("example.com").name, "generic");
}

{
  assert.equal(sanitizeIdentifierToken("fixture-textarea"), "fixture-textarea");
  assert.equal(sanitizeIdentifierToken("prompt text with spaces"), "");
  assert.equal(sanitizeIdentifierToken("123-starts-with-number"), "");
  assert.equal(sanitizeIdentifierToken("safe_token_name", 8), "safe_tok");
}

{
  const good = scoreCandidateMetadata({
    visible: true,
    disabled: false,
    readOnly: false,
    ariaHidden: false,
    targetKind: "textarea",
    viewportPosition: "visible",
    pageBottomRatio: 0.9,
    safeSelectorHint: "textarea#fixture-textarea"
  }, 50);

  const bad = scoreCandidateMetadata({
    visible: false,
    disabled: true,
    readOnly: false,
    ariaHidden: true,
    targetKind: "textarea",
    viewportPosition: "offscreen",
    pageBottomRatio: 0,
    safeSelectorHint: "textarea#fixture-hidden-textarea"
  }, 50);

  assert.ok(good > bad);
}

console.log("masker tests passed");
