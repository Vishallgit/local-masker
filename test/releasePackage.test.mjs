import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProductionManifest, PRODUCTION_MATCHES, validateProductionManifest } from "../scripts/build-release.mjs";

const sourceManifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const productionManifest = createProductionManifest(sourceManifest);
const serialized = JSON.stringify(productionManifest);
const contentMatches = productionManifest.content_scripts.flatMap((entry) => entry.matches ?? []);
const webAccessibleMatches = productionManifest.web_accessible_resources.flatMap((entry) => entry.matches ?? []);
const webAccessibleResources = productionManifest.web_accessible_resources.flatMap((entry) => entry.resources ?? []);

assert.deepEqual(contentMatches, PRODUCTION_MATCHES);
assert.deepEqual(webAccessibleMatches, PRODUCTION_MATCHES);
assert.equal(productionManifest.icons["128"], "assets/icons/icon-128.png");
assert.equal(/\bscaffold\b/i.test(productionManifest.description), false);
assert.equal(/localhost|127\.0\.0\.1/.test(serialized), false);
assert.equal(webAccessibleResources.includes("src/dev/selfTestConstants.js"), false);
assert.equal(/(^|[^-])unsafe-eval/i.test(productionManifest.content_security_policy.extension_pages), false);
assert.equal(/\bwasm-unsafe-eval\b/.test(productionManifest.content_security_policy.extension_pages), true);
assert.deepEqual(validateProductionManifest(productionManifest), []);

{
  const invalidManifest = structuredClone(productionManifest);
  invalidManifest.content_scripts[0].matches.push("http://localhost/*");
  assert.ok(validateProductionManifest(invalidManifest).some((error) => error.includes("localhost")));
}

{
  const invalidManifest = structuredClone(productionManifest);
  invalidManifest.web_accessible_resources[0].resources.push("src/dev/selfTestConstants.js");
  assert.ok(validateProductionManifest(invalidManifest).some((error) => error.includes("Dev-only")));
}

{
  const invalidManifest = structuredClone(productionManifest);
  delete invalidManifest.icons;
  assert.ok(validateProductionManifest(invalidManifest).some((error) => error.includes("128x128")));
}

console.log("releasePackage tests passed");
