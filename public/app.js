// 서울 전월세 가격 분석 — 프론트엔드
// 브라우저는 /api/rent(Cloudflare Worker)만 호출하며 서울시 API 키를 알지 못합니다.
"use strict";

const YEARS = [2022, 2023, 2024, 2025, 2026];
const MIN_N = 3; // 월별 중위값을 표시하기 위한 최소 거래 건수
const RATE = 0.05; // 전월세 전환율 5% — 전세환산 보증금 = 보증금 + 월세×12÷전환율
const SLATE = "#64748b";
const ALL = "all"; // 법정동 대신 자치구 전체 조회
const conv = (dep, rent) => dep + ((rent || 0) * 12) / RATE;
const MINT = "#14b8a6";
const NEUTRAL = "#a9b1ba";
const GRID = "#efede8";
const INK2 = "#57606a";

const $ = (s) => document.querySelector(s);
const state = { districts: [], rows: [], meta: [], usg: "", metric: "deposit", gu: null, dong: null, charts: {} };

// ---------- 유틸 ----------
const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const won = (v) => {
  if (v == null || isNaN(v)) return "–";
  v = Math.round(v);
  if (Math.abs(v) >= 10000) {
    const eok = Math.floor(v / 10000), man = v % 10000;
    return man ? `${eok}억 ${man.toLocaleString()}만` : `${eok}억`;
  }
  return `${v.toLocaleString()}만`;
};
const pct = (a, b) => (a == null || b == null || !b ? null : ((a - b) / b) * 100);
const pctHtml = (p) => p == null ? "–" : `<span class="${p >= 0 ? "up" : "down"}">${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}%</span>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ym = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}`;
const fmtDay = (d) => `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;

function setStatus(html, err = false) {
  const el = $("#status");
  el.className = "status" + (err ? " err" : "");
  el.innerHTML = html;
}

// ---------- 지역 선택 ----------
async function initDistricts() {
  state.districts = await (await fetch("districts.json")).json();
  const gu = $("#gu");
  for (const d of state.districts) gu.add(new Option(d.name, d.code));
  gu.addEventListener("change", () => {
    fillDongs(gu.value);
    if (gu.value) map.highlight(gu.value, ALL); else map.highlight("", "");
    updatePicked();
  });
  $("#dong").addEventListener("change", () => {
    map.highlight(gu.value, $("#dong").value);
    updatePicked();
  });
  $("#load").addEventListener("click", load);

  await map.init();

  // ?gu=11680&dong=10300 (법정동) 또는 ?gu=11680 (자치구 전체) 링크로 바로 열기
  const p = new URLSearchParams(location.search);
  if (/^\d{5}$/.test(p.get("gu") || "")) select(p.get("gu"), /^\d{5}$/.test(p.get("dong") || "") ? p.get("dong") : ALL, true);
}

function fillDongs(guCode) {
  const dong = $("#dong");
  dong.innerHTML = "";
  const d = state.districts.find((x) => x.code === guCode);
  if (!d) { dong.add(new Option("먼저 자치구를 선택하세요", "")); dong.disabled = true; return; }
  dong.add(new Option("자치구 전체", ALL));
  for (const x of d.dongs) dong.add(new Option(x.name, x.code));
  dong.disabled = false;
}

function updatePicked() {
  const g = state.districts.find((x) => x.code === $("#gu").value);
  const d = g?.dongs.find((x) => x.code === $("#dong").value);
  const all = g && $("#dong").value === ALL;
  $("#picked").innerHTML = d ? `선택: <b>${esc(g.name)} ${esc(d.name)}</b>` : all ? `선택: <b>${esc(g.name)} 전체</b> <span class="muted">(자치구 단위)</span>` : "선택된 지역 없음";
  $("#load").disabled = !(d || all);
}

// 지도·드롭다운 어느 쪽에서 골라도 같은 상태가 되도록 동기화
function select(guCode, dongCode, autoload) {
  $("#gu").value = guCode;
  fillDongs(guCode);
  $("#dong").value = dongCode;
  map.highlight(guCode, $("#dong").value);
  updatePicked();
  if (autoload && !$("#load").disabled) load();
}

// ---------- 지도 (Leaflet + 브이월드 법정동 경계) ----------
const map = {
  m: null, layers: {}, selected: null,
  base: { color: "#7f8c8a", weight: 0.6, opacity: 0.7, fillColor: "#14b8a6", fillOpacity: 0.04 },
  hover: { color: "#0f8f82", weight: 2, opacity: 1, fillColor: "#14b8a6", fillOpacity: 0.25 },
  pick: { color: "#0b6f65", weight: 2.5, opacity: 1, fillColor: "#14b8a6", fillOpacity: 0.5 },
  guBase: { color: "#4b5755", weight: 1.8, opacity: 0.8, fill: false },
  guPick: { color: "#0b6f65", weight: 3, opacity: 1, fill: true, fillColor: "#14b8a6", fillOpacity: 0.28 },
  async init() {
    if (!window.L) return;
    this.m = L.map("map", { zoomSnap: 0.25, minZoom: 10, maxZoom: 16, scrollWheelZoom: false, attributionControl: true }).setView([37.5665, 126.978], 10.75);
    this.m.attributionControl.setPrefix(false).addAttribution("배경지도·경계: 브이월드");
    // 브이월드 배경지도(white) — 인증키가 필요 없는 xdworld 타일 서버를 사용합니다.
    L.tileLayer("https://xdworld.vworld.kr/2d/white/service/{z}/{x}/{y}.png", { opacity: 0.55, minZoom: 9, maxZoom: 18, maxNativeZoom: 18, bounds: [[37.38, 126.7], [37.75, 127.3]] }).addTo(this.m);
    this.m.on("focus", () => this.m.scrollWheelZoom.enable());
    this.m.on("blur", () => this.m.scrollWheelZoom.disable());

    const [dong, gu] = await Promise.all([fetch("dong.geojson").then((r) => r.json()), fetch("gu.geojson").then((r) => r.json())]);
    this.dongLayer = L.geoJSON(dong, {
      style: () => this.base,
      onEachFeature: (f, layer) => {
        const p = f.properties;
        this.layers[p.g + p.d] = layer;
        layer.bindTooltip(`${p.gn} <b>${p.n}</b>`, { sticky: true, className: "dong-tip", direction: "top", offset: [0, -6] });
        layer.on({
          mouseover: () => { if (this.selected !== layer) layer.setStyle(this.hover); },
          mouseout: () => { if (this.selected !== layer) layer.setStyle(this.base); },
          click: () => select(p.g, p.d, true),
        });
      },
    }).addTo(this.m);
    this.guLayer = L.geoJSON(gu, { style: () => this.guBase, interactive: false }).addTo(this.m);
    this.guBounds = {}; this.guLayers = {};
    this.guLayer.eachLayer((l) => {
      const p = l.feature.properties;
      this.guBounds[p.g] = l.getBounds();
      this.guLayers[p.g] = l;
      L.tooltip({ permanent: true, direction: "center", className: "gu-label", interactive: false })
        .setLatLng(l.getBounds().getCenter()).setContent(p.gn).addTo(this.m);
    });
    this.m.fitBounds(this.guLayer.getBounds(), { padding: [8, 8] });
    this.m.setMaxBounds(this.guLayer.getBounds().pad(0.3));
  },
  highlight(guCode, dongCode) {
    if (!this.m) return;
    if (this.selected) this.selected.setStyle(this.base);
    if (this.selectedGu) this.selectedGu.setStyle(this.guBase);
    this.selected = null; this.selectedGu = null;
    if (dongCode === ALL) {
      this.selectedGu = this.guLayers[guCode] || null;
      this.selectedGu?.setStyle(this.guPick);
      this.focusGu(guCode);
      return;
    }
    this.selected = this.layers[guCode + dongCode] || null;
    if (this.selected) {
      this.selected.setStyle(this.pick).bringToFront();
      this.guLayer.bringToFront();
      const b = this.selected.getBounds();
      if (!this.m.getBounds().contains(b) || this.m.getZoom() < 12) this.m.flyToBounds(this.guBounds[guCode] || b, { padding: [20, 20], duration: 0.5 });
    }
  },
  focusGu(guCode) {
    if (this.m && this.guBounds?.[guCode]) this.m.flyToBounds(this.guBounds[guCode], { padding: [20, 20], duration: 0.5 });
  },
};

// ---------- 데이터 로드 (2022~2026 전 연도) ----------
async function load() {
  const guCode = $("#gu").value, dongCode = $("#dong").value;
  const gu = state.districts.find((x) => x.code === guCode);
  const dong = dongCode === ALL ? null : gu?.dongs.find((x) => x.code === dongCode);
  if (!gu || (!dong && dongCode !== ALL)) return;
  state.gu = gu; state.dong = dong;
  const label = `${esc(gu.name)} ${dong ? esc(dong.name) : "전체"}`;
  history.replaceState(null, "", dong ? `?gu=${guCode}&dong=${dongCode}` : `?gu=${guCode}`);
  $("#load").disabled = true;

  // 연도별 첫 조각(chunk 0)을 받은 뒤, 자치구 전체처럼 큰 경우 나머지 조각을 이어서 받습니다.
  let loaded = 0; const totals = {};
  const progress = () => {
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    const pctDone = Object.keys(totals).length < YEARS.length ? Math.min(loaded / Math.max(sum, 1), 0.1) : loaded / Math.max(sum, 1);
    setStatus(`<b>${label}</b> 2022–2026년 데이터를 불러오는 중… ${sum ? `(${loaded.toLocaleString()} / ${sum.toLocaleString()}건)` : ""}${dong ? "" : "<br><span class=\"muted\">자치구 전체는 거래가 많아 수십 초 걸릴 수 있습니다.</span>"}<div class="bar"><i></i></div>`);
    $("#status .bar i").style.width = `${Math.round(pctDone * 100)}%`;
  };
  const getPart = async (y, chunk) => {
    const r = await fetch(`/api/rent?gu=${guCode}&dong=${dong ? dongCode : ""}&year=${y}&chunk=${chunk}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    totals[y] = j.total; loaded += j.rows.length; progress();
    return j;
  };
  // 동시에 3개 요청까지만 (서울시 API 부하 완화)
  const pool = async (tasks, n = 3) => {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
    return out;
  };
  progress();
  try {
    const firsts = await pool(YEARS.map((y) => () => getPart(y, 0)));
    const more = firsts.flatMap((f) => Array.from({ length: f.chunks - 1 }, (_, k) => () => getPart(f.year, k + 1)));
    const parts = firsts.concat(await pool(more));
    const rows = [];
    for (const r of parts) {
      const idx = Object.fromEntries(r.fields.map((k, i) => [k, i]));
      for (const a of r.rows) {
        rows.push({
          dong: a[idx.STDG_NM], day: a[idx.CTRT_DAY], type: a[idx.RENT_SE], area: a[idx.RENT_AREA], dep: a[idx.GRFE], rent: a[idx.RTFE],
          bldg: a[idx.BLDG_NM], usg: a[idx.BLDG_USG], flr: a[idx.FLR], built: a[idx.ARCH_YR], renew: a[idx.NEW_UPDT_YN], rcpt: a[idx.RCPT_YR],
        });
      }
    }
    state.rows = rows.filter((r) => r.day && r.day.length === 8 && r.dep != null);
    for (const r of state.rows) r.conv = conv(r.dep, r.rent);
    state.meta = firsts.map((r) => ({ year: r.year, total: r.total }));
    if (!state.rows.length) {
      setStatus(`${label}에는 조회된 거래가 없습니다.`);
      $("#result").hidden = true;
    } else {
      setStatus(`<b>${label}</b> · 총 ${state.rows.length.toLocaleString()}건 불러옴 (접수연도 ${state.meta.map((m) => `${m.year}: ${m.total.toLocaleString()}`).join(" · ")})`);
      $("#result").hidden = false;
      render();
    }
  } catch (e) {
    setStatus(`데이터를 불러오지 못했습니다: ${esc(e.message)}`, true);
  } finally {
    $("#load").disabled = false;
  }
}

