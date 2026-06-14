import assert from "node:assert/strict";
import { runInference } from "../src/inference/inferenceEngine.js";

{
  const result = await runInference("John Doe visited 123 Main St.", { providerPreference: "regex-only" });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "regex-only");
  assert.deepEqual(result.spans, []);
}

{
  const text = "John Doe visited 123 Main St.";
  const original = text.slice();
  const result = await runInference(text, { providerPreference: "mock" });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "mock");
  assert.equal(result.modelStatus.provider, "mock");
  assert.equal(result.modelStatus.loaded, true);
  assert.equal(text, original);
}

{
  const result = await runInference("John Doe emailed nobody.", { providerPreference: "mock" });
  assert.ok(result.spans.some((span) => span.label === "private_person" && span.source === "mock"));
}

{
  const result = await runInference("Meet at 123 Main St tomorrow.", { providerPreference: "mock" });
  assert.ok(result.spans.some((span) => span.label === "private_address" && span.source === "mock"));
}

{
  const result = await runInference("John Doe emailed nobody.", { providerPreference: "privacy-filter" });
  assert.equal(result.ok, false);
  assert.equal(result.provider, "privacy-filter");
  assert.deepEqual(result.spans, []);
  assert.match(result.error, /not loaded/i);
}

{
  const result = await runInference("John Doe emailed nobody.", { providerPreference: "auto" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "mock");
  assert.ok(result.warnings?.some((warning) => /not auto-loaded/i.test(warning)));
}

console.log("inferenceEngine tests passed");
