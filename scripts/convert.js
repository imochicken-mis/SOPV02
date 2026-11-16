#!/usr/bin/env node
/*
 * Converts the department SOP Word files into web pages for the "SOP Library".
 *
 *   npm run convert                      (uses the default source folder below)
 *   npm run convert -- "D:\Other\Folder" (or pass a different source folder)
 *
 * Source layout:  <source>/<Department Name CODE>/<main file>.docx
 * Output:         library/index.json        (department list + section list)
 *                 library/<slug>.html       (one page per department)
 *                 library/<slug>/...        (images taken out of the Word file)
 * A department with no Word file but a PDF is listed as a PDF.
 */
const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const { numberHeadings } = require("./word-numbering");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) || process.env.SOP_SOURCE || "E:/Project/SOP/Imo Completed SOP");
const OUT = path.join(ROOT, "library");

// Word drawings (hierarchy / org charts, flowcharts, SmartArt, shapes) are NOT readable by mammoth.
// On Windows with Microsoft Word installed, word-diagrams.ps1 renders them to PNG first.
// Skip this step with:  npm run convert -- --no-diagrams
const WORD_PS1 = path.join(__dirname, "word-diagrams.ps1");
const USE_DIAGRAMS = process.platform === "win32" && !process.argv.includes("--no-diagrams");

// Folder names with typos -> the name shown on the site.
const NAME_FIX = {
  "extention": "Extension",
  "trasnport department": "Transport Department",
  "quality assuarance": "Quality Assurance",
  "productio": "Production",
};
// Files inside a department folder that are NOT that department's SOP (copies of other departments).
const SKIP_FILES = [/^sales & marketing department\.docx$/i];

const slugify = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const strip = (html) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// "Automotive AMD019" -> { name: "Automotive", code: "AMD019" }; "Sales Admin Department SAD 012" -> code "SAD012"
function parseFolder(folder) {
  const m = folder.trim().match(/^(.*?)\s+([A-Z]{2,4})\s*(\d{3})$/);
  let name = (m ? m[1] : folder).trim().replace(/\s+/g, " ");
  name = NAME_FIX[name.toLowerCase()] || name;
  return { name, code: m ? m[2] + m[3] : "" };
}

function pickFile(dir, ext) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext) && !f.startsWith("~$"))
    .filter((f) => !SKIP_FILES.some((re) => re.test(f)));
  // Prefer the file named like the folder, else the largest one.
  const base = path.basename(dir).toLowerCase().replace(/\s+/g, " ");
  return files.find((f) => f.toLowerCase().replace(/\s+/g, " ").startsWith(base.split(" ")[0]))
    || files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
}

// Give headings ids and collect the section list. Files without Word heading styles get their
// numbered procedure titles (e.g. "19.01 ..." / "4.2 ...", in bold) promoted to headings.
// Sub-headings repeated inside every procedure — kept as headings in the page, left out of the section list.
const GENERIC = /^(?:\d{1,2}\s?\.?\s*)?\(?(?:[\u0D80-\u0DFF\u200c\u200d\s]+)?\)?\s*\(?\s*(purpose|scope|responsibilit\w*|definitions?|procedure|required records[^)]*|records?[^)]*|references?|safety[^)]*|non[- ]?conformance[^)]*|annex\w*|flow ?chart|objectives?|kpis?)\s*\)?\s*:?$/i;
// Procedure titles in files without Word heading styles, e.g. "SOP-ERP-01.01 : ...", "SEC-SOP-01", "T & D- SOP-01 ...".
const SOP_TITLE = /^(?:SOP\s?[-–]|[A-Z]{2,4}\s?[-–]\s?SOP|T\s?&amp;\s?D\s?[-–]\s?SOP)/;

