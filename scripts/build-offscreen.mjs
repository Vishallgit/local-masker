import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import {
  BROWSER_CONDITIONS,
  BROWSER_MAIN_FIELDS,
  createRuntimeResolutionPlugin,
  resolveRuntimeSpecifier
} from "./runtime-package-resolution.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const distDir = resolve(projectRoot, "dist");
const buildManifestPath = join(distDir, "build-manifest.json");
const offscreenOutfile = join(distDir, "offscreen", "offscreen.bundle.js");
const transformersSource = join(projectRoot, "node_modules", "@huggingface", "transformers", "dist", "transformers.web.js");
const transformersTarget = join(distDir, "vendor", "transformers", "transformers.web.js");
const ortSourceDir = join(projectRoot, "node_modules", "onnxruntime-web", "dist");
const ortTargetDir = join(distDir, "vendor", "onnxruntime-web");

const buildOptions = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  mainFields: BROWSER_MAIN_FIELDS,
  conditions: BROWSER_CONDITIONS,
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "silent",
  plugins: [createRuntimeResolutionPlugin({ projectRoot })]
};

if (!distDir.startsWith(`${projectRoot}${sep}`)) {
  throw new Error("Refusing to clean a dist path outside the project.");
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(dirname(offscreenOutfile), { recursive: true });
mkdirSync(dirname(transformersTarget), { recursive: true });
mkdirSync(ortTargetDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(projectRoot, "src", "offscreen", "offscreen.js")],
  outfile: offscreenOutfile,
  ...buildOptions
});

await buildPatchedTransformersRuntime();
const copiedOrtAssets = copyOrtAssets();
writeBuildManifest(copiedOrtAssets);

const bundleSizeKb = formatKb(statSync(offscreenOutfile).size);
const vendorSizeKb = formatKb(statSync(transformersTarget).size);
console.log(`built ${relative(offscreenOutfile)} (${bundleSizeKb})`);
console.log(`bundled ${relative(transformersTarget)} (${vendorSizeKb})`);
console.log(`copied ${copiedOrtAssets.length} local ONNX Runtime assets into ${relative(ortTargetDir)}`);
console.log(`wrote ${relative(buildManifestPath)}`);

async function buildPatchedTransformersRuntime() {
  if (!existsSync(transformersSource)) {
    throw new Error("Missing @huggingface/transformers web runtime. Run npm install first.");
  }

  await esbuild.build({
    entryPoints: [transformersSource],
    outfile: transformersTarget,
    splitting: false,
    ...buildOptions
  });

  let source = readFileSync(transformersTarget, "utf8");
  const cdnHost = "cdn." + "jsdelivr.net";
  const remoteWasmPathPrefix = new RegExp(
    `const wasmPathPrefix = \`https://${escapeRegExp(cdnHost)}/npm/onnxruntime-web@\\$\\{ONNX_ENV\\.versions\\.web\\}/dist/\`;`,
    "g"
  );
  const localWasmPathPrefix = 'const wasmPathPrefix = chrome.runtime.getURL("dist/vendor/onnxruntime-web/");';
  source = source.replace(
    remoteWasmPathPrefix,
    localWasmPathPrefix
  );

  if (source.includes(cdnHost)) {
    throw new Error("Bundled Transformers runtime still contains a CDN WASM fallback.");
  }

  if (!source.includes(localWasmPathPrefix)) {
    throw new Error("Bundled Transformers runtime did not receive the local ONNX WASM fallback.");
  }

  writeFileSync(transformersTarget, source);
}

function copyOrtAssets() {
  const ortAssets = discoverOrtAssets();
  for (const asset of ortAssets) {
    const source = join(ortSourceDir, asset);
    if (!existsSync(source)) {
      throw new Error(`Missing ONNX Runtime asset: ${asset}`);
    }

    copyFileSync(source, join(ortTargetDir, asset));
  }

  return ortAssets;
}

function discoverOrtAssets() {
  if (!existsSync(ortSourceDir)) {
    throw new Error("Missing onnxruntime-web dist assets. Run npm install first.");
  }

  const requiredAssets = new Set([
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm"
  ]);
  const availableAssets = new Set(readdirSync(ortSourceDir));

  for (const asset of requiredAssets) {
    if (!availableAssets.has(asset)) {
      throw new Error(`Missing ONNX Runtime asset: ${asset}`);
    }
  }

  return [...requiredAssets].sort();
}

function writeBuildManifest(ortAssets) {
  const assetPaths = [
    offscreenOutfile,
    transformersTarget,
    ...ortAssets.map((asset) => join(ortTargetDir, asset))
  ];
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const transformersPackage = JSON.parse(readFileSync(join(projectRoot, "node_modules", "@huggingface", "transformers", "package.json"), "utf8"));
  const onnxRuntimePackage = JSON.parse(readFileSync(join(projectRoot, "node_modules", "onnxruntime-web", "package.json"), "utf8"));
  const esbuildPackage = JSON.parse(readFileSync(join(projectRoot, "node_modules", "esbuild", "package.json"), "utf8"));
  const webgpuResolution = resolveRuntimeSpecifier(projectRoot, "onnxruntime-web/webgpu");
  const manifest = {
    generatedAt: new Date().toISOString(),
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    dependencies: {
      "@huggingface/transformers": transformersPackage.version,
      "onnxruntime-web": onnxRuntimePackage.version,
      esbuild: esbuildPackage.version
    },
    runtimeResolution: {
      onnxRuntimeWebgpuSpecifier: "onnxruntime-web/webgpu",
      onnxRuntimeWebgpuResolvedPath: webgpuResolution.ok ? webgpuResolution.relativePath : "",
      onnxRuntimeWebgpuBundledInto: relative(transformersTarget),
      conditions: BROWSER_CONDITIONS,
      mainFields: BROWSER_MAIN_FIELDS
    },
    assets: assetPaths.map((path) => {
      const bytes = readFileSync(path);
      return {
        path: relative(path),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    })
  };

  writeFileSync(buildManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function relative(path) {
  return path.slice(projectRoot.length + 1).replaceAll("\\", "/");
}

function formatKb(bytes) {
  return `${Math.ceil(bytes / 1024)} KB`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
