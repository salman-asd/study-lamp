import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const testFiles = findTestFiles("src");
if (testFiles.length === 0) {
  // Without this guard `tsx --test` with no files would run its default discovery and could report a false pass.
  console.error("No *.test.ts files found under src/.");
  process.exit(1);
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npxCommand, ["tsx", "--test", ...testFiles], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
