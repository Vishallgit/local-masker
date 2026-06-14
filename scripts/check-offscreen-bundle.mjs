import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnresolvedRuntimeSpecifiers } from "../src/inference/runtimeSpecifierChecks.js";

const projectRoot = resolve(".");

export { findUnresolvedRuntimeSpecifiers };

export function checkOffscreenBundles(root = projectRoot) {
  const bundleFiles = listRuntimeBundleFiles(root);
  const findings = [];

  for (const file of bundleFiles) {
    const normalizedPath = relative(root, file).replaceAll("\\", "/");
    const content = readFileSync(file, "utf8");
    for (const finding of findUnresolvedRuntimeSpecifiers(content)) {
      findings.push({
        path: normalizedPath,
        specifier: finding.specifier,
        kind: finding.kind
      });
    }
  }

  return {
    ok: findings.length === 0,
    scanned: bundleFiles.map((file) => relative(root, file).replaceAll("\\", "/")),
    findings
  };
}

export function listRuntimeBundleFiles(root = projectRoot) {
  const files = [];
  const offscreenDir = resolve(root, "dist", "offscreen");
  const transformersRuntime = resolve(root, "dist", "vendor", "transformers", "transformers.web.js");

  if (existsSync(offscreenDir)) {
    files.push(...listJavaScriptFiles(offscreenDir));
  }

  if (existsSync(transformersRuntime)) {
    files.push(transformersRuntime);
  }

  return files;
}

export function isSafeManifestAssetPath(path) {
  return typeof path === "string" &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkOffscreenBundles(projectRoot);

  if (!result.scanned.length) {
    console.error("offscreen bundle check failed");
    console.error("- no built offscreen/runtime JavaScript files were found; run npm run build first");
    process.exit(1);
  }

  if (!result.ok) {
    console.error("offscreen bundle check failed");
    for (const finding of result.findings) {
      console.error(`- ${finding.path}: unresolved ${finding.kind} ${finding.specifier}`);
    }
    process.exit(1);
  }

  console.log(`offscreen bundle check passed (${result.scanned.length} files scanned)`);
}

function listJavaScriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listJavaScriptFiles(path));
    } else if (/\.(?:mjs|js)$/i.test(entry)) {
      files.push(path);
    }
  }

  return files;
}
