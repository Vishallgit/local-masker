# Store Listing Draft

This document collects public-facing copy and review notes for publishing Local Masker to browser extension stores.

## Product Name

Local Masker

## Short Description

Mask private details locally before inserting prompts into supported AI websites.

## Full Description

Local Masker is a privacy-first browser extension for AI prompt composition. It adds a secure local composer to supported AI websites so users can write prompts, mask sensitive details, and insert only the cleaned version into the AI input.

The extension detects common private values such as emails, API keys, account numbers, and other sensitive text. It can also use a local Privacy Filter model for stronger semantic detection of names, addresses, and customer details. Processing happens in the browser, with regex masking available instantly and local model setup requested only when needed.

Local Masker does not include a backend, telemetry, analytics, or automatic prompt submission.

## Key Features

- Local prompt masking before AI insertion
- Floating composer on ChatGPT, Claude, and Gemini
- Automatic smart masking mode
- Regex fallback for fast deterministic protection
- Optional local Privacy Filter model setup
- Masked preview before sending
- No backend service
- No analytics or telemetry

## Screenshot Candidates

Use these prepared store media files:

- `docs/store-assets/store-icon-128.png`
- `docs/store-assets/small-promo-440x280.png`
- `docs/store-assets/screenshot-main-1280x800.png`

Additional production screenshots on ChatGPT, Claude, and Gemini can be added later, but the prepared 1280x800 screenshot is suitable for the first draft submission.

## Privacy Disclosure Draft

Local Masker processes prompt text locally in the browser extension to detect and replace sensitive details before insertion into supported AI websites. The extension does not send prompt text to a backend controlled by the developer and does not include analytics or telemetry. If the optional Privacy Filter model is set up, model files may be downloaded from Hugging Face as model data for local inference.

Privacy policy URL:

```text
https://github.com/Vishallgit/local-masker/blob/main/PRIVACY.md
```

## Reviewer Notes

- The extension is Manifest V3.
- The release build strips localhost development matches.
- `wasm-unsafe-eval` is present for local WASM execution.
- `unsafe-eval` is not enabled.
- ONNX Runtime assets are bundled locally during build.
- Model weights are not bundled in the release package.
- The extension does not automatically submit prompts.

## Release Checklist

- Run `npm run verify`.
- Run `npm run build:release`.
- Confirm `release/local-masker.zip` is generated.
- Confirm release manifest excludes localhost and development fixtures.
- Confirm extension icons are present in the release package.
- Upload prepared store assets from `docs/store-assets`.
- Add the privacy policy URL.
- Upload `release/local-masker.zip`.
