const ROUTES_STORAGE_KEY = "lmSessionRoutes";
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";
const OFFSCREEN_REQUEST_TIMEOUT_MS = 10000;
const OFFSCREEN_SMOKE_TEST_TIMEOUT_MS = 30000;
const OFFSCREEN_MODEL_LOAD_TIMEOUT_MS = 1200000;

// Non-sensitive fallback routing only. If chrome.storage.session is unavailable,
// routes remain volatile in this service worker; originals/entities are never
// stored here.
const fallbackRoutes = new Map();
let storageSessionAvailable = Boolean(chrome.storage?.session);
let creatingOffscreenDocument;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "LM_REGISTER_SESSION") {
    registerSession(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to register session." }));
    return true;
  }

  if (message.type === "LM_COMPOSER_SUBMIT_MASKED") {
    handleComposerSubmitMasked(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          inserted: false,
          targetKind: "",
          targetDescription: "",
          method: "",
          error: error.message || "Unable to route masked prompt."
        });
      });
    return true;
  }

  if (message.type === "LM_REQUEST_TARGET_DIAGNOSTICS") {
    handleTargetDiagnosticsRequest(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          adapterName: "",
          hostname: "",
          origin: "",
          selectedTarget: null,
          candidates: [],
          error: error.message || "Unable to route target diagnostics."
        });
      });
    return true;
  }

  if (message.type === "LM_REQUEST_INFERENCE") {
    handleInferenceRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createNoInferenceResult(error.message || "Inference request failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_INFERENCE_STATUS") {
    handleInferenceStatusRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createNoInferenceStatus(error.message || "Inference status failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_LOAD_PRIVACY_FILTER") {
    handleLoadPrivacyFilterRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createPrivacyFilterLoadFailure(error.message || "Privacy Filter load failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_RUNTIME_DIAGNOSTICS") {
    handleRuntimeDiagnosticsRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createRuntimeDiagnosticsFailure(error.message || "Runtime diagnostics failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_OFFSCREEN_WEBGPU_PROBE") {
    handleOffscreenWebGPUProbeRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createWebGPUProbeFailure("offscreen", error.message || "Offscreen WebGPU probe failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_CONTENT_WEBGPU_PROBE") {
    handleContentWebGPUProbeRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createWebGPUProbeFailure("content", error.message || "Content WebGPU probe failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_PRIVACY_FILTER_SMOKE_TEST") {
    handlePrivacyFilterSmokeTestRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createSmokeTestFailure(error.message || "Privacy Filter smoke test failed.")));
    return true;
  }

  if (message.type === "LM_REQUEST_LOCAL_SELF_TEST_VERIFY") {
    handleLocalSelfTestVerifyRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse(createLocalSelfTestVerifyFailure(error.message || "Unable to route local self-test verification.")));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabSessions(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    cleanupTabSessions(tabId);
  }
});

async function registerSession(message, sender) {
  if (!message.sessionId || !sender.tab?.id) {
    return { ok: false, error: "Missing session or tab." };
  }

  // The nonce guards against accidental stale-session reuse. It is not a
  // cryptographic isolation boundary because the host page can see iframe src.
  const sessionNonce = typeof message.sessionNonce === "string" && message.sessionNonce
    ? message.sessionNonce
    : createSessionNonce();

  const route = {
    sessionId: message.sessionId,
    sessionNonce,
    tabId: sender.tab.id,
    frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
    createdAt: Date.now()
  };

  await setRoute(route);
  return { ok: true, sessionNonce };
}

async function handleComposerSubmitMasked(message) {
  const validation = validateMaskedSubmit(message);
  if (!validation.ok) {
    return validation;
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return {
      ok: false,
      inserted: false,
      targetKind: "",
      targetDescription: "",
      method: "",
      error: routeResult.error
    };
  }

  const insertion = await sendMessageToTab(routeResult.route.tabId, {
    type: "LM_INSERT_MASKED_PROMPT",
    sessionId: message.sessionId,
    maskedText: message.maskedText,
    entities: message.entities
  }, {
    frameId: routeResult.route.frameId
  });

  return {
    ok: Boolean(insertion?.ok),
    inserted: Boolean(insertion?.inserted),
    adapterName: insertion?.adapterName || "",
    targetKind: insertion?.targetKind || "",
    targetDescription: insertion?.targetDescription || "",
    strategy: insertion?.strategy || "",
    method: insertion?.method || "",
    error: insertion?.error
  };
}

async function handleTargetDiagnosticsRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return {
      ok: false,
      adapterName: "",
      hostname: "",
      origin: "",
      selectedTarget: null,
      candidates: [],
      error: "Missing session identifiers."
    };
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return {
      ok: false,
      adapterName: "",
      hostname: "",
      origin: "",
      selectedTarget: null,
      candidates: [],
      error: routeResult.error
    };
  }

  const diagnostics = await sendMessageToTab(routeResult.route.tabId, {
    type: "LM_DIAGNOSE_PROMPT_TARGETS",
    sessionId: message.sessionId
  }, {
    frameId: routeResult.route.frameId
  });

  return diagnostics ?? {
    ok: false,
    adapterName: "",
    hostname: "",
    origin: "",
    selectedTarget: null,
    candidates: [],
    error: "No diagnostics response from content script."
  };
}

