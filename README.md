# Local Masker

Local Masker is a Chrome Manifest V3 extension for proving a local-first prompt masking flow on supported AI websites.

## Current Status

Stage 5.10 is implemented. The extension has a production release package path, smart automatic masking, a real OpenAI Privacy Filter provider scaffold using `@huggingface/transformers`, first-time model setup consent, safe runtime diagnostics, WebGPU adapter probes, a Privacy Filter smoke test, and local-fixture E2E diagnostics. The Transformers.js runtime is bundled locally with the ONNX Runtime WebGPU browser entry resolved at build time. Quick regex masking is instant, Privacy Filter setup is opt-in on first real-site use, and regex masking remains the safe fallback.

## What Works

- Injects a floating **Local Masker** button on supported pages.
- Opens an extension-owned iframe composer.
- Shows one visible **Smart masking** flow instead of a provider picker.
- Uses quick regex masking automatically for obvious patterns such as emails, keys, URLs, dates, phones, and account numbers.
- Uses Privacy Filter automatically when the prompt appears to contain semantic private details such as names, addresses, or private customer/client context.
- Asks the user on first real-site composer open before Privacy Filter setup because model data must download from Hugging Face and setup can take a few minutes, sometimes up to 10 minutes or longer on slow networks.
- Shows safe runtime diagnostics for offscreen, WebGPU, CSP, local runtime assets, provider state, and sanitized errors.
- Runs a Privacy Filter smoke test that uses a fixed non-user string and returns only counts, labels, timing, and status.
- Requests local inference through an extension-owned offscreen document.
- Combines provider spans with deterministic regex detections.
- Falls back to regex-only masking if provider inference fails.
- Runs a localhost-only integration self-test using the mock provider.
- Inserts only masked text into the host page prompt editor.
- Keeps the placeholder vault in content-script memory, keyed by `sessionId`.
- Stores only non-sensitive route metadata in `chrome.storage.session` and Privacy Filter setup timestamps in `chrome.storage.local`.

## Intentionally Not Implemented Yet

- No response placeholder rehydration.
- No automatic prompt submission.
- No backend.
- No telemetry or analytics.
- No CDN scripts or remote executable code.
- No bundled model weights yet.
- No generic prompt-content verification APIs.

## Build Required

Stage 5 adds a build step for the offscreen inference runtime:

```bash
npm install
npm run build
```

The build creates:

- `dist/offscreen/offscreen.bundle.js`
- `dist/vendor/transformers/transformers.web.js`
- `dist/vendor/onnxruntime-web/*`
- `dist/build-manifest.json`

Executable JS/WASM runtime assets are copied locally into `dist`. Model weights are not copied. If Smart masking asks for and receives user approval, Privacy Filter model files may download from Hugging Face as model data.

## Verify

```bash
npm test
npm run build
npm run inspect:runtime
npm run check:offscreen-bundle
npm run e2e:webgpu
npm run audit:remote-code
npm run smoke:extension
npm run build:release
npm run verify
```

`npm run verify` runs tests, build, remote-code audit, the offscreen/runtime bundle check, the extension smoke-load script, and production release packaging.

The audit allows `wasm-unsafe-eval` in `manifest.json` for local WASM execution. It does not allow remote script imports or `unsafe-eval`. The ONNX Runtime local WASM glue may contain eval-like compatibility code; the project keeps `unsafe-eval` disabled and uses runtime diagnostics to determine whether the executed path is compatible in MV3.

## Load Unpacked In Chrome

1. Run `npm install`.
2. Run `npm run build`.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select this project folder.

Supported real sites:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`

Local fixture-only matches:

- `http://localhost/*`
- `http://127.0.0.1/*`

The localhost and 127.0.0.1 matches are included only for local fixture testing in the development manifest. `npm run build:release` strips them from the generated production manifest.

## Release Package

Build the store upload package with:

```bash
npm run build:release
```

The command writes:

- `release/local-masker/`
- `release/local-masker.zip`

