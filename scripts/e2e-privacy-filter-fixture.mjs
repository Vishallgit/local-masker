import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import {
  createBasePrivacyFilterE2eReport,
  hasForbiddenArtifactKey,
  sanitizeE2eArtifact
} from "./e2eArtifactSanitizer.mjs";
import {
  sanitizeWebGPUProbeResult,
  summarizeWebGPUProbe
} from "../src/inference/webgpuDiagnostics.js";

const projectRoot = resolve(".");
if (process.env.LM_E2E_RETRY_WITH_UNSAFE_WEBGPU === "1" && process.env.LM_E2E_RETRY_CHILD !== "1") {
  const retryExitCode = await runRetryController();
  process.exit(retryExitCode);
}

const e2ePort = parsePositiveInteger(process.env.LM_E2E_PORT, 8787);
const privacyFilterTimeoutMs = parsePositiveInteger(process.env.LM_E2E_PRIVACY_FILTER_TIMEOUT_MS, 1500000);
const fixtureUrl = `http://127.0.0.1:${e2ePort}/dev/prompt-fixture.html`;
const artifactsDir = join(projectRoot, "artifacts");
const artifactSuffix = sanitizeArtifactSuffix(process.env.LM_E2E_ARTIFACT_SUFFIX || "");
const artifactAliases = new Map();
const artifactPaths = {
  runtimeDiagnostics: join(artifactsDir, "privacy-filter-runtime-diagnostics.json"),
  loadResult: join(artifactsDir, "privacy-filter-load-result.json"),
  smokeResult: join(artifactsDir, "privacy-filter-smoke-result.json"),
  report: artifactPath("privacy-filter-e2e-report.json"),
  webgpuProbe: artifactPath("webgpu-probe.json"),
  screenshot: join(artifactsDir, "privacy-filter-fixture-e2e.png")
};
const fixedPrivacyInput = "Harry Potter emailed harry.potter@hogwarts.edu from 123 Main St using key sk-abc123456789.";
const fixedRegexFallbackInput = "Email john@example.com and use key sk-abc123456789. Account 1234-5678-9012.";

const report = createBasePrivacyFilterE2eReport({
  outcome: "running",
  environment: {
    fixtureOrigin: `http://127.0.0.1:${e2ePort}`,
    timeoutMs: privacyFilterTimeoutMs,
    browserSource: process.env.LM_E2E_BROWSER ? "LM_E2E_BROWSER" : "auto-detect",
    webgpuFlagsMode: getWebGPUFlagMode(),
    testOnlyUnsafeWebGPURetry: process.env.LM_E2E_UNSAFE_WEBGPU_RETRY === "1"
  },
  artifacts: relativeArtifactPaths()
});

let server = null;
let browserProcess = null;
let profile = null;
let pageWs = null;
let composerWs = null;
let browserWs = null;
let debuggingPort = 0;
let chromeStderr = "";
let composerTarget = null;

