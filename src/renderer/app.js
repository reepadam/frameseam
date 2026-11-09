'use strict';
/* FrameSeam editor UI: media library, preview player, single-track magnetic timeline, export dialog. */

const $ = s => document.querySelector(s);
// `api` is the global the preload script exposes (see preload.js).

// ---------------------------------------------------------------- icons
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  skipStart: '<path d="M6 5v14"/><path d="M18 5 9 12l9 7z" fill="currentColor"/>',
  skipEnd: '<path d="M18 5v14"/><path d="M6 5l9 7-9 7z" fill="currentColor"/>',
  back5: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/><text x="12.4" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Segoe UI">5</text>',
  fwd5: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/><text x="11.6" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Segoe UI">5</text>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  duplicate: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4M8 12h8"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.7"/><circle cx="12" cy="16.8" r=".7" fill="currentColor"/>',
};
const icon = name =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

// ---------------------------------------------------------------- state
const state = {
  media: [],      // { id, path, name, info, fileUrl, poster, thumbs[], thumbStep, previewError }
  clips: [],      // { id, mediaId, in, out }  (source seconds; frame-aligned)
  selected: null, // clip id
  playhead: 0,    // timeline seconds
  zoom: 60,       // px per second
  playing: false,
};
let nextId = 1;
const uid = () => nextId++;
const undoStack = [];
const redoStack = [];
const PAD = 16;
const TRACK_H = 56;

const mediaById = id => state.media.find(m => m.id === id);
const fpsOf = m => (m && m.info.fps) || 30;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function layout() {
  let t = 0;
  return state.clips.map((clip, index) => {
    const media = mediaById(clip.mediaId);
    const d = clip.out - clip.in;
    const r = { clip, media, index, start: t, end: t + d };
    t += d;
    return r;
  });
}
const totalDuration = () => state.clips.reduce((s, c) => s + (c.out - c.in), 0);
function clipAt(t, L = layout()) {
  for (const r of L) if (t < r.end - 1e-9) return r;
  return null;
}

// ---------------------------------------------------------------- formatting
const pad2 = n => String(n).padStart(2, '0');
function fmtTime(t) {
  t = Math.max(0, t);
  const cs = Math.floor(t * 100 + 1e-6);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return (h ? `${h}:${pad2(m)}` : pad2(m)) + `:${pad2(s)}.${pad2(c)}`;
}
function fmtShort(t) {
  const s = Math.round(t);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(ss)}` : `${m}:${pad2(ss)}`;
}
const fmtFps = f => (Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : f.toFixed(2));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = p => p.split(/[\\/]/).pop();
const dirname = p => p.replace(/[\\/][^\\/]*$/, '');
const cleanErr = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- history
const snapshot = () => JSON.stringify({ clips: state.clips, selected: state.selected });
function commit() {
  undoStack.push(snapshot());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const o = JSON.parse(s);
  state.clips = o.clips.filter(c => mediaById(c.mediaId)); // media removed since the snapshot can't come back
  state.selected = state.clips.some(c => c.id === o.selected) ? o.selected : null;
  afterEdit();
}
function undo() {
  if (!undoStack.length) return;
  pause();
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  pause();
  undoStack.push(snapshot());
  restore(redoStack.pop());
}
function afterEdit() {
  state.playhead = clamp(state.playhead, 0, totalDuration());
  api.setDirty(state.clips.length > 0);
  renderAll();
  previewAt(state.playhead);
}

// ---------------------------------------------------------------- import & thumbnails
const VIDEO_RE = /\.(mp4|mov|mkv|m4v|avi|webm|mts|m2ts|ts|wmv|flv|3gp|mpg|mpeg)$/i;

async function importPaths(paths) {
  const added = [];
  for (const p of paths) {
    const existing = state.media.find(m => m.path.toLowerCase() === p.toLowerCase());
    if (existing) { added.push(existing); continue; }
    try {
      const info = await api.probe(p);
      const m = { id: uid(), path: p, name: basename(p), info, fileUrl: info.fileUrl, poster: null, thumbs: [], thumbStep: 1, previewError: false };
      state.media.push(m);
      added.push(m);
      queueThumbs(m);
    } catch (e) {
      toast(`Couldn't open ${basename(p)}: ${cleanErr(e)}`, 5000);
    }
  }
  renderMedia();
  return added;
}

async function importDialog() {
  const paths = await api.pickFiles();
  if (paths.length) await importPaths(paths);
}

function seekVideo(v, t) {
  return new Promise(res => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
    v.addEventListener('seeked', fin);
    setTimeout(fin, 4000);
    v.currentTime = t;
  });
}

const thumbQueue = [];
let thumbRunning = false;
const posterQueue = [];
function queueThumbs(m) {
  posterQueue.push(m);
  thumbQueue.push(m);
  if (!thumbRunning) runThumbs();
}
async function runPosters() {
  while (posterQueue.length) {
    const m = posterQueue.shift();
    if (!state.media.includes(m)) continue;
    try { await genThumbs(m, true); } catch (e) { console.warn('poster', e); }
  }
}
async function runThumbs() {
  thumbRunning = true;
  await runPosters();
  while (thumbQueue.length) {
    const m = thumbQueue.shift();
    if (!state.media.includes(m) || m.previewError) continue;
    try { await genThumbs(m, false); } catch (e) { console.warn('thumbs', e); }
  }
  thumbRunning = false;
}

