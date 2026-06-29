import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionId = "com.zhmotions.scriptstudio";
const distRoot = path.join(root, "dist");
const outDir = path.join(distRoot, extensionId);

const requiredSources = ["CSXS", "client", "jsx", "assets"];

function copyDir(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (filePath) => !/\.DS_Store$/.test(filePath)
  });
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const sourceName of requiredSources) {
  const sourcePath = path.join(root, sourceName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required source directory: ${sourceName}`);
  }
  copyDir(sourcePath, path.join(outDir, sourceName));
}

const manifestPath = path.join(outDir, "CSXS", "manifest.xml");
if (!fs.existsSync(manifestPath)) {
  throw new Error("Build output is missing CSXS/manifest.xml");
}

// Keep the panel's EXT_VERSION in lockstep with the manifest. It was hardcoded and
// drifted (manifest 2.0.52, code 2.0.50) → the in-app update check fired forever and
// showed a perpetual "update available" banner. Manifest is the single source of truth.
const manifestXml = fs.readFileSync(manifestPath, "utf8");
const verMatch = manifestXml.match(/ExtensionBundleVersion="([^"]+)"/);
if (!verMatch) {
  throw new Error("Could not read ExtensionBundleVersion from manifest");
}
const bundleVersion = verMatch[1];
const builtAppJs = path.join(outDir, "client", "js", "app.js");
const appSrc = fs.readFileSync(builtAppJs, "utf8");
if (!/var EXT_VERSION = "[^"]*";/.test(appSrc)) {
  throw new Error("Could not find EXT_VERSION in app.js to sync");
}
fs.writeFileSync(
  builtAppJs,
  appSrc.replace(/var EXT_VERSION = "[^"]*";/, `var EXT_VERSION = "${bundleVersion}";`),
  "utf8"
);
console.log(`Synced EXT_VERSION -> ${bundleVersion}`);

fs.writeFileSync(
  path.join(outDir, "BUILD_INFO.txt"),
  [
    "Word Viewer Panel",
    `Extension ID: ${extensionId}`,
    `Built: ${new Date().toISOString()}`,
    "Renderer dependencies are bundled locally in client/vendor.",
    ""
  ].join("\n"),
  "utf8"
);

console.log(`Built CEP extension payload: ${outDir}`);
