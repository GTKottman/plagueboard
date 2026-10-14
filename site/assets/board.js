// Red string board: d3 force layout computed once (no jitter), then static with pan/zoom.
(function () {
  const data = window.BOARD;
  const svgEl = document.getElementById("rs-svg");
  const panel = document.getElementById("rs-panel");
  const search = document.getElementById("rs-search");
  if (!data || !svgEl || !window.d3) return;

  // ---- merge duplicate links (same pair) into one with several notes
  const byId = new Map(data.nodes.map(n => [n.id, { ...n }]));
  const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const merged = new Map();
  for (const [a, b, note, src] of data.links) {
    if (!byId.has(a) || !byId.has(b)) continue;
    const k = pairKey(a, b);
    if (!merged.has(k)) merged.set(k, { source: a, target: b, notes: [] });
    merged.get(k).notes.push({ note, src });
  }
  const nodes = [...byId.values()];
  const links = [...merged.values()];
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const l of links) {
    adj.get(l.source).push({ other: l.target, link: l });
    adj.get(l.target).push({ other: l.source, link: l });
  }
  nodes.forEach(n => (n.degree = adj.get(n.id).length));

  const COUNTRY = { RU: "Russia", CN: "China", MN: "Mongolia", US: "United States", INT: "International" };
  const TYPE = { org: "Organization", person: "Person", event: "Meeting / event" };
  const R = n => ((n.type === "person" ? 10 : n.type === "event" ? 11 : 13) + Math.min(n.degree, 14) * 0.7) * 1.35;

  // ---- label metrics for collision (labels sit under the shape, never over anything)
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = "500 19px Urbanist, sans-serif";
  nodes.forEach(n => {
    n.label = n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name;
    n.lw = ctx.measureText(n.label).width;
  });

  // ---- layout: countries pull to regions, run to rest, then freeze
  const W = 1400, H = 1000;
  // three columns to suit a wide board: Russia | Mongolia, International, United States | China
  const anchor = { RU: [-420, 0], CN: [420, 0], MN: [0, -300], INT: [0, 20], US: [0, 320] };
  nodes.forEach((n, i) => {
    const a = anchor[n.country] || [0, 0];
    n.x = a[0] + Math.cos(i) * 60; n.y = a[1] + Math.sin(i) * 60;
  });
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(l => (l.source.type === "event" || l.target.type === "event") ? 120 : 90).strength(0.35))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("x", d3.forceX(d => (anchor[d.country] || [0, 0])[0]).strength(0.06))
    .force("y", d3.forceY(d => (anchor[d.country] || [0, 0])[1]).strength(0.06))
    .force("collide", d3.forceCollide(d => Math.max(R(d) + 18, d.lw / 3 + 6)).strength(1).iterations(3))
    .stop();
  for (let i = 0; i < 700; i++) sim.tick();
  // final pass: collision only, so no two labels touch
  sim.force("link", null).force("charge", null).force("x", null).force("y", null);
  sim.force("collide", d3.forceCollide(d => Math.max(R(d) + 20, d.lw / 3 + 8)).strength(1).iterations(6));
  for (let i = 0; i < 200; i++) sim.tick();

  // ---- country zones: boxes around each country's nodes (meetings sit where they happened), pushed apart so no two touch
  ctx.font = "500 13px Urbanist, sans-serif";
  nodes.forEach(n => (n.lpx = ctx.measureText(n.label).width));
  // est = how many screen px one layout unit will be; zones are padded so country names and labels fit on screen.
  // The board's final scale depends on the zones, so settle it in a few rounds.
  const svgW = svgEl.clientWidth || 900, svgH = svgEl.clientHeight || 700;
  let est = 0.5, ZP, ext;
  const countries = [...new Set(nodes.map(n => n.country))];
  const zoneBox = c => {
    const pts = nodes.filter(n => n.country === c);
    return {
      c,
      x0: Math.min(...pts.map(n => n.x - ext(n))) - ZP.l, x1: Math.max(...pts.map(n => n.x + ext(n))) + ZP.r,
      y0: Math.min(...pts.map(n => n.y - R(n) * 1.2)) - ZP.t, y1: Math.max(...pts.map(n => n.y + R(n) * 1.2)) + ZP.b,
    };
  };
  const ZGAP = 48;
  let zones;
  for (let round = 0; round < 4; round++) {
    ZP = { l: 90, r: 90, t: Math.min(140, Math.max(64, 44 / est)), b: Math.min(100, Math.max(50, 30 / est)) };
    ext = n => R(n) * (n.type === "event" ? 1.2 : 1);
    for (let it = 0; it < 300; it++) {
      const zs = countries.map(zoneBox);
      let moved = false;
      for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
        const a = zs[i], b = zs[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + ZGAP, oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + ZGAP;
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const [dx, dy] = ox < oy ? [(a.x0 + a.x1 < b.x0 + b.x1 ? -1 : 1) * ox / 2, 0] : [0, (a.y0 + a.y1 < b.y0 + b.y1 ? -1 : 1) * oy / 2];
        nodes.forEach(n => { if (n.country === a.c) { n.x += dx; n.y += dy; } else if (n.country === b.c) { n.x -= dx; n.y -= dy; } });
      }
      if (!moved) break;
    }
    zones = countries.map(zoneBox);
    const w = Math.max(...zones.map(z => z.x1)) - Math.min(...zones.map(z => z.x0)) + 48;
    const h = Math.max(...zones.map(z => z.y1)) - Math.min(...zones.map(z => z.y0)) + 48;
    const real = Math.min(svgW / w, svgH / h);
    if (Math.abs(real - est) / real < 0.03) break;
    est = real;
  }

  // ---- draw
  const svg = d3.select(svgEl);
  const xs = zones.flatMap(z => [z.x0, z.x1]);
  const ys = zones.flatMap(z => [z.y0, z.y1]);
  const pad = 24;
  const vb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2];
  svg.attr("viewBox", vb.join(" "));
  const root = svg.append("g");

  // faint dot grid that moves with the board
  const defs = svg.append("defs");
  defs.append("pattern").attr("id", "rs-dot").attr("width", 28).attr("height", 28).attr("patternUnits", "userSpaceOnUse")
    .append("circle").attr("class", "rs-dots").attr("cx", 14).attr("cy", 14).attr("r", 1.3);
  root.append("rect").attr("x", vb[0] - vb[2] * 3).attr("y", vb[1] - vb[3] * 3).attr("width", vb[2] * 7).attr("height", vb[3] * 7).attr("fill", "url(#rs-dot)");

  const zoneSel = root.append("g").selectAll("g").data(zones).join("g").attr("class", "rs-zone");
  zoneSel.append("rect").attr("x", z => z.x0).attr("y", z => z.y0).attr("width", z => z.x1 - z.x0).attr("height", z => z.y1 - z.y0).attr("rx", 22);
  zoneSel.append("text").text(z => COUNTRY[z.c]);

  // strings hang a little, like real string pinned between two points
  const sag = d => {
    const len = Math.hypot(d.target.x - d.source.x, d.target.y - d.source.y);
    const mx = (d.source.x + d.target.x) / 2, my = (d.source.y + d.target.y) / 2 + len * 0.08;
    return `M${d.source.x},${d.source.y} Q${mx},${my} ${d.target.x},${d.target.y}`;
  };
  const linkSel = root.append("g").attr("class", "rs-links").selectAll("path").data(links).join("path").attr("d", sag);

  const nodeSel = root.append("g").selectAll("g").data(nodes).join("g")
    .attr("class", d => "rs-node rs-" + d.type)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .attr("tabindex", 0).attr("role", "button").attr("aria-label", d => `${d.name}, ${TYPE[d.type]}`)
    .on("click", (e, d) => select(d.id))
    .on("keydown", (e, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(d.id); } });

  nodeSel.each(function (d) {
    const g = d3.select(this), r = R(d);
    if (d.type === "org") g.append("rect").attr("x", -r).attr("y", -r).attr("width", r * 2).attr("height", r * 2).attr("rx", 3);
    else if (d.type === "event") g.append("path").attr("d", `M0,${-r * 1.2} L${r * 1.2},0 L0,${r * 1.2} L${-r * 1.2},0 Z`);
    else g.append("circle").attr("r", r);
    g.append("text").attr("text-anchor", "middle").text(d.label);
  });

  // ---- labels: fixed 13px on screen at any zoom; colliding labels hide (most important wins)
  const LABEL_PX = 13, LINE_PX = 19;
  let zt = d3.zoomIdentity, near = null, selId = null;
  const baseScale = () => {
    const w = svgEl.clientWidth || 800, h = svgEl.clientHeight || 600;
    return Math.min(w / vb[2], h / vb[3]);
  };
  // labels: try below, right, left, then above the shape; a label never touches another label, a shape,
  // a country name or its zone's edge (most important labels are placed first)
  const zoneById = new Map(zones.map(z => [z.c, z]));
  function layoutLabels() {
    const s = baseScale() * zt.k;
    const textSel = nodeSel.select("text");
    textSel.attr("font-size", LABEL_PX / s);
    const prio = d => d.id === selId ? 1e6 : near && near.has(d.id) ? 1e4 + d.degree : (d.type === "person" ? 0 : 100) + d.degree;
    const order = [...nodes].sort((a, b) => prio(b) - prio(a));
    const kept = nodes.map(d => { const r = R(d) * (d.type === "event" ? 1.2 : 1) * s; return { id: d.id, b: [d.x * s - r, d.y * s - r, d.x * s + r, d.y * s + r] }; });
    const ZL = 11;
    zoneSel.select("text").attr("font-size", ZL / s).attr("x", z => z.x0 + 18 / s).attr("y", z => z.y0 + 26 / s);
    ctx.font = "600 11px Urbanist, sans-serif";
    const zoneShown = new Set();
    zones.forEach(z => {
      const b = [z.x0 * s + 14, z.y0 * s + 10, z.x0 * s + 22 + ctx.measureText(COUNTRY[z.c].toUpperCase()).width * 1.15, z.y0 * s + 32];
      if (b[2] > z.x1 * s - 8 || b[3] > z.y1 * s - 8) return; // zone too small on screen for its name
      if (kept.some(k => b[0] < k.b[2] && k.b[0] < b[2] && b[1] < k.b[3] && k.b[1] < b[3])) return; // a shape is in the way
      kept.push({ id: "zone:" + z.c, b }); zoneShown.add(z.c);
    });
    zoneSel.select("text").classed("hid", z => !zoneShown.has(z.c));
    // the visible part of the svg, in the same frame as the boxes (layout units × s)
    const bs = baseScale(), sw = svgEl.clientWidth || 800, sh = svgEl.clientHeight || 600;
    const cx0 = (zt.x - vb[0]) * bs + (sw - vb[2] * bs) / 2, cy0 = (zt.y - vb[1]) * bs + (sh - vb[3] * bs) / 2;
    const view = [-cx0 + 6, -cy0 + 6, sw - cx0 - 6, sh - cy0 - 6];
    const place = new Map();
    for (const d of order) {
      if (near && !near.has(d.id)) continue; // with a selection, only the cluster is labelled
      const cx = d.x * s, cy = d.y * s, r = R(d) * (d.type === "event" ? 1.2 : 1) * s, w = d.lpx, H = LINE_PX;
      const z = zoneById.get(d.country), zb = [z.x0 * s + 4, z.y0 * s + 4, z.x1 * s - 4, z.y1 * s - 4];
      const cands = [
        { pos: "below", b: [cx - w / 2 - 3, cy + r + 2, cx + w / 2 + 3, cy + r + 2 + H] },
        { pos: "right", b: [cx + r + 4, cy - H / 2, cx + r + 8 + w, cy + H / 2] },
        { pos: "left", b: [cx - r - 8 - w, cy - H / 2, cx - r - 4, cy + H / 2] },
        { pos: "above", b: [cx - w / 2 - 3, cy - r - 2 - H, cx + w / 2 + 3, cy - r - 2] },
      ];
      const free = c => c.b[0] >= view[0] && c.b[1] >= view[1] && c.b[2] <= view[2] && c.b[3] <= view[3] && !kept.some(k => k.id !== d.id && c.b[0] < k.b[2] && k.b[0] < c.b[2] && c.b[1] < k.b[3] && k.b[1] < c.b[3]);
      const inZone = c => c.b[0] >= zb[0] && c.b[1] >= zb[1] && c.b[2] <= zb[2] && c.b[3] <= zb[3];
      // inside the zone if possible; on small screens a label may cross the zone edge rather than vanish
      // the selected item always gets its name: if nothing is free, it may sit over a faded (unrelated) shape
      const freeOfCluster = c => c.b[0] >= view[0] && c.b[1] >= view[1] && c.b[2] <= view[2] && c.b[3] <= view[3] &&
        !kept.some(k => k.id !== d.id && (!near || near.has(k.id) || !byId.has(k.id)) && c.b[0] < k.b[2] && k.b[0] < c.b[2] && c.b[1] < k.b[3] && k.b[1] < c.b[3]);
      const c = cands.find(c => inZone(c) && free(c)) || cands.find(free) || (d.id === selId ? cands.find(freeOfCluster) : null);
      if (!c) continue;
      kept.push({ id: "label:" + d.id, b: c.b }); place.set(d.id, c.pos);
    }
    textSel.classed("hid", d => !place.has(d.id)).attr("stroke-width", 5 / s)
      .each(function (d) {
        const pos = place.get(d.id) || "below", r = R(d) * (d.type === "event" ? 1.2 : 1);
        const t = d3.select(this);
        if (pos === "below") t.attr("text-anchor", "middle").attr("x", 0).attr("y", r + (LABEL_PX + 3) / s);
        else if (pos === "above") t.attr("text-anchor", "middle").attr("x", 0).attr("y", -r - 6 / s);
        else t.attr("text-anchor", pos === "right" ? "start" : "end").attr("x", (pos === "right" ? 1 : -1) * (r + 6 / s)).attr("y", 4.5 / s);
      });
  }
  const zoom = d3.zoom().scaleExtent([0.6, 8]).on("zoom", e => { zt = e.transform; root.attr("transform", zt); layoutLabels(); });
  svg.call(zoom).on("dblclick.zoom", null);
  document.getElementById("rs-zin").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1.4));
  document.getElementById("rs-zout").addEventListener("click", () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.4));
  new ResizeObserver(() => layoutLabels()).observe(svgEl);
  // label widths were measured before the web font loaded: measure again once it has
  if (document.fonts) document.fonts.ready.then(() => {
    ctx.font = "500 13px Urbanist, sans-serif";
    nodes.forEach(n => (n.lpx = ctx.measureText(n.label).width + 2));
    layoutLabels();
  });

  function flyTo(ids) {
    const pts = nodes.filter(n => ids.has(n.id));
    const x0 = Math.min(...pts.map(n => n.x)) - 70, x1 = Math.max(...pts.map(n => n.x)) + 70;
    const y0 = Math.min(...pts.map(n => n.y)) - 50, y1 = Math.max(...pts.map(n => n.y)) + 90;
    // fit the cluster to what is actually visible (the svg can be wider or taller than the viewBox)
    const s0 = baseScale(), vw = (svgEl.clientWidth || 800) / s0, vh = (svgEl.clientHeight || 600) / s0;
    const k = Math.max(0.6, Math.min(3, 0.9 * Math.min(vw / (x1 - x0), vh / (y1 - y0))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const t = d3.zoomIdentity.translate(vb[0] + vb[2] / 2 - cx * k, vb[1] + vb[3] / 2 - cy * k).scale(k);
    svg.transition().duration(500).call(zoom.transform, t);
  }

  // ---- selection
  let current = null;
  function highlight(id) {
    selId = id;
    if (!id) {
      near = null;
      svgEl.classList.remove("has-sel");
      nodeSel.classed("on", false).classed("sel", false);
      linkSel.classed("on", false);
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
      layoutLabels();
      return;
    }
    near = new Set([id, ...adj.get(id).map(a => a.other)]);
    svgEl.classList.add("has-sel");
    nodeSel.classed("on", d => near.has(d.id)).classed("sel", d => d.id === id);
    nodeSel.filter(d => near.has(d.id)).raise(); nodeSel.filter(d => d.id === id).raise();
    linkSel.classed("on", d => d.source.id === id || d.target.id === id);
    flyTo(near);
    layoutLabels();
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const chip = (n, note, src) => `
    <button class="rs-item" data-id="${n.id}">
      <span class="rs-shape rs-shape-${n.type}" aria-hidden="true"></span>
      <span class="rs-item-text"><span class="rs-item-line"><b>${esc(n.name)}</b>${(note || n.sub) ? " — " + esc(note || n.sub) : ""}</span>${src ? `<em>${esc(src)}</em>` : ""}</span>
    </button>`;

  function group(title, items) {
    if (!items.length) return "";
    return `<div class="rs-group"><h5>${title} <span>${items.length}</span></h5><div class="rs-list">${items.join("")}</div></div>`;
  }

  function select(id, push = true) {
    current = id;
    highlight(id);
    if (!id) return overview();
    const n = byId.get(id);
    const conns = adj.get(id).map(a => ({ n: byId.get(a.other), notes: a.link.notes }));
    const fmt = c => chip(c.n, c.notes.map(x => x.note).filter(Boolean).join(" · "), [...new Set(c.notes.map(x => x.src).filter(Boolean))].join("; "));
    const people = conns.filter(c => c.n.type === "person");
    const orgs = conns.filter(c => c.n.type === "org");
    const events = conns.filter(c => c.n.type === "event");
    const meta = n.type === "event" ? n.date : COUNTRY[n.country] || "";
    panel.innerHTML = `
      <button class="rs-back" data-back>← All organizations</button>
      <div class="rs-head">
        <span class="rs-type"><span class="rs-shape rs-shape-${n.type}" aria-hidden="true"></span>${TYPE[n.type]}${meta ? " · " + esc(meta) : ""}</span>
        <h4>${esc(n.name)}</h4>
        <p class="rs-sub">${esc(n.sub || "")}</p>
        <p class="rs-about">${esc(n.about || "")}</p>
      </div>
      ${n.type === "person"
        ? group("Works at / roles", orgs.map(fmt)) + group("Seen with / dealt with", people.map(fmt)) + group("Meetings and events", events.map(fmt))
        : group(n.type === "org" ? "People" : "Who was there", people.map(fmt)) + group("Connected organizations", orgs.map(fmt)) + group("Meetings and events", events.map(fmt))}
    `;
    panel.scrollTop = 0;
    if (push) try { history.replaceState(null, "", "#rs-" + id); } catch (e) {}
  }

  function overview() {
    const orgs = nodes.filter(n => n.type === "org").sort((a, b) => b.degree - a.degree);
    const events = nodes.filter(n => n.type === "event");
    panel.innerHTML = `
      <div class="rs-head">
        <span class="rs-type">Start here</span>
        <h4>Pick a company, institute or person</h4>
        <p class="rs-about">Click anything on the board or in this list. Organizations show their people; people show where they work,
          who they've dealt with and which meetings they were at. Every string has a source. A connection is not an accusation.</p>
      </div>
      ${group("Organizations, most connected first", orgs.map(n => chip(n, n.sub)))}
      ${group("Meetings and events", events.map(n => chip(n, n.date + " · " + n.sub)))}
    `;
    try { history.replaceState(null, "", "#money"); } catch (e) {}
  }

  panel.addEventListener("click", e => {
    if (e.target.closest("[data-back]")) return select(null);
    const b = e.target.closest(".rs-item");
    if (b) select(b.dataset.id);
  });

  // ---- search
  const dl = document.getElementById("rs-names");
  dl.innerHTML = nodes.map(n => `<option value="${esc(n.name)}"></option>`).join("");
  search.addEventListener("change", () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find(n => n.name.toLowerCase() === q) || nodes.find(n => n.name.toLowerCase().includes(q) || (n.sub || "").toLowerCase().includes(q));
    if (hit) select(hit.id);
  });

  const start = (location.hash || "").startsWith("#rs-") ? location.hash.slice(4) : null;
  if (start && byId.has(start)) select(start, false); else overview();
})();
