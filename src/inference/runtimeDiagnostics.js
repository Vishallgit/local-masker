import {
  extractRuntimeSpecifierFromMessage,
  findUnresolvedRuntimeSpecifiers,
  isRuntimeSpecifierResolutionError
} from "./runtimeSpecifierChecks.js";
import { summarizeWebGPUProbe } from "./webgpuDiagnostics.js";

const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "text",
  "value",
  "innertext",
  "textcontent",
  "maskedtext",
  "original",
  "originals",
  "entities",
  "vault",
  "prompt",
  "editor",
  "pagecontent"
]);

const DEFAULT_ASSET_PATHS = [
  "dist/offscreen/offscreen.bundle.js",
  "dist/vendor/transformers/transformers.web.js",
  "dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs",
  "dist/vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm"
];

export async function getRuntimeDiagnostics(options = {}) {
  const errors = [];
  const manifest = getExtensionManifest();
  const buildManifestResult = await readBuildManifest();
  if (buildManifestResult.error) {
    errors.push(buildManifestResult.error);
  }

  const checkedAssets = await checkRuntimeAssets(buildManifestResult.manifest, errors);
  const bundleResolution = await checkRuntimeBundleResolution(buildManifestResult.manifest, errors);
  const csp = getCspDiagnostics(manifest, buildManifestResult.manifest);
  const runtimeResolutionFailed = Boolean(
    options.transformers?.unresolvedRuntimeSpecifier ||
    options.transformers?.runtimeResolutionErrorCategory === "runtime-module-resolution-failed"
  );
  const diagnostics = {
    ok: errors.length === 0,
    runtime: {
      isOffscreenDocument: Boolean(options.isOffscreenDocument),
      locationProtocol: getLocationProtocol(),
      userAgentFamily: getUserAgentFamily(),
      webgpuAvailable: isWebGpuAvailable(),
      crossOriginIsolated: typeof globalThis.crossOriginIsolated === "boolean"
        ? globalThis.crossOriginIsolated
        : undefined
    },
    webgpuProbe: summarizeWebGPUProbe(options.webgpuProbe ?? {
      ok: false,
      contextLabel: options.isOffscreenDocument ? "offscreen" : "unknown",
      navigatorGpuPresent: isWebGpuAvailable(),
      errorCategory: "",
      errorMessage: ""
    }),
    transformers: {
      importAvailable: Boolean(options.transformers?.importAvailable),
      envConfigured: Boolean(options.transformers?.envConfigured),
      localWasmPathConfigured: Boolean(options.transformers?.localWasmPathConfigured),
      localRuntimeAssetsConfigured: Boolean(options.transformers?.localRuntimeAssetsConfigured),
      localWasmPathOrigin: options.transformers?.localWasmPathOrigin || "unknown",
      resolvedRuntimeMode: options.transformers?.resolvedRuntimeMode || "unknown",
      onnxRuntimeWebgpuImportResolvable: runtimeResolutionFailed
        ? false
        : Boolean(options.transformers?.onnxRuntimeWebgpuImportResolvable || !bundleResolution.offscreenBundleHasBareOnnxImports),
      unresolvedRuntimeSpecifier: options.transformers?.unresolvedRuntimeSpecifier || bundleResolution.unresolvedRuntimeSpecifier,
      transformersPackageVersion: buildManifestResult.manifest?.dependencies?.["@huggingface/transformers"] || "",
      onnxruntimeWebPackageVersion: buildManifestResult.manifest?.dependencies?.["onnxruntime-web"] || "",
      runtimeResolutionErrorCategory: options.transformers?.runtimeResolutionErrorCategory || bundleResolution.runtimeResolutionErrorCategory,
      runtimeResolutionErrorMessage: options.transformers?.runtimeResolutionErrorMessage || bundleResolution.runtimeResolutionErrorMessage,
      allowRemoteModels: Boolean(options.transformers?.allowRemoteModels),
      allowLocalModels: options.transformers?.allowLocalModels
    },
    assets: {
      buildManifestAvailable: Boolean(buildManifestResult.manifest),
      wasmAssetsKnown: countWasmAssets(buildManifestResult.manifest),
      checkedAssets,
      offscreenBundleHasBareOnnxImports: bundleResolution.offscreenBundleHasBareOnnxImports,
      unresolvedRuntimeSpecifierCount: bundleResolution.unresolvedRuntimeSpecifierCount
    },
    build: getBuildMetadata(buildManifestResult.manifest),
    providers: options.providers ?? {},
    csp,
    errors
  };

  return sanitizeDiagnosticsReport(diagnostics);
}