// Thumbnails are generated in memory only (small JPEG data URLs). Nothing is written to disk.
// Posters for every file come first, then the timeline filmstrips.
async function genThumbs(m, posterOnly) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  const ok = await new Promise(res => {
    v.onloadeddata = () => res(true);
    v.onerror = () => res(false);
    v.src = m.fileUrl;
  });
  if (!ok || !v.videoWidth) {
    m.previewError = true;
    updateMediaCard(m);
    toast(`${m.name}: this video's format (${m.info.vcodec}) can't be previewed, but it can still be cut and exported.`, 6000);
    return;
  }
  const H = 90;
  const W = Math.max(16, Math.round((H * v.videoWidth) / v.videoHeight));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const dur = m.info.duration || v.duration || 1;
  const grab = async t => {
    await seekVideo(v, clamp(t, 0, Math.max(0, dur - 0.05)));
    ctx.drawImage(v, 0, 0, W, H);
    return cv.toDataURL('image/jpeg', 0.72);
  };
  if (posterOnly) {
    m.poster = await grab(Math.min(dur * 0.1, 2));
    updateMediaCard(m);
    scheduleTimelineRender();
  } else {
    const n = clamp(Math.ceil(dur / 0.5), 1, 150);
    m.thumbStep = dur / n;
    m.thumbs = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (!state.media.includes(m)) break;
      if (posterQueue.length) await runPosters(); // newly imported files get their poster right away
      m.thumbs[i] = await grab((i + 0.5) * m.thumbStep);
      if (i % 6 === 5 || i === n - 1) scheduleTimelineRender();
    }
  }
  v.removeAttribute('src');
  v.load();
}

function thumbFor(m, t) {
  if (!m.thumbs.length) return m.poster;
  let i = clamp(Math.floor(t / m.thumbStep), 0, m.thumbs.length - 1);
  while (i > 0 && !m.thumbs[i]) i--;
  return m.thumbs[i] || m.poster;
}

// ---------------------------------------------------------------- media panel
const grid = $('#mediaGrid');

function cardInner(m) {
  const used = state.clips.some(c => c.mediaId === m.id);
  const i = m.info;
  const spec = `${Math.min(i.displayWidth, i.displayHeight)}p${fmtFps(i.fps)}`;
  let overlay = '';
  if (m.previewError) overlay = '<div class="err">No preview<br>(export still works)</div>';
  else if (!m.poster) overlay = '<div class="loading">Loading…</div>';
  return `
    <div class="thumb" style="${m.poster ? `background-image:url(${m.poster})` : ''}">
      ${overlay}
      <span class="badge dur">${fmtShort(i.duration)}</span>
      <span class="badge spec" title="${i.displayWidth}×${i.displayHeight} at ${fmtFps(i.fps)} fps">${spec}</span>
      ${used ? `<span class="used-check">${icon('check')}</span>` : ''}
      <button class="card-btn card-add" title="Add to end of timeline">${icon('plus')}</button>
      <button class="card-btn card-remove" title="Remove from media">${icon('x')}</button>
    </div>
    <div class="name">${esc(m.name)}</div>`;
}

function renderMedia() {
  grid.innerHTML = state.media
    .map(m => `<div class="media-card" draggable="true" data-id="${m.id}" title="${esc(m.path)}">${cardInner(m)}</div>`)
    .join('');
  $('#mediaEmpty').hidden = state.media.length > 0;
}
function updateMediaCard(m) {
  const el = grid.querySelector(`.media-card[data-id="${m.id}"]`);
  if (el) el.innerHTML = cardInner(m);
}

grid.addEventListener('click', e => {
  const card = e.target.closest('.media-card');
  if (!card) return;
  const m = mediaById(+card.dataset.id);
  if (e.target.closest('.card-add')) addClips([m]);
  else if (e.target.closest('.card-remove')) removeMedia(m);
});
grid.addEventListener('dblclick', e => {
  const card = e.target.closest('.media-card');
  if (card && !e.target.closest('.card-btn')) addClips([mediaById(+card.dataset.id)]);
});
grid.addEventListener('dragstart', e => {
  const card = e.target.closest('.media-card');
  if (!card) return;
  e.dataTransfer.setData('application/x-frameseam-media', card.dataset.id);
  e.dataTransfer.effectAllowed = 'copy';
  const th = card.querySelector('.thumb');
  if (th) e.dataTransfer.setDragImage(th, th.offsetWidth / 2, th.offsetHeight / 2);
});

function removeMedia(m) {
  const used = state.clips.some(c => c.mediaId === m.id);
  if (used && !confirm(`"${m.name}" is used on the timeline. Remove it and its clips?`)) return;
  pause();
  state.media = state.media.filter(x => x !== m);
  if (used) state.clips = state.clips.filter(c => c.mediaId !== m.id);
  undoStack.length = 0; // older snapshots may point at the removed file
  redoStack.length = 0;
  for (const v of players) if (v.dataset.mid === String(m.id)) { v.removeAttribute('src'); v.dataset.mid = ''; v.load(); }
  renderMedia();
  afterEdit();
}

// ---------------------------------------------------------------- editing
function addClips(mediaList, index = state.clips.length) {
  mediaList = mediaList.filter(Boolean);
  if (!mediaList.length) return;
  pause();
  commit();
  const wasEmpty = state.clips.length === 0;
  const fresh = mediaList.map(m => ({ id: uid(), mediaId: m.id, in: 0, out: m.info.duration }));
  state.clips.splice(index, 0, ...fresh);
  state.selected = null;
  if (wasEmpty) state.playhead = 0;
  afterEdit();
  if (wasEmpty) zoomToFit();
  renderMedia();
}

function split() {
  const L = layout();
  let hit = clipAt(state.playhead, L);
  if (!hit) return toast('Move the playhead over a clip to split it');
  const fps = fpsOf(hit.media);
  // Cut at the start of the frame currently shown, so it becomes the first frame of the right-hand clip.
  const src = Math.floor((hit.clip.in + (state.playhead - hit.start)) * fps + 1e-4) / fps;
  if (src - hit.clip.in < 0.5 / fps || hit.clip.out - src < 0.5 / fps) {
    return toast('The playhead is at the edge of a clip. Move it inside the clip to split.');
  }
  pause();
  commit();
  const clip = state.clips[hit.index];
  const right = { id: uid(), mediaId: clip.mediaId, in: src, out: clip.out };
  clip.out = src;
  state.clips.splice(hit.index + 1, 0, right);
  state.selected = right.id;
  state.playhead = hit.start + (src - clip.in);
  afterEdit();
}

