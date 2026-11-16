/*
 * Word shows automatic numbers ("1.", "2.", "a)") on numbered Heading paragraphs, but the Word->HTML
 * converter (mammoth) drops them. This reads a .docx, works out each numbered heading's number the way
 * Word does (numbering.xml + the style's list) and writes it into the heading text in a COPY of the file
 * held in memory. The original file is never changed.
 *
 *   const fixed = await numberHeadings(fs.readFileSync(file));   // Buffer in, Buffer out
 */
const JSZip = require("jszip");

const ROMAN = [["m", 1000], ["cm", 900], ["d", 500], ["cd", 400], ["c", 100], ["xc", 90], ["l", 50], ["xl", 40], ["x", 10], ["ix", 9], ["v", 5], ["iv", 4], ["i", 1]];
const roman = (n) => { let s = ""; for (const [r, v] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const letters = (n) => { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };

function format(fmt, n) {
  switch (fmt) {
    case "decimal": return String(n);
    case "decimalZero": return String(n).padStart(2, "0");
    case "lowerLetter": return letters(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    default: return null; // bullet / none / anything else: no number text
  }
}

const attr = (xml, re) => { const m = xml.match(re); return m ? m[1] : null; };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// styleId -> { basedOn, numId, ilvl }
function readStyles(xml) {
  const styles = {};
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const body = m[2];
    styles[m[1]] = {
      basedOn: attr(body, /<w:basedOn w:val="([^"]+)"/),
      numId: attr(body, /<w:numPr>[\s\S]*?<w:numId w:val="(\d+)"/),
      ilvl: attr(body, /<w:numPr>[\s\S]*?<w:ilvl w:val="(\d+)"/),
    };
  }
  return styles;
}

// numId -> { abstract: id, overrides: { ilvl: startValue } }; abstractId -> { ilvl: { start, fmt, text } }
function readNumbering(xml) {
  const abstracts = {}, nums = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = {};
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      levels[l[1]] = {
        start: Number(attr(l[2], /<w:start w:val="(-?\d+)"/) ?? 1),
        fmt: attr(l[2], /<w:numFmt w:val="([^"]+)"/) || "decimal",
        text: attr(l[2], /<w:lvlText w:val="([^"]*)"/) ?? "%1.",
      };
    }
    abstracts[m[1]] = levels;
  }
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const overrides = {};
    for (const o of m[2].matchAll(/<w:lvlOverride w:ilvl="(\d+)"[^>]*>\s*<w:startOverride w:val="(-?\d+)"/g)) overrides[o[1]] = Number(o[2]);
    nums[m[1]] = { abstract: attr(m[2], /<w:abstractNumId w:val="(\d+)"/), overrides };
  }
  return { abstracts, nums };
}

async function numberHeadings(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml"), numFile = zip.file("word/numbering.xml"), styleFile = zip.file("word/styles.xml");
  if (!docFile || !numFile || !styleFile) return buffer;

  const styles = readStyles(await styleFile.async("string"));
  const { abstracts, nums } = readNumbering(await numFile.async("string"));
  const styleNum = (id, seen = new Set()) => {            // numbering a style carries (walks "based on")
    const s = styles[id]; if (!s || seen.has(id)) return {};
    seen.add(id);
    if (s.numId != null) return { numId: s.numId, ilvl: s.ilvl };
    return s.basedOn ? styleNum(s.basedOn, seen) : {};
  };

  const counters = {};                                     // abstractNumId -> counter per level
  const restarted = new Set();                             // "numId:level" whose start override already applied
  let xml = await docFile.async("string");
  let changed = 0;
  // Paragraphs that do not contain another paragraph (text boxes nest paragraphs inside paragraphs).
  xml = xml.replace(/<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g, (p) => {
    const styleId = attr(p, /<w:pStyle w:val="([^"]+)"/);
    if (!styleId || !/^Heading\d/i.test(styleId)) return p;  // only headings lose their numbers
    if (!(p.match(/<w:t\b[^>]*>[^<]*<\/w:t>/g) || []).some((t) => t.replace(/<[^>]+>/g, "").trim())) return p; // blank lines are not numbered
    const ppr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0];
    const direct = ppr.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    let numId = direct ? attr(direct[1], /<w:numId w:val="(\d+)"/) : null;
    let ilvl = direct ? attr(direct[1], /<w:ilvl w:val="(\d+)"/) : null;
    if (numId == null) { const s = styleNum(styleId); numId = s.numId; ilvl = ilvl ?? s.ilvl; }
    if (numId == null || numId === "0" || !nums[numId]) return p;
    const level = Number(ilvl ?? 0);
    const def = abstracts[nums[numId].abstract];
    if (!def || !def[level]) return p;

    // Word counts every list that points at the same numbering definition as ONE sequence. A list with a
    // "start at" override restarts that sequence the first time it is used at that level.
    const abstractId = nums[numId].abstract;
    const c = (counters[abstractId] ||= []);
    const startOf = (k) => (def[k]?.start ?? 1);
    const override = nums[numId].overrides[level];
    const first = `${numId}:${level}`;
    if (override !== undefined && !restarted.has(first)) { restarted.add(first); c[level] = override; }
    else c[level] = c[level] === undefined ? startOf(level) : c[level] + 1;
    c.length = level + 1;                                  // a higher level restarts everything below it

    const lv = def[level];
    if (format(lv.fmt, 1) == null) return p;                // bullets etc.
    const label = lv.text.replace(/%(\d)/g, (_, d) => {
      const k = Number(d) - 1;
      const f = def[k] ? format(def[k].fmt, c[k] ?? startOf(k)) : null;
      return f ?? "";
    }).trim();
    if (!label) return p;

    const run = `<w:r><w:t xml:space="preserve">${esc(label)} </w:t></w:r>`;
    changed++;
    return ppr ? p.replace(ppr, ppr + run) : p.replace(/^(<w:p\b[^>]*>)/, "$1" + run);
  });

  if (!changed) return buffer;
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { numberHeadings };
