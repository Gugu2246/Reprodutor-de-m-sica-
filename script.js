"use strict";

/* ==========================================================
   Helpers
   ========================================================== */
const $ = id => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setIcon(element, name) {
  element.innerHTML = "";
  element.appendChild(el("span", "material-symbols-rounded", name));
}

// A capa vem SEMPRE de song.cover (fonte única)
function setCover(element, url) {
  element.innerHTML = "";

  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Capa da música";
    img.draggable = false;
    element.appendChild(img);
  } else {
    setIcon(element, "music_note");
  }
}

function fmt(t) {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/* ==========================================================
   Armazenamento permanente (IndexedDB)
   ========================================================== */
const DB_NAME = "musica-db";
const STORE = "songs";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbReady = (() => {
  try {
    return openDB().catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
})();

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

async function dbPut(record) {
  const db = await dbReady;
  if (!db) return;
  db.transaction(STORE, "readwrite").objectStore(STORE).put(record);
}

async function dbDelete(id) {
  const db = await dbReady;
  if (!db) return;
  db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
}

async function dbGetAll() {
  const db = await dbReady;
  if (!db) return [];
  return new Promise(resolve => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

function toRecord(song) {
  return {
    id: song.id,
    name: song.name,
    artist: song.artist,
    favorite: song.favorite,
    file: song.file,
    coverBlob: song.coverBlob || null,
    playCount: song.playCount || 0,
    lastPlayed: song.lastPlayed || 0,
    lyrics: song.lyrics || ""
  };
}

function makeSong(r) {
  return {
    id: r.id,
    name: r.name,
    artist: r.artist,
    favorite: !!r.favorite,
    file: r.file,
    url: URL.createObjectURL(r.file),
    coverBlob: r.coverBlob || null,
    cover: r.coverBlob ? URL.createObjectURL(r.coverBlob) : null,
    playCount: r.playCount || 0,
    lastPlayed: r.lastPlayed || 0,
    lyrics: r.lyrics || "",
    seed: null
  };
}

/* ==========================================================
   Estado
   ========================================================== */
const audio = $("audio");
const fileInput = $("fileInput");
const lrcInput = $("lrcInput");

const songs = [];
let currentId = null;
let queue = [];
let history = [];
let shuffle = false;
let repeat = "off"; // off | all | one
let libraryFilter = "all"; // all | fav | id de playlist
let playlists = lsGet("playlists", []);
let mixMode = lsGet("mixMode", "plays"); // plays | recent
let manualTheme = lsGet("manualTheme", null);
let seeking = false;
let lyricsView = false;
let fpOpen = false;
let homeMain = null;
let lrcTargetId = null;
let seed = { h: 215, s: 0.8 };

const getSong = id => songs.find(s => s.id === id) || null;
const current = () => getSong(currentId);
const allIds = () => songs.map(s => s.id);

function savePlaylists() {
  lsSet("playlists", playlists);
}

/* ==========================================================
   Cor dinâmica (Material 3) — extraída da capa
   ========================================================== */
const DEFAULT_SEED = { h: 215, s: 0.8 };
const rootStyle = document.documentElement.style;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }

  return [h, s, l];
}

function extractSeed(url) {
  return new Promise(resolve => {
    const img = new Image();

    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        const weight = new Array(36).fill(0);
        const satSum = new Array(36).fill(0);

        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          if (l < 0.12 || l > 0.92) continue;
          const w = s * (1 - Math.abs(2 * l - 1));
          const bin = Math.floor(h / 10) % 36;
          weight[bin] += w;
          satSum[bin] += s * w;
        }

        let best = 0;
        for (let i = 1; i < 36; i++) {
          if (weight[i] > weight[best]) best = i;
        }

        if (weight[best] < 0.8) {
          resolve({ h: 220, s: 0.06 }); // capa praticamente cinza
          return;
        }

        resolve({
          h: best * 10 + 5,
          s: Math.min(0.75, Math.max(0.3, satSum[best] / weight[best]))
        });
      } catch {
        resolve(DEFAULT_SEED);
      }
    };

    img.onerror = () => resolve(DEFAULT_SEED);
    img.src = url;
  });
}

function hsl(h, s, l) {
  return "hsl(" + h + " " + s + "% " + l + "%)";
}

