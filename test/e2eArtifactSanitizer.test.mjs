import assert from "node:assert/strict";
import {
  createBasePrivacyFilterE2eReport,
  hasForbiddenArtifactKey,
  sanitizeE2eArtifact
} from "../scripts/e2eArtifactSanitizer.mjs";

const privacyDummy = "Harry Potter emailed harry.potter@hogwarts.edu from 123 Main St using key sk-abc123456789.";
const regexDummy = "Email john@example.com and use key sk-abc123456789. Account 1234-5678-9012.";
const maskedDummy = "\u27E6LM_PRIVATE_EMAIL_TESTSESS_001\u27E7 \u27E6LM_SECRET_TESTSESS_002\u27E7";

{
  const sanitized = sanitizeE2eArtifact({
    ok: true,
    nested: {
      text: privacyDummy,
      prompt: regexDummy,
      value: "editor value",
      innerText: "inner",
      textContent: "content",
      maskedText: maskedDummy,
      original: "secret",
      originals: ["secret"],
      entities: [{ original: "secret" }],
      vault: { a: "b" },
      editor: "editor",
      pageContent: "page",
      safeStatus: "PASS"
    }
  });

  assert.equal(hasForbiddenArtifactKey(sanitized), false);
  assert.deepEqual(sanitized, {
    ok: true,
    nested: {
      safeStatus: "PASS"
    }
  });
}

{
  const sanitized = sanitizeE2eArtifact({
    status: "FAIL",
    error: {
      category: "model-data-fetch-blocked",
      message: "x".repeat(900)
    }
  }, {
    maxStringLength: 120
  });

  assert.equal(sanitized.status, "FAIL");
  assert.equal(sanitized.error.category, "model-data-fetch-blocked");
  assert.ok(sanitized.error.message.length <= 123);
  assert.ok(sanitized.error.message.endsWith("..."));
}

{
  const report = createBasePrivacyFilterE2eReport({
    outcome: "partial",
    steps: {
      browserFound: true,
      extensionLoaded: true,
      privacyFilterLoad: "FAIL"
    },
    diagnostics: {
      error: `Model failed while handling ${privacyDummy}`,
      labels: {
        private_email: 1,
        secret: 1
      },
      rendered: maskedDummy
    }
  });

  const serialized = JSON.stringify(report);
  assert.equal(hasForbiddenArtifactKey(report), false);
  assert.equal(serialized.includes("Harry Potter"), false);
  assert.equal(serialized.includes("harry.potter@hogwarts.edu"), false);
  assert.equal(serialized.includes("john@example.com"), false);
  assert.equal(serialized.includes("sk-abc123456789"), false);
  assert.equal(serialized.includes("1234-5678-9012"), false);
  assert.equal(serialized.includes("\u27E6LM_"), false);
  assert.equal(report.outcome, "partial");
  assert.equal(report.steps.privacyFilterLoad, "FAIL");
  assert.equal(report.diagnostics.labels.private_email, 1);
}

console.log("e2eArtifactSanitizer tests passed");
