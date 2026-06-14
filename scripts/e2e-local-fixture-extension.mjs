import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const projectRoot = resolve(".");
const fixtureUrl = "http://127.0.0.1:8787/dev/prompt-fixture.html";
const artifactPath = join(projectRoot, "artifacts", "local-fixture-extension-e2e.png");
const report = {
  chromeFound: false,
  extensionLaunch: false,
  extensionTargetFound: false,
  fixturePageOpened: false,
  contentScriptRootFound: false,
  localMaskerButtonFound: false,
  composerIframeOpened: false,
  screenshotPath: "artifacts/local-fixture-extension-e2e.png",
  extensionTargets: []
};
const likelyCauses = [
  "Extension was not loaded from the project root.",
  "npm run build was not run before loading unpacked.",
  "Content script match patterns do not include 127.0.0.1.",
  "Manifest file paths are wrong.",
  "Chrome blocked extension load due to a manifest or CSP error.",
  "The fixture page was opened before the extension loaded and needs a reload."
];

let server = null;
let chrome = null;
let profile = null;
let ws = null;
let browserWs = null;

try {
  await runCommand(process.execPath, ["scripts/build-offscreen.mjs"]);
  await ensureFixtureServer();

  const chromePath = findChrome();
  report.chromeFound = Boolean(chromePath);
  if (!chromePath) {
    printReport("No Chrome/Chromium browser found for E2E diagnostic.");
    process.exit(1);
  }

  if (typeof WebSocket === "undefined") {
    printReport("Node WebSocket support is unavailable; manual browser testing is required.");
    process.exit(1);
  }

  profile = mkdtempSync(join(tmpdir(), "local-masker-e2e-"));
  const debuggingPort = await findOpenPort();
  chrome = spawn(chromePath, createChromeArgs(debuggingPort, profile), {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const version = await waitForCdp(debuggingPort);
  browserWs = version.webSocketDebuggerUrl ? await connectCdp(version.webSocketDebuggerUrl) : null;
  if (browserWs) {
    report.extensionTargets = await waitForExtensionTargets(browserWs);
    report.extensionTargetFound = report.extensionTargets.some(isLocalMaskerTarget);
  }
  await delay(1000);

  const target = await createFixtureTarget(debuggingPort);
  report.extensionLaunch = true;

  ws = await connectCdp(target.webSocketDebuggerUrl);
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable").catch(() => undefined);
  await cdp("Accessibility.enable").catch(() => undefined);
  await cdp("Page.reload", { ignoreCache: true }).catch(() => undefined);
  report.fixturePageOpened = await waitForPageReady();

  await cdp("Runtime.evaluate", {
    expression: "document.querySelector('#fixture-textarea')?.focus(); undefined",
    awaitPromise: true
  });

  const rootPresent = await waitForContentScriptRoot();
  report.contentScriptRootFound = rootPresent;
  report.extensionTargetFound = report.extensionTargetFound || rootPresent;
  const axButtonFound = await findLocalMaskerInAccessibilityTree();
  if (rootPresent) {
    await clickBottomRightButton();
  }

  report.composerIframeOpened = await waitForComposerFrame();
  report.localMaskerButtonFound = Boolean(axButtonFound || report.composerIframeOpened);

  await saveScreenshot();

  if (!report.localMaskerButtonFound || !report.composerIframeOpened) {
    const pageErrors = summarizePageErrors();
    const extra = hasCommandLineExtensionSwitchBlocked(stderr)
      ? "Chrome reported that command-line extension loading flags are not allowed in this browser environment. Load the extension manually from chrome://extensions, or run this diagnostic with a Chromium/Chrome build that permits --load-extension."
      : pageErrors
      ? `Page/runtime errors: ${pageErrors}`
      : stderr && /Failed to load extension|Error loading extension|Manifest|extension/i.test(stderr)
      ? `Chrome reported an extension-related error: ${stderr.slice(0, 800)}`
      : report.extensionTargetFound
        ? "The extension target was visible to Chrome, but content-script injection was not confirmed."
        : "Chrome launched, but no extension target was visible. The unpacked extension likely did not load.";
    printReport(extra);
    process.exit(1);
  }

  printReport("Fixture extension injection confirmed.");
} catch (error) {
  printReport(error.message || "E2E fixture diagnostic failed.");
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
    browserWs?.close();
  } catch {}

  if (chrome && !chrome.killed) {
    chrome.kill();
    await waitForProcessExit(chrome, 3000);
  }

  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  if (profile) {
    await removeProfile(profile);
  }
}

function createChromeArgs(debuggingPort, userDataDir) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--enable-extensions",
    "--enable-logging=stderr",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--window-size=1280,900",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${projectRoot}`,
    `--load-extension=${projectRoot}`,
    "about:blank"
  ];

  if (process.env.LM_E2E_HEADLESS === "0") {
    return args.filter((arg) => arg !== "--headless=new");
  }

  return args;
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
    server.listen(8787, "127.0.0.1", resolveListen);
  });
}