function deleteSelected() {
  const i = state.clips.findIndex(c => c.id === state.selected);
  if (i < 0) return toast('Click a clip on the timeline to select it first');
  pause();
  commit();
  const r = layout()[i];
  state.clips.splice(i, 1);
  if (state.playhead >= r.end) state.playhead -= r.end - r.start;
  else if (state.playhead > r.start) state.playhead = r.start;
  state.selected = null;
  afterEdit();
  renderMedia();
}

function duplicateSelected() {
  const i = state.clips.findIndex(c => c.id === state.selected);
  if (i < 0) return;
  pause();
  commit();
  const copy = { ...state.clips[i], id: uid() };
  state.clips.splice(i + 1, 0, copy);
  state.selected = copy.id;
  afterEdit();
}

function moveClip(id, toIndex) {
  const from = state.clips.findIndex(c => c.id === id);
  if (from < 0) return;
  const without = state.clips.filter(c => c.id !== id);
  if (toIndex === from) return;
  pause();
  commit();
  without.splice(toIndex, 0, state.clips[from]);
  state.clips = without;
  afterEdit();
}

// ---------------------------------------------------------------- preview / playback
const players = [$('#vA'), $('#vB')];
let active = 0;
let seekToken = 0;
const P = () => players[active];
const Q = () => players[1 - active];
const EPS = 0.0005;

function setSrc(v, m) {
  if (v.dataset.mid !== String(m.id)) {
    v.dataset.mid = String(m.id);
    v.src = m.fileUrl;
  }
}
function show(i) {
  active = i;
  players.forEach((p, j) => {
    p.classList.toggle('on', j === i);
    p.muted = j !== i;
  });
}

function srcTimeAt(t, L = layout()) {
  let hit = clipAt(t, L);
  if (!hit && L.length) {
    // At the very end, show the last frame of the last clip.
    hit = L[L.length - 1];
    return { hit, src: Math.max(hit.clip.in, hit.clip.out - 1 / fpsOf(hit.media)) };
  }
  if (!hit) return null;
  return { hit, src: hit.clip.in + (t - hit.start) };
}

// Show the source frame at `src` seconds of media `m` (paused).
async function previewSource(m, src) {
  const token = ++seekToken;
  $('#stageEmpty').hidden = true;
  if (P().dataset.mid === String(m.id)) {
    P().currentTime = src + EPS;
    show(active);
    return;
  }
  const q = Q();
  setSrc(q, m);
  q.pause();
  await seekVideo(q, src + EPS);
  if (token !== seekToken) return;
  show(1 - active);
}

function previewAt(t) {
  const r = srcTimeAt(t);
  if (!r) {
    players.forEach(p => p.classList.remove('on'));
    $('#stageEmpty').hidden = false;
    return;
  }
  previewSource(r.hit.media, r.src);
}

const pb = { idx: -1, preloaded: null };
const contiguous = (a, b) => a.mediaId === b.mediaId && Math.abs(b.in - a.out) < 1e-4;
let playGen = 0; // bumped on every play(); a play() that was paused and restarted while it waited for a seek gives up

async function play() {
  if (state.playing || !state.clips.length) return;
  const total = totalDuration();
  if (state.playhead >= total - 1e-3) state.playhead = 0;
  const L = layout();
  const hit = clipAt(state.playhead, L);
  if (!hit) return;
  pb.idx = hit.index;
  state.playing = true;
  const gen = ++playGen;
  updatePlayButton();
  ++seekToken;
  const src = hit.clip.in + (state.playhead - hit.start);
  if (P().dataset.mid !== String(hit.media.id)) {
    setSrc(Q(), hit.media);
    await seekVideo(Q(), src + EPS);
    if (!state.playing || gen !== playGen) return;
    show(1 - active);
  } else if (Math.abs(P().currentTime - src) > 0.02) {
    await seekVideo(P(), src + EPS);
  }
  if (!state.playing || gen !== playGen) return;
  show(active);
  P().play().catch(() => {});
  preloadNext(L);
  requestAnimationFrame(tick);
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  players.forEach(p => p.pause());
  updatePlayButton();
}
const togglePlay = () => (state.playing ? pause() : play());

function preloadNext(L) {
  const cur = L[pb.idx], next = L[pb.idx + 1];
  pb.preloaded = null;
  if (!cur || !next || contiguous(cur.clip, next.clip)) return;
  const q = Q();
  setSrc(q, next.media);
  q.pause();
  q.currentTime = next.clip.in + EPS;
  pb.preloaded = next.clip.id;
}

function tick() {
  if (!state.playing) return;
  const L = layout();
  let cur = L[pb.idx];
  if (!cur) { pause(); return; }
  const v = P();
  if (v.currentTime >= cur.clip.out - 0.004 || v.ended) {
    const next = L[pb.idx + 1];
    if (!next) {
      pause();
      state.playhead = totalDuration();
      updatePlayhead();
      previewAt(state.playhead);
      return;
    }
    if (!contiguous(cur.clip, next.clip)) {
      const q = Q();
      if (pb.preloaded !== next.clip.id) {
        setSrc(q, next.media);
        q.currentTime = next.clip.in + EPS;
      }
      v.pause();
      show(1 - active);
      P().play().catch(() => {});
    }
    pb.idx++;
    cur = next;
    preloadNext(L);
  }
  state.playhead = cur.start + clamp(P().currentTime - cur.clip.in, 0, cur.end - cur.start);
  updatePlayhead(true);
  requestAnimationFrame(tick);
}