// ---------- 분석 ----------
function filtered() {
  return state.usg ? state.rows.filter((r) => r.usg === state.usg) : state.rows;
}

function monthly(rows) {
  const months = [...new Set(rows.map((r) => ym(r.day)))].sort();
  if (!months.length) return [];
  // 첫 달~마지막 달 사이 빈 달도 채워 넣기
  const out = [];
  let [y, m] = months[0].split("-").map(Number);
  const [ly, lm] = months[months.length - 1].split("-").map(Number);
  const by = {};
  for (const r of rows) (by[ym(r.day)] ||= []).push(r);
  while (y < ly || (y === ly && m <= lm)) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const g = by[key] || [];
    const j = g.filter((r) => r.type === "전세"), w = g.filter((r) => r.type === "월세");
    out.push({
      key,
      nJ: j.length, nW: w.length,
      dep: j.length >= MIN_N ? median(j.map((r) => r.dep)) : null,
      perm2: j.length >= MIN_N ? median(j.filter((r) => r.area > 0).map((r) => r.dep / r.area)) : null,
      rent: w.length >= MIN_N ? median(w.map((r) => r.rent)) : null,
      conv: g.length >= MIN_N ? median(g.map((r) => r.conv)) : null,
      convW: w.length >= MIN_N ? median(w.map((r) => r.conv)) : null,
      n: g.length,
    });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function windowStats(rows, endKey, back) {
  // endKey(YYYY-MM)로 끝나는 12개월 구간(back=1이면 그 이전 12개월)
  const [ey, em] = endKey.split("-").map(Number);
  const endIdx = ey * 12 + em - 1 - back * 12;
  const inWin = rows.filter((r) => {
    const i = Number(r.day.slice(0, 4)) * 12 + Number(r.day.slice(4, 6)) - 1;
    return i <= endIdx && i > endIdx - 12;
  });
  const j = inWin.filter((r) => r.type === "전세"), w = inWin.filter((r) => r.type === "월세");
  return {
    n: inWin.length,
    dep: median(j.map((r) => r.dep)),
    perm2: median(j.filter((r) => r.area > 0).map((r) => r.dep / r.area)),
    rent: median(w.map((r) => r.rent)),
    wdep: median(w.map((r) => r.dep)),
  };
}

function render() {
  const rows = filtered();
  const mon = monthly(rows);
  renderKpis(rows, mon);
  renderCharts(mon);
  renderYearTable(rows);
  renderTx();
  renderNotes(rows);
}

function renderKpis(rows, mon) {
  if (!rows.length) { $("#kpis").innerHTML = `<div class="kpi"><div class="l">해당 용도의 거래가 없습니다</div></div>`; return; }
  const last = mon[mon.length - 1].key;
  const cur = windowStats(rows, last, 0), prev = windowStats(rows, last, 1);
  const nJ = rows.filter((r) => r.type === "전세").length;
  const share = (nJ / rows.length) * 100;
  const vs = "직전 12개월 대비";
  $("#kpis").innerHTML = `
    <div class="kpi"><div class="l">총 거래 건수</div><div class="v">${rows.length.toLocaleString()}건</div><div class="d">전세 비중 ${share.toFixed(0)}%</div></div>
    <div class="kpi hl"><div class="l">전세 보증금 중위값 (최근 12개월)</div><div class="v">${won(cur.dep)}</div><div class="d">${pctHtml(pct(cur.dep, prev.dep))} ${vs}</div></div>
    <div class="kpi"><div class="l">전세 ㎡당 보증금 (최근 12개월)</div><div class="v">${won(cur.perm2)}</div><div class="d">${pctHtml(pct(cur.perm2, prev.perm2))} ${vs}</div></div>
    <div class="kpi"><div class="l">월세 중위값 (최근 12개월)</div><div class="v">${cur.rent == null ? "–" : cur.rent.toLocaleString() + "만"}</div><div class="d">${pctHtml(pct(cur.rent, prev.rent))} · 보증금 ${won(cur.wdep)}</div></div>`;
}

function baseOpts(yFmt) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#fff", titleColor: "#1f2328", bodyColor: "#1f2328", borderColor: "#e8e6e1", borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true,
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: INK2, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { grid: { color: GRID }, border: { display: false }, ticks: { color: INK2, callback: yFmt }, beginAtZero: false },
    },
  };
}

