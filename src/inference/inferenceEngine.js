import { inferMockSpans } from "./providers/mockProvider.js";
import {
  getPrivacyFilterStatus,
  inferPrivacyFilterSpans
} from "./providers/privacyFilterProvider.js";
import { normalizeSpans } from "./spanUtils.js";

const MOCK_MODEL_STATUS = {
  provider: "mock",
  loaded: true,
  device: "none",
  dtype: "none",
  modelId: "mock-local-provider"
};

const REGEX_ONLY_STATUS = {
  provider: "regex-only",
  loaded: true,
  device: "none",
  dtype: "none",
  modelId: "deterministic-regex"
};

const AVAILABLE_PROVIDERS = ["regex-only", "mock", "privacy-filter"];

export async function runInference(text, options = {}) {
  const sourceText = String(text ?? "");
  const providerPreference = normalizeProviderPreference(options.providerPreference);

  if (providerPreference === "regex-only") {
    return {
      ok: true,
      provider: "regex-only",
      modelStatus: { ...REGEX_ONLY_STATUS },
      spans: []
    };
  }

  if (providerPreference === "privacy-filter") {
    return inferPrivacyFilterSpans(sourceText, options);
  }

  if (providerPreference === "auto" && options.allowPrivacyFilter === true && getPrivacyFilterStatus().loaded) {
    return inferPrivacyFilterSpans(sourceText, options);
  }

  const spans = normalizeSpans(await inferMockSpans(sourceText, options), sourceText);

  return {
    ok: true,
    provider: "mock",
    modelStatus: { ...MOCK_MODEL_STATUS },
    spans,
    warnings: providerPreference === "auto"
      ? ["Privacy Filter is not auto-loaded; using mock provider."]
      : undefined
  };
}

export function getInferenceStatus() {
  const privacyFilterStatus = getPrivacyFilterStatus();
  const activeProvider = privacyFilterStatus.loaded || privacyFilterStatus.loading
    ? "privacy-filter"
    : "mock";

  return {
    ok: true,
    provider: activeProvider,
    activeProvider,
    availableProviders: [...AVAILABLE_PROVIDERS],
    modelStatus: {
      regexOnly: { ...REGEX_ONLY_STATUS },
      mock: { ...MOCK_MODEL_STATUS },
      privacyFilter: privacyFilterStatus
    }
  };
}

function normalizeProviderPreference(value) {
  const preference = String(value || "mock");
  return AVAILABLE_PROVIDERS.includes(preference) || preference === "auto"
    ? preference
    : "mock";
}