function seek(t) {
  const wasPlaying = state.playing;
  pause();
  state.playhead = clamp(t, 0, totalDuration());
  updatePlayhead();
  previewAt(state.playhead);
  if (wasPlaying) play();
}

function stepFrame(dir) {
  pause();
  const L = layout();
  const r = srcTimeAt(state.playhead, L);
  if (!r) return;
  const fps = fpsOf(r.hit.media);
  const k = Math.floor(r.src * fps + 1e-4) + dir;
  let t = r.hit.start + (k / fps - r.hit.clip.in);
  if (t < r.hit.start - 1e-6 && r.hit.index > 0) {
    // Stepping back into the previous clip: land on its last frame.
    const prev = L[r.hit.index - 1];
    t = prev.end - 1 / fpsOf(prev.media);
  }
  seek(clamp(t, 0, Math.max(0, totalDuration() - 1e-4)));
}

function updatePlayButton() {
  $('#btnPlay').innerHTML = icon(state.playing ? 'pause' : 'play');
}

// ---------------------------------------------------------------- stage sizing
const stage = $('#stage');
function projectInfo() {
  const c = state.clips[0];
  return c ? mediaById(c.mediaId).info : null;
}
function layoutStage() {
  const wrap = $('#stageWrap').getBoundingClientRect();
  const info = projectInfo();
  const w = info ? info.displayWidth : 16, h = info ? info.displayHeight : 9;
  const s = Math.min(wrap.width / w, wrap.height / h);
  stage.style.width = Math.floor(w * s) + 'px';
  stage.style.height = Math.floor(h * s) + 'px';
  $('#formatChip').textContent = info ? `${info.displayWidth}×${info.displayHeight} · ${fmtFps(info.fps)} fps` : '16:9';
}
new ResizeObserver(() => { layoutStage(); renderTimeline(); }).observe($('#stageWrap'));

// ---------------------------------------------------------------- timeline rendering
const tlScroll = $('#tlScroll'), tlContent = $('#tlContent'), track = $('#track');
const ruler = $('#ruler'), playheadEl = $('#playhead'), marker = $('#insertMarker');
const clipEls = new Map();
const xOf = t => PAD + t * state.zoom;
const tOf = x => (x - PAD) / state.zoom;

let renderQueued = false;
function scheduleTimelineRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTimeline(); });
}

function renderTimeline() {
  const viewW = tlScroll.clientWidth;
  tlContent.style.width = Math.max(viewW, PAD * 2 + totalDuration() * state.zoom + 400) + 'px';
  const L = layout();
  const seen = new Set();
  const viewL = tlScroll.scrollLeft - 300, viewR = tlScroll.scrollLeft + viewW + 300;
  for (const r of L) {
    seen.add(r.clip.id);
    let el = clipEls.get(r.clip.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'clip';
      el.dataset.id = r.clip.id;
      el.innerHTML = '<div class="strip"></div><div class="clip-label"></div><div class="handle l"></div><div class="handle r"></div>';
      track.appendChild(el);
      clipEls.set(r.clip.id, el);
    }
    const left = xOf(r.start), w = Math.max(3, (r.end - r.start) * state.zoom);
    el.style.left = left + 'px';
    el.style.width = w + 'px';
    el.classList.toggle('selected', r.clip.id === state.selected);
    el.classList.toggle('narrow', w < 40);
    const label = el.children[1];
    const text = `${r.media.name} · ${fmtShort(r.end - r.start)}`;
    if (label.textContent !== text) label.textContent = text;
    renderStrip(el.firstChild, r, left, w, viewL, viewR);
  }
  for (const [id, el] of clipEls) if (!seen.has(id)) { el.remove(); clipEls.delete(id); }
  $('#trackEmpty').hidden = L.length > 0;
  drawRuler();
  updatePlayhead();
  updateButtons();
}

function renderStrip(strip, r, left, w, viewL, viewR) {
  const m = r.media;
  const tileW = Math.max(24, Math.round((TRACK_H * m.info.displayWidth) / m.info.displayHeight));
  const a = Math.max(0, viewL - left), b = Math.min(w, viewR - left);
  if (b <= a) {
    if (strip.dataset.key !== 'off') { strip.innerHTML = ''; strip.dataset.key = 'off'; }
    return;
  }
  const i0 = Math.floor(a / tileW), i1 = Math.ceil(b / tileW);
  const filled = m.thumbs.reduce((n, x) => n + (x ? 1 : 0), 0);
  const key = `${i0}|${i1}|${tileW}|${state.zoom}|${r.clip.in}|${filled}|${!!m.poster}`;
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  let html = '';
  for (let i = i0; i < i1; i++) {
    const th = thumbFor(m, r.clip.in + (i * tileW + tileW / 2) / state.zoom);
    html += `<div class="tile" style="left:${i * tileW}px;width:${tileW}px;${th ? `background-image:url(${th})` : ''}"></div>`;
  }
  strip.innerHTML = html;
}

const RULER_STEPS = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const RULER_SUB = { 15: 3, 30: 6, 60: 6, 120: 4, 900: 3, 1800: 6, 3600: 6, 7200: 4 };
function fmtRuler(t, step) {
  const r = Math.round(t * 1000) / 1000;
  const h = Math.floor(r / 3600), m = Math.floor(r / 60) % 60, s = r % 60;
  const sec = step < 1 ? s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0') : pad2(Math.floor(s));
  return h ? `${h}:${pad2(m)}:${sec}` : `${m}:${sec}`;
}
function drawRuler() {
  const dpr = window.devicePixelRatio || 1;
  const w = tlScroll.clientWidth, h = 30;
  if (ruler.width !== Math.round(w * dpr) || ruler.height !== h * dpr) {
    ruler.width = Math.round(w * dpr);
    ruler.height = h * dpr;
    ruler.style.width = w + 'px';
  }
  const ctx = ruler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const major = RULER_STEPS.find(s => s * state.zoom >= 72) || 7200;
  const sub = RULER_SUB[major] || 5;
  const minor = major / sub;
  const sl = tlScroll.scrollLeft;
  const n0 = Math.max(0, Math.floor(tOf(sl) / minor)), n1 = Math.ceil(tOf(sl + w) / minor);
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  for (let n = n0; n <= n1; n++) {
    const t = n * minor;
    const x = Math.round(xOf(t) - sl) + 0.5;
    const isMajor = n % sub === 0;
    ctx.strokeStyle = isMajor ? '#6d6b7b' : '#3c3a47';
    ctx.beginPath();
    ctx.moveTo(x, isMajor ? 16 : 22);
    ctx.lineTo(x, 30);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = '#8c8a99';
      ctx.fillText(fmtRuler(t, major), x + 4, 4);
    }
  }
}

