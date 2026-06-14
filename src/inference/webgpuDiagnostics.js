const FORBIDDEN_WEBGPU_KEYS = new Set([
  "text",
  "prompt",
  "value",
  "innertext",
  "textcontent",
  "maskedtext",
  "original",
  "originals",
  "entities",
  "vault",
  "editor",
  "pagecontent"
]);

const HARDWARE_IDENTIFYING_KEYS = new Set([
  "adapterinfo",
  "architecture",
  "description",
  "deviceid",
  "driver",
  "driverinfo",
  "name",
  "vendor",
  "vendorid"
]);

const ADAPTER_PROBES = [
  ["requestAdapterDefault", undefined],
  ["requestAdapterLowPower", { powerPreference: "low-power" }],
  ["requestAdapterHighPerformance", { powerPreference: "high-performance" }]
];

export async function probeWebGPU(options = {}) {
  const startedAt = now();
  const contextLabel = sanitizeContextLabel(options.contextLabel || "unknown");
  const gpu = options.gpu ?? (typeof navigator !== "undefined" ? navigator.gpu : undefined);
  const result = {
    ok: false,
    contextLabel,
    navigatorGpuPresent: Boolean(gpu),
    requestAdapterDefault: createNotAttemptedProbe(),
    requestAdapterLowPower: createNotAttemptedProbe(),
    requestAdapterHighPerformance: createNotAttemptedProbe(),
    elapsedMs: 0,
    errorCategory: "",
    errorMessage: ""
  };

  if (!gpu?.requestAdapter) {
    result.errorCategory = "navigator-gpu-missing";
    result.errorMessage = "navigator.gpu is unavailable in this context.";
    result.elapsedMs = elapsedSince(startedAt);
    return sanitizeWebGPUProbeResult(result);
  }

  for (const [key, adapterOptions] of ADAPTER_PROBES) {
    result[key] = await probeAdapter(gpu, adapterOptions);
  }

  const attempts = ADAPTER_PROBES.map(([key]) => result[key]);
  result.ok = attempts.some((attempt) => attempt.adapterReturned && attempt.requestDeviceOk);
  const failureCategory = classifyWebGPUProbeFailure(result);
  result.errorCategory = result.ok ? "" : failureCategory;
  result.errorMessage = result.ok ? "" : getFailureMessage(failureCategory);
  result.elapsedMs = elapsedSince(startedAt);

  return sanitizeWebGPUProbeResult(result);
}

export function sanitizeWebGPUProbeResult(result) {
  return sanitizeValue(result);
}

export function classifyWebGPUProbeFailure(errorOrResult) {
  if (!errorOrResult) {
    return "unknown";
  }

  if (typeof errorOrResult === "object" && "navigatorGpuPresent" in errorOrResult) {
    return classifyProbeResult(errorOrResult);
  }

  return classifyErrorMessage(extractErrorMessage(errorOrResult));
}

export function summarizeWebGPUProbe(probe) {
  const sanitized = sanitizeWebGPUProbeResult(probe ?? {});
  const bestAttempt = getBestProbeAttempt(sanitized);
  const failureCategory = sanitized.errorCategory || classifyWebGPUProbeFailure(sanitized);
  return {
    contextLabel: sanitized.contextLabel || "unknown",
    navigatorGpuPresent: Boolean(sanitized.navigatorGpuPresent),
    adapterReturned: Boolean(bestAttempt?.adapterReturned),
    requestDeviceOk: Boolean(bestAttempt?.requestDeviceOk),
    failureCategory: sanitized.ok ? "" : failureCategory,
    unsafeFlagRecommendedForDevOnly: shouldRecommendUnsafeWebGPUFlag(failureCategory)
  };
}

async function probeAdapter(gpu, adapterOptions) {
  const result = {
    attempted: true,
    ok: false,
    adapterReturned: false,
    requestDeviceOk: false,
    featuresCount: 0,
    hasShaderF16: false,
    limitsKnown: false,
    errorCategory: "",
    errorMessage: ""
  };

  try {
    const adapter = await gpu.requestAdapter(adapterOptions);
    result.adapterReturned = Boolean(adapter);

    if (!adapter) {
      result.errorCategory = "adapter-null";
      result.errorMessage = "WebGPU adapter request returned no adapter.";
      return result;
    }

    result.featuresCount = getFeatureCount(adapter.features);
    result.hasShaderF16 = hasFeature(adapter.features, "shader-f16");
    result.limitsKnown = Boolean(adapter.limits);

    try {
      const device = await adapter.requestDevice();
      result.requestDeviceOk = Boolean(device);
      result.ok = Boolean(device);
      destroyDevice(device);
      if (!device) {
        result.errorCategory = "request-device-failed";
        result.errorMessage = "WebGPU requestDevice returned no device.";
      }
    } catch (error) {
      result.errorCategory = classifyErrorMessage(extractErrorMessage(error)) || "request-device-failed";
      result.errorMessage = sanitizeErrorMessage(error, "WebGPU requestDevice failed.");
    }
  } catch (error) {
    result.errorCategory = classifyErrorMessage(extractErrorMessage(error));
    result.errorMessage = sanitizeErrorMessage(error, "WebGPU requestAdapter failed.");
  }

  return result;
}

function classifyProbeResult(result) {
  if (!result.navigatorGpuPresent) {
    return "navigator-gpu-missing";
  }

  const attempts = ADAPTER_PROBES.map(([key]) => result[key]).filter(Boolean);
  if (attempts.some((attempt) => attempt.requestDeviceOk)) {
    return "";
  }

  const firstCategory = attempts.find((attempt) => attempt.errorCategory)?.errorCategory;
  if (firstCategory) {
    return firstCategory;
  }

  if (attempts.some((attempt) => attempt.adapterReturned && !attempt.requestDeviceOk)) {
    return "request-device-failed";
  }

  if (attempts.some((attempt) => attempt.attempted && !attempt.adapterReturned)) {
    return "adapter-null";
  }

  return "unknown";
}

function classifyErrorMessage(message) {
  const normalized = String(message || "").toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (/navigator\.gpu|gpu is unavailable|gpu unavailable/.test(normalized)) {
    return "navigator-gpu-missing";
  }

  if (/enable.*unsafe.*webgpu|unsafe-webgpu|flag/.test(normalized)) {
    return "webgpu-policy-or-flag-required";
  }

  if (/blocklist|gpu access is disabled|hardware acceleration|acceleration disabled|disabled by software/.test(normalized)) {
    return "gpu-blocked-or-disabled";
  }

  if (/unsupported context|not supported in current environment|secure context|permission policy|policy/.test(normalized)) {
    return "webgpu-unsupported-context";
  }

  if (/requestdevice|request device|device/.test(normalized)) {
    return "request-device-failed";
  }

  if (/adapter|null|requestadapter|request adapter/.test(normalized)) {
    return "adapter-null";
  }

  return "unknown";
}

function createNotAttemptedProbe() {
  return {
    attempted: false,
    ok: false,
    adapterReturned: false,
    requestDeviceOk: false,
    featuresCount: 0,
    hasShaderF16: false,
    limitsKnown: false
  };
}

function getBestProbeAttempt(probe) {
  const attempts = ADAPTER_PROBES.map(([key]) => probe?.[key]).filter(Boolean);
  return attempts.find((attempt) => attempt.requestDeviceOk) ||
    attempts.find((attempt) => attempt.adapterReturned) ||
    attempts[0] ||
    createNotAttemptedProbe();
}

function getFailureMessage(category) {
  return {
    "navigator-gpu-missing": "navigator.gpu is unavailable in this context.",
    "adapter-null": "WebGPU adapter request returned no adapter.",
    "request-device-failed": "WebGPU adapter was returned, but requestDevice failed.",
    "gpu-blocked-or-disabled": "WebGPU appears blocked or disabled by browser, GPU, or acceleration settings.",
    "webgpu-policy-or-flag-required": "WebGPU may require a development-only browser launch flag in this environment.",
    "webgpu-unsupported-context": "WebGPU appears unsupported in this JavaScript context.",
    unknown: "WebGPU probe failed for an unknown reason."
  }[category] || "WebGPU probe failed.";
}

function shouldRecommendUnsafeWebGPUFlag(category) {
  return category === "webgpu-policy-or-flag-required" ||
    category === "gpu-blocked-or-disabled" ||
    category === "adapter-null";
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (!value || typeof value !== "object") {
    return sanitizeScalar(value);
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (FORBIDDEN_WEBGPU_KEYS.has(normalizedKey) || HARDWARE_IDENTIFYING_KEYS.has(normalizedKey)) {
      continue;
    }

    result[key] = sanitizeValue(nested);
  }

  return result;
}

function sanitizeScalar(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(/chrome-extension:\/\/[a-z]{32}/gi, "chrome-extension://<extension>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function sanitizeErrorMessage(error, fallback) {
  return sanitizeScalar(extractErrorMessage(error)) || fallback;
}

function extractErrorMessage(errorLike) {
  if (typeof errorLike === "string") {
    return errorLike;
  }

  if (typeof errorLike?.message === "string") {
    return errorLike.message;
  }

  return String(errorLike ?? "");
}

function sanitizeContextLabel(value) {
  const label = String(value || "unknown").toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(label) ? label : "unknown";
}

function getFeatureCount(features) {
  return Number.isInteger(features?.size) ? features.size : 0;
}

function hasFeature(features, feature) {
  return typeof features?.has === "function" && features.has(feature);
}

function destroyDevice(device) {
  try {
    device?.destroy?.();
  } catch {
    // Destruction is best-effort; the probe result is already captured.
  }
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function elapsedSince(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}
