# Local Masker Privacy Policy

Effective date: June 14, 2026

Local Masker is a local-first browser extension that helps users mask sensitive details before inserting prompts into supported AI websites.

## Summary

Local Masker processes prompt text locally in the browser extension. The extension does not include a developer-operated backend, analytics, telemetry, advertising, or tracking.

## Data Processed By The Extension

Local Masker may process the following data inside the browser:

- Prompt text that the user types into the Local Masker composer.
- Masked prompt text generated from that input.
- Detected sensitivity categories and counts, such as email, secret, account number, name, or address.
- The supported website hostname where the composer is opened.
- Non-sensitive setup timestamps for the optional local Privacy Filter model.

## How Data Is Used

The extension uses prompt text only to detect and replace sensitive details before insertion into the active AI prompt field.

Prompt text, masked text, detected entities, entity originals, and placeholder vault data are not stored in persistent browser storage by the extension. Placeholder mappings are kept in memory for the active page session.

## Data Sharing

Local Masker does not send prompt text, masked text, detected entities, or placeholder mappings to a developer-controlled server.

If the optional Privacy Filter model is enabled, the browser may download model files from Hugging Face so inference can run locally. Prompt text is not sent to Hugging Face by Local Masker for inference.

When the user clicks **Mask & Insert**, the extension inserts the masked prompt into the active AI website prompt field. The user remains responsible for reviewing and sending the prompt on that website.

## Storage

Local Masker uses browser extension storage only for non-sensitive operational state:

- `chrome.storage.session` may store non-sensitive session route metadata.
- `chrome.storage.local` may store Privacy Filter setup timestamps, such as when setup was approved or completed.

The extension does not store raw prompt text, masked prompt text, original sensitive values, placeholder vault data, runtime diagnostics containing user content, or analytics identifiers in persistent storage.

## Permissions

Local Masker requests only the permissions needed for its single purpose:

- `storage`: Stores non-sensitive setup and route metadata.
- `offscreen`: Runs local inference in an extension-owned offscreen document.
- Host access for supported AI websites: Injects the composer and inserts masked prompts.
- `https://huggingface.co/openai/privacy-filter/*`: Allows optional model file downloads for local Privacy Filter setup.

## Limited Use Disclosure

Local Masker's use of browser user data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used only to provide the extension's single purpose: locally masking sensitive prompt details before insertion into supported AI websites.

Local Masker does not sell user data, use user data for advertising, use user data for creditworthiness or lending, transfer user data to data brokers, or allow humans to read user prompt content except when the user explicitly chooses to share information outside the extension.

## Contact

For privacy questions, open an issue on the project repository:

https://github.com/Vishallgit/local-masker/issues