function applyPalette() {
  const light = document.body.classList.contains("light");
  const h = Math.round(seed.h);
  const sat = Math.round(Math.min(Math.max(seed.s, 0.04), 0.8) * 100);
  const set = (name, value) => rootStyle.setProperty(name, value);
  const k = f => Math.round(sat * f);

  if (!light) {
    set("--md-primary", hsl(h, sat, 80));
    set("--md-on-primary", hsl(h, sat, 16));
    set("--md-primary-container", hsl(h, k(0.75), 28));
    set("--md-on-primary-container", hsl(h, Math.min(sat + 10, 100), 90));
    set("--md-secondary-container", hsl(h, k(0.3), 26));
    set("--md-on-secondary-container", hsl(h, k(0.4), 90));
    set("--md-surface", hsl(h, k(0.25), 7));
    set("--md-surface-container", hsl(h, k(0.22), 11));
    set("--md-surface-container-high", hsl(h, k(0.2), 15));
    set("--md-surface-container-highest", hsl(h, k(0.2), 19));
    set("--md-on-surface", hsl(h, 12, 92));
    set("--md-on-surface-variant", hsl(h, 10, 72));
    set("--md-outline-variant", hsl(h, 10, 30));
    set("--glow", "hsl(" + h + " " + k(0.75) + "% 30% / .6)");
  } else {
    set("--md-primary", hsl(h, sat, 38));
    set("--md-on-primary", "#ffffff");
    set("--md-primary-container", hsl(h, Math.min(sat + 15, 100), 88));
    set("--md-on-primary-container", hsl(h, sat, 14));
    set("--md-secondary-container", hsl(h, k(0.4), 88));
    set("--md-on-secondary-container", hsl(h, k(0.5), 14));
    set("--md-surface", hsl(h, k(0.3), 97));
    set("--md-surface-container", hsl(h, k(0.28), 94));
    set("--md-surface-container-high", hsl(h, k(0.26), 91));
    set("--md-surface-container-highest", hsl(h, k(0.26), 88));
    set("--md-on-surface", hsl(h, 12, 10));
    set("--md-on-surface-variant", hsl(h, 8, 34));
    set("--md-outline-variant", hsl(h, 10, 78));
    set("--glow", "hsl(" + h + " " + Math.min(sat + 15, 100) + "% 80% / .75)");
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", hsl(h, light ? k(0.3) : k(0.25), light ? 97 : 7));
  }
}

let colorToken = 0;

async function updateColor() {
  const song = current() || homeMain;
  const token = ++colorToken;

  if (!song || !song.cover) {
    seed = DEFAULT_SEED;
    applyPalette();
    return;
  }

  if (!song.seed) {
    song.seed = await extractSeed(song.cover);
  }

  if (token !== colorToken) return;
  seed = song.seed;
  applyPalette();
}

/* ---------- Tema claro/escuro ---------- */
const systemTheme = window.matchMedia("(prefers-color-scheme: light)");

function applyTheme() {
  const light = manualTheme === null
    ? systemTheme.matches
    : manualTheme === "light";

  document.body.classList.toggle("light", light);
  setIcon($("themeBtn"), light ? "dark_mode" : "light_mode");
  applyPalette();
}

$("themeBtn").onclick = () => {
  manualTheme = document.body.classList.contains("light") ? "dark" : "light";
  lsSet("manualTheme", manualTheme);
  applyTheme();
};

systemTheme.addEventListener("change", () => {
  if (manualTheme === null) applyTheme();
});

/* ==========================================================
   Navegação
   ========================================================== */
const pageIds = {
  home: "homePage",
  search: "searchPage",
  library: "libraryPage"
};

function openPage(name) {
  document.body.dataset.page = name;

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  $(pageIds[name]).classList.add("active");

  document.querySelectorAll(".nav-item").forEach(b => {
    b.classList.toggle("active", b.dataset.target === name);
  });

  window.scrollTo({ top: 0, behavior: "smooth" });

  if (name === "search") renderSearch();
  if (name === "library") renderLibrary();
}

document.querySelectorAll(".nav-item").forEach(b => {
  b.addEventListener("click", () => openPage(b.dataset.target));
});

/* ==========================================================
   Snackbar, bottom sheet e diálogos (Material 3)
   ========================================================== */
let toastTimer = null;

function showToast(message) {
  let bar = $("snackbar");

  if (!bar) {
    bar = el("div", "snackbar");
    bar.id = "snackbar";
    document.body.appendChild(bar);
  }

  bar.textContent = message;
  void bar.offsetWidth;
  bar.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => bar.classList.remove("show"), 2600);
}

let activeSheet = null;

function closeSheet() {
  if (!activeSheet) return;
  const { scrim, sheet } = activeSheet;
  activeSheet = null;

  scrim.classList.remove("show");
  sheet.classList.remove("show");
  setTimeout(() => {
    scrim.remove();
    sheet.remove();
  }, 260);
}

function openSheet(title, actions) {
  closeSheet();

  const scrim = el("div", "scrim");
  const sheet = el("div", "sheet");
  sheet.appendChild(el("div", "sheet-handle"));
  if (title) sheet.appendChild(el("h3", "", title));

  actions.forEach(a => {
    const btn = el("button", "sheet-item" + (a.danger ? " danger" : ""));
    btn.appendChild(el("span", "material-symbols-rounded", a.icon));
    btn.appendChild(el("span", "", a.label));
    btn.onclick = () => {
      closeSheet();
      a.run();
    };
    sheet.appendChild(btn);
  });

  scrim.onclick = closeSheet;
  document.body.append(scrim, sheet);
  activeSheet = { scrim, sheet };

  requestAnimationFrame(() => {
    scrim.classList.add("show");
    sheet.classList.add("show");
  });
}

