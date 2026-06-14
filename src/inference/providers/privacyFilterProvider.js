import { normalizePrivacyFilterOutput } from "../spanUtils.js";
import {
  classifyRuntimeError,
  sanitizeRuntimeError
} from "../runtimeDiagnostics.js";
import {
  extractRuntimeSpecifierFromMessage,
  isRuntimeSpecifierResolutionError
} from "../runtimeSpecifierChecks.js";
import {
  probeWebGPU,
  summarizeWebGPUProbe
} from "../webgpuDiagnostics.js";

const MODEL_ID = "openai/privacy-filter";
const PROVIDER = "privacy-filter";
const MODEL_SOURCE = "remote-hub";
const REQUESTED_DEVICE = "webgpu";
const REQUESTED_DTYPE = "q4";

let pipelineInstance = null;
let loadPromise = null;
let transformersRuntimePromise = null;
let providerState = {
  provider: PROVIDER,
  loaded: false,
  loading: false,
  device: "none",
  dtype: "unknown",
  modelId: MODEL_ID,
  modelSource: MODEL_SOURCE,
  webgpuAvailable: detectWebGpuAvailable(),
  onnxRuntimeWebgpuResolved: false,
  localRuntimeAssetsConfigured: false,
  localWasmPathConfigured: false,
  resolvedRuntimeMode: "unknown",
  webgpuProbeOk: false,
  webgpuAdapterAvailable: false,
  webgpuRequestDeviceOk: false,
  webgpuFailureCategory: "",
  modelDownloadAttempted: false,
  lastErrorCategory: "",
  lastErrorMessage: "",
  lastLoadAttemptAt: undefined,
  lastSuccessfulLoadAt: undefined,
  lastInferenceMs: undefined
};
let runtimeConfigState = {
  importAvailable: false,
  envConfigured: false,
  onnxRuntimeWebgpuImportResolvable: false,
  unresolvedRuntimeSpecifier: null,
  localRuntimeAssetsConfigured: false,
  localWasmPathConfigured: false,
  localWasmPathOrigin: "unknown",
  resolvedRuntimeMode: "unknown",
  runtimeResolutionErrorCategory: "",
  runtimeResolutionErrorMessage: "",
  webgpuProbe: null,
  webgpuProbeSummary: {
    contextLabel: "offscreen",
    navigatorGpuPresent: detectWebGpuAvailable(),
    adapterReturned: false,
    requestDeviceOk: false,
    failureCategory: "",
    unsafeFlagRecommendedForDevOnly: false
  },
  allowRemoteModels: false,
  allowLocalModels: undefined
};

export function getPrivacyFilterStatus() {
  return { ...providerState };
}

export function getPrivacyFilterRuntimeDiagnostics() {
  return { ...runtimeConfigState };
}

