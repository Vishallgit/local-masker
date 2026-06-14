import {
  countEntities,
  mergeAndDedupeSpans,
  normalizeSpans,
  spansToEntities
} from "../inference/spanUtils.js";

export function maskText(text, options = {}) {
  const source = String(text ?? "");
  const startIndex = Number.isInteger(options.startIndex) && options.startIndex > 0
    ? options.startIndex
    : 1;

  const regexSpans = collectRegexSpans(source);
  const externalSpans = normalizeSpans(
    (options.externalSpans ?? []).map((span) => ({
      ...span,
      source: span?.source || options.externalSource || "external"
    })),
    source
  );
  const mergedSpans = mergeAndDedupeSpans([...regexSpans, ...externalSpans], { text: source });
  const entities = spansToEntities(source, mergedSpans, {
    sessionId: options.sessionId,
    startIndex
  });

  let maskedText = source;
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index];
    maskedText =
      maskedText.slice(0, entity.start) +
      entity.placeholder +
      maskedText.slice(entity.end);
  }

  const detectedCounts = countEntities(entities);
  const sources = countSources(entities);

  return {
    maskedText,
    entities,
    detectedCounts,
    sources
  };
}

function collectRegexSpans(text) {
  const spans = [];

  addRegexSpans(spans, text, "secret", /\bsk-[A-Za-z0-9_-]{8,}\b/g, 0.99);
  addRegexSpans(spans, text, "secret", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 0.99);
  addRegexSpans(spans, text, "secret", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 0.99);
  addKeyValueSecretSpans(spans, text);

  addRegexSpans(
    spans,
    text,
    "private_email",
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    0.95
  );

  addUrlSpans(spans, text);
  addPhoneSpans(spans, text);
  addDateSpans(spans, text);
  addAccountNumberSpans(spans, text);

  return normalizeSpans(spans, text);
}

function addRegexSpans(spans, text, label, regex, score) {
  for (const match of text.matchAll(regex)) {
    addSpan(spans, label, match.index, match.index + match[0].length, score);
  }
}

function addUrlSpans(spans, text) {
  const urlRegex = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  for (const match of text.matchAll(urlRegex)) {
    const trimmed = trimTrailingPunctuation(text, match.index, match.index + match[0].length);
    addSpan(spans, "private_url", trimmed.start, trimmed.end, 0.9);
  }
}

function addPhoneSpans(spans, text) {
  const phoneRegex = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s?(?:x|ext\.?)\s?\d{1,6})?/gi;
  for (const match of text.matchAll(phoneRegex)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isWordAdjacent(text, start, end)) {
      continue;
    }

    const original = text.slice(start, end);
    const digitCount = countDigits(original);
    if (digitCount < 10 || digitCount > 15) {
      continue;
    }

    addSpan(spans, "private_phone", start, end, 0.9);
  }
}

function addDateSpans(spans, text) {
  const dateRegexes = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi
  ];

  for (const regex of dateRegexes) {
    addRegexSpans(spans, text, "private_date", regex, 0.82);
  }
}

function addAccountNumberSpans(spans, text) {
  const accountRegex = /(?<!\w)\d(?:[ -]?\d){7,}(?!\w)/g;
  for (const match of text.matchAll(accountRegex)) {
    const start = match.index;
    const end = start + match[0].length;
    const original = text.slice(start, end);
    const digits = original.replace(/\D/g, "");

    if (digits.length < 8 || looksLikeCommonDate(original) || looksLikeFormattedPhone(original)) {
      continue;
    }

    addSpan(spans, "account_number", start, end, 0.88);
  }
}

function addKeyValueSecretSpans(spans, text) {
  const keyValueRegex = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret)\b\s*[:=]\s*(['"]?)([A-Za-z0-9._~+/=-]{6,})\1/gi;

  for (const match of text.matchAll(keyValueRegex)) {
    const fullMatch = match[0];
    const value = match[2];
    const valueOffset = fullMatch.lastIndexOf(value);
    const start = match.index + valueOffset;
    const trimmed = trimTrailingPunctuation(text, start, start + value.length);
    addSpan(spans, "secret", trimmed.start, trimmed.end, 0.97);
  }
}

function addSpan(spans, label, start, end, score) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    return;
  }

  spans.push({
    label,
    start,
    end,
    score,
    source: "regex"
  });
}

function countSources(entities) {
  const sources = {};
  for (const entity of entities) {
    const source = entity.source || "unknown";
    sources[source] = (sources[source] ?? 0) + 1;
  }

  return sources;
}

function trimTrailingPunctuation(text, start, end) {
  let trimmedEnd = end;
  while (trimmedEnd > start && /[.,;:!?]/.test(text[trimmedEnd - 1])) {
    trimmedEnd -= 1;
  }

  return { start, end: trimmedEnd };
}

function isWordAdjacent(text, start, end) {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return /[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after);
}

function countDigits(value) {
  return (value.match(/\d/g) ?? []).length;
}

function looksLikeCommonDate(value) {
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);
}

function looksLikeFormattedPhone(value) {
  return /^\+?\d?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(value.trim());
}