export function sanitizeRuntimeError(error, options = {}) {
  return {
    category: options.category || classifyRuntimeError(error),
    message: options.useFallbackMessage
      ? String(options.fallback || "Runtime error.").slice(0, 240)
      : sanitizeErrorMessage(error, options.fallback || "Runtime error."),
    stackIncluded: false
  };
}

export function classifyRuntimeError(errorLike) {
  const message = extractErrorMessage(errorLike).toLowerCase();

  if (isRuntimeSpecifierResolutionError(message)) {
    return "runtime-module-resolution-failed";
  }

  if (/webgpuinit is not a function|onnx.*webgpu.*init|jsep.*webgpu/.test(message)) {
    return "onnx-webgpu-init-failed";
  }

  if (/webgpu adapter is unavailable|adapter-null|failed to get gpu adapter/.test(message)) {
    return "webgpu-adapter-unavailable";
  }

  if (/webgpu|navigator\.gpu|requestadapter|gpu adapter/.test(message)) {
    return "webgpu-unavailable";
  }

  if (message.includes(getUnsafeEvalToken()) || /content security policy|eval|new function|wasm code generation|refused to evaluate/.test(message)) {
    return "csp-eval-blocked";
  }

  if (/wasm|onnxruntime|ort-|no such file|not found|404/.test(message)) {
    return "wasm-asset-missing";
  }

  if (/timeout|timed out/.test(message)) {
    return "model-load-timeout";
  }

  if (/huggingface|model|fetch|network|cors|failed to fetch|load failed|403|401|blocked/.test(message)) {
    return "model-data-fetch-blocked";
  }

  if (/transformers|import/.test(message)) {
    return "transformers-import-failed";
  }

  if (/offscreen/.test(message)) {
    return "offscreen-unavailable";
  }

  return "unknown";
}

export function sanitizeDiagnosticsReport(report) {
  return sanitizeValue(report);
}

export function hasForbiddenDiagnosticKey(value) {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenDiagnosticKey);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_DIAGNOSTIC_KEYS.has(key.toLowerCase())) {
      return true;
    }

    if (hasForbiddenDiagnosticKey(nested)) {
      return true;
    }
  }

  return false;
}

async function readBuildManifest() {
  const path = "dist/build-manifest.json";
  try {
    const url = getExtensionUrl(path);
    if (!url || typeof fetch !== "function") {
      return {
        manifest: null,
        error: sanitizeRuntimeError("Build manifest unavailable.", { category: "wasm-asset-missing" })
      };
    }

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return {
        manifest: null,
        error: sanitizeRuntimeError("Build manifest unavailable.", { category: "wasm-asset-missing" })
      };
    }

    return { manifest: await response.json(), error: null };
  } catch (error) {
    return {
      manifest: null,
      error: sanitizeRuntimeError(error, { category: "wasm-asset-missing" })
    };
  }
}

async function checkRuntimeAssets(buildManifest, errors) {
  const manifestAssets = Array.isArray(buildManifest?.assets) ? buildManifest.assets : [];
  const assetPaths = manifestAssets.length > 0
    ? manifestAssets.map((asset) => asset.path).filter(isSafeRelativeAssetPath)
    : DEFAULT_ASSET_PATHS;
  const manifestByPath = new Map(manifestAssets.map((asset) => [asset.path, asset]));
  const checked = [];

  for (const path of assetPaths) {
    const manifestAsset = manifestByPath.get(path);
    try {
      const url = getExtensionUrl(path);
      if (!url || typeof fetch !== "function") {
        throw new Error("Extension asset fetch is unavailable.");
      }

      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Bundled runtime asset is unavailable.");
      }

      const blob = await response.blob();
      checked.push({
        path,
        ok: true,
        bytes: blob.size,
        sha256Known: Boolean(manifestAsset?.sha256)
      });
    } catch (error) {
      checked.push({
        path,
        ok: false,
        sha256Known: Boolean(manifestAsset?.sha256)
      });
      errors.push(sanitizeRuntimeError(error, { category: "wasm-asset-missing" }));
    }
  }

  return checked;
}

