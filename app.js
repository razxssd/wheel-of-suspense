/* =====================================================================
   Wheel of Suspense — random name picker with dramatic commentary
   ===================================================================== */

const TAU = Math.PI * 2;

const PALETTE = [
  "#FF6B6B", "#FFA94D", "#FFD43B", "#69DB7C",
  "#38D9A9", "#4DABF7", "#9775FA", "#F783AC",
];

// ---------------------------------------------------------------------
// Commentary script lines. {name} is replaced with whoever is currently
// under the pointer when the line fires.
// ---------------------------------------------------------------------
const LINES = {
  hype: [
    "AND HERE WE GO!!! 🌀",
    "The wheel is spinning at FULL speed!",
    "Everybody hold your breath... 😮",
    "No turning back now!!",
    "Destiny is in motion... ✨",
    "Round and round it goes!!",
  ],
  tease: [
    "It's anyone's game right now!! 👀",
    "Someone's destiny is being decided...",
    "The tension is UNBEARABLE...",
    "Who will it be?? NOBODY knows!!",
    "I've never seen a wheel THIS dramatic!!",
    "Hold tight... this could be ANYONE!",
    "The wheel is keeping its secret... 🤫",
    "Don't blink now!!",
  ],
  final: [
    "IT'S SLOWING DOWN... {name} IN SIGHT!!",
    "{name}... IS IT YOU?! 😱",
    "HEART RATES RISING... {name}!!!",
    "THIS IS IT... {name}?!",
    "I CAN'T WATCH... {name}!!! 🙈",
    "INCHES AWAY FROM {name}!!",
  ],
};

const STYLES = ["shout", "ticker", "typewriter", "heartbeat", "spotlight"];

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  names: [],
  rotation: 0,
  spinning: false,
  highlight: null, // { idx, pulse } — winning segment glow after a spin
  muted: localStorage.getItem("wheel.muted") === "1",
  lastStyle: null,
  history: JSON.parse(localStorage.getItem("wheel.history") || "[]"),
};

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("wheel");
const ctx = canvas.getContext("2d");
const namesInput = $("namesInput");
const spinBtn = $("spinBtn");
const commentaryEl = $("commentary");
const flashEl = $("flash");
const pointerEl = document.querySelector(".pointer");

// kick the pointer like a peg just hit it (synced with the tick sound)
function flapPointer() {
  pointerEl.classList.remove("flap");
  void pointerEl.offsetWidth;
  pointerEl.classList.add("flap");
}

// ---------------------------------------------------------------------
// Server sync — saved lists & winners live on the server (Upstash Redis
// via /api). localStorage is kept as an offline cache so the app still
// works when opened straight from disk or while the network is down.
// ---------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ---------------------------------------------------------------------
// Names handling
// ---------------------------------------------------------------------
function parseNames() {
  state.names = namesInput.value
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  $("nameCount").textContent = state.names.length;
  spinBtn.disabled = state.spinning || state.names.length < 2;
  localStorage.setItem("wheel.names", namesInput.value);
  state.highlight = null; // indexes shift when the list changes
  drawWheel();
  syncActiveList(); // keep the active saved list up to date
  renderSavedLists();
}

function setNames(arr) {
  namesInput.value = arr.join("\n");
  parseNames();
}