function addSections(html) {
  html = html.replace(/<p>(<strong>\s*(\d{1,2}\s?\.\s?\d{1,2}\.?\s[^<]{3,160})<\/strong>)<\/p>/g, (all, s, t) => (/^10\.7\s/.test(t.trim()) ? all : `<h3>${t}</h3>`));
  html = html.replace(/<p><strong>\s*([^<]{4,160})<\/strong><\/p>/g, (all, t) => (SOP_TITLE.test(t.trim()) ? `<h2>${t.trim()}</h2>` : all));
  const sections = [];
  let n = 0;
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (all, level, inner) => {
    const title = strip(inner);
    if (!title) return "";
    const id = "s" + (++n);
    if (level <= 3 && !GENERIC.test(title)) sections.push({ id, title: title.slice(0, 140), level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html, sections };
}

// Returns { dir, docx, pngs } or null (not Windows / Word missing / failed / no diagrams).
function renderDiagrams(file) {
  if (!USE_DIAGRAMS) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sop-diag-"));
  const r = spawnSync("powershell",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", WORD_PS1, "-Src", file, "-OutDir", tmp],
    { encoding: "utf8", timeout: 5 * 60 * 1000 });
  const prepared = path.join(tmp, "prepared.docx");
  const pngs = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => /^diagram-.+\.png$/i.test(f)) : [];
  if (r.status !== 0 || !fs.existsSync(prepared)) {
    console.warn(`  ! diagram step failed for ${path.basename(file)} (${(r.stderr || r.error || "").toString().trim().split("\n")[0]})`);
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  if (!pngs.length) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
  return { dir: tmp, docx: prepared, pngs };
}

// Finish Goods: Word's two org charts come out as flat paragraphs; rebuild them as HTML/CSS charts.
function fgOrgCharts(html) {
  const re = /<p><strong>((?:Current|Intended) Organizational Structure in Finish Goods Department)<\/strong><\/p>((?:<p>[^<]*<\/p>){7})/g;
  return html.replace(re, (all, title, rows) => {
    const t = [...rows.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1].trim());
    const by = (rx) => t.find((x) => rx.test(x)) || "";
    const n = (cls, s) => `<span class="n ${cls}">${s}</span>`;
    return `<p class="org-title"><strong>${title}</strong></p><div class="org"><ul><li>${n("hd", by(/^Head/i))}<ul>`
      + `<li>${n("sv", by(/Admin Officer/i))}<ul><li>${n("st", by(/Admin Assistant/i))}</li></ul></li>`
      + `<li>${n("sv", by(/Cool/i))}</li><li>${n("sv", by(/^Unloading/i))}</li>`
      + `<li>${n("sv", by(/^Loading Supervisor/i))}<ul><li>${n("st", by(/Loading Officer/i))}</li></ul></li>`
      + `</ul></li></ul></div>`;
  });
}

// Information Technology: the org chart's boxes are floating Word shapes, so only their text comes out.
// Rebuild it as the same HTML/CSS chart: Network Security System Engineer on top, three boxes below
// (left to right as in Word: Senior Technician / Technician, GPS, CCTV).
function itOrgChart(html) {
  const re = /<p><strong>\s*(Information Technology\s+Department\s+organizational\s+structure)\s*<\/strong><\/p>((?:<p><strong>[^<]*<\/strong><\/p>){5})/i;
  return html.replace(re, (all, title, rows) => {
    const t = [...rows.matchAll(/<p><strong>([^<]*)<\/strong><\/p>/g)].map((m) => m[1].trim());
    const by = (rx) => t.find((x) => rx.test(x)) || "";
    const n = (s) => `<span class="n gr">${s}</span>`;
    const techs = t.filter((x) => /technician/i.test(x)).join("<br>");
    return `<p class="org-title"><strong>${title}</strong></p><div class="org"><ul><li>${n(by(/engineer/i))}<ul>`
      + `<li>${n(techs)}</li><li>${n(by(/GPS/i))}</li><li>${n(by(/CCTV/i))}</li>`
      + `</ul></li></ul></div>`;
  });
}

// Information Technology "Content" table: one row (21.02) was styled as a Heading 1 in Word, so it came out
// as a big heading; and the table ends with empty rows. Make every row look alike and drop the blank ones.
// Only that one table is touched: empty rows inside the other tables are part of Word's merged cells
// (e.g. "13. Definitions" spans 9 rows, 2 of them empty), so removing them would shift the columns.
function itContentTable(html) {
  return html.replace(/<table>(?:(?!<\/table>)[\s\S])*?<\/table>/g, (tbl) => {
    if (!/21\.01/.test(tbl) || !/21\.03/.test(tbl)) return tbl;
    tbl = tbl.replace(/<td>\s*<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>\s*<\/td>/g, "<td><p>$1</p></td>");
    return tbl.replace(/<tr>(?:<td>(?:\s|<p>\s*<\/p>)*<\/td>)+<\/tr>/g, "");
  });
}

// Information Technology: only 21.02 was a real heading in Word; 21.01 and 21.03 were plain bold lines.
// Make the three procedure titles the same heading, like the procedure titles in the other departments.
function itProcedureHeadings(html) {
  return html.replace(/<p>\s*<strong>\s*(21\.0[123]\s*[-–][^<]{3,200}?)\s*<\/strong>\s*<\/p>/g, "<h1><strong>$1</strong></h1>");
}

// Live Birds: the "Current" and "Intended" org charts are floating Word shapes; only their text comes out,
// in scrambled order. Rebuild both as HTML/CSS charts (same tree in both, only some box texts differ).
function lbOrgCharts(html) {
  const re = /<p><strong>((?:Current|Intended) Organizational Structure in [^<]*)<\/strong><\/p>((?:<p>[^<]*<\/p>){11})/g;
  return html.replace(re, (all, title, rows) => {
    const t = [...rows.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1].replace(/[ \s]+/g, " ").trim());
    const by = (rx, skip) => t.find((x) => rx.test(x) && !(skip && skip.test(x))) || "";
    const helpers = t.filter((x) => /^Helpers/i.test(x));
    const helpersTop = helpers.find((x) => /\(10\)/.test(x)) || "";                 // under Drivers
    const helpersLoad = helpers.find((x) => x !== helpersTop) || "";                // under Loading Officers
    const n = (cls, s) => `<span class="n ${cls}">${s}</span>`;
    return `<p class="org-title"><strong>${title}</strong></p><div class="org sm"><ul><li>${n("hd", by(/^Head/i))}<ul>`
      + `<li>${n("st", by(/Admin\s+Officer/i))}<ul>`
      + `<li>${n("st", by(/File\s+maintenance/i))}</li>`
      + `<li>${n("st", by(/\(Operations\)/i))}<ul>`
      + `<li>${n("sv eq", by(/^BuyBack/i))}</li>`
      + `<li>${n("sv eq", by(/Catching\s+Officers/i, /^BuyBack/i))}<ul><li>${n("sv", by(/^Loading/i))}<ul><li>${n("sv", helpersLoad)}</li></ul></li></ul></li>`
      + `<li>${n("sv eq", by(/^Live\s+Transport/i))}<ul><li>${n("sv", by(/^Drivers/i))}<ul><li>${n("sv", helpersTop)}</li></ul></li></ul></li>`
      + `</ul></li></ul></li></ul></li></ul></div>`;
  });
}

