#!/usr/bin/env node
/*
 * Scans the pdfs/ folder and updates data/sops.json.
 *
 *   pdfs/<Department Name>/<CODE - Title>.pdf
 *
 * - Every PDF found is marked "done": true and linked.
 * - SOPs you added by hand with "done": false (no PDF yet) are kept as Pending.
 * - When a matching PDF appears later (same code, or same title), that SOP flips to done.
 * - If a linked PDF is deleted, the SOP goes back to Pending.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PDF_DIR = path.join(ROOT, "pdfs");
const DATA_FILE = path.join(ROOT, "data", "sops.json");

// "QA-SOP-001 - Live Bird Receiving.pdf" -> { code: "QA-SOP-001", title: "Live Bird Receiving" }
function parseName(file) {
  const base = path.basename(file, path.extname(file)).trim();
  const m = base.match(/^([A-Za-z]{1,10}(?:[-_ ][A-Za-z]{1,10})*[-_ ]?\d{1,4}[A-Za-z]?)\s*(?:[-_–:.]\s*|\s+)(.+)$/);
  if (m) return { code: m[1].replace(/[_ ]/g, "-").toUpperCase(), title: m[2].trim() };
  return { code: "", title: base };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function load() {
  if (!fs.existsSync(DATA_FILE)) return { title: "SOP Tracker", company: "", departments: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function main() {
  const data = load();
  data.departments = data.departments || [];
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  let added = 0, linked = 0, unlinked = 0;

  // 1. Un-link PDFs that no longer exist
  for (const d of data.departments) {
    for (const s of d.sops || []) {
      if (s.pdf && !fs.existsSync(path.join(ROOT, s.pdf))) {
        console.warn(`! Missing file, marking pending: ${s.pdf}`);
        delete s.pdf;
        s.done = false;
        unlinked++;
      }
    }
  }

  // 2. Walk pdfs/<Department>/*.pdf
  const deptDirs = fs.readdirSync(PDF_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const dir of deptDirs) {
    let dept = data.departments.find((d) => norm(d.name) === norm(dir.name));
    if (!dept) {
      dept = { name: dir.name, sops: [] };
      data.departments.push(dept);
      console.log(`+ New department: ${dir.name}`);
    }
    dept.sops = dept.sops || [];

    const files = fs.readdirSync(path.join(PDF_DIR, dir.name))
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const f of files) {
      const rel = `pdfs/${dir.name}/${f}`;
      const { code, title } = parseName(f);

      let sop = dept.sops.find((s) => s.pdf === rel)
        || (code && dept.sops.find((s) => norm(s.code) === norm(code)))
        || dept.sops.find((s) => norm(s.title) === norm(title));

      if (sop) {
        if (!sop.done || sop.pdf !== rel) { linked++; console.log(`✓ Linked: ${rel}`); }
        sop.done = true;
        sop.pdf = rel;
        if (!sop.code && code) sop.code = code;
      } else {
        dept.sops.push({ code, title, done: true, pdf: rel });
        added++;
        console.log(`+ Added: ${rel}`);
      }
    }

    dept.sops.sort((a, b) =>
      (a.code || a.title).localeCompare(b.code || b.title, undefined, { numeric: true }));
  }

  data.lastUpdated = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");

  const all = data.departments.flatMap((d) => d.sops || []);
  const done = all.filter((s) => s.done).length;
  console.log(`\nDone. ${added} added, ${linked} linked, ${unlinked} unlinked.`);
  console.log(`Progress: ${done}/${all.length} SOPs completed across ${data.departments.length} departments.`);
}

main();
