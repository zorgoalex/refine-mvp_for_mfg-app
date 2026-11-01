#!/usr/bin/env node

// Release version for a merge into main: one step above the version on main.
// The last number grows by one per merge; after 99 the middle number grows and the last resets
// (0.5.37 -> 0.5.38, 0.5.99 -> 0.6.0). Run on the branch that is about to be merged into main.
// Usage: node scripts/bump-version-main-merge.js [base-ref]   (default base-ref: origin/main)

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const versionTsPath = path.join(root, "src", "version.ts");

function parseVersion(source, origin) {
  const version = source.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error(`${origin}: APP_VERSION string constant not found`);
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`${origin}: invalid version ${version}`);
  }
  return parts;
}

function nextMainVersion([major, minor, patch]) {
  return patch >= 99 ? [major, minor + 1, 0] : [major, minor, patch + 1];
}

function updatePackageVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  json.version = version;
  if (json.packages?.[""]) json.packages[""].version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function main() {
  const baseRef = process.argv[2] || "origin/main";
  const baseSource = execFileSync("git", ["show", `${baseRef}:src/version.ts`], { cwd: root, encoding: "utf8" });
  const next = nextMainVersion(parseVersion(baseSource, baseRef)).join(".");
  const today = new Date().toISOString().slice(0, 10);
  const source = fs.readFileSync(versionTsPath, "utf8");
  parseVersion(source, "src/version.ts");
  fs.writeFileSync(
    versionTsPath,
    source
      .replace(/APP_VERSION\s*=\s*"[^"]+"/, `APP_VERSION = "${next}"`)
      .replace(/APP_VERSION_UPDATED_AT\s*=\s*"[^"]+"/, `APP_VERSION_UPDATED_AT = "${today}"`),
  );
  updatePackageVersion(packageJsonPath, next);
  updatePackageVersion(packageLockPath, next);
  console.log(`Version for the merge into main: ${next} (${baseRef} has ${parseVersion(baseSource, baseRef).join(".")}).`);
}

if (require.main === module) main();

module.exports = { nextMainVersion };
