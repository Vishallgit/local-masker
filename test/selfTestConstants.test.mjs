import assert from "node:assert/strict";
import {
  SELF_TEST_FORBIDDEN_VALUES,
  SELF_TEST_PLACEHOLDER_PREFIXES,
  SELF_TEST_PROMPT,
  hasUnsafeSelfTestReportKey,
  isLocalSelfTestHostname,
  sanitizeSelfTestReport,
  validateSelfTestMaskedOutput,
  verifyKnownSelfTestEditorState
} from "../src/dev/selfTestConstants.js";

{
  assert.ok(SELF_TEST_PROMPT.includes("John Doe"));
  assert.ok(SELF_TEST_PROMPT.includes("john@example.com"));
  assert.ok(SELF_TEST_FORBIDDEN_VALUES.some((item) => item.value === "123 Main St"));
  assert.ok(SELF_TEST_PLACEHOLDER_PREFIXES.some((item) => item.value === "LM_PRIVATE_PERSON"));
}

{
  assert.equal(isLocalSelfTestHostname("localhost"), true);
  assert.equal(isLocalSelfTestHostname("127.0.0.1"), true);
  assert.equal(isLocalSelfTestHostname("chatgpt.com"), false);
}

{
  const report = verifyKnownSelfTestEditorState(
    "⟦LM_PRIVATE_PERSON_TEST_001⟧ ⟦LM_PRIVATE_ADDRESS_TEST_002⟧ ⟦LM_PRIVATE_EMAIL_TEST_003⟧ ⟦LM_SECRET_TEST_004⟧ ⟦LM_ACCOUNT_NUMBER_TEST_005⟧",
    {
      isLocalFixture: true,
      adapterName: "local-fixture",
      targetKind: "textarea",
      targetDescription: "textarea#fixture-textarea",
      method: "native-value-setter"
    }
  );

  assert.equal(report.ok, true);
  assert.equal(report.containsAnyForbiddenKnownTestValue, false);
  assert.equal(report.containsExpectedPlaceholder, true);
  assert.equal(hasUnsafeSelfTestReportKey(report), false);
}

{
  const report = verifyKnownSelfTestEditorState("John Doe LM_PRIVATE_PERSON", {
    isLocalFixture: true
  });

  assert.equal(report.ok, false);
  assert.equal(report.forbiddenChecks.personAbsent, false);
  assert.equal(report.containsAnyForbiddenKnownTestValue, true);
}

{
  const report = verifyKnownSelfTestEditorState(
    "\u27E6LM_PRIVATE_PERSON_TEST_001\u27E7 \u27E6LM_PRIVATE_ADDRESS_TEST_002\u27E7 \u27E6LM_PRIVATE_EMAIL_TEST_003\u27E7 \u27E6LM_SECRET_TEST_004\u27E7",
    {
      isLocalFixture: true,
      scenario: "privacyFilterFixture"
    }
  );

  assert.equal(report.ok, true);
  assert.equal(report.containsAnyForbiddenKnownTestValue, false);
  assert.equal(report.containsExpectedPlaceholder, true);
}

{
  const report = verifyKnownSelfTestEditorState(
    "\u27E6LM_PRIVATE_EMAIL_TEST_001\u27E7 \u27E6LM_SECRET_TEST_002\u27E7 \u27E6LM_ACCOUNT_NUMBER_TEST_003\u27E7",
    {
      isLocalFixture: true,
      scenario: "regexFallbackFixture"
    }
  );

  assert.equal(report.ok, true);
  assert.equal(report.containsAnyForbiddenKnownTestValue, false);
  assert.equal(report.containsExpectedPlaceholder, true);
}

{
  const unsafe = sanitizeSelfTestReport({
    text: "secret",
    prompt: "secret",
    value: "secret",
    nested: {
      innerText: "secret",
      safe: true,
      entities: [],
      editor: "secret",
      pageContent: "secret"
    }
  });

  assert.deepEqual(unsafe, {
    nested: {
      safe: true
    }
  });
  assert.equal(hasUnsafeSelfTestReportKey(unsafe), false);
}

{
  const validation = validateSelfTestMaskedOutput("LM_PRIVATE_PERSON LM_PRIVATE_ADDRESS", [
    { original: "John Doe" }
  ]);
  assert.equal(validation.ok, true);

  const failed = validateSelfTestMaskedOutput("John Doe LM_PRIVATE_PERSON", [
    { original: "John Doe" }
  ]);
  assert.equal(failed.ok, false);
  assert.equal(failed.entityOriginalRemaining, true);
}

console.log("selfTestConstants tests passed");