function showDialog({ title, text, input, confirmLabel = "OK", danger = false }) {
  return new Promise(resolve => {
    const scrim = el("div", "scrim");
    const dlg = el("div", "dialog");
    dlg.appendChild(el("h3", "", title));
    if (text) dlg.appendChild(el("p", "", text));

    let field = null;
    if (input) {
      field = el("input", "dialog-input");
      field.type = "text";
      field.value = input.value || "";
      field.placeholder = input.placeholder || "";
      field.maxLength = 40;
      dlg.appendChild(field);
    }

    const actions = el("div", "dialog-actions");
    const cancel = el("button", "text-btn", "Cancelar");
    const ok = el("button", "text-btn" + (danger ? " danger" : ""), confirmLabel);
    actions.append(cancel, ok);
    dlg.appendChild(actions);

    const done = value => {
      scrim.classList.remove("show");
      dlg.classList.remove("show");
      setTimeout(() => {
        scrim.remove();
        dlg.remove();
      }, 260);
      resolve(value);
    };

    cancel.onclick = () => done(null);
    scrim.onclick = () => done(null);
    ok.onclick = () => done(field ? field.value.trim() : true);

    if (field) {
      field.addEventListener("keydown", e => {
        if (e.key === "Enter") ok.click();
      });
    }

    document.body.append(scrim, dlg);

    requestAnimationFrame(() => {
      scrim.classList.add("show");
      dlg.classList.add("show");
      if (field) field.focus();
    });
  });
}

/* ==========================================================
   Adicionar músicas
   ========================================================== */
function openFilePicker() {
  fileInput.click();
}

$("addBtn").onclick = openFilePicker;
$("libraryAdd").onclick = openFilePicker;

const audioExt = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|weba)$/i;

function addFile(file) {
  const duplicate = songs.some(
    s => s.file && s.file.name === file.name && s.file.size === file.size
  );
  if (duplicate) return false;

  const song = {
    id: Date.now() + Math.random(),
    name: file.name.replace(/\.[^/.]+$/, ""),
    artist: "Arquivo local",
    favorite: false,
    file: file,
    url: URL.createObjectURL(file),
    coverBlob: null,
    cover: null,
    playCount: 0,
    lastPlayed: 0,
    lyrics: "",
    seed: null
  };

  songs.push(song);
  dbPut(toRecord(song));

  if (window.jsmediatags) {
    window.jsmediatags.read(file, {
      onSuccess: result => {
        const tags = result.tags || {};

        if (tags.title) song.name = tags.title;
        if (tags.artist) song.artist = tags.artist;

        if (tags.picture) {
          const picture = tags.picture;
          const bytes = new Uint8Array(picture.data);
          const blob = new Blob([bytes], { type: picture.format || "image/jpeg" });
          song.coverBlob = blob;
          song.cover = URL.createObjectURL(blob);
        }

        dbPut(toRecord(song));
        refreshAll();
      },
      onError: () => refreshAll()
    });
  }

  return true;
}

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []).filter(
    f => f.type.startsWith("audio/") || audioExt.test(f.name)
  );

  let added = 0;
  files.forEach(f => {
    if (addFile(f)) added++;
  });

  fileInput.value = "";
  refreshAll();

  if (files.length > 0 && added === 0) showToast("Essas músicas já estão na biblioteca");
  else if (added > 0) showToast(added + (added === 1 ? " música adicionada" : " músicas adicionadas"));
});

/* ==========================================================
   Playlists e menus
   ========================================================== */
async function createPlaylist(firstSongId) {
  const name = await showDialog({
    title: "Nova playlist",
    input: { placeholder: "Nome da playlist" },
    confirmLabel: "Criar"
  });

  if (!name) return null;

  const playlist = {
    id: "p" + Date.now(),
    name: name,
    songIds: firstSongId !== undefined ? [firstSongId] : []
  };

  playlists.push(playlist);
  savePlaylists();
  renderLibrary();
  showToast("Playlist \"" + name + "\" criada");
  return playlist;
}

function toggleInPlaylist(playlist, song) {
  const i = playlist.songIds.indexOf(song.id);

  if (i >= 0) {
    playlist.songIds.splice(i, 1);
    showToast("Removida de \"" + playlist.name + "\"");
  } else {
    playlist.songIds.push(song.id);
    showToast("Adicionada a \"" + playlist.name + "\"");
  }

  savePlaylists();
  renderLibrary();
}

function addToPlaylistSheet(song) {
  const actions = playlists.map(p => ({
    icon: p.songIds.includes(song.id) ? "check_circle" : "playlist_add",
    label: p.name,
    run: () => toggleInPlaylist(p, song)
  }));

  actions.push({
    icon: "add",
    label: "Nova playlist",
    run: () => createPlaylist(song.id)
  });

  openSheet("Adicionar à playlist", actions);
}

function pickLrcFor(songId) {
  lrcTargetId = songId;
  lrcInput.click();
}

