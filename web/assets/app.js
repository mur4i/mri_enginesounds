// MRI Engine Sounds — catálogo + player estático (GitHub Pages)
const state = {
  all: [],
  filtered: [],
  filters: {}, // {brand, vehicleType, aspiration, fuel, layout} -> valor ("" = todos)
  query: "",
  currentHash: null, // som tocando agora
  selectedHashes: new Set(),
};

// dimensoes que viram dropdown de filtro (na ordem)
const FILTER_DIMS = [
  { key: "brand", label: "Marca" },
  { key: "vehicleType", label: "Tipo" },
  { key: "aspiration", label: "Aspiração" },
  { key: "fuel", label: "Combustível" },
  { key: "layout", label: "Motor" },
];

// cor (gradiente) + icone por tipo de motor — usado nos placeholders e badges
const ENGINE_META = {
  W16: { c1: "#7b1fa2", c2: "#311b92", icon: "🏎️" },
  V12: { c1: "#8e24aa", c2: "#4a148c", icon: "🏎️" },
  V10: { c1: "#f4511e", c2: "#bf360c", icon: "🏎️" },
  V8:  { c1: "#e53935", c2: "#8e0000", icon: "🏎️" },
  V6:  { c1: "#fb8c00", c2: "#e65100", icon: "🏎️" },
  I6:  { c1: "#1e88e5", c2: "#0d47a1", icon: "🏎️" },
  I5:  { c1: "#3949ab", c2: "#1a237e", icon: "🏎️" },
  I4:  { c1: "#00897b", c2: "#004d40", icon: "🏎️" },
  I3:  { c1: "#00acc1", c2: "#006064", icon: "🏎️" },
  I1:  { c1: "#26a69a", c2: "#004d40", icon: "🏍️" },
  F6:  { c1: "#43a047", c2: "#1b5e20", icon: "🏎️" },
  F4:  { c1: "#7cb342", c2: "#33691e", icon: "🏎️" },
  Rotary:  { c1: "#d81b60", c2: "#880e4f", icon: "🌀" },
  Diesel:  { c1: "#6d4c41", c2: "#3e2723", icon: "🛻" },
  Moto:    { c1: "#00b8d4", c2: "#006978", icon: "🏍️" },
  Other:   { c1: "#546e7a", c2: "#263238", icon: "🔊" },
};
const emeta = (e) => ENGINE_META[e] || ENGINE_META.Other;

const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  selects: document.getElementById("filter-selects"),
  empty: document.getElementById("empty"),
  tpl: document.getElementById("card-tpl"),
  // player
  audio: document.getElementById("audio"),
  bar: document.getElementById("player-bar"),
  pbToggle: document.getElementById("pb-toggle"),
  pbName: document.getElementById("pb-name"),
  pbHash: document.getElementById("pb-hash"),
  pbSeek: document.getElementById("pb-seek"),
  pbTime: document.getElementById("pb-time"),
  pbClose: document.getElementById("pb-close"),
  // selection
  selBar: document.getElementById("selection-bar"),
  selCount: document.getElementById("sel-count"),
  btnClearSel: document.getElementById("btn-clear-sel"),
  btnDownloadPack: document.getElementById("btn-download-pack"),
};

async function init() {
  try {
    const res = await fetch("data/catalog.json", { cache: "no-cache" });
    state.all = await res.json();
  } catch (e) {
    els.grid.innerHTML = '<p class="empty">Falha ao carregar o catálogo.</p>';
    return;
  }
  buildFilters();
  els.search.addEventListener("input", () => {
    state.query = els.search.value.trim().toLowerCase();
    apply();
  });
  setupPlayer();
  if (els.btnClearSel) {
    els.btnClearSel.addEventListener("click", clearSelection);
  }
  if (els.btnDownloadPack) {
    els.btnDownloadPack.addEventListener("click", () => downloadSelectedPack(els.btnDownloadPack));
  }
  apply();
}

