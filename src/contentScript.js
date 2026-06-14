const ROOT_ID = "local-masker-extension-root";
const COMPOSER_URL = chrome.runtime.getURL("src/composer/composer.html");

const sessionId = createSessionId();
const sessionNonce = createSessionId();
const vaultBySession = new Map();
const extensionModulesReady = loadExtensionModules();

let findPromptTarget;
let diagnosePromptTargets;
let isLocalSelfTestHostname;
let verifyKnownSelfTestEditorState;
let selfTestModulePromise;
let webgpuDiagnosticsModulePromise;
let rootHost;
let shadowRoot;
let iframe;
let launcherButton;
let lastFocusedPrompt;
let lastInsertionMetadata;
let composerSizeRaf = 0;

initialize().catch(() => {
  // Keep startup failures private and non-sensitive. The composer will surface
  // structured errors if adapter modules are unavailable during an action.
});

window.addEventListener("pagehide", clearVaults, { once: true });
window.addEventListener("beforeunload", clearVaults, { once: true });
window.addEventListener("message", handleComposerWindowMessage);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        inserted: false,
        targetKind: "",
        targetDescription: "",
        method: "",
        error: error.message || "Local Masker content script failed."
      });
    });
  return true;
});

async function initialize() {
  registerSession();
  injectFloatingButton();

  const { adapters } = await extensionModulesReady;
  findPromptTarget = adapters.findPromptTarget;
  diagnosePromptTargets = adapters.diagnosePromptTargets;

  trackPromptFocus();
}

async function loadExtensionModules() {
  const adapters = await (globalThis.__localMaskerSiteAdapters ?? import(chrome.runtime.getURL("src/siteAdapters.js")));

  return { adapters };
}

async function handleRuntimeMessage(message) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Unsupported Local Masker message." };
  }

  await extensionModulesReady;

  if (message.type === "LM_INSERT_MASKED_PROMPT") {
    return handleInsertMaskedPrompt(message);
  }

  if (message.type === "LM_DIAGNOSE_PROMPT_TARGETS") {
    return handleDiagnosePromptTargets(message);
  }

  if (message.type === "LM_LOCAL_SELF_TEST_VERIFY") {
    return handleLocalSelfTestVerify(message);
  }

  if (message.type === "LM_CONTENT_WEBGPU_PROBE") {
    return handleContentWebGPUProbe(message);
  }

  return { ok: false, error: "Unsupported Local Masker message." };
}

function handleInsertMaskedPrompt(message) {
  if (message.sessionId !== sessionId) {
    return createInsertionFailure("Session mismatch.");
  }

  if (typeof message.maskedText !== "string") {
    return createInsertionFailure("Masked text was not a string.");
  }

  if (!Array.isArray(message.entities)) {
    return createInsertionFailure("Entities were not provided as an array.");
  }

  clearStaleVaults();
  storeEntities(sessionId, message.entities);
  return insertMaskedPrompt(message.maskedText);
}

function handleDiagnosePromptTargets(message) {
  if (message.sessionId !== sessionId) {
    return {
      ok: false,
      sessionId,
      adapterName: "",
      hostname: location.hostname,
      origin: location.origin,
      selectedTarget: null,
      candidates: [],
      error: "Session mismatch."
    };
  }

  const diagnosis = diagnosePromptTargets(document, createAdapterOptions());
  return {
    ok: diagnosis.ok,
    sessionId,
    adapterName: diagnosis.adapterName,
    hostname: diagnosis.hostname,
    origin: diagnosis.origin,
    selectedTarget: diagnosis.selectedTarget,
    candidates: diagnosis.candidates,
    error: diagnosis.error
  };
}

