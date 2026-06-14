import assert from "node:assert/strict";
import {
  classifyRuntimeError,
  hasForbiddenDiagnosticKey,
  sanitizeDiagnosticsReport,
  sanitizeRuntimeError
} from "../src/inference/runtimeDiagnostics.js";
import {
  extractRuntimeSpecifierFromMessage,
  isRuntimeSpecifierResolutionError
} from "../src/inference/runtimeSpecifierChecks.js";

const moduleResolutionError = 'Failed to resolve module specifier "onnxruntime-web/webgpu". Relative references must start with either "/", "./", or "../".';
assert.equal(classifyRuntimeError(moduleResolutionError), "runtime-module-resolution-failed");
assert.equal(isRuntimeSpecifierResolutionError(moduleResolutionError), true);
assert.equal(extractRuntimeSpecifierFromMessage(moduleResolutionError), "onnxruntime-web/webgpu");

{
  const sanitized = sanitizeRuntimeError(new Error(`${moduleResolutionError} ${"x".repeat(400)}`));
  assert.equal(sanitized.category, "runtime-module-resolution-failed");
  assert.equal(sanitized.stackIncluded, false);
  assert.ok(sanitized.message.length <= 240);
  assert.equal(sanitized.message.includes("onnxruntime-web/webgpu"), true);
}

{
  const report = sanitizeDiagnosticsReport({
    ok: false,
    editor: "raw editor surface",
    pageContent: "raw page content",
    nested: {
      prompt: "raw prompt",
      text: "raw text",
      value: "raw value",
      innerText: "raw innerText",
      textContent: "raw textContent",
      maskedText: "masked text",
      original: "secret",
      originals: ["secret"],
      entities: [{ original: "secret" }],
      vault: { secret: "value" },
      safe: "kept"
    }
  });

  assert.equal(hasForbiddenDiagnosticKey(report), false);
  assert.equal(report.nested.safe, "kept");
  assert.equal(JSON.stringify(report).includes("raw editor surface"), false);
  assert.equal(JSON.stringify(report).includes("secret"), false);
}

console.log("runtimeResolution tests passed");
