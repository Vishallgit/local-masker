const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel"]);
const MAX_CANDIDATES = 30;

const COMMON_FALLBACK_STRATEGIES = [
  strategy("textarea", ["textarea"], 55),
  strategy("text-input", ["input[type='text']", "input[type='search']", "input:not([type])"], 52),
  strategy("contenteditable-div", ["div[contenteditable='true']", "div[contenteditable='plaintext-only']"], 50),
  strategy("role-textbox", ["[role='textbox']"], 49),
  strategy("prosemirror", [".ProseMirror[contenteditable='true']"], 48),
  strategy("slate-editor", ["[data-slate-editor='true']"], 47),
  strategy("lexical-editor", ["[data-lexical-editor='true']"], 46),
  strategy("bottom-contenteditable", ["[contenteditable='true']", "[contenteditable='plaintext-only']"], 40)
];

const ADAPTERS = [
  {
    name: "chatgpt",
    matches: (hostname) => hostname === "chatgpt.com" || hostname === "chat.openai.com",
    preferred: [
      strategy("chatgpt-testid-prompt-textarea", ["[data-testid='prompt-textarea']"], 100),
      strategy("chatgpt-prompt-textarea-id", ["#prompt-textarea"], 96),
      strategy("chatgpt-composer-textarea", ["textarea[data-testid='prompt-textarea']"], 94),
      strategy("chatgpt-role-textbox", ["div[role='textbox'][contenteditable='true']"], 90),
      strategy("chatgpt-prosemirror", [".ProseMirror[contenteditable='true']"], 86)
    ],
    fallback: COMMON_FALLBACK_STRATEGIES,
    score: defaultAdapterScore
  },
  {
    name: "claude",
    matches: (hostname) => hostname === "claude.ai",
    preferred: [
      strategy("claude-chat-input-testid", ["[data-testid='chat-input']", "[data-testid='chat-input-textbox']"], 100),
      strategy("claude-prosemirror", [".ProseMirror[contenteditable='true']"], 96),
      strategy("claude-contenteditable-textbox", ["div[contenteditable='true'][role='textbox']"], 92),
      strategy("claude-aria-prompt", ["[contenteditable='true'][aria-label*='prompt' i]", "[contenteditable='true'][aria-label*='message' i]"], 88)
    ],
    fallback: COMMON_FALLBACK_STRATEGIES,
    score: defaultAdapterScore
  },
  {
    name: "gemini",
    matches: (hostname) => hostname === "gemini.google.com",
    preferred: [
      strategy("gemini-rich-textarea", ["rich-textarea textarea", "rich-textarea [contenteditable='true']"], 100),
      strategy("gemini-prompt-textarea", ["textarea[aria-label*='prompt' i]", "textarea[aria-label*='message' i]"], 94),
      strategy("gemini-contenteditable", ["div[contenteditable='true'][role='textbox']", "div[contenteditable='true']"], 88),
      strategy("gemini-lexical", ["[data-lexical-editor='true']"], 84)
    ],
    fallback: COMMON_FALLBACK_STRATEGIES,
    score: defaultAdapterScore
  },
  {
    name: "local-fixture",
    matches: (hostname) => hostname === "localhost" || hostname === "127.0.0.1",
    preferred: [
      strategy("fixture-textarea", ["#fixture-textarea"], 100),
      strategy("fixture-input", ["#fixture-input"], 98),
      strategy("fixture-contenteditable", ["#fixture-contenteditable"], 96),
      strategy("fixture-role-textbox", ["#fixture-role-textbox"], 95),
      strategy("fixture-prosemirror", ["#fixture-prosemirror"], 94),
      strategy("fixture-slate", ["#fixture-slate"], 93),
      strategy("fixture-lexical", ["#fixture-lexical"], 92),
      strategy("fixture-invalid-cases", ["#fixture-hidden-textarea", "#fixture-disabled-textarea", "#fixture-readonly-input", "#fixture-offscreen-editor"], 20),
      strategy("fixture-bottom-editor", ["#fixture-bottom-editor"], 88)
    ],
    fallback: COMMON_FALLBACK_STRATEGIES,
    score: defaultAdapterScore
  }
];