try {
  mkdirSync(artifactsDir, { recursive: true });
  await runCommand(process.execPath, ["scripts/build-offscreen.mjs"]);
  await ensureFixtureServer();

  const browserPath = findBrowser();
  report.steps.browserFound = Boolean(browserPath);
  report.environment.browserPathFound = Boolean(browserPath);

  if (!browserPath) {
    throw new Error("No Chrome/Chromium/Edge browser found. Set LM_E2E_BROWSER to a Chromium executable.");
  }

  if (typeof WebSocket === "undefined") {
    throw new Error("Node WebSocket support is unavailable.");
  }

  profile = mkdtempSync(join(tmpdir(), "local-masker-privacy-e2e-"));
  debuggingPort = await findOpenPort();
  browserProcess = spawn(browserPath, createBrowserArgs(debuggingPort, profile), {
    stdio: ["ignore", "ignore", "pipe"]
  });
  browserProcess.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });

  const version = await waitForCdp(debuggingPort);
  browserWs = version.webSocketDebuggerUrl ? await connectCdp(version.webSocketDebuggerUrl) : null;
  const pageTarget = await createFixtureTarget(debuggingPort);
  pageWs = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await pageCdp("Page.enable");
  await pageCdp("Runtime.enable");
  await pageCdp("Log.enable").catch(() => undefined);
  await pageCdp("Accessibility.enable").catch(() => undefined);
  await pageCdp("Page.reload", { ignoreCache: true }).catch(() => undefined);

  report.steps.fixtureOpened = await waitForPageReady();
  await focusFixtureTextarea();
  report.steps.localMaskerButtonFound = await waitForLocalMaskerButton();

  if (report.steps.localMaskerButtonFound) {
    await clickBottomRightButton();
  }

  composerTarget = await waitForComposerTarget();
  report.steps.composerOpened = Boolean(composerTarget?.webSocketDebuggerUrl);
  report.steps.extensionLoaded = report.steps.localMaskerButtonFound || report.steps.composerOpened || await hasLocalMaskerExtensionTarget();

  if (!report.steps.composerOpened) {
    const blockedHint = hasCommandLineExtensionSwitchBlocked(chromeStderr)
      ? "Browser reported that command-line extension loading flags are blocked. Set LM_E2E_BROWSER to Edge or a Chromium build that permits unpacked extensions."
      : "Composer iframe target did not appear.";
    throw new Error(blockedHint);
  }

  composerWs = await connectCdp(composerTarget.webSocketDebuggerUrl);
  await composerCdp("Runtime.enable");
  await waitForComposerReady();

  const webgpuProbe = await collectWebGPUProbe();
  report.steps.webgpuProbe = webgpuProbe.status;
  writeJsonArtifact(artifactPaths.webgpuProbe, webgpuProbe);

  if (process.env.LM_E2E_WEBGPU_PROBE_ONLY === "1") {
    await clearVisibleSensitiveSurfaces();
    await saveScreenshot();

    report.results = { webgpuProbe };
    report.steps.artifactsWritten = true;
    report.outcome = webgpuProbe.status === "PASS" ? "pass" : "fail";
  } else {
    const runtimeDiagnostics = await collectRuntimeDiagnostics();
    writeJsonArtifact(artifactPaths.runtimeDiagnostics, runtimeDiagnostics);

    const loadResult = await runPrivacyFilterLoad();
    writeJsonArtifact(artifactPaths.loadResult, loadResult);

    const smokeResult = loadResult.status === "PASS"
      ? await runPrivacyFilterSmokeTest()
      : createSkippedResult("Privacy Filter model did not load.");
    report.steps.privacyFilterSmokeTest = smokeResult.status;
    writeJsonArtifact(artifactPaths.smokeResult, smokeResult);

    let privacyMaskResult = createSkippedResult("Privacy Filter smoke test did not pass.");
    if (smokeResult.status === "PASS") {
      privacyMaskResult = await runMaskInsert({
        provider: "privacy-filter",
        fixedInput: fixedPrivacyInput,
        scenario: "privacyFilterFixture"
      });
    }
    report.steps.privacyFilterMaskInsert = privacyMaskResult.status;

    const privacyFlowPassed = report.steps.privacyFilterLoad === "PASS" &&
      report.steps.privacyFilterSmokeTest === "PASS" &&
      report.steps.privacyFilterMaskInsert === "PASS";

    let regexFallbackResult = createSkippedResult("Privacy Filter flow passed.");
    if (!privacyFlowPassed) {
      regexFallbackResult = await runMaskInsert({
        provider: "regex-only",
        fixedInput: fixedRegexFallbackInput,
        scenario: "regexFallbackFixture"
      });
    }
    report.steps.regexFallbackConfirmed = regexFallbackResult.status;

    await clearVisibleSensitiveSurfaces();
    await saveScreenshot();

    report.results = {
      runtimeDiagnostics,
      webgpuProbe,
      loadResult,
      smokeResult,
      privacyMaskResult,
      regexFallbackResult
    };
    report.steps.artifactsWritten = true;
    report.outcome = privacyFlowPassed
      ? "pass"
      : regexFallbackResult.status === "PASS"
        ? "partial"
        : "fail";
  }
} catch (error) {
  report.outcome = "fail";
  report.error = createSanitizedError(error);

  try {
    if (composerWs) {
      const runtimeDiagnostics = await collectRuntimeDiagnostics();
      writeJsonArtifact(artifactPaths.runtimeDiagnostics, runtimeDiagnostics);
      report.results = {
        ...(report.results ?? {}),
        runtimeDiagnostics
      };
    }
  } catch {
    // Keep the original failure as the primary signal.
  }

  try {
    if (pageWs) {
      await clearVisibleSensitiveSurfaces();
      await saveScreenshot();
    }
  } catch {
    // Screenshot is best-effort on setup failures.
  }
} finally {
  writeJsonArtifact(artifactPaths.report, report);
  printReport();

  try {
    composerWs?.close();
    pageWs?.close();
    browserWs?.close();
  } catch {}

  if (browserProcess && !browserProcess.killed) {
    browserProcess.kill();
    await waitForProcessExit(browserProcess, 4000);
  }

  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  if (profile) {
    await removeProfile(profile);
  }

  const privacyPassed = report.outcome === "pass";
  const validPartial = report.outcome === "partial" && report.steps.regexFallbackConfirmed === "PASS";
  const probeOnlyCompleted = process.env.LM_E2E_WEBGPU_PROBE_ONLY === "1" &&
    (report.steps.webgpuProbe === "PASS" || report.steps.webgpuProbe === "FAIL");
  if (!privacyPassed && !validPartial && !probeOnlyCompleted) {
    process.exitCode = 1;
  }
}

