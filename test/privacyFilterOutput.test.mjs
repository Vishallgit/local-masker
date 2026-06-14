import assert from "node:assert/strict";
import {
  normalizePrivacyFilterOutput,
  resolveDetectedTextOffset
} from "../src/inference/spanUtils.js";

{
  const text = "Email Jane Smith at jane@example.com.";
  const spans = normalizePrivacyFilterOutput([
    { entity_group: "PRIVATE_PERSON", start: 6, end: 16, score: 0.91, word: "Jane Smith" }
  ], text);

  assert.deepEqual(spans, [
    {
      label: "private_person",
      start: 6,
      end: 16,
      score: 0.91,
      source: "privacy-filter"
    }
  ]);
}

{
  const text = "John Doe met John Doe again.";
  const spans = normalizePrivacyFilterOutput([
    { entity_group: "person", word: "John Doe", score: 0.8 },
    { entity_group: "person", word: "John Doe", score: 0.7 }
  ], text);

  assert.equal(spans.length, 2);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[1].start, 13);
}

{
  const text = "A token was present.";
  const spans = normalizePrivacyFilterOutput([
    { entity_group: "O", word: "A", score: 0.99 },
    { entity_group: "background", word: "token", score: 0.99 },
    { entity_group: "unknown_label", word: "present", score: 0.99 }
  ], text);

  assert.deepEqual(spans, []);
}

{
  const text = "Call 555-111-2222 or visit https://example.test.";
  const spans = normalizePrivacyFilterOutput([
    { entity_group: "PHONE_NUMBER", word: "555-111-2222", score: 0.88 },
    { entity_group: "URL", word: "https://example.test", score: 0.77 }
  ], text);

  assert.equal(spans[0].label, "private_phone");
  assert.equal(spans[1].label, "private_url");
}

{
  const text = "The email is a@example.com.";
  assert.deepEqual(resolveDetectedTextOffset(text, "missing@example.com"), null);
}

{
  const text = "Secret sk-abc123456789 remains private.";
  const spans = normalizePrivacyFilterOutput([
    { entity_group: "api_key", start: 7, end: 23, score: 0.9 }
  ], text);

  assert.equal(spans[0].label, "secret");
  assert.equal(spans[0].source, "privacy-filter");

  const serialized = JSON.stringify({
    ok: false,
    provider: "privacy-filter",
    modelStatus: { provider: "privacy-filter", loaded: false },
    error: "Privacy Filter model is not loaded."
  });

  assert.equal(serialized.includes("sk-abc123456789"), false);
}

console.log("privacyFilterOutput tests passed");