const GENERIC_ADAPTER = {
  name: "generic",
  matches: () => true,
  preferred: [
    strategy("generic-active-textarea", ["textarea"], 60),
    strategy("generic-active-contenteditable", ["[contenteditable='true']", "[contenteditable='plaintext-only']"], 58)
  ],
  fallback: COMMON_FALLBACK_STRATEGIES,
  score: defaultAdapterScore
};

export function getSiteAdapter(hostname = "") {
  const normalized = String(hostname).toLowerCase();
  return ADAPTERS.find((adapter) => adapter.matches(normalized)) ?? GENERIC_ADAPTER;
}

export function findPromptTarget(doc, options = {}) {
  const diagnosis = collectPromptCandidates(doc, options);
  const selected = diagnosis.selected;

  return {
    ok: Boolean(selected?.element),
    adapterName: diagnosis.adapter.name,
    target: selected?.element ?? null,
    targetKind: selected?.metadata.targetKind ?? "",
    targetDescription: selected?.metadata.safeSelectorHint ?? "",
    method: selected ? "adapter-target-selection" : "",
    strategy: selected?.metadata.strategy ?? "",
    candidates: diagnosis.candidates.map((candidate) => candidate.metadata),
    error: selected ? undefined : "No suitable prompt editor target found."
  };
}

export function diagnosePromptTargets(doc, options = {}) {
  const diagnosis = collectPromptCandidates(doc, options);

  return {
    ok: Boolean(diagnosis.selected),
    adapterName: diagnosis.adapter.name,
    hostname: safeHostname(doc),
    origin: safeOrigin(doc),
    selectedTarget: diagnosis.selected?.metadata ?? null,
    candidates: diagnosis.candidates.map((candidate) => candidate.metadata),
    error: diagnosis.selected ? undefined : "No suitable prompt editor target found."
  };
}

export function scoreCandidateMetadata(metadata, baseScore = 0, options = {}) {
  let score = Number(baseScore) || 0;

  if (metadata.isActive) {
    score += 1000;
  }

  if (metadata.isLastFocused) {
    score += 800;
  }

  if (metadata.visible) {
    score += 25;
  } else {
    score -= 400;
  }

  if (metadata.disabled || metadata.readOnly || metadata.ariaHidden) {
    score -= 500;
  }

  if (metadata.targetKind === "textarea") {
    score += 15;
  } else if (metadata.targetKind === "input") {
    score += 10;
  } else if (metadata.targetKind) {
    score += 12;
  }

  if (metadata.viewportPosition === "visible") {
    score += 18;
  } else if (metadata.viewportPosition === "below") {
    score += 8;
  } else {
    score -= 25;
  }

  const pageBottomRatio = Number.isFinite(metadata.pageBottomRatio)
    ? metadata.pageBottomRatio
    : 0;
  score += Math.round(Math.max(0, Math.min(1, pageBottomRatio)) * 22);

  if (metadata.safeSelectorHint?.includes("local-masker")) {
    score -= 1000;
  }

  if (options.adapterName === "local-fixture" && metadata.safeSelectorHint?.includes("fixture-bottom-editor")) {
    score += 80;
  }

  return Math.round(score);
}

export function sanitizeIdentifierToken(value, maxLength = 48) {
  const token = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
    return "";
  }

  return token.slice(0, maxLength);
}

export function getSafeSelectorHint(element) {
  if (!isElement(element)) {
    return "";
  }

  const tagName = element.tagName.toLowerCase();
  const parts = [tagName];
  const safeId = sanitizeIdentifierToken(element.id, 48);

  if (safeId) {
    parts.push(`#${safeId}`);
  }

  const safeClasses = [...(element.classList ?? [])]
    .map((className) => sanitizeIdentifierToken(className, 32))
    .filter(Boolean)
    .slice(0, 2);

  for (const className of safeClasses) {
    parts.push(`.${className}`);
  }

  if (element.getAttribute("role") === "textbox") {
    parts.push("[role=textbox]");
  }

  if (element.matches?.("[contenteditable='true'],[contenteditable='plaintext-only']")) {
    parts.push("[contenteditable]");
  }

  if (element.matches?.("[data-slate-editor='true']")) {
    parts.push("[data-slate-editor]");
  }

  if (element.matches?.("[data-lexical-editor='true']")) {
    parts.push("[data-lexical-editor]");
  }

  return parts.join("");
}

function collectPromptCandidates(doc, options) {
  const adapter = getSiteAdapter(options.hostname ?? safeHostname(doc));
  const activeElement = closestPromptElement(options.activeElement ?? getDeepActiveElement(doc), doc);
  const lastFocusedElement = closestPromptElement(options.lastFocusedElement, doc);
  const seen = new Map();

  addElementCandidate(seen, activeElement, {
    adapter,
    strategyName: activeElement && isTextInput(activeElement) ? "active-text-input" : "active-editor",
    baseScore: 125,
    doc,
    options,
    isActive: true
  });

  addElementCandidate(seen, lastFocusedElement, {
    adapter,
    strategyName: "last-focused-editor",
    baseScore: 115,
    doc,
    options,
    isLastFocused: true
  });

  for (const currentStrategy of [...adapter.preferred, ...adapter.fallback]) {
    for (const element of queryStrategy(doc, currentStrategy)) {
      addElementCandidate(seen, closestPromptElement(element, doc), {
        adapter,
        strategyName: currentStrategy.name,
        baseScore: currentStrategy.baseScore,
        doc,
        options
      });
    }
  }

  const candidates = [...seen.values()]
    .sort((a, b) => b.metadata.score - a.metadata.score)
    .slice(0, options.maxCandidates ?? MAX_CANDIDATES);

  const selected = candidates.find((candidate) => candidate.selectable) ?? null;
  return { adapter, candidates, selected };
}

function addElementCandidate(seen, element, context) {
  if (!isElement(element) || element.ownerDocument !== context.doc) {
    return;
  }

  const metadata = describeCandidate(element, context);
  const selectable = isSelectablePrompt(element, metadata, context.options);
  const existing = seen.get(element);

  if (!existing || metadata.score > existing.metadata.score) {
    seen.set(element, {
      element,
      metadata,
      selectable
    });
  }
}

function describeCandidate(element, context) {
  const rect = getRect(element);
  const viewport = getViewport(element.ownerDocument);
  const tagName = element.tagName.toUpperCase();
  const contentEditable = getContentEditableState(element);
  const metadata = {
    strategy: context.strategyName,
    adapterName: context.adapter.name,
    tagName,
    role: getSafeRole(element),
    contentEditable,
    inputType: getInputType(element),
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
    ariaHidden: hasAriaHiddenAncestor(element),
    visible: isVisiblyUsable(element),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    bottomDistance: Math.round(viewport.height - rect.bottom),
    viewportPosition: getViewportPosition(rect, viewport),
    pageBottomRatio: getPageBottomRatio(rect, element.ownerDocument),
    targetKind: getTargetKind(element),
    safeSelectorHint: getSafeSelectorHint(element),
    isActive: Boolean(context.isActive),
    isLastFocused: Boolean(context.isLastFocused)
  };

  metadata.score = context.adapter.score(metadata, context.baseScore, { adapterName: context.adapter.name });
  delete metadata.pageBottomRatio;
  delete metadata.isActive;
  delete metadata.isLastFocused;
  return metadata;
}

function defaultAdapterScore(metadata, baseScore, options) {
  return scoreCandidateMetadata(metadata, baseScore, options);
}

function strategy(name, selectors, baseScore) {
  return { name, selectors, baseScore };
}

function queryStrategy(doc, currentStrategy) {
  const elements = [];

  for (const selector of currentStrategy.selectors) {
    try {
      elements.push(...doc.querySelectorAll(selector));
    } catch {
      // Invalid selectors are ignored; adapters can be tuned independently.
    }
  }

  return elements;
}

function closestPromptElement(element, doc) {
  if (!isElement(element) || element.ownerDocument !== doc) {
    return null;
  }

  if (isPromptLike(element)) {
    return element;
  }

  return element.closest?.(
    "textarea,input,[contenteditable='true'],[contenteditable='plaintext-only'],[role='textbox'],.ProseMirror,[data-slate-editor='true'],[data-lexical-editor='true']"
  ) ?? null;
}

function isSelectablePrompt(element, metadata, options) {
  return (
    isPromptLike(element) &&
    metadata.visible &&
    !metadata.disabled &&
    !metadata.readOnly &&
    !metadata.ariaHidden &&
    !isInsideExcludedRoot(element, options.excludedRootId)
  );
}

function isPromptLike(element) {
  return isTextInput(element) || isEditable(element);
}

function isTextInput(element) {
  if (!isElement(element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }

  if (tagName !== "input") {
    return false;
  }

  return TEXT_INPUT_TYPES.has(getInputType(element) || "text");
}

function isEditable(element) {
  if (!isElement(element)) {
    return false;
  }

  return (
    element.isContentEditable ||
    ["true", "plaintext-only"].includes(element.getAttribute("contenteditable")) ||
    element.getAttribute("role") === "textbox" ||
    element.matches?.(".ProseMirror[contenteditable='true'],[data-slate-editor='true'],[data-lexical-editor='true']")
  );
}

function getTargetKind(element) {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea") {
    return "textarea";
  }

  if (tagName === "input") {
    return "input";
  }

  if (element.matches?.("[data-slate-editor='true']")) {
    return "slate";
  }

  if (element.matches?.("[data-lexical-editor='true']")) {
    return "lexical";
  }

  if (element.classList?.contains("ProseMirror")) {
    return "prosemirror";
  }

  if (element.getAttribute("role") === "textbox") {
    return "role_textbox";
  }

  return "contenteditable";
}

function getInputType(element) {
  if (!isElement(element) || element.tagName.toLowerCase() !== "input") {
    return null;
  }

  const inputType = (element.getAttribute("type") || "text").toLowerCase();
  return sanitizeIdentifierToken(inputType, 24) || null;
}

function getSafeRole(element) {
  const role = element.getAttribute("role");
  return role ? sanitizeIdentifierToken(role, 32) || "custom" : null;
}

function getContentEditableState(element) {
  const value = element.getAttribute("contenteditable");
  if (value === "true" || value === "false" || value === "plaintext-only") {
    return value;
  }

  return element.isContentEditable ? "true" : "inherit";
}

function getDeepActiveElement(doc) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function isInsideExcludedRoot(element, excludedRootId) {
  if (!excludedRootId) {
    return false;
  }

  const root = element.ownerDocument.getElementById(excludedRootId);
  return Boolean(root && (element === root || root.contains(element)));
}

function isVisiblyUsable(element) {
  if (!element?.isConnected) {
    return false;
  }

  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
    return false;
  }

  const rect = getRect(element);
  const viewport = getViewport(element.ownerDocument);
  const horizontallyReachable = rect.right > 0 && rect.left < viewport.width;
  return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0 && horizontallyReachable;
}

function hasAriaHiddenAncestor(element) {
  let current = element;
  while (current && current !== element.ownerDocument.documentElement) {
    if (current.getAttribute?.("aria-hidden") === "true") {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function getViewportPosition(rect, viewport) {
  if (rect.right <= 0 || rect.left >= viewport.width) {
    return "offscreen";
  }

  if (rect.bottom < 0) {
    return "above";
  }

  if (rect.top > viewport.height) {
    return "below";
  }

  return "visible";
}

function getPageBottomRatio(rect, doc) {
  const viewport = getViewport(doc);
  const pageHeight = Math.max(
    doc.documentElement?.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0,
    viewport.height
  );
  const pageBottom = rect.bottom + (doc.defaultView?.scrollY ?? 0);
  return pageHeight > 0 ? pageBottom / pageHeight : 0;
}

function getRect(element) {
  return element.getBoundingClientRect();
}

function getViewport(doc) {
  const win = doc.defaultView;
  return {
    width: win?.innerWidth ?? doc.documentElement?.clientWidth ?? 0,
    height: win?.innerHeight ?? doc.documentElement?.clientHeight ?? 0
  };
}

function safeHostname(doc) {
  return doc?.location?.hostname ? String(doc.location.hostname).toLowerCase() : "";
}

function safeOrigin(doc) {
  return doc?.location?.origin ?? "";
}

function isElement(value) {
  return Boolean(globalThis.Element && value instanceof Element);
}