async function deleteSong(song) {
  const ok = await showDialog({
    title: "Excluir música?",
    text: "\"" + song.name + "\" será removida da sua biblioteca.",
    confirmLabel: "Excluir",
    danger: true
  });

  if (!ok) return;

  if (song.id === currentId) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentId = null;
    closeFullPlayer();
  }

  URL.revokeObjectURL(song.url);
  if (song.cover) URL.revokeObjectURL(song.cover);

  songs.splice(songs.indexOf(song), 1);
  playlists.forEach(p => {
    p.songIds = p.songIds.filter(id => id !== song.id);
  });
  savePlaylists();

  queue = queue.filter(id => id !== song.id);
  history = history.filter(id => id !== song.id);
  dbDelete(song.id);

  refreshAll();
  showToast("Música excluída");
}

function openSongMenu(song, opts = {}) {
  const actions = [
    {
      icon: "playlist_add",
      label: "Adicionar à playlist",
      run: () => addToPlaylistSheet(song)
    }
  ];

  if (opts.playlistId) {
    const p = playlists.find(x => x.id === opts.playlistId);
    if (p) {
      actions.push({
        icon: "playlist_remove",
        label: "Remover desta playlist",
        run: () => toggleInPlaylist(p, song)
      });
    }
  }

  actions.push({
    icon: "lyrics",
    label: song.lyrics ? "Trocar letra (.lrc)" : "Importar letra (.lrc)",
    run: () => pickLrcFor(song.id)
  });

  if (song.lyrics) {
    actions.push({
      icon: "speaker_notes_off",
      label: "Remover letra",
      run: () => {
        song.lyrics = "";
        dbPut(toRecord(song));
        if (song.id === currentId) renderLyrics(song);
        showToast("Letra removida");
      }
    });
  }

  actions.push({
    icon: "delete",
    label: "Excluir música",
    danger: true,
    run: () => deleteSong(song)
  });

  openSheet(song.name, actions);
}

/* ==========================================================
   Listas (Library e Search)
   ========================================================== */
function toggleFavorite(song) {
  song.favorite = !song.favorite;
  dbPut(toRecord(song));
  renderAll();
  if (song.id === currentId) updateFullPlayer();
}

function createSongItem(song, context, opts = {}) {
  const isCurrent = song.id === currentId;
  const item = el("div", "song-item" + (isCurrent ? " playing" : ""));

  const cover = el("div", "song-cover");
  setCover(cover, song.cover);

  if (isCurrent) {
    const eq = el("div", "eq" + (audio.paused ? " paused" : ""));
    eq.innerHTML = "<i></i><i></i><i></i>";
    cover.appendChild(eq);
  }

  const info = el("div", "song-info");
  info.append(el("strong", "", song.name), el("small", "", song.artist));

  const fav = el("button", "icon-btn fav" + (song.favorite ? " active" : ""));
  fav.setAttribute("aria-label", "Favoritar");
  setIcon(fav, song.favorite ? "favorite" : "favorite_border");
  fav.onclick = e => {
    e.stopPropagation();
    toggleFavorite(song);
  };

  const more = el("button", "icon-btn");
  more.setAttribute("aria-label", "Mais opções");
  setIcon(more, "more_vert");
  more.onclick = e => {
    e.stopPropagation();
    openSongMenu(song, opts);
  };

  item.onclick = () => {
    if (song.id === currentId) togglePlay();
    else playSong(song.id, context);
  };

  attachRipple(item);

  item.append(cover, info, fav, more);
  return item;
}

function showEmpty(container, title, message, showButton) {
  container.innerHTML = "";

  const empty = el("div", "empty-state");
  empty.appendChild(el("span", "material-symbols-rounded", "library_music"));
  empty.appendChild(el("h3", "", title));
  empty.appendChild(el("p", "", message));

  if (showButton) {
    const button = el("button", "", "Adicionar músicas");
    button.onclick = openFilePicker;
    empty.appendChild(button);
  }

  container.appendChild(empty);
}

function renderSearch() {
  const container = $("searchSongList");
  container.innerHTML = "";

  const query = $("searchInput").value.trim().toLowerCase();

  const results = songs.filter(
    s =>
      s.name.toLowerCase().includes(query) ||
      s.artist.toLowerCase().includes(query)
  );

  if (results.length === 0) {
    showEmpty(
      container,
      songs.length === 0 ? "Nenhuma música adicionada" : "Nenhum resultado encontrado",
      songs.length === 0
        ? "Adicione músicas para pesquisar sua coleção."
        : "Experimente pesquisar por outro nome.",
      songs.length === 0
    );
    return;
  }

  const ids = results.map(s => s.id);
  results.forEach(song => container.appendChild(createSongItem(song, ids)));
}

function librarySongs() {
  if (libraryFilter === "all") return songs.slice();
  if (libraryFilter === "fav") return songs.filter(s => s.favorite);

  const p = playlists.find(x => x.id === libraryFilter);
  if (!p) {
    libraryFilter = "all";
    return songs.slice();
  }

  return p.songIds.map(getSong).filter(Boolean);
}

