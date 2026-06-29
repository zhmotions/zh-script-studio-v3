import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-files");
fs.mkdirSync(outDir, { recursive: true });

const ns = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture"
};

const fixtures = [
  {
    fileName: "01-simple-text.docx",
    body: [
      paragraph("Simple Text Document", { heading: true }),
      paragraph("This file verifies basic paragraph rendering in Word Viewer Panel."),
      paragraph("Search terms: alpha beta gamma.")
    ]
  },
  {
    fileName: "02-multi-page.docx",
    body: [
      paragraph("Multi-page Document", { heading: true }),
      paragraph("Page one contains enough structure to verify the first page."),
      pageBreak(),
      paragraph("Page Two", { heading: true }),
      paragraph("This paragraph appears after a manual page break."),
      pageBreak(),
      paragraph("Page Three", { heading: true }),
      paragraph("The final page verifies navigation, scrolling, and search across page breaks.")
    ]
  },
  {
    fileName: "03-tables.docx",
    body: [
      paragraph("Tables", { heading: true }),
      table([
        ["Name", "Role", "Status"],
        ["Asha", "Editor", "Ready"],
        ["Rafi", "Motion Designer", "Review"],
        ["Mina", "Producer", "Approved"]
      ])
    ]
  },
  {
    fileName: "04-images.docx",
    withImage: true,
    body: [
      paragraph("Images", { heading: true }),
      paragraph("The embedded image below is local inside the DOCX package."),
      imageParagraph()
    ]
  },
  {
    fileName: "05-unicode-bengali.docx",
    body: [
      paragraph("Unicode and Bengali", { heading: true }),
      paragraph("বাংলা লেখা পরীক্ষা: এটি একটি ইউনিকোড ডকুমেন্ট।"),
      paragraph("Mixed scripts: বাংলা, English, हिन्दी, العربية, 日本語.")
    ]
  }
];

for (const fixture of fixtures) {
  createDocx(path.join(outDir, fixture.fileName), fixture.body, Boolean(fixture.withImage));
  console.log(`Created ${fixture.fileName}`);
}

function createDocx(outputPath, bodyXml, withImage) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "word-viewer-docx-"));
  const wordDir = path.join(tempDir, "word");
  const relsDir = path.join(tempDir, "_rels");
  const wordRelsDir = path.join(wordDir, "_rels");
  fs.mkdirSync(wordDir, { recursive: true });
  fs.mkdirSync(relsDir, { recursive: true });
  fs.mkdirSync(wordRelsDir, { recursive: true });

  if (withImage) {
    fs.mkdirSync(path.join(wordDir, "media"), { recursive: true });
    fs.writeFileSync(path.join(wordDir, "media", "image1.png"), Buffer.from(getSamplePngBase64(), "base64"));
  }

  fs.writeFileSync(path.join(tempDir, "[Content_Types].xml"), contentTypes(withImage), "utf8");
  fs.writeFileSync(path.join(relsDir, ".rels"), packageRels(), "utf8");
  fs.writeFileSync(path.join(wordDir, "document.xml"), documentXml(bodyXml.join("\n")), "utf8");
  fs.writeFileSync(path.join(wordDir, "styles.xml"), stylesXml(), "utf8");
  fs.writeFileSync(path.join(wordRelsDir, "document.xml.rels"), documentRels(withImage), "utf8");

  fs.rmSync(outputPath, { force: true });
  run("zip", ["-qr", outputPath, "."], tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function documentXml(body) {
  return xml(`\
<w:document xmlns:w="${ns.w}" xmlns:r="${ns.r}" xmlns:wp="${ns.wp}" xmlns:a="${ns.a}" xmlns:pic="${ns.pic}">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`);
}

function paragraph(text, options = {}) {
  const style = options.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function table(rows) {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2880" w:type="dxa"/></w:tcPr>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

function imageParagraph() {
  return `\
<w:p>
  <w:r>
    <w:drawing>
      <wp:inline>
        <wp:extent cx="1828800" cy="914400"/>
        <wp:docPr id="1" name="Sample Image"/>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;
}

function contentTypes(withImage) {
  return xml(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${withImage ? '<Default Extension="png" ContentType="image/png"/>' : ""}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
}

function packageRels() {
  return xml(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
}

function documentRels(withImage) {
  return xml(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${withImage ? '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' : ""}
</Relationships>`);
}

function stylesXml() {
  return xml(`\
<w:styles xmlns:w="${ns.w}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:spacing w:after="160"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
</w:styles>`);
}

function xml(value) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${value}\n`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status}`);
  }
}

function getSamplePngBase64() {
  return "iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAACvjw7lAAAACXBIWXMAAAsTAAALEwEAmpwYAAABuElEQVR4nO3UwQnCQBQFQWf/oR3tQhRLMZlLKvJwFAk8zLwOw7Lv+gG4mQ0A4B8iQAAJkEACJJAACSRAAgmQQAIk0G+8X8f9vD7X5/2+7+/r9fV8P6/bp+P5cA4skAAJkEACJJAACSRAAgmQQAIkQAL9j1fXc7lc7vL5fPr4+Gj7er2+z+dzt9vtTqdT2+12u92u4/GYz+cLh8Mhm83m9/t9v98/lUolFoslEomEw+GQTCaTSCQSCYVCIBAIBAKBQCwWQyAQCAQCoVAoFAqFQqFQKBQKBUKhUCgUCoVCoVAoFAqFQqFQKBRKJpNJp9Mpl8vFYrFYLBYLhUKhUCgUCoVCwWAwmUwmmUwmlUqlUqlUKpVKpVIplUqFQiEQiEQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEomEw+EwmUwmmUwmlUqlUqlUqg8Gg8FgMFgsFovFYrFYLBaLRaLRaDQaDQaDwWAwGAwGg8FgMBgMBoPB4HA4HA6H0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+n0+n0+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/ksFgshEAh8Pl8qlUqlUqlUKhUKhULBYLBYLBaLRSKRSCQSiUQikUgkEonE43G43G43m83m83m83m82m02m02m00mk0mk0mk0mk0mk0mkwAAwL9KAgmQQAIk0GfBzhgLNzMWNc0AAAAASUVORK5CYII=";
}
