/* SOP Tracker — reads data/sops.json and renders progress + PDF viewer. */
(() => {
  "use strict";

  const DATA_URL = "data/sops.json";
  const SHEET_KPI_URL = "https://docs.google.com/spreadsheets/d/1gAs71UXQI9kQzfSso17s9tllST6Pc7tGWp30UT9vedI/gviz/tq?tqx=out:json&sheet=Data";
  const SHEET_MASTER_URL = "https://docs.google.com/spreadsheets/d/1gAs71UXQI9kQzfSso17s9tllST6Pc7tGWp30UT9vedI/gviz/tq?tqx=out:json&sheet=MasterData";
  const $ = (id) => document.getElementById(id);

  const state = {
    data: null,
    dept: null,        // selected department name, or null for all
    status: "all",     // all | done | pending
    query: "",
    kpi: null,
    masterRows: [],
    groupOpen: false,  // General Admin sub-departments expanded in the table
  };

  /* ---------- Theme ---------- */
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("sop-theme"); } catch (_) {}
    if (saved) document.documentElement.dataset.theme = saved;
    $("themeBtn").addEventListener("click", () => {
      const current = document.documentElement.dataset.theme
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("sop-theme", next); } catch (_) {}
    });
  }

  /* ---------- Helpers ---------- */
  const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Encode each path segment so file names with spaces / # / % work on GitHub Pages
  function pdfUrl(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function countDept(d) {
    const total = d.sops.length;
    const done = d.sops.filter((s) => s.done).length;
    return { total, done, pending: total - done, pct: pct(done, total) };
  }

  function allSops() {
    return state.data.departments.flatMap((d) => d.sops.map((s) => ({ ...s, dept: d.name })));
  }

  /* ---------- Render ---------- */
  function renderSummary() {
    if (state.kpi) {
      $("statTotal").textContent = state.kpi.totalDepartments;
      $("statDone").textContent = state.kpi.finalizedDepartments;
      $("statOngoing").textContent = state.kpi.ongoingDepartments;
      $("statPending").textContent = state.kpi.pendingDepartments;
      $("statPct").textContent = state.kpi.overallProgress;
      $("statPctCard").textContent = state.kpi.overallProgress;
      $("overallBar").style.width = state.kpi.progressNumber + "%";
      $("gaugeFill").style.strokeDasharray = `${282.74 * state.kpi.progressNumber / 100} 282.74`;
      $("overallDonutValue").textContent = state.kpi.overallProgress;
      return;
    }
    const sops = allSops();
    const done = sops.filter((s) => s.done).length;
    const p = pct(done, sops.length);
    // Fallback (Google Sheet unavailable): derive department KPIs from local data.
    const depts = state.data.departments.map(countDept);
    $("statTotal").textContent = depts.length;
    $("statDone").textContent = depts.filter((c) => c.total && c.pct === 100).length;
    $("statOngoing").textContent = depts.filter((c) => c.pct > 0 && c.pct < 100).length;
    $("statPending").textContent = depts.filter((c) => c.pct === 0).length;
    $("statPct").textContent = p + "%";
    $("statPctCard").textContent = p + "%";
    $("gaugeFill").style.strokeDasharray = `${282.74 * p / 100} 282.74`;
    $("overallDonutValue").textContent = p + "%";
    $("overallBar").style.width = p + "%";
  }

  function parseSheetResponse(text) {
    const m = text.match(/setResponse\(([\s\S]*)\);?\s*$/);
    if (!m) throw new Error("Unexpected Google Sheets response");
    return JSON.parse(m[1]);
  }

  async function loadSheetKpi() {
    const res = await fetch(SHEET_KPI_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Google Sheets HTTP ${res.status}`);
    const payload = parseSheetResponse(await res.text());
    const rows = (payload.table.rows || []).map((r) => (r.c || []).map((c) => c ? { value: c.v, formatted: c.f } : { value: "", formatted: "" }));
    const values = {};
    rows.forEach(([label, value]) => { values[String(label.value || "").toLowerCase().replace(/[^a-z]/g, "")] = value; });
    const rawProgress = values.overallprogress?.formatted || values.overallprogress?.value || "0";
    const numericProgress = Number.parseFloat(String(rawProgress).replace("%", ""));
    const progressNumber = numericProgress <= 1 ? numericProgress * 100 : numericProgress;
    const progress = `${Math.round(progressNumber)}%`;
    state.kpi = {
      totalDepartments: values.totaldepartment?.value || 0,
      finalizedDepartments: values.totalfinalizeddepartment?.value || 0,
      ongoingDepartments: values.ongoingdepartment?.value || 0,
      pendingDepartments: values.pendingdepartment?.value || 0,
      overallProgress: progress,
      progressNumber,
    };
  }

  async function loadMasterData() {
    const res = await fetch(SHEET_MASTER_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Google Sheets MasterData HTTP ${res.status}`);
    const payload = parseSheetResponse(await res.text());
    const rows = (payload.table.rows || []).map((r) => (r.c || []).map((c) => c ? { value: c.v, formatted: c.f } : { value: "", formatted: "" }));
    const shortNames = { "hr department":"HR", "feed mill department":"F.Mill", "extension department":"Ext", "production department":"Prd", "quality department":"QA", "finished good department":"FG", "sale & marketing department":"S&M", "procurement department":"Prc", "maintenance department":"Main", "general stores department":"Gs", "finance department":"Fin", "security department":"Sec", "training and development department":"T&D", "general admin department":"GD", kitchen:"Kit", construction:"Con", landscaping:"Lnd", "transport department":"Trp", "automotive department":"Auto", "information technology department":"IT", "legal department":"Leg", "farm cordination":"F.Cor", "enterprise resource planning":"ERP", "management information system":"MIS", "live bird department":"LB" };
    const parsedRows = rows.map((r) => {
      const name = String(r[0]?.value || "").trim();
      const raw = r[6]?.formatted || r[6]?.value || "0";
      const n = Number.parseFloat(String(raw).replace("%", ""));
      const key = name.toLowerCase().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      return { name, short: String(r[7]?.value || shortNames[key] || ""), progress: Math.max(0, Math.min(100, n <= 1 ? n * 100 : n)), procedures: Number(r[4]?.value) || 0, sops: Number(r[1]?.value) || 0, date: String(r[5]?.formatted || r[5]?.value || "Not available") };
    }).filter((r) => r.name && r.name.toLowerCase() !== "total");
    const groupNames = new Set(["general admin department", "kitchen", "construction", "landscaping"]);
    const grouped = parsedRows.filter((r) => groupNames.has(r.name.toLowerCase()));
    const firstGroupIndex = parsedRows.findIndex((r) => groupNames.has(r.name.toLowerCase()));
    state.masterRows = parsedRows.filter((r) => !groupNames.has(r.name.toLowerCase()));
    if (grouped.length) {
      // In the sheet the General Admin row already holds the totals of its units (Kitchen,
      // Construction, Landscaping), so use its values as-is — adding the units again would double count.
      const main = grouped.find((r) => r.name.toLowerCase() === "general admin department");
      const units = grouped.filter((r) => r !== main);
      const src = main || { progress: units.reduce((sum, r) => sum + r.progress, 0) / (units.length || 1), procedures: units.reduce((sum, r) => sum + r.procedures, 0), sops: units.reduce((sum, r) => sum + r.sops, 0) };
      const ownDate = main && main.date !== "Not available" ? main.date : groupDate(units);
      const group = { name: "General Admin Department (including Kitchen / Construction / Landscaping)", short: "GD", progress: src.progress, procedures: src.procedures, sops: src.sops, date: ownDate, tableName: "General Admin Department", children: units };
      state.masterRows.splice(Math.max(0, firstGroupIndex), 0, group);
    }
  }

  function renderDeptChart() {
    const el = $("deptChart");
    if (!el || !state.masterRows.length) return;
    el.style.gridTemplateRows = `repeat(${state.masterRows.length}, minmax(0, 1fr))`;
    el.innerHTML = state.masterRows.map((r, i) => `<div class="dept-bar-wrap" style="--bar-index:${i}" data-name="${esc(r.name)}" data-progress="${Math.round(r.progress)}%" data-date="${esc(r.date)}"><div class="dept-bar-label">${esc(r.short || i + 1)}</div><div class="dept-bar-track"><div class="dept-bar" style="width:${Math.max(2, r.progress)}%"></div></div><div class="dept-bar-value">${Math.round(r.progress)}%</div></div>`).join("");
  }

  // One date if every grouped department shares it, otherwise "Various".
  function groupDate(rows) {
    const dates = [...new Set(rows.map((r) => r.date).filter((d) => d && d !== "Not available"))];
    return dates.length === 1 ? dates[0] : dates.length ? "Various" : "Not available";
  }

  function renderSopTable() {
    const body = $("sopTableBody");
    if (!body || !state.masterRows.length) return;
    const cell = (v) => `<td title="${esc(v)}">${esc(v)}</td>`;
    body.innerHTML = state.masterRows.map((r, i) => {
      if (!r.children?.length) return `<tr><td>${i + 1}</td>${cell(r.name)}<td>${r.sops}</td><td>${esc(r.date)}</td></tr>`;
      // Grouped row (General Admin): click to show the departments inside it.
      const open = state.groupOpen;
      // The main department is the group row itself, so only list the units under it.
      const subs = r.children.filter((c) => c.name.toLowerCase() !== (r.tableName || "").toLowerCase());
      const hint = "Includes: " + subs.map((c) => `${c.name} (${c.sops})`).join(", ");
      const parent = `<tr class="group-row${open ? " open" : ""}"><td>${i + 1}</td><td><button type="button" class="group-toggle" data-group-toggle aria-expanded="${open}" title="${esc(hint)}"><span class="group-name">${esc(r.tableName || r.name)}</span><span class="caret" aria-hidden="true">▸</span></button></td><td>${r.sops}</td><td>${esc(r.date)}</td></tr>`;
      const kids = subs.map((c, j) => `<tr class="sub-row"${open ? "" : " hidden"}><td>${i + 1}.${j + 1}</td><td title="${esc(c.name)}"><span class="sub-mark" aria-hidden="true">↳</span>${esc(c.name)}</td><td>${c.sops}</td><td>${esc(c.date)}</td></tr>`).join("");
      return parent + kids;
    }).join("");
    const total = state.masterRows.reduce((sum, r) => sum + r.sops, 0);
    $("sopTableTotal").textContent = total;
  }

  function renderProcedureChart() {
    const el = $("procedureChart");
    if (!el || !state.masterRows.length) return;
    const max = Math.max(...state.masterRows.map((r) => r.procedures), 1);
    el.innerHTML = state.masterRows.map((r, i) => `<div class="procedure-column-wrap" style="--bar-index:${i}" data-name="${esc(r.name)}" data-procedures="${r.procedures}" data-date="${esc(r.date)}"><div class="procedure-column-value">${r.procedures}</div><div class="procedure-column" style="height:${Math.max(2, r.procedures / max * 100)}%"></div><div class="procedure-column-label">${esc(r.short || i + 1)}</div></div>`).join("");
  }

  function renderDepts() {
    const grid = $("deptGrid");
    grid.innerHTML = state.data.departments.map((d) => {
      const c = countDept(d);
      const cls = ["dept-card", "card",
        c.pct === 100 ? "complete" : "",
        c.pct < 50 ? "low" : "",
        state.dept === d.name ? "active" : ""].join(" ");
      return `
        <button class="${cls}" data-dept="${esc(d.name)}">
          <span class="dept-name">${esc(d.name)}</span>
          <div class="bar"><div class="bar-fill" style="width:${c.pct}%"></div></div>
          <span class="dept-meta"><span><strong>${c.done}</strong> / ${c.total} done</span><strong>${c.pct}%</strong></span>
        </button>`;
    }).join("");
    $("clearDept").hidden = !state.dept;
  }

  function matches(s) {
    if (state.status === "done" && !s.done) return false;
    if (state.status === "pending" && s.done) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      if (!(`${s.code} ${s.title}`.toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function rowHtml(s) {
    const canView = s.done && s.pdf;
    const action = canView
      ? `<button class="btn" data-view="${esc(s.dept)}::${esc(s.code || s.title)}">View</button>`
      : `<span class="btn-placeholder"></span>`;
    return `
      <div class="sop-row">
        <span class="code">${esc(s.code || "—")}</span>
        <span class="sop-title">${esc(s.title)}</span>
        <span class="badge ${s.done ? "done" : "pending"}">${s.done ? "Completed" : "Pending"}</span>
        ${action}
      </div>`;
  }

  function renderList() {
    const depts = state.dept
      ? state.data.departments.filter((d) => d.name === state.dept)
      : state.data.departments;

    $("listTitle").textContent = state.dept ? `${state.dept} SOPs` : "All SOPs";

    let shown = 0;
    const html = depts.map((d) => {
      const rows = d.sops.map((s) => ({ ...s, dept: d.name })).filter(matches);
      shown += rows.length;
      if (!rows.length) return "";
      return `
        <div class="group">
          ${state.dept ? "" : `<h3 class="group-title">${esc(d.name)}</h3>`}
          <div class="group-rows card">${rows.map(rowHtml).join("")}</div>
        </div>`;
    }).join("");

    $("sopList").innerHTML = html;
    $("emptyMsg").hidden = shown > 0;
  }

  function renderAll() {
    renderSummary();
    renderDepts();
    renderList();
  }

  /* ---------- Viewer ---------- */
  function findSop(key) {
    const [dept, id] = key.split("::");
    const d = state.data.departments.find((x) => x.name === dept);
    const s = d && d.sops.find((x) => (x.code || x.title) === id);
    return s ? { ...s, dept } : null;
  }

  function openViewer(key, push = true) {
    const s = findSop(key);
    if (!s || !s.pdf) return;
    const url = pdfUrl(s.pdf);
    $("viewerCode").textContent = `${s.code ? s.code + " · " : ""}${s.dept}`;
    $("viewerTitle").textContent = s.title;
    $("viewerFrame").src = url;
    $("viewerOpen").href = url;
    $("viewerDownload").href = url;
    $("viewer").hidden = false;
    document.body.style.overflow = "hidden";
    if (push) location.hash = "sop=" + encodeURIComponent(key);
  }

  function closeViewer() {
    $("viewer").hidden = true;
    $("viewerFrame").src = "about:blank";
    document.body.style.overflow = "";
    if (location.hash.startsWith("#sop=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function handleHash() {
    const h = location.hash;
    if (h.startsWith("#sop=")) openViewer(decodeURIComponent(h.slice(5)), false);
    else if (!$("viewer").hidden) closeViewer();
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    const sopTableBody = $("sopTableBody");
    if (sopTableBody) sopTableBody.addEventListener("click", (e) => {
      if (!e.target.closest("[data-group-toggle]")) return;
      state.groupOpen = !state.groupOpen;
      renderSopTable();
      if (state.groupOpen) sopTableBody.querySelector(".sub-row:last-of-type, .sub-row")?.scrollIntoView({ block: "nearest" });
    });
    $("deptGrid").addEventListener("click", (e) => {
      const card = e.target.closest("[data-dept]");
      if (!card) return;
      state.dept = state.dept === card.dataset.dept ? null : card.dataset.dept;
      renderDepts();
      renderList();
    });

    $("clearDept").addEventListener("click", () => {
      state.dept = null;
      renderDepts();
      renderList();
    });

    $("search").addEventListener("input", (e) => {
      state.query = e.target.value.trim();
      renderList();
    });

    document.querySelectorAll(".seg-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
        state.status = b.dataset.status;
        renderList();
      }));

    $("sopList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (btn) openViewer(btn.dataset.view);
    });

    $("viewerClose").addEventListener("click", closeViewer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("viewer").hidden) closeViewer();
    });
    window.addEventListener("hashchange", handleHash);
  }

  /* ---------- Load ---------- */
  async function load() {
    state.data = { departments: [] };
    const [localResult, sheetResult, masterResult] = await Promise.allSettled([
      fetch(DATA_URL, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      loadSheetKpi(),
      loadMasterData(),
    ]);

    if (localResult.status === "fulfilled") {
      const data = localResult.value;
      data.departments = (data.departments || []).map((d) => ({ ...d, sops: d.sops || [] }));
      state.data = data;
      if (data.title) document.title = "Standard Operation Procedure";
      $("companyName").textContent = "Imo Chicken & Agro (Pvt) Ltd.";
      $("lastUpdated").textContent = data.lastUpdated || "–";
    }

    if (sheetResult.status === "fulfilled") {
      $("companyName").textContent = "Imo Chicken & Agro (Pvt) Ltd.";
      $("loadError").hidden = true;
    } else if (localResult.status === "rejected") {
      const el = $("loadError");
      el.hidden = false;
      el.textContent = `Could not load the Google Sheet or local SOP data. ${sheetResult.reason?.message || "Check the connection."}`;
    }

    renderAll();
    renderDeptChart();
    renderProcedureChart();
    renderSopTable();
    bindChartTooltip("procedureChart", "procedureTooltip", ".procedure-column-wrap",
      (d) => [`Procedures: ${d.procedures}`, `Last updated: ${d.date}`]);
    bindChartTooltip("deptChart", "deptTooltip", ".dept-bar-wrap",
      (d) => [`Progress: ${d.progress}`, `Last updated: ${d.date}`]);
    handleHash();
  }

  // Shared hover tooltip for both charts. Values are escaped (they come from the Google Sheet).
  function bindChartTooltip(chartId, tooltipId, itemSelector, lines) {
    const chart = $(chartId);
    const tooltip = $(tooltipId);
    if (!chart || !tooltip) return;
    chart.addEventListener("mousemove", (e) => {
      const item = e.target.closest(itemSelector);
      if (!item) { tooltip.hidden = true; return; }
      tooltip.innerHTML = `<strong>${esc(item.dataset.name)}</strong>` +
        lines(item.dataset).map((l) => `<span>${esc(l)}</span>`).join("");
      tooltip.hidden = false;
      const panelRect = chart.parentElement.getBoundingClientRect();
      const left = e.clientX + 215 > window.innerWidth ? e.clientX - panelRect.left - 205 : e.clientX - panelRect.left + 12;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(8, e.clientY - panelRect.top - 76)}px`;
    });
    chart.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  }

  initTheme();
  bindEvents();
  load();
})();