function renderFilters() {
  const box = $("filters");
  box.innerHTML = "";

  const addChip = (label, value, extra) => {
    const active = libraryFilter === value;
    const chip = el("button", "filter" + (active ? " active" : "") + (extra ? " " + extra : ""));
    if (active) chip.appendChild(el("span", "material-symbols-rounded", "check"));
    chip.appendChild(document.createTextNode(label));
    chip.onclick = () => {
      libraryFilter = value;
      renderLibrary();
    };
    box.appendChild(chip);
  };

  addChip("Todas", "all");
  addChip("Favoritas", "fav");
  playlists.forEach(p => addChip(p.name, p.id));

  const add = el("button", "filter new");
  add.appendChild(el("span", "material-symbols-rounded", "add"));
  add.appendChild(document.createTextNode("Playlist"));
  add.onclick = async () => {
    const p = await createPlaylist();
    if (p) {
      libraryFilter = p.id;
      renderLibrary();
    }
  };
  box.appendChild(add);
}

function renderPlaylistBar(playlist, list) {
  const bar = $("playlistBar");

  if (!playlist) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  bar.innerHTML = "";

  const info = el("div", "pl-info");
  info.append(
    el("strong", "", playlist.name),
    el("span", "", list.length + (list.length === 1 ? " música" : " músicas"))
  );

  const play = el("button", "tonal-btn");
  play.appendChild(el("span", "material-symbols-rounded", "play_arrow"));
  play.appendChild(document.createTextNode("Tocar"));
  play.onclick = () => {
    if (list.length === 0) {
      showToast("A playlist está vazia");
      return;
    }
    const ids = list.map(s => s.id);
    const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
    playSong(first, ids);
  };

  const rename = el("button", "icon-btn");
  rename.setAttribute("aria-label", "Renomear playlist");
  setIcon(rename, "edit");
  rename.onclick = async () => {
    const name = await showDialog({
      title: "Renomear playlist",
      input: { value: playlist.name, placeholder: "Nome da playlist" },
      confirmLabel: "Salvar"
    });
    if (name) {
      playlist.name = name;
      savePlaylists();
      renderLibrary();
    }
  };

  const del = el("button", "icon-btn");
  del.setAttribute("aria-label", "Excluir playlist");
  setIcon(del, "delete");
  del.onclick = async () => {
    const ok = await showDialog({
      title: "Excluir playlist?",
      text: "As músicas continuam na biblioteca.",
      confirmLabel: "Excluir",
      danger: true
    });
    if (ok) {
      playlists = playlists.filter(p => p !== playlist);
      savePlaylists();
      libraryFilter = "all";
      renderLibrary();
      showToast("Playlist excluída");
    }
  };

  bar.append(info, play, rename, del);
}

function renderLibrary() {
  const container = $("songList");
  container.innerHTML = "";

  $("libraryCount").textContent =
    songs.length + (songs.length === 1 ? " música adicionada" : " músicas adicionadas");

  const list = librarySongs();
  const playlist = playlists.find(p => p.id === libraryFilter) || null;

  renderFilters();
  renderPlaylistBar(playlist, list);

  if (list.length === 0) {
    if (playlist) {
      showEmpty(
        container,
        "Playlist vazia",
        "Use o menu ⋮ de uma música para adicioná-la aqui.",
        false
      );
    } else if (libraryFilter === "fav") {
      showEmpty(
        container,
        "Nenhuma favorita",
        "Marque músicas com o coração para encontrá-las aqui.",
        false
      );
    } else {
      showEmpty(
        container,
        "Sua biblioteca está vazia",
        "As músicas que você adicionar aparecerão aqui.",
        false
      );
    }
    return;
  }

  const ids = list.map(s => s.id);
  const opts = playlist ? { playlistId: playlist.id } : {};
  list.forEach(song => container.appendChild(createSongItem(song, ids, opts)));
}

function renderAll() {
  renderSearch();
  renderLibrary();
}

/* ==========================================================
   Your Mix
   ========================================================== */
const homeTargets = { artMain: null, artSmall1: null, artSmall2: null };

function rankedForHome() {
  const arr = songs.slice();

  if (mixMode === "plays") {
    arr.sort(
      (a, b) =>
        b.playCount - a.playCount ||
        b.lastPlayed - a.lastPlayed ||
        a.id - b.id
    );
  } else {
    arr.sort((a, b) => b.lastPlayed - a.lastPlayed || a.id - b.id);
  }

  return arr;
}

function renderMixMode() {
  document.querySelectorAll("#mixMode button").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mixMode);
  });
}

document.querySelectorAll("#mixMode button").forEach(b => {
  b.addEventListener("click", () => {
    mixMode = b.dataset.mode;
    lsSet("mixMode", mixMode);
    renderMixMode();
    updateHome();
  });
});

function updateHome() {
  const ranked = rankedForHome();
  const main = current() || ranked[0] || null;
  const others = ranked.filter(s => s !== main);
  const pick = i => others[i] || main;

  homeMain = main;
  homeTargets.artMain = main ? main.id : null;
  homeTargets.artSmall1 = pick(0) ? pick(0).id : null;
  homeTargets.artSmall2 = pick(1) ? pick(1).id : null;

  setCover($("artMain"), main ? main.cover : null);
  setCover($("artSmall1"), pick(0) ? pick(0).cover : null);
  setCover($("artSmall2"), pick(1) ? pick(1).cover : null);

  $("heroSubtitle").textContent = main ? main.name : "Sua coleção musical";

  updateMiniPlayer();
}

