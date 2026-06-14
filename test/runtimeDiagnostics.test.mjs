import assert from "node:assert/strict";
import {
  hasForbiddenDiagnosticKey,
  sanitizeDiagnosticsReport
} from "../src/inference/runtimeDiagnostics.js";

const unsafe = {
  ok: true,
  text: "raw user text",
  prompt: "raw prompt",
  editor: "raw editor",
  pageContent: "raw page content",
  nested: {
    value: "editor value",
    innerText: "editor inner text",
    textContent: "editor text",
    maskedText: "masked",
    original: "secret",
    originals: ["secret"],
    entities: [{ original: "secret" }],
    vault: { a: "b" },
    safe: "ok"
  }
};

const sanitized = sanitizeDiagnosticsReport(unsafe);
assert.equal(hasForbiddenDiagnosticKey(sanitized), false);
assert.equal(sanitized.nested.safe, "ok");
assert.equal(JSON.stringify(sanitized).includes("raw user text"), false);
assert.equal(JSON.stringify(sanitized).includes("secret"), false);

{
  const report = sanitizeDiagnosticsReport({
    error: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/path"
  });

  assert.equal(report.error.includes("chrome-extension://<extension>"), true);
  assert.equal(report.error.includes("abcdefghijklmnopqrstuvwxyzabcdef"), false);
}

console.log("runtimeDiagnostics tests passed");
