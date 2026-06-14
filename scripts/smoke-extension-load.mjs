import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const candidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

const browser = candidates.find((candidate) => existsSync(candidate));
if (!browser) {
  console.error("No Chrome/Chromium browser found for extension smoke test.");
  process.exit(1);
}

const extensionRoot = resolve(".");
const profile = mkdtempSync(join(tmpdir(), "local-masker-smoke-"));

try {
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-default-apps",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    "--dump-dom",
    "about:blank"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolveExit) => {
    child.on("exit", resolveExit);
  });

  const failed = /Failed to load extension|Manifest file is missing or unreadable|Error loading extension/i.test(stderr);
  if (exitCode !== 0 || failed) {
    console.error(stderr || `Browser exited with code ${exitCode}`);
    process.exit(1);
  }

  console.log("extension smoke load passed");
} finally {
  rmSync(profile, { recursive: true, force: true });
}