// Obviously-fake placeholder names used only as a last-resort fallback (no
// saved lists on the server and nothing cached locally). They're randomized so
// it's instantly clear the wheel loaded the fallback rather than a real team.
const DEFAULT_NAME_POOL = [
  "Anonymous Alpaca", "Mystery Guest", "Random Rascal", "Placeholder Pete",
  "Nobody McNobody", "Sample Sally", "John Doe", "Jane Doe", "Test Dummy",
  "Captain Nobody", "Unnamed Hero", "Some Stranger", "Totally Real Person",
  "Guest of Honour",
];
function randomDefaults(n = 6) {
  const pool = [...DEFAULT_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const savedNames = localStorage.getItem("wheel.names");
namesInput.value =
  savedNames !== null && savedNames.trim()
    ? savedNames
    : randomDefaults().join("\n");

namesInput.addEventListener("input", () => { if (!state.spinning) parseNames(); });

$("shuffleBtn").addEventListener("click", () => {
  if (state.spinning) return;
  const arr = [...state.names];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  setNames(arr);
});

$("sortBtn").addEventListener("click", () => {
  if (state.spinning) return;
  setNames([...state.names].sort((a, b) => a.localeCompare(b)));
});

$("clearBtn").addEventListener("click", () => {
  if (state.spinning) return;
  setNames([]);
});

// ---------------------------------------------------------------------
// Saved lists — save the current participants under a name and reload
// them later (e.g. to restore the full roster after eliminations).
// ---------------------------------------------------------------------
let savedLists = JSON.parse(localStorage.getItem("wheel.lists") || "[]");
let currentListName = localStorage.getItem("wheel.currentList") || "";
let listsOffline = false; // true once a server call has failed
let firstListLoad = true; // auto-load the first saved list once, on boot
let listsReady = false; // becomes true after the initial server load settles
let listSyncTimer = null; // debounces auto-saving the active list

// Compare two name lists by membership (order-independent), so reordering
// (Shuffle/Sort) doesn't count as a change but adding/removing names does.
const membersKey = (arr) =>
  [...arr].sort((a, b) => a.localeCompare(b)).join("\n");

const saveForm = $("saveForm");
const saveNameInput = $("saveNameInput");

// Write-through cache: localStorage mirrors the last known server state so the
// app degrades gracefully offline.
function cacheLists() {
  localStorage.setItem("wheel.lists", JSON.stringify(savedLists));
  localStorage.setItem("wheel.currentList", currentListName);
}

// Pull the shared lists from the server on boot. If the server is empty but we
// have local lists (first run after enabling sync), seed them up so nothing is
// lost on migration.
async function fetchLists() {
  const cached = savedLists;
  try {
    const { lists } = await api("/api/lists");
    if ((!lists || lists.length === 0) && cached.length > 0) {
      await Promise.all(
        cached.map((l) =>
          api("/api/lists", { method: "POST", body: JSON.stringify(l) })
        )
      );
      savedLists = cached;
    } else {
      savedLists = lists;
    }
    listsOffline = false;
    cacheLists();
  } catch (err) {
    listsOffline = true; // keep showing the cached copy
  }
  autoLoadFirstList();
  renderSavedLists();
  listsReady = true; // edits from here on auto-save to the active list
}

// On first load, populate the wheel from the first saved list instead of the
// static placeholder names. Falls back to the placeholders if no lists exist.
function autoLoadFirstList() {
  if (!firstListLoad) return;
  firstListLoad = false;
  if (savedLists.length === 0) return;
  const first = savedLists[0];
  currentListName = first.name;
  setNames([...first.names]); // updates the textarea, wheel, and cache
  cacheLists();
}

// Auto-save the active list whenever its membership changes (e.g. a winner is
// removed, or names are edited). Debounced so typing doesn't spam the server.
function syncActiveList() {
  if (!listsReady) return; // don't sync until the server load has settled
  const active = savedLists.find((l) => l.name === currentListName);
  if (!active) return; // no active list — nothing to keep in sync
  if (membersKey(active.names) === membersKey(state.names)) return; // unchanged
  active.names = [...state.names]; // optimistic local update
  cacheLists();
  clearTimeout(listSyncTimer);
  listSyncTimer = setTimeout(async () => {
    try {
      await api("/api/lists", {
        method: "POST",
        body: JSON.stringify({ name: active.name, names: active.names }),
      });
      listsOffline = false;
    } catch (err) {
      listsOffline = true;
      renderSavedLists();
    }
  }, 500);
}

function renderSavedLists() {
  const ul = $("savedLists");
  ul.innerHTML = "";

  if (listsOffline) {
    const note = document.createElement("li");
    note.className = "empty offline";
    note.textContent = "⚠ Offline — showing the last synced copy.";
    ul.appendChild(note);
  }

  if (savedLists.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No saved lists yet — hit 💾 Save to keep this one.";
    ul.appendChild(li);
    return;
  }

  for (const list of savedLists) {
    const li = document.createElement("li");
    const isActive = list.name === currentListName;
    const isModified =
      isActive && membersKey(list.names) !== membersKey(state.names);
    if (isActive) li.classList.add("active");

    const load = document.createElement("button");
    load.className = "load";
    load.title = `Load "${list.name}"`;

    const nameSpan = document.createElement("span");
    nameSpan.className = "list-name";
    nameSpan.textContent = `📋 ${list.name}${isModified ? " *" : ""}`;

    const countSpan = document.createElement("span");
    countSpan.className = "list-count";
    countSpan.textContent = `${list.names.length} names`;

    load.append(nameSpan, countSpan);
    load.addEventListener("click", () => loadList(list.name));

    const del = document.createElement("button");
    del.className = "mini-btn";
    del.title = `Delete "${list.name}"`;
    del.textContent = "✕";
    del.addEventListener("click", () => deleteList(list.name));

    li.append(load, del);
    ul.appendChild(li);
  }
}

async function saveCurrentList(name) {
  name = name.trim();
  if (!name || state.names.length === 0) {
    saveNameInput.focus();
    return;
  }
  const names = [...state.names];

  // Optimistic local update so the UI feels instant…
  const existing = savedLists.find((l) => l.name === name);
  if (existing) {
    existing.names = names;
  } else {
    savedLists.push({ name, names });
  }
  currentListName = name;
  cacheLists();
  renderSavedLists();
  saveForm.classList.add("hidden");

  // …then push to the server.
  const btn = $("saveListBtn");
  try {
    await api("/api/lists", { method: "POST", body: JSON.stringify({ name, names }) });
    listsOffline = false;
    btn.textContent = "✓ Saved";
  } catch (err) {
    listsOffline = true;
    btn.textContent = "⚠ Saved locally";
    renderSavedLists();
  }
  setTimeout(() => { btn.textContent = "💾 Save"; }, 1400);
}

function loadList(name) {
  if (state.spinning) return;
  const list = savedLists.find((l) => l.name === name);
  if (!list) return;
  const sameContent = JSON.stringify(list.names) === JSON.stringify(state.names);
  if (state.names.length > 0 && !sameContent) {
    if (!confirm(`Replace the current participants with "${name}"?`)) return;
  }
  currentListName = name;
  cacheLists();
  setNames([...list.names]);
}

async function deleteList(name) {
  if (!confirm(`Delete the saved list "${name}"?`)) return;
  savedLists = savedLists.filter((l) => l.name !== name);
  if (currentListName === name) currentListName = "";
  cacheLists();
  renderSavedLists();
  try {
    await api(`/api/lists?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    listsOffline = false;
  } catch (err) {
    listsOffline = true;
    renderSavedLists();
  }
}

$("saveListBtn").addEventListener("click", () => {
  saveForm.classList.toggle("hidden");
  if (!saveForm.classList.contains("hidden")) {
    saveNameInput.value = currentListName;
    saveNameInput.focus();
    saveNameInput.select();
  }
});

$("saveConfirmBtn").addEventListener("click", () => saveCurrentList(saveNameInput.value));

saveNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveCurrentList(saveNameInput.value);
  if (e.key === "Escape") saveForm.classList.add("hidden");
});

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
let historyOffline = false;

function cacheHistory() {
  localStorage.setItem("wheel.history", JSON.stringify(state.history.slice(-50)));
}

function renderHistory() {
  const ul = $("historyList");
  ul.innerHTML = "";
  state.history.slice(-8).reverse().forEach((h) => {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.textContent = `🏆 ${h.name}`;

    const meta = document.createElement("span");
    meta.className = "meta";

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = h.when;

    const del = document.createElement("button");
    del.className = "mini-btn del-winner";
    del.title = `Remove "${h.name}" from winners`;
    del.textContent = "✕";
    del.addEventListener("click", () => deleteWinner(h.id));

    meta.append(when, del);
    li.append(name, meta);
    ul.appendChild(li);
  });
}

async function addToHistory(name) {
  const when = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const entry = { id: uid(), name, when };
  state.history.push(entry);
  cacheHistory();
  renderHistory();
  try {
    await api("/api/history", { method: "POST", body: JSON.stringify(entry) });
    historyOffline = false;
  } catch (err) {
    historyOffline = true;
  }
}

async function deleteWinner(id) {
  state.history = state.history.filter((h) => h.id !== id);
  cacheHistory();
  renderHistory();
  try {
    await api(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    historyOffline = false;
  } catch (err) {
    historyOffline = true;
  }
}

// Pull shared winners on boot; seed the server from local cache on first run.
async function fetchHistory() {
  const cached = state.history.map((h) => (h.id ? h : { ...h, id: uid() }));
  try {
    const { history } = await api("/api/history");
    if ((!history || history.length === 0) && cached.length > 0) {
      for (const entry of cached) {
        await api("/api/history", { method: "POST", body: JSON.stringify(entry) });
      }
      state.history = cached;
    } else {
      state.history = history;
    }
    historyOffline = false;
    cacheHistory();
  } catch (err) {
    historyOffline = true;
    state.history = cached;
  }
  renderHistory();
}

$("clearHistoryBtn").addEventListener("click", async () => {
  state.history = [];
  cacheHistory();
  renderHistory();
  try {
    await api("/api/history", { method: "DELETE" });
    historyOffline = false;
  } catch (err) {
    historyOffline = true;
  }
});

// ---------------------------------------------------------------------
// Wheel drawing
// ---------------------------------------------------------------------
function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWheel();
}

function segmentColor(i, n) {
  let c = PALETTE[i % PALETTE.length];
  // avoid identical colors touching where the circle closes
  if (i === n - 1 && n > 1 && c === PALETTE[0]) c = "#E64980";
  return c;
}

function drawWheel() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (!w) return;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 8;
  const n = state.names.length;

  ctx.clearRect(0, 0, w, h);

  // outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 6, 0, TAU);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();

  if (n === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fillStyle = "#1d1d38";
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `600 ${Math.max(14, radius * 0.07)}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Add some names to begin", cx, cy - radius * 0.45);
    return;
  }

  const seg = TAU / n;
  const hl = state.highlight && state.highlight.idx < n ? state.highlight : null;

  for (let i = 0; i < n; i++) {
    const start = state.rotation + i * seg - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + seg);
    ctx.closePath();
    ctx.globalAlpha = hl && i !== hl.idx ? 0.3 : 1;
    ctx.fillStyle = segmentColor(i, n);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // winning segment glow, drawn on top of its dimmed neighbours
  if (hl) {
    const start = state.rotation + hl.idx * seg - Math.PI / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + seg);
    ctx.closePath();
    ctx.shadowColor = "rgba(255, 235, 130, 0.95)";
    ctx.shadowBlur = 16 + hl.pulse * 28;
    ctx.fillStyle = segmentColor(hl.idx, n);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#ffd43b";
    ctx.stroke();
    ctx.restore();
  }

  // labels
  const fontSize = Math.min(20, Math.max(8, radius * seg * 0.32));
  ctx.font = `800 ${fontSize}px Outfit, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const maxWidth = radius * 0.55;

  for (let i = 0; i < n; i++) {
    const mid = state.rotation + (i + 0.5) * seg - Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = hl && i !== hl.idx ? 0.3 : 1;
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    let label = state.names[i];
    while (label.length > 1 && ctx.measureText(label).width > maxWidth) {
      label = label.slice(0, -1);
    }
    if (label !== state.names[i]) label = label.slice(0, -1) + "…";
    ctx.fillStyle = "rgba(20,20,40,0.85)";
    ctx.fillText(label, radius - 16, 0);
    ctx.restore();
  }
}

// which segment is under the top pointer right now
function currentIndex() {
  const n = state.names.length;
  if (!n) return -1;
  const seg = TAU / n;
  const a = ((-state.rotation) % TAU + TAU) % TAU;
  return Math.floor(a / seg) % n;
}

window.addEventListener("resize", sizeCanvas);

// ---------------------------------------------------------------------
// Sound (WebAudio, created lazily on first spin for autoplay policy)
// ---------------------------------------------------------------------
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function playTick() {
  if (state.muted || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = 1600;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

function playFanfare() {
  if (state.muted || !audioCtx) return;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    const t = audioCtx.currentTime + i * 0.13;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

const muteBtn = $("muteBtn");
function renderMute() { muteBtn.textContent = state.muted ? "🔇" : "🔊"; }
muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  localStorage.setItem("wheel.muted", state.muted ? "1" : "0");
  renderMute();
});
renderMute();

// ---------------------------------------------------------------------
// Commentary engine — picks one of 5 visual styles per spin and feeds it
// suspense lines whose intensity follows the wheel's deceleration.
// ---------------------------------------------------------------------
const commentary = {
  style: null,
  schedule: [],
  step: 0,
  hideAt: 0.78,
  dismissed: false,
  lastLine: "",
  typeTimer: null,

  start(winnerName, neighborName) {
    const choices = STYLES.filter((s) => s !== state.lastStyle);
    this.style = choices[Math.floor(Math.random() * choices.length)];
    state.lastStyle = this.style;
    commentaryEl.className = `commentary on style-${this.style}`;
    commentaryEl.textContent = "";
    this.lastLine = "";
    this.step = 0;
    this.dismissed = false;
    // The outcome is decided when the spin starts; the named call-out is
    // a true coin flip between the winner and the near-miss neighbour,
    // so hearing a name reveals nothing.
    this.finalName = Math.random() < 0.5 ? winnerName : neighborName;
    // Only 2-3 lines per spin, all within the first ~60% of the spin —
    // then the commentary fades and the wheel finishes in silence.
    this.schedule = Math.random() < 0.5 ? [0.05, 0.42] : [0.05, 0.3, 0.55];
  },

  stop() {
    if (this.typeTimer) clearInterval(this.typeTimer);
    this.typeTimer = null;
    commentaryEl.className = "commentary";
    commentaryEl.textContent = "";
  },

  pickLine(pool, name) {
    let line;
    do {
      line = pool[Math.floor(Math.random() * pool.length)];
    } while (pool.length > 1 && line === this.lastLine);
    this.lastLine = line;
    return line.replaceAll("{name}", name);
  },

  // t = 0..1 spin progress; called every frame from the spin loop
  update(t) {
    if (this.step < this.schedule.length && t >= this.schedule[this.step]) {
      // A named line only appears as the 3rd message of 3-line spins;
      // 2-line spins stay fully generic.
      const isLast = this.step === this.schedule.length - 1;
      const isFinal = isLast && this.schedule.length === 3;
      const phase = this.step === 0 ? "hype" : isFinal ? "final" : "tease";
      const name = phase === "final" ? this.finalName : "";
      this.show(this.pickLine(LINES[phase], name), phase);
      this.step++;
    } else if (this.step >= this.schedule.length && t >= this.hideAt) {
      this.dismiss();
    }
  },

  dismiss() {
    if (this.dismissed) return;
    this.dismissed = true;
    if (this.typeTimer) clearInterval(this.typeTimer);
    this.typeTimer = null;
    commentaryEl.classList.add("fading");
  },

  show(text, phase) {
    if (this.typeTimer) clearInterval(this.typeTimer);
    this.typeTimer = null;

    if (this.style === "ticker") {
      commentaryEl.innerHTML = "";
      const inner = document.createElement("span");
      inner.className = "inner";
      inner.textContent = `${text}  •  ${text}  •  ${text}`;
      commentaryEl.appendChild(inner);
      commentaryEl.classList.remove("animate");
      void commentaryEl.offsetWidth; // restart CSS animation
      commentaryEl.classList.add("animate");
      return;
    }

    if (this.style === "typewriter") {
      const prefix = phase === "final" ? "> ALERT: " : "> ";
      const full = prefix + text;
      commentaryEl.textContent = "";
      let i = 0;
      this.typeTimer = setInterval(() => {
        commentaryEl.textContent = full.slice(0, ++i);
        if (i >= full.length) { clearInterval(this.typeTimer); this.typeTimer = null; }
      }, 28);
      return;
    }

    if (this.style === "spotlight") {
      flashEl.classList.remove("pop");
      void flashEl.offsetWidth;
      flashEl.classList.add("pop");
    }

    commentaryEl.textContent = text;
    commentaryEl.classList.remove("animate", "fast");
    void commentaryEl.offsetWidth;
    commentaryEl.classList.add("animate");
    if (this.style === "heartbeat" && phase === "final") {
      commentaryEl.classList.add("fast");
    }
  },
};

// ---------------------------------------------------------------------
// Spin!
// ---------------------------------------------------------------------
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

function spin() {
  if (state.spinning || state.names.length < 2) return;
  ensureAudio();
  hideWinner();

  state.spinning = true;
  state.highlight = null;
  spinBtn.disabled = true;
  spinBtn.classList.add("spinning");
  spinBtn.textContent = "···";
  namesInput.disabled = true;

  const n = state.names.length;
  const seg = TAU / n;

  // The winner is decided up front so the finish can be staged:
  // land just past the previous name's boundary (a near-miss creep)
  // and let the commentary foreshadow the real outcome.
  const winnerIdx = Math.floor(Math.random() * n);
  const margin = seg * (0.12 + Math.random() * 0.25);
  const targetA = (winnerIdx + 1) * seg - margin;

  const startRotation = state.rotation;
  const turns = TAU * (6 + Math.floor(Math.random() * 3));
  const align = (((-targetA - startRotation) % TAU) + TAU) % TAU;
  const finalRotation = startRotation + turns + align;
  // overshoot stays well inside the winner segment, and the settle
  // swing never reaches back across the boundary
  const overshoot = margin * 0.5;

  const duration = 8000 + Math.random() * 2000;
  const settleDuration = 650;
  const startTime = performance.now();
  let lastIdx = currentIndex();

  commentary.start(state.names[winnerIdx], state.names[(winnerIdx + 1) % n]);

  function frame(now) {
    const elapsed = now - startTime;

    if (elapsed < duration) {
      // main spin: decelerate into the winner, slightly past the mark
      const t = elapsed / duration;
      state.rotation =
        startRotation + (finalRotation + overshoot - startRotation) * easeOutQuart(t);
      drawWheel();

      const idx = currentIndex();
      if (idx !== lastIdx) {
        playTick();
        flapPointer();
        lastIdx = idx;
      }
      commentary.update(t);
      requestAnimationFrame(frame);
    } else if (elapsed < duration + settleDuration) {
      // elastic settle: damped wobble back onto the final position
      const s = (elapsed - duration) / settleDuration;
      state.rotation =
        finalRotation + overshoot * Math.exp(-4 * s) * Math.cos(s * Math.PI * 3);
      drawWheel();
      requestAnimationFrame(frame);
    } else {
      state.rotation = finalRotation;
      drawWheel();
      finishSpin(winnerIdx);
    }
  }

  requestAnimationFrame(frame);
}

function finishSpin(winnerIdx) {
  const winner = state.names[winnerIdx];
  commentary.stop();

  // pulse the winning segment so you see where it landed before the reveal
  const start = performance.now();
  const highlightFor = 1300;

  function pulse(now) {
    const e = now - start;
    if (e < highlightFor) {
      state.highlight = { idx: winnerIdx, pulse: (Math.sin(e / 110) + 1) / 2 };
      drawWheel();
      requestAnimationFrame(pulse);
      return;
    }
    state.highlight = { idx: winnerIdx, pulse: 0.6 }; // keep a static glow
    drawWheel();
    state.spinning = false;
    namesInput.disabled = false;
    spinBtn.disabled = state.names.length < 2;
    spinBtn.classList.remove("spinning");
    spinBtn.textContent = "SPIN";
    showWinner(winner);
    addToHistory(winner);
    playFanfare();
  }

  requestAnimationFrame(pulse);
}

spinBtn.addEventListener("click", spin);
window.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (e.code === "Space" && !typing) {
    e.preventDefault();
    if ($("winnerOverlay").classList.contains("on")) hideWinner();
    spin();
  }
});

// ---------------------------------------------------------------------
// Winner modal + confetti
// ---------------------------------------------------------------------
let confettiRaf = null;

function showWinner(name) {
  $("winnerName").textContent = name;
  $("winnerOverlay").classList.add("on");
  launchConfetti();
}

function hideWinner() {
  $("winnerOverlay").classList.remove("on");
  if (confettiRaf) cancelAnimationFrame(confettiRaf);
  confettiRaf = null;
}

$("againBtn").addEventListener("click", () => { hideWinner(); spin(); });
$("closeBtn").addEventListener("click", hideWinner);
$("removeBtn").addEventListener("click", () => {
  const winner = $("winnerName").textContent;
  const idx = state.names.indexOf(winner);
  if (idx !== -1) {
    const arr = [...state.names];
    arr.splice(idx, 1);
    setNames(arr);
  }
  hideWinner();
});

function launchConfetti() {
  const cv = $("confetti");
  const cctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // burst outward from behind the winner card, then sway down like real confetti
  const originX = innerWidth / 2;
  const originY = innerHeight * 0.45;
  const parts = Array.from({ length: 200 }, () => {
    const angle = Math.random() * TAU;
    const speed = 5 + Math.random() * 9;
    return {
      x: originX + (Math.random() - 0.5) * 60,
      y: originY + (Math.random() - 0.5) * 40,
      w: 6 + Math.random() * 7,
      h: 8 + Math.random() * 9,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 4, // bias the burst upward
      rot: Math.random() * TAU,
      vr: -0.2 + Math.random() * 0.4,
      swayPhase: Math.random() * TAU,
      swayAmp: 0.6 + Math.random() * 1.4,
    };
  });

  const t0 = performance.now();
  const LIFE = 5200;

  function tick(now) {
    const age = now - t0;
    const fade = Math.max(0, Math.min(1, (LIFE - age) / 900));
    cctx.clearRect(0, 0, innerWidth, innerHeight);
    cctx.globalAlpha = fade;
    for (const p of parts) {
      p.vx *= 0.985; // air drag
      p.vy = p.vy * 0.985 + 0.18; // drag + gravity
      p.x += p.vx + Math.cos(age / 240 + p.swayPhase) * p.swayAmp;
      p.y += p.vy;
      p.rot += p.vr;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cctx.restore();
    }
    cctx.globalAlpha = 1;
    if (age < LIFE && $("winnerOverlay").classList.contains("on")) {
      confettiRaf = requestAnimationFrame(tick);
    } else {
      cctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  confettiRaf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
parseNames();
renderHistory();
sizeCanvas();

// Sync shared state from the server (renders cached copies above first).
fetchLists();
fetchHistory();

// gentle idle drift so the wheel feels alive between spins
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion) {
  (function idleDrift() {
    if (!state.spinning) {
      state.rotation += 0.0007;
      drawWheel();
    }
    requestAnimationFrame(idleDrift);
  })();
}