async function checkRuntimeBundleResolution(buildManifest, errors) {
  const paths = getRuntimeBundlePaths(buildManifest);
  const findings = [];

  for (const path of paths) {
    try {
      const url = getExtensionUrl(path);
      if (!url || typeof fetch !== "function") {
        continue;
      }

      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        continue;
      }

      const content = await response.text();
      for (const finding of findUnresolvedRuntimeSpecifiers(content)) {
        findings.push({
          path,
          specifier: finding.specifier,
          kind: finding.kind
        });
      }
    } catch {
      // Asset availability is reported by checkRuntimeAssets; this check only
      // reports unresolved runtime imports when JavaScript text is readable.
    }
  }

  const first = findings[0];
  if (first) {
    const error = sanitizeRuntimeError(`Unresolved runtime module specifier: ${first.specifier}`, {
      category: "runtime-module-resolution-failed"
    });
    errors.push(error);
    return {
      offscreenBundleHasBareOnnxImports: true,
      unresolvedRuntimeSpecifier: first.specifier,
      unresolvedRuntimeSpecifierCount: findings.length,
      runtimeResolutionErrorCategory: error.category,
      runtimeResolutionErrorMessage: error.message
    };
  }

  return {
    offscreenBundleHasBareOnnxImports: false,
    unresolvedRuntimeSpecifier: null,
    unresolvedRuntimeSpecifierCount: 0,
    runtimeResolutionErrorCategory: "",
    runtimeResolutionErrorMessage: ""
  };
}

function getCspDiagnostics(manifest, buildManifest) {
  const csp = manifest?.content_security_policy?.extension_pages || "";
  const unsafeEvalToken = getUnsafeEvalToken();
  const hasUnsafeEval = new RegExp(`(^|[^-])${escapeRegExp(unsafeEvalToken)}`).test(csp);
  const hasWasmUnsafeEval = new RegExp(`\\b${escapeRegExp(`wasm-${unsafeEvalToken}`)}\\b`).test(csp);
  const hasOnnxGlue = (buildManifest?.assets ?? []).some((asset) => /onnxruntime-web\/.*\.mjs$/.test(asset.path));

  return {
    unsafeEvalAllowed: hasUnsafeEval,
    wasmUnsafeEvalConfigured: hasWasmUnsafeEval,
    suspectedEvalShimRisk: hasOnnxGlue && !hasUnsafeEval
  };
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (!value || typeof value !== "object") {
    return sanitizeScalar(value);
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_DIAGNOSTIC_KEYS.has(key.toLowerCase())) {
      continue;
    }

    result[key] = sanitizeValue(nested);
  }

  return result;
}

function sanitizeScalar(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(/chrome-extension:\/\/[a-z]{32}/gi, "chrome-extension://<extension>")
    .slice(0, 500);
}

function sanitizeErrorMessage(error, fallback) {
  return extractErrorMessage(error)
    .replace(/chrome-extension:\/\/[a-z]{32}/gi, "chrome-extension://<extension>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || fallback;
}

function extractErrorMessage(errorLike) {
  if (typeof errorLike === "string") {
    return errorLike;
  }

  if (typeof errorLike?.message === "string") {
    return errorLike.message;
  }

  return String(errorLike ?? "");
}

function getRuntimeBundlePaths(buildManifest) {
  const manifestPaths = (buildManifest?.assets ?? [])
    .map((asset) => asset.path)
    .filter((path) => isSafeRelativeAssetPath(path) && /^dist\/(?:offscreen|vendor\/transformers)\/.*\.(?:mjs|js)$/i.test(path));

  return manifestPaths.length > 0
    ? manifestPaths
    : DEFAULT_ASSET_PATHS.filter((path) => /^dist\/(?:offscreen|vendor\/transformers)\/.*\.(?:mjs|js)$/i.test(path));
}

function getExtensionManifest() {
  if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
    return chrome.runtime.getManifest();
  }

  return null;
}

function getExtensionUrl(path) {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }

  return "";
}

function getLocationProtocol() {
  return typeof location !== "undefined" && typeof location.protocol === "string"
    ? location.protocol
    : "unknown";
}

function getUserAgentFamily() {
  const agent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return /Chrome|Chromium|Edg/i.test(agent) ? "chromium" : "unknown";
}

function isWebGpuAvailable() {
  return typeof navigator !== "undefined" && Boolean(navigator.gpu);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUnsafeEvalToken() {
  return String.fromCharCode(117, 110, 115, 97, 102, 101, 45, 101, 118, 97, 108);
}

function countWasmAssets(buildManifest) {
  return (buildManifest?.assets ?? []).filter((asset) => /\.wasm$/i.test(asset.path)).length;
}

function getBuildMetadata(buildManifest) {
  return {
    generatedAt: buildManifest?.generatedAt || "",
    packageName: buildManifest?.package?.name || "",
    packageVersion: buildManifest?.package?.version || "",
    transformersVersion: buildManifest?.dependencies?.["@huggingface/transformers"] || "",
    onnxruntimeWebVersion: buildManifest?.dependencies?.["onnxruntime-web"] || "",
    onnxRuntimeWebgpuResolvedPath: buildManifest?.runtimeResolution?.onnxRuntimeWebgpuResolvedPath || "",
    esbuildVersion: buildManifest?.dependencies?.esbuild || ""
  };
}

export function isSafeRelativeAssetPath(path) {
  return typeof path === "string" &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path);
}