function upsert(id, config) {
  state.charts[id]?.destroy();
  state.charts[id] = new Chart(document.getElementById(id), config);
}

function renderCharts(mon) {
  const labels = mon.map((m) => m.key);
  const isPerm = state.metric === "perm2";
  const o1 = baseOpts((v) => won(v));
  o1.plugins.tooltip.callbacks = {
    label: (c) => ` ${isPerm ? "㎡당 " : ""}중위 ${won(c.parsed.y)}`,
    afterLabel: (c) => ` 전세 ${mon[c.dataIndex].nJ}건`,
  };
  upsert("c1", {
    type: "line",
    data: { labels, datasets: [{ data: mon.map((m) => (isPerm ? m.perm2 : m.dep)), borderColor: MINT, backgroundColor: MINT, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2, spanGaps: true, tension: 0.25 }] },
    options: o1,
  });

  const o2 = baseOpts((v) => v.toLocaleString());
  o2.scales.x.stacked = true; o2.scales.y.stacked = true; o2.scales.y.beginAtZero = true;
  o2.plugins.legend = { display: true, position: "top", align: "end", labels: { color: INK2, usePointStyle: true, pointStyle: "rectRounded", boxWidth: 10 } };
  o2.plugins.tooltip.callbacks = { label: (c) => ` ${c.dataset.label} ${c.parsed.y.toLocaleString()}건` };
  upsert("c2", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "전세", data: mon.map((m) => m.nJ), backgroundColor: MINT, borderColor: "#fff", borderWidth: { top: 2 }, borderRadius: 3, borderSkipped: "bottom" },
        { label: "월세", data: mon.map((m) => m.nW), backgroundColor: NEUTRAL, borderColor: "#fff", borderWidth: { top: 2 }, borderRadius: 3, borderSkipped: "bottom" },
      ],
    },
    options: o2,
  });

  const o4 = baseOpts((v) => won(v));
  o4.plugins.legend = { display: true, position: "top", align: "end", labels: { color: INK2, usePointStyle: true, pointStyle: "line", boxWidth: 18 } };
  o4.plugins.tooltip.callbacks = {
    label: (c) => ` ${c.dataset.label} ${won(c.parsed.y)}`,
    afterBody: (items) => { const m = mon[items[0].dataIndex]; return [`전체 ${m.n}건 · 월세 ${m.nW}건`]; },
  };
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2, spanGaps: true, tension: 0.25, ...extra });
  upsert("c4", {
    type: "line",
    data: { labels, datasets: [line("전체 거래 (환산)", mon.map((m) => m.conv), MINT), line("월세 거래만 (환산)", mon.map((m) => m.convW), SLATE, { borderDash: [5, 4] })] },
    options: o4,
  });

  const o3 = baseOpts((v) => `${v.toLocaleString()}만`);
  o3.plugins.tooltip.callbacks = {
    label: (c) => ` 월세 중위 ${c.parsed.y.toLocaleString()}만원`,
    afterLabel: (c) => ` 월세 ${mon[c.dataIndex].nW}건`,
  };
  upsert("c3", {
    type: "line",
    data: { labels, datasets: [{ data: mon.map((m) => m.rent), borderColor: MINT, backgroundColor: MINT, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2, spanGaps: true, tension: 0.25 }] },
    options: o3,
  });
}

