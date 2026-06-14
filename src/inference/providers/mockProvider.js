export async function inferMockSpans(text, options = {}) {
  void options;
  const sourceText = String(text ?? "");
  const spans = [];

  addRegexSpans(spans, sourceText, "private_person", /\b(?:John Doe|Jane Smith|Alice Smith|Harry Potter)\b/g, 0.92);
  addRegexSpans(spans, sourceText, "private_address", /\b\d{1,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane)\b/g, 0.88);

  return spans;
}

function addRegexSpans(spans, text, label, regex, score) {
  for (const match of text.matchAll(regex)) {
    spans.push({
      label,
      start: match.index,
      end: match.index + match[0].length,
      score,
      source: "mock"
    });
  }
}
