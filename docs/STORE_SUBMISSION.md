# Chrome Web Store Submission Notes

This document contains the package, listing, privacy, and reviewer material needed for a Chrome Web Store draft.

## Upload Package

Build the upload package:

```bash
npm run verify
```

Upload:

```text
release/local-masker.zip
```

The release package includes production-only host matches, local runtime assets, and extension icons. It excludes localhost fixture access, development self-test resources, `node_modules`, screenshots, artifacts, and source-only test files.

## Required Store Assets

Prepared assets:

- Store icon: `docs/store-assets/store-icon-128.png`
- Small promo tile: `docs/store-assets/small-promo-440x280.png`
- Screenshot: `docs/store-assets/screenshot-main-1280x800.png`

Optional future assets:

- Additional 1280x800 screenshots captured on ChatGPT, Claude, and Gemini.
- A short YouTube demo video.
- A marquee promo tile if Chrome requests or recommends one for featuring.

## Single Purpose

Local Masker's single purpose is to locally mask sensitive details in user-written AI prompts before inserting the cleaned prompt into supported AI websites.

## Permission Justifications

### `storage`

Used only for non-sensitive operational state such as Privacy Filter setup timestamps and active session route metadata. Raw prompts, masked prompts, original sensitive values, and placeholder mappings are not stored in persistent extension storage.

### `offscreen`

Used to run local Privacy Filter inference in an extension-owned offscreen document. This keeps the inference runtime separate from host webpages and avoids sending prompt text to a developer backend.

### Supported AI Website Host Access

Used to inject the Local Masker composer and insert masked prompt text into the active AI prompt field on supported websites:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

### Hugging Face Host Access

Used only to download optional Privacy Filter model files from:

- `https://huggingface.co/openai/privacy-filter/*`

Prompt text is not sent to Hugging Face by the extension for inference.

## Data Handling Answers

Use these statements when filling the privacy tab:

- The extension processes user-provided prompt text locally.
- The extension does not collect or transmit prompt text to a developer-controlled server.
- The extension does not sell user data.
- The extension does not use user data for ads or analytics.
- The extension does not include telemetry.
- The extension inserts masked text only after the user clicks **Mask & Insert**.
- The extension does not automatically submit prompts to AI websites.
- Optional model files may be downloaded from Hugging Face; prompt inference runs locally in the browser extension.

## Reviewer Notes

Suggested reviewer note:

```text
Local Masker is a Manifest V3 extension for local-first AI prompt masking. It injects a composer on supported AI websites, masks sensitive values locally, and inserts only the masked prompt after user action. It does not automatically submit prompts.

The extension has no developer backend, analytics, telemetry, or ads. Regex masking is available immediately. If the user approves optional Privacy Filter setup, model files may download from Hugging Face and local inference runs in an extension-owned offscreen document.

The release package excludes localhost fixture matches and development self-test resources. The CSP keeps unsafe-eval disabled and uses wasm-unsafe-eval only for local WASM runtime support.
```

## Final Manual Dashboard Steps

1. Upload `release/local-masker.zip`.
2. Add the short and full descriptions from `docs/STORE_LISTING.md`.
3. Upload the prepared store assets from `docs/store-assets`.
4. Add the privacy policy URL: `https://github.com/Vishallgit/local-masker/blob/main/PRIVACY.md`.
5. Fill the privacy tab with the single purpose, data handling, and permission justifications above.
6. Add reviewer notes.
7. Submit for review.