async function handleInferenceRequest(message) {
  if (!message.sessionId || !message.sessionNonce || typeof message.text !== "string") {
    return createNoInferenceResult("Missing session identifiers or text.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createNoInferenceResult(routeResult.error);
  }

  // Raw text is routed only transiently to the extension-owned offscreen
  // document for local inference. It is never stored in this service worker.
  return requestOffscreenInference(message.text, message.options ?? {});
}

async function handleInferenceStatusRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createNoInferenceStatus("Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createNoInferenceStatus(routeResult.error);
  }

  return requestOffscreenStatus();
}

async function handleLoadPrivacyFilterRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createPrivacyFilterLoadFailure("Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createPrivacyFilterLoadFailure(routeResult.error);
  }

  return requestOffscreenLoadPrivacyFilter(message.options ?? {});
}

async function handleRuntimeDiagnosticsRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createRuntimeDiagnosticsFailure("Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createRuntimeDiagnosticsFailure(routeResult.error);
  }

  return requestOffscreenRuntimeDiagnostics();
}

async function handleOffscreenWebGPUProbeRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createWebGPUProbeFailure("offscreen", "Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createWebGPUProbeFailure("offscreen", routeResult.error);
  }

  return requestOffscreenWebGPUProbe();
}

async function handleContentWebGPUProbeRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createWebGPUProbeFailure("content", "Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createWebGPUProbeFailure("content", routeResult.error);
  }

  try {
    const response = await sendMessageToTabWithTimeout(routeResult.route.tabId, {
      type: "LM_CONTENT_WEBGPU_PROBE",
      sessionId: message.sessionId
    }, {
      frameId: routeResult.route.frameId
    }, OFFSCREEN_REQUEST_TIMEOUT_MS, "Content WebGPU probe timed out");

    return response ?? createWebGPUProbeFailure("content", "No content WebGPU probe response.");
  } catch (error) {
    return createWebGPUProbeFailure("content", error.message || "Content WebGPU probe failed.");
  }
}

async function handlePrivacyFilterSmokeTestRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createSmokeTestFailure("Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createSmokeTestFailure(routeResult.error);
  }

  return requestOffscreenPrivacyFilterSmokeTest(message.options ?? {});
}

async function handleLocalSelfTestVerifyRequest(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return createLocalSelfTestVerifyFailure("Missing session identifiers.");
  }

  const routeResult = await validateSessionRoute(message);
  if (!routeResult.ok) {
    return createLocalSelfTestVerifyFailure(routeResult.error);
  }

  const result = await sendMessageToTab(routeResult.route.tabId, {
    type: "LM_LOCAL_SELF_TEST_VERIFY",
    sessionId: message.sessionId,
    scenario: message.scenario
  }, {
    frameId: routeResult.route.frameId
  });

  return result ?? createLocalSelfTestVerifyFailure("No local self-test verification response from content script.");
}

function validateMaskedSubmit(message) {
  if (!message.sessionId || !message.sessionNonce) {
    return {
      ok: false,
      inserted: false,
      targetKind: "",
      targetDescription: "",
      method: "",
      error: "Missing session identifiers."
    };
  }

  if (typeof message.maskedText !== "string") {
    return {
      ok: false,
      inserted: false,
      targetKind: "",
      targetDescription: "",
      method: "",
      error: "Masked text must be a string."
    };
  }

  if (!Array.isArray(message.entities)) {
    return {
      ok: false,
      inserted: false,
      targetKind: "",
      targetDescription: "",
      method: "",
      error: "Entities must be an array."
    };
  }

  return { ok: true };
}

