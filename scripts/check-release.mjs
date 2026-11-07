import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureMarkers = [
  "__saathiSecurityTestEnvironment",
  "__saathiSecurityTestProvider",
  "test_key_not_a_real_credential_123456789",
  "PRIVATE_EPHEMERAL_TOKEN",
  // These identify the development sign-in shim, not ordinary words such as
  // "mock" that also occur legitimately in bundled framework code.
  "__sites_local_auth",
  "seedy@sites.test",
];
const privateDirectories = new Set([".git", ".sites-runtime", ".wrangler", "tests", "__tests__", "fixtures", "__fixtures__"]);
const secretVariableNames = ["SAATHI_SECRET", "OWNER_EMAIL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesBelow(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Release must not contain a symbolic link: ${relative}`);
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(directory, entry.name), relative));
    else {
      assert(entry.isFile(), `Release contains an unsupported file type: ${relative}`);
      result.push(relative);
    }
  }
  return result.sort();
}

async function nonempty(file, label) {
  const stat = await lstat(file).catch(() => null);
  assert(stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Missing or empty ${label}.`);
  return readFile(file);
}

function hasDefaultExport(source) {
  const parsed = ts.createSourceFile("index.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert(parsed.parseDiagnostics.length === 0, "The Worker entrypoint is not valid JavaScript.");
  return parsed.statements.some(statement =>
    ts.isExportAssignment(statement) && !statement.isExportEquals
    || ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some(element => element.name.text === "default")
    || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

/** Validate a build without loading Worker code, provider credentials or live data. */
export async function checkRelease(root = defaultRoot) {
  const dist = path.join(root, "dist");
  const entry = await nonempty(path.join(dist, "server/index.js"), "production Worker entrypoint");
  assert(hasDefaultExport(entry.toString("utf8")), "The Worker entrypoint has no default export.");
  const sourceHosting = JSON.parse(await readFile(path.join(root, ".openai/hosting.json"), "utf8"));
  const builtHosting = JSON.parse(await nonempty(path.join(dist, ".openai/hosting.json"), "Sites hosting manifest"));
  assert(typeof sourceHosting.project_id === "string" && sourceHosting.project_id.length > 0, "The source hosting manifest has no Site identity.");
  assert(isDeepStrictEqual(sourceHosting, builtHosting), "The built hosting manifest does not match source.");
  assert(!builtHosting.static, "Saathi requires the server Worker, not a static-only release.");

  const publicRoot = path.join(root, "public");
  const publicFiles = await filesBelow(publicRoot);
  for (const required of ["saathi-microphone.js", "sw.js", "manifest.webmanifest", "favicon.svg", "apple-touch-icon.png"]) {
    assert(publicFiles.includes(required), `Missing required public asset: ${required}`);
  }
  for (const relative of publicFiles) {
    const source = await nonempty(path.join(publicRoot, relative), `source asset ${relative}`);
    const built = await nonempty(path.join(dist, "client", relative), `built asset ${relative}`);
    assert(source.equals(built), `The built public asset differs from source: ${relative}`);
  }
  const manifest = JSON.parse(await readFile(path.join(dist, "client/manifest.webmanifest"), "utf8"));
  assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, "The installable app manifest has no icons.");
  for (const icon of manifest.icons) {
    assert(typeof icon.src === "string" && /^\/(?!\/)/.test(icon.src) && !/[?#]/.test(icon.src), "App icons must reference local release assets.");
    const asset = icon.src.slice(1);
    assert(publicFiles.includes(asset), `An app icon is missing from the release: ${asset}`);
  }

  if (builtHosting.d1) {
    const sourceMigrations = await filesBelow(path.join(root, "drizzle"));
    const packagedMigrations = await filesBelow(path.join(dist, ".openai/drizzle"));
    assert(sourceMigrations.some(file => file.endsWith(".sql")), "A D1 release must include its schema migrations.");
    assert(isDeepStrictEqual(sourceMigrations, packagedMigrations), "Packaged D1 migration files differ from source.");
    for (const relative of sourceMigrations) {
      const source = await readFile(path.join(root, "drizzle", relative));
      const built = await readFile(path.join(dist, ".openai/drizzle", relative));
      assert(source.equals(built), `A packaged D1 migration differs from source: ${relative}`);
    }
  }

  const workerConfig = JSON.parse(await nonempty(path.join(dist, "server/wrangler.json"), "generated Worker configuration"));
  for (const name of secretVariableNames) {
    assert(!(name in (workerConfig.vars ?? {})), `Runtime-only value ${name} must not be embedded in the release configuration.`);
  }
  assert(!(workerConfig.services ?? []).some(service => service.service === "sites-connector-preview"), "Development connector bindings must not be packaged for production.");

  const files = await filesBelow(dist);
  let scanned = 0;
  for (const relative of files) {
    const segments = relative.split("/");
    const basename = segments.at(-1);
    assert(!segments.some(segment => privateDirectories.has(segment)), `Local or test data was included in the release: ${relative}`);
    assert(!/^\.(?:env|dev\.vars)(?:\.|$)/i.test(basename), `A local environment file was included in the release: ${relative}`);
    assert(!/\.(?:pem|p12|pfx)$/i.test(basename), `Private credential material must not be packaged: ${relative}`);
    if (/\.(?:js|mjs|json|html|map|webmanifest|txt|sql)$/i.test(relative)) {
      const content = await readFile(path.join(dist, relative), "utf8");
      for (const marker of fixtureMarkers) assert(!content.includes(marker), `Development authentication or a test fixture was bundled: ${relative}`);
      scanned++;
    }
  }
  return { files: files.length, inspectedTextFiles: scanned, publicAssets: publicFiles.length, siteId: builtHosting.project_id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 2, "Usage: node scripts/check-release.mjs");
    const summary = await checkRelease();
    console.log(`Release verified: ${summary.files} files, ${summary.publicAssets} public assets, matching Sites metadata and D1 migrations.`);
  } catch (error) {
    console.error(`Release check failed: ${error instanceof Error ? error.message : "Unknown validation failure"}`);
    process.exitCode = 1;
  }
}
