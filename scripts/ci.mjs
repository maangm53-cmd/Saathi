import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "ci";
if (process.argv.length > 3 || !["ci", "check", "typecheck"].includes(mode)) {
  console.error("Usage: node scripts/ci.mjs [ci|check|typecheck]");
  process.exit(64);
}
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Saathi's checks require Node.js 24 or newer. Use the version in .nvmrc.");
  process.exit(1);
}

const steps = [
  ["Generate route types", ["node_modules/vinext/dist/cli.js", "typegen"]],
  ["Check TypeScript", ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"]],
];
if (mode !== "typecheck") steps.push(["Run all tests", ["--experimental-transform-types", "--test"]]);
if (mode === "ci") {
  // This is the same build entrypoint used by `npm run build` and Sites.
  steps.push(["Build the production Worker", ["scripts/run-framework.mjs", "build"]]);
  steps.push(["Validate the release contents", ["scripts/check-release.mjs"]]);
}

for (const [label, args] of steps) {
  console.log(`\n${label}`);
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  if (child.error) {
    console.error(`Unable to start: ${label}. ${child.error.message}`);
    process.exit(1);
  }
  if (child.signal || child.status !== 0) {
    console.error(`${label} failed${child.signal ? ` (${child.signal})` : ""}.`);
    process.exit(child.status || 1);
  }
}
console.log(`\nSaathi ${mode} checks passed.`);