// Finish Goods: Word's two org charts come out as flat paragraphs; rebuild them as HTML/CSS charts.
function fgOrgCharts(html) {
  const re = /<p><strong>((?:Current|Intended) Organizational Structure in Finish Goods Department)<\/strong><\/p>((?:<p>[^<]*<\/p>){7})/g;
  return html.replace(re, (all, title, rows) => {
    const t = [...rows.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1].trim());
    const by = (rx) => t.find((x) => rx.test(x)) || "";
    const n = (cls, s) => `<span class="n ${cls}">${s}</span>`;
    return `<p class="org-title"><strong>${title}</strong></p><div class="org"><ul><li>${n("hd", by(/^Head/i))}<ul>`
      + `<li>${n("sv", by(/Admin Officer/i))}<ul><li>${n("st", by(/Admin Assistant/i))}</li></ul></li>`
      + `<li>${n("sv", by(/Cool/i))}</li><li>${n("sv", by(/^Unloading/i))}</li>`
      + `<li>${n("sv", by(/^Loading Supervisor/i))}<ul><li>${n("st", by(/Loading Officer/i))}</li></ul></li>`
      + `</ul></li></ul></div>`;
  });
}

async function convertDocx(file, slug) {
  const imgDir = path.join(OUT, slug);
  let imgCount = 0;
  const diag = renderDiagrams(file);
  // Word's automatic heading numbers ("1. Purpose") are lost by mammoth; write them into a copy first.
  const docBuffer = await numberHeadings(fs.readFileSync(diag ? diag.docx : file)).catch((err) => { console.warn(`  ! heading numbers skipped (${err.message})`); return fs.readFileSync(diag ? diag.docx : file); });
  const result = await mammoth.convertToHtml({ buffer: docBuffer }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const ext = (image.contentType.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
      if (!["png", "jpg", "gif", "webp", "bmp"].includes(ext)) return { src: "" }; // skip emf/wmf etc.
      fs.mkdirSync(imgDir, { recursive: true });
      const name = `img-${++imgCount}.${ext}`;
      fs.writeFileSync(path.join(imgDir, name), await image.read());
      return { src: `library/${slug}/${name}` };
    }),
  });
  let html = result.value.replace(/<img src="">/g, "");
  if (diag) {
    fs.mkdirSync(imgDir, { recursive: true });
    for (const f of diag.pngs) fs.copyFileSync(path.join(diag.dir, f), path.join(imgDir, f));
    const tag = (id) => `<img class="diagram" src="library/${slug}/diagram-${id}.png" alt="Diagram ${id}" />`;
    const have = (id) => diag.pngs.includes(`diagram-${id}.png`);
    // Marker paragraph -> picture, then any marker left inside other text.
    html = html.replace(/<p>\s*(?:<[^>]+>\s*)*\[\[DIAGRAM-([a-z0-9]+)\]\]\s*(?:<\/[^>]+>\s*)*<\/p>/gi, (all, id) => (have(id) ? `<p>${tag(id)}</p>` : all));
    html = html.replace(/\[\[DIAGRAM-([a-z0-9]+)\]\]/gi, (all, id) => (have(id) ? tag(id) : ""));
    console.log(`  + ${diag.pngs.length} diagram(s) rendered`);
    fs.rmSync(diag.dir, { recursive: true, force: true });
  }
  // Word's centered title block (SOP title / procedure name / company) loses its alignment in mammoth.
  html = html.replace(/<p><strong>STANDARD OPERATING PROCEDURE \(SOP\)<\/strong><\/p>(?:<p><strong>[^<]+<\/strong><\/p>){2}/i, (m) => `<div class="doc-title">${m}</div>`);
  if (slug === "finish-good") html = fgOrgCharts(html);
  if (slug === "information-technology") html = itProcedureHeadings(itContentTable(itOrgChart(html)));
  if (slug === "live-birds") html = lbOrgCharts(html);
  // Word's centered title block (SOP title / procedure name / company) loses its alignment in mammoth.
  html = html.replace(/<p><strong>STANDARD OPERATING PROCEDURE \(SOP\)<\/strong><\/p>(?:<p><strong>[^<]+<\/strong><\/p>){2}/i, (m) => `<div class="doc-title">${m}</div>`);
  if (slug === "finish-good") html = fgOrgCharts(html);
  return addSections(html);
}

