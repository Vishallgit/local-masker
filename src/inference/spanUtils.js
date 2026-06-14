const LABEL_RISK = {
  secret: 800,
  account_number: 700,
  private_email: 600,
  private_phone: 500,
  private_address: 400,
  private_person: 300,
  private_url: 200,
  private_date: 100
};

const PLACEHOLDER_OPEN = "\u27E6";
const PLACEHOLDER_CLOSE = "\u27E7";
const VALID_LABELS = new Set(Object.keys(LABEL_RISK));

export function normalizeSpan(span, text) {
  if (!span || typeof span.label !== "string") {
    return null;
  }

  const sourceText = String(text ?? "");
  let start = Number(span.start);
  let end = Number(span.end);

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return null;
  }

  if (start < 0 || end > sourceText.length || end <= start) {
    return null;
  }

  while (start < end && /\s/.test(sourceText[start])) {
    start += 1;
  }

  while (end > start && /\s/.test(sourceText[end - 1])) {
    end -= 1;
  }

  if (end <= start) {
    return null;
  }

  const score = Number.isFinite(Number(span.score)) ? Number(span.score) : 1;
  const source = typeof span.source === "string" && span.source ? span.source : "unknown";

  return {
    label: span.label,
    start,
    end,
    score,
    source
  };
}

export function normalizeSpans(spans, text) {
  if (!Array.isArray(spans)) {
    return [];
  }

  return spans
    .map((span) => normalizeSpan(span, text))
    .filter(Boolean);
}

export function mergeAndDedupeSpans(spans, options = {}) {
  const text = typeof options.text === "string" ? options.text : null;
  const normalized = text === null ? [...(spans ?? [])] : normalizeSpans(spans, text);
  const sorted = normalized
    .filter((span) => span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start)
    .sort((a, b) => {
      const riskDifference = getRiskScore(b.label) - getRiskScore(a.label);
      if (riskDifference !== 0) {
        return riskDifference;
      }

      const scoreDifference = b.score - a.score;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      const lengthDifference = (b.end - b.start) - (a.end - a.start);
      if (lengthDifference !== 0) {
        return lengthDifference;
      }

      if (a.start !== b.start) {
        return a.start - b.start;
      }

      return a.label.localeCompare(b.label);
    });

  const selected = [];
  for (const span of sorted) {
    if (selected.some((existing) => spansOverlap(existing, span))) {
      continue;
    }

    selected.push({ ...span });
  }

  return selected.sort((a, b) => a.start - b.start || a.end - b.end || a.label.localeCompare(b.label));
}

export function spansToEntities(text, spans, options = {}) {
  const sourceText = String(text ?? "");
  const startIndex = Number.isInteger(options.startIndex) && options.startIndex > 0
    ? options.startIndex
    : 1;
  const shortSession = getShortSession(options.sessionId);

  return mergeAndDedupeSpans(spans, { text: sourceText }).map((span, index) => ({
    label: span.label,
    original: sourceText.slice(span.start, span.end),
    placeholder: makePlaceholder(span.label, shortSession, startIndex + index),
    start: span.start,
    end: span.end,
    source: span.source
  }));
}

export function countEntities(entities) {
  const counts = {};
  for (const entity of entities ?? []) {
    if (!entity?.label) {
      continue;
    }

    counts[entity.label] = (counts[entity.label] ?? 0) + 1;
  }

  return counts;
}

export function normalizePrivacyFilterOutput(output, text, options = {}) {
  const sourceText = String(text ?? "");
  const source = typeof options.source === "string" && options.source
    ? options.source
    : "privacy-filter";
  const items = Array.isArray(output) ? output : [output].filter(Boolean);
  const spans = [];
  let searchFrom = 0;

  for (const item of items) {
    const label = normalizePrivacyLabel(
      item?.entity_group ?? item?.entityGroup ?? item?.entity ?? item?.label ?? item?.type
    );
    if (!label) {
      continue;
    }

    let start = toInteger(item?.start);
    let end = toInteger(item?.end);

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      const detectedWord = sanitizeDetectedWord(item?.word ?? item?.text ?? item?.value ?? "");
      const resolved = resolveDetectedTextOffset(sourceText, detectedWord, searchFrom);
      if (!resolved) {
        continue;
      }

      start = resolved.start;
      end = resolved.end;
    }

    const span = normalizeSpan({
      label,
      start,
      end,
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : 1,
      source
    }, sourceText);

    if (!span) {
      continue;
    }

    spans.push(span);
    searchFrom = Math.max(searchFrom, span.end);
  }

  return spans;
}

export function resolveDetectedTextOffset(text, detectedWord, startFrom = 0) {
  const sourceText = String(text ?? "");
  const needle = sanitizeDetectedWord(detectedWord);
  if (!needle) {
    return null;
  }

  const boundedStart = Math.max(0, Math.min(sourceText.length, Number(startFrom) || 0));
  const start = sourceText.indexOf(needle, boundedStart);

  if (start < 0) {
    return null;
  }

  return {
    start,
    end: start + needle.length
  };
}

function spansOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function getRiskScore(label) {
  return LABEL_RISK[label] ?? 0;
}

function normalizePrivacyLabel(label) {
  if (typeof label !== "string") {
    return "";
  }

  const normalized = label
    .replace(/^[BI]-/i, "")
    .replace(/^LABEL_/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized || normalized === "o" || normalized === "0" || normalized === "background" || normalized === "outside" || normalized === "none") {
    return "";
  }

  const direct = normalized.replace(/^private_/, "");
  const mapped = {
    account: "account_number",
    account_number: "account_number",
    bank_account: "account_number",
    card: "account_number",
    credit_card: "account_number",
    credit_card_number: "account_number",
    iban: "account_number",
    ssn: "account_number",
    social_security_number: "account_number",

    address: "private_address",
    location: "private_address",
    street_address: "private_address",

    email: "private_email",
    email_address: "private_email",

    full_name: "private_person",
    name: "private_person",
    per: "private_person",
    person: "private_person",

    mobile: "private_phone",
    phone: "private_phone",
    phone_number: "private_phone",
    telephone: "private_phone",

    link: "private_url",
    uri: "private_url",
    url: "private_url",
    website: "private_url",

    birth_date: "private_date",
    date: "private_date",
    dob: "private_date",

    api_key: "secret",
    access_token: "secret",
    auth_token: "secret",
    credential: "secret",
    password: "secret",
    secret: "secret",
    token: "secret"
  }[direct] || (VALID_LABELS.has(normalized) ? normalized : "");

  return VALID_LABELS.has(mapped) ? mapped : "";
}

function sanitizeDetectedWord(value) {
  return String(value ?? "")
    .replace(/(^|[\s])##/g, "$1")
    .replace(/[Ġ▁]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function makePlaceholder(label, shortSession, index) {
  const ordinal = String(index).padStart(3, "0");
  return `${PLACEHOLDER_OPEN}LM_${label.toUpperCase()}_${shortSession}_${ordinal}${PLACEHOLDER_CLOSE}`;
}

function getShortSession(sessionId) {
  const cleaned = String(sessionId ?? "LOCAL")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

  return (cleaned || "LOCAL").slice(0, 8).padEnd(8, "0");
}
