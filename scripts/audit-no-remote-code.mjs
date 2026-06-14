import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnresolvedRuntimeSpecifiers } from "./check-offscreen-bundle.mjs";

const projectRoot = resolve(".");
const README_PATH = resolve(projectRoot, "README.md");

export function analyzeContent(content, normalizedPath, options = {}) {
  const findings = [];
  const warnings = [];
  const readmeDocumentsOnnxRisk = Boolean(options.readmeDocumentsOnnxRisk);
  const manifestCspAllowsUnsafeEval = Boolean(options.manifestCspAllowsUnsafeEval);

  for (const check of getFatalPatterns()) {
    if (check.pattern.test(content)) {
      findings.push(`${normalizedPath}: ${check.name}`);
    }
  }

  if (/\bnew Function\s*\(/.test(content)) {
    if (isAllowedOnnxRuntimeShim(normalizedPath, readmeDocumentsOnnxRisk, manifestCspAllowsUnsafeEval)) {
      warnings.push(`${normalizedPath}: documented local ONNX Runtime new Function shim; CSP does not allow unsafe-eval.`);
    } else {
      findings.push(`${normalizedPath}: new Function`);
    }
  }

  if (shouldCheckForUnresolvedRuntimeSpecifiers(normalizedPath)) {
    for (const finding of findUnresolvedRuntimeSpecifiers(content)) {
      findings.push(`${normalizedPath}: unresolved ${finding.kind} ${finding.specifier}`);
    }
  }

  return { findings, warnings };
}

export function getFatalPatterns() {
  return [
    { name: "remote script tag", pattern: /<script[^>]+src=["']https?:/i },
    { name: "remote dynamic import", pattern: /import\s*\(\s*["']https?:/i },
    { name: "remote static import", pattern: /import\s+[^;]*["']https?:/i },
    { name: "eval", pattern: /\beval\s*\(/i },
    { name: "unsafe-eval", pattern: /(^|[^-])unsafe-eval/i },
    { name: "cdn.jsdelivr", pattern: /cdn\.jsdelivr/i },
    { name: "unpkg", pattern: /unpkg\.com/i },
    { name: "esm.sh", pattern: /esm\.sh/i },
    { name: "skypack", pattern: /skypack/i }
  ];
}

export function auditProject(root = projectRoot) {
  const manifestPath = resolve(root, "manifest.json");
  const readme = existsSync(README_PATH) ? readFileSync(README_PATH, "utf8") : "";
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const readmeDocumentsOnnxRisk = /ONNX Runtime local WASM glue/i.test(readme);
  const manifestCspAllowsUnsafeEval = /(^|[^-])unsafe-eval/.test(manifest);
  const scanRoots = [
    resolve(root, "src"),
    resolve(root, "dist"),
    resolve(root, "scripts"),
    manifestPath
  ].filter(existsSync);
  const findings = [];
  const warnings = [];

  for (const file of listFiles(scanRoots)) {
    const normalized = relative(root, file).replaceAll("\\", "/");
    if (isBinaryLike(file) || normalized === "scripts/audit-no-remote-code.mjs") {
      continue;
    }

    const result = analyzeContent(readFileSync(file, "utf8"), normalized, {
      readmeDocumentsOnnxRisk,
      manifestCspAllowsUnsafeEval
    });
    findings.push(...result.findings);
    warnings.push(...result.warnings);
  }

  return { findings, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { findings, warnings } = auditProject(projectRoot);

  if (findings.length > 0) {
    console.error("remote-code audit failed");
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("remote-code audit warnings");
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }

  console.log("remote-code audit passed");
}

function isAllowedOnnxRuntimeShim(normalizedPath, readmeDocumentsOnnxRisk, manifestCspAllowsUnsafeEval) {
  return normalizedPath.startsWith("dist/vendor/onnxruntime-web/") &&
    readmeDocumentsOnnxRisk &&
    !manifestCspAllowsUnsafeEval;
}

function shouldCheckForUnresolvedRuntimeSpecifiers(normalizedPath) {
  return /^dist\/(?:offscreen|vendor\/transformers)\/.*\.(?:mjs|js)$/i.test(normalizedPath);
}

function listFiles(paths) {
  const files = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        files.push(...listFiles([join(path, entry)]));
      }
    } else {
      files.push(path);
    }
  }

  return files;
}

function isBinaryLike(file) {
  return /\.(wasm|png|jpg|jpeg|gif|webp|ico)$/i.test(file);
}
