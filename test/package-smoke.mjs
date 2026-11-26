import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archivePath = process.argv[2];
if (!archivePath) throw new Error("Usage: node test/package-smoke.mjs <path-to-xpi>");
const archive = resolve(archivePath);
if (!existsSync(archive)) throw new Error(`XPI does not exist: ${archive}`);

const zipTest = spawnSync("7z", ["t", archive], { encoding: "utf8" });
assert.equal(zipTest.status, 0, `XPI archive validation failed:\n${zipTest.stdout}\n${zipTest.stderr}`);

const listing = spawnSync("7z", ["l", "-slt", archive], { encoding: "utf8" });
assert.equal(listing.status, 0, `Could not list XPI members:\n${listing.stdout}\n${listing.stderr}`);
const members = listing.stdout.split(/\r?\n\r?\n/)
  .map((block) => ({
    path: /^Path = (.+)$/m.exec(block)?.[1]?.replace(/\\/g, "/"),
    folder: /^Folder = ([+-])$/m.exec(block)?.[1] === "+",
    entry: /^Folder = [+-]$/m.test(block),
  }))
  .filter((entry) => entry.path && entry.entry && !entry.folder)
  .map((entry) => entry.path)
  .sort();
const expected = [
  "manifest.json",
  "bootstrap.js",
  "chrome.manifest",
  "prefpane.xhtml",
  "prefpane.js",
  "pane-icon.svg",
  "defaults/preferences/prefs.js",
  "content/office-to-pdf.vbs",
  "content/modules/core.js",
  "content/modules/fulltext-translation.js",
  "content/modules/main.js",
  "content/modules/pdf-export.js",
  "content/modules/supporting-info.js",
  "content/modules/translation-client.js",
].sort();
assert.deepEqual(members, expected, "XPI members must exactly match the current source manifest");
for (const member of expected) {
  const packagedFile = spawnSync("7z", ["e", "-so", archive, member], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(packagedFile.status, 0, `Could not extract packaged source file: ${member}`);
  assert.deepEqual(packagedFile.stdout, readFileSync(join(root, member)), `Packaged file differs from source: ${member}`);
}
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const packagedManifest = spawnSync("7z", ["e", "-so", archive, "manifest.json"], { encoding: "utf8" });
assert.equal(packagedManifest.status, 0, "XPI must contain a readable root manifest");
assert.equal(JSON.parse(packagedManifest.stdout).version, manifest.version, "XPI version must match source manifest");
console.log(`XPI package checks passed (${members.length} source files, version ${manifest.version}).`);