["artMain", "artSmall1", "artSmall2"].forEach(id => {
  $(id).addEventListener("click", () => {
    const songId = homeTargets[id];

    if (songId === null || !getSong(songId)) {
      openFilePicker();
      return;
    }

    if (songId === currentId) togglePlay();
    else playSong(songId, allIds());
  });
});

/* ==========================================================
   Mini player
   ========================================================== */
// Ondinha de toque estilo Material
function attachRipple(node) {
  node.classList.add("ripple-host");

  node.addEventListener("pointerdown", e => {
    const r = node.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const dot = el("span", "ripple");
    dot.style.width = dot.style.height = size + "px";
    dot.style.left = e.clientX - r.left - size / 2 + "px";
    dot.style.top = e.clientY - r.top - size / 2 + "px";
    node.appendChild(dot);
    dot.addEventListener("animationend", () => dot.remove());
  });
}

let lastMiniId = null;

function updateMiniPlayer() {
  const box = $("nowPlaying");

  if (songs.length === 0) {
    box.hidden = true;
    lastMiniId = null;
    return;
  }

  box.hidden = false;
  const song = current() || homeMain;
  if (!song) return;

  $("nowTitle").textContent = song.name;
  $("nowArtist").textContent = song.artist;
  setCover($("nowCover"), song.cover);

  // animação da capa só quando a música muda
  if (lastMiniId !== null && lastMiniId !== song.id) {
    const cover = $("nowCover");
    cover.classList.remove("pop");
    void cover.offsetWidth;
    cover.classList.add("pop");
  }
  lastMiniId = song.id;
}

attachRipple($("nowPlaying"));

$("nowPlaying").addEventListener("click", e => {
  if (e.target.closest("#nowPlay")) return;

  if (!current() && homeMain) playSong(homeMain.id, allIds());
  openFullPlayer();
});

$("nowPlay").addEventListener("click", e => {
  e.stopPropagation();
  togglePlay();
});

$("heroPlay").addEventListener("click", () => {
  if (!current() && homeMain) playSong(homeMain.id, allIds());
  else togglePlay();
});

function updatePlayButtons() {
  const playing = !audio.paused && currentId !== null;
  const icon = playing ? "pause" : "play_arrow";

  setIcon($("heroPlay"), icon);
  setIcon($("nowPlay"), icon);
  setIcon($("fpPlay"), icon);

  $("heroPlay").classList.toggle("playing", playing);
  $("fpPlay").classList.toggle("playing", playing);
}

/* ==========================================================
   Reprodução
   ========================================================== */
function playSong(id, context, back) {
  const song = getSong(id);
  if (!song) return;

  if (context) queue = context.slice();
  else if (!queue.includes(id)) queue = allIds();

  if (!back && currentId !== null && currentId !== id) {
    history.push(currentId);
    if (history.length > 50) history.shift();
  }

  currentId = id;
  song.playCount += 1;
  song.lastPlayed = Date.now();
  dbPut(toRecord(song));

  audio.src = song.url;
  const result = audio.play();
  if (result && result.catch) result.catch(() => {});

  onSongChanged();
}

function onSongChanged() {
  lrcActive = -1;
  updateHome();
  updatePlayButtons();
  updateMediaSession();
  updateFullPlayer();
  renderLyrics(current());
  renderAll();
  updateColor();
  updateProgress();
}

function refreshAll() {
  updateHome();
  renderAll();
  updatePlayButtons();
  if (current()) updateFullPlayer();
  updateColor();
}

function togglePlay() {
  if (currentId === null) {
    const first = homeMain || songs[0];
    if (first) playSong(first.id, allIds());
    return;
  }

  if (audio.paused) {
    const result = audio.play();
    if (result && result.catch) result.catch(() => {});
  } else {
    audio.pause();
  }
}

function pickNext(auto) {
  if (queue.length === 0) return null;
  if (repeat === "one" && auto) return currentId;

  const idx = queue.indexOf(currentId);

  if (shuffle) {
    if (queue.length === 1) return queue[0];
    let n;
    do {
      n = queue[Math.floor(Math.random() * queue.length)];
    } while (n === currentId);
    return n;
  }

  if (idx === -1) return queue[0];
  if (idx < queue.length - 1) return queue[idx + 1];
  return repeat === "all" || !auto ? queue[0] : null;
}

function playNext() {
  const next = pickNext(false);
  if (next !== null) playSong(next);
}

function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  while (history.length) {
    const id = history.pop();
    if (getSong(id)) {
      playSong(id, null, true);
      return;
    }
  }

  const idx = queue.indexOf(currentId);
  if (idx > 0) playSong(queue[idx - 1], null, true);
  else if (queue.length > 1 && repeat === "all") playSong(queue[queue.length - 1], null, true);
  else audio.currentTime = 0;
}

audio.addEventListener("play", () => {
  updatePlayButtons();
  renderAll();
  updateMediaState();
});

audio.addEventListener("pause", () => {
  updatePlayButtons();
  renderAll();
  updateMediaState();
});

