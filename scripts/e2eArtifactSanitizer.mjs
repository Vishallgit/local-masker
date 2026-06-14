export const FORBIDDEN_ARTIFACT_KEYS = new Set([
  "text",
  "prompt",
  "value",
  "innertext",
  "textcontent",
  "maskedtext",
  "original",
  "originals",
  "entities",
  "vault",
  "editor",
  "pagecontent"
]);

const SENSITIVE_DUMMY_VALUES = [
  "Harry Potter emailed harry.potter@hogwarts.edu from 123 Main St using key sk-abc123456789.",
  "Email john@example.com and use key sk-abc123456789. Account 1234-5678-9012.",
  "Harry Potter",
  "harry.potter@hogwarts.edu",
  "john@example.com",
  "123 Main St",
  "sk-abc123456789",
  "1234-5678-9012"
];

const PLACEHOLDER_TOKEN_PATTERN = /\u27E6LM_[A-Z_]+_[A-Z0-9]{8}_\d{3}\u27E7/g;

export function sanitizeE2eArtifact(value, options = {}) {
  const maxStringLength = Number.isInteger(options.maxStringLength) && options.maxStringLength > 0
    ? options.maxStringLength
    : 500;

  return sanitizeValue(value, maxStringLength);
}

export function hasForbiddenArtifactKey(value) {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenArtifactKey);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_ARTIFACT_KEYS.has(key.toLowerCase()) || hasForbiddenArtifactKey(nested)
  ));
}

export function createBasePrivacyFilterE2eReport(extra = {}) {
  return sanitizeE2eArtifact({
    reportType: "local-masker-privacy-filter-e2e",
    generatedAt: new Date().toISOString(),
    outcome: "not-run",
    steps: {
      browserFound: false,
      extensionLoaded: false,
      fixtureOpened: false,
      localMaskerButtonFound: false,
      composerOpened: false,
      runtimeDiagnosticsReachable: false,
      webgpuAvailable: false,
      privacyFilterLoad: "SKIPPED",
      privacyFilterSmokeTest: "SKIPPED",
      privacyFilterMaskInsert: "SKIPPED",
      regexFallbackConfirmed: "SKIPPED",
      artifactsWritten: false
    },
    artifacts: {},
    ...extra
  });
}

function sanitizeValue(value, maxStringLength) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, maxStringLength));
  }

  if (!value || typeof value !== "object") {
    return sanitizeScalar(value, maxStringLength);
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_ARTIFACT_KEYS.has(key.toLowerCase())) {
      continue;
    }

    result[key] = sanitizeValue(nested, maxStringLength);
  }

  return result;
}

function sanitizeScalar(value, maxStringLength) {
  if (typeof value !== "string") {
    return value;
  }

  let sanitized = value
    .replace(/chrome-extension:\/\/[a-z]{32}/gi, "chrome-extension://<extension>")
    .replace(PLACEHOLDER_TOKEN_PATTERN, "<redacted-placeholder>");

  for (const dummyValue of SENSITIVE_DUMMY_VALUES) {
    sanitized = sanitized.split(dummyValue).join("<redacted-dummy>");
  }

  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return sanitized.length > maxStringLength
    ? `${sanitized.slice(0, maxStringLength)}...`
    : sanitized;
}