async function validateSessionRoute(message) {
  const route = await getRoute(message.sessionId);
  if (!route) {
    return {
      ok: false,
      route: null,
      error: "This page session is no longer available. Refresh the AI page and try again."
    };
  }

  if (route.sessionNonce !== message.sessionNonce) {
    return {
      ok: false,
      route: null,
      error: "Session nonce mismatch. Reopen the Local Masker panel."
    };
  }

  return { ok: true, route };
}

function sendMessageToTab(tabId, message, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function sendMessageToTabWithTimeout(tabId, message, options, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("chrome.offscreen is unavailable.");
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (contexts.length > 0) {
      return;
    }
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Run local-only privacy inference in an extension-owned offscreen document."
    }).catch((error) => {
      if (String(error?.message || "").includes("Only a single offscreen document")) {
        return;
      }

      throw error;
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }

  await creatingOffscreenDocument;
}

// TODO: Close the offscreen document after an idle timeout once real model
// loading and lifecycle costs are understood.
function closeOffscreenDocumentIfIdle() {}

async function requestOffscreenInference(text, options) {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_INFER",
        requestId,
        text,
        options
      },
      OFFSCREEN_REQUEST_TIMEOUT_MS,
      "Offscreen inference timed out"
    );

    return normalizeInferenceResponse(response, requestId);
  } catch (error) {
    return createNoInferenceResult(error.message || "Offscreen inference unavailable.");
  } finally {
    closeOffscreenDocumentIfIdle();
  }
}

async function requestOffscreenStatus() {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_STATUS",
        requestId
      },
      OFFSCREEN_REQUEST_TIMEOUT_MS,
      "Offscreen status timed out"
    );

    if (response?.requestId !== requestId) {
      return createNoInferenceStatus("Offscreen status response mismatch.");
    }

    return {
      ok: Boolean(response.ok),
      provider: response.provider || response.activeProvider || "none",
      activeProvider: response.activeProvider || response.provider || "none",
      availableProviders: Array.isArray(response.availableProviders) ? response.availableProviders : [],
      modelStatus: response.modelStatus ?? createNoProviderStatuses(),
      error: response.error
    };
  } catch (error) {
    return createNoInferenceStatus(error.message || "Offscreen inference unavailable.");
  }
}

async function requestOffscreenLoadPrivacyFilter(options) {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_LOAD_MODEL",
        requestId,
        options
      },
      OFFSCREEN_MODEL_LOAD_TIMEOUT_MS,
      "Privacy Filter model load timed out"
    );

    if (response?.requestId !== requestId) {
      return createPrivacyFilterLoadFailure("Privacy Filter load response mismatch.");
    }

    return {
      ok: Boolean(response.ok),
      provider: response.provider || "privacy-filter",
      modelStatus: response.modelStatus ?? {
        provider: "privacy-filter",
        loaded: false,
        loading: false,
        device: "none",
        dtype: "unknown",
        modelId: "openai/privacy-filter",
        modelSource: "unknown",
        webgpuAvailable: false,
        webgpuProbeOk: false,
        webgpuAdapterAvailable: false,
        webgpuRequestDeviceOk: false,
        webgpuFailureCategory: "",
        modelDownloadAttempted: false
      },
      error: response.error
    };
  } catch (error) {
    return createPrivacyFilterLoadFailure(error.message || "Privacy Filter model load unavailable.");
  }
}

async function requestOffscreenRuntimeDiagnostics() {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_RUNTIME_DIAGNOSTICS",
        requestId
      },
      OFFSCREEN_REQUEST_TIMEOUT_MS,
      "Runtime diagnostics timed out"
    );

    if (response?.requestId !== requestId) {
      return createRuntimeDiagnosticsFailure("Runtime diagnostics response mismatch.");
    }

    return {
      ok: Boolean(response.ok),
      diagnostics: response.diagnostics ?? {
        ok: false,
        errors: []
      },
      error: response.error
    };
  } catch (error) {
    return createRuntimeDiagnosticsFailure(error.message || "Runtime diagnostics unavailable.");
  }
}

async function requestOffscreenWebGPUProbe() {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_WEBGPU_PROBE",
        requestId
      },
      OFFSCREEN_REQUEST_TIMEOUT_MS,
      "Offscreen WebGPU probe timed out"
    );

    if (response?.requestId !== requestId) {
      return createWebGPUProbeFailure("offscreen", "Offscreen WebGPU probe response mismatch.");
    }

    return {
      ok: Boolean(response.ok),
      probe: response.probe ?? {
        ok: false,
        contextLabel: "offscreen",
        navigatorGpuPresent: false,
        errorCategory: "unknown",
        errorMessage: "Offscreen WebGPU probe returned no probe data."
      },
      error: response.error
    };
  } catch (error) {
    return createWebGPUProbeFailure("offscreen", error.message || "Offscreen WebGPU probe unavailable.");
  }
}

async function requestOffscreenPrivacyFilterSmokeTest(options) {
  try {
    await ensureOffscreenDocument();

    const requestId = createRequestId();
    const response = await sendRuntimeMessageWithTimeout(
      {
        type: "LM_OFFSCREEN_PRIVACY_FILTER_SMOKE_TEST",
        requestId,
        options
      },
      options?.loadIfNeeded === true ? OFFSCREEN_MODEL_LOAD_TIMEOUT_MS : OFFSCREEN_SMOKE_TEST_TIMEOUT_MS,
      "Privacy Filter smoke test timed out"
    );

    if (response?.requestId !== requestId) {
      return createSmokeTestFailure("Privacy Filter smoke test response mismatch.");
    }

    return {
      ok: Boolean(response.ok),
      provider: response.provider || "privacy-filter",
      loaded: Boolean(response.loaded),
      inferenceRan: Boolean(response.inferenceRan),
      elapsedMs: Number.isFinite(Number(response.elapsedMs)) ? Number(response.elapsedMs) : 0,
      spansReturned: Number.isInteger(response.spansReturned) ? response.spansReturned : 0,
      labelsReturned: response.labelsReturned && typeof response.labelsReturned === "object" ? response.labelsReturned : {},
      normalizedSpanCount: Number.isInteger(response.normalizedSpanCount) ? response.normalizedSpanCount : 0,
      warnings: Array.isArray(response.warnings) ? response.warnings : undefined,
      error: response.error,
      errorCategory: response.errorCategory
    };
  } catch (error) {
    return createSmokeTestFailure(error.message || "Privacy Filter smoke test unavailable.");
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function sendRuntimeMessageWithTimeout(message, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function normalizeInferenceResponse(response, requestId) {
  if (!response || response.requestId !== requestId) {
    return createNoInferenceResult("Offscreen inference response mismatch.");
  }

  return {
    ok: Boolean(response.ok),
    provider: response.provider || "none",
    modelStatus: response.modelStatus ?? {
      provider: "none",
      loaded: false
    },
    spans: Array.isArray(response.spans) ? response.spans : [],
    error: response.error
  };
}

function createNoInferenceResult(error) {
  return {
    ok: false,
    provider: "none",
    modelStatus: {
      provider: "none",
      loaded: false
    },
    spans: [],
    error
  };
}

function createNoInferenceStatus(error) {
  return {
    ok: false,
    provider: "none",
    activeProvider: "none",
    availableProviders: ["regex-only", "mock", "privacy-filter"],
    modelStatus: createNoProviderStatuses(),
    error
  };
}

function createPrivacyFilterLoadFailure(error) {
  return {
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
      webgpuProbeOk: false,
      webgpuAdapterAvailable: false,
      webgpuRequestDeviceOk: false,
      webgpuFailureCategory: "",
      modelDownloadAttempted: false
    },
    error
  };
}

function createRuntimeDiagnosticsFailure(error) {
  return {
    ok: false,
    diagnostics: {
      ok: false,
      runtime: {},
      transformers: {},
      assets: {
        buildManifestAvailable: false,
        wasmAssetsKnown: 0,
        checkedAssets: []
      },
      providers: {},
      csp: {
        unsafeEvalAllowed: false,
        wasmUnsafeEvalConfigured: false,
        suspectedEvalShimRisk: false
      },
      errors: [
        {
          category: String(error || "").toLowerCase().includes("offscreen") ? "offscreen-unavailable" : "unknown",
          message: String(error || "Runtime diagnostics failed.").slice(0, 240),
          stackIncluded: false
        }
      ]
    },
    error
  };
}

function createWebGPUProbeFailure(contextLabel, error) {
  return {
    ok: false,
    probe: {
      ok: false,
      contextLabel,
      navigatorGpuPresent: false,
      requestAdapterDefault: {
        attempted: false,
        ok: false,
        adapterReturned: false,
        requestDeviceOk: false,
        featuresCount: 0,
        hasShaderF16: false,
        limitsKnown: false
      },
      requestAdapterLowPower: {
        attempted: false,
        ok: false,
        adapterReturned: false,
        requestDeviceOk: false,
        featuresCount: 0,
        hasShaderF16: false,
        limitsKnown: false
      },
      requestAdapterHighPerformance: {
        attempted: false,
        ok: false,
        adapterReturned: false,
        requestDeviceOk: false,
        featuresCount: 0,
        hasShaderF16: false,
        limitsKnown: false
      },
      elapsedMs: 0,
      errorCategory: "unknown",
      errorMessage: String(error || "WebGPU probe failed.").replace(/\s+/g, " ").slice(0, 240)
    },
    error
  };
}

function createSmokeTestFailure(error) {
  return {
    ok: false,
    provider: "privacy-filter",
    loaded: false,
    inferenceRan: false,
    elapsedMs: 0,
    spansReturned: 0,
    labelsReturned: {},
    normalizedSpanCount: 0,
    error
  };
}

function createNoProviderStatuses() {
  return {
    regexOnly: {
      provider: "regex-only",
      loaded: true,
      device: "none",
      dtype: "none",
      modelId: "deterministic-regex"
    },
    mock: {
      provider: "mock",
      loaded: false,
      device: "none",
      dtype: "none",
      modelId: "mock-local-provider"
    },
    privacyFilter: {
      provider: "privacy-filter",
      loaded: false,
      loading: false,
      device: "none",
      dtype: "unknown",
      modelId: "openai/privacy-filter",
      modelSource: "unknown",
      webgpuAvailable: false,
      webgpuProbeOk: false,
      webgpuAdapterAvailable: false,
      webgpuRequestDeviceOk: false,
      webgpuFailureCategory: "",
      modelDownloadAttempted: false
    }
  };
}

function createLocalSelfTestVerifyFailure(error) {
  return {
    ok: false,
    isLocalFixture: false,
    adapterName: "",
    targetKind: "",
    targetDescription: "",
    method: "",
    containsAnyForbiddenKnownTestValue: false,
    containsExpectedPlaceholder: false,
    forbiddenChecks: {},
    placeholderChecks: {},
    error
  };
}

async function setRoute(route) {
  if (storageSessionAvailable) {
    try {
      const routes = await readStoredRoutes();
      routes[route.sessionId] = route;
      await setSessionStorageValue({ [ROUTES_STORAGE_KEY]: routes });
      fallbackRoutes.delete(route.sessionId);
      return;
    } catch {
      storageSessionAvailable = false;
    }
  }

  fallbackRoutes.set(route.sessionId, route);
}

async function getRoute(sessionId) {
  if (storageSessionAvailable) {
    try {
      const routes = await readStoredRoutes();
      return routes[sessionId] || fallbackRoutes.get(sessionId);
    } catch {
      storageSessionAvailable = false;
    }
  }

  return fallbackRoutes.get(sessionId);
}

async function cleanupTabSessions(tabId) {
  for (const [sessionId, route] of fallbackRoutes.entries()) {
    if (route.tabId === tabId) {
      fallbackRoutes.delete(sessionId);
    }
  }

  if (!storageSessionAvailable) {
    return;
  }

  try {
    const routes = await readStoredRoutes();
    let changed = false;

    for (const [sessionId, route] of Object.entries(routes)) {
      if (route.tabId === tabId) {
        delete routes[sessionId];
        changed = true;
      }
    }

    if (changed) {
      await setSessionStorageValue({ [ROUTES_STORAGE_KEY]: routes });
    }
  } catch {
    storageSessionAvailable = false;
  }
}

async function readStoredRoutes() {
  const result = await getSessionStorageValue(ROUTES_STORAGE_KEY);
  const routes = result?.[ROUTES_STORAGE_KEY];
  return routes && typeof routes === "object" ? routes : {};
}

function getSessionStorageValue(key) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.session) {
      reject(new Error("chrome.storage.session is unavailable."));
      return;
    }

    chrome.storage.session.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(result);
    });
  });
}

function setSessionStorageValue(value) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage?.session) {
      reject(new Error("chrome.storage.session is unavailable."));
      return;
    }

    chrome.storage.session.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function createSessionNonce() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createRequestId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
