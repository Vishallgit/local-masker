import assert from "node:assert/strict";
import { analyzeContent } from "../scripts/audit-no-remote-code.mjs";
import { isSafeRelativeAssetPath } from "../src/inference/runtimeDiagnostics.js";

assert.equal(isSafeRelativeAssetPath("dist/offscreen/offscreen.bundle.js"), true);
assert.equal(isSafeRelativeAssetPath("dist/vendor/onnxruntime-web/ort.wasm"), true);
assert.equal(isSafeRelativeAssetPath("/dist/offscreen/offscreen.bundle.js"), false);
assert.equal(isSafeRelativeAssetPath("../secret"), false);
assert.equal(isSafeRelativeAssetPath("https://example.test/script.js"), false);

{
  const result = analyzeContent("<script src=\"https://cdn.example.test/a.js\"></script>", "src/test.js");
  assert.ok(result.findings.some((finding) => finding.includes("remote script tag")));
}

{
  const result = analyzeContent("const f = new Function('return 1')", "src/test.js", {
    readmeDocumentsOnnxRisk: true,
    manifestCspAllowsUnsafeEval: false
  });
  assert.ok(result.findings.some((finding) => finding.includes("new Function")));
}

{
  const result = analyzeContent("const f = new Function('return 1')", "dist/vendor/onnxruntime-web/ort.mjs", {
    readmeDocumentsOnnxRisk: true,
    manifestCspAllowsUnsafeEval: false
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings.length, 1);
}

{
  const result = analyzeContent("script-src 'self' 'unsafe-eval'", "manifest.json");
  assert.ok(result.findings.some((finding) => finding.includes("unsafe-eval")));
}

{
  const result = analyzeContent('import("onnxruntime-web/webgpu");', "dist/offscreen/offscreen.bundle.js");
  assert.ok(result.findings.some((finding) => finding.includes("unresolved dynamic-import onnxruntime-web/webgpu")));
}

console.log("buildManifest tests passed");
