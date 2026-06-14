import assert from "node:assert/strict";
import {
  classifyRuntimeError,
  sanitizeRuntimeError
} from "../src/inference/runtimeDiagnostics.js";

assert.equal(classifyRuntimeError("Refused to evaluate a string as JavaScript because unsafe-eval is blocked."), "csp-eval-blocked");
assert.equal(classifyRuntimeError("Failed to resolve module specifier \"onnxruntime-web/webgpu\"."), "runtime-module-resolution-failed");
assert.equal(classifyRuntimeError("TypeError: S(...).webgpuInit is not a function"), "onnx-webgpu-init-failed");
assert.equal(classifyRuntimeError("WebGPU not available on this browser."), "webgpu-unavailable");
assert.equal(classifyRuntimeError("ort-wasm-simd-threaded.jsep.wasm was not found."), "wasm-asset-missing");
assert.equal(classifyRuntimeError("Failed to fetch model file from Hugging Face."), "model-data-fetch-blocked");
assert.equal(classifyRuntimeError("Privacy Filter model load timed out."), "model-load-timeout");
assert.equal(classifyRuntimeError("Transformers runtime import failed."), "transformers-import-failed");
assert.equal(classifyRuntimeError("Offscreen document unavailable."), "offscreen-unavailable");
assert.equal(classifyRuntimeError("Something else."), "unknown");

{
  const error = new Error(`x`.repeat(400));
  error.stack = "very long stack";
  const sanitized = sanitizeRuntimeError(error);

  assert.equal(sanitized.stackIncluded, false);
  assert.ok(sanitized.message.length <= 240);
  assert.equal(JSON.stringify(sanitized).includes("very long stack"), false);
}

console.log("runtimeErrorSanitizer tests passed");