function renderYearTable(rows) {
  const years = [...new Set(rows.map((r) => r.day.slice(0, 4)))].sort();
  // 접수연도 데이터가 없는 해(예: 2023)의 계약은 다음 해 신고분 일부만 있으므로 '부분'으로 표시
  const firstRcpt = Math.min(...state.meta.filter((m) => m.total > 0).map((m) => m.year));
  let prevDep = null;
  const body = years.map((y) => {
    const partial = Number(y) < firstRcpt;
    const g = rows.filter((r) => r.day.startsWith(y));
    const j = g.filter((r) => r.type === "전세"), w = g.filter((r) => r.type === "월세");
    const dep = median(j.map((r) => r.dep));
    const ch = partial ? null : pct(dep, prevDep); prevDep = partial ? null : dep;
    const cv = median(g.map((r) => r.conv));
    const renew = g.length ? (g.filter((r) => r.renew === "갱신").length / g.length) * 100 : 0;
    return `<tr><td>${y}년${partial ? ' <span class="tag m">부분</span>' : ""}</td><td>${g.length.toLocaleString()}</td><td>${j.length.toLocaleString()}</td><td>${won(dep)}</td>
      <td class="d">${ch == null ? "–" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}</td>
      <td>${won(median(j.filter((r) => r.area > 0).map((r) => r.dep / r.area)))}</td>
      <td>${w.length.toLocaleString()}</td><td>${won(median(w.map((r) => r.dep)))}</td><td>${(median(w.map((r) => r.rent)) ?? "–").toLocaleString()}만</td><td>${won(cv)}</td>
      <td>${renew.toFixed(0)}%</td></tr>`;
  }).join("");
  $("#ytable").innerHTML = `<thead><tr><th>계약연도</th><th>전체 건수</th><th>전세 건수</th><th>전세 중위 보증금</th><th>전년 대비</th><th>전세 ㎡당</th><th>월세 건수</th><th>월세 중위 보증금</th><th>월세 중위</th><th>전세환산 중위</th><th>갱신 비율</th></tr></thead><tbody>${body}</tbody>`;
}

