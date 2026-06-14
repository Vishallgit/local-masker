import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findUnresolvedRuntimeSpecifiers } from "../src/inference/runtimeSpecifierChecks.js";
import {
  BROWSER_CONDITIONS,
  readInstalledPackageJson,
  resolveRuntimeSpecifier,
  toProjectRelative
} from "./runtime-package-resolution.mjs";

const projectRoot = resolve(".");
const require = createRequire(import.meta.url);
const runtimeSpecifiers = [
  "onnxruntime-web",
  "onnxruntime-web/webgpu",
  "#onnxruntime-webgpu",
  "#onnxruntime-web"
];

const rootPackage = readJsonIfExists(join(projectRoot, "package.json"));
const transformersPackage = readInstalledPackageJson(projectRoot, "@huggingface/transformers");
const onnxPackage = readInstalledPackageJson(projectRoot, "onnxruntime-web");
const esbuildPackage = readInstalledPackageJson(projectRoot, "esbuild");
const transformersSource = join(projectRoot, "node_modules", "@huggingface", "transformers", "dist", "transformers.web.js");
const transformersRuntime = join(projectRoot, "dist", "vendor", "transformers", "transformers.web.js");
const offscreenBundle = join(projectRoot, "dist", "offscreen", "offscreen.bundle.js");

const sourceContent = existsSync(transformersSource) ? readFileSync(transformersSource, "utf8") : "";
const builtRuntimeContent = existsSync(transformersRuntime) ? readFileSync(transformersRuntime, "utf8") : "";
const offscreenContent = existsSync(offscreenBundle) ? readFileSync(offscreenBundle, "utf8") : "";
const likelyImportFile = findLikelyTransformersImportFile();
const webgpuNodeResolution = resolveWithNode("onnxruntime-web/webgpu");
const webgpuBrowserResolution = resolveRuntimeSpecifier(projectRoot, "onnxruntime-web/webgpu", BROWSER_CONDITIONS);
const unresolvedInBuiltRuntime = findUnresolvedRuntimeSpecifiers(builtRuntimeContent);
const unresolvedInOffscreen = findUnresolvedRuntimeSpecifiers(offscreenContent);

const report = {
  packageDependencies: {
    "@huggingface/transformers": rootPackage.dependencies?.["@huggingface/transformers"] || "",
    "onnxruntime-web": rootPackage.dependencies?.["onnxruntime-web"] || transformersPackage.packageJson?.dependencies?.["onnxruntime-web"] || "",
    esbuild: rootPackage.devDependencies?.esbuild || rootPackage.dependencies?.esbuild || ""
  },
  installed: {
    "@huggingface/transformers": transformersPackage.version || "",
    "onnxruntime-web": onnxPackage.version || "",
    esbuild: esbuildPackage.version || ""
  },
  onnxruntimeWebInstalled: Boolean(onnxPackage.ok),
  nodeResolution: {
    "onnxruntime-web/webgpu": webgpuNodeResolution
  },
  browserExportResolution: Object.fromEntries(
    runtimeSpecifiers.map((specifier) => {
      const resolved = resolveRuntimeSpecifier(projectRoot, specifier, BROWSER_CONDITIONS);
      return [specifier, resolved.ok ? resolved.relativePath : resolved.error];
    })
  ),
  transformersSource: {
    hasPackageImportAlias: /#onnxruntime-webgpu/.test(sourceContent),
    importsOnnxRuntimeWebgpu: /onnxruntime-web\/webgpu/.test(sourceContent),
    likelyImportFile
  },
  builtRuntime: {
    transformersRuntimeExists: existsSync(transformersRuntime),
    offscreenBundleExists: existsSync(offscreenBundle),
    webgpuEntryIncludedInTransformersRuntime: Boolean(
      existsSync(transformersRuntime) &&
      webgpuBrowserResolution.ok &&
      onnxPackage.version &&
      builtRuntimeContent.includes(onnxPackage.version) &&
      !unresolvedInBuiltRuntime.some((finding) => finding.specifier === "onnxruntime-web/webgpu")
    ),
    webgpuEntryCopiedAsStandaloneAsset: existsSync(join(projectRoot, "dist", "vendor", "onnxruntime-web", "ort.webgpu.min.mjs")),
    unresolvedRuntimeSpecifiers: [
      ...unresolvedInOffscreen.map((finding) => ({
        path: "dist/offscreen/offscreen.bundle.js",
        specifier: finding.specifier,
        kind: finding.kind
      })),
      ...unresolvedInBuiltRuntime.map((finding) => ({
        path: "dist/vendor/transformers/transformers.web.js",
        specifier: finding.specifier,
        kind: finding.kind
      }))
    ]
  }
};

printReport(report);

function printReport(value) {
  console.log("Transformers runtime inspection");
  console.log(`- onnxruntime-web installed: ${value.onnxruntimeWebInstalled}`);
  console.log(`- package versions: transformers=${value.installed["@huggingface/transformers"] || "missing"}, onnxruntime-web=${value.installed["onnxruntime-web"] || "missing"}, esbuild=${value.installed.esbuild || "missing"}`);
  console.log(`- declared versions: transformers=${value.packageDependencies["@huggingface/transformers"] || "not declared"}, onnxruntime-web=${value.packageDependencies["onnxruntime-web"] || "transitive"}, esbuild=${value.packageDependencies.esbuild || "not declared"}`);
  console.log(`- Node resolves onnxruntime-web/webgpu: ${value.nodeResolution["onnxruntime-web/webgpu"] || "no"}`);
  console.log(`- browser export onnxruntime-web/webgpu: ${value.browserExportResolution["onnxruntime-web/webgpu"] || "no"}`);
  console.log(`- #onnxruntime-webgpu appears in Transformers source: ${value.transformersSource.hasPackageImportAlias}`);
  console.log(`- likely source import file: ${value.transformersSource.likelyImportFile || "not found"}`);
  console.log(`- built Transformers runtime exists: ${value.builtRuntime.transformersRuntimeExists}`);
  console.log(`- offscreen bundle exists: ${value.builtRuntime.offscreenBundleExists}`);
  console.log(`- WebGPU entry appears bundled into Transformers runtime: ${value.builtRuntime.webgpuEntryIncludedInTransformersRuntime}`);
  console.log(`- WebGPU entry copied as standalone asset: ${value.builtRuntime.webgpuEntryCopiedAsStandaloneAsset}`);

  if (value.builtRuntime.unresolvedRuntimeSpecifiers.length) {
    console.log("- unresolved runtime specifiers:");
    for (const finding of value.builtRuntime.unresolvedRuntimeSpecifiers) {
      console.log(`  - ${finding.path}: ${finding.kind} ${finding.specifier}`);
    }
  } else {
    console.log("- unresolved runtime specifiers: none");
  }
}

function resolveWithNode(specifier) {
  try {
    return toProjectRelative(projectRoot, require.resolve(specifier));
  } catch {
    return "";
  }
}

function findLikelyTransformersImportFile() {
  const candidates = [
    join(projectRoot, "node_modules", "@huggingface", "transformers", "src", "backends", "onnx.js"),
    transformersSource
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && /onnxruntime-web\/webgpu|#onnxruntime-webgpu/.test(readFileSync(candidate, "utf8"))) {
      return toProjectRelative(projectRoot, candidate);
    }
  }

  return "";
}

function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return {};
  }

  return JSON.parse(readFileSync(path, "utf8"));
}
