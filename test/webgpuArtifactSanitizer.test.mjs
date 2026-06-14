import assert from "node:assert/strict";
import { hasForbiddenArtifactKey, sanitizeE2eArtifact } from "../scripts/e2eArtifactSanitizer.mjs";
import { sanitizeWebGPUProbeResult } from "../src/inference/webgpuDiagnostics.js";

const forbiddenPayload = {
  reportType: "webgpu-probe",
  text: "Harry Potter",
  prompt: "harry.potter@hogwarts.edu",
  value: "123 Main St",
  innerText: "sk-abc123456789",
  textContent: "john@example.com",
  maskedText: "1234-5678-9012",
  original: "Harry Potter",
  originals: ["harry.potter@hogwarts.edu"],
  entities: [{ original: "123 Main St" }],
  vault: { secret: "sk-abc123456789" },
  editor: "john@example.com",
  pageContent: "1234-5678-9012",
  probe: {
    ok: false,
    contextLabel: "offscreen",
    navigatorGpuPresent: true,
    vendor: "specific vendor",
    deviceId: "specific device"
  }
};

const sanitized = sanitizeE2eArtifact(sanitizeWebGPUProbeResult(forbiddenPayload));
const serialized = JSON.stringify(sanitized);

assert.equal(hasForbiddenArtifactKey(sanitized), false);
assert.equal(serialized.includes("Harry Potter"), false);
assert.equal(serialized.includes("harry.potter@hogwarts.edu"), false);
assert.equal(serialized.includes("123 Main St"), false);
assert.equal(serialized.includes("sk-abc123456789"), false);
assert.equal(serialized.includes("john@example.com"), false);
assert.equal(serialized.includes("1234-5678-9012"), false);
assert.equal(serialized.includes("specific vendor"), false);
assert.equal(serialized.includes("specific device"), false);
assert.equal(sanitized.probe.navigatorGpuPresent, true);

console.log("webgpuArtifactSanitizer tests passed");
