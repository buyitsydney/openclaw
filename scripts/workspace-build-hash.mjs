#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);
const DEFAULT_EXCLUDED_FILES = new Set([".DS_Store"]);

function parseArgs(argv) {
  const options = {
    baseDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    short: false,
  };

  for (const arg of argv) {
    if (arg === "--short") {
      options.short = true;
      continue;
    }
    if (arg.startsWith("--base-dir=")) {
      options.baseDir = path.resolve(arg.slice("--base-dir=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function collectWorkspaceEntries(rootDir) {
  const entries = [];

  function walk(currentDir, relativeDir) {
    const children = fs.readdirSync(currentDir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const absolutePath = path.join(currentDir, child.name);

      if (child.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(child.name)) {
          continue;
        }
        walk(absolutePath, relativePath);
        continue;
      }

      if (DEFAULT_EXCLUDED_FILES.has(child.name)) {
        continue;
      }

      if (child.isFile() || child.isSymbolicLink()) {
        entries.push(relativePath);
      }
    }
  }

  walk(rootDir, "");
  return entries;
}

function computeWorkspaceHash(rootDir) {
  const hash = createHash("sha256");
  const entries = collectWorkspaceEntries(rootDir);

  for (const relativePath of entries) {
    const absolutePath = path.join(rootDir, relativePath);
    const stat = fs.lstatSync(absolutePath);
    hash.update(`path:${relativePath}\0mode:${stat.mode.toString(8)}\0`);

    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${fs.readlinkSync(absolutePath)}\0`);
      continue;
    }

    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const digest = computeWorkspaceHash(options.baseDir);
  process.stdout.write(options.short ? `${digest.slice(0, 16)}\n` : `${digest}\n`);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
}