function updatePlayhead(follow = false) {
  const x = xOf(state.playhead);
  playheadEl.style.left = x + 'px';
  const total = totalDuration();
  $('#timeDisplay').innerHTML = `<b>${fmtTime(state.playhead)}</b> / ${fmtTime(total)}`;
  if (follow) {
    const sl = tlScroll.scrollLeft, w = tlScroll.clientWidth;
    if (x > sl + w - 60 || x < sl) tlScroll.scrollLeft = x - 60;
  }
}

function updateButtons() {
  const sel = state.clips.some(c => c.id === state.selected);
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
  $('#btnDelete').disabled = !sel;
  $('#btnDup').disabled = !sel;
  $('#btnSplit').disabled = !state.clips.length;
  $('#exportBtn').disabled = !state.clips.length;
}

function renderAll() {
  layoutStage();
  renderTimeline();
}

tlScroll.addEventListener('scroll', scheduleTimelineRender);

// ---------------------------------------------------------------- zoom
const fitZoom = () => (tlScroll.clientWidth - PAD * 2 - 30) / Math.max(totalDuration(), 0.5);
function setZoom(z, anchorT = state.playhead, anchorX = xOf(state.playhead) - tlScroll.scrollLeft) {
  const min = Math.min(fitZoom() * 0.5, 2);
  // Chromium's layout gives up past ~33 million px, so very long timelines get a lower zoom ceiling.
  const max = Math.min(4000, 1.6e7 / Math.max(totalDuration(), 1));
  state.zoom = clamp(z, Math.max(0.005, Math.min(min, max)), max);
  tlContent.style.width = Math.max(tlScroll.clientWidth, PAD * 2 + totalDuration() * state.zoom + 400) + 'px';
  tlScroll.scrollLeft = xOf(anchorT) - anchorX;
  renderTimeline();
}
function zoomToFit() {
  setZoom(fitZoom(), 0, PAD);
  tlScroll.scrollLeft = 0;
}
tlScroll.addEventListener('wheel', e => {
  if (e.ctrlKey) {
    e.preventDefault();
    const rect = tlScroll.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const at = tOf(tlScroll.scrollLeft + ax);
    setZoom(state.zoom * Math.pow(1.0015, -e.deltaY), at, ax);
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    tlScroll.scrollLeft += e.deltaY;
  }
}, { passive: false });

// ---------------------------------------------------------------- timeline pointer interactions
let drag = null;
const contentX = e => e.clientX - tlContent.getBoundingClientRect().left;

function insertIndexAt(x, excludeId = null) {
  const L = layout();
  let idx = 0;
  for (const r of L) {
    if (r.clip.id === excludeId) continue;
    if (x > (xOf(r.start) + xOf(r.end)) / 2) idx++;
  }
  return idx;
}
function showMarkerAt(index, excludeId = null) {
  const L = layout().filter(r => r.clip.id !== excludeId);
  let x;
  if (!L.length) x = PAD;
  else if (index >= L.length) x = xOf(layout().slice(-1)[0].end);
  else x = xOf(layout().find(r => r.clip.id === L[index].clip.id).start);
  marker.style.left = x + 'px';
  marker.style.display = 'block';
}
const hideMarker = () => { marker.style.display = 'none'; };

tlContent.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const x = contentX(e);
  const clipEl = e.target.closest('.clip');
  const handle = e.target.closest('.handle');
  if (clipEl) {
    const id = +clipEl.dataset.id;
    const r = layout().find(r => r.clip.id === id);
    state.selected = id;
    renderTimeline();
    if (handle) {
      pause();
      drag = { type: 'trim', side: handle.classList.contains('l') ? 'l' : 'r', id, x0: x, in0: r.clip.in, out0: r.clip.out, committed: false };
    } else {
      drag = { type: 'press', id, x0: x, offset: x - xOf(r.start) };
    }
  } else {
    if (state.clips.length && !e.target.closest('.ph-knob') && e.target !== ruler) {
      state.selected = null;
      renderTimeline();
    }
    drag = { type: 'scrub', wasPlaying: state.playing };
    pause();
    seek(tOf(x));
  }
  tlContent.setPointerCapture(e.pointerId);
  e.preventDefault();
});

tlContent.addEventListener('pointermove', e => {
  if (!drag) return;
  const x = contentX(e);
  if (drag.type === 'scrub') {
    seek(tOf(x));
  } else if (drag.type === 'press' && Math.abs(x - drag.x0) > 5) {
    pause();
    drag.type = 'move';
    const src = clipEls.get(drag.id);
    src.classList.add('dragging');
    drag.ghost = src.cloneNode(true);
    drag.ghost.className = 'clip ghost';
    drag.ghost.style.width = Math.min(parseFloat(src.style.width), 240) + 'px';
    drag.offset = Math.min(drag.offset, 120);
    tlContent.appendChild(drag.ghost);
  }
  if (drag.type === 'move') {
    drag.ghost.style.left = x - drag.offset + 'px';
    drag.index = insertIndexAt(x, drag.id);
    showMarkerAt(drag.index, drag.id);
  } else if (drag.type === 'trim') {
    doTrim(x);
  }
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === 'scrub') {
    if (d.wasPlaying) play();
  } else if (d.type === 'move') {
    d.ghost.remove();
    const el = clipEls.get(d.id);
    if (el) el.classList.remove('dragging');
    hideMarker();
    moveClip(d.id, d.index);
  } else if (d.type === 'trim' && d.committed) {
    afterEdit();
  }
}
tlContent.addEventListener('pointerup', endDrag);
tlContent.addEventListener('pointercancel', endDrag);
tlContent.addEventListener('lostpointercapture', endDrag);