async function main() {
  if (!fs.existsSync(SOURCE)) { console.error(`Source folder not found: ${SOURCE}`); process.exit(1); }
  // Clear the previous output (contents only, so an open folder window doesn't block it).
  fs.mkdirSync(OUT, { recursive: true });
  for (const entry of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });

  const departments = [];
  const folders = fs.readdirSync(SOURCE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const folder of folders.sort((a, b) => a.localeCompare(b))) {
    const dir = path.join(SOURCE, folder);
    const { name, code } = parseFolder(folder);
    const slug = slugify(name);
    const docx = pickFile(dir, ".docx");
    try {
      if (docx) {
        const { html, sections } = await convertDocx(path.join(dir, docx), slug);
        fs.writeFileSync(path.join(OUT, `${slug}.html`), html, "utf8");
        departments.push({ name, code, slug, type: "html", file: `library/${slug}.html`, source: docx, sections });
        console.log(`✓ ${name.padEnd(32)} ${String(sections.length).padStart(3)} sections  (${docx})`);
      } else {
        const pdf = pickFile(dir, ".pdf");
        if (!pdf) { console.warn(`! ${name}: no Word or PDF file, skipped`); continue; }
        fs.copyFileSync(path.join(dir, pdf), path.join(OUT, `${slug}.pdf`));
        departments.push({ name, code, slug, type: "pdf", file: `library/${slug}.pdf`, source: pdf, sections: [] });
        console.log(`✓ ${name.padEnd(32)}   PDF only        (${pdf})`);
      }
    } catch (err) {
      console.warn(`! ${name}: could not convert ${docx} — ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(OUT, "index.json"),
    JSON.stringify({ generated: new Date().toISOString().slice(0, 10), departments }, null, 2) + "\n", "utf8");
  console.log(`\nDone. ${departments.length} departments written to library/`);
}

main();