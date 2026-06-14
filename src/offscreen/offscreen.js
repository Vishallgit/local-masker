import { getInferenceStatus, runInference } from "../inference/inferenceEngine.js";
import {
  getPrivacyFilterRuntimeDiagnostics,
  getPrivacyFilterStatus,
  inferPrivacyFilterSpans,
  loadPrivacyFilter
} from "../inference/providers/privacyFilterProvider.js";
import {
  getRuntimeDiagnostics,
  sanitizeRuntimeError
} from "../inference/runtimeDiagnostics.js";
import {
  probeWebGPU,
  sanitizeWebGPUProbeResult
} from "../inference/webgpuDiagnostics.js";

const PRIVACY_FILTER_SMOKE_TEST_TEXT = "Harry Potter emailed harry.potter@hogwarts.edu from 123 Main St using key sk-abc123456789.";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "LM_OFFSCREEN_INFER") {
    handleInfer(message)
      .then(sendResponse)
      .catch((error) => {
        const sanitized = sanitizeRuntimeError(error, {
          fallback: "Offscreen inference failed.",
          useFallbackMessage: true
        });
        sendResponse({
          type: "LM_OFFSCREEN_INFER_RESULT",
          requestId: message.requestId,
          ok: false,
          provider: "none",
          modelStatus: {
            provider: "none",
            loaded: false
          },
          spans: [],
          error: sanitized.message,
          errorCategory: sanitized.category
        });
      });
    return true;
  }

  if (message.type === "LM_OFFSCREEN_STATUS") {
    const status = getInferenceStatus();
    sendResponse({
      type: "LM_OFFSCREEN_STATUS_RESULT",
      requestId: message.requestId,
      ...status
    });
    return false;
  }

  if (message.type === "LM_OFFSCREEN_LOAD_MODEL") {
    handleLoadModel(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "LM_OFFSCREEN_LOAD_MODEL_RESULT",
          requestId: message.requestId,
          ok: false,
          provider: "privacy-filter",
          modelStatus: {
            provider: "privacy-filter",
            loaded: false,
            loading: false,
            device: "none",
            dtype: "unknown",
            modelId: "openai/privacy-filter",
            modelSource: "unknown",
            webgpuAvailable: false,
            onnxRuntimeWebgpuResolved: false,
            localRuntimeAssetsConfigured: false,
            localWasmPathConfigured: false,
            resolvedRuntimeMode: "unknown",
            webgpuProbeOk: false,
            webgpuAdapterAvailable: false,
            webgpuRequestDeviceOk: false,
            webgpuFailureCategory: "",
            modelDownloadAttempted: false
          },
          error: error.message || "Privacy Filter model load failed."
        });
      });
    return true;
  }

  if (message.type === "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS") {
    handleRuntimeDiagnostics(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          type: "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS_RESULT",
          requestId: message.requestId,
          ok: false,
          diagnostics: {
            ok: false,
            errors: [sanitizeRuntimeError(error)]
          }
        });
      });
    return true;
  }

  if (message.type === "LM_OFFSCREEN_WEBGPU_PROBE") {
    handleWebGPUProbe(message)
      .then(sendResponse)
      .catch((error) => {
        const sanitized = sanitizeRuntimeError(error);
        sendResponse({
          type: "LM_OFFSCREEN_WEBGPU_PROBE_RESULT",
          requestId: message.requestId,
          ok: false,
          probe: sanitizeWebGPUProbeResult({
            ok: false,
            contextLabel: "offscreen",
            navigatorGpuPresent: typeof navigator !== "undefined" && Boolean(navigator.gpu),
            errorCategory: sanitized.category,
            errorMessage: sanitized.message
          })
        });
      });
    return true;
  }

  if (message.type === "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST") {
    handlePrivacyFilterSmokeTest(message)
      .then(sendResponse)
      .catch((error) => {
        const sanitized = sanitizeRuntimeError(error);
        sendResponse({
          type: "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST_RESULT",
          requestId: message.requestId,
          ok: false,
          provider: "privacy-filter",
          loaded: Boolean(getPrivacyFilterStatus().loaded),
          inferenceRan: false,
          elapsedMs: 0,
          spansReturned: 0,
          labelsReturned: {},
          normalizedSpanCount: 0,
          error: sanitized.message,
          errorCategory: sanitized.category
        });
      });
    return true;
  }

  return false;
});

async function handleInfer(message) {
  const result = await runInference(String(message.text ?? ""), message.options ?? {});

  return {
    type: "LM_OFFSCREEN_INFER_RESULT",
    requestId: message.requestId,
    ...result
  };
}

async function handleLoadModel(message) {
  const result = await loadPrivacyFilter(message.options ?? {});

  return {
    type: "LM_OFFSCREEN_LOAD_MODEL_RESULT",
    requestId: message.requestId,
    ...result
  };
}

async function handleRuntimeDiagnostics(message) {
  const webgpuProbe = await probeWebGPU({ contextLabel: "offscreen" });
  const diagnostics = await getRuntimeDiagnostics({
    isOffscreenDocument: true,
    webgpuProbe,
    transformers: getPrivacyFilterRuntimeDiagnostics(),
    providers: getInferenceStatus().modelStatus
  });

  return {
    type: "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS_RESULT",
    requestId: message.requestId,
    ok: Boolean(diagnostics.ok),
    diagnostics
  };
}

async function handleWebGPUProbe(message) {
  const probe = await probeWebGPU({ contextLabel: "offscreen" });
  return {
    type: "LM_OFFSCREEN_WEBGPU_PROBE_RESULT",
    requestId: message.requestId,
    ok: Boolean(probe.ok),
    probe
  };
}

async function handlePrivacyFilterSmokeTest(message) {
  const startedAt = now();
  const options = message.options ?? {};
  let status = getPrivacyFilterStatus();

  if (!status.loaded && options.loadIfNeeded === true) {
    await loadPrivacyFilter(options);
    status = getPrivacyFilterStatus();
  }

  if (!status.loaded) {
    return {
      type: "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST_RESULT",
      requestId: message.requestId,
      ok: false,
      provider: "privacy-filter",
      loaded: false,
      inferenceRan: false,
      elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      spansReturned: 0,
      labelsReturned: {},
      normalizedSpanCount: 0,
      error: "Privacy Filter model is not loaded. Click Load Privacy Filter model first."
    };
  }

  const result = await inferPrivacyFilterSpans(PRIVACY_FILTER_SMOKE_TEST_TEXT, options);
  const labelsReturned = countLabels(result.spans);

  return {
    type: "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST_RESULT",
    requestId: message.requestId,
    ok: Boolean(result.ok),
    provider: "privacy-filter",
    loaded: Boolean(result.modelStatus?.loaded),
    inferenceRan: Boolean(result.ok),
    elapsedMs: Math.max(0, Math.round(now() - startedAt)),
    spansReturned: result.spans?.length ?? 0,
    labelsReturned,
    normalizedSpanCount: result.spans?.length ?? 0,
    warnings: result.spans?.length ? undefined : ["Privacy Filter returned no normalized spans for the smoke text."],
    error: result.error,
    errorCategory: result.modelStatus?.lastErrorCategory || undefined
  };
}

function countLabels(spans = []) {
  const counts = {};
  for (const span of spans) {
    if (!span?.label) {
      continue;
    }

    counts[span.label] = (counts[span.label] ?? 0) + 1;
  }

  return counts;
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