function doTrim(x) {
  const clip = state.clips.find(c => c.id === drag.id);
  if (!clip) return;
  const m = mediaById(clip.mediaId);
  const fps = fpsOf(m);
  const minLen = 1 / fps;
  const delta = (x - drag.x0) / state.zoom;
  const snap = t => Math.round(t * fps) / fps;
  let changed = false;
  if (drag.side === 'r') {
    let out = snap(drag.out0 + delta);
    out = clamp(out, clip.in + minLen, m.info.duration);
    if (drag.out0 + delta >= m.info.duration) out = m.info.duration;
    if (out !== clip.out) {
      if (!drag.committed) { commit(); drag.committed = true; }
      clip.out = out;
      changed = true;
    }
    if (changed) previewSource(m, Math.max(clip.in, out - minLen));
  } else {
    let inn = clamp(snap(drag.in0 + delta), 0, clip.out - minLen);
    if (inn !== clip.in) {
      if (!drag.committed) { commit(); drag.committed = true; }
      clip.in = inn;
      changed = true;
    }
    if (changed) previewSource(m, inn);
  }
  if (changed) renderTimeline();
}

// ---------------------------------------------------------------- drag & drop (media panel and Explorer)
const MEDIA_TYPE = 'application/x-frameseam-media';
const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
const isMediaDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes(MEDIA_TYPE);

function droppedPaths(e) {
  return Array.from(e.dataTransfer.files || [])
    .map(f => { try { return api.pathForFile(f); } catch { return ''; } })
    .filter(p => p && VIDEO_RE.test(p));
}

tlScroll.addEventListener('dragover', e => {
  if (!isFileDrag(e) && !isMediaDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  tlScroll.classList.add('drop-hot');
  $('#dropOverlay').hidden = true;
  showMarkerAt(insertIndexAt(contentX(e)));
});
tlScroll.addEventListener('dragleave', e => {
  if (!tlScroll.contains(e.relatedTarget)) { tlScroll.classList.remove('drop-hot'); hideMarker(); }
});
tlScroll.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  tlScroll.classList.remove('drop-hot');
  hideMarker();
  const index = insertIndexAt(contentX(e));
  if (isMediaDrag(e)) {
    addClips([mediaById(+e.dataTransfer.getData(MEDIA_TYPE))], index);
  } else {
    const paths = droppedPaths(e);
    if (!paths.length) return toast('Drop video files (mp4, mov, mkv, …)');
    const added = await importPaths(paths);
    addClips(added, index);
  }
});

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
  $('#mediaPanel').classList.add('drop-hot');
});
window.addEventListener('dragleave', e => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) { $('#dropOverlay').hidden = true; $('#mediaPanel').classList.remove('drop-hot'); }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  $('#mediaPanel').classList.remove('drop-hot');
  if (!isFileDrag(e)) return;
  const paths = droppedPaths(e);
  if (!paths.length) return toast('Drop video files (mp4, mov, mkv, …)');
  await importPaths(paths);
});
document.addEventListener('drop', () => {
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  $('#mediaPanel').classList.remove('drop-hot');
  tlScroll.classList.remove('drop-hot');
}, true);

// ---------------------------------------------------------------- export
let exportUI = null;

// Same rule as targetFor() in src/ffmpeg.js, so the dialog describes what the export will really do.
function targetFor(info) {
  const tenBit = (info.bitDepth || 8) > 8;
  return { family: info.vcodec === 'hevc' || tenBit ? 'hevc' : 'h264', tenBit };
}

function fastCompat(L) {
  const a = L[0].media.info;
  for (const r of L) {
    const b = r.media.info;
    if (b.vcodec !== a.vcodec || b.width !== a.width || b.height !== a.height || b.pixFmt !== a.pixFmt ||
        b.rotation !== a.rotation || Math.abs(b.fps - a.fps) > 0.01 || b.hasAudio !== a.hasAudio ||
        b.acodec !== a.acodec || b.sampleRate !== a.sampleRate || b.channels !== a.channels) {
      return 'Not available: the clips come from videos with different formats.';
    }
  }
  return null;
}

