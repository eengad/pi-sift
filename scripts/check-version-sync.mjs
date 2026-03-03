#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] Could not parse ${label} at ${path}: ${message}`);
    process.exit(1);
  }
}

const root = process.cwd();
const packageJsonPath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");

const pkg = readJson(packageJsonPath, "package.json");
const lock = readJson(packageLockPath, "package-lock.json");

const pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;
const lockVersion = typeof lock.version === "string" ? lock.version : undefined;
const lockRootPackageVersion =
  typeof lock?.packages?.[""]?.version === "string"
    ? lock.packages[""].version
    : undefined;

if (!pkgVersion) {
  console.error("[FAIL] package.json is missing a string version field");
  process.exit(1);
}

const mismatches = [];
if (!lockVersion) {
  mismatches.push("package-lock.json version is missing or not a string");
} else if (lockVersion !== pkgVersion) {
  mismatches.push(
    `package-lock.json version (${lockVersion}) != package.json version (${pkgVersion})`
  );
}

if (!lockRootPackageVersion) {
  mismatches.push('package-lock.json packages[""].version is missing or not a string');
} else if (lockRootPackageVersion !== pkgVersion) {
  mismatches.push(
    `package-lock.json packages[""].version (${lockRootPackageVersion}) != package.json version (${pkgVersion})`
  );
}

if (mismatches.length > 0) {
  console.error("[FAIL] package version mismatch detected:");
  for (const issue of mismatches) {
    console.error(`  - ${issue}`);
  }
  console.error(
    "Fix: run `npm install --package-lock-only` (or `npm install`) and commit the updated package-lock.json"
  );
  process.exit(1);
}

console.log(`[PASS] package.json and package-lock.json versions are in sync (${pkgVersion})`);
