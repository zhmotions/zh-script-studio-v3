import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const extensionDir = path.join(root, "dist", "com.zhmotions.scriptstudio");
const zxpPath = path.join(root, "dist", "ZHScriptStudio.zxp");
const unsignedZipPath = path.join(root, "dist", "ZHScriptStudio.unsigned.zip");
const signingRequiredPath = path.join(root, "dist", "SIGNING_REQUIRED.txt");

run(nodePath, [path.join(root, "scripts", "build.mjs")], root);

const signCmd = process.env.ZXP_SIGN_CMD || findExecutable("ZXPSignCmd");
let certPath = process.env.ZXP_CERT_PATH || "";
let certPassword = process.env.ZXP_CERT_PASSWORD || "";
const tsaUrl = process.env.ZXP_TSA_URL || "";
let generatedSelfSignedCert = false;

if (process.env.ZXP_SELF_SIGN === "1" && signCmd && (!certPath || !certPassword)) {
  certPassword = process.env.ZXP_CERT_PASSWORD || `word-viewer-${Date.now()}`;
  certPath = path.join(root, "dist", "word-viewer-self-signed.p12");
  generatedSelfSignedCert = true;
  run(signCmd, [
    "-selfSignedCert",
    process.env.ZXP_CERT_COUNTRY || "US",
    process.env.ZXP_CERT_STATE || "CA",
    process.env.ZXP_CERT_ORG || "Word Viewer Panel",
    process.env.ZXP_CERT_CN || "Word Viewer Panel Development",
    certPassword,
    certPath
  ], root);
}

fs.rmSync(zxpPath, { force: true });
fs.rmSync(unsignedZipPath, { force: true });
fs.rmSync(signingRequiredPath, { force: true });

if (signCmd && certPath && certPassword) {
  const args = ["-sign", extensionDir, zxpPath, certPath, certPassword];
  if (tsaUrl) {
    args.push("-tsa", tsaUrl);
  }
  run(signCmd, args, root);
  run(signCmd, ["-verify", zxpPath], root);
  if (generatedSelfSignedCert && process.env.KEEP_SELF_SIGNED_CERT !== "1") {
    fs.rmSync(certPath, { force: true });
  }
  console.log(`Signed ZXP: ${zxpPath}`);
} else {
  makeUnsignedZip();
  fs.writeFileSync(
    signingRequiredPath,
    [
      "Signed ZXP was not produced on this machine.",
      "",
      "To create dist/ZHScriptStudio.zxp, install Adobe ZXPSignCmd and run:",
      "  ZXP_SIGN_CMD=/path/to/ZXPSignCmd \\",
      "  ZXP_CERT_PATH=/path/to/certificate.p12 \\",
      "  ZXP_CERT_PASSWORD='certificate-password' \\",
      "  node scripts/package-zxp.mjs",
      "",
      "For a development-only self-signed package, run:",
      "  ZXP_SIGN_CMD=/path/to/ZXPSignCmd ZXP_SELF_SIGN=1 node scripts/package-zxp.mjs",
      "",
      "Unsigned CEP extensions do not run in production without CSXS PlayerDebugMode.",
      ""
    ].join("\n"),
    "utf8"
  );

  console.warn(`ZXPSignCmd or certificate credentials are missing.`);
  console.warn(`Created unsigned ZIP for inspection only: ${unsignedZipPath}`);
  if (process.env.REQUIRE_SIGNED_ZXP === "1") {
    process.exitCode = 2;
  }
}

function makeUnsignedZip() {
  const zip = findExecutable("zip");
  if (!zip) {
    throw new Error("zip command is required to create the unsigned package fallback.");
  }
  run(zip, ["-qr", unsignedZipPath, "."], extensionDir);
}

function findExecutable(name) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, name + extension);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}
