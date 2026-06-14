import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkOffscreenBundles,
  findUnresolvedRuntimeSpecifiers,
  isSafeManifestAssetPath
} from "../scripts/check-offscreen-bundle.mjs";

{
  const findings = findUnresolvedRuntimeSpecifiers('import * as ONNX_WEB from "onnxruntime-web/webgpu";');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].specifier, "onnxruntime-web/webgpu");
}

{
  const findings = findUnresolvedRuntimeSpecifiers('const runtime = "#onnxruntime-webgpu";');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].specifier, "#onnxruntime-webgpu");
}

{
  const findings = findUnresolvedRuntimeSpecifiers('import localRuntime from "./vendor/ort.webgpu.min.mjs";');
  assert.equal(findings.length, 0);
}

assert.equal(isSafeManifestAssetPath("dist/offscreen/offscreen.bundle.js"), true);
assert.equal(isSafeManifestAssetPath("dist/vendor/transformers/transformers.web.js"), true);
assert.equal(isSafeManifestAssetPath("/dist/offscreen/offscreen.bundle.js"), false);
assert.equal(isSafeManifestAssetPath("../dist/offscreen/offscreen.bundle.js"), false);
assert.equal(isSafeManifestAssetPath("chrome-extension://extension/dist/offscreen/offscreen.bundle.js"), false);

{
  const root = mkdtempSync(join(tmpdir(), "local-masker-bundle-check-"));
  try {
    mkdirSync(join(root, "dist", "offscreen"), { recursive: true });
    mkdirSync(join(root, "dist", "vendor", "transformers"), { recursive: true });
    writeFileSync(join(root, "dist", "offscreen", "offscreen.bundle.js"), 'import("./local.js");');
    writeFileSync(join(root, "dist", "vendor", "transformers", "transformers.web.js"), 'import("onnxruntime-web");');

    const result = checkOffscreenBundles(root);
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].specifier, "onnxruntime-web");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("offscreenBundleCheck tests passed");
