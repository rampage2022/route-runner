// ====== CONFIG ======
const DEFAULT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRH1e2H95OOk65fXbvYT5hdGIMRWvXdJeGc7bM6BErPGxfbNOdhketj5ufnBIYnb9oen_xVFFQ87Ybc/pub?gid=0&single=true&output=csv";

// ====== Helpers ======
function getRouteFromPath() {
  const path = window.location.pathname.toLowerCase();
  const m = path.match(/\/r\/([^\/]+)/);
  if (m && m[1]) return m[1];
  return null; // home page
}

function lsKey(route, suffix) {
  return `route_runner:${route}:${suffix}`;
}

function googleMapsNavLink(address) {
  const dest = encodeURIComponent(address.trim());
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

// Simple CSV parser (handles quoted commas)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') { cur += '"'; i++; continue; }
    if (c === '"') { inQuotes = !inQuotes; continue; }

    if (c === "," && !inQuotes) { row.push(cur); cur = ""; continue; }

    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && next === "\n") i++;
      row.push(cur); cur = "";
      if (row.some(v => v.trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cur += c;
  }
  row.push(cur);
  if (row.some(v => v.trim().length > 0)) rows.push(row);
  return rows;
}

function normalizeHeader(h) { return (h || "").trim().toLowerCase(); }
function toInt(x, fallback=0) {
  const n = parseInt(String(x || "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchStops() {
  const res = await fetch(DEFAULT_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed (${res.status})`);
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("CSV looks empty.");

  const headers = rows[0].map(normalizeHeader);
  const idx = {
    route: headers.indexOf("route"),
    stop: headers.indexOf("stop"),
    name: headers.indexOf("name"),
    address: headers.indexOf("address"),
    notes: headers.indexOf("notes"),
  };

  if (idx.route === -1 || idx.stop === -1 || idx.address === -1) {
    throw new Error("CSV must have headers: route, stop, address (name/notes optional).");
  }

  return rows.slice(1).map(r => ({
    route: (r[idx.route] || "").trim().toLowerCase(),
    stop: toInt(r[idx.stop], 0),
    name: idx.name !== -1 ? (r[idx.name] || "").trim() : "",
    address: (r[idx.address] || "").trim(),
    notes: idx.notes !== -1 ? (r[idx.notes] || "").trim() : "",
  })).filter(x => x.route && x.stop > 0 && x.address);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ====== UI ======
const route = getRouteFromPath();
document.getElementById("routePill").textContent = route ? `Route: ${route}` : "Routes Home";

const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const actionsEl = document.getElementById("actions");
const navigateBtn = document.getElementById("navigateBtn");
const doneBtn = document.getElementById("doneBtn");
const nextBtn = document.getElementById("nextBtn");
const prevBtn = document.getElementById("prevBtn");
const resetBtn = document.getElementById("resetBtn");
const stopListEl = document.getElementById("stopList");
const countLineEl = document.getElementById("countLine");
const warnBoxEl = document.getElementById("warnBox");

let routeStops = [];
let currentIndex = 0;

function getDoneSet() {
  const raw = localStorage.getItem(lsKey(route, "done")) || "[]";
  try { return new Set(JSON.parse(raw)); } catch { return new Set(); }
}
function setDoneSet(doneSet) {
  localStorage.setItem(lsKey(route, "done"), JSON.stringify([...doneSet]));
}
function getCurrentIndex() { return toInt(localStorage.getItem(lsKey(route, "current_index")), 0); }
function setCurrentIndex(i) { localStorage.setItem(lsKey(route, "current_index"), String(i)); }

function showWarn(msg) {
  warnBoxEl.style.display = msg ? "block" : "none";
  warnBoxEl.textContent = msg || "";
}
// ====== Map Preview (Leaflet + OSM) ======
let map, markersLayer, lineLayer;
let geoCache = new Map();

function geoKey(addr) {
  return `route_runner:geocode:${addr.toLowerCase()}`;
}

function loadGeocodeFromStorage(addr) {
  const raw = localStorage.getItem(geoKey(addr));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function saveGeocodeToStorage(addr, latlng) {
  localStorage.setItem(geoKey(addr), JSON.stringify(latlng));
}

async function geocodeAddress(addr) {
  if (geoCache.has(addr)) return geoCache.get(addr);

  const stored = loadGeocodeFromStorage(addr);
  if (stored && stored.lat && stored.lng) {
    geoCache.set(addr, stored);
    return stored;
  }

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data || !data.length) return null;

  const latlng = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  geoCache.set(addr, latlng);
  saveGeocodeToStorage(addr, latlng);
  return latlng;
}

function initMapIfNeeded() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  if (map) return;

  map = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  lineLayer = L.layerGroup().addTo(map);

  map.setView([32.7767, -96.7970], 10);

  // ✅ force Leaflet to re-measure container size (fixes blank map)
  setTimeout(() => map.invalidateSize(true), 250);
}


function clearMapLayers() {
  if (markersLayer) markersLayer.clearLayers();
  if (lineLayer) lineLayer.clearLayers();
}

async function renderMap(routeStops, currentIndex) {
  // If the map container isn't on the page, do nothing
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  initMapIfNeeded();
  clearMapLayers();

  if (!routeStops || !routeStops.length) return;

  // Geocode all stops (cached after first time)
  const points = [];
  for (const s of routeStops) {
    const ll = await geocodeAddress(s.address);
    if (ll) points.push({ ...ll, stop: s.stop, name: s.name, address: s.address });
  }

  if (!points.length) return;

  // Draw line in stop order (preview only)
  const latlngs = points.map(p => [p.lat, p.lng]);
  L.polyline(latlngs).addTo(lineLayer);

  const currentStopNumber = routeStops[currentIndex]?.stop;

  // Draw markers (current stop larger)
  for (const p of points) {
    const isCurrent = p.stop === currentStopNumber;
    const marker = L.circleMarker([p.lat, p.lng], { radius: isCurrent ? 10 : 7 });
    marker.bindPopup(
      `<strong>#${p.stop}</strong><br>${escapeHtml(p.name || "")}<br>${escapeHtml(p.address)}`
    );
    marker.addTo(markersLayer);
  }

  // Fit bounds
  const bounds = L.latLngBounds(latlngs);
  map.fitBounds(bounds, { padding: [20, 20] });
}
function titleCase(s) {
  return (s || "").slice(0, 1).toUpperCase() + (s || "").slice(1);
}

function renderHome(allStops) {
  if (homeCardEl) homeCardEl.style.display = "block";

  // Hide route controls on home
  actionsEl.style.display = "none";
  titleEl.textContent = "Select a route";
  subtitleEl.textContent = "Tap a day below.";
  countLineEl.textContent = "";
  stopListEl.innerHTML = "";

  const routes = Array.from(new Set(allStops.map(s => s.route).filter(Boolean))).sort();
  if (!routes.length) {
    routesListEl.innerHTML = `<div class="muted">No routes found in your sheet yet.</div>`;
    return;
  }

  routesListEl.innerHTML = routes.map(r =>
    `<a class="btn secondary" href="/r/${encodeURIComponent(r)}">${escapeHtml(titleCase(r))}</a>`
  ).join("");
}

function render() {
  if (!routeStops.length) {
    titleEl.textContent = `No stops found for "${route}"`;
    subtitleEl.textContent = "Check your Sheet route values match (e.g., monday).";
    actionsEl.style.display = "none";
    countLineEl.textContent = "";
    stopListEl.innerHTML = "";
    return;
  }

  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= routeStops.length) currentIndex = routeStops.length - 1;

  const s = routeStops[currentIndex];
  const doneSet = getDoneSet();
  const isDone = doneSet.has(String(s.stop));

  titleEl.textContent = `${s.name ? s.name : "Stop"} — #${s.stop}`;
  subtitleEl.innerHTML = `
    <div class="big">${escapeHtml(s.address)}</div>
    ${s.notes ? `<div class="muted" style="margin-top:6px;">Notes: ${escapeHtml(s.notes)}</div>` : ""}
    <div class="muted" style="margin-top:6px;">Stop ${currentIndex + 1} of ${routeStops.length}${isDone ? " • Done ✅" : ""}</div>
  `;

  navigateBtn.href = googleMapsNavLink(s.address);
  actionsEl.style.display = "flex";

  countLineEl.textContent = `${routeStops.length} stops • Tap any stop below to jump`;

  const done = getDoneSet();
  stopListEl.innerHTML = routeStops.map((x, idx) => {
    const d = done.has(String(x.stop));
    const label = `${x.stop}. ${x.name ? x.name : x.address}`;
    return `
      <div class="item ${d ? "done" : ""}" data-idx="${idx}">
        <div><strong>${escapeHtml(label)}</strong></div>
        <div class="muted">${escapeHtml(x.address)}${x.notes ? ` • ${escapeHtml(x.notes)}` : ""}</div>
      </div>
    `;
  }).join("");

  stopListEl.querySelectorAll(".item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = toInt(el.getAttribute("data-idx"), 0);
      currentIndex = idx;
      setCurrentIndex(currentIndex);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

    renderMap(routeStops, currentIndex);
}

doneBtn.addEventListener("click", () => {
  const s = routeStops[currentIndex];
  const doneSet = getDoneSet();
  doneSet.add(String(s.stop));
  setDoneSet(doneSet);
  if (currentIndex < routeStops.length - 1) { currentIndex += 1; setCurrentIndex(currentIndex); }
  render();
});

nextBtn.addEventListener("click", () => {
  currentIndex = Math.min(routeStops.length - 1, currentIndex + 1);
  setCurrentIndex(currentIndex);
  render();
});

prevBtn.addEventListener("click", () => {
  currentIndex = Math.max(0, currentIndex - 1);
  setCurrentIndex(currentIndex);
  render();
});

resetBtn.addEventListener("click", () => {
  localStorage.removeItem(lsKey(route, "done"));
  localStorage.removeItem(lsKey(route, "current_index"));
  currentIndex = 0;
  render();
});

(async function load() {
  showWarn("");
  try {
   const allStops = await fetchStops();

if (!route) {
  renderHome(allStops);
  return;
}

routeStops = allStops.filter(s => s.route === route).sort((a, b) => a.stop - b.stop);
currentIndex = getCurrentIndex();
render();

  } catch (e) {
    actionsEl.style.display = "none";
    titleEl.textContent = "Couldn’t load stops";
    subtitleEl.textContent = String(e.message || e);
    showWarn("Make sure your Google Sheet is published as CSV and headers are: route, stop, address.");
  }
})();