The release manifest is generated from `manifest.json` and validated before zipping. It removes localhost and 127.0.0.1 content-script matches, removes dev self-test web-accessible resources, keeps only the supported real AI-site matches, keeps `unsafe-eval` disabled, keeps `wasm-unsafe-eval` for local WASM execution, and omits `src/dev` from the release folder.

Chrome Web Store submission still requires account/listing work outside this repository: store description, screenshots, category, support/contact details, privacy disclosures, and any reviewer notes about local WASM/model-data downloads.

## If the Local Masker button does not appear

Check these first:

1. Confirm `npm run build` was run.
2. Confirm the unpacked extension folder is the project root, not `dist`.
3. Confirm the **Local Masker** extension card appears in `chrome://extensions`.
4. Confirm **Developer mode** is on.
5. Confirm there are no manifest, service worker, or CSP errors on the extension card.
6. Refresh the fixture tab after loading or reloading the extension.
7. Confirm the fixture URL is `http://127.0.0.1:8787/dev/prompt-fixture.html` or `http://localhost:8787/dev/prompt-fixture.html`.

Then run:

```bash
npm run diagnose:extension
npm run e2e:fixture
```

`npm run diagnose:extension` checks manifest paths, local match patterns, composer resources, and build outputs. `npm run e2e:fixture` launches Chrome with the unpacked extension from the project root, opens the local fixture, checks for the injected button/composer iframe, and writes a screenshot to `artifacts/local-fixture-extension-e2e.png`.

Some managed Chrome builds block command-line extension loading flags such as `--load-extension` or `--disable-extensions-except`. If the E2E script reports that limitation, either load the extension manually through `chrome://extensions` or rerun the script with a Chromium-based browser that allows unpacked extension flags:

```powershell
$env:LM_E2E_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run e2e:fixture
Remove-Item Env:LM_E2E_BROWSER
```

## Stage 5.6 Privacy Filter Runtime E2E

Stage 5.6 adds an automated localhost fixture diagnostic for the real Privacy Filter runtime path. It launches a Chromium browser with the unpacked extension, opens the local fixture, drives the actual composer UI, captures sanitized runtime diagnostics, attempts Privacy Filter model load, runs the Privacy Filter smoke test if loaded, and verifies either Privacy Filter insertion or regex-only fallback through localhost-only fixed-test verification.

Run it manually because it can be slow, network-dependent, GPU-dependent, and browser-policy-dependent:

```powershell
$env:LM_E2E_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run e2e:privacy-filter
Remove-Item Env:LM_E2E_BROWSER
```

Optional settings:

```powershell
$env:LM_E2E_PRIVACY_FILTER_TIMEOUT_MS = "1500000"
$env:LM_E2E_PORT = "8787"
```

Artifacts are written to:

- `artifacts/privacy-filter-runtime-diagnostics.json`
- `artifacts/privacy-filter-load-result.json`
- `artifacts/privacy-filter-smoke-result.json`
- `artifacts/privacy-filter-e2e-report.json`
- `artifacts/privacy-filter-fixture-e2e.png`

The JSON artifacts are sanitized. They must not contain raw prompt text, masked prompt text, editor text/value/textContent/innerText, entity originals, entities, vault data, or page content. The screenshot is captured after clearing fixed dummy input and preview surfaces.

`npm run e2e:privacy-filter` is intentionally not included in `npm run verify`.

## Stage 5.7 WebGPU Runtime Resolution

Stage 5.6 narrowed the real provider issue to ONNX Runtime WebGPU module resolution: the copied Transformers.js runtime still contained the bare browser import `onnxruntime-web/webgpu`, which an MV3 extension page cannot resolve at runtime.

Stage 5.7 fixes that by bundling `@huggingface/transformers/dist/transformers.web.js` through esbuild with browser ESM conditions and a local ONNX Runtime WebGPU export resolver. The build also copies the local ONNX WASM sidecar files used by the WebGPU/JSEP path and the WASM fallback path, then writes those files into `dist/build-manifest.json`.

