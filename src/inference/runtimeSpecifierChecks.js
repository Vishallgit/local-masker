export function findUnresolvedRuntimeSpecifiers(content) {
  const source = String(content ?? "");
  const findings = [];

  for (const specifier of getRuntimeSpecifiers()) {
    if (getPackageImportAliases().has(specifier)) {
      findings.push(...findPackageImportAlias(source, specifier));
      continue;
    }

    findings.push(...findBarePackageImports(source, specifier));
  }

  return findings;
}

export function extractRuntimeSpecifierFromMessage(message) {
  const normalized = String(message ?? "");
  return getRuntimeSpecifiers().find((specifier) => normalized.includes(specifier)) || null;
}

export function isRuntimeSpecifierResolutionError(errorLike) {
  const message = extractErrorMessage(errorLike).toLowerCase();
  return Boolean(extractRuntimeSpecifierFromMessage(message)) ||
    /failed to resolve module specifier|bare specifier|module specifier/.test(message);
}

function findBarePackageImports(source, specifier) {
  return [
    ...findMatches(source, new RegExp(`\\bfrom\\s*["']${escapeRegExp(specifier)}["']`, "g"), specifier, "static-import"),
    ...findMatches(source, new RegExp(`\\bimport\\s*\\(\\s*["']${escapeRegExp(specifier)}["']\\s*\\)`, "g"), specifier, "dynamic-import"),
    ...findMatches(source, new RegExp(`\\bimport\\s*["']${escapeRegExp(specifier)}["']`, "g"), specifier, "side-effect-import")
  ];
}

function findPackageImportAlias(source, specifier) {
  return [
    ...findMatches(source, new RegExp(`\\bfrom\\s*["']${escapeRegExp(specifier)}["']`, "g"), specifier, "package-import-alias"),
    ...findMatches(source, new RegExp(`\\bimport\\s*\\(\\s*["']${escapeRegExp(specifier)}["']\\s*\\)`, "g"), specifier, "package-import-alias"),
    ...findMatches(source, new RegExp(`["']${escapeRegExp(specifier)}["']`, "g"), specifier, "package-import-alias")
  ];
}

function getRuntimeSpecifiers() {
  const packageName = getOnnxRuntimePackageName();
  const packageImportAlias = `#${packageName}`;
  return [
    `${packageName}/webgpu`,
    `${packageImportAlias}gpu`,
    packageImportAlias,
    packageName
  ];
}

function getPackageImportAliases() {
  const packageImportAlias = `#${getOnnxRuntimePackageName()}`;
  return new Set([
    `${packageImportAlias}gpu`,
    packageImportAlias
  ]);
}

function getOnnxRuntimePackageName() {
  return `${fromCodePoints([111, 110, 110, 120, 114, 117, 110, 116, 105, 109, 101])}-${fromCodePoints([119, 101, 98])}`;
}

function findMatches(source, pattern, specifier, kind) {
  const findings = [];
  for (const match of source.matchAll(pattern)) {
    findings.push({
      specifier,
      kind,
      index: match.index ?? 0
    });
  }

  return findings;
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

function fromCodePoints(values) {
  return String.fromCharCode(...values);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