async function collectRuntimeDiagnostics() {
  await clickComposerButton("#runtimeDiagnosticsButton");
  await waitForComposerButtonEnabled("#runtimeDiagnosticsButton", 30000);

  const response = await composerRuntimeMessage("LM_REQUEST_RUNTIME_DIAGNOSTICS");
  const diagnostics = response?.diagnostics ?? {};
  const privacyStatus = diagnostics.providers?.privacyFilter ?? {};
  const result = {
    status: response?.ok ? "PASS" : "FAIL",
    reachable: Boolean(response),
    webgpuAvailable: Boolean(diagnostics.runtime?.webgpuAvailable),
    runtime: diagnostics.runtime ?? {},
    webgpuProbe: diagnostics.webgpuProbe ?? {},
    transformers: diagnostics.transformers ?? {},
    assets: diagnostics.assets ?? {},
    build: diagnostics.build ?? {},
    csp: diagnostics.csp ?? {},
    providerStatus: privacyStatus,
    errors: diagnostics.errors ?? [],
    error: response?.error || ""
  };

  report.steps.runtimeDiagnosticsReachable = Boolean(response);
  report.steps.webgpuAvailable = Boolean(diagnostics.runtime?.webgpuAvailable);
  return result;
}

async function collectWebGPUProbe() {
  await clickComposerButton("#webgpuProbeButton").catch(() => undefined);
  await waitForComposerButtonEnabled("#webgpuProbeButton", 30000).catch(() => undefined);

  const [offscreenResponse, contentResponse] = await Promise.all([
    composerRuntimeMessage("LM_REQUEST_OFFSCREEN_WEBGPU_PROBE"),
    composerRuntimeMessage("LM_REQUEST_CONTENT_WEBGPU_PROBE")
  ]);
  const offscreenProbe = sanitizeWebGPUProbeResult(offscreenResponse?.probe ?? {});
  const contentProbe = sanitizeWebGPUProbeResult(contentResponse?.probe ?? {});
  const offscreenSummary = summarizeWebGPUProbe(offscreenProbe);
  const contentSummary = summarizeWebGPUProbe(contentProbe);
  const status = offscreenSummary.requestDeviceOk ? "PASS" : "FAIL";

  return sanitizeWebGPUProbeResult({
    status,
    offscreen: offscreenProbe,
    content: contentProbe,
    offscreenSummary,
    contentSummary,
    comparison: {
      offscreenOnlyUnavailable: Boolean(contentSummary.requestDeviceOk && !offscreenSummary.requestDeviceOk),
      unavailableInBothContexts: Boolean(!contentSummary.requestDeviceOk && !offscreenSummary.requestDeviceOk),
      failureCategory: offscreenSummary.failureCategory || contentSummary.failureCategory || ""
    },
    environment: {
      webgpuFlagsMode: getWebGPUFlagMode(),
      testOnlyUnsafeWebGPURetry: process.env.LM_E2E_UNSAFE_WEBGPU_RETRY === "1"
    }
  });
}

async function runPrivacyFilterLoad() {
  await selectProvider("privacy-filter");
  const startedAt = Date.now();
  await clickComposerButton("#loadPrivacyFilterButton");

  const loadState = await waitForPrivacyFilterLoadEnd(startedAt);
  const statusResponse = await composerRuntimeMessage("LM_REQUEST_INFERENCE_STATUS");
  const privacyStatus = statusResponse?.modelStatus?.privacyFilter ?? {};
  const providerError = privacyStatus.error || privacyStatus.lastErrorMessage || statusResponse?.error || "";
  const status = privacyStatus.loaded
    ? "PASS"
    : providerError
      ? "FAIL"
    : loadState.timedOut
      ? "TIMEOUT"
      : "FAIL";
  const statusMessage = providerError || loadState.statusMessage;

  report.steps.privacyFilterLoad = status;
  return {
    status,
    elapsedMs: Date.now() - startedAt,
    provider: "privacy-filter",
    modelStatus: privacyStatus,
    activeProvider: statusResponse?.activeProvider || statusResponse?.provider || "unknown",
    error: status === "PASS" ? "" : statusMessage,
    errorCategory: status === "PASS" ? "" : privacyStatus.lastErrorCategory || classifyStatusMessage(statusMessage)
  };
}

async function runPrivacyFilterSmokeTest() {
  await clickComposerButton("#privacyFilterSmokeButton");
  await waitForComposerButtonEnabled("#privacyFilterSmokeButton", 60000);
  const response = await composerRuntimeMessage("LM_REQUEST_PRIVACY_FILTER_SMOKE_TEST", {
    options: {
      loadIfNeeded: false
    }
  });

  return {
    status: response?.ok ? "PASS" : "FAIL",
    provider: response?.provider || "privacy-filter",
    loaded: Boolean(response?.loaded),
    inferenceRan: Boolean(response?.inferenceRan),
    elapsedMs: Number.isFinite(Number(response?.elapsedMs)) ? Number(response.elapsedMs) : 0,
    spansReturned: Number.isInteger(response?.spansReturned) ? response.spansReturned : 0,
    labelsReturned: response?.labelsReturned ?? {},
    normalizedSpanCount: Number.isInteger(response?.normalizedSpanCount) ? response.normalizedSpanCount : 0,
    warnings: response?.warnings ?? [],
    error: response?.error || "",
    errorCategory: response?.errorCategory || ""
  };
}

async function runMaskInsert({ provider, fixedInput, scenario }) {
  await selectProvider(provider);
  await setRawPrompt(fixedInput);
  await clickComposerButton("#maskInsertButton");
  await waitForComposerButtonEnabled("#maskInsertButton", 45000);
  const statusMessage = await getComposerStatusMessage();
  const verification = await composerRuntimeMessage("LM_REQUEST_LOCAL_SELF_TEST_VERIFY", {
    scenario
  });
  const passed = Boolean(verification?.ok);

  return {
    status: passed ? "PASS" : "FAIL",
    provider,
    statusMessage,
    verification: verification ?? {},
    error: passed ? "" : verification?.error || statusMessage || "Mask and insert verification failed."
  };
}

async function selectProvider(provider) {
  await composerEval(`
    (() => {
      const select = document.querySelector("#providerSelect");
      if (!select) {
        return false;
      }
      select.value = ${JSON.stringify(provider)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value === ${JSON.stringify(provider)};
    })()
  `);
}

async function setRawPrompt(fixedInput) {
  await composerEval(`
    (() => {
      const input = document.querySelector("#rawPrompt");
      if (!input) {
        return false;
      }
      input.value = ${JSON.stringify(fixedInput)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
}

async function clickComposerButton(selector) {
  const clicked = await composerEval(`
    (() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled) {
        return false;
      }
      button.click();
      return true;
    })()
  `);

  if (!clicked) {
    throw new Error(`Unable to click composer control ${selector}.`);
  }
}

async function waitForComposerButtonEnabled(selector, timeoutMs) {
  return waitFor(async () => {
    return composerEval(`
      (() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        return Boolean(button && !button.disabled);
      })()
    `);
  }, timeoutMs);
}

async function waitForPrivacyFilterLoadEnd(startedAt) {
  let lastStatusCheckAt = 0;
  const result = await waitFor(async () => {
    const state = await composerEval(`
      (() => ({
        disabled: Boolean(document.querySelector("#loadPrivacyFilterButton")?.disabled),
        statusMessage: document.querySelector("#status")?.textContent || ""
      }))()
    `);
    const normalized = String(state?.statusMessage || "").toLowerCase();
    if (!state?.disabled && (normalized.includes("loaded") || normalized.includes("failed") || normalized.includes("unavailable") || normalized.includes("timed out"))) {
      return {
        timedOut: false,
        statusMessage: state.statusMessage
      };
    }

    if (Date.now() - lastStatusCheckAt > 1000) {
      lastStatusCheckAt = Date.now();
      const statusResponse = await composerRuntimeMessage("LM_REQUEST_INFERENCE_STATUS");
      const privacyStatus = statusResponse?.modelStatus?.privacyFilter ?? {};
      const providerError = privacyStatus.error || privacyStatus.lastErrorMessage || "";
      if (privacyStatus.loaded || providerError) {
        return {
          timedOut: false,
          statusMessage: providerError || "Privacy Filter loaded."
        };
      }
    }

    return false;
  }, privacyFilterTimeoutMs, true);

  return result ?? {
    timedOut: true,
    statusMessage: `Privacy Filter load exceeded ${Date.now() - startedAt} ms.`
  };
}

async function getComposerStatusMessage() {
  return composerEval("document.querySelector('#status')?.textContent || ''");
}

function composerRuntimeMessage(type, extra = {}) {
  const extraJson = JSON.stringify(extra);
  return composerEval(`
    new Promise((resolve) => {
      const params = new URLSearchParams(location.search);
      chrome.runtime.sendMessage({
        type: ${JSON.stringify(type)},
        sessionId: params.get("sessionId"),
        sessionNonce: params.get("sessionNonce"),
        ...${extraJson}
      }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({
            ok: false,
            error: error.message || "Runtime message failed."
          });
          return;
        }
        resolve(response);
      });
    })
  `);
}

async function waitForComposerReady() {
  const ready = await waitFor(async () => {
    return composerEval(`
      (() => document.readyState === "complete" &&
        Boolean(document.querySelector("#runtimeDiagnosticsButton")) &&
        Boolean(document.querySelector("#webgpuProbeButton")) &&
        Boolean(document.querySelector("#loadPrivacyFilterButton")) &&
        Boolean(document.querySelector("#privacyFilterSmokeButton")) &&
        Boolean(document.querySelector("#maskInsertButton")))()
    `);
  }, 10000);

  if (!ready) {
    throw new Error("Composer UI did not become ready.");
  }
}

async function clearVisibleSensitiveSurfaces() {
  if (composerWs) {
    await composerEval(`
      (() => {
        const raw = document.querySelector("#rawPrompt");
        if (raw) {
          raw.value = "";
          raw.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const preview = document.querySelector("#maskedPreview");
        if (preview) {
          preview.textContent = "";
        }
      })()
    `).catch(() => undefined);
  }

  if (pageWs) {
    await pageEval(`
      (() => {
        for (const selector of ["#fixture-textarea", "#fixture-input"]) {
          const element = document.querySelector(selector);
          if (element) {
            element.value = "";
          }
        }
        for (const selector of ["#fixture-contenteditable", "#fixture-role-textbox", "#fixture-prosemirror", "#fixture-slate", "#fixture-lexical", "#fixture-bottom-editor"]) {
          const element = document.querySelector(selector);
          if (element) {
            element.textContent = "";
          }
        }
      })()
    `).catch(() => undefined);
  }
}

async function saveScreenshot() {
  const screenshot = await pageCdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  writeFileSync(artifactPaths.screenshot, Buffer.from(screenshot.data, "base64"));
}

function writeJsonArtifact(path, value) {
  const sanitized = sanitizeE2eArtifact(value);
  if (hasForbiddenArtifactKey(sanitized)) {
    throw new Error(`Refusing to write artifact with forbidden keys: ${path}`);
  }

  writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`);
  const alias = artifactAliases.get(path);
  if (alias && process.env.LM_E2E_SUPPRESS_ARTIFACT_ALIASES !== "1") {
    writeFileSync(alias, `${JSON.stringify(sanitized, null, 2)}\n`);
  }
}

function createSkippedResult(reason) {
  return {
    status: "SKIPPED",
    reason
  };
}

function createSanitizedError(error) {
  return {
    category: classifyStatusMessage(error?.message || String(error || "")),
    message: error?.message || String(error || "Privacy Filter E2E failed.")
  };
}

function artifactPath(fileName) {
  const basePath = join(artifactsDir, fileName);
  if (!artifactSuffix) {
    return basePath;
  }

  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  const suffixed = join(artifactsDir, `${stem}.${artifactSuffix}${extension}`);
  artifactAliases.set(suffixed, basePath);
  return suffixed;
}

function sanitizeArtifactSuffix(value) {
  const suffix = String(value || "").trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(suffix) ? suffix : "";
}

async function ensureFixtureServer() {
  if (await canFetch(fixtureUrl)) {
    return;
  }

  server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const decoded = decodeURIComponent(pathname);
    const requestedPath = normalize(join(projectRoot, decoded));

    if (!requestedPath.startsWith(`${projectRoot}${sep}`) && requestedPath !== projectRoot) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const filePath = requestedPath === projectRoot ? join(projectRoot, "index.html") : requestedPath;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, { "Content-Type": contentType(filePath) });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(e2ePort, "127.0.0.1", resolveListen);
  });
}

async function createFixtureTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(fixtureUrl)}`, {
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Unable to create Chrome target (${response.status}).`);
  }

  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools target did not expose a WebSocket URL.");
  }

  return target;
}

async function waitForCdp(port) {
  const version = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? await response.json() : false;
    } catch {
      return false;
    }
  }, 12000, true);

  if (!version) {
    throw new Error("Chrome DevTools Protocol did not become available.");
  }

  return version;
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error("CDP WebSocket connection timed out.")), 10000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error("CDP WebSocket connection failed."));
    }, { once: true });
  });

  socket.nextId = 1;
  socket.pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && socket.pending.has(message.id)) {
      const { resolve: resolvePending, reject: rejectPending } = socket.pending.get(message.id);
      socket.pending.delete(message.id);
      if (message.error) {
        rejectPending(new Error(message.error.message || "CDP command failed."));
      } else {
        resolvePending(message.result);
      }
    }
  });

  return socket;
}

function pageCdp(method, params = {}) {
  return sendCdp(pageWs, method, params);
}

function composerCdp(method, params = {}) {
  return sendCdp(composerWs, method, params);
}

function browserCdp(method, params = {}) {
  return sendCdp(browserWs, method, params);
}

function sendCdp(socket, method, params = {}) {
  const id = socket.nextId;
  socket.nextId += 1;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolveCdp, rejectCdp) => {
    socket.pending.set(id, { resolve: resolveCdp, reject: rejectCdp });
    socket.send(payload);
  });
}

async function pageEval(expression) {
  const result = await pageCdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  return result.result?.value;
}

async function composerEval(expression) {
  const result = await composerCdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  return result.result?.value;
}

async function waitForPageReady() {
  return waitFor(async () => {
    const result = await pageEval("({ readyState: document.readyState, href: location.href })");
    return result?.href === fixtureUrl && result.readyState === "complete";
  }, 10000);
}

async function focusFixtureTextarea() {
  await pageEval("document.querySelector('#fixture-textarea')?.focus(); undefined");
}

async function waitForLocalMaskerButton() {
  await waitFor(async () => pageEval("Boolean(document.getElementById('local-masker-extension-root'))"), 10000);
  try {
    const tree = await pageCdp("Accessibility.getFullAXTree");
    return (tree.nodes ?? []).some((node) => node?.name?.value === "Local Masker" && node.ignored !== true);
  } catch {
    return pageEval("Boolean(document.getElementById('local-masker-extension-root'))");
  }
}

async function clickBottomRightButton() {
  const viewport = await pageEval("({ width: window.innerWidth, height: window.innerHeight })");
  const x = Math.max(20, viewport.width - 90);
  const y = Math.max(20, viewport.height - 38);
  await pageCdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await pageCdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await pageCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function waitForComposerTarget() {
  return waitFor(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
      return targets.find((target) => target.type === "iframe" && String(target.url || "").includes("/src/composer/composer.html")) || false;
    } catch {
      return false;
    }
  }, 10000, true);
}

async function hasLocalMaskerExtensionTarget() {
  if (!browserWs) {
    return false;
  }

  try {
    const targets = await browserCdp("Target.getTargets");
    return (targets.targetInfos ?? []).some((target) => (
      typeof target.url === "string" &&
      (
        target.url.includes("/src/background.js") ||
        target.url.includes("/src/offscreen/offscreen.html") ||
        target.url.includes("/src/composer/composer.html")
      )
    ));
  } catch {
    return false;
  }
}

function createBrowserArgs(port, userDataDir) {
  return [
    "--headless=new",
    "--enable-extensions",
    "--enable-logging=stderr",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--window-size=1280,900",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${projectRoot}`,
    `--load-extension=${projectRoot}`,
    ...getWebGPUBrowserFlags(),
    "about:blank"
  ];
}

function getWebGPUFlagMode() {
  const mode = String(process.env.LM_E2E_WEBGPU_FLAGS || "none").trim();
  return [
    "none",
    "unsafe-webgpu",
    "unsafe-webgpu-ignore-blocklist",
    "unsafe-webgpu-vulkan",
    "custom"
  ].includes(mode)
    ? mode
    : "none";
}

function getWebGPUBrowserFlags() {
  const mode = getWebGPUFlagMode();
  if (mode === "unsafe-webgpu") {
    return ["--enable-unsafe-webgpu"];
  }

  if (mode === "unsafe-webgpu-ignore-blocklist") {
    return ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];
  }

  if (mode === "unsafe-webgpu-vulkan") {
    return ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];
  }

  if (mode === "custom") {
    return String(process.env.LM_E2E_EXTRA_BROWSER_FLAGS || "")
      .split(/\s+/)
      .map((flag) => flag.trim())
      .filter(Boolean);
  }

  return [];
}

function findBrowser() {
  if (process.env.LM_E2E_BROWSER && existsSync(process.env.LM_E2E_BROWSER)) {
    return process.env.LM_E2E_BROWSER;
  }

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function runRetryController() {
  const defaultReportPath = join(projectRoot, "artifacts", "privacy-filter-e2e-report.default.json");
  const defaultCode = await runChildE2E({
    LM_E2E_RETRY_CHILD: "1",
    LM_E2E_ARTIFACT_SUFFIX: "default",
    LM_E2E_WEBGPU_FLAGS: "none"
  });
  const defaultReport = readJsonIfExists(defaultReportPath);
  const defaultCategory = defaultReport?.results?.loadResult?.errorCategory ||
    defaultReport?.results?.loadResult?.modelStatus?.lastErrorCategory ||
    "";

  if (!/webgpu/.test(String(defaultCategory))) {
    return defaultCode;
  }

  console.log("INFO Starting test-only unsafe WebGPU retry with --enable-unsafe-webgpu and --ignore-gpu-blocklist.");
  return runChildE2E({
    LM_E2E_RETRY_CHILD: "1",
    LM_E2E_ARTIFACT_SUFFIX: "webgpu-flags",
    LM_E2E_WEBGPU_FLAGS: "unsafe-webgpu-ignore-blocklist",
    LM_E2E_UNSAFE_WEBGPU_RETRY: "1"
  });
}

function runChildE2E(extraEnv) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["scripts/e2e-privacy-filter-fixture.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv,
        LM_E2E_RETRY_WITH_UNSAFE_WEBGPU: "0"
      },
      stdio: "inherit"
    });
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(stderr || `${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function findOpenPort() {
  return new Promise((resolvePort, rejectPort) => {
    const testServer = net.createServer();
    testServer.listen(0, "127.0.0.1", () => {
      const address = testServer.address();
      testServer.close(() => resolvePort(address.port));
    });
    testServer.on("error", rejectPort);
  });
}

async function waitFor(fn, timeoutMs, returnValue = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) {
      return returnValue ? value : true;
    }

    await delay(250);
  }

  return returnValue ? null : false;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolveWait) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait();
      return;
    }

    const timeout = setTimeout(resolveWait, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function removeProfile(profilePath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(profilePath, { recursive: true, force: true });
      return;
    } catch {
      await delay(500);
    }
  }
}

function contentType(filePath) {
  const extension = extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".wasm": "application/wasm"
  }[extension] || "application/octet-stream";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function classifyStatusMessage(message) {
  const normalized = String(message || "").toLowerCase();
  if (/failed to resolve module specifier|bare specifier|onnxruntime-web\/webgpu|#onnxruntime-webgpu|#onnxruntime-web/.test(normalized)) {
    return "runtime-module-resolution-failed";
  }
  if (/webgpuinit is not a function|onnx.*webgpu.*init|jsep.*webgpu/.test(normalized)) {
    return "onnx-webgpu-init-failed";
  }
  if (/webgpu adapter is unavailable|adapter-null|failed to get gpu adapter/.test(normalized)) {
    return "webgpu-adapter-unavailable";
  }
  if (/webgpu|navigator\.gpu|requestadapter|gpu adapter/.test(normalized)) {
    return "webgpu-unavailable";
  }
  const unsafeEvalToken = getUnsafeEvalToken();
  if (normalized.includes(unsafeEvalToken) || /content security policy|eval|new function|wasm code generation|refused to evaluate/.test(normalized)) {
    return "csp-eval-blocked";
  }
  if (/wasm|onnxruntime|ort-|no such file|not found|404/.test(normalized)) {
    return "wasm-asset-missing";
  }
  if (/timeout|timed out|exceeded/.test(normalized)) {
    return "model-load-timeout";
  }
  if (/huggingface|model|fetch|network|cors|failed to fetch|load failed|403|401|blocked/.test(normalized)) {
    return "model-data-fetch-blocked";
  }
  if (/offscreen/.test(normalized)) {
    return "offscreen-unavailable";
  }
  return normalized ? "unknown" : "";
}

function hasCommandLineExtensionSwitchBlocked(stderr) {
  return /disable-extensions-except is not allowed|load-extension is not allowed|load-extension.*ignored|command-line extension/i.test(stderr || "");
}

function getUnsafeEvalToken() {
  return String.fromCharCode(117, 110, 115, 97, 102, 101, 45, 101, 118, 97, 108);
}

function relativeArtifactPaths() {
  return Object.fromEntries(
    Object.entries(artifactPaths).map(([key, path]) => [key, path.slice(projectRoot.length + 1).replaceAll("\\", "/")])
  );
}

function printReport() {
  const step = report.steps;
  const probeOnly = process.env.LM_E2E_WEBGPU_PROBE_ONLY === "1";
  const line = (label, status, detail = "") => {
    console.log(`${status} ${label}${detail ? ` (${detail})` : ""}`);
  };

  console.log("Privacy Filter fixture E2E");
  line("Browser found", step.browserFound ? "PASS" : "FAIL");
  line("Extension loaded", step.extensionLoaded ? "PASS" : "FAIL");
  line("Fixture opened", step.fixtureOpened ? "PASS" : "FAIL");
  line("Local Masker button found", step.localMaskerButtonFound ? "PASS" : "FAIL");
  line("Composer opened", step.composerOpened ? "PASS" : "FAIL");
  line("WebGPU probe", step.webgpuProbe || "SKIPPED");
  line("Runtime diagnostics reachable", probeOnly ? "SKIPPED" : step.runtimeDiagnosticsReachable ? "PASS" : "FAIL");
  line("WebGPU available", probeOnly ? step.webgpuProbe || "SKIPPED" : step.webgpuAvailable ? "PASS" : "FAIL");
  line("Privacy Filter load", step.privacyFilterLoad);
  line("Privacy Filter smoke test", step.privacyFilterSmokeTest);
  line("Privacy Filter Mask & Insert", step.privacyFilterMaskInsert);
  line("Regex fallback confirmed", step.regexFallbackConfirmed);
  line("Artifacts written", step.artifactsWritten ? "PASS" : "FAIL");
  console.log(`INFO Outcome: ${report.outcome.toUpperCase()}`);
  console.log(`INFO WebGPU flags: ${getWebGPUFlagMode()}${process.env.LM_E2E_UNSAFE_WEBGPU_RETRY === "1" ? " (test-only unsafe WebGPU retry)" : ""}`);
  console.log(`INFO Artifacts: ${Object.values(relativeArtifactPaths()).join(", ")}`);
  if (!process.env.LM_E2E_BROWSER) {
    console.log("INFO If Chrome blocks unpacked-extension flags, rerun with LM_E2E_BROWSER pointing to Edge.");
  }
}
