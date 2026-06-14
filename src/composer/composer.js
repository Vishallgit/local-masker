import { maskText } from "../shared/masker.js";
import { sanitizeDiagnosticsReport } from "../inference/runtimeDiagnostics.js";
import {
  sanitizeWebGPUProbeResult,
  summarizeWebGPUProbe
} from "../inference/webgpuDiagnostics.js";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId");
const sessionNonce = params.get("sessionNonce");
const hostContext = normalizeHostContext(params.get("hostname"));
const isDevFixtureContext = isLocalFixtureHostname(hostContext);
const PRIVACY_FILTER_SETUP_STORAGE_KEY = "lmPrivacyFilterSetup";

const rawPrompt = document.getElementById("rawPrompt");
const promptMeta = document.getElementById("promptMeta");
const providerSelect = document.getElementById("providerSelect");
const smartModeStatus = document.getElementById("smartModeStatus");
const shell = document.querySelector(".shell");
const composerPanel = document.querySelector(".composer-panel");
const maskInsertButton = document.getElementById("maskInsertButton");
const maskInsertButtonLabel = document.getElementById("maskInsertButtonLabel");
const inferenceStatusButton = document.getElementById("inferenceStatusButton");
const runtimeDiagnosticsButton = document.getElementById("runtimeDiagnosticsButton");
const webgpuProbeButton = document.getElementById("webgpuProbeButton");
const privacyFilterSmokeButton = document.getElementById("privacyFilterSmokeButton");
const loadPrivacyFilterButton = document.getElementById("loadPrivacyFilterButton");
const selfTestButton = document.getElementById("selfTestButton");
const diagnoseButton = document.getElementById("diagnoseButton");
const clearButton = document.getElementById("clearButton");
const copyMaskedButton = document.getElementById("copyMaskedButton");
const copyDiagnosticsButton = document.getElementById("copyDiagnosticsButton");
const copyRuntimeDiagnosticsButton = document.getElementById("copyRuntimeDiagnosticsButton");
const copyWebgpuDiagnosticsButton = document.getElementById("copyWebgpuDiagnosticsButton");
const status = document.getElementById("status");
const previewPanel = document.getElementById("previewPanel");
const maskedPreview = document.getElementById("maskedPreview");
const detectedCounts = document.getElementById("detectedCounts");
const inferenceStatus = document.getElementById("inferenceStatus");
const runtimeDiagnostics = document.getElementById("runtimeDiagnostics");
const webgpuProbeDiagnostics = document.getElementById("webgpuProbeDiagnostics");
const privacyFilterSmokeResults = document.getElementById("privacyFilterSmokeResults");
const selfTestResults = document.getElementById("selfTestResults");
const insertionDiagnostics = document.getElementById("insertionDiagnostics");
const targetDiagnostics = document.getElementById("targetDiagnostics");
const candidateList = document.getElementById("candidateList");
const setupDialog = document.getElementById("setupDialog");
const setupDialogTitle = document.getElementById("setupDialogTitle");
const setupReason = document.getElementById("setupReason");
const setupConfirmButton = document.getElementById("setupConfirmButton");
const setupCancelButton = document.getElementById("setupCancelButton");
const closeComposerButton = document.getElementById("closeComposerButton");

let latestMaskedText = "";
let latestDiagnosticsReport = null;
let latestRuntimeDiagnosticsReport = null;
let latestWebgpuDiagnosticsReport = null;
let lastInsertionResult = null;
let lastInferenceResult = null;
let lastInferenceStatus = null;
let nextPlaceholderIndex = 1;
let selfTestModulePromise;
let setupDialogResolver = null;
let composerSizeRaf = 0;

maskInsertButton.addEventListener("click", handleMaskInsert);
inferenceStatusButton.addEventListener("click", handleInferenceStatus);
runtimeDiagnosticsButton.addEventListener("click", handleRuntimeDiagnostics);
webgpuProbeButton.addEventListener("click", handleWebGPUProbe);
privacyFilterSmokeButton.addEventListener("click", handlePrivacyFilterSmokeTest);
loadPrivacyFilterButton?.addEventListener("click", handleLoadPrivacyFilter);
selfTestButton.addEventListener("click", handleLocalSelfTest);
diagnoseButton.addEventListener("click", handleDiagnoseTarget);
clearButton.addEventListener("click", clearComposer);
copyMaskedButton.addEventListener("click", copyMaskedPrompt);
copyDiagnosticsButton.addEventListener("click", copyDiagnostics);
copyRuntimeDiagnosticsButton.addEventListener("click", copyRuntimeDiagnostics);
copyWebgpuDiagnosticsButton.addEventListener("click", copyWebGPUDiagnostics);
rawPrompt.addEventListener("input", handlePromptInput);
setupConfirmButton.addEventListener("click", () => resolveSetupDialog(true));
setupCancelButton.addEventListener("click", () => resolveSetupDialog(false));
closeComposerButton?.addEventListener("click", requestComposerClose);

applyContextVisibility();
updatePromptMeta();
startComposerSizeReporting();
refreshSmartModeStatus().catch(() => undefined);
initializePrivacyFilterSetupFlow().catch(() => undefined);

async function handleMaskInsert() {
  const text = rawPrompt.value;
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  if (!text.trim()) {
    setStatus("error", "Enter prompt text first.");
    return;
  }

  maskInsertButton.disabled = true;
  setComposerScanning(true);
  setStatus("neutral", "Detecting sensitive data");
  let providerPreference = "regex-only";
  let inference = createRegexOnlyInferenceResult();

  try {
    const decision = await chooseSmartMaskingProvider(text);
    providerPreference = decision.provider;
    setStatus("neutral", decision.statusMessage);

      if (providerPreference === "privacy-filter") {
        const ready = await ensurePrivacyFilterReady(decision);
        if (!ready) {
          providerPreference = "regex-only";
          setSmartModeStatus("Regex ready", "ready");
          setStatus("neutral", "Using quick local masking for this prompt.");
        }
      }

    inference = await requestInference(text, providerPreference);
    lastInferenceResult = inference;
    renderInferenceStatus(inference);

    if (!inference.ok || inference.fallbackUsed) {
      setStatus(
        "neutral",
        providerPreference === "privacy-filter"
          ? "Privacy Filter unavailable; using quick local masking."
          : "Using quick local masking."
      );
      providerPreference = "regex-only";
      inference = createRegexOnlyInferenceResult();
    }

    const masked = maskText(text, {
      sessionId,
      startIndex: nextPlaceholderIndex,
      externalSpans: inference.ok ? inference.spans : [],
      externalSource: inference.provider
    });
    const leakedOriginal = findLeakedOriginal(masked.maskedText, masked.entities);

    if (leakedOriginal) {
      clearMaskedDisplay();
      setStatus("error", "Masking safety check failed. Nothing was inserted.");
      renderInsertionDiagnostics({
        ok: false,
        inserted: false,
        error: "Masked text still contained an original detected value."
      });
      return;
    }

    nextPlaceholderIndex += masked.entities.length;
    latestMaskedText = masked.maskedText;
    maskedPreview.textContent = masked.maskedText;
    revealMaskedPreview();
    copyMaskedButton.disabled = masked.maskedText.length === 0;
    renderCounts(masked.detectedCounts);

    const response = await sendRuntimeMessage({
      type: "LM_COMPOSER_SUBMIT_MASKED",
      sessionId,
      sessionNonce,
      maskedText: masked.maskedText,
      entities: masked.entities,
      detectedCounts: masked.detectedCounts
    });

    lastInsertionResult = sanitizeInsertionResult(response ?? {});
    renderInsertionDiagnostics(response ?? {});
    updateDiagnosticsReport();

    if (response?.ok) {
      setStatus(
        "success",
        inference.ok
          ? "Masked prompt inserted. Review it before sending."
          : "Masked prompt inserted with deterministic masking only. Review it before sending."
      );
      return;
    }

    setStatus("error", response?.error || "Masking completed, but insertion failed.");
  } catch (error) {
    setStatus("error", error.message || "Unable to contact Local Masker.");
  } finally {
    setComposerScanning(false);
    maskInsertButton.disabled = false;
  }
}