export async function loadPrivacyFilter(options = {}) {
  if (pipelineInstance) {
    return {
      ok: true,
      provider: PROVIDER,
      modelStatus: getPrivacyFilterStatus()
    };
  }

  if (loadPromise) {
    return loadPromise;
  }

  providerState = {
    ...providerState,
    loading: true,
    loaded: false,
    device: REQUESTED_DEVICE,
    dtype: REQUESTED_DTYPE,
    error: undefined,
    loadStartedAt: Date.now(),
    lastLoadAttemptAt: Date.now(),
    loadCompletedAt: undefined,
    modelDownloadAttempted: false,
    webgpuAvailable: detectWebGpuAvailable()
  };

  loadPromise = (async () => {
    try {
      if (!providerState.webgpuAvailable) {
        throw new Error("WebGPU is unavailable in this extension context.");
      }

      const webgpuProbe = await getOffscreenWebGPUProbe();
      if (!webgpuProbe.requestDeviceOk) {
        providerState = {
          ...providerState,
          webgpuProbeOk: false,
          webgpuAdapterAvailable: Boolean(webgpuProbe.adapterReturned),
          webgpuRequestDeviceOk: false,
          webgpuFailureCategory: webgpuProbe.failureCategory || "adapter-null",
          modelDownloadAttempted: false
        };
        throw new Error("WebGPU adapter is unavailable in the extension offscreen context. Use Regex only or Mock provider on this browser/device.");
      }

      const { pipeline } = await loadTransformersRuntime();
      providerState = {
        ...providerState,
        webgpuProbeOk: true,
        webgpuAdapterAvailable: true,
        webgpuRequestDeviceOk: true,
        webgpuFailureCategory: "",
        modelDownloadAttempted: true
      };
      pipelineInstance = await pipeline("token-classification", MODEL_ID, {
        device: REQUESTED_DEVICE,
        dtype: REQUESTED_DTYPE,
        revision: options.revision || "main"
      });

      providerState = {
        ...providerState,
        loaded: true,
        loading: false,
        device: REQUESTED_DEVICE,
        dtype: REQUESTED_DTYPE,
        modelSource: MODEL_SOURCE,
        onnxRuntimeWebgpuResolved: true,
        webgpuProbeOk: true,
        webgpuAdapterAvailable: true,
        webgpuRequestDeviceOk: true,
        webgpuFailureCategory: "",
        modelDownloadAttempted: true,
        loadCompletedAt: Date.now(),
        lastSuccessfulLoadAt: Date.now(),
        lastErrorCategory: "",
        lastErrorMessage: "",
        error: undefined
      };

      return {
        ok: true,
        provider: PROVIDER,
        modelStatus: getPrivacyFilterStatus()
      };
    } catch (error) {
      const sanitized = sanitizeProviderError(error, "Privacy Filter model load failed.");
      pipelineInstance = null;
      providerState = {
        ...providerState,
        loaded: false,
        loading: false,
        device: providerState.webgpuAvailable ? REQUESTED_DEVICE : "none",
        dtype: REQUESTED_DTYPE,
        onnxRuntimeWebgpuResolved: runtimeConfigState.onnxRuntimeWebgpuImportResolvable,
        webgpuProbeOk: providerState.webgpuProbeOk,
        webgpuAdapterAvailable: providerState.webgpuAdapterAvailable,
        webgpuRequestDeviceOk: providerState.webgpuRequestDeviceOk,
        webgpuFailureCategory: providerState.webgpuFailureCategory,
        modelDownloadAttempted: providerState.modelDownloadAttempted,
        loadCompletedAt: Date.now(),
        lastErrorCategory: sanitized.category,
        lastErrorMessage: sanitized.message,
        error: sanitized.message
      };

      return {
        ok: false,
        provider: PROVIDER,
        modelStatus: getPrivacyFilterStatus(),
        error: providerState.error
      };
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export async function inferPrivacyFilterSpans(text, options = {}) {
  const sourceText = String(text ?? "");
  if (!pipelineInstance) {
    return {
      ok: false,
      provider: PROVIDER,
      modelStatus: getPrivacyFilterStatus(),
      spans: [],
    error: "Privacy Filter model is not loaded."
    };
  }

  const startedAt = now();
  try {
    const output = await pipelineInstance(sourceText, {
      aggregation_strategy: options.aggregationStrategy || "simple"
    });
    const spans = normalizePrivacyFilterOutput(output, sourceText, {
      source: PROVIDER
    });

    providerState = {
      ...providerState,
      loaded: true,
      loading: false,
      lastInferenceMs: Math.max(0, Math.round(now() - startedAt)),
      lastErrorCategory: "",
      lastErrorMessage: "",
      error: undefined
    };

    return {
      ok: true,
      provider: PROVIDER,
      modelStatus: getPrivacyFilterStatus(),
      spans
    };
  } catch (error) {
    const sanitized = sanitizeProviderError(error, "Privacy Filter inference failed.", {
      useFallbackMessage: true
    });
    providerState = {
      ...providerState,
      lastInferenceMs: Math.max(0, Math.round(now() - startedAt)),
      lastErrorCategory: sanitized.category,
      lastErrorMessage: sanitized.message,
      error: sanitized.message
    };

    return {
      ok: false,
      provider: PROVIDER,
      modelStatus: getPrivacyFilterStatus(),
      spans: [],
      error: providerState.error
    };
  }
}

async function loadTransformersRuntime() {
  if (!transformersRuntimePromise) {
    transformersRuntimePromise = import(getTransformersRuntimeUrl()).then((runtime) => {
      runtimeConfigState = {
        ...runtimeConfigState,
        importAvailable: true,
        onnxRuntimeWebgpuImportResolvable: true,
        unresolvedRuntimeSpecifier: null,
        runtimeResolutionErrorCategory: "",
        runtimeResolutionErrorMessage: ""
      };
      providerState = {
        ...providerState,
        onnxRuntimeWebgpuResolved: true,
        lastErrorCategory: providerState.lastErrorCategory === "runtime-module-resolution-failed" ? "" : providerState.lastErrorCategory,
        lastErrorMessage: providerState.lastErrorCategory === "runtime-module-resolution-failed" ? "" : providerState.lastErrorMessage
      };
      configureTransformersEnvironment(runtime);
      return runtime;
    }).catch((error) => {
      const sanitized = sanitizeProviderError(error, "Transformers runtime import failed.");
      const unresolvedRuntimeSpecifier = extractRuntimeSpecifierFromMessage(error?.message || String(error)) ||
        (isRuntimeSpecifierResolutionError(error) ? "unknown" : null);
      runtimeConfigState = {
        ...runtimeConfigState,
        importAvailable: false,
        envConfigured: false,
        onnxRuntimeWebgpuImportResolvable: false,
        unresolvedRuntimeSpecifier,
        runtimeResolutionErrorCategory: sanitized.category,
        runtimeResolutionErrorMessage: sanitized.message
      };
      providerState = {
        ...providerState,
        onnxRuntimeWebgpuResolved: false,
        resolvedRuntimeMode: "unknown",
        lastErrorCategory: sanitized.category,
        lastErrorMessage: sanitized.message,
        error: sanitized.message
      };
      throw error;
    });
  }

  return transformersRuntimePromise;
}

function configureTransformersEnvironment(runtime) {
  const env = runtime?.env;
  if (!env) {
    return;
  }

  const LogLevel = runtime.LogLevel ?? {};
  env.logLevel = LogLevel.ERROR ?? 40;
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.remoteHost = "https://huggingface.co/";
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  env.useFS = false;
  env.useFSCache = false;
  env.experimental_useCrossOriginStorage = false;

  const wasmPaths = getLocalOrtWasmPaths();
  if (wasmPaths && env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = wasmPaths;
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
  }

  if (env.backends?.onnx?.webgpu) {
    env.backends.onnx.webgpu.powerPreference = "high-performance";
  }

  const localRuntimeAssetsConfigured = Boolean(wasmPaths);
  const resolvedRuntimeMode = providerState.webgpuAvailable ? "webgpu" : wasmPaths ? "wasm" : "unknown";
  runtimeConfigState = {
    ...runtimeConfigState,
    envConfigured: true,
    localRuntimeAssetsConfigured,
    localWasmPathConfigured: Boolean(wasmPaths),
    localWasmPathOrigin: wasmPaths ? "chrome-extension" : "unknown",
    resolvedRuntimeMode,
    allowRemoteModels: Boolean(env.allowRemoteModels),
    allowLocalModels: env.allowLocalModels
  };

  providerState = {
    ...providerState,
    localRuntimeAssetsConfigured,
    localWasmPathConfigured: Boolean(wasmPaths),
    resolvedRuntimeMode
  };

  // TODO: Add offline model bundling and integrity checks before production
  // publishing. Remote Hugging Face files are model data, not executable code.
}

function getTransformersRuntimeUrl() {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL("dist/vendor/transformers/transformers.web.js");
  }

  return "@huggingface/transformers";
}

function getLocalOrtWasmPaths() {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) {
    return null;
  }

  return {
    mjs: chrome.runtime.getURL("dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: chrome.runtime.getURL("dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm")
  };
}

function detectWebGpuAvailable() {
  return typeof navigator !== "undefined" && Boolean(navigator.gpu);
}

function sanitizeProviderError(error, fallback, options = {}) {
  const sanitized = sanitizeRuntimeError(error, {
    category: classifyRuntimeError(error),
    fallback,
    useFallbackMessage: Boolean(options.useFallbackMessage)
  });
  return sanitized;
}

async function getOffscreenWebGPUProbe() {
  const probe = await probeWebGPU({ contextLabel: "offscreen" });
  const summary = summarizeWebGPUProbe(probe);

  runtimeConfigState = {
    ...runtimeConfigState,
    webgpuProbe: probe,
    webgpuProbeSummary: summary
  };

  providerState = {
    ...providerState,
    webgpuProbeOk: Boolean(summary.requestDeviceOk),
    webgpuAdapterAvailable: Boolean(summary.adapterReturned),
    webgpuRequestDeviceOk: Boolean(summary.requestDeviceOk),
    webgpuFailureCategory: summary.failureCategory || ""
  };

  return summary;
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
