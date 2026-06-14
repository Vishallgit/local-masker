import assert from "node:assert/strict";

let listener;
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(callback) {
        listener = callback;
      }
    }
  }
};

await import("../src/offscreen/offscreen.js");

assert.equal(typeof listener, "function");

function sendToOffscreen(message) {
  return new Promise((resolve) => {
    const asyncResponse = listener(message, {}, resolve);
    if (!asyncResponse) {
      resolve(undefined);
    }
  });
}

{
  const response = await sendToOffscreen({
    type: "LM_OFFSCREEN_STATUS",
    requestId: "status-1"
  });

  assert.equal(response.type, "LM_OFFSCREEN_STATUS_RESULT");
  assert.equal(response.requestId, "status-1");
  assert.equal(response.ok, true);
  assert.equal(response.provider, "mock");
  assert.equal(response.activeProvider, "mock");
  assert.equal(response.modelStatus.mock.loaded, true);
  assert.equal(response.modelStatus.privacyFilter.provider, "privacy-filter");
}

{
  const response = await sendToOffscreen({
    type: "LM_OFFSCREEN_INFER",
    requestId: "infer-1",
    text: "John Doe visited 123 Main St.",
    options: {
      providerPreference: "mock"
    }
  });

  assert.equal(response.type, "LM_OFFSCREEN_INFER_RESULT");
  assert.equal(response.requestId, "infer-1");
  assert.equal(response.ok, true);
  assert.equal(response.provider, "mock");
  assert.ok(response.spans.some((span) => span.label === "private_person"));
  assert.ok(response.spans.some((span) => span.label === "private_address"));
}

{
  const response = await sendToOffscreen({
    type: "LM_OFFSCREEN_LOAD_MODEL",
    requestId: "load-1",
    options: {}
  });

  assert.equal(response.type, "LM_OFFSCREEN_LOAD_MODEL_RESULT");
  assert.equal(response.requestId, "load-1");
  assert.equal(response.provider, "privacy-filter");
  assert.equal(response.ok, false);
  assert.equal(response.modelStatus.loaded, false);
}

{
  const response = await sendToOffscreen({
    type: "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS",
    requestId: "runtime-1"
  });

  assert.equal(response.type, "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS_RESULT");
  assert.equal(response.requestId, "runtime-1");
  assert.equal(typeof response.diagnostics, "object");
  assert.equal(JSON.stringify(response).includes("Harry Potter"), false);
}

{
  const response = await sendToOffscreen({
    type: "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST",
    requestId: "smoke-1",
    options: {}
  });

  const serialized = JSON.stringify(response);
  assert.equal(response.type, "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST_RESULT");
  assert.equal(response.requestId, "smoke-1");
  assert.equal(response.ok, false);
  assert.equal(response.loaded, false);
  assert.equal(response.inferenceRan, false);
  assert.equal(serialized.includes("Harry Potter"), false);
  assert.equal(serialized.includes("harry.potter@hogwarts.edu"), false);
  assert.equal(serialized.includes("sk-abc123456789"), false);
}

console.log("offscreen tests passed");