Use these commands when debugging the Privacy Filter runtime:

```bash
npm run inspect:runtime
npm run check:offscreen-bundle
npm run e2e:privacy-filter
```

If `npm run e2e:privacy-filter` still fails, the failure should now be a later runtime issue such as CSP/WASM/model fetch/WebGPU/model load timeout, not unresolved `onnxruntime-web/webgpu`. Paste only sanitized artifact JSON when debugging.

## Stage 5.8 WebGPU Adapter Diagnostics

Stage 5.8 adds explicit WebGPU adapter diagnostics for the extension offscreen document and the content-script page context. The Privacy Filter module-resolution issue is fixed; the current failure class has moved beyond adapter acquisition. The latest default Edge probe can acquire an adapter and request a device in both contexts, while full model loading now reaches ONNX Runtime WebGPU initialization/model-load behavior.

Run the fast probe without loading the model:

```bash
npm run e2e:webgpu
```

Run the full Privacy Filter path:

```bash
npm run e2e:privacy-filter
```

The E2E scripts support test-only WebGPU launch experiments:

```powershell
$env:LM_E2E_WEBGPU_FLAGS = "unsafe-webgpu-ignore-blocklist"
npm run e2e:webgpu
Remove-Item Env:LM_E2E_WEBGPU_FLAGS
```

Supported `LM_E2E_WEBGPU_FLAGS` values are `none`, `unsafe-webgpu`, `unsafe-webgpu-ignore-blocklist`, `unsafe-webgpu-vulkan`, and `custom` with `LM_E2E_EXTRA_BROWSER_FLAGS`. These flags are for development E2E only and are never product behavior.

The composer also has a **WebGPU probe** button and **Copy WebGPU diagnostics** action. The copied JSON is sanitized and omits raw prompt/editor data and GPU hardware identifiers.

## Stage 5 Architecture

```text
Composer
  -> Background service worker
  -> Offscreen inference document
  -> Local provider runtime
  -> Background service worker
  -> Composer
  -> Background service worker
  -> Content script
  -> Host AI page
```

The real Privacy Filter path is opt-in. The model does not load on extension startup. Smart masking asks for setup approval on first real-site composer open, then loads the model automatically on later opens if setup was approved. The background routes to the offscreen document and stores no prompts, spans, entities, masked text, diagnostics, originals, or vault data.

## Privacy Filter Manual Test

1. Run `npm install`.
2. Run `npm run build`.
3. Run `npm test`.
4. Run `npm run smoke:extension`.
5. Start the local fixture server:

```bash
python3 -m http.server 8787
```

On Windows, `python -m http.server 8787` may be the available command.

6. Open `http://127.0.0.1:8787/dev/prompt-fixture.html`.
7. Load the extension unpacked.
8. Focus a fixture editor.
9. Click **Local Masker**.
10. Confirm **Run local self-test** still passes.
11. Enter a prompt with a name and street address.
12. Click **Mask & Insert**.
13. If loaded, confirm **Mask & Insert** uses stronger local masking.
14. If loading or inference fails, confirm quick regex masking still works.

First model load may be large and slow. WebGPU support varies by browser, OS, GPU, driver, and extension CSP behavior. Privacy Filter is an aid, not a compliance or anonymization guarantee.

## Stage 5.5 Runtime Diagnostics

Use this flow before real-site testing:

1. Run `npm install`.
2. Run `npm run build`.
3. Run `npm run verify`.
4. Start the local fixture server:

```bash
python3 -m http.server 8787
```

5. Open `http://127.0.0.1:8787/dev/prompt-fixture.html`.
6. Load the extension unpacked.
7. Focus a fixture editor.
8. Click **Local Masker**.
9. Click **Runtime diagnostics**.
10. Copy diagnostics if any error appears.
11. Click **Check inference status**.
12. Run **Run local self-test**.
13. Enter a semantic prompt with a name and street address.
14. Click **Mask & Insert**.
15. If loaded, click **Run Privacy Filter smoke test**.
16. Confirm the smoke test reports spans/counts without showing raw test text.
17. Try **Mask & Insert** again with the semantic prompt.
18. Confirm quick masking still works for a prompt containing only email/key/account patterns.

