/* SOP Library — reads library/index.json (made by `npm run convert`) and shows each
   department's SOP as a web page inside the dashboard. Opened with the "SOP Library" button. */
(() => {
  "use strict";

  const INDEX_URL = "library/index.json";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Departments that expand in the sidebar to show their units. The unit's slug is the library page it opens.
  const GROUPS = { "general-admin": [{ name: "Kitchen", slug: "general-admin", code: "27" }] };

  const lib = { index: null, current: null, cache: new Map(), filter: "", open: new Set() };

  async function loadIndex() {
    if (lib.index) return lib.index;
    const res = await fetch(INDEX_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lib.index = await res.json();
    return lib.index;
  }

  /* ---------- Sidebar ---------- */
  function renderSide() {
    const q = lib.filter.toLowerCase();
    const depts = lib.index.departments.filter((d) => !q || `${d.name} ${d.code} ${(GROUPS[d.slug] || []).map((k) => k.name).join(" ")}`.toLowerCase().includes(q));
    $("libDepts").innerHTML = depts.map((d) => {
      const active = lib.current === d.slug;
      const sections = active && d.sections.length
        ? `<ol class="lib-sections">${d.sections.map((s) =>
            `<li class="lv${s.level}"><a href="#" data-section="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</a></li>`).join("")}</ol>`
        : "";
      if (GROUPS[d.slug]) {
        const open = lib.open.has(d.slug) || active;
        const kids = GROUPS[d.slug].map((k) => `<div class="lib-dept lib-sub${lib.current === k.slug ? " active" : ""}">
            <button type="button" data-slug="${esc(k.slug)}" aria-current="${lib.current === k.slug}"><span class="lib-dept-name">${esc(k.name)}</span><span class="lib-dept-code">${esc(k.code || "")}</span></button>${lib.current === k.slug ? sections : ""}</div>`).join("");
        return `<div class="lib-dept lib-group${open ? " open" : ""}">
          <button type="button" data-group="${esc(d.slug)}" aria-expanded="${open}">
            <span class="lib-dept-name">${esc(d.name)}</span><span style="display:flex;align-items:center;gap:8px"><span class="lib-dept-code">${esc(d.code)}</span><span class="lib-caret" aria-hidden="true">▸</span></span>
          </button>${open ? `<div class="lib-subdepts">${kids}</div>` : ""}</div>`;
      }
      return `<div class="lib-dept${active ? " active" : ""}">
          <button type="button" data-slug="${esc(d.slug)}" aria-current="${active}">
            <span class="lib-dept-name">${esc(d.name)}</span>
            <span class="lib-dept-code">${esc(d.code || (d.type === "pdf" ? "PDF" : ""))}</span>
          </button>${sections}</div>`;
    }).join("") || `<p class="lib-empty">No department matches “${esc(lib.filter)}”.</p>`;
  }

  /* ---------- Kitchen org charts ---------- */
  // Word's two Kitchen org charts (Existing / Proposed) arrive as loose paragraphs; rebuild them as charts.
  function buildKitchenCharts(doc) {
    const text = (el) => el.textContent.replace(/[\s\u00a0]+/g, " ").trim();
    const byNum = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    ["Existing", "Proposed"].forEach((label) => {
      const start = [...doc.children].find((el) => el.tagName === "P" && text(el) === label);
      if (!start) return;
      const used = [];
      const items = [];
      for (let el = start.nextElementSibling; el && el.tagName === "P"; el = el.nextElementSibling) {
        const t = text(el);
        if (t === "Proposed" || /^Content$/i.test(t)) break;
        if (t) items.push(t);
        used.push(el);
      }
      const manager = items.find((t) => /^Manager$/i.test(t)) || "Manager";
      const assistant = items.find((t) => /Assistant/i.test(t));
      const col = (list) => `<div class="kc-col"><ul>${list.map((t) => `<li><span class="kc-n">${esc(t)}</span></li>`).join("")}</ul></div>`;
      const solo = assistant ? `<div class="kc-col kc-solo"><span class="kc-n">${esc(assistant)}</span></div>` : "";
      const left = items.filter((t) => /^(Cook|Helper)/i.test(t)).sort(byNum);
      const right = items.filter((t) => /^(Canteen|Cleaning)/i.test(t)).sort(byNum);
      start.insertAdjacentHTML("beforebegin", `<p class="kc-label"><strong>${esc(label)}</strong></p>`
        + `<div class="kc"><div class="kc-in"><span class="kc-n kc-mgr">${esc(manager)}</span><div class="kc-stem"></div>`
        + `<div class="kc-bar">${solo}${col(left)}${col(right)}</div></div></div>`);
      start.remove();
      used.forEach((el) => el.remove());
    });
  }

  /* ---------- HR org charts ---------- */
  // The HR Word file draws its two org charts as shapes (lost on conversion); rebuild them as SVG.
  function buildHrCharts(doc) {
    const wrap = (w, h, id, parts) => `<svg viewBox="0 0 ${w} ${h}" class="hr-chart" role="img" aria-label="Organization structure" xmlns="http://www.w3.org/2000/svg" style="font-family:Calibri,'Segoe UI',Arial,sans-serif">`
      + `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#111"/></marker></defs>${parts.join("")}</svg>`;
    const box = (cx, y, w, h, lines) => `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="1.5"/>`
      + `<text x="${cx}" y="${y + h / 2 - ((lines.length - 1) * 7) + 4.5}" text-anchor="middle" font-size="12" font-weight="600" fill="#111">${lines.map((t, i) => `<tspan x="${cx}" dy="${i ? 14 : 0}">${esc(t)}</tspan>`).join("")}</text>`;
    const ln = (id, x1, y1, x2, y2, arrow) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="2"${arrow ? ` marker-end="url(#${id})"` : ""}/>`;

    const a = "hrx";
    const existing = wrap(700, 245, a, [
      box(382, 10, 160, 30, ["Human Resources Manager"]), ln(a, 382, 40, 382, 64), ln(a, 110, 64, 625, 64),
      ln(a, 110, 64, 110, 92), box(110, 92, 100, 28, ["HR Executive - 01"]),
      ln(a, 110, 120, 110, 160), ln(a, 55, 160, 165, 160),
      ln(a, 55, 160, 55, 185, 1), ln(a, 165, 160, 165, 185, 1),
      box(55, 185, 80, 34, ["HR Officer", "- 01"]), box(165, 185, 80, 34, ["HR Officer", "- 02"]),
      ln(a, 382, 64, 382, 160), ln(a, 255, 160, 510, 160),
      ...[255, 340, 425, 510].map((x, i) => ln(a, x, 160, x, 185, 1) + box(x, 185, 80, 34, ["HR Officer", `- 0${i + 3}`])),
      ln(a, 625, 64, 625, 120), box(625, 120, 112, 36, ["Human Care Officer", "- 01"]),
    ]);

    const b = "hrp";
    const proposed = wrap(700, 255, b, [
      box(382, 10, 160, 30, ["Human Resources Manager"]), ln(b, 382, 40, 382, 64), ln(b, 110, 64, 625, 64),
      ln(b, 110, 64, 110, 92, 1), box(110, 92, 100, 28, ["HR Executive - 01"]),
      ln(b, 110, 120, 110, 150, 1), box(110, 150, 100, 28, ["HR Officer - 01"]),
      ln(b, 110, 178, 110, 208, 1), box(110, 208, 100, 28, ["HR Assistant - 01"]),
      ln(b, 382, 64, 382, 126), ln(b, 300, 126, 464, 126),
      ...[[300, 2], [464, 3]].map(([x, n]) => ln(b, x, 126, x, 150, 1) + box(x, 150, 110, 28, [`HR Officer - 0${n}`])
        + ln(b, x, 178, x, 208, 1) + box(x, 208, 110, 28, [`HR Assistant - 0${n}`])),
      box(475, 78, 130, 36, ["Senior HR Executive", "- 01"]), ln(b, 410, 96, 382, 96, 1),
      ln(b, 625, 64, 625, 150, 1), box(625, 150, 112, 36, ["Human Care Officer", "- 01"]),
    ]);

    [["Existing", existing], ["Proposed", proposed]].forEach(([word, svg]) => {
      const h = [...doc.querySelectorAll("h1")].find((el) => new RegExp(`^${word} Processing Plant`, "i").test(el.textContent.trim()));
      const p = h && h.nextElementSibling;
      const ul = p && p.nextElementSibling;
      if (!p || p.tagName !== "P" || !ul || ul.tagName !== "UL") return;
      p.remove();
      ul.remove();
      h.insertAdjacentHTML("afterend", `<div class="hr-chart-wrap">${svg}</div>`);
    });
  }

  /* ---------- Content ---------- */
  function renderHome() {
    $("libDeptTitle").textContent = "";
    $("libBack").hidden = true;
    $("libContent").innerHTML = `
      <div class="lib-home">
        <h2>Select a department</h2>
        <p>Choose a department to read its Standard Operation Procedures.</p>
        <div class="lib-cards">${lib.index.departments.map((d) => `
          <button type="button" class="lib-card" data-slug="${esc(d.slug)}">
            <strong>${esc(d.name)}</strong>
            <span>${esc(d.code)}${d.sections.length ? ` · ${d.sections.length} sections` : d.type === "pdf" ? " · PDF" : ""}</span>
          </button>`).join("")}
        </div>
      </div>`;
  }

  async function openDept(slug, push = true) {
    const d = lib.index.departments.find((x) => x.slug === slug);
    if (!d) { lib.current = null; renderSide(); renderHome(); return; }
    lib.current = slug;
    renderSide();
    $("libBack").hidden = false;
    $("libDeptTitle").textContent = GROUPS[slug] ? `${d.name} › ${GROUPS[slug][0].name} · ${GROUPS[slug][0].code}` : d.code ? `${d.name} · ${d.code}` : d.name;
    const box = $("libContent");
    if (push) history.replaceState(null, "", "#lib=" + encodeURIComponent(slug));

    if (d.type === "pdf") {
      box.innerHTML = `<div class="lib-pdf-note">This department only has a PDF so far.</div>
        <iframe class="lib-pdf" src="${esc(d.file)}" title="${esc(d.name)} SOP"></iframe>`;
      return;
    }
    box.innerHTML = `<p class="lib-loading">Loading ${esc(d.name)}…</p>`;
    try {
      if (!lib.cache.has(slug)) {
        const res = await fetch(d.file, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        lib.cache.set(slug, await res.text());
      }
      if (lib.current !== slug) return; // user picked another department meanwhile
      box.innerHTML = `<div class="sop-doc">${lib.cache.get(slug)}</div>`;
      if (slug === "general-admin") buildKitchenCharts(box.firstElementChild);
      if (slug === "human-resources") buildHrCharts(box.firstElementChild);
      box.scrollTop = 0;
    } catch (err) {
      box.innerHTML = `<p class="lib-error">Could not load this SOP (${esc(err.message)}).</p>`;
    }
  }

  /* ---------- Open / close ---------- */
  async function openLibrary(slug) {
    $("library").hidden = false;
    document.body.classList.add("lib-open");
    try {
      await loadIndex();
    } catch (err) {
      $("libDepts").innerHTML = "";
      $("libContent").innerHTML = `<p class="lib-error">The SOP Library is not available yet. Run <code>npm run convert</code> to build it. (${esc(err.message)})</p>`;
      return;
    }
    if (slug) openDept(slug, false);
    else { lib.current = null; renderSide(); renderHome(); history.replaceState(null, "", "#lib"); }
    $("libSearch").focus({ preventScroll: true });
  }

  function closeLibrary() {
    $("library").hidden = true;
    document.body.classList.remove("lib-open");
    if (location.hash.startsWith("#lib")) history.replaceState(null, "", location.pathname + location.search);
    $("libraryBtn").focus({ preventScroll: true });
  }

  function fromHash() {
    const h = location.hash;
    if (h === "#lib") openLibrary(null);
    else if (h.startsWith("#lib=")) openLibrary(decodeURIComponent(h.slice(5)));
  }

  /* ---------- Events ---------- */
  $("libraryBtn").addEventListener("click", () => openLibrary(lib.current));
  $("libClose").addEventListener("click", closeLibrary);
  function goHome() {
    lib.current = null; renderSide(); renderHome(); history.replaceState(null, "", "#lib");
    $("libContent").scrollTop = 0;
    document.querySelector(".lib-body").classList.remove("side-open");
  }
  $("libHome").addEventListener("click", goHome);
  $("libBack").addEventListener("click", goHome);
  $("libSearch").addEventListener("input", (e) => { lib.filter = e.target.value.trim(); renderSide(); });

  document.getElementById("library").addEventListener("click", (e) => {
    const grpBtn = e.target.closest("[data-group]");
    if (grpBtn) {
      const g = grpBtn.dataset.group;
      if (lib.open.has(g)) lib.open.delete(g); else lib.open.add(g);
      renderSide();
      return;
    }
    const deptBtn = e.target.closest("[data-slug]");
    if (deptBtn) { openDept(deptBtn.dataset.slug); return; }
    const sec = e.target.closest("[data-section]");
    if (sec) {
      e.preventDefault();
      const target = document.getElementById(sec.dataset.section);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector(".lib-body").classList.remove("side-open");
    }
  });
  $("libSideToggle").addEventListener("click", () => document.querySelector(".lib-body").classList.toggle("side-open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("library").hidden) closeLibrary();
  });
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();