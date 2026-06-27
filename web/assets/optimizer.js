"use strict";

const LIMITS = {
  compressedBytes: 600 * 1024 * 1024,
  uncompressedBytes: 1024 * 1024 * 1024,
  files: 2500,
  xmlBytes: 8 * 1024 * 1024,
};

const META_TYPES = [
  { name: "vehicles.meta", type: "VEHICLE_METADATA_FILE" },
  { name: "handling.meta", type: "HANDLING_FILE" },
  { name: "carvariations.meta", type: "VEHICLE_VARIATION_FILE" },
  { name: "carcols.meta", type: "CARCOLS_FILE" },
  { name: "vehiclelayouts.meta", type: "VEHICLE_LAYOUTS_FILE" },
];
const STREAM_EXTENSIONS = new Set([
  ".yft", ".ytd", ".ydr", ".ydd", ".ybn", ".ymap", ".ytyp", ".ycd", ".awc",
]);
const JUNK_NAMES = new Set(["thumbs.db", ".ds_store", "desktop.ini"]);
const JUNK_EXTENSIONS = new Set([".tmp", ".bak"]);

const elements = {
  uploadPanel: document.getElementById("upload-panel"),
  analysisPanel: document.getElementById("analysis-panel"),
  dropZone: document.getElementById("drop-zone"),
  zipInput: document.getElementById("zip-input"),
  folderInput: document.getElementById("folder-input"),
  chooseZip: document.getElementById("choose-zip"),
  chooseFolder: document.getElementById("choose-folder"),
  status: document.getElementById("optimizer-status"),
  reset: document.getElementById("reset-optimizer"),
  resourceName: document.getElementById("resource-name"),
  metricFiles: document.getElementById("metric-files"),
  metricSize: document.getElementById("metric-size"),
  metricStream: document.getElementById("metric-stream"),
  metricScore: document.getElementById("metric-score"),
  scoreLabel: document.getElementById("score-label"),
  issueSummary: document.getElementById("issue-summary"),
  issuesList: document.getElementById("issues-list"),
  fixesList: document.getElementById("fixes-list"),
  download: document.getElementById("download-optimized"),
  downloadNote: document.getElementById("download-note"),
};

let currentSession = null;
const catalogHashesPromise = fetch("data/catalog.json", { cache: "no-cache" })
  .then(function (response) { return response.ok ? response.json() : []; })
  .then(function (items) {
    return new Set(items.map(function (item) { return String(item.hash || "").toLowerCase(); }));
  })
  .catch(function () { return new Set(); });

function initialize() {
  elements.chooseZip.addEventListener("click", function (event) {
    event.stopPropagation();
    elements.zipInput.click();
  });
  elements.chooseFolder.addEventListener("click", function (event) {
    event.stopPropagation();
    elements.folderInput.click();
  });
  elements.dropZone.addEventListener("click", function () { elements.zipInput.click(); });
  elements.dropZone.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.zipInput.click();
    }
  });
  elements.zipInput.addEventListener("change", function () {
    const file = elements.zipInput.files[0];
    if (file) openZip(file);
  });
  elements.folderInput.addEventListener("change", function () {
    const files = Array.from(elements.folderInput.files);
    if (files.length) openFolder(files);
  });
  ["dragenter", "dragover"].forEach(function (eventName) {
    elements.dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach(function (eventName) {
    elements.dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  });
  elements.dropZone.addEventListener("drop", function (event) {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
      openZip(files[0]);
      return;
    }
    setStatus("Para preservar as pastas, arraste um ZIP ou use “Escolher pasta”.", true);
  });
  elements.reset.addEventListener("click", resetOptimizer);
  elements.download.addEventListener("click", generateOptimizedZip);
}

async function openZip(file) {
  if (!window.JSZip) {
    setStatus("Não foi possível carregar o leitor de ZIP local.", true);
    return;
  }
  if (!file.name.toLowerCase().endsWith(".zip")) {
    setStatus("Escolha um arquivo .zip de resource FiveM.", true);
    return;
  }
  if (file.size > LIMITS.compressedBytes) {
    setStatus("O ZIP excede o limite local de " + formatBytes(LIMITS.compressedBytes) + ".", true);
    return;
  }

  setBusy("Abrindo o ZIP localmente…");
  try {
    const zip = await JSZip.loadAsync(file, { createFolders: true, checkCRC32: false });
    const rawEntries = [];
    for (const zipEntry of Object.values(zip.files)) {
      if (zipEntry.dir) continue;
      const originalPath = zipEntry.unsafeOriginalName || zipEntry.name;
      const path = normalizeSafePath(originalPath);
      if (!path) throw new Error("Caminho inseguro encontrado no ZIP: " + originalPath);
      const size = Number(zipEntry._data && zipEntry._data.uncompressedSize) || 0;
      rawEntries.push({
        originalPath: path,
        size: size,
        readBytes: function () { return zipEntry.async("uint8array"); },
        readText: function () { return zipEntry.async("string"); },
      });
    }
    await createSession(file.name.replace(/\.zip$/i, ""), rawEntries, file.size, "zip");
  } catch (error) {
    setStatus(readableError(error, "Não foi possível abrir este ZIP."), true);
  }
}

async function openFolder(files) {
  setBusy("Lendo a pasta localmente…");
  try {
    const rawEntries = files.map(function (file) {
      const unsafePath = file.webkitRelativePath || file.name;
      const path = normalizeSafePath(unsafePath);
      if (!path) throw new Error("Caminho inseguro encontrado: " + unsafePath);
      return {
        originalPath: path,
        size: file.size,
        readBytes: async function () { return new Uint8Array(await file.arrayBuffer()); },
        readText: function () { return file.text(); },
      };
    });
    const firstPath = files[0].webkitRelativePath || files[0].name;
    const name = firstPath.split(/[\\/]/)[0] || "vehicle_resource";
    const total = files.reduce(function (sum, file) { return sum + file.size; }, 0);
    await createSession(name, rawEntries, total, "folder");
  } catch (error) {
    setStatus(readableError(error, "Não foi possível ler esta pasta."), true);
  }
}

async function createSession(rawName, rawEntries, sourceBytes, sourceType) {
  if (!rawEntries.length) throw new Error("O resource está vazio.");
  if (rawEntries.length > LIMITS.files) {
    throw new Error("O resource possui " + rawEntries.length + " arquivos; o limite seguro é " + LIMITS.files + ".");
  }
  const paths = rawEntries.map(function (entry) { return entry.originalPath; });
  const root = commonRoot(paths);
  const entries = rawEntries.map(function (entry) {
    return Object.assign({}, entry, {
      path: root ? entry.originalPath.slice(root.length + 1) : entry.originalPath,
    });
  }).filter(function (entry) { return entry.path; });
  const totalBytes = entries.reduce(function (sum, entry) { return sum + entry.size; }, 0);
  if (totalBytes > LIMITS.uncompressedBytes) {
    throw new Error("O conteúdo descompactado excede " + formatBytes(LIMITS.uncompressedBytes) + ".");
  }

  currentSession = {
    name: safeResourceName(root || rawName),
    sourceType: sourceType,
    sourceBytes: sourceBytes,
    entries: entries,
    totalBytes: totalBytes,
    streamBytes: 0,
    issues: [],
    fixes: new Map(),
    junkPaths: new Set(),
    moveMap: new Map(),
    manifestPatch: "",
    generatedManifest: "",
    manifestPath: "fxmanifest.lua",
    score: 0,
  };
  setStatus("Analisando manifesto, metas e assets…");
  await analyze(currentSession);
  renderAnalysis(currentSession);
}

async function analyze(session) {
  const issues = session.issues;
  function addIssue(severity, title, detail, fixId) {
    issues.push({ severity: severity, title: title, detail: detail, fixId: fixId || "" });
  }
  function registerFix(id, title, description) {
    if (!session.fixes.has(id)) session.fixes.set(id, { id: id, title: title, description: description });
  }

  const byLowerPath = new Map();
  const byBaseName = new Map();
  session.entries.forEach(function (entry) {
    const lowerPath = entry.path.toLowerCase();
    if (!byLowerPath.has(lowerPath)) byLowerPath.set(lowerPath, []);
    byLowerPath.get(lowerPath).push(entry);
    const base = baseName(entry.path).toLowerCase();
    if (!byBaseName.has(base)) byBaseName.set(base, []);
    byBaseName.get(base).push(entry);
  });

  const caseCollisions = Array.from(byLowerPath.values()).filter(function (group) { return group.length > 1; });
  if (caseCollisions.length) {
    addIssue("error", "Arquivos com caminhos conflitantes", caseCollisions.length + " caminho(s) diferem apenas por maiúsculas/minúsculas e podem quebrar em servidores Linux.");
  }
  const duplicateNames = Array.from(byBaseName.entries()).filter(function (pair) {
    return pair[1].length > 1 && !["readme.md", "readme.txt", "license"].includes(pair[0]);
  });
  if (duplicateNames.length) {
    addIssue("warning", "Nomes de arquivo repetidos", duplicateNames.length + " nome(s) aparecem em mais de uma pasta. Revise possíveis cópias ou conflitos.");
  }

  session.entries.forEach(function (entry) {
    const name = baseName(entry.path).toLowerCase();
    if (JUNK_NAMES.has(name) || JUNK_EXTENSIONS.has(fileExtension(name))) session.junkPaths.add(entry.path);
  });
  if (session.junkPaths.size) {
    const junkBytes = session.entries
      .filter(function (entry) { return session.junkPaths.has(entry.path); })
      .reduce(function (sum, entry) { return sum + entry.size; }, 0);
    registerFix("remove-junk", "Remover arquivos temporários", session.junkPaths.size + " arquivo(s), " + formatBytes(junkBytes) + ".");
    addIssue("warning", "Arquivos temporários encontrados", session.junkPaths.size + " item(ns) como Thumbs.db, .tmp ou .bak podem ser removidos.", "remove-junk");
  }

  const streamEntries = session.entries.filter(function (entry) { return isInsideStream(entry.path); });
  session.streamBytes = streamEntries.reduce(function (sum, entry) { return sum + entry.size; }, 0);
  const looseAssets = session.entries.filter(function (entry) {
    return STREAM_EXTENSIONS.has(fileExtension(entry.path)) && !isInsideStream(entry.path);
  });
  const occupiedPaths = new Set(session.entries.map(function (entry) { return entry.path.toLowerCase(); }));
  const movable = [];
  looseAssets.forEach(function (entry) {
    const target = "stream/" + baseName(entry.path);
    if (!occupiedPaths.has(target.toLowerCase())) {
      session.moveMap.set(entry.path, target);
      movable.push(entry);
    }
  });
  if (movable.length) {
    registerFix("move-stream", "Mover assets soltos para stream/", movable.length + " arquivo(s) GTA serão organizados.");
    addIssue("warning", "Assets fora da pasta stream", movable.length + " arquivo(s) compilado(s) podem ser movidos com segurança para stream/.", "move-stream");
  }
  if (looseAssets.length > movable.length) {
    addIssue("error", "Colisão ao organizar stream", (looseAssets.length - movable.length) + " asset(s) solto(s) já possuem um arquivo com o mesmo nome em stream/.");
  }

  const allStreamLike = session.entries.filter(function (entry) {
    return STREAM_EXTENSIONS.has(fileExtension(entry.path));
  });
  if (!allStreamLike.length) {
    addIssue("error", "Nenhum asset de veículo encontrado", "Não encontramos arquivos .yft, .ytd, .ydr, .ydd ou outros assets GTA no resource.");
  } else {
    addIssue("ok", "Assets GTA reconhecidos", allStreamLike.length + " arquivo(s) compilado(s) detectado(s).");
  }

  const largeTextures = session.entries.filter(function (entry) {
    return fileExtension(entry.path) === ".ytd" && entry.size > 16 * 1024 * 1024;
  });
  if (largeTextures.length) addIssue("warning", "Dicionários de textura pesados", summarizeLargeFiles(largeTextures, "YTD"));
  const largeModels = session.entries.filter(function (entry) {
    return fileExtension(entry.path) === ".yft" && entry.size > 16 * 1024 * 1024;
  });
  if (largeModels.length) addIssue("warning", "Modelos YFT pesados", summarizeLargeFiles(largeModels, "YFT"));
  if (session.streamBytes > 200 * 1024 * 1024) {
    addIssue("warning", "Stream muito grande", "A pasta stream usa " + formatBytes(session.streamBytes) + ". Isso aumenta download, cache e memória dos jogadores.");
  }

  const manifest = firstByBaseName(byBaseName, "fxmanifest.lua");
  const legacyManifest = firstByBaseName(byBaseName, "__resource.lua");
  const detectedMetas = META_TYPES.map(function (meta) {
    return Object.assign({}, meta, { entry: firstByBaseName(byBaseName, meta.name) });
  }).filter(function (meta) { return meta.entry; });

  if (!manifest) {
    session.generatedManifest = generateManifest(detectedMetas);
    registerFix("generate-manifest", "Criar fxmanifest.lua", "Gera um manifesto Cerulean a partir dos metas encontrados.");
    addIssue("error", "fxmanifest.lua ausente", legacyManifest
      ? "Existe apenas um __resource.lua legado. Podemos gerar um manifesto moderno sem apagar o antigo."
      : "O FiveM precisa de um manifesto para iniciar o resource.", "generate-manifest");
  } else {
    session.manifestPath = manifest.path;
    const manifestText = await safeReadText(manifest);
    const lowerManifest = manifestText.toLowerCase();
    if (!/\bfx_version\s+['"]/.test(manifestText)) {
      addIssue("warning", "fx_version não identificado", "O manifesto pode estar incompleto ou usar uma sintaxe não reconhecida.");
    }
    if (!/\bgames?\s*(?:\{|['"])/.test(manifestText)) {
      addIssue("warning", "Jogo não declarado", "O manifesto não declara game 'gta5' ou uma lista de games.");
    }
    const missingMetaDeclarations = detectedMetas.filter(function (meta) {
      return !lowerManifest.includes(meta.type.toLowerCase());
    });
    if (missingMetaDeclarations.length) {
      session.manifestPatch = generateManifestPatch(missingMetaDeclarations);
      registerFix("patch-manifest", "Completar declarações do manifesto", "Adiciona " + missingMetaDeclarations.length + " data_file ausente(s), preservando o conteúdo existente.");
      addIssue("warning", "Metas não declarados no manifesto", missingMetaDeclarations.map(function (meta) { return meta.name; }).join(", ") + " não possuem a declaração data_file esperada.", "patch-manifest");
    } else if (detectedMetas.length) {
      addIssue("ok", "Manifesto reconhece os metas", detectedMetas.length + " arquivo(s) de configuração estão declarados.");
    }
  }

  const vehiclesEntry = firstByBaseName(byBaseName, "vehicles.meta");
  if (!vehiclesEntry) {
    addIssue("error", "vehicles.meta ausente", "Não foi possível validar modelos, handling, texturas ou audioNameHash.");
  } else {
    await analyzeMetadata(session, byBaseName, vehiclesEntry, addIssue);
  }

  const errors = issues.filter(function (issue) { return issue.severity === "error"; }).length;
  const warnings = issues.filter(function (issue) { return issue.severity === "warning"; }).length;
  const info = issues.filter(function (issue) { return issue.severity === "info"; }).length;
  session.score = Math.max(0, 100 - errors * 18 - warnings * 7 - info);
}

async function analyzeMetadata(session, byBaseName, vehiclesEntry, addIssue) {
  const vehicles = await parseXmlEntry(vehiclesEntry, addIssue);
  if (!vehicles) return;
  const models = uniqueTagTexts(vehicles, "modelName");
  const txds = uniqueTagTexts(vehicles, "txdName");
  const handlingIds = uniqueTagTexts(vehicles, "handlingId");
  const audioHashes = uniqueTagTexts(vehicles, "audioNameHash");
  if (!models.length) {
    addIssue("error", "Nenhum modelName válido", "O vehicles.meta não contém um nome de modelo reconhecível.");
    return;
  }
  addIssue("ok", "vehicles.meta válido", models.length + " modelo(s) encontrado(s): " + models.slice(0, 4).join(", ") + (models.length > 4 ? "…" : "") + ".");

  const yftNames = new Set(session.entries
    .filter(function (entry) { return fileExtension(entry.path) === ".yft"; })
    .map(function (entry) { return stem(entry.path).replace(/_hi$/i, "").toLowerCase(); }));
  const missingModels = models.filter(function (model) { return !yftNames.has(model.toLowerCase()); });
  if (missingModels.length) {
    addIssue("warning", "Modelo sem YFT correspondente", "Não encontramos .yft para: " + missingModels.slice(0, 6).join(", ") + (missingModels.length > 6 ? "…" : "") + ".");
  }

  const ytdNames = new Set(session.entries
    .filter(function (entry) { return fileExtension(entry.path) === ".ytd"; })
    .map(function (entry) { return stem(entry.path).toLowerCase(); }));
  const missingTextures = txds.filter(function (txd) {
    return txd && txd.toLowerCase() !== "null" && !ytdNames.has(txd.toLowerCase());
  });
  if (missingTextures.length) {
    addIssue("warning", "TXD sem arquivo correspondente", "Não encontramos .ytd para: " + missingTextures.slice(0, 6).join(", ") + (missingTextures.length > 6 ? "…" : "") + ".");
  }

  const handlingEntry = firstByBaseName(byBaseName, "handling.meta");
  if (handlingEntry) {
    const handling = await parseXmlEntry(handlingEntry, addIssue);
    if (handling) {
      const names = new Set(uniqueTagTexts(handling, "handlingName").map(function (name) { return name.toLowerCase(); }));
      const missing = handlingIds.filter(function (id) { return id && !names.has(id.toLowerCase()); });
      if (missing.length) {
        addIssue("warning", "Handling não localizado", missing.slice(0, 6).join(", ") + " não aparece no handling.meta local; pode ser um handling do jogo base.");
      } else if (handlingIds.length) {
        addIssue("ok", "Referências de handling consistentes", handlingIds.length + " handlingId(s) conferido(s).");
      }
    }
  } else if (handlingIds.length) {
    addIssue("info", "Sem handling.meta local", "O veículo pode depender de um handling do jogo base ou de outro resource.");
  }

  const variationsEntry = firstByBaseName(byBaseName, "carvariations.meta");
  if (variationsEntry) {
    const variations = await parseXmlEntry(variationsEntry, addIssue);
    if (variations) {
      const modelSet = new Set(models.map(function (model) { return model.toLowerCase(); }));
      const unknown = uniqueTagTexts(variations, "modelName").filter(function (model) {
        return !modelSet.has(model.toLowerCase());
      });
      if (unknown.length) {
        addIssue("warning", "Carvariation aponta para outro modelo", unknown.slice(0, 6).join(", ") + " não está declarado no vehicles.meta.");
      }
    }
  }

  const catalogHashes = await catalogHashesPromise;
  const customAudio = audioHashes.filter(function (hash) { return hash && hash.toUpperCase() !== "NULL"; });
  const catalogMatches = customAudio.filter(function (hash) { return catalogHashes.has(hash.toLowerCase()); });
  if (catalogMatches.length) {
    addIssue("ok", "Som disponível no catálogo MRI", catalogMatches.join(", ") + " pode ser ouvido e baixado na aba Catálogo.");
  } else if (!customAudio.length) {
    addIssue("info", "audioNameHash vazio", "O veículo usará o som padrão associado pelo jogo ou ficará sem uma substituição explícita.");
  } else {
    addIssue("info", "Som externo ao catálogo MRI", customAudio.join(", ") + " pode ser válido, mas não faz parte deste pacote de sons.");
  }
}

async function parseXmlEntry(entry, addIssue) {
  if (entry.size > LIMITS.xmlBytes) {
    addIssue("warning", baseName(entry.path) + " muito grande", "O XML excede " + formatBytes(LIMITS.xmlBytes) + " e não foi aberto para proteger o navegador.");
    return null;
  }
  try {
    const text = await entry.readText();
    const documentNode = new DOMParser().parseFromString(text, "application/xml");
    if (documentNode.querySelector("parsererror")) {
      addIssue("error", "XML inválido em " + baseName(entry.path), "O arquivo possui erro de sintaxe e pode impedir o resource de carregar.");
      return null;
    }
    return documentNode;
  } catch (_) {
    addIssue("error", "Falha ao ler " + baseName(entry.path), "O arquivo não pôde ser interpretado como texto XML.");
    return null;
  }
}

function renderAnalysis(session) {
  elements.uploadPanel.hidden = true;
  elements.analysisPanel.hidden = false;
  elements.resourceName.textContent = session.name;
  elements.metricFiles.textContent = new Intl.NumberFormat("pt-BR").format(session.entries.length);
  elements.metricSize.textContent = formatBytes(session.totalBytes);
  elements.metricStream.textContent = formatBytes(session.streamBytes);
  elements.metricScore.textContent = session.score + "/100";
  elements.scoreLabel.textContent = scoreLabel(session.score);
  elements.metricScore.style.color = scoreColor(session.score);
  renderIssues(session.issues);
  renderFixes(session);
  elements.download.textContent = session.fixes.size ? "Gerar ZIP otimizado" : "Baixar cópia validada";
  elements.download.disabled = false;
  elements.downloadNote.textContent = "As correções são aplicadas somente à cópia baixada.";
  window.scrollTo({ top: Math.max(0, elements.analysisPanel.offsetTop - 24), behavior: "smooth" });
}

function renderIssues(issues) {
  elements.issuesList.replaceChildren();
  elements.issueSummary.replaceChildren();
  const counts = {
    error: issues.filter(function (issue) { return issue.severity === "error"; }).length,
    warning: issues.filter(function (issue) { return issue.severity === "warning"; }).length,
    ok: issues.filter(function (issue) { return issue.severity === "ok"; }).length,
  };
  [["error", "erros"], ["warning", "avisos"], ["ok", "ok"]].forEach(function (pair) {
    const pill = document.createElement("span");
    pill.className = "summary-pill " + pair[0];
    pill.textContent = String(counts[pair[0]]);
    pill.title = counts[pair[0]] + " " + pair[1];
    elements.issueSummary.appendChild(pill);
  });
  const icons = { error: "!", warning: "△", info: "i", ok: "✓" };
  const ordered = issues.slice().sort(function (a, b) {
    return severityOrder(a.severity) - severityOrder(b.severity);
  });
  ordered.forEach(function (issue) {
    const row = document.createElement("article");
    row.className = "issue-row " + issue.severity;
    const icon = document.createElement("span");
    icon.className = "issue-icon";
    icon.textContent = icons[issue.severity] || "·";
    const content = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = issue.title;
    const detail = document.createElement("p");
    detail.textContent = issue.detail;
    content.append(title, detail);
    row.append(icon, content);
    elements.issuesList.appendChild(row);
  });
}

function renderFixes(session) {
  elements.fixesList.replaceChildren();
  if (!session.fixes.size) {
    const empty = document.createElement("p");
    empty.className = "no-fixes";
    empty.textContent = "Nenhuma correção automática necessária.";
    elements.fixesList.appendChild(empty);
    return;
  }
  session.fixes.forEach(function (fix) {
    const label = document.createElement("label");
    label.className = "fix-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = fix.id;
    input.checked = true;
    const content = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = fix.title;
    const detail = document.createElement("small");
    detail.textContent = fix.description;
    content.append(title, detail);
    label.append(input, content);
    elements.fixesList.appendChild(label);
  });
}

async function generateOptimizedZip() {
  const session = currentSession;
  if (!session || !window.JSZip) return;
  const selectedFixes = new Set(Array.from(elements.fixesList.querySelectorAll("input:checked")).map(function (input) {
    return input.value;
  }));
  elements.download.disabled = true;
  elements.download.textContent = "Preparando arquivos…";
  elements.downloadNote.textContent = "Resources grandes podem usar bastante memória do navegador.";
  try {
    const output = new JSZip();
    const root = output.folder(safeResourceName(session.name) + "_optimized");
    let processed = 0;
    for (const entry of session.entries) {
      if (selectedFixes.has("remove-junk") && session.junkPaths.has(entry.path)) continue;
      let targetPath = entry.path;
      if (selectedFixes.has("move-stream") && session.moveMap.has(entry.path)) targetPath = session.moveMap.get(entry.path);
      let data;
      if (selectedFixes.has("patch-manifest") && entry.path === session.manifestPath && session.manifestPatch) {
        data = (await entry.readText()).replace(/\s+$/, "") + "\n" + session.manifestPatch;
      } else {
        data = await entry.readBytes();
      }
      root.file(targetPath, data);
      processed += 1;
      if (processed % 20 === 0) {
        elements.download.textContent = "Lendo arquivos " + processed + "/" + session.entries.length + "…";
      }
    }
    if (selectedFixes.has("generate-manifest") && session.generatedManifest) {
      root.file("fxmanifest.lua", session.generatedManifest);
    }
    const blob = await output.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true },
      function (metadata) { elements.download.textContent = "Compactando " + Math.round(metadata.percent) + "%…"; },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeResourceName(session.name) + "_optimized.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    elements.download.textContent = "✓ ZIP gerado";
    elements.downloadNote.textContent = formatBytes(blob.size) + " gerados localmente. O original não foi alterado.";
  } catch (error) {
    console.error(error);
    elements.download.textContent = "Falha ao gerar ZIP";
    elements.downloadNote.textContent = "O navegador pode ter ficado sem memória ou algum arquivo não pôde ser lido.";
  }
  setTimeout(function () {
    if (!currentSession) return;
    elements.download.disabled = false;
    elements.download.textContent = currentSession.fixes.size ? "Gerar ZIP otimizado" : "Baixar cópia validada";
  }, 2200);
}

function generateManifest(detectedMetas) {
  const lines = [
    "fx_version \"cerulean\"",
    "game \"gta5\"",
    "",
    "author \"MRI local optimizer\"",
    "description \"Vehicle resource validated locally\"",
    "",
  ];
  if (detectedMetas.length) {
    lines.push("files {");
    detectedMetas.forEach(function (meta) { lines.push("    \"" + meta.entry.path + "\","); });
    lines.push("}", "");
    detectedMetas.forEach(function (meta) {
      lines.push("data_file \"" + meta.type + "\" \"" + meta.entry.path + "\"");
    });
    lines.push("");
  }
  return lines.join("\n");
}

function generateManifestPatch(metas) {
  const lines = ["", "-- MRI optimizer: declaracoes de metas ausentes", "files {"];
  metas.forEach(function (meta) { lines.push("    \"" + meta.entry.path + "\","); });
  lines.push("}", "");
  metas.forEach(function (meta) {
    lines.push("data_file \"" + meta.type + "\" \"" + meta.entry.path + "\"");
  });
  lines.push("");
  return lines.join("\n");
}

function normalizeSafePath(value) {
  if (!value || value.includes("\0")) return "";
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (/^(?:\/|[a-z]:\/)/i.test(normalized)) return "";
  const parts = normalized.split("/").filter(function (part) { return part && part !== "."; });
  if (!parts.length || parts.some(function (part) { return part === ".."; })) return "";
  return parts.join("/");
}
function commonRoot(paths) {
  if (!paths.length || paths.some(function (path) { return !path.includes("/"); })) return "";
  const first = paths[0].split("/")[0];
  return paths.every(function (path) {
    return path.split("/")[0].toLowerCase() === first.toLowerCase();
  }) ? first : "";
}
function firstByBaseName(map, name) {
  const entries = map.get(name.toLowerCase());
  return entries && entries[0] ? entries[0] : null;
}
function baseName(path) { return path.split("/").pop() || path; }
function fileExtension(path) {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}
function stem(path) {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(0, index) : name;
}
function isInsideStream(path) { return /(^|\/)stream\//i.test(path); }
function uniqueTagTexts(documentNode, tagName) {
  return Array.from(new Set(Array.from(documentNode.getElementsByTagName(tagName))
    .map(function (node) { return (node.textContent || "").trim(); })
    .filter(Boolean)));
}
async function safeReadText(entry) {
  if (entry.size > LIMITS.xmlBytes) return "";
  try { return await entry.readText(); } catch (_) { return ""; }
}
function safeResourceName(name) {
  const cleaned = String(name || "vehicle_resource")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return cleaned || "vehicle_resource";
}
function summarizeLargeFiles(entries, type) {
  const names = entries.slice().sort(function (a, b) { return b.size - a.size; }).slice(0, 4)
    .map(function (entry) { return baseName(entry.path) + " (" + formatBytes(entry.size) + ")"; });
  return entries.length + " " + type + "(s) acima de 16 MB merecem revisão: " + names.join(", ") + (entries.length > 4 ? "…" : "") + ".";
}
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + " KB";
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (value / 1024 / 1024 / 1024).toFixed(1) + " GB";
}
function scoreLabel(score) {
  if (score >= 90) return "excelente";
  if (score >= 75) return "boa estrutura";
  if (score >= 55) return "precisa revisão";
  return "problemas importantes";
}
function scoreColor(score) {
  if (score >= 75) return "var(--green)";
  if (score >= 55) return "var(--yellow)";
  return "var(--red)";
}
function severityOrder(severity) {
  const order = { error: 0, warning: 1, info: 2, ok: 3 };
  return Object.prototype.hasOwnProperty.call(order, severity) ? order[severity] : 4;
}
function setBusy(message) {
  setStatus(message);
  elements.zipInput.value = "";
  elements.folderInput.value = "";
}
function setStatus(message, isError) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", Boolean(isError));
}
function readableError(error, fallback) { return error && error.message ? error.message : fallback; }
function resetOptimizer() {
  currentSession = null;
  elements.analysisPanel.hidden = true;
  elements.uploadPanel.hidden = false;
  elements.issuesList.replaceChildren();
  elements.fixesList.replaceChildren();
  setStatus("");
  window.scrollTo({ top: elements.uploadPanel.offsetTop - 30, behavior: "smooth" });
}

initialize();