If a CSP, `new Function`, WASM, WebGPU, or model-data error appears, paste only the copied runtime diagnostics, not the raw prompt. Runtime diagnostics intentionally omit raw prompt text, masked prompt text, entity originals, editor text/value/textContent/innerText, and vault data.

The smoke test uses only a fixed non-user string inside the offscreen document. It does not insert anything into the host page, does not auto-load Privacy Filter by default, and does not return the fixed string or detected originals.

First model load may be large and slow. WebGPU support varies by browser/device. Real AI-site testing remains manual.

## Local Fixture Self-Test

Open:

```text
http://127.0.0.1:8787/dev/prompt-fixture.html
```

Then:

1. Focus the textarea or one contenteditable fixture.
2. Click **Local Masker**.
3. Click **Check inference status**.
4. Confirm the mock provider is loaded.
5. Click **Run local self-test**.
6. Confirm mock spans, regex detections, insertion, verification, absent raw values, and expected placeholders all pass.

The self-test only runs on `localhost` and `127.0.0.1`. It is not intended for real AI sites, and it does not return editor text or prompt contents.

## Real-Site Verification Matrix

| Site | URL | Checklist |
| --- | --- | --- |
| ChatGPT | `https://chatgpt.com/` | Floating button appears; composer opens; first real-site open asks for Smart masking setup if not approved; selected target looks correct; quick masking works for email/key/account; semantic prompt uses Privacy Filter when ready; Mask & Insert inserts only masked text; raw email/key/account are absent; Send is not auto-clicked. |
| Claude | `https://claude.ai/` | Floating button appears; composer opens; first real-site open asks for Smart masking setup if not approved; selected target looks correct; quick masking works for email/key/account; semantic prompt uses Privacy Filter when ready; Mask & Insert inserts only masked text; raw email/key/account are absent; Send is not auto-clicked. |
| Gemini | `https://gemini.google.com/` | Floating button appears; composer opens; first real-site open asks for Smart masking setup if not approved; selected target looks correct; quick masking works for email/key/account; semantic prompt uses Privacy Filter when ready; Mask & Insert inserts only masked text; raw email/key/account are absent; Send is not auto-clicked. |

These checks remain manual and site-specific because AI prompt editor DOMs change often.

## Privacy Model

Raw prompt text is allowed only in:

- the composer textarea while the user types
- composer JavaScript memory while masking
- transient extension runtime messages for local inference
- the offscreen document during local inference

Raw prompt text, masked prompt text, entity originals, entities, diagnostics, and vault data are not stored in `localStorage`, `sessionStorage`, `chrome.storage.local`, `chrome.storage.sync`, or `chrome.storage.session`.

`chrome.storage.local` may store only non-sensitive Privacy Filter setup timestamps, such as when the user approved setup and when setup completed.

The service worker stores only:

```text
sessionId -> { sessionNonce, tabId, frameId, createdAt }
```

The content script owns the sensitive placeholder vault in tab-scoped memory:

```text
sessionId -> placeholder -> { original, label, createdAt }
```

Diagnostics intentionally omit raw prompt text, masked prompt text, entity originals, vault data, existing editor value, textContent, innerText, placeholder, aria-label, title, and URL path/query.

## Store Submission Checklist

1. Run `npm run verify`.
2. Run `npm run e2e:webgpu`.
3. Run `npm run e2e:privacy-filter` when network/GPU conditions allow the full model path.
4. Manually verify ChatGPT, Claude, and Gemini using the matrix above.
5. Upload `release/local-masker.zip` to the Chrome Web Store draft.
6. Add the store listing, screenshots, support/contact details, privacy disclosures, and reviewer notes for local-only processing plus Hugging Face model-data downloads.