audio.addEventListener("ended", () => {
  const next = pickNext(true);

  if (next === null) {
    audio.pause();
    return;
  }

  if (next === currentId) {
    audio.currentTime = 0;
    const result = audio.play();
    if (result && result.catch) result.catch(() => {});
  } else {
    playSong(next);
  }
});

audio.addEventListener("loadedmetadata", () => {
  updateProgress();
  updatePositionState();
});
audio.addEventListener("durationchange", updateProgress);
audio.addEventListener("timeupdate", updateProgress);

/* ---------- Media Session (notificação / tela de bloqueio) ---------- */
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const song = current();
  if (!song) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: song.artist,
      album: "Sua Música, Seu Universo",
      artwork: song.cover
        ? [{
            src: song.cover,
            sizes: "512x512",
            type: (song.coverBlob && song.coverBlob.type) || "image/jpeg"
          }]
        : []
    });
  } catch {}
}

function updateMediaState() {
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
    } catch {}
  }
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch {}
}

function initMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;

  const handlers = {
    play: () => togglePlay(),
    pause: () => audio.pause(),
    previoustrack: playPrev,
    nexttrack: playNext,
    seekto: d => {
      if (d && typeof d.seekTime === "number") audio.currentTime = d.seekTime;
    }
  };

  Object.keys(handlers).forEach(name => {
    try {
      navigator.mediaSession.setActionHandler(name, handlers[name]);
    } catch {}
  });
}

/* ==========================================================
   Progresso
   ========================================================== */
function updateProgress() {
  const d = audio.duration;
  const t = audio.currentTime || 0;
  const pct = d && isFinite(d) ? (t / d) * 100 : 0;

  $("miniProgress").style.width = pct + "%";

  if (!seeking) {
    const seek = $("seek");
    seek.value = pct * 10;
    seek.style.setProperty("--pct", pct + "%");
    $("curTime").textContent = fmt(t);
  }

  $("durTime").textContent = fmt(d);
  syncLyrics(t);
}

$("seek").addEventListener("input", () => {
  seeking = true;
  const seek = $("seek");
  const d = audio.duration || 0;
  seek.style.setProperty("--pct", seek.value / 10 + "%");
  $("curTime").textContent = fmt((seek.value / 1000) * d);
});

$("seek").addEventListener("change", () => {
  const seek = $("seek");
  if (audio.duration && isFinite(audio.duration)) {
    audio.currentTime = (seek.value / 1000) * audio.duration;
  }
  seeking = false;
  updatePositionState();
});

/* ==========================================================
   Player completo
   ========================================================== */
function updateFullPlayer() {
  const song = current();
  if (!song) return;

  $("fpTitle").textContent = song.name || "Sem título";
  $("fpArtist").textContent = song.artist || "Artista desconhecido";
  setCover($("fpCover"), song.cover);

  setIcon($("fpFav"), song.favorite ? "favorite" : "favorite_border");
  $("fpFav").classList.toggle("active", song.favorite);

  $("fpShuffle").classList.toggle("on", shuffle);

  const rep = $("fpRepeat");
  rep.classList.toggle("on", repeat !== "off");
  setIcon(rep, repeat === "one" ? "repeat_one" : "repeat");

  $("fpLyricsBtn").classList.toggle("on", lyricsView);
}

function openFullPlayer() {
  if (!current()) return;

  updateFullPlayer();
  $("fullPlayer").classList.add("open");
  $("fullPlayer").setAttribute("aria-hidden", "false");
  document.body.classList.add("no-scroll");

  if (!fpOpen) {
    try {
      history.pushState({ fp: 1 }, "");
    } catch {}
  }

  fpOpen = true;
  if (lyricsView) requestAnimationFrame(scrollLyricsToActive);
}

function closeFullPlayer(fromPop) {
  if (!fpOpen) return;
  fpOpen = false;

  $("fullPlayer").classList.remove("open");
  $("fullPlayer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("no-scroll");

  if (!fromPop) {
    try {
      if (history.state && history.state.fp) history.back();
    } catch {}
  }
}

window.addEventListener("popstate", () => {
  if (fpOpen) closeFullPlayer(true);
});

$("fpClose").onclick = () => closeFullPlayer();
$("fpPlay").onclick = togglePlay;
$("fpPrev").onclick = playPrev;
$("fpNext").onclick = playNext;

$("fpFav").onclick = () => {
  const song = current();
  if (song) toggleFavorite(song);
};

$("fpShuffle").onclick = () => {
  shuffle = !shuffle;
  updateFullPlayer();
  showToast(shuffle ? "Aleatório ligado" : "Aleatório desligado");
};

$("fpRepeat").onclick = () => {
  repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
  updateFullPlayer();
  showToast(
    repeat === "off"
      ? "Repetir desligado"
      : repeat === "all"
      ? "Repetindo a lista"
      : "Repetindo esta música"
  );
};

$("fpMenu").onclick = () => {
  const song = current();
  if (song) openSongMenu(song);
};

$("fpLyricsBtn").onclick = () => {
  lyricsView = !lyricsView;
  $("fpStage").classList.toggle("lyrics-on", lyricsView);
  updateFullPlayer();
  if (lyricsView) requestAnimationFrame(scrollLyricsToActive);
};

/* ==========================================================
   Letras (.lrc)
   ========================================================== */
let lrcLines = [];
let lrcSynced = false;
let lrcActive = -1;

function parseLrc(text) {
  const lines = [];
  let synced = false;

  text.split(/\r?\n/).forEach(raw => {
    const stamps = Array.from(
      raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)
    );

    const content = raw
      .replace(/\[[^\]]*\]/g, "")
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
      .trim();

    if (stamps.length === 0) {
      if (content) lines.push({ t: null, text: content });
      return;
    }

    synced = true;
    stamps.forEach(m => {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lines.push({
        t: Number(m[1]) * 60 + Number(m[2]) + frac,
        text: content || "♪"
      });
    });
  });

  if (synced) {
    return {
      synced: true,
      lines: lines.filter(l => l.t !== null).sort((a, b) => a.t - b.t)
    };
  }

  return { synced: false, lines };
}

