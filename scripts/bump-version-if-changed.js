#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const versionTsPath = path.join(root, "src", "version.ts");

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const CODE_PATH_PREFIXES = [
  "api/",
  "backend/",
  "ops/",
  "public/",
  "scripts/",
  "src/",
  "tests/",
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function readVersionState() {
  const source = fs.readFileSync(versionTsPath, "utf8");
  const version = source.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const updatedAt = source.match(/APP_VERSION_UPDATED_AT\s*=\s*"([^"]+)"/)?.[1];
  if (!version || !updatedAt) {
    throw new Error("src/version.ts must export APP_VERSION and APP_VERSION_UPDATED_AT string constants");
  }
  return { source, version, updatedAt };
}

function isCodePath(filePath) {
  if (!filePath || filePath === "src/version.ts" || filePath === "package.json" || filePath === "package-lock.json") {
    return false;
  }
  return CODE_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix)) && CODE_EXTENSIONS.has(path.extname(filePath));
}

function changedCodeFilesSince(date) {
  const unstaged = git(["diff", "--name-only"]);
  const staged = git(["diff", "--cached", "--name-only"]);
  const committed = git(["log", `--since=${date}T00:00:00Z`, "--name-only", "--pretty=format:"]);
  return Array.from(new Set([...unstaged.split("\n"), ...staged.split("\n"), ...committed.split("\n")].filter(isCodePath)));
}

function bumpPatch(version) {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  parts[2] += 1;
  return parts.join(".");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function updatePackageVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  json.version = version;
  if (json.packages?.[""]) {
    json.packages[""].version = version;
  }
  writeJson(filePath, json);
}

function main() {
  const currentDate = todayUtc();
  const state = readVersionState();
  if (state.updatedAt === currentDate) {
    console.log(`Version already checked today (${currentDate}); current version ${state.version}.`);
    return;
  }

  const changedFiles = changedCodeFilesSince(state.updatedAt);
  if (changedFiles.length === 0) {
    console.log(`No code changes since ${state.updatedAt}; current version ${state.version}.`);
    return;
  }

  const nextVersion = bumpPatch(state.version);
  const nextVersionSource = state.source
    .replace(/APP_VERSION\s*=\s*"[^"]+"/, `APP_VERSION = "${nextVersion}"`)
    .replace(/APP_VERSION_UPDATED_AT\s*=\s*"[^"]+"/, `APP_VERSION_UPDATED_AT = "${currentDate}"`);

  fs.writeFileSync(versionTsPath, nextVersionSource);
  updatePackageVersion(packageJsonPath, nextVersion);
  updatePackageVersion(packageLockPath, nextVersion);

  console.log(`Bumped version ${state.version} -> ${nextVersion} (${changedFiles.length} changed code file(s)).`);
}

main();