let exportOpening = false;
async function openExport() {
  if (!state.clips.length) return toast('Add a video to the timeline first');
  if (exportOpening || modalOpen()) return;
  pause();
  exportOpening = true;
  const enc = await api.encoders(); // instant after the first call; the timeline is only read once this is back
  exportOpening = false;
  if (!state.clips.length || modalOpen()) return;
  const L = layout();
  const info = L[0].media.info;
  const t = targetFor(info);
  const codecLabel = `${t.family === 'hevc' ? 'HEVC' : 'H.264'}${t.tenBit ? ' 10-bit' : ''}`;
  // A card is only offered if it can encode what this video needs (8-bit H.264, 8-bit HEVC or 10-bit HEVC).
  const need = t.tenBit ? 'hevc10' : t.family;
  const devices = (enc.devices || []).map(d => ({ ...d, ok: !!(d.caps && d.caps[need]) }));
  const anyCard = devices.some(d => d.ok);
  // Pre-select the card used last time if it's still here and suitable, else the first suitable one, else the CPU.
  let lastCard = null;
  try { lastCard = localStorage.getItem('exportCard'); } catch { /* storage unavailable */ }
  let device = null;
  if (lastCard !== 'cpu') device = devices.find(d => d.ok && d.id === lastCard) || devices.find(d => d.ok) || null;
  let cardNote = '';
  if (!devices.length) cardNote = 'No hardware video encoder was found on this PC, so the CPU will do the encoding. That works fine, it just takes longer.';
  else if (!anyCard) cardNote = `Your video card can't encode ${codecLabel}, so the CPU will do the encoding for this video.`;
  const fastBlock = fastCompat(L);
  const mixed = L.some(r => {
    const b = r.media.info;
    return b.displayWidth !== info.displayWidth || b.displayHeight !== info.displayHeight || Math.abs(b.fps - info.fps) > 0.01;
  });
  const opts = { mode: 'exact', quality: 'high' };
  const applyDevice = d => {
    opts.useGpu = !!d;
    opts.device = d ? d.id : null;
    opts.gpu = d ? d.kind : null;
    opts.gpuIndex = d ? d.index : null;
  };
  applyDevice(device);

  const modal = $('#modal');
  modal.innerHTML = `
    <h2>Export video</h2>
    <div class="specs">
      <div class="spec-box"><b>${info.displayWidth} × ${info.displayHeight}</b><span>Resolution</span></div>
      <div class="spec-box"><b>${fmtFps(info.fps)} fps</b><span>Frame rate</span></div>
      <div class="spec-box"><b>${fmtTime(totalDuration())}</b><span>Length</span></div>
      <div class="spec-box"><b>${t.family === 'hevc' ? 'HEVC' : 'H.264'}${t.tenBit ? ' 10-bit' : ''}</b><span>Codec</span></div>
    </div>
    <p class="note ${mixed ? 'warn' : ''}">${mixed
      ? `Your clips come from videos with different sizes or frame rates. Everything will be converted to match the first clip (${info.displayWidth}×${info.displayHeight} at ${fmtFps(info.fps)} fps).`
      : 'Matches your original video: same resolution, frame rate and orientation.'}</p>
    <label class="mode sel" data-mode="exact">
      <input type="radio" name="mode" checked>
      <div><b>Exact cuts (recommended)</b>
      <span>Cuts on the exact frames you chose. Re-encodes at near-original quality ${anyCard ? 'on the video card you pick below' : 'on the CPU'}.</span></div>
    </label>
    <label class="mode ${fastBlock ? 'disabled' : ''}" data-mode="fast">
      <input type="radio" name="mode" ${fastBlock ? 'disabled' : ''}>
      <div><b>Fast &amp; lossless</b>
      <span>${fastBlock || 'Copies the original video data with zero quality loss and finishes in seconds. Each cut can start a little early (up to a couple of seconds), because it has to begin on a keyframe.'}</span></div>
    </label>
    <div id="exactOpts">
      <div class="row"><label>Quality</label>
        <select id="qualitySel">
          <option value="best">Visually lossless (biggest file)</option>
          <option value="high" selected>High (recommended)</option>
          <option value="small">Smaller file</option>
        </select>
      </div>
      <div class="row"><label>Video card</label>
        <select id="cardSel">
          ${devices.map(d => `<option value="${esc(d.id)}" ${device && d.id === device.id ? 'selected' : ''} ${d.ok ? '' : 'disabled'}>${esc(d.name)}${d.ok ? '' : ` (can't encode ${codecLabel})`}</option>`).join('')}
          <option value="cpu" ${device ? '' : 'selected'}>None, use the CPU${anyCard ? ' (much slower)' : ''}</option>
        </select>
      </div>
      ${cardNote ? `<p class="note">${cardNote}</p>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn-secondary" id="expCancel">Cancel</button>
      <button class="btn-primary" id="expGo">${icon('export')}Export</button>
    </div>`;
  $('#modalBack').hidden = false;

  modal.querySelectorAll('.mode').forEach(el => el.addEventListener('click', e => {
    if (el.classList.contains('disabled')) { e.preventDefault(); return; }
    opts.mode = el.dataset.mode;
    modal.querySelectorAll('.mode').forEach(m => m.classList.toggle('sel', m === el));
    el.querySelector('input').checked = true;
    $('#exactOpts').style.display = opts.mode === 'exact' ? '' : 'none';
  }));
  $('#qualitySel').onchange = e => { opts.quality = e.target.value; };
  $('#cardSel').onchange = e => {
    const d = devices.find(x => x.ok && x.id === e.target.value) || null;
    applyDevice(d);
    try { localStorage.setItem('exportCard', d ? d.id : 'cpu'); } catch { /* storage unavailable */ }
  };
  $('#expCancel').onclick = closeModal;
  $('#expGo').onclick = async () => {
    const name = ($('#projectName').value.trim() || 'My video').replace(/[\\/:*?"<>|]+/g, '_');
    // Fast mode keeps the original codecs, so suggest a container that can hold them: the source's own when it is a
    // common one, otherwise MKV, which takes anything.
    const srcExt = (L[0].media.path.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
    const ext = opts.mode !== 'fast' ? 'mp4' : /^(mp4|mov|m4v|mkv|webm)$/.test(srcExt) ? srcExt : 'mkv';
    const out = await api.saveDialog(`${dirname(L[0].media.path)}\\${name}.${ext}`);
    if (!out) return;
    runExport({
      ...opts,
      output: out,
      segments: L.map(r => ({ path: r.media.path, in: r.clip.in, out: r.clip.out, info: r.media.info })),
    });
  };
}

async function runExport(plan) {
  const modal = $('#modal');
  modal.innerHTML = `
    <h2>Exporting…</h2>
    <div class="path">${esc(plan.output)}</div>
    <div class="progress"><div id="progBar"></div></div>
    <div class="prog-meta"><span id="progPct">0%</span><span id="progEta">Starting…</span></div>
    <p class="note" id="progUsing">${plan.mode === 'fast' ? 'Copying the original video data, no re-encoding.' : ''}</p>
    <div class="modal-foot"><button class="btn-secondary" id="expStop">Cancel export</button></div>`;
  $('#expStop').onclick = () => api.exportCancel();
  exportUI = { start: performance.now() };
  const res = await api.exportStart(plan);
  exportUI = null;
  if (res.ok) {
    api.setDirty(false);
    modal.innerHTML = `
      <h2>Export complete 🎉</h2>
      <div class="path">${esc(plan.output)}</div>
      <div class="modal-foot">
        <button class="btn-secondary" id="expShow">Show in folder</button>
        <button class="btn-primary" id="expDone">Done</button>
      </div>`;
    $('#expShow').onclick = () => api.showInFolder(plan.output);
    $('#expDone').onclick = closeModal;
  } else if (res.cancelled) {
    closeModal();
    toast('Export cancelled');
  } else {
    modal.innerHTML = `
      <h2>Export failed</h2>
      <div class="err-box">${esc(res.error)}</div>
      <p class="note">${plan.mode === 'fast' ? 'Fast & lossless keeps the original codecs; if the chosen file type can\'t hold them, saving as .mkv works for any of them.'
    : plan.useGpu ? 'Try again with a different video card, or with the CPU.' : ''}</p>
      <div class="modal-foot"><button class="btn-primary" id="expDone">Close</button></div>`;
    $('#expDone').onclick = closeModal;
  }
}

api.onExportProgress(p => {
  if (!exportUI) return;
  const bar = $('#progBar');
  if (!bar) return;
  if (p.using && $('#progUsing')) $('#progUsing').textContent = `Encoding on: ${p.using}`;
  bar.style.width = p.percent.toFixed(1) + '%';
  $('#progPct').textContent = `${Math.floor(p.percent)}%`;
  const el = (performance.now() - exportUI.start) / 1000;
  if (p.percent > 1 && p.percent < 100) {
    const eta = (el * (100 - p.percent)) / p.percent;
    $('#progEta').textContent = `About ${fmtShort(eta)} left${p.speed ? ` · ${p.speed.trim()}` : ''}`;
  }
});

function closeModal() {
  if (exportUI) return;
  $('#modalBack').hidden = true;
  $('#modal').innerHTML = '';
}
const modalOpen = () => !$('#modalBack').hidden;

// ---------------------------------------------------------------- help
const SHORTCUTS = [
  ['Space', 'Play / pause (or click the preview)'],
  ['S', 'Split the clip at the playhead'],
  ['Delete / Backspace', 'Delete the selected clip'],
  ['← / →', 'Step one frame'],
  ['Shift + ← / →', 'Jump one second'],
  ['Home / End', 'Go to the start / end'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+D', 'Duplicate the selected clip'],
  ['Ctrl + wheel, Ctrl + / −', 'Zoom the timeline'],
  ['Ctrl+0', 'Fit the whole timeline in the window'],
  ['Ctrl+I', 'Import media'],
  ['Ctrl+E', 'Export'],
  ['Esc', 'Deselect'],
  ['?', 'This list'],
];
function openHelp() {
  if (modalOpen()) return;
  pause();
  $('#modal').innerHTML = `
    <h2>Keyboard shortcuts</h2>
    <table class="keys">${SHORTCUTS.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>
    <p class="note" style="margin-top:14px">Drag a video from the left panel onto the timeline, or drop files from Explorer anywhere on the window.
    Drag the white edges of a clip to trim it; drag a clip to reorder.</p>
    <div class="modal-foot"><button class="btn-primary" id="helpDone">Done</button></div>`;
  $('#modalBack').hidden = false;
  $('#helpDone').onclick = closeModal;
}

// ---------------------------------------------------------------- buttons & keys
$('#helpBtn').onclick = openHelp;
$('#importBtn').onclick = importDialog;
$('#railImport').onclick = importDialog;
$('#exportBtn').onclick = openExport;
$('#btnPlay').onclick = togglePlay;
$('#btnStart').onclick = () => seek(0);
$('#btnEnd').onclick = () => seek(totalDuration());
$('#btnBack').onclick = () => seek(state.playhead - 5);
$('#btnFwd').onclick = () => seek(state.playhead + 5);
$('#btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnSplit').onclick = split;
$('#btnDelete').onclick = deleteSelected;
$('#btnDup').onclick = duplicateSelected;
$('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.6);
$('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.6);
$('#btnFit').onclick = zoomToFit;
stage.addEventListener('click', togglePlay);
stage.addEventListener('dblclick', () => $('#btnFull').click());
$('#projectName').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (modalOpen()) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, lower = k.toLowerCase();
  let handled = true;
  if (k === ' ') togglePlay();
  else if (ctrl && lower === 'z') (e.shiftKey ? redo() : undo());
  else if (ctrl && lower === 'y') redo();
  else if (ctrl && lower === 'd') duplicateSelected();
  else if (ctrl && lower === 'i') importDialog();
  else if (ctrl && lower === 'e') openExport();
  else if (ctrl && (k === '=' || k === '+')) setZoom(state.zoom * 1.6);
  else if (ctrl && k === '-') setZoom(state.zoom / 1.6);
  else if (ctrl && k === '0') zoomToFit();
  else if (!ctrl && lower === 's') split();
  else if (k === 'Delete' || k === 'Backspace') deleteSelected();
  else if (k === 'ArrowLeft') (e.shiftKey ? seek(state.playhead - 1) : stepFrame(-1));
  else if (k === 'ArrowRight') (e.shiftKey ? seek(state.playhead + 1) : stepFrame(1));
  else if (k === 'Home') seek(0);
  else if (k === 'End') seek(totalDuration());
  else if (k === 'Escape') { state.selected = null; renderTimeline(); }
  else if (k === '?' || k === 'F1') openHelp();
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------- init
renderMedia();
renderAll();
updatePlayButton();