function renderLyrics(song) {
  const box = $("fpLyrics");
  box.innerHTML = "";
  lrcLines = [];
  lrcSynced = false;
  lrcActive = -1;

  if (!song || !song.lyrics) {
    const empty = el("div", "lrc-empty");
    empty.appendChild(el("span", "material-symbols-rounded", "lyrics"));
    empty.appendChild(el("p", "", "Esta música ainda não tem letra."));

    const btn = el("button", "tonal-btn");
    btn.appendChild(el("span", "material-symbols-rounded", "upload_file"));
    btn.appendChild(document.createTextNode("Importar .lrc"));
    btn.onclick = () => {
      if (song) pickLrcFor(song.id);
    };

    empty.appendChild(btn);
    box.appendChild(empty);
    return;
  }

  const parsed = parseLrc(song.lyrics);
  lrcLines = parsed.lines;
  lrcSynced = parsed.synced;

  lrcLines.forEach(line => {
    const p = el("p", "lrc-line" + (lrcSynced ? "" : " plain"), line.text);

    if (lrcSynced) {
      p.onclick = () => {
        audio.currentTime = line.t;
      };
    }

    box.appendChild(p);
  });

  syncLyrics(audio.currentTime || 0);
}

function scrollLyricsToActive() {
  const box = $("fpLyrics");
  const node = box.children[lrcActive];
  if (!node || !lrcSynced) return;

  box.scrollTo({
    top: node.offsetTop - box.clientHeight / 2 + node.offsetHeight / 2,
    behavior: "smooth"
  });
}

function syncLyrics(t) {
  if (!lrcSynced || lrcLines.length === 0) return;

  const target = t + 0.25;
  let lo = 0;
  let hi = lrcLines.length - 1;
  let idx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lrcLines[mid].t <= target) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (idx === lrcActive) return;

  const nodes = $("fpLyrics").children;
  if (nodes[lrcActive]) nodes[lrcActive].classList.remove("active");
  lrcActive = idx;

  if (idx >= 0 && nodes[idx]) {
    nodes[idx].classList.add("active");
    if (lyricsView && fpOpen) scrollLyricsToActive();
  }
}

lrcInput.addEventListener("change", async () => {
  const file = lrcInput.files && lrcInput.files[0];
  lrcInput.value = "";
  if (!file) return;

  const song = getSong(lrcTargetId !== null ? lrcTargetId : currentId);
  if (!song) {
    showToast("Escolha uma música primeiro");
    return;
  }

  try {
    song.lyrics = await file.text();
  } catch {
    showToast("Não consegui ler esse arquivo");
    return;
  }

  dbPut(toRecord(song));
  if (song.id === currentId) renderLyrics(song);
  showToast("Letra adicionada");
});

/* ==========================================================
   Pesquisa
   ========================================================== */
$("searchInput").addEventListener("input", renderSearch);

/* ==========================================================
   Inicialização
   ========================================================== */
async function loadSongs() {
  const records = await dbGetAll();
  records.sort((a, b) => a.id - b.id);

  records.forEach(r => {
    if (r && r.file) songs.push(makeSong(r));
  });

  const valid = new Set(allIds());
  let changed = false;
  playlists.forEach(p => {
    const kept = p.songIds.filter(id => valid.has(id));
    if (kept.length !== p.songIds.length) {
      p.songIds = kept;
      changed = true;
    }
  });
  if (changed) savePlaylists();
}

applyTheme();
renderMixMode();
renderAll();
updateHome();
updatePlayButtons();
renderLyrics(null);
initMediaSessionHandlers();

loadSongs().then(() => {
  refreshAll();
});

     // Impedir menu de seleção ao pressionar textos
document.addEventListener("contextmenu", function (event) {
  if (event.target.closest("input, textarea, [contenteditable='true']")) {
    return;
  }

  event.preventDefault();
}, true);

// Impedir seleção de textos
document.addEventListener("selectstart", function (event) {
  if (event.target.closest("input, textarea, [contenteditable='true']")) {
    return;
  }

  event.preventDefault();
}, true);
  