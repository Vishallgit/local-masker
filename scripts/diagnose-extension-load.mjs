import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(".");
const manifestPath = join(projectRoot, "manifest.json");
const requiredLocalMatches = ["http://localhost/*", "http://127.0.0.1/*"];
const requiredComposerResources = [
  "src/composer/composer.html",
  "src/composer/composer.js",
  "src/composer/composer.css"
];
const requiredFiles = [
  "manifest.json",
  "package.json",
  "src",
  "dist",
  "dist/offscreen/offscreen.bundle.js",
  "dist/build-manifest.json"
];

const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed: Boolean(passed), detail });
}

function existsRelative(path) {
  return existsSync(join(projectRoot, path));
}

for (const file of requiredFiles) {
  check(`${file} exists`, existsRelative(file));
}

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  check("manifest.json parses", true);
} catch (error) {
  check("manifest.json parses", false, error.message);
}

if (manifest) {
  check("Manifest V3", manifest.manifest_version === 3);

  const backgroundPath = manifest.background?.service_worker;
  check("background service worker exists", typeof backgroundPath === "string" && existsRelative(backgroundPath), backgroundPath || "missing");

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  check("content_scripts configured", contentScripts.length > 0);

  const allMatches = contentScripts.flatMap((entry) => entry.matches ?? []);
  for (const pattern of requiredLocalMatches) {
    check(`content script match includes ${pattern}`, allMatches.includes(pattern));
  }

  const allContentScriptFiles = contentScripts.flatMap((entry) => entry.js ?? []);
  for (const scriptPath of allContentScriptFiles) {
    check(`content script exists: ${scriptPath}`, existsRelative(scriptPath));
  }

  const resources = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  for (const resource of requiredComposerResources) {
    check(`web accessible composer resource: ${resource}`, resources.includes(resource) && existsRelative(resource));
  }

  check("site adapter module web accessible", resources.includes("src/siteAdapters.js") && existsRelative("src/siteAdapters.js"));
  check("self-test constants web accessible", resources.includes("src/dev/selfTestConstants.js") && existsRelative("src/dev/selfTestConstants.js"));

  const offscreenHtml = "src/offscreen/offscreen.html";
  if (existsRelative(offscreenHtml)) {
    const html = readFileSync(join(projectRoot, offscreenHtml), "utf8");
    check("offscreen HTML exists", true);
    check("offscreen HTML references dist bundle", html.includes("../../dist/offscreen/offscreen.bundle.js"));
    check("referenced offscreen dist bundle exists", existsRelative("dist/offscreen/offscreen.bundle.js"));
  } else {
    check("offscreen HTML exists", false);
  }
}

const failed = checks.filter((item) => !item.passed);

console.log("Local Masker extension load diagnostics");
for (const item of checks) {
  console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
}

if (failed.length > 0) {
  console.log("");
  console.log("Likely fixes:");
  console.log("- Run npm run build from the project root.");
  console.log("- Load the unpacked extension from the project root, not dist.");
  console.log("- Check chrome://extensions for manifest or CSP errors.");
  process.exit(1);
}

console.log("");
console.log("PASS extension files and local fixture matches look loadable.");
