import assert from "node:assert/strict";
import {
  countEntities,
  mergeAndDedupeSpans,
  normalizeSpan,
  normalizeSpans,
  spansToEntities
} from "../src/inference/spanUtils.js";

{
  const text = "hello";
  assert.equal(normalizeSpan({ label: "private_person", start: -1, end: 2 }, text), null);
  assert.equal(normalizeSpan({ label: "private_person", start: 1, end: 9 }, text), null);
  assert.equal(normalizeSpan({ label: "private_person", start: 3, end: 3 }, text), null);
}

{
  const text = "  John Doe  ";
  const span = normalizeSpan({ label: "private_person", start: 0, end: text.length, score: 0.7, source: "mock" }, text);
  assert.deepEqual(span, {
    label: "private_person",
    start: 2,
    end: 10,
    score: 0.7,
    source: "mock"
  });
}

{
  const text = "John Doe emailed jane@example.com";
  const spans = normalizeSpans([
    { label: "private_person", start: 0, end: 8, score: 0.9, source: "mock" },
    { label: "private_email", start: 17, end: 33, score: 0.9, source: "regex" }
  ], text);
  const merged = mergeAndDedupeSpans(spans);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].label, "private_person");
  assert.equal(merged[1].label, "private_email");
}

{
  const text = "sk-abc123456789";
  const merged = mergeAndDedupeSpans([
    { label: "private_person", start: 0, end: text.length, score: 0.99, source: "mock" },
    { label: "secret", start: 0, end: text.length, score: 0.6, source: "regex" }
  ], { text });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "secret");
}

{
  const text = "John Doe";
  const merged = mergeAndDedupeSpans([
    { label: "private_person", start: 0, end: 4, score: 0.6, source: "mock" },
    { label: "private_person", start: 0, end: 8, score: 0.95, source: "mock" }
  ], { text });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 8);
}

{
  const text = "John Doe lives at 123 Main St";
  const entities = spansToEntities(text, [
    { label: "private_person", start: 0, end: 8, score: 0.9, source: "mock" },
    { label: "private_address", start: 18, end: 29, score: 0.9, source: "mock" }
  ], { sessionId: "span-test-session" });

  assert.equal(entities[0].original, "John Doe");
  assert.equal(entities[1].original, "123 Main St");
  assert.ok(entities[0].placeholder.includes("LM_PRIVATE_PERSON_SPANTEST_001"));
  assert.deepEqual(countEntities(entities), {
    private_person: 1,
    private_address: 1
  });
}

console.log("spanUtils tests passed");
