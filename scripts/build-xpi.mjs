import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error(`Invalid plugin version for XPI filename: ${String(manifest.version)}`);
}
const output = resolve(root, "..", `zotero-paperflow-${manifest.version}.xpi`);
if (existsSync(output)) {
  throw new Error(`Refusing to overwrite existing XPI; inspect or move it first: ${output}`);
}

const buildDir = mkdtempSync(join(tmpdir(), "zotero-auto-fulltext-build-"));
const archive = join(buildDir, basename(output));
try {
  const packageResult = spawnSync("7z", [
    "a", "-tzip", "-mx=9", archive,
    "manifest.json", "bootstrap.js", "chrome.manifest", "prefpane.xhtml", "prefpane.js",
    "pane-icon.svg", "defaults", "content",
  ], { cwd: root, encoding: "utf8" });
  if (packageResult.status !== 0) {
    throw new Error(`7-Zip package creation failed:\n${packageResult.stdout}\n${packageResult.stderr}`);
  }

  const testResult = spawnSync("node", [join(root, "test/package-smoke.mjs"), archive], {
    cwd: root,
    encoding: "utf8",
  });
  if (testResult.status !== 0) {
    throw new Error(`Fresh XPI package validation failed:\n${testResult.stdout}\n${testResult.stderr}`);
  }

  copyFileSync(archive, output, 1);
  const outputTest = spawnSync("node", [join(root, "test/package-smoke.mjs"), output], {
    cwd: root,
    encoding: "utf8",
  });
  if (outputTest.status !== 0) {
    rmSync(output, { force: true });
    throw new Error(`Final XPI validation failed and the incomplete package was removed:\n${outputTest.stdout}\n${outputTest.stderr}`);
  }
  console.log(outputTest.stdout.trim());
  console.log(`Built ${output}`);
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