async function createFixtureTarget(debuggingPort) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(fixtureUrl)}`, {
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
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Keep waiting until Chrome exposes the debugging endpoint.
    }

    await delay(250);
  }

  throw new Error("Chrome DevTools Protocol did not become available.");
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
  socket.events = [];
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
    } else if (message.method) {
      socket.events.push(message);
    }
  });

  return socket;
}

function cdp(method, params = {}) {
  return sendCdp(ws, method, params);
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

async function waitForExtensionTargets(socket) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const targets = socket === browserWs
        ? await browserCdp("Target.getTargets")
        : await sendCdp(socket, "Target.getTargets");
      const extensionTargets = (targets.targetInfos ?? [])
        .filter((target) => typeof target.url === "string" && target.url.startsWith("chrome-extension://"))
        .map((target) => ({
          type: target.type || "unknown",
          title: sanitizeTargetTitle(target.title),
          url: redactExtensionUrl(target.url),
          path: getExtensionUrlPath(target.url)
        }));
      if (extensionTargets.length > 0) {
        return extensionTargets;
      }
    } catch {
      return [];
    }

    await delay(300);
  }

  return [];
}

function redactExtensionUrl(url) {
  return String(url).replace(/chrome-extension:\/\/[^/]+/g, "chrome-extension://<id>");
}

function sanitizeTargetTitle(title) {
  return String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function getExtensionUrlPath(url) {
  const match = String(url).match(/^chrome-extension:\/\/[^/]+(\/.*)$/);
  return match ? match[1] : "";
}

function isLocalMaskerTarget(target) {
  return /local masker/i.test(target.title || "") ||
    ["/src/background.js", "/src/offscreen/offscreen.html", "/src/composer/composer.html"].some((path) => target.path === path);
}

async function waitForPageReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await evaluate("({ readyState: document.readyState, href: location.href })");
    if (result?.href === fixtureUrl && result.readyState === "complete") {
      return true;
    }

    await delay(250);
  }

  return false;
}

async function waitForContentScriptRoot() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await evaluate("Boolean(document.getElementById('local-masker-extension-root'))");
    if (result === true) {
      return true;
    }

    await delay(300);
  }

  return false;
}

async function findLocalMaskerInAccessibilityTree() {
  try {
    const tree = await cdp("Accessibility.getFullAXTree");
    return (tree.nodes ?? []).some((node) => node?.name?.value === "Local Masker" && node.ignored !== true);
  } catch {
    return false;
  }
}

async function clickBottomRightButton() {
  const viewport = await evaluate("({ width: window.innerWidth, height: window.innerHeight })");
  const x = Math.max(20, viewport.width - 90);
  const y = Math.max(20, viewport.height - 38);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function waitForComposerFrame() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const frameTree = await cdp("Page.getFrameTree");
    if (findComposerFrame(frameTree.frameTree) || await findComposerTarget() || await findComposerInAccessibilityTree()) {
      return true;
    }

    await delay(300);
  }

  return false;
}

async function findComposerTarget() {
  if (!browserWs) {
    return false;
  }

  try {
    const targets = await browserCdp("Target.getTargets");
    return (targets.targetInfos ?? []).some((target) => {
      return typeof target.url === "string" && target.url.includes("/src/composer/composer.html");
    });
  } catch {
    return false;
  }
}

async function findComposerInAccessibilityTree() {
  try {
    const tree = await cdp("Accessibility.getFullAXTree");
    return (tree.nodes ?? []).some((node) => {
      const name = String(node?.name?.value ?? "");
      return node.ignored !== true && (name === "Mask & Insert" || name === "Secure composer");
    });
  } catch {
    return false;
  }
}

function findComposerFrame(node) {
  if (!node) {
    return false;
  }

  if (typeof node.frame?.url === "string" && node.frame.url.includes("src/composer/composer.html")) {
    return true;
  }

  return (node.childFrames ?? []).some(findComposerFrame);
}

async function saveScreenshot() {
  mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
  const screenshot = await cdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  writeFileSync(artifactPath, Buffer.from(screenshot.data, "base64"));
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  return result.result?.value;
}

function printReport(message) {
  console.log("Local fixture extension E2E diagnostic");
  console.log(`${report.chromeFound ? "PASS" : "FAIL"} Chrome found`);
  console.log(`${report.extensionLaunch ? "PASS" : "FAIL"} Extension launch`);
  console.log(`${report.extensionTargetFound ? "PASS" : "FAIL"} Local Masker extension observed`);
  if (report.extensionTargets.length > 0) {
    console.log(`INFO Observed extension targets: ${report.extensionTargets.map((target) => `${target.type}:${target.title || "untitled"}:${target.url}`).join(", ")}`);
  }
  console.log(`${report.fixturePageOpened ? "PASS" : "FAIL"} Fixture page opened`);
  console.log(`${report.contentScriptRootFound ? "PASS" : "FAIL"} Content script root found`);
  console.log(`${report.localMaskerButtonFound ? "PASS" : "FAIL"} Local Masker button found`);
  console.log(`${report.composerIframeOpened ? "PASS" : "FAIL"} Composer iframe opened`);
  console.log(`INFO Screenshot path: ${report.screenshotPath}`);
  console.log(`INFO ${message}`);

  if (!report.localMaskerButtonFound || !report.composerIframeOpened) {
    console.log("Likely causes:");
    for (const cause of likelyCauses) {
      console.log(`- ${cause}`);
    }
  }
}

function summarizePageErrors() {
  const events = (ws?.events ?? []).filter((event) => {
    return event.method === "Runtime.exceptionThrown" ||
      event.method === "Log.entryAdded" ||
      event.method === "Runtime.consoleAPICalled";
  });
  const rendered = events.map((event) => {
    if (event.method === "Runtime.exceptionThrown") {
      return event.params?.exceptionDetails?.text ||
        event.params?.exceptionDetails?.exception?.description ||
        "runtime exception";
    }

    if (event.method === "Log.entryAdded") {
      const entry = event.params?.entry ?? {};
      if (String(entry.url || "").endsWith("/favicon.ico")) {
        return "";
      }
      return [entry.text || "log entry", entry.url || ""].filter(Boolean).join(" @ ");
    }

    return event.params?.args?.map((arg) => arg.value || arg.description || "").join(" ") || "console message";
  }).filter(Boolean);

  return rendered.slice(0, 4).join(" | ").slice(0, 1000);
}

function hasCommandLineExtensionSwitchBlocked(stderr) {
  return /disable-extensions-except is not allowed|load-extension is not allowed|load-extension.*ignored|command-line extension/i.test(stderr || "");
}

function findChrome() {
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(profilePath, { recursive: true, force: true });
      return;
    } catch {
      await delay(250);
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