async function handleInferenceStatus() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  inferenceStatusButton.disabled = true;
  setStatus("neutral", "Checking inference status...");

  try {
    const response = await sendRuntimeMessage({
      type: "LM_REQUEST_INFERENCE_STATUS",
      sessionId,
      sessionNonce
    });

    const normalized = normalizeInferenceStatusResponse(response);
    lastInferenceStatus = normalized;
    lastInferenceResult = normalized;
    renderInferenceStatus(normalized);

    if (normalized.ok) {
      setStatus("success", "Inference status ready.");
      return;
    }

    setStatus("neutral", "Offscreen inference unavailable; using deterministic masking only.");
  } catch (error) {
    const fallback = createInferenceFallback(error.message || "Unable to check inference status.");
    lastInferenceResult = fallback;
    renderInferenceStatus(fallback);
    setStatus("neutral", "Offscreen inference unavailable; using deterministic masking only.");
  } finally {
    inferenceStatusButton.disabled = false;
  }
}

async function handleLoadPrivacyFilter() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  if (loadPrivacyFilterButton) {
    loadPrivacyFilterButton.disabled = true;
  }
  setStatus("neutral", "Loading Privacy Filter model...");
  setSmartModeStatus("Setting up model", "loading");

  try {
    const response = await sendRuntimeMessage({
      type: "LM_REQUEST_LOAD_PRIVACY_FILTER",
      sessionId,
      sessionNonce,
      options: {
        providerPreference: "privacy-filter"
      }
    });

    const normalized = normalizePrivacyFilterLoadResponse(response);
    lastInferenceStatus = normalized;
    lastInferenceResult = normalized;
    renderInferenceStatus(normalized);

    if (normalized.ok) {
      if (providerSelect) {
        providerSelect.value = "privacy-filter";
      }
      await markPrivacyFilterSetupCompleted();
      setSmartModeStatus("Model ready", "ready");
      setStatus("success", "Privacy Filter model loaded.");
      return;
    }

    setSmartModeStatus("Regex ready", "ready");
    setStatus("error", normalized.error || "Privacy Filter model load failed. Quick masking remains available.");
  } catch (error) {
    const fallback = normalizePrivacyFilterLoadResponse({
      ok: false,
      error: error.message || "Privacy Filter model load failed."
    });
    lastInferenceResult = fallback;
    renderInferenceStatus(fallback);
    setSmartModeStatus("Regex ready", "ready");
    setStatus("error", fallback.error);
  } finally {
    if (loadPrivacyFilterButton) {
      loadPrivacyFilterButton.disabled = false;
    }
  }
}

async function handleRuntimeDiagnostics() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  runtimeDiagnosticsButton.disabled = true;
  setStatus("neutral", "Collecting runtime diagnostics...");

  try {
    const response = await sendRuntimeMessage({
      type: "LM_REQUEST_RUNTIME_DIAGNOSTICS",
      sessionId,
      sessionNonce
    });
    const report = sanitizeDiagnosticsReport({
      reportType: "local-masker-runtime-diagnostics",
      generatedAt: new Date().toISOString(),
      ok: Boolean(response?.ok),
      diagnostics: response?.diagnostics ?? null,
      error: response?.error || ""
    });

    latestRuntimeDiagnosticsReport = report;
    copyRuntimeDiagnosticsButton.disabled = false;
    renderRuntimeDiagnostics(report);

    if (response?.ok) {
      setStatus("success", "Runtime diagnostics ready.");
      return;
    }

    setStatus("error", response?.error || "Runtime diagnostics found issues.");
  } catch (error) {
    const report = sanitizeDiagnosticsReport({
      reportType: "local-masker-runtime-diagnostics",
      generatedAt: new Date().toISOString(),
      ok: false,
      error: error.message || "Runtime diagnostics failed."
    });
    latestRuntimeDiagnosticsReport = report;
    copyRuntimeDiagnosticsButton.disabled = false;
    renderRuntimeDiagnostics(report);
    setStatus("error", report.error || "Runtime diagnostics failed.");
  } finally {
    runtimeDiagnosticsButton.disabled = false;
  }
}

async function handleWebGPUProbe() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  webgpuProbeButton.disabled = true;
  setStatus("neutral", "Running WebGPU probe...");

  try {
    const [offscreen, content] = await Promise.all([
      sendRuntimeMessage({
        type: "LM_REQUEST_OFFSCREEN_WEBGPU_PROBE",
        sessionId,
        sessionNonce
      }),
      sendRuntimeMessage({
        type: "LM_REQUEST_CONTENT_WEBGPU_PROBE",
        sessionId,
        sessionNonce
      })
    ]);
    const report = createWebGPUProbeReport(offscreen, content);

    latestWebgpuDiagnosticsReport = report;
    copyWebgpuDiagnosticsButton.disabled = false;
    renderWebGPUProbe(report);
    setStatus(report.ok ? "success" : "neutral", report.ok ? "WebGPU probe PASS." : "WebGPU probe completed with limitations.");
  } catch (error) {
    const report = createWebGPUProbeReport(
      {
        ok: false,
        probe: {
          ok: false,
          contextLabel: "offscreen",
          navigatorGpuPresent: false,
          errorCategory: "unknown",
          errorMessage: error.message || "WebGPU probe failed."
        }
      },
      {
        ok: false,
        probe: {
          ok: false,
          contextLabel: "content",
          navigatorGpuPresent: false,
          errorCategory: "unknown",
          errorMessage: error.message || "WebGPU probe failed."
        }
      }
    );
    latestWebgpuDiagnosticsReport = report;
    copyWebgpuDiagnosticsButton.disabled = false;
    renderWebGPUProbe(report);
    setStatus("error", "WebGPU probe failed.");
  } finally {
    webgpuProbeButton.disabled = false;
  }
}

async function handlePrivacyFilterSmokeTest() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  privacyFilterSmokeButton.disabled = true;
  setStatus("neutral", "Running Privacy Filter smoke test...");

  try {
    const response = await sendRuntimeMessage({
      type: "LM_REQUEST_PRIVACY_FILTER_SMOKE_TEST",
      sessionId,
      sessionNonce,
      options: {
        loadIfNeeded: false
      }
    });

    renderPrivacyFilterSmokeResult(response ?? {});

    if (response?.ok) {
      setStatus("success", "Privacy Filter smoke test PASS.");
      return;
    }

    setStatus("error", response?.error || "Privacy Filter smoke test failed.");
  } catch (error) {
    const result = {
      ok: false,
      loaded: false,
      inferenceRan: false,
      error: error.message || "Privacy Filter smoke test failed."
    };
    renderPrivacyFilterSmokeResult(result);
    setStatus("error", result.error);
  } finally {
    privacyFilterSmokeButton.disabled = false;
  }
}

async function handleLocalSelfTest() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  const {
    SELF_TEST_PROMPT,
    isLocalSelfTestHostname,
    summarizeSelfTestMasking,
    validateSelfTestMaskedOutput
  } = await loadSelfTestModule();

  selfTestButton.disabled = true;
  setStatus("neutral", "Running local self-test...");

  const steps = {
    diagnosticsPassed: false,
    offscreenStatusPassed: false,
    inferencePassed: false,
    maskingPassed: false,
    insertionPassed: false,
    verificationPassed: false
  };

  try {
    const diagnostics = await requestTargetDiagnostics();
    renderTargetDiagnostics(diagnostics);
    latestDiagnosticsReport = createDiagnosticReport(diagnostics);
    copyDiagnosticsButton.disabled = false;
    steps.diagnosticsPassed = Boolean(diagnostics.ok);

    if (!diagnostics.ok) {
      throw new Error(diagnostics.error || "Target diagnostics failed.");
    }

    if (!isLocalSelfTestHostname(diagnostics.hostname)) {
      throw new Error("Local self-test only runs on localhost or 127.0.0.1 fixture pages.");
    }

    const statusResponse = normalizeInferenceStatusResponse(await requestInferenceStatusMessage());
    lastInferenceStatus = statusResponse;
    lastInferenceResult = statusResponse;
    renderInferenceStatus(statusResponse);
    steps.offscreenStatusPassed = statusResponse.ok &&
      Boolean(statusResponse.modelStatus?.mock?.loaded);

    if (!steps.offscreenStatusPassed) {
      throw new Error(statusResponse.error || "Mock offscreen inference status failed.");
    }

    const inference = await requestInference(SELF_TEST_PROMPT, "mock");
    lastInferenceResult = inference;
    renderInferenceStatus(inference);
    steps.inferencePassed = inference.ok &&
      inference.provider === "mock" &&
      inference.spans.length >= 2;

    if (!steps.inferencePassed) {
      throw new Error(inference.error || "Mock inference did not return expected spans.");
    }

    const masked = maskText(SELF_TEST_PROMPT, {
      sessionId,
      startIndex: nextPlaceholderIndex,
      externalSpans: inference.spans,
      externalSource: inference.provider
    });
    const maskValidation = validateSelfTestMaskedOutput(masked.maskedText, masked.entities);
    const maskingSummary = summarizeSelfTestMasking(masked, inference);
    steps.maskingPassed = maskValidation.ok &&
      Boolean(maskingSummary.masking?.hasPrivatePerson) &&
      Boolean(maskingSummary.masking?.hasPrivateAddress) &&
      Boolean(maskingSummary.masking?.hasPrivateEmail) &&
      Boolean(maskingSummary.masking?.hasSecret) &&
      Boolean(maskingSummary.masking?.hasAccountNumber);

    if (!steps.maskingPassed) {
      throw new Error("Self-test masking validation failed before insertion.");
    }

    nextPlaceholderIndex += masked.entities.length;
    latestMaskedText = masked.maskedText;
    maskedPreview.textContent = masked.maskedText;
    revealMaskedPreview();
    copyMaskedButton.disabled = masked.maskedText.length === 0;
    renderCounts(masked.detectedCounts);

    const insertion = await submitMaskedPrompt(masked);
    lastInsertionResult = sanitizeInsertionResult(insertion ?? {});
    renderInsertionDiagnostics(insertion ?? {});
    updateDiagnosticsReport();
    steps.insertionPassed = Boolean(insertion?.ok);

    if (!steps.insertionPassed) {
      throw new Error(insertion?.error || "Self-test insertion failed.");
    }

    const verification = await requestLocalSelfTestVerification();
    steps.verificationPassed = Boolean(verification?.ok);
    const report = {
      ok: steps.verificationPassed,
      steps,
      inference: sanitizeInferenceResult(inference),
      masking: maskingSummary.masking,
      insertion: lastInsertionResult,
      verification
    };

    renderSelfTestResults(report);

    if (!steps.verificationPassed) {
      setStatus("error", verification?.error || "Local self-test verification failed.");
      return;
    }

    setStatus("success", "Local self-test PASS.");
  } catch (error) {
    const report = {
      ok: false,
      steps,
      inference: sanitizeInferenceResult(lastInferenceResult),
      insertion: lastInsertionResult,
      error: error.message || "Local self-test failed."
    };
    renderSelfTestResults(report);
    setStatus("error", error.message || "Local self-test failed.");
  } finally {
    selfTestButton.disabled = false;
  }
}

async function handleDiagnoseTarget() {
  if (!sessionId || !sessionNonce) {
    setStatus("error", "Missing page session. Reopen the Local Masker panel.");
    return;
  }

  diagnoseButton.disabled = true;
  setStatus("neutral", "Inspecting prompt targets...");

  try {
    const response = await requestTargetDiagnostics();

    renderTargetDiagnostics(response ?? {});
    latestDiagnosticsReport = createDiagnosticReport(response ?? {});
    copyDiagnosticsButton.disabled = false;

    if (response?.ok) {
      setStatus("success", "Target diagnostics ready.");
      return;
    }

    setStatus("error", response?.error || "No suitable target found.");
  } catch (error) {
    setStatus("error", error.message || "Unable to inspect prompt targets.");
  } finally {
    diagnoseButton.disabled = false;
  }
}

function clearComposer() {
  rawPrompt.value = "";
  updatePromptMeta();
  clearMaskedDisplay();
  renderCounts({});
  lastInferenceResult = null;
  lastInferenceStatus = null;
  lastInsertionResult = null;
  latestDiagnosticsReport = null;
  latestRuntimeDiagnosticsReport = null;
  latestWebgpuDiagnosticsReport = null;
  copyDiagnosticsButton.disabled = true;
  copyRuntimeDiagnosticsButton.disabled = true;
  copyWebgpuDiagnosticsButton.disabled = true;
  renderInsertionDiagnostics({
    ok: false,
    inserted: false,
    status: "Not run"
  });
  renderTargetDiagnostics({
    ok: false,
    status: "Not run",
    candidates: []
  });
  renderInferenceStatus({
    ok: false,
    provider: "none",
    modelStatus: {
      provider: "none",
      loaded: false
    },
    spans: [],
    fallbackUsed: false,
    status: "Not checked"
  });
  renderSelfTestResults({
    ok: false,
    status: "Not run"
  });
  renderRuntimeDiagnostics({
    ok: false,
    status: "Not run"
  });
  renderWebGPUProbe({
    ok: false,
    status: "Not run"
  });
  renderPrivacyFilterSmokeResult({
    ok: false,
    status: "Not run"
  });
  setStatus("neutral", "Ready");
  rawPrompt.focus();
}

async function requestInference(text, providerPreference = getSelectedProvider()) {
  if (providerPreference === "regex-only") {
    return createRegexOnlyInferenceResult();
  }

  try {
    const response = await sendRuntimeMessage({
      type: "LM_REQUEST_INFERENCE",
      sessionId,
      sessionNonce,
      text,
      options: {
        providerPreference
      }
    });

    return normalizeInferenceResponse(response, providerPreference);
  } catch (error) {
    return createInferenceFallback(error.message || "Offscreen inference unavailable.");
  }
}

async function chooseSmartMaskingProvider(text) {
  const analysis = analyzeSmartMaskingNeed(text);
  const statusResponse = await getCurrentInferenceStatus();
  const privacyStatus = statusResponse?.modelStatus?.privacyFilter ?? {};

  if (!analysis.shouldUsePrivacyFilter) {
    return {
      provider: "regex-only",
      reason: analysis.reason,
      statusMessage: analysis.regexEntityCount > 0
        ? "Using quick local masking."
        : "Using quick local masking; no model needed for this prompt."
    };
  }

  if (privacyStatus.loaded || isPrivacyFilterLoaded()) {
    setSmartModeStatus("Model ready", "ready");
    return {
      provider: "privacy-filter",
      reason: analysis.reason,
      statusMessage: "Using stronger local masking."
    };
  }

  return {
    provider: "privacy-filter",
    reason: analysis.reason,
    setupRequired: true,
    statusMessage: "This prompt may need stronger local masking."
  };
}

function analyzeSmartMaskingNeed(text) {
  const source = String(text ?? "");
  const regexPreview = maskText(source, {
    sessionId,
    startIndex: 1
  });
  const regexEntityCount = regexPreview.entities.length;
  const addressPattern = /\b\d{1,6}\s+[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct|Place|Pl)\b/;
  const namedPersonPattern = /\b(?:customer|client|patient|employee|candidate|contact|lead|user|manager|owner)\s+(?:named\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/;
  const privateContextPattern = /\b(?:home address|street address|mailing address|passport|driver'?s license|patient|medical|customer|client|employee|candidate|lead)\b/i;
  const properNameNearActionPattern = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b.{0,80}\b(?:emailed|called|reported|requested|lives|works|from)\b/i;
  const signals = [];

  if (addressPattern.test(source)) {
    signals.push("street address");
  }

  if (namedPersonPattern.test(source) || properNameNearActionPattern.test(source)) {
    signals.push("person name");
  }

  if (privateContextPattern.test(source)) {
    signals.push("private context");
  }

  if (signals.length === 0) {
    return {
      shouldUsePrivacyFilter: false,
      regexEntityCount,
      reason: regexEntityCount > 0
        ? "Quick rules found the obvious private patterns."
        : "No semantic privacy signal found."
    };
  }

  return {
    shouldUsePrivacyFilter: true,
    regexEntityCount,
    reason: `This prompt appears to include ${signals.slice(0, 2).join(" and ")} that quick rules may miss.`
  };
}

async function getCurrentInferenceStatus() {
  try {
    const response = await requestInferenceStatusMessage();
    const normalized = normalizeInferenceStatusResponse(response);
    lastInferenceStatus = normalized;
    lastInferenceResult = normalized;
    renderInferenceStatus(normalized);
    if (normalized.modelStatus?.privacyFilter?.loaded) {
      setSmartModeStatus("Model ready", "ready");
    }
    return normalized;
  } catch {
    return lastInferenceStatus;
  }
}

async function ensurePrivacyFilterReady(decision) {
  if (isPrivacyFilterLoaded()) {
    return true;
  }

  const setupState = await readPrivacyFilterSetupState();
  if (!setupState.acceptedAt && !decision.skipPrompt) {
    const accepted = await showPrivacyFilterSetupDialog(decision.reason);
    if (!accepted) {
      await writePrivacyFilterSetupState({
        declinedAt: new Date().toISOString()
      });
      return false;
    }

    await writePrivacyFilterSetupState({
      acceptedAt: new Date().toISOString()
    });
  }

  setSmartModeStatus("Setting up model", "loading");
  setStatus("neutral", "Setting up stronger local masking. First setup can take a few minutes...");

  const response = await sendRuntimeMessage({
    type: "LM_REQUEST_LOAD_PRIVACY_FILTER",
    sessionId,
    sessionNonce,
    options: {
      providerPreference: "privacy-filter"
    }
  });
  const normalized = normalizePrivacyFilterLoadResponse(response);
  lastInferenceStatus = normalized;
  lastInferenceResult = normalized;
  renderInferenceStatus(normalized);

  if (normalized.ok) {
    await markPrivacyFilterSetupCompleted();
    setSmartModeStatus("Model ready", "ready");
    setStatus("success", "Ready.");
    return true;
  }

  setSmartModeStatus("Regex ready", "ready");
  setStatus("neutral", "Model setup did not finish. Using quick local masking for now.");
  return false;
}

async function initializePrivacyFilterSetupFlow() {
  if (isDevFixtureContext || !sessionId || !sessionNonce) {
    return;
  }

  const setupState = await readPrivacyFilterSetupState();
  const statusResponse = await getCurrentInferenceStatus();
  if (statusResponse?.modelStatus?.privacyFilter?.loaded) {
    setSmartModeStatus("Model ready", "ready");
    return;
  }

  const reason = "Set up the local model now so Local Masker can catch names, addresses, and other private details automatically.";
  if (setupState.acceptedAt) {
    await ensurePrivacyFilterReady({
      reason,
      skipPrompt: true
    });
    return;
  }

  if (setupState.declinedAt) {
    return;
  }

  const accepted = await showPrivacyFilterSetupDialog(reason, {
    title: "Prepare local masking",
    confirmText: "OK, start setup",
    cancelText: "Not now"
  });

  if (!accepted) {
    await writePrivacyFilterSetupState({
      declinedAt: new Date().toISOString()
    });
    return;
  }

  await writePrivacyFilterSetupState({
    acceptedAt: new Date().toISOString()
  });
  await ensurePrivacyFilterReady({
    reason,
    skipPrompt: true
  });
}

function showPrivacyFilterSetupDialog(reason, options = {}) {
  if (!setupDialog) {
    return Promise.resolve(false);
  }

  setupDialogTitle.textContent = options.title || "Set up stronger local masking?";
  setupReason.textContent = reason || "This prompt may contain private details that need semantic detection.";
  setupConfirmButton.textContent = options.confirmText || "OK, set it up";
  setupCancelButton.textContent = options.cancelText || "Use quick masking";
  setupDialog.hidden = false;
  setupConfirmButton.focus();

  return new Promise((resolve) => {
    setupDialogResolver = resolve;
  });
}

function resolveSetupDialog(accepted) {
  if (!setupDialogResolver) {
    return;
  }

  setupDialog.hidden = true;
  const resolve = setupDialogResolver;
  setupDialogResolver = null;
  resolve(Boolean(accepted));
}

async function readPrivacyFilterSetupState() {
  return new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve({});
      return;
    }

    chrome.storage.local.get(PRIVACY_FILTER_SETUP_STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }

      const value = result?.[PRIVACY_FILTER_SETUP_STORAGE_KEY];
      resolve(value && typeof value === "object" ? value : {});
    });
  });
}

async function writePrivacyFilterSetupState(patch) {
  const current = await readPrivacyFilterSetupState();
  return new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.set({
      [PRIVACY_FILTER_SETUP_STORAGE_KEY]: {
        ...current,
        ...patch
      }
    }, () => resolve());
  });
}

function markPrivacyFilterSetupCompleted() {
  return writePrivacyFilterSetupState({
    completedAt: new Date().toISOString()
  });
}

async function refreshSmartModeStatus() {
  const statusResponse = await getCurrentInferenceStatus();
  if (statusResponse?.modelStatus?.privacyFilter?.loaded) {
    setSmartModeStatus("Model ready", "ready");
    return;
  }

  setSmartModeStatus("Regex ready", "ready");
}

function requestInferenceStatusMessage() {
  return sendRuntimeMessage({
    type: "LM_REQUEST_INFERENCE_STATUS",
    sessionId,
    sessionNonce
  });
}

function requestTargetDiagnostics() {
  return sendRuntimeMessage({
    type: "LM_REQUEST_TARGET_DIAGNOSTICS",
    sessionId,
    sessionNonce
  });
}

function requestLocalSelfTestVerification() {
  return sendRuntimeMessage({
    type: "LM_REQUEST_LOCAL_SELF_TEST_VERIFY",
    sessionId,
    sessionNonce
  });
}

function submitMaskedPrompt(masked) {
  return sendRuntimeMessage({
    type: "LM_COMPOSER_SUBMIT_MASKED",
    sessionId,
    sessionNonce,
    maskedText: masked.maskedText,
    entities: masked.entities,
    detectedCounts: masked.detectedCounts
  });
}

async function copyMaskedPrompt() {
  if (!latestMaskedText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(latestMaskedText);
    setStatus("success", "Masked prompt copied.");
  } catch {
    setStatus("error", "Could not copy masked prompt.");
  }
}

async function copyDiagnostics() {
  if (!latestDiagnosticsReport) {
    return;
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(latestDiagnosticsReport, null, 2));
    setStatus("success", "Diagnostics copied.");
  } catch {
    setStatus("error", "Could not copy diagnostics.");
  }
}

async function copyRuntimeDiagnostics() {
  if (!latestRuntimeDiagnosticsReport) {
    return;
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(sanitizeDiagnosticsReport(latestRuntimeDiagnosticsReport), null, 2));
    setStatus("success", "Runtime diagnostics copied.");
  } catch {
    setStatus("error", "Could not copy runtime diagnostics.");
  }
}

async function copyWebGPUDiagnostics() {
  if (!latestWebgpuDiagnosticsReport) {
    return;
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(sanitizeWebGPUProbeResult(latestWebgpuDiagnosticsReport), null, 2));
    setStatus("success", "WebGPU diagnostics copied.");
  } catch {
    setStatus("error", "Could not copy WebGPU diagnostics.");
  }
}

function clearMaskedDisplay() {
  latestMaskedText = "";
  maskedPreview.textContent = "";
  maskedPreview.classList.remove("is-revealed");
  if (previewPanel) {
    previewPanel.hidden = true;
  }
  notifyResultVisibility(false);
  copyMaskedButton.disabled = true;
}

function revealMaskedPreview() {
  if (previewPanel) {
    previewPanel.hidden = false;
  }
  notifyResultVisibility(true);
  maskedPreview.classList.remove("is-revealed");
  void maskedPreview.offsetWidth;
  maskedPreview.classList.add("is-revealed");
}

function setComposerScanning(isScanning) {
  composerPanel?.classList.toggle("is-scanning", isScanning);
  if (maskInsertButtonLabel) {
    maskInsertButtonLabel.textContent = isScanning ? "Scanning locally..." : "Mask & Insert";
  }
}

function requestComposerClose() {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: "LM_CLOSE_COMPOSER",
      sessionId,
      sessionNonce
    }, "*");
  }
}

function notifyResultVisibility(visible) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: "LM_COMPOSER_RESULT_VISIBILITY",
      visible: Boolean(visible),
      sessionId,
      sessionNonce
    }, "*");
  }

  notifyComposerSize();
}

function startComposerSizeReporting() {
  notifyComposerSize();

  if (typeof ResizeObserver === "function" && shell) {
    const observer = new ResizeObserver(() => notifyComposerSize());
    observer.observe(shell);
  }
}

function notifyComposerSize() {
  if (!window.parent || window.parent === window) {
    return;
  }

  if (composerSizeRaf) {
    window.cancelAnimationFrame(composerSizeRaf);
  }

  composerSizeRaf = window.requestAnimationFrame(() => {
    const shellHeight = shell ? shell.getBoundingClientRect().height : 0;
    const bodyHeight = document.body?.scrollHeight || 0;
    const height = Math.max(shellHeight, bodyHeight) + 2;
    window.parent.postMessage({
      type: "LM_COMPOSER_SIZE",
      height,
      sessionId,
      sessionNonce
    }, "*");
  });
}

function findLeakedOriginal(maskedText, entities) {
  for (const entity of entities) {
    if (entity?.original && maskedText.includes(entity.original)) {
      return entity.original;
    }
  }

  return "";
}

function renderCounts(counts) {
  detectedCounts.textContent = "";

  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    detectedCounts.textContent = "None";
    return;
  }

  for (const [label, count] of entries) {
    const pill = document.createElement("span");
    pill.className = "count-pill";
    pill.textContent = `${label}: ${count}`;
    detectedCounts.appendChild(pill);
  }
}

function renderInferenceStatus(result) {
  inferenceStatus.textContent = "";

  const modelStatus = result.modelStatus ?? {};
  const mockStatus = modelStatus.mock ?? (modelStatus.provider === "mock" ? modelStatus : {});
  const privacyStatus = modelStatus.privacyFilter ?? (modelStatus.provider === "privacy-filter" ? modelStatus : {});
  const providerStatus = modelStatus.provider ? modelStatus : privacyStatus;
  const rows = [
    ["Active provider", result.activeProvider || result.provider || providerStatus.provider || "none"]
  ];

  if (isDevFixtureContext) {
    rows.push(["Mock loaded", String(Boolean(mockStatus.loaded))]);
  }

  rows.push(
    ["Privacy loaded", String(Boolean(privacyStatus.loaded))],
    ["Privacy loading", String(Boolean(privacyStatus.loading))],
    ["WebGPU", privacyStatus.webgpuAvailable === undefined ? "-" : String(Boolean(privacyStatus.webgpuAvailable))],
    ["WebGPU probe", privacyStatus.webgpuProbeOk === undefined ? "-" : String(Boolean(privacyStatus.webgpuProbeOk))],
    ["GPU adapter", privacyStatus.webgpuAdapterAvailable === undefined ? "-" : String(Boolean(privacyStatus.webgpuAdapterAvailable))],
    ["GPU device", privacyStatus.webgpuRequestDeviceOk === undefined ? "-" : String(Boolean(privacyStatus.webgpuRequestDeviceOk))],
    ["ONNX WebGPU", privacyStatus.onnxRuntimeWebgpuResolved === undefined ? "-" : String(Boolean(privacyStatus.onnxRuntimeWebgpuResolved))],
    ["Runtime mode", privacyStatus.resolvedRuntimeMode || "-"],
    ["Local runtime", privacyStatus.localRuntimeAssetsConfigured === undefined ? "-" : String(Boolean(privacyStatus.localRuntimeAssetsConfigured))],
    ["Device", providerStatus.device || privacyStatus.device || "none"],
    ["dtype", providerStatus.dtype || privacyStatus.dtype || "none"],
    ["Model", privacyStatus.modelId || providerStatus.modelId || "-"],
    ["Model source", privacyStatus.modelSource || providerStatus.modelSource || "-"],
    ["Model download", privacyStatus.modelDownloadAttempted === undefined ? "-" : String(Boolean(privacyStatus.modelDownloadAttempted))],
    ["Last inference ms", privacyStatus.lastInferenceMs === undefined ? "-" : String(privacyStatus.lastInferenceMs)],
    ["Last error category", privacyStatus.lastErrorCategory || "-"],
    ["Spans", String(result.spans?.length ?? 0)],
    ["Fallback", result.fallbackUsed ? "regex-only" : result.ok ? "provider+regex" : result.status || "not checked"]
  );

  const error = result.error || privacyStatus.lastErrorMessage || privacyStatus.error || "";
  if (error) {
    rows.push(["Error", error]);
  }

  renderDefinitionRows(inferenceStatus, rows);
}

function renderSelfTestResults(result) {
  selfTestResults.textContent = "";

  const steps = result.steps ?? {};
  const verification = result.verification ?? {};
  const forbidden = verification.forbiddenChecks ?? {};
  const placeholders = verification.placeholderChecks ?? {};
  const rows = [
    ["Status", result.ok ? "PASS" : result.status || "FAIL"],
    ["Diagnostics", formatPassFail(steps.diagnosticsPassed)],
    ["Offscreen status", formatPassFail(steps.offscreenStatusPassed)],
    ["Mock inference", formatPassFail(steps.inferencePassed)],
    ["Hybrid masking", formatPassFail(steps.maskingPassed)],
    ["Insertion", formatPassFail(steps.insertionPassed)],
    ["Verification", formatPassFail(steps.verificationPassed)],
    ["Forbidden absent", verification.containsAnyForbiddenKnownTestValue === false ? "PASS" : "FAIL"],
    ["Placeholders present", verification.containsExpectedPlaceholder ? "PASS" : "FAIL"],
    ["Person absent", formatBoolean(forbidden.personAbsent)],
    ["Email absent", formatBoolean(forbidden.emailAbsent)],
    ["Address absent", formatBoolean(forbidden.addressAbsent)],
    ["Secret absent", formatBoolean(forbidden.secretAbsent)],
    ["Account absent", formatBoolean(forbidden.accountAbsent)],
    ["Person placeholder", formatBoolean(placeholders.hasPrivatePersonPlaceholder)],
    ["Address placeholder", formatBoolean(placeholders.hasPrivateAddressPlaceholder)],
    ["Email placeholder", formatBoolean(placeholders.hasPrivateEmailPlaceholder)],
    ["Secret placeholder", formatBoolean(placeholders.hasSecretPlaceholder)],
    ["Account placeholder", formatBoolean(placeholders.hasAccountNumberPlaceholder)]
  ];

  if (result.error || verification.error) {
    rows.push(["Error", result.error || verification.error]);
  }

  renderDefinitionRows(selfTestResults, rows);
}

function renderRuntimeDiagnostics(report) {
  runtimeDiagnostics.textContent = "";

  const diagnostics = report.diagnostics ?? report;
  const runtime = diagnostics.runtime ?? {};
  const webgpuProbe = diagnostics.webgpuProbe ?? {};
  const transformers = diagnostics.transformers ?? {};
  const assets = diagnostics.assets ?? {};
  const build = diagnostics.build ?? {};
  const csp = diagnostics.csp ?? {};
  const privacy = diagnostics.providers?.privacyFilter ?? {};
  const errors = diagnostics.errors ?? [];
  const failedAssets = (assets.checkedAssets ?? []).filter((asset) => !asset.ok).length;
  const rows = [
    ["Status", report.ok || diagnostics.ok ? "PASS" : report.status || "FAIL"],
    ["Protocol", runtime.locationProtocol || "-"],
    ["Offscreen", formatBoolean(runtime.isOffscreenDocument)],
    ["WebGPU", formatBoolean(runtime.webgpuAvailable)],
    ["Probe adapter", formatBoolean(webgpuProbe.adapterReturned)],
    ["Probe device", formatBoolean(webgpuProbe.requestDeviceOk)],
    ["Probe failure", webgpuProbe.failureCategory || "-"],
    ["Cross isolated", runtime.crossOriginIsolated === undefined ? "-" : String(runtime.crossOriginIsolated)],
    ["TF import", formatBoolean(transformers.importAvailable)],
    ["TF env", formatBoolean(transformers.envConfigured)],
    ["ONNX WebGPU", formatBoolean(transformers.onnxRuntimeWebgpuImportResolvable)],
    ["Local WASM", formatBoolean(transformers.localWasmPathConfigured)],
    ["Local runtime", formatBoolean(transformers.localRuntimeAssetsConfigured)],
    ["Runtime mode", transformers.resolvedRuntimeMode || "-"],
    ["WASM origin", transformers.localWasmPathOrigin || "-"],
    ["Bare ONNX imports", formatBoolean(assets.offscreenBundleHasBareOnnxImports)],
    ["Build manifest", formatBoolean(assets.buildManifestAvailable)],
    ["Build generated", build.generatedAt || "-"],
    ["Transformers", build.transformersVersion || "-"],
    ["ONNX Runtime", build.onnxruntimeWebVersion || transformers.onnxruntimeWebPackageVersion || "-"],
    ["esbuild", build.esbuildVersion || "-"],
    ["WASM assets", String(assets.wasmAssetsKnown ?? 0)],
    ["Checked assets", String(assets.checkedAssets?.length ?? 0)],
    ["Failed assets", String(failedAssets)],
    ["Privacy loaded", formatBoolean(privacy.loaded)],
    ["Privacy loading", formatBoolean(privacy.loading)],
    ["Privacy error category", privacy.lastErrorCategory || "-"],
    ["Runtime error category", transformers.runtimeResolutionErrorCategory || "-"],
    ["Unsafe eval", formatBoolean(csp.unsafeEvalAllowed)],
    ["WASM eval", formatBoolean(csp.wasmUnsafeEvalConfigured)],
    ["Eval shim risk", formatBoolean(csp.suspectedEvalShimRisk)],
    ["Errors", String(errors.length)]
  ];

  if (errors[0]) {
    rows.push(["First error", `${errors[0].category || "unknown"}: ${errors[0].message || "-"}`]);
  } else if (transformers.runtimeResolutionErrorMessage) {
    rows.push(["Runtime error", transformers.runtimeResolutionErrorMessage]);
  } else if (report.error) {
    rows.push(["Error", report.error]);
  }

  renderDefinitionRows(runtimeDiagnostics, rows);
}

function renderWebGPUProbe(report) {
  webgpuProbeDiagnostics.textContent = "";

  const offscreen = report.offscreenSummary ?? {};
  const content = report.contentSummary ?? {};
  const comparison = report.comparison ?? {};
  const rows = [
    ["Status", report.ok ? "PASS" : report.status || "FAIL"],
    ["Offscreen GPU", formatBoolean(offscreen.navigatorGpuPresent)],
    ["Offscreen adapter", formatBoolean(offscreen.adapterReturned)],
    ["Offscreen device", formatBoolean(offscreen.requestDeviceOk)],
    ["Content GPU", formatBoolean(content.navigatorGpuPresent)],
    ["Content adapter", formatBoolean(content.adapterReturned)],
    ["Content device", formatBoolean(content.requestDeviceOk)],
    ["Failure category", comparison.failureCategory || offscreen.failureCategory || content.failureCategory || "-"],
    ["Offscreen only", formatBoolean(comparison.offscreenOnlyUnavailable)],
    ["Recommendation", report.recommendation || "-"]
  ];

  if (report.error) {
    rows.push(["Error", report.error]);
  }

  renderDefinitionRows(webgpuProbeDiagnostics, rows);
}

function renderPrivacyFilterSmokeResult(result) {
  privacyFilterSmokeResults.textContent = "";

  const labels = result.labelsReturned ?? {};
  const labelSummary = Object.keys(labels).length
    ? Object.entries(labels).map(([label, count]) => `${label}:${count}`).join(", ")
    : "-";
  const rows = [
    ["Status", result.ok ? "PASS" : result.status || "FAIL"],
    ["Loaded", formatBoolean(result.loaded)],
    ["Inference ran", formatBoolean(result.inferenceRan)],
    ["Elapsed ms", String(result.elapsedMs ?? 0)],
    ["Spans", String(result.spansReturned ?? 0)],
    ["Normalized", String(result.normalizedSpanCount ?? 0)],
    ["Labels", labelSummary],
    ["Error category", result.errorCategory || "-"]
  ];

  if (result.error) {
    rows.push(["Error", result.error]);
  }

  if (result.warnings?.length) {
    rows.push(["Warnings", result.warnings.join("; ")]);
  }

  renderDefinitionRows(privacyFilterSmokeResults, rows);
}

function renderInsertionDiagnostics(result) {
  insertionDiagnostics.textContent = "";

  const rows = [
    ["Status", result.ok ? "PASS" : result.status || "FAIL"],
    ["Adapter", result.adapterName || "-"],
    ["Target kind", result.targetKind || "-"],
    ["Target", result.targetDescription || "-"],
    ["Strategy", result.strategy || "-"],
    ["Method", result.method || "-"]
  ];

  if (result.error) {
    rows.push(["Error", result.error]);
  }

  renderDefinitionRows(insertionDiagnostics, rows);
}

function renderTargetDiagnostics(result) {
  targetDiagnostics.textContent = "";
  candidateList.textContent = "";

  const selected = result.selectedTarget;
  const rows = [
    ["Status", result.ok ? "PASS" : result.status || "FAIL"],
    ["Adapter", result.adapterName || "-"],
    ["Hostname", result.hostname || "-"],
    ["Origin", result.origin || "-"],
    ["Selected", selected ? selected.safeSelectorHint || "-" : "-"],
    ["Tag", selected?.tagName || "-"],
    ["Role", selected?.role || "-"],
    ["Editable", selected?.contentEditable || "-"],
    ["Input type", selected?.inputType || "-"],
    ["Target kind", selected?.targetKind || "-"],
    ["Strategy", selected?.strategy || "-"],
    ["Size", selected ? `${selected.width ?? 0}x${selected.height ?? 0}` : "-"],
    ["Position", selected?.viewportPosition || "-"],
    ["Candidates", String(result.candidates?.length ?? 0)]
  ];

  if (result.error) {
    rows.push(["Error", result.error]);
  }

  renderDefinitionRows(targetDiagnostics, rows);

  const topCandidates = (result.candidates ?? []).slice(0, 5);
  if (topCandidates.length === 0) {
    candidateList.textContent = "No candidates.";
    return;
  }

  for (const candidate of topCandidates) {
    const item = document.createElement("div");
    item.className = "candidate";
    item.textContent = [
      candidate.safeSelectorHint || candidate.tagName || "unknown",
      `strategy=${candidate.strategy || "-"}`,
      `kind=${candidate.targetKind || "-"}`,
      `tag=${candidate.tagName || "-"}`,
      `role=${candidate.role || "-"}`,
      `score=${candidate.score ?? "-"}`,
      `visible=${Boolean(candidate.visible)}`,
      `size=${candidate.width ?? 0}x${candidate.height ?? 0}`,
      `position=${candidate.viewportPosition || "-"}`
    ].join(" | ");
    candidateList.appendChild(item);
  }
}

function createDiagnosticReport(result) {
  return {
    reportType: "local-masker-target-diagnostics",
    generatedAt: new Date().toISOString(),
    ok: Boolean(result.ok),
    adapterName: result.adapterName || "",
    hostname: result.hostname || "",
    origin: result.origin || "",
    selectedTarget: result.selectedTarget || null,
    candidateCount: result.candidates?.length ?? 0,
    topCandidates: (result.candidates ?? []).slice(0, 10),
    inferenceStatus: sanitizeInferenceResult(lastInferenceResult),
    lastInsertionResult,
    error: result.error || ""
  };
}

function createWebGPUProbeReport(offscreenResponse, contentResponse) {
  const offscreenProbe = sanitizeWebGPUProbeResult(offscreenResponse?.probe ?? {
    ok: false,
    contextLabel: "offscreen",
    navigatorGpuPresent: false,
    errorCategory: "unknown",
    errorMessage: offscreenResponse?.error || "No offscreen probe response."
  });
  const contentProbe = sanitizeWebGPUProbeResult(contentResponse?.probe ?? {
    ok: false,
    contextLabel: "content",
    navigatorGpuPresent: false,
    errorCategory: "unknown",
    errorMessage: contentResponse?.error || "No content probe response."
  });
  const offscreenSummary = summarizeWebGPUProbe(offscreenProbe);
  const contentSummary = summarizeWebGPUProbe(contentProbe);
  const failureCategory = offscreenSummary.failureCategory || contentSummary.failureCategory || "";
  const comparison = {
    offscreenOnlyUnavailable: Boolean(contentSummary.requestDeviceOk && !offscreenSummary.requestDeviceOk),
    unavailableInBothContexts: Boolean(!contentSummary.requestDeviceOk && !offscreenSummary.requestDeviceOk),
    failureCategory
  };

  return sanitizeWebGPUProbeResult({
    reportType: "local-masker-webgpu-probe",
    generatedAt: new Date().toISOString(),
    ok: Boolean(offscreenSummary.requestDeviceOk),
    offscreenProbe,
    contentProbe,
    offscreenSummary,
    contentSummary,
    comparison,
    recommendation: getWebGPURecommendation(comparison, offscreenSummary, contentSummary)
  });
}

function getWebGPURecommendation(comparison, offscreen, content) {
  if (offscreen.requestDeviceOk) {
    return "WebGPU adapter and device are available in the offscreen context.";
  }

  if (comparison.offscreenOnlyUnavailable) {
    return "WebGPU works in page context but not offscreen. Use Regex only on this browser/device.";
  }

  if (offscreen.unsafeFlagRecommendedForDevOnly || content.unsafeFlagRecommendedForDevOnly) {
    return "For development E2E only, try the unsafe WebGPU launch flag path.";
  }

  return "Check chrome://gpu and graphics acceleration settings. Use Regex only on this device/browser.";
}

function updateDiagnosticsReport() {
  if (!latestDiagnosticsReport) {
    return;
  }

  latestDiagnosticsReport = {
    ...latestDiagnosticsReport,
    inferenceStatus: sanitizeInferenceResult(lastInferenceResult),
    lastInsertionResult
  };
}

function sanitizeInsertionResult(result) {
  return {
    ok: Boolean(result.ok),
    inserted: Boolean(result.inserted),
    adapterName: result.adapterName || "",
    targetKind: result.targetKind || "",
    targetDescription: result.targetDescription || "",
    strategy: result.strategy || "",
    method: result.method || "",
    error: result.error || ""
  };
}

function renderDefinitionRows(container, rows) {
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    const valueClass = getDiagnosticValueClass(value);

    term.textContent = label;
    description.textContent = value;
    if (valueClass) {
      description.className = `value-pill ${valueClass}`;
    }

    row.append(term, description);
    container.appendChild(row);
  }
}

function getDiagnosticValueClass(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "pass") {
    return "value-pass";
  }

  if (normalized === "fail") {
    return "value-fail";
  }

  if (normalized === "not run" || normalized === "not checked" || normalized === "-") {
    return "value-neutral";
  }

  return "";
}

function updatePromptMeta() {
  if (!promptMeta) {
    return;
  }

  const text = rawPrompt.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  promptMeta.textContent = `${text.length} chars / ${words} words`;
}

function handlePromptInput() {
  updatePromptMeta();
  if (latestMaskedText) {
    clearMaskedDisplay();
  }

  if (status) {
    status.hidden = true;
  }
}

function formatPassFail(value) {
  if (value === undefined) {
    return "-";
  }

  return value ? "PASS" : "FAIL";
}

function formatBoolean(value) {
  if (value === undefined) {
    return "-";
  }

  return value ? "true" : "false";
}

function normalizeInferenceResponse(response, requestedProvider = "regex-only") {
  if (!response?.ok) {
    return createInferenceFallback(response?.error || "Offscreen inference unavailable.", requestedProvider);
  }

  return {
    ok: true,
    provider: response.provider || "unknown",
    modelStatus: response.modelStatus ?? {
      provider: response.provider || "unknown",
      loaded: false
    },
    spans: Array.isArray(response.spans) ? response.spans : [],
    fallbackUsed: false,
    warnings: response.warnings
  };
}

function normalizeInferenceStatusResponse(response) {
  if (!response?.ok) {
    return createInferenceFallback(response?.error || "Offscreen inference unavailable.");
  }

  return {
    ok: true,
    provider: response.provider || response.activeProvider || "unknown",
    activeProvider: response.activeProvider || response.provider || "unknown",
    availableProviders: Array.isArray(response.availableProviders) ? response.availableProviders : [],
    modelStatus: response.modelStatus ?? createDefaultProviderStatuses(),
    spans: [],
    fallbackUsed: false
  };
}

function normalizePrivacyFilterLoadResponse(response) {
  const statuses = createDefaultProviderStatuses();
  statuses.privacyFilter = response?.modelStatus ?? statuses.privacyFilter;
  return {
    ok: Boolean(response?.ok),
    provider: "privacy-filter",
    activeProvider: "privacy-filter",
    modelStatus: statuses,
    spans: [],
    fallbackUsed: !response?.ok,
    error: response?.error || (response?.ok ? "" : "Privacy Filter model load failed.")
  };
}

function createInferenceFallback(error, requestedProvider = "none") {
  return {
    ok: false,
    provider: requestedProvider === "regex-only" ? "regex-only" : "none",
    modelStatus: {
      provider: requestedProvider === "privacy-filter" ? "privacy-filter" : "none",
      loaded: false,
      device: "none",
      dtype: "none"
    },
    spans: [],
    fallbackUsed: true,
    error
  };
}

function sanitizeInferenceResult(result) {
  if (!result) {
    return null;
  }

  return {
    ok: Boolean(result.ok),
    provider: result.provider || "",
    modelStatus: result.modelStatus ?? null,
    spansReturned: result.spans?.length ?? 0,
    fallbackUsed: Boolean(result.fallbackUsed),
    error: result.error || ""
  };
}

function createRegexOnlyInferenceResult() {
  return {
    ok: true,
    provider: "regex-only",
    modelStatus: {
      provider: "regex-only",
      loaded: true,
      device: "none",
      dtype: "none",
      modelId: "deterministic-regex"
    },
    spans: [],
    fallbackUsed: false
  };
}

function getSelectedProvider() {
  return providerSelect?.value || "regex-only";
}

function applyContextVisibility() {
  const shouldHideDevControls = !isDevFixtureContext;

  for (const element of document.querySelectorAll("[data-dev-only='true']")) {
    if (element instanceof HTMLOptionElement) {
      element.hidden = shouldHideDevControls;
      element.disabled = shouldHideDevControls;
      continue;
    }

    element.hidden = shouldHideDevControls;
  }

  if (shouldHideDevControls && providerSelect?.value === "mock") {
    providerSelect.value = "regex-only";
  }
}

function normalizeHostContext(value) {
  return String(value || "").trim().toLowerCase();
}

function isLocalFixtureHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function loadSelfTestModule() {
  if (!selfTestModulePromise) {
    selfTestModulePromise = import("../dev/selfTestConstants.js");
  }

  return selfTestModulePromise;
}

function isPrivacyFilterLoaded() {
  const status = lastInferenceStatus?.modelStatus?.privacyFilter;
  if (status?.loaded) {
    return true;
  }

  const resultStatus = lastInferenceResult?.modelStatus;
  return Boolean(resultStatus?.provider === "privacy-filter" && resultStatus.loaded);
}

function setSmartModeStatus(message, kind = "neutral") {
  if (!smartModeStatus) {
    return;
  }

  smartModeStatus.textContent = message;
  smartModeStatus.dataset.state = kind;
}

function createDefaultProviderStatuses() {
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
      loaded: true,
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
      onnxRuntimeWebgpuResolved: false,
      localRuntimeAssetsConfigured: false,
      localWasmPathConfigured: false,
      resolvedRuntimeMode: "unknown",
      webgpuProbeOk: false,
      webgpuAdapterAvailable: false,
      webgpuRequestDeviceOk: false,
      webgpuFailureCategory: "",
      modelDownloadAttempted: false
    }
  };
}

function setStatus(kind, message) {
  status.className = `status ${kind}`;
  status.textContent = message;
  status.hidden = kind !== "error";
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