function valuesFor(key) {
  const set = new Set();
  for (const s of state.all) {
    const v = s[key];
    if (v && v !== "Desconhecido") set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt"));
}

function buildFilters() {
  els.selects.innerHTML = "";
  for (const dim of FILTER_DIMS) {
    const vals = valuesFor(dim.key);
    if (!vals.length) continue;
    state.filters[dim.key] = "";
    const sel = document.createElement("select");
    sel.className = "fsel";
    sel.innerHTML =
      `<option value="">${dim.label}: todos</option>` +
      vals.map((v) => `<option value="${v}">${v}</option>`).join("");
    sel.addEventListener("change", () => {
      state.filters[dim.key] = sel.value;
      apply();
    });
    els.selects.appendChild(sel);
  }
}

function apply() {
  const q = state.query;
  state.filtered = state.all.filter((s) => {
    for (const dim of FILTER_DIMS) {
      const want = state.filters[dim.key];
      if (want && s[dim.key] !== want) return false;
    }
    if (!q) return true;
    const hay = [s.name, s.hash, s.brand, s.model, s.engineCode, s.displacement, s.author]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
  render();
}

function render() {
  els.grid.innerHTML = "";
  els.count.textContent = state.filtered.length;
  els.empty.hidden = state.filtered.length > 0;

  const frag = document.createDocumentFragment();
  for (const s of state.filtered) {
    const node = els.tpl.content.cloneNode(true);
    const card = node.querySelector(".card");
    card.dataset.hash = s.hash;

    // thumb: imagem real ou placeholder gerado por motor
    const thumb = node.querySelector(".thumb");
    buildThumb(thumb, s);
    thumb.addEventListener("click", () => playHash(s));

    node.querySelector(".name").textContent = s.name;

    const sub = node.querySelector(".sub-model");
    const brandModel = [s.brand, s.model].filter((v) => v && v !== "Desconhecido").join(" · ");
    if (brandModel) sub.textContent = brandModel;
    else sub.remove();

    const meta = node.querySelector(".meta");
    const layout = s.layout || s.engine;
    const badges = [];
    if (layout) badges.push({ t: layout, cls: "b-layout", color: emeta(layout).c1 });
    if (s.displacement && s.displacement !== "Desconhecido") badges.push({ t: s.displacement, cls: "b-disp" });
    if (s.aspiration && s.aspiration !== "Desconhecido" && s.aspiration !== "Aspirado")
      badges.push({ t: s.aspiration, cls: "b-asp" });
    if (s.fuel === "Diesel") badges.push({ t: "Diesel", cls: "b-fuel" });
    if (s.vehicleType && s.vehicleType !== "Carro") badges.push({ t: s.vehicleType, cls: "b-veh" });
    for (const b of badges) {
      const el = document.createElement("span");
      el.className = "badge " + b.cls;
      el.textContent = b.t;
      if (b.color) el.style.borderColor = b.color;
      meta.appendChild(el);
    }

    const hashBtn = node.querySelector(".hash");
    hashBtn.textContent = s.hash;
    hashBtn.addEventListener("click", () => copyHash(hashBtn, s.hash));

    const play = node.querySelector(".play-btn");
    play.addEventListener("click", () => playHash(s));

    const dl = node.querySelector(".dl-btn");
    dl.addEventListener("click", () => downloadResource(s, dl));

    const source = node.querySelector(".source");
    if (s.sourceUrl) source.href = s.sourceUrl;
    else source.remove();

    // Checkbox selection
    const selectWrap = node.querySelector(".card-select-wrap");
    const selectCb = node.querySelector(".card-select");
    
    if (state.selectedHashes.has(s.hash)) {
      card.classList.add("selected");
      selectCb.checked = true;
    }

    selectCb.addEventListener("change", (e) => {
      toggleSelectHash(s.hash, selectCb.checked);
    });

    selectWrap.addEventListener("click", (e) => {
      if (e.target !== selectCb) {
        selectCb.checked = !selectCb.checked;
        toggleSelectHash(s.hash, selectCb.checked);
      }
    });

    frag.appendChild(node);
  }
  els.grid.appendChild(frag);
  syncPlayingState();
}

// monta a capa: <img> se houver imagem, senão um placeholder colorido por motor
function buildThumb(thumb, s) {
  const m = emeta(s.engine);
  if (s.image) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = s.name;
    img.src = "images/" + s.image;
    img.addEventListener("error", () => fillPlaceholder(thumb, s, m));
    thumb.appendChild(img);
  } else {
    fillPlaceholder(thumb, s, m);
  }
  // overlay de play
  const ov = document.createElement("span");
  ov.className = "play-overlay";
  ov.textContent = "▶";
  thumb.appendChild(ov);
}

function fillPlaceholder(thumb, s, m) {
  thumb.classList.add("placeholder");
  thumb.style.background = `linear-gradient(135deg, ${m.c1}, ${m.c2})`;
  const wrap = document.createElement("span");
  wrap.className = "ph-inner";
  wrap.innerHTML =
    `<span class="ph-icon">${m.icon}</span>` +
    `<span class="ph-eng">${s.engine}</span>`;
  thumb.appendChild(wrap);
}

/* ===================== PLAYER (um som por vez) ===================== */

function setupPlayer() {
  const a = els.audio;
  els.pbToggle.addEventListener("click", () => {
    if (a.paused) a.play(); else a.pause();
  });
  els.pbClose.addEventListener("click", stopPlayer);
  a.addEventListener("play", () => { els.pbToggle.textContent = "⏸"; syncPlayingState(); });
  a.addEventListener("pause", () => { els.pbToggle.textContent = "▶"; syncPlayingState(); });
  a.addEventListener("ended", () => { els.pbToggle.textContent = "▶"; syncPlayingState(); });
  a.addEventListener("timeupdate", () => {
    if (a.duration) {
      els.pbSeek.value = String(Math.round((a.currentTime / a.duration) * 1000));
    }
    els.pbTime.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
  });
  a.addEventListener("error", () => {
    if (!a.src) return;
    els.pbName.textContent = "Preview indisponível";
    els.pbHash.textContent = state.currentHash || "";
  });
  els.pbSeek.addEventListener("input", () => {
    if (a.duration) a.currentTime = (Number(els.pbSeek.value) / 1000) * a.duration;
  });
}

function playHash(s) {
  const a = els.audio;
  if (state.currentHash === s.hash) {
    if (a.paused) a.play(); else a.pause();
    return;
  }
  state.currentHash = s.hash;
  els.bar.hidden = false;
  els.pbName.textContent = s.name;
  els.pbHash.textContent = s.hash;
  els.pbSeek.value = "0";
  els.pbTime.textContent = "0:00 / 0:00";
  a.src = "previews/" + s.hash + ".ogg";
  a.play().catch(() => {});
  syncPlayingState();
  updateSelectionBarPosition();
}

function stopPlayer() {
  els.audio.pause();
  els.audio.removeAttribute("src");
  els.audio.load();
  state.currentHash = null;
  els.bar.hidden = true;
  syncPlayingState();
  updateSelectionBarPosition();
}

// atualiza visual dos cards (qual esta tocando)
function syncPlayingState() {
  const playing = state.currentHash && !els.audio.paused;
  for (const card of els.grid.querySelectorAll(".card")) {
    const isCur = card.dataset.hash === state.currentHash;
    card.classList.toggle("playing", !!isCur && !!playing);
    const btn = card.querySelector(".play-btn");
    if (!btn) continue;
    const ico = btn.querySelector(".ico");
    const lbl = btn.querySelector(".lbl");
    if (isCur) {
      ico.textContent = playing ? "⏸" : "▶";
      lbl.textContent = playing ? "Tocando" : "Pausado";
    } else {
      ico.textContent = "▶";
      lbl.textContent = "Tocar";
    }
  }
}

/* ===== Download de um resource FiveM com APENAS o som escolhido ===== */
// Os .awc/.rel nao estao no site (Pages), mas estao no repo: puxamos via raw
// (CORS liberado) e montamos o .zip no proprio navegador com JSZip.
const RAW = "https://raw.githubusercontent.com/mur4i/mri_enginesounds/master/";

async function rawFile(path) {
  // retorna Uint8Array ou null (404/erro)
  try {
    const res = await fetch(RAW + path, { cache: "no-cache" });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (_) {
    return null;
  }
}

function manifestFor(h, hasAmp) {
  const lines = [
    "fx_version 'cerulean'",
    "game 'gta5'",
    "",
    "files {",
    `\t'audio/${h}/*.rel',`,
    `\t'audio/${h}/dlc_${h}/*.awc',`,
    "}",
    "",
  ];
  if (hasAmp) lines.push(`data_file 'AUDIO_SYNTHDATA' 'audio/${h}/${h}_amp.dat'`);
  lines.push(
    `data_file 'AUDIO_GAMEDATA' 'audio/${h}/${h}_game.dat'`,
    `data_file 'AUDIO_SOUNDDATA' 'audio/${h}/${h}_sounds.dat'`,
    `data_file 'AUDIO_WAVEPACK' 'audio/${h}/dlc_${h}'`,
    ""
  );
  return lines.join("\n");
}

async function downloadResource(s, btn) {
  const h = s.hash;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Gerando…";
  try {
    // obrigatorios
    const [game, sounds, awc] = await Promise.all([
      rawFile(`resource/audio/${h}/${h}_game.dat151.rel`),
      rawFile(`resource/audio/${h}/${h}_sounds.dat54.rel`),
      rawFile(`resource/audio/${h}/dlc_${h}/${h}.awc`),
    ]);
    if (!game || !sounds || !awc) {
      btn.textContent = "✕ Indisponível";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
      return;
    }
    // opcionais
    const [amp, npc] = await Promise.all([
      rawFile(`resource/audio/${h}/${h}_amp.dat10.rel`),
      rawFile(`resource/audio/${h}/dlc_${h}/${h}_npc.awc`),
    ]);

    const zip = new JSZip();
    const root = zip.folder(h); // resource = <hash>
    root.file("fxmanifest.lua", manifestFor(h, !!amp));
    const engineDir = root.folder("audio").folder(h);
    engineDir.file(`${h}_game.dat151.rel`, game);
    engineDir.file(`${h}_sounds.dat54.rel`, sounds);
    if (amp) engineDir.file(`${h}_amp.dat10.rel`, amp);
    const dlc = engineDir.folder(`dlc_${h}`);
    dlc.file(`${h}.awc`, awc);
    if (npc) dlc.file(`${h}_npc.awc`, npc);

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${h}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.textContent = "✓ Baixado";
  } catch (e) {
    btn.textContent = "✕ Erro";
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
}

function fmt(t) {
  if (!t || !isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

async function copyHash(btn, hash) {
  try {
    await navigator.clipboard.writeText(hash);
    const prev = btn.textContent;
    btn.classList.add("copied");
    btn.textContent = "copiado ✓ " + hash;
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.textContent = prev;
    }, 1200);
  } catch (_) {}
}

function toggleSelectHash(hash, isChecked) {
  if (isChecked) {
    state.selectedHashes.add(hash);
  } else {
    state.selectedHashes.delete(hash);
  }
  
  for (const card of els.grid.querySelectorAll(".card")) {
    if (card.dataset.hash === hash) {
      card.classList.toggle("selected", isChecked);
      const cb = card.querySelector(".card-select");
      if (cb) cb.checked = isChecked;
    }
  }
  
  updateSelectionBar();
}

function clearSelection() {
  state.selectedHashes.clear();
  for (const card of els.grid.querySelectorAll(".card")) {
    card.classList.remove("selected");
    const cb = card.querySelector(".card-select");
    if (cb) cb.checked = false;
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = state.selectedHashes.size;
  if (count === 0) {
    els.selBar.hidden = true;
    return;
  }
  
  els.selBar.hidden = false;
  els.selCount.textContent = count;
  
  const badge = els.selCount;
  if (count >= 180) {
    badge.className = "sel-count-badge limit-warning";
    els.btnDownloadPack.disabled = true;
    els.btnDownloadPack.title = "Limite de 180 sons addon atingido! Desmarque alguns.";
  } else if (count > 150) {
    badge.className = "sel-count-badge limit-warning";
    els.btnDownloadPack.disabled = false;
    els.btnDownloadPack.title = "Baixar pacote customizado (Aproximando-se do limite de 180)";
  } else {
    badge.className = "sel-count-badge";
    els.btnDownloadPack.disabled = false;
    els.btnDownloadPack.title = "Baixar pacote customizado";
  }
  
  updateSelectionBarPosition();
}

function updateSelectionBarPosition() {
  if (els.selBar) {
    const hasPlayer = !els.bar.hidden;
    if (hasPlayer) {
      els.selBar.style.bottom = "80px";
    } else {
      els.selBar.style.bottom = "20px";
    }
  }
}

function manifestForMultiple(hashes, ampHashingMap, includeScripts) {
  const lines = [
    "fx_version 'cerulean'",
    "games { 'rdr3', 'gta5' }",
    "",
    "author 'MRI Custom Pack'",
    "description 'MRI Engine Sounds - Pacote de audios de motor customizado'",
    ""
  ];

  if (includeScripts) {
    lines.push(
      "server_scripts {",
      "\t'server.lua'",
      "}",
      "client_scripts {",
      "\t'client.lua'",
      "}",
      ""
    );
  }

  lines.push(
    "files {",
    "\t'audio/**/*.dat151.rel',",
    "\t'audio/**/*.dat54.rel',",
    "\t'audio/**/*.dat10.rel',",
    "\t'audio/**/*.awc',",
  );
  if (includeScripts) {
    lines.push("\t'client.lua',", "\t'server.lua',");
  }
  lines.push("}", "");

  for (const h of hashes) {
    const hasAmp = ampHashingMap[h];
    if (hasAmp) lines.push(`data_file 'AUDIO_SYNTHDATA' 'audio/${h}/${h}_amp.dat'`);
    lines.push(
      `data_file 'AUDIO_GAMEDATA' 'audio/${h}/${h}_game.dat'`,
      `data_file 'AUDIO_SOUNDDATA' 'audio/${h}/${h}_sounds.dat'`,
      `data_file 'AUDIO_WAVEPACK' 'audio/${h}/dlc_${h}'`,
      ""
    );
  }
  return lines.join("\n");
}

async function downloadSelectedPack(btn) {
  const hashes = Array.from(state.selectedHashes);
  if (hashes.length === 0) return;
  if (hashes.length > 180) {
    alert("Você selecionou mais de 180 sons. Por favor, desmarque alguns para ficar dentro do limite do GTA V.");
    return;
  }
  
  const orig = btn.textContent;
  btn.disabled = true;
  
  try {
    const zip = new JSZip();
    const root = zip.folder("custom_enginesounds");
    
    const ampHashingMap = {};
    let count = 0;
    const total = hashes.length;
    
    for (const h of hashes) {
      btn.textContent = `⏳ Baixando (${count + 1}/${total})…`;
      
      const [game, sounds, awc] = await Promise.all([
        rawFile(`resource/audio/${h}/${h}_game.dat151.rel`),
        rawFile(`resource/audio/${h}/${h}_sounds.dat54.rel`),
        rawFile(`resource/audio/${h}/dlc_${h}/${h}.awc`),
      ]);
      
      if (!game || !sounds || !awc) {
        console.warn(`Erro ao baixar arquivos para o som: ${h}`);
        continue;
      }
      
      const engineDir = root.folder("audio").folder(h);
      engineDir.file(`${h}_game.dat151.rel`, game);
      engineDir.file(`${h}_sounds.dat54.rel`, sounds);
      
      const [amp, npc] = await Promise.all([
        rawFile(`resource/audio/${h}/${h}_amp.dat10.rel`),
        rawFile(`resource/audio/${h}/dlc_${h}/${h}_npc.awc`),
      ]);
      
      if (amp) {
        engineDir.file(`${h}_amp.dat10.rel`, amp);
        ampHashingMap[h] = true;
      } else {
        ampHashingMap[h] = false;
      }
      
      const dlc = engineDir.folder(`dlc_${h}`);
      dlc.file(`${h}.awc`, awc);
      if (npc) {
        dlc.file(`${h}_npc.awc`, npc);
      }
      
      count++;
    }
    
    if (count === 0) {
      btn.textContent = "✕ Falha";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
      return;
    }
    
    btn.textContent = "⏳ Baixando scripts…";
    const [clientLua, serverLua] = await Promise.all([
      rawFile("client.lua"),
      rawFile("server.lua")
    ]);
    
    const includeScripts = !!clientLua && !!serverLua;
    if (clientLua) root.file("client.lua", clientLua);
    if (serverLua) root.file("server.lua", serverLua);
    
    btn.textContent = "📦 Compactando zip…";
    root.file("fxmanifest.lua", manifestForMultiple(hashes, ampHashingMap, includeScripts));
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custom_enginesounds.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.textContent = "✓ Concluído!";
  } catch (e) {
    console.error(e);
    btn.textContent = "✕ Erro";
  }
  
  setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
    updateSelectionBar();
  }, 2500);
}

init();