function renderTx() {
  const q = $("#q").value.trim();
  let rows = filtered();
  if (q) rows = rows.filter((r) => r.bldg.includes(q) || (r.dong || "").includes(q));
  rows = rows.slice().sort((a, b) => b.day.localeCompare(a.day));
  const shown = rows.slice(0, 200);
  $("#ttable").innerHTML = `<thead><tr><th>계약일</th><th>구분</th><th>법정동</th><th>건물명</th><th>용도</th><th>면적(㎡)</th><th>층</th><th>보증금</th><th>월세</th><th>신규/갱신</th></tr></thead><tbody>${
    shown.map((r) => `<tr><td>${fmtDay(r.day)}</td><td class="t"><span class="tag ${r.type === "월세" ? "m" : ""}">${esc(r.type)}</span></td>
      <td class="t">${esc(r.dong || "-")}</td><td class="t">${esc(r.bldg || "-")}</td><td class="t">${r.usg === "공공임대" ? '<span class="tag p">공공임대</span>' : esc(r.usg)}</td><td>${r.area ?? "-"}</td><td>${r.flr ?? "-"}</td>
      <td>${won(r.dep)}</td><td>${r.rent ? r.rent.toLocaleString() + "만" : "-"}</td><td class="t">${esc(r.renew || "-")}</td></tr>`).join("")
  }</tbody>`;
  $("#tnote").textContent = `${rows.length.toLocaleString()}건 중 최근 ${shown.length.toLocaleString()}건 표시 · 전체는 CSV로 내려받을 수 있습니다.`;
}