async function handleLocalSelfTestVerify(message) {
  if (message.sessionId !== sessionId) {
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
      error: "Session mismatch."
    };
  }

  const selfTest = await loadSelfTestModule();
  isLocalSelfTestHostname = selfTest.isLocalSelfTestHostname;
  verifyKnownSelfTestEditorState = selfTest.verifyKnownSelfTestEditorState;

  if (!isLocalSelfTestHostname(location.hostname)) {
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
      error: "Local self-test verification only runs on localhost or 127.0.0.1."
    };
  }

  const targetResult = findPromptTarget(document, createAdapterOptions());
  if (!targetResult.ok || !targetResult.target) {
    return verifyKnownSelfTestEditorState("", {
      isLocalFixture: true,
      adapterName: targetResult.adapterName,
      targetKind: targetResult.targetKind,
      targetDescription: targetResult.targetDescription,
      method: "",
      error: targetResult.error || "No local fixture target found."
    });
  }

  const editorSnapshot = getTargetEditorSnapshot(targetResult.target, targetResult.targetKind);
  return verifyKnownSelfTestEditorState(editorSnapshot, {
    isLocalFixture: true,
    adapterName: targetResult.adapterName,
    targetKind: targetResult.targetKind,
    targetDescription: targetResult.targetDescription,
    method: lastInsertionMetadata?.method || "local-self-test-read",
    scenario: message.scenario
  });
}

async function handleContentWebGPUProbe(message) {
  if (message.sessionId !== sessionId) {
    return {
      ok: false,
      sessionId,
      probe: {
        ok: false,
        contextLabel: "content",
        navigatorGpuPresent: typeof navigator !== "undefined" && Boolean(navigator.gpu),
        errorCategory: "unknown",
        errorMessage: "Session mismatch."
      }
    };
  }

  const { probeWebGPU } = await loadWebGPUDiagnosticsModule();
  const probe = await probeWebGPU({ contextLabel: "content" });
  return {
    ok: Boolean(probe.ok),
    sessionId,
    probe
  };
}

function loadSelfTestModule() {
  if (!selfTestModulePromise) {
    selfTestModulePromise = globalThis.__localMaskerSelfTest ??
      import(chrome.runtime.getURL("src/dev/selfTestConstants.js"));
  }

  return selfTestModulePromise;
}

function loadWebGPUDiagnosticsModule() {
  if (!webgpuDiagnosticsModulePromise) {
    webgpuDiagnosticsModulePromise = import(chrome.runtime.getURL("src/inference/webgpuDiagnostics.js"));
  }

  return webgpuDiagnosticsModulePromise;
}

function createSessionId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function registerSession() {
  clearStaleVaults();
  chrome.runtime.sendMessage({
    type: "LM_REGISTER_SESSION",
    sessionId,
    sessionNonce
  });
}

function injectFloatingButton() {
  if (document.getElementById(ROOT_ID)) {
    return;
  }

  rootHost = document.createElement("div");
  rootHost.id = ROOT_ID;
  document.documentElement.appendChild(rootHost);

  shadowRoot = rootHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      color-scheme: normal;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .lm-button {
      align-items: center;
      backdrop-filter: blur(14px);
      background: rgba(17, 31, 46, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      bottom: 18px;
      box-shadow: 0 16px 38px rgba(0, 0, 0, 0.28);
      color: #f5f8fb;
      cursor: pointer;
      display: inline-flex;
      font: 650 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      gap: 9px;
      min-height: 42px;
      padding: 0 15px 0 9px;
      position: fixed;
      right: 18px;
      z-index: 2147483646;
      transition: background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
    }

    .lm-button[hidden] {
      display: none;
    }

    .lm-button-icon {
      background: rgba(61, 214, 198, 0.09);
      border: 1px solid rgba(61, 214, 198, 0.18);
      border-radius: 999px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      flex: 0 0 auto;
      height: 28px;
      position: relative;
      width: 28px;
    }

    .lm-button-icon::before,
    .lm-button-icon::after {
      content: "";
      left: 50%;
      position: absolute;
      transform: translateX(-50%);
    }

    .lm-button-icon::before {
      border: 2px solid #3dd6c6;
      border-bottom: 0;
      border-radius: 7px 7px 0 0;
      height: 9px;
      top: 6px;
      width: 12px;
    }

    .lm-button-icon::after {
      background: linear-gradient(180deg, #3dd6c6, #2aa59c);
      border-radius: 4px;
      box-shadow: 0 5px 12px rgba(61, 214, 198, 0.22);
      height: 12px;
      top: 15px;
      width: 16px;
    }

    .lm-button:hover,
    .lm-button:focus-visible {
      background: rgba(20, 37, 56, 0.98);
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.34);
      outline: 2px solid rgba(61, 214, 198, 0.14);
      outline-offset: 3px;
      transform: translateY(-1px);
    }

    .lm-frame {
      background: transparent !important;
      background-color: transparent !important;
      border: 0;
      border-radius: 8px;
      bottom: 18px;
      box-shadow: none;
      color-scheme: normal;
      height: min(500px, calc(100vh - 36px));
      position: fixed;
      right: 18px;
      width: min(520px, calc(100vw - 32px));
      z-index: 2147483646;
    }

    .lm-frame.has-result {
      height: min(660px, calc(100vh - 36px));
    }

    @media (prefers-color-scheme: dark) {
      .lm-frame {
        background: transparent;
        border-color: transparent;
        box-shadow: none;
      }
    }

    @media (max-width: 540px) {
      .lm-button {
        bottom: 12px;
        right: 12px;
      }

      .lm-frame {
        bottom: 8px;
        height: min(500px, calc(100vh - 16px));
        left: 8px;
        right: 8px;
        width: auto;
      }

      .lm-frame.has-result {
        height: min(660px, calc(100vh - 16px));
      }
    }
  `;

  launcherButton = document.createElement("button");
  launcherButton.className = "lm-button";
  launcherButton.type = "button";
  const launcherIcon = document.createElement("span");
  launcherIcon.className = "lm-button-icon";
  launcherIcon.setAttribute("aria-hidden", "true");
  const launcherLabel = document.createElement("span");
  launcherLabel.textContent = "Local Masker";
  launcherButton.append(launcherIcon, launcherLabel);
  launcherButton.addEventListener("click", toggleComposer);

  shadowRoot.append(style, launcherButton);
}

function toggleComposer() {
  if (iframe) {
    closeComposer();
    return;
  }

  registerSession();

  const query = new URLSearchParams({
    sessionId,
    sessionNonce,
    hostname: location.hostname
  });

  iframe = document.createElement("iframe");
  iframe.className = "lm-frame";
  iframe.title = "Local Masker secure composer";
  iframe.allow = "";
  iframe.setAttribute("allowtransparency", "true");
  iframe.referrerPolicy = "no-referrer";
  iframe.style.background = "transparent";
  iframe.style.backgroundColor = "transparent";
  iframe.style.colorScheme = "normal";
  iframe.src = `${COMPOSER_URL}?${query.toString()}`;
  shadowRoot.appendChild(iframe);
  resizeComposerFrame(500);
  if (launcherButton) {
    launcherButton.hidden = true;
  }
}

function closeComposer() {
  if (iframe) {
    iframe.remove();
    iframe = undefined;
  }

  if (composerSizeRaf) {
    cancelAnimationFrame(composerSizeRaf);
    composerSizeRaf = 0;
  }

  if (launcherButton) {
    launcherButton.hidden = false;
  }
}

function handleComposerWindowMessage(event) {
  if (!iframe || event.source !== iframe.contentWindow) {
    return;
  }

  if (event.data?.type === "LM_CLOSE_COMPOSER") {
    closeComposer();
    return;
  }

  if (event.data?.type === "LM_COMPOSER_RESULT_VISIBILITY") {
    iframe.classList.toggle("has-result", Boolean(event.data.visible));
    return;
  }

  if (event.data?.type === "LM_COMPOSER_SIZE") {
    resizeComposerFrame(event.data.height);
  }
}

function resizeComposerFrame(height) {
  if (!iframe) {
    return;
  }

  if (composerSizeRaf) {
    cancelAnimationFrame(composerSizeRaf);
  }

  composerSizeRaf = requestAnimationFrame(() => {
    const requestedHeight = Number(height);
    if (!Number.isFinite(requestedHeight) || requestedHeight <= 0) {
      return;
    }

    const viewportLimit = Math.max(360, window.innerHeight - 36);
    const nextHeight = Math.min(Math.max(Math.ceil(requestedHeight), 360), viewportLimit);
    iframe.style.height = `${nextHeight}px`;
  });
}

function storeEntities(sessionIdToStore, entities) {
  const vault = vaultBySession.get(sessionIdToStore) ?? new Map();
  const createdAt = Date.now();

  for (const entity of entities) {
    if (!entity || typeof entity.placeholder !== "string" || typeof entity.original !== "string") {
      continue;
    }

    vault.set(entity.placeholder, {
      original: entity.original,
      label: typeof entity.label === "string" ? entity.label : "unknown",
      createdAt
    });
  }

  vaultBySession.set(sessionIdToStore, vault);
}

function clearStaleVaults() {
  for (const vaultSessionId of vaultBySession.keys()) {
    if (vaultSessionId !== sessionId) {
      vaultBySession.delete(vaultSessionId);
    }
  }
}

function clearVaults() {
  vaultBySession.clear();
}

function rehydrateTextForExtensionDisplay(sessionIdToHydrate, text) {
  const vault = vaultBySession.get(sessionIdToHydrate);
  void vault;
  // TODO: use vaultBySession to replace placeholders only inside an
  // extension-owned display layer. Never rehydrate into the host page DOM.
  return String(text ?? "");
}

function insertMaskedPrompt(maskedText) {
  const targetResult = findPromptTarget(document, createAdapterOptions());
  if (!targetResult.ok || !targetResult.target) {
    return {
      ...createInsertionFailure(targetResult.error || "Could not find a prompt input on this page."),
      adapterName: targetResult.adapterName,
      strategy: targetResult.strategy,
      candidates: targetResult.candidates
    };
  }

  try {
    const method = targetResult.targetKind === "textarea" || targetResult.targetKind === "input"
      ? setTextInputValue(targetResult.target, maskedText)
      : setContentEditableValue(targetResult.target, maskedText);

    lastInsertionMetadata = {
      adapterName: targetResult.adapterName,
      targetKind: targetResult.targetKind,
      targetDescription: targetResult.targetDescription,
      method
    };

    return {
      ok: true,
      inserted: true,
      adapterName: targetResult.adapterName,
      targetKind: targetResult.targetKind,
      targetDescription: targetResult.targetDescription,
      strategy: targetResult.strategy,
      method
    };
  } catch (error) {
    return {
      ok: false,
      inserted: false,
      adapterName: targetResult.adapterName,
      targetKind: targetResult.targetKind,
      targetDescription: targetResult.targetDescription,
      strategy: targetResult.strategy,
      method: "",
      error: error.message || "Failed to insert masked text."
    };
  }
}

function createInsertionFailure(error) {
  return {
    ok: false,
    inserted: false,
    adapterName: "",
    targetKind: "",
    targetDescription: "",
    strategy: "",
    method: "",
    error
  };
}

function createAdapterOptions(extra = {}) {
  return {
    excludedRootId: ROOT_ID,
    hostname: location.hostname,
    lastFocusedElement: lastFocusedPrompt,
    ...extra
  };
}

function trackPromptFocus() {
  document.addEventListener("focusin", (event) => {
    const result = findPromptTarget(document, createAdapterOptions({
      activeElement: event.target,
      maxCandidates: 5
    }));

    if (result.ok && result.target) {
      lastFocusedPrompt = result.target;
    }
  }, true);
}

function setTextInputValue(element, value) {
  focusElement(element);

  const prototype = element.tagName.toLowerCase() === "textarea"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(createInputEvent());
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return "native-value-setter";
}

function setContentEditableValue(element, value) {
  focusElement(element);
  selectElementContents(element);

  let method = "execCommand.insertText";
  const inserted = document.execCommand?.("insertText", false, value);
  if (!inserted || element.textContent !== value) {
    element.replaceChildren(document.createTextNode(value));
    method = inserted ? "textContent-fallback-after-execCommand" : "textContent";
  }

  element.dispatchEvent(createInputEvent());
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return method;
}

function getTargetEditorSnapshot(element, targetKind) {
  if (targetKind === "textarea" || targetKind === "input") {
    return element.value;
  }

  return element.textContent || "";
}

function focusElement(element) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function selectElementContents(element) {
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Some editor wrappers reject range selection. In that case insertion will
    // fall back to textContent replacement below.
  }
}

function createInputEvent() {
  try {
    return new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText"
    });
  } catch {
    return new Event("input", { bubbles: true, cancelable: true });
  }
}
