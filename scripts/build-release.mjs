import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProject } from "./audit-no-remote-code.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const releaseRoot = resolve(projectRoot, "release");
const releaseDir = join(releaseRoot, "local-masker");
const releaseZip = join(releaseRoot, "local-masker.zip");
const sourceManifestPath = join(projectRoot, "manifest.json");
const releaseManifestPath = join(releaseDir, "manifest.json");
const UNSAFE_EVAL_TOKEN = "unsafe" + "-eval";
const WASM_EVAL_TOKEN = "wasm-" + UNSAFE_EVAL_TOKEN;

export const PRODUCTION_MATCHES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*"
];

const REQUIRED_RELEASE_FILES = [
  "manifest.json",
  "src/background.js",
  "src/contentScript.js",
  "src/siteAdapters.js",
  "src/composer/composer.html",
  "src/composer/composer.js",
  "src/composer/composer.css",
  "src/offscreen/offscreen.html",
  "dist/offscreen/offscreen.bundle.js",
  "dist/vendor/transformers/transformers.web.js",
  "dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
  "dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"
];

export function createProductionManifest(sourceManifest) {
  const manifest = structuredClone(sourceManifest);

  manifest.description = "Mask sensitive prompt content locally before inserting into supported AI websites.";
  manifest.content_scripts = (manifest.content_scripts ?? [])
    .map((entry) => ({
      ...entry,
      matches: (entry.matches ?? []).filter(isProductionMatch)
    }))
    .filter((entry) => entry.matches.length > 0);

  manifest.web_accessible_resources = (manifest.web_accessible_resources ?? [])
    .map((entry) => ({
      ...entry,
      resources: (entry.resources ?? []).filter((resource) => !isDevOnlyResource(resource)),
      matches: (entry.matches ?? []).filter(isProductionMatch)
    }))
    .filter((entry) => entry.resources.length > 0 && entry.matches.length > 0);

  return manifest;
}

export function validateProductionManifest(manifest) {
  const errors = [];
  const serialized = JSON.stringify(manifest);
  const contentMatches = (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []);
  const webAccessibleMatches = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.matches ?? []);
  const webAccessibleResources = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  const csp = manifest.content_security_policy?.extension_pages || "";

  if (manifest.manifest_version !== 3) {
    errors.push("Manifest must use Manifest V3.");
  }

  if (/(?:localhost|127\.0\.0\.1)/i.test(serialized)) {
    errors.push("Production manifest must not include localhost or 127.0.0.1 fixture access.");
  }

  if (contentMatches.some((match) => !isProductionMatch(match))) {
    errors.push("Production content script matches must be limited to supported real AI sites.");
  }

  if (webAccessibleMatches.some((match) => !isProductionMatch(match))) {
    errors.push("Production web-accessible resource matches must be limited to supported real AI sites.");
  }

  if (webAccessibleResources.some(isDevOnlyResource)) {
    errors.push("Dev-only self-test resources must not be web-accessible in production.");
  }

  if (contentMatches.length === 0) {
    errors.push("Production manifest must expose at least one content-script match.");
  }

  if (/\ball_urls\b|<all_urls>/i.test(serialized)) {
    errors.push("Production manifest must not request all_urls.");
  }

  if (new RegExp(`(^|[^-])${escapeRegExp(UNSAFE_EVAL_TOKEN)}`, "i").test(csp)) {
    errors.push(`Production CSP must not allow ${UNSAFE_EVAL_TOKEN}.`);
  }

  if (!new RegExp(`\\b${escapeRegExp(WASM_EVAL_TOKEN)}\\b`).test(csp)) {
    errors.push(`Production CSP must keep ${WASM_EVAL_TOKEN} for local WASM runtime support.`);
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease();
}

function buildRelease() {
  ensureInsideProject(releaseDir);
  ensureInsideProject(releaseZip);

  runNodeScript("scripts/build-offscreen.mjs");

  rmSync(releaseDir, { recursive: true, force: true });
  rmSync(releaseZip, { force: true });
  mkdirSync(releaseDir, { recursive: true });

  copyReleaseInputs();
  writeProductionManifest();
  assertRequiredReleaseFiles();
  assertNoDevDirectory();
  runReleaseAudit();
  zipReleaseDirectory();

  console.log(`release package ready: ${relative(releaseZip)}`);
}

function copyReleaseInputs() {
  copyFile("src/background.js");
  copyFile("src/contentScript.js");
  copyFile("src/siteAdapters.js");
  copyDirectory("src/composer");
  copyDirectory("src/offscreen");
  copyDirectory("src/shared");
  copyDirectory("src/inference");
  copyDirectory("dist");
}

function writeProductionManifest() {
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  const manifest = createProductionManifest(sourceManifest);
  const errors = validateProductionManifest(manifest);

  if (errors.length > 0) {
    throw new Error(`Production manifest validation failed:\n- ${errors.join("\n- ")}`);
  }

  writeFileSync(releaseManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertRequiredReleaseFiles() {
  const missing = REQUIRED_RELEASE_FILES.filter((file) => !existsSync(join(releaseDir, file)));

  if (missing.length > 0) {
    throw new Error(`Release package is missing required files:\n- ${missing.join("\n- ")}`);
  }
}

function assertNoDevDirectory() {
  if (existsSync(join(releaseDir, "src", "dev"))) {
    throw new Error("Release package must not include src/dev.");
  }
}

function runReleaseAudit() {
  const { findings, warnings } = auditProject(releaseDir);

  if (findings.length > 0) {
    throw new Error(`Release remote-code audit failed:\n- ${findings.join("\n- ")}`);
  }

  if (warnings.length > 0) {
    console.warn("release remote-code audit warnings");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }
}

function zipReleaseDirectory() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `if (Test-Path -LiteralPath ${quotePowerShell(releaseZip)}) { Remove-Item -LiteralPath ${quotePowerShell(releaseZip)} -Force }`,
    `Compress-Archive -Path ${quotePowerShell(join(releaseDir, "*"))} -DestinationPath ${quotePowerShell(releaseZip)} -Force`
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error("Failed to create release zip with Compress-Archive.");
  }
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed.`);
  }
}

function copyFile(relativePath) {
  const source = join(projectRoot, relativePath);
  const target = join(releaseDir, relativePath);

  if (!existsSync(source)) {
    throw new Error(`Missing release source file: ${relativePath}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyDirectory(relativePath) {
  const source = join(projectRoot, relativePath);
  const target = join(releaseDir, relativePath);

  if (!existsSync(source)) {
    throw new Error(`Missing release source directory: ${relativePath}`);
  }

  mkdirSync(target, { recursive: true });

  for (const entry of readdirSync(source)) {
    const sourceEntry = join(source, entry);
    const relativeEntry = join(relativePath, entry);

    if (statSync(sourceEntry).isDirectory()) {
      copyDirectory(relativeEntry);
    } else {
      copyFile(relativeEntry);
    }
  }
}

function isProductionMatch(match) {
  return PRODUCTION_MATCHES.includes(match);
}

function isDevOnlyResource(resource) {
  return resource === "src/dev/selfTestConstants.js" || resource.startsWith("src/dev/");
}

function ensureInsideProject(path) {
  const resolved = resolve(path);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${sep}`)) {
    throw new Error(`Refusing to write outside the project: ${path}`);
  }
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relative(path) {
  return path.slice(projectRoot.length + 1).replaceAll("\\", "/");
}