function renderNotes(rows) {
  const empty = state.meta.filter((m) => m.total === 0).map((m) => m.year);
  const first = rows.length ? rows.reduce((a, r) => (r.day < a ? r.day : a), "99999999") : null;
  const notes = [
    `2022–2026년 모든 접수연도를 API로 요청했습니다. ${empty.length ? `서울시 API는 현재 ${empty.join("·")}년 접수분을 제공하지 않아(응답: “해당하는 데이터가 없습니다”) ` : ""}실제 계약일 기준 데이터는 ${first ? fmtDay(first) : "-"}부터입니다. 2023년 계약은 2024년에 신고된 일부만 포함되어 건수가 적습니다.`,
    "서울시 전월세 데이터는 법정동 단위로 제공되어 법정동 기준으로 선택합니다. 지도 경계는 브이월드 법정동 경계입니다.",
    "행복주택·국민임대·영구임대·장기전세·LH/SH 단지·역세권청년주택 등 공공(지원)임대 주택은 ‘아파트’ 등에서 빼고 ‘공공임대’로 따로 분류했습니다. 데이터에 공공임대 여부 항목이 없어 건물명(예: 행복주택, (임대), LH, 엘에이치, SH, 휴먼시아, 청년주택)으로 판별하므로 일부 누락·오분류가 있을 수 있습니다.",
    `가격은 중위값(median)입니다. 해당 월 거래가 ${MIN_N}건 미만이면 그래프에서 생략합니다. 금액 단위는 만원입니다.`,
    "전세환산 보증금 = 보증금 + 월세 × 12 ÷ 전환율(5%). 전세 거래는 보증금 그대로이고, 월세 거래는 월세를 보증금으로 환산해 더합니다.",
    "‘최근 12개월’은 데이터의 마지막 계약월로 끝나는 12개월이며, 직전 12개월과 비교합니다.",
  ];
  $("#notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
}

function downloadCsv() {
  const head = ["법정동", "계약일", "구분", "건물명", "용도", "면적_㎡", "층", "보증금_만원", "월세_만원", "전세환산보증금_만원", "건축년도", "신규갱신", "접수연도"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")].concat(
    filtered().slice().sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => [r.dong, r.day, r.type, r.bldg, r.usg, r.area, r.flr, r.dep, r.rent, Math.round(r.conv), r.built, r.renew, r.rcpt].map(q).join(","))
  );
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `seoul_rent_${state.gu.name}_${state.dong ? state.dong.name : "전체"}_2022-2026${state.usg ? "_" + state.usg : ""}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 첫 화면: 자치구 전세환산 보증금 TOP 10 ----------
const top10 = { data: null, type: "전체", metric: "median" };
async function initTop10() {
  try {
    top10.data = await (await fetch("top10.json")).json();
  } catch { $("#top10").hidden = true; return; }
  const d = top10.data;
  $("#t10period").textContent = `${d.period[0].replace("-", ".")}–${d.period[1].replace("-", ".")} 계약 · 전환율 ${d.rate * 100}%`;
  $("#t10note").textContent = `서울 전체 ${d.rows.toLocaleString()}건(최근 12개월 계약)의 자치구·유형별 중위값입니다. ‘전체’는 공공임대를 포함한 모든 유형의 거래입니다. 거래 ${d.min_n}건 미만인 자치구는 제외했습니다. 자치구를 누르면 해당 자치구 전체를 조회합니다. (집계일 ${d.generated})`;
  renderTop10();
}
function renderTop10() {
  const items = (top10.data.types[top10.type] || []).filter((x) => x[top10.metric] != null)
    .sort((a, b) => b[top10.metric] - a[top10.metric]).slice(0, 10);
  const max = items[0]?.[top10.metric] || 1;
  $("#t10list").innerHTML = items.length ? items.map((x, i) => {
    const g = state.districts.find((d) => d.name === x.gu);
    return `<li tabindex="0" data-gu="${g ? g.code : ""}" title="${esc(x.gu)} — 지도에서 보기">
      <span class="no">${i + 1}</span><span class="gu">${esc(x.gu)}</span>
      <span class="track"><span class="fill" data-w="${((x[top10.metric] / max) * 100).toFixed(1)}"></span></span>
      <span class="val">${won(x[top10.metric])}${top10.metric === "perm2" ? "/㎡" : ""}<small>${x.n.toLocaleString()}건</small></span></li>`;
  }).join("") : `<li class="muted">해당 유형의 데이터가 부족합니다.</li>`;
  // CSP(style-src 'self')로 인라인 style 속성이 막히므로 CSSOM으로 너비 지정
  $("#t10list").querySelectorAll(".fill").forEach((el) => { el.style.width = el.dataset.w + "%"; });
}
function pickGuFromRank(e) {
  const li = e.target.closest("li[data-gu]");
  if (!li || !li.dataset.gu) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  select(li.dataset.gu, ALL, true);
  $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("#t10list").addEventListener("click", pickGuFromRank);
$("#t10list").addEventListener("keydown", pickGuFromRank);

// ---------- 이벤트 ----------
function segment(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state[key] = b.dataset.v;
    after();
  });
}
segment("#usg", "usg", render);
segment("#t10type", "_t10type", () => { top10.type = state._t10type; renderTop10(); });
segment("#t10metric", "_t10metric", () => { top10.metric = state._t10metric; renderTop10(); });
segment("#metric", "metric", () => renderCharts(monthly(filtered())));
$("#q").addEventListener("input", renderTx);
$("#csv").addEventListener("click", downloadCsv);

if (window.Chart) Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
initDistricts().then(initTop10).catch(() => setStatus("지역 목록을 불러오지 못했습니다.", true));
