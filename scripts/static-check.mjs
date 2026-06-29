import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error: error.message });
  }
}

function read(filePath) {
  return fs.readFileSync(path.join(root, filePath), "utf8");
}

check("manifest includes PPRO 22+", () => {
  const manifest = read("CSXS/manifest.xml");
  if (!/<Host\s+Name="PPRO"\s+Version="\[22\.0,99\.9\]"/.test(manifest)) {
    throw new Error("PPRO host range missing or incorrect");
  }
});

check("manifest includes AEFT 22+", () => {
  const manifest = read("CSXS/manifest.xml");
  if (!/<Host\s+Name="AEFT"\s+Version="\[22\.0,99\.9\]"/.test(manifest)) {
    throw new Error("AEFT host range missing or incorrect");
  }
});

check("CSP restricts network to the license domain only", () => {
  const html = read("client/index.html");
  const m = html.match(/connect-src ([^;]+);/);
  if (!m) throw new Error("connect-src missing");
  const val = m[1].trim();
  // Must be limited to zhmotions.com for license checks — never '*' or http:.
  if (/\*/.test(val) || /http:\/\//.test(val) || !/zhmotions\.com/.test(val)) {
    throw new Error("connect-src too permissive: " + val);
  }
});

check("license gate is present", () => {
  const html = read("client/index.html");
  const app = read("client/js/app.js");
  if (!html.includes('id="licenseGate"') || !app.includes("enforceLicense") || !app.includes("/license/verify")) {
    throw new Error("License gate wiring missing");
  }
});

check("runtime dependencies are local", () => {
  const html = read("client/index.html");
  // No remotely-loaded resources (scripts/styles/images/fonts). The license API URL and
  // the zhmotions.com link are allowed (runtime fetch / external link, not a page resource).
  if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
    const offenders = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    const bad = offenders.filter((o) => !/zhmotions\.com/i.test(o));
    if (bad.length) throw new Error("HTML loads remote resources: " + bad.join(", "));
  }
  for (const filePath of [
    "client/vendor/jszip.min.js",
    "client/vendor/docx-preview.min.js",
    "client/vendor/mammoth.browser.min.js",
    "client/vendor/purify.min.js"
  ]) {
    if (!fs.existsSync(path.join(root, filePath))) {
      throw new Error(`Missing ${filePath}`);
    }
  }
});

check("JSZip loads before docx-preview", () => {
  const html = read("client/index.html");
  const jszipIndex = html.indexOf("./vendor/jszip.min.js");
  const docxIndex = html.indexOf("./vendor/docx-preview.min.js");
  if (jszipIndex === -1 || docxIndex === -1 || jszipIndex > docxIndex) {
    throw new Error("JSZip must load before docx-preview");
  }
});

check("Word lock file warning exists", () => {
  const app = read("client/js/app.js");
  if (!app.includes("temporary Word lock file")) {
    throw new Error("Lock-file warning text missing");
  }
});

check("collapsible tools menu exists", () => {
  const html = read("client/index.html");
  const app = read("client/js/app.js");
  if (!html.includes('id="toolsButton"') || !html.includes('id="toolsMenu"') || !app.includes("setToolsMenuOpen")) {
    throw new Error("Tools menu toggle is missing");
  }
});

check("font dropdown and timeline paste controls exist", () => {
  const html = read("client/index.html");
  const app = read("client/js/app.js");
  if (!html.includes('<select id="fontFamilyInput"') || !app.includes("loadSystemFonts")) {
    throw new Error("Installed font dropdown support is missing");
  }
  if (!html.includes('id="captionButton"') || !html.includes('id="batchButton"') ||
      !html.includes('id="markerButton"') || !app.includes("sendToTimeline")) {
    throw new Error("Timeline send controls (caption/batch/marker) are missing");
  }
});

check(".doc warning text is exact", () => {
  const app = read("client/js/app.js");
  if (!app.includes("Please convert this .doc file to .docx.")) {
    throw new Error("Required .doc warning text missing");
  }
});

for (const result of checks) {
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
}

if (checks.some((result) => !result.pass)) {
  process.exit(1);
}
