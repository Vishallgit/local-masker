import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  hasForbiddenArtifactKey,
  sanitizeE2eArtifact
} from "./e2eArtifactSanitizer.mjs";

const projectRoot = resolve(".");
const artifactsDir = join(projectRoot, "artifacts");
const probeArtifact = join(artifactsDir, "webgpu-probe.webgpu-probe.json");
const reportArtifact = join(artifactsDir, "webgpu-probe-report.json");

mkdirSync(artifactsDir, { recursive: true });

const exitCode = await runPrivacyFixtureProbeOnly();
const probe = readJsonIfExists(probeArtifact);
const report = sanitizeE2eArtifact({
  reportType: "local-masker-webgpu-probe-e2e",
  generatedAt: new Date().toISOString(),
  ok: Boolean(probe),
  sourceArtifact: "artifacts/webgpu-probe.webgpu-probe.json",
  webgpuFlagsMode: process.env.LM_E2E_WEBGPU_FLAGS || "none",
  probe: probe ?? null,
  error: probe ? "" : "WebGPU probe artifact was not written."
});

if (hasForbiddenArtifactKey(report)) {
  throw new Error("Refusing to write WebGPU probe report with forbidden keys.");
}

writeFileSync(reportArtifact, `${JSON.stringify(report, null, 2)}\n`);
console.log(`WebGPU probe report: ${reportArtifact}`);
process.exit(exitCode);

function runPrivacyFixtureProbeOnly() {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["scripts/e2e-privacy-filter-fixture.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        LM_E2E_WEBGPU_PROBE_ONLY: "1",
        LM_E2E_RETRY_WITH_UNSAFE_WEBGPU: "0",
        LM_E2E_ARTIFACT_SUFFIX: "webgpu-probe",
        LM_E2E_SUPPRESS_ARTIFACT_ALIASES: "1"
      },
      stdio: "inherit"
    });
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
}

function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
