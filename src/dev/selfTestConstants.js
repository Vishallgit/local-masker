export const SELF_TEST_PROMPT = "John Doe emailed john@example.com from 123 Main St using key sk-abc123456789. Account 1234-5678-9012.";

export const SELF_TEST_FORBIDDEN_VALUES = [
  { key: "personAbsent", value: "John Doe" },
  { key: "emailAbsent", value: "john@example.com" },
  { key: "addressAbsent", value: "123 Main St" },
  { key: "secretAbsent", value: "sk-abc123456789" },
  { key: "accountAbsent", value: "1234-5678-9012" }
];

export const SELF_TEST_PLACEHOLDER_PREFIXES = [
  { key: "hasPrivatePersonPlaceholder", value: "LM_PRIVATE_PERSON" },
  { key: "hasPrivateAddressPlaceholder", value: "LM_PRIVATE_ADDRESS" },
  { key: "hasPrivateEmailPlaceholder", value: "LM_PRIVATE_EMAIL" },
  { key: "hasSecretPlaceholder", value: "LM_SECRET" },
  { key: "hasAccountNumberPlaceholder", value: "LM_ACCOUNT_NUMBER" }
];

const SELF_TEST_SCENARIOS = {
  default: {
    forbiddenValues: SELF_TEST_FORBIDDEN_VALUES,
    placeholderPrefixes: SELF_TEST_PLACEHOLDER_PREFIXES
  },
  privacyFilterFixture: {
    forbiddenValues: [
      { key: "personAbsent", value: "Harry Potter" },
      { key: "emailAbsent", value: "harry.potter@hogwarts.edu" },
      { key: "addressAbsent", value: "123 Main St" },
      { key: "secretAbsent", value: "sk-abc123456789" }
    ],
    placeholderPrefixes: [
      { key: "hasPrivatePersonPlaceholder", value: "LM_PRIVATE_PERSON" },
      { key: "hasPrivateAddressPlaceholder", value: "LM_PRIVATE_ADDRESS" },
      { key: "hasPrivateEmailPlaceholder", value: "LM_PRIVATE_EMAIL" },
      { key: "hasSecretPlaceholder", value: "LM_SECRET" }
    ]
  },
  regexFallbackFixture: {
    forbiddenValues: [
      { key: "emailAbsent", value: "john@example.com" },
      { key: "secretAbsent", value: "sk-abc123456789" },
      { key: "accountAbsent", value: "1234-5678-9012" }
    ],
    placeholderPrefixes: [
      { key: "hasPrivateEmailPlaceholder", value: "LM_PRIVATE_EMAIL" },
      { key: "hasSecretPlaceholder", value: "LM_SECRET" },
      { key: "hasAccountNumberPlaceholder", value: "LM_ACCOUNT_NUMBER" }
    ]
  }
};

const UNSAFE_REPORT_KEYS = new Set([
  "text",
  "prompt",
  "value",
  "innerText",
  "textContent",
  "maskedText",
  "original",
  "originals",
  "entities",
  "vault",
  "editor",
  "pageContent"
]);

export function isLocalSelfTestHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function verifyKnownSelfTestEditorState(editorSnapshot, metadata = {}) {
  const snapshot = String(editorSnapshot ?? "");
  const scenario = getSelfTestScenario(metadata.scenario);
  const forbiddenChecks = {};
  const placeholderChecks = {};

  for (const check of scenario.forbiddenValues) {
    forbiddenChecks[check.key] = !snapshot.includes(check.value);
  }

  for (const check of scenario.placeholderPrefixes) {
    placeholderChecks[check.key] = snapshot.includes(check.value);
  }

  const containsAnyForbiddenKnownTestValue = Object.values(forbiddenChecks).some((absent) => !absent);
  const containsExpectedPlaceholder = Object.values(placeholderChecks).every(Boolean);

  return sanitizeSelfTestReport({
    ok: Boolean(metadata.isLocalFixture) && !containsAnyForbiddenKnownTestValue && containsExpectedPlaceholder,
    isLocalFixture: Boolean(metadata.isLocalFixture),
    adapterName: metadata.adapterName || "",
    targetKind: metadata.targetKind || "",
    targetDescription: metadata.targetDescription || "",
    method: metadata.method || "",
    containsAnyForbiddenKnownTestValue,
    containsExpectedPlaceholder,
    forbiddenChecks,
    placeholderChecks,
    error: metadata.error || undefined
  });
}

export function summarizeSelfTestMasking(maskResult, inferenceResult = {}) {
  const entities = Array.isArray(maskResult?.entities) ? maskResult.entities : [];
  const detectedCounts = maskResult?.detectedCounts ?? {};
  const sources = maskResult?.sources ?? {};

  return sanitizeSelfTestReport({
    inference: {
      ok: Boolean(inferenceResult?.ok),
      provider: inferenceResult?.provider || "none",
      loaded: Boolean(inferenceResult?.modelStatus?.loaded),
      spansReturned: Array.isArray(inferenceResult?.spans) ? inferenceResult.spans.length : 0,
      error: inferenceResult?.error || ""
    },
    masking: {
      entityCount: entities.length,
      detectedCounts,
      sources,
      hasPrivatePerson: Boolean(detectedCounts.private_person),
      hasPrivateAddress: Boolean(detectedCounts.private_address),
      hasPrivateEmail: Boolean(detectedCounts.private_email),
      hasSecret: Boolean(detectedCounts.secret),
      hasAccountNumber: Boolean(detectedCounts.account_number)
    }
  });
}

export function validateSelfTestMaskedOutput(maskedOutput, entities = []) {
  const output = String(maskedOutput ?? "");
  const entityOriginalRemaining = entities.some((entity) => entity?.original && output.includes(entity.original));
  const forbiddenRemaining = SELF_TEST_FORBIDDEN_VALUES.some((check) => output.includes(check.value));

  return {
    ok: !entityOriginalRemaining && !forbiddenRemaining,
    entityOriginalRemaining,
    forbiddenRemaining
  };
}

export function sanitizeSelfTestReport(report) {
  if (Array.isArray(report)) {
    return report.map((item) => sanitizeSelfTestReport(item));
  }

  if (!report || typeof report !== "object") {
    return report;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(report)) {
    if (UNSAFE_REPORT_KEYS.has(key)) {
      continue;
    }

    sanitized[key] = sanitizeSelfTestReport(value);
  }

  return sanitized;
}

export function hasUnsafeSelfTestReportKey(report) {
  if (Array.isArray(report)) {
    return report.some((item) => hasUnsafeSelfTestReportKey(item));
  }

  if (!report || typeof report !== "object") {
    return false;
  }

  return Object.entries(report).some(([key, value]) => (
    UNSAFE_REPORT_KEYS.has(key) || hasUnsafeSelfTestReportKey(value)
  ));
}

function getSelfTestScenario(scenarioName) {
  const normalized = String(scenarioName || "default");
  return SELF_TEST_SCENARIOS[normalized] ?? SELF_TEST_SCENARIOS.default;
}
