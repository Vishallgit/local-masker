import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const BROWSER_MAIN_FIELDS = ["browser", "module", "main"];
export const BROWSER_CONDITIONS = [
  "browser",
  "import",
  "module",
  "onnxruntime-web-use-extern-wasm",
  "default"
];

export function createRuntimeResolutionPlugin({ projectRoot, conditions = BROWSER_CONDITIONS } = {}) {
  return {
    name: "local-masker-runtime-resolution",
    setup(build) {
      build.onResolve({ filter: /^(?:onnxruntime-web(?:\/webgpu)?|#onnxruntime-web(?:gpu)?)$/ }, (args) => {
        const resolved = resolveRuntimeSpecifier(projectRoot, args.path, conditions);
        if (!resolved.ok) {
          return {
            errors: [{
              text: resolved.error || `Unable to resolve ${args.path}`
            }]
          };
        }

        return { path: resolved.absolutePath };
      });
    }
  };
}

export function resolveRuntimeSpecifier(projectRoot, specifier, conditions = BROWSER_CONDITIONS) {
  const exportKey = getOnnxRuntimeExportKey(specifier);
  if (!exportKey) {
    return {
      ok: false,
      specifier,
      error: `Unsupported runtime specifier: ${specifier}`
    };
  }

  const resolved = resolvePackageExport(projectRoot, "onnxruntime-web", exportKey, conditions);
  return {
    ...resolved,
    specifier,
    mappedSpecifier: exportKey === "." ? "onnxruntime-web" : `onnxruntime-web/${exportKey.slice(2)}`
  };
}

export function resolvePackageExport(projectRoot, packageName, exportKey, conditions = BROWSER_CONDITIONS) {
  const packageResult = readInstalledPackageJson(projectRoot, packageName);
  if (!packageResult.ok) {
    return packageResult;
  }

  const { packageJson, packageDir } = packageResult;
  const exportMap = packageJson.exports ?? {};
  const exportTarget = exportMap[exportKey];
  const target = selectConditionalExport(exportTarget, conditions);
  if (!target) {
    return {
      ok: false,
      packageName,
      exportKey,
      error: `${packageName} does not expose ${exportKey} for browser import conditions.`
    };
  }

  const absolutePath = join(packageDir, target);
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      packageName,
      exportKey,
      target,
      absolutePath,
      error: `Resolved runtime file does not exist: ${toProjectRelative(projectRoot, absolutePath)}`
    };
  }

  return {
    ok: true,
    packageName,
    exportKey,
    target,
    absolutePath,
    relativePath: toProjectRelative(projectRoot, absolutePath)
  };
}

export function readInstalledPackageJson(projectRoot, packageName) {
  const packageJsonPath = join(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      packageName,
      packageJsonPath,
      error: `${packageName} is not installed.`
    };
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return {
      ok: true,
      packageName,
      packageJson,
      packageDir: dirname(packageJsonPath),
      packageJsonPath,
      version: packageJson.version || ""
    };
  } catch (error) {
    return {
      ok: false,
      packageName,
      packageJsonPath,
      error: error.message || `Unable to read ${packageName} package.json.`
    };
  }
}

export function selectConditionalExport(target, conditions = BROWSER_CONDITIONS) {
  if (typeof target === "string") {
    return target;
  }

  if (Array.isArray(target)) {
    for (const candidate of target) {
      const selected = selectConditionalExport(candidate, conditions);
      if (selected) {
        return selected;
      }
    }
    return "";
  }

  if (!target || typeof target !== "object") {
    return "";
  }

  for (const [condition, conditionalTarget] of Object.entries(target)) {
    if (condition === "types") {
      continue;
    }

    if (conditions.includes(condition) || condition === "default") {
      const selected = selectConditionalExport(conditionalTarget, conditions);
      if (selected) {
        return selected;
      }
    }
  }

  return "";
}

export function getOnnxRuntimeExportKey(specifier) {
  if (specifier === "onnxruntime-web" || specifier === "#onnxruntime-web") {
    return ".";
  }

  if (specifier === "onnxruntime-web/webgpu" || specifier === "#onnxruntime-webgpu") {
    return "./webgpu";
  }

  return "";
}

export function toProjectRelative(projectRoot, absolutePath) {
  return relative(projectRoot, absolutePath).replaceAll("\\", "/");
}
