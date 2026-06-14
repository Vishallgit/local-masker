import assert from "node:assert/strict";
import {
  classifyWebGPUProbeFailure,
  probeWebGPU,
  sanitizeWebGPUProbeResult,
  summarizeWebGPUProbe
} from "../src/inference/webgpuDiagnostics.js";

{
  const result = await probeWebGPU({
    contextLabel: "offscreen",
    gpu: null
  });

  assert.equal(result.ok, false);
  assert.equal(result.navigatorGpuPresent, false);
  assert.equal(result.errorCategory, "navigator-gpu-missing");
  assert.equal(classifyWebGPUProbeFailure(result), "navigator-gpu-missing");
}

{
  const result = await probeWebGPU({
    contextLabel: "content",
    gpu: {
      requestAdapter: async () => null
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.navigatorGpuPresent, true);
  assert.equal(result.requestAdapterDefault.adapterReturned, false);
  assert.equal(classifyWebGPUProbeFailure(result), "adapter-null");
}

{
  const result = await probeWebGPU({
    contextLabel: "offscreen",
    gpu: {
      requestAdapter: async () => ({
        features: new Set(["shader-f16"]),
        limits: {},
        requestDevice: async () => {
          throw new Error("requestDevice failed");
        }
      })
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.requestAdapterDefault.adapterReturned, true);
  assert.equal(result.requestAdapterDefault.hasShaderF16, true);
  assert.equal(result.requestAdapterDefault.requestDeviceOk, false);
  assert.equal(classifyWebGPUProbeFailure(result), "request-device-failed");
}

{
  const result = await probeWebGPU({
    contextLabel: "offscreen",
    gpu: {
      requestAdapter: async () => ({
        features: new Set(),
        limits: {},
        requestDevice: async () => ({ destroy() {} })
      })
    }
  });
  const summary = summarizeWebGPUProbe(result);

  assert.equal(result.ok, true);
  assert.equal(summary.adapterReturned, true);
  assert.equal(summary.requestDeviceOk, true);
  assert.equal(summary.unsafeFlagRecommendedForDevOnly, false);
}

{
  const sanitized = sanitizeWebGPUProbeResult({
    ok: false,
    contextLabel: "offscreen",
    vendor: "sensitive vendor",
    deviceId: "sensitive device",
    adapterInfo: {
      description: "specific gpu"
    },
    nested: {
      safe: true,
      text: "raw text",
      prompt: "raw prompt",
      value: "raw value",
      innerText: "raw innerText",
      textContent: "raw textContent",
      maskedText: "masked",
      original: "secret",
      originals: ["secret"],
      entities: [{ original: "secret" }],
      vault: { secret: "value" },
      editor: "raw editor",
      pageContent: "raw page"
    }
  });

  const serialized = JSON.stringify(sanitized);
  assert.equal(sanitized.nested.safe, true);
  assert.equal(serialized.includes("sensitive vendor"), false);
  assert.equal(serialized.includes("specific gpu"), false);
  assert.equal(serialized.includes("raw prompt"), false);
  assert.equal(serialized.includes("secret"), false);
}

console.log("webgpuDiagnostics tests passed");
