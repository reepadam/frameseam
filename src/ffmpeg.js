'use strict';
// Everything that touches ffmpeg/ffprobe: reading file info, detecting hardware encoders, exporting.

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Prefer the copy that Setup.bat downloads into tools/ffmpeg, otherwise use ffmpeg from PATH.
const BIN_DIR = path.join(__dirname, '..', 'tools', 'ffmpeg');
const bundled = name => path.join(BIN_DIR, name + (process.platform === 'win32' ? '.exe' : ''));
const FFMPEG = fs.existsSync(bundled('ffmpeg')) ? bundled('ffmpeg') : 'ffmpeg';
const FFPROBE = fs.existsSync(bundled('ffprobe')) ? bundled('ffprobe') : 'ffprobe';
const TMP_PREFIX = 'frameseam-';

// ---------- toolchain ----------

let toolchainCache = null;
// Checked once at startup: are ffmpeg and ffprobe there, and which ffmpeg version is it?
function checkToolchain() {
  if (!toolchainCache) {
    toolchainCache = new Promise(resolve => {
      const why = err => (err.code === 'ENOENT' ? 'not found' : err.message);
      execFile(FFMPEG, ['-version'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ ok: false, ffmpeg: FFMPEG, error: `ffmpeg ${why(err)}` });
        const first = String(stdout).split(/\r?\n/)[0] || '';
        const m = /^ffmpeg version n?(\d+)\./i.exec(first);
        // Git snapshot builds ("2024-03-14-git-...", "N-114172-g...") don't put the release number in the first line, but
        // libavcodec's major version maps to it (60 = ffmpeg 6, 61 = 7, 62 = 8, 63 = 9).
        const lavc = /^libavcodec\s+(\d+)\./m.exec(String(stdout));
        const major = m ? Number(m[1]) : lavc ? Number(lavc[1]) - 54 : 99;
        execFile(FFPROBE, ['-version'], { windowsHide: true }, err2 => {
          if (err2) return resolve({ ok: false, ffmpeg: FFMPEG, error: `ffprobe ${why(err2)}` });
          // The CPU encoders are optional ffmpeg components; a build without them can still do lossless exports.
          execFile(FFMPEG, ['-hide_banner', '-encoders'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_e3, list) => {
            const has = name => new RegExp(`\\b${name}\\b`).test(String(list || ''));
            resolve({ ok: true, ffmpeg: FFMPEG, version: first.replace(/^ffmpeg version /, '').split(' ')[0], major,
              cpu: { h264: has('libx264'), hevc: has('libx265') } });
          });
        });
      });
    });
  }
  return toolchainCache;
}

// ---------- probing ----------

// Common frame rates, used to clean up the slightly-off averages that phones report.
const STANDARD_RATES = ['24000/1001', '24', '25', '30000/1001', '30', '48', '50', '60000/1001', '60',
  '90', '100', '120000/1001', '120', '144', '240'];

function parseRate(s) {
  if (!s) return 0;
  const [n, d] = String(s).split('/').map(Number);
  if (d === undefined) return n || 0;
  return d ? n / d : 0;
}

function pickFrameRate(v) {
  const r = parseRate(v.r_frame_rate), avg = parseRate(v.avg_frame_rate);
  const isStd = s => STANDARD_RATES.some(x => Math.abs(parseRate(x) - parseRate(s)) < 0.001);
  // Constant-frame-rate files: r_frame_rate is exact.
  if (r > 0 && r <= 240 && (!(avg > 0) || Math.abs(r - avg) / r < 0.05)) {
    return { fps: r, fpsStr: v.r_frame_rate };
  }
  // Variable-frame-rate (phones): snap the average to the nearest standard rate.
  if (avg > 0) {
    let best = null;
    for (const s of STANDARD_RATES) {
      const d = Math.abs(parseRate(s) - avg) / avg;
      if (d < 0.04 && (!best || d < best.d)) best = { s, d };
    }
    if (best) return { fps: parseRate(best.s), fpsStr: best.s };
    return { fps: avg, fpsStr: v.avg_frame_rate };
  }
  if (r > 0 && isStd(v.r_frame_rate)) return { fps: r, fpsStr: v.r_frame_rate };
  return { fps: 30, fpsStr: '30' };
}

const even = n => Math.max(2, Math.round(n / 2) * 2);

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split(/\r?\n/).pop() || 'Unreadable file'));
        let j;
        try { j = JSON.parse(stdout); } catch { return reject(new Error('Could not read file info')); }
        const streams = j.streams || [];
        const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        if (!v) return reject(new Error('No video stream found'));
        const a = streams.find(s => s.codec_type === 'audio');

        let rotation = 0;
        const sd = (v.side_data_list || []).find(d => d.rotation !== undefined);
        if (sd) rotation = Number(sd.rotation) || 0;
        else if (v.tags && v.tags.rotate) rotation = -Number(v.tags.rotate) || 0;
        const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;

        let sar = 1;
        if (v.sample_aspect_ratio && /^\d+:\d+$/.test(v.sample_aspect_ratio)) {
          const [sn, sdn] = v.sample_aspect_ratio.split(':').map(Number);
          if (sn > 0 && sdn > 0) sar = sn / sdn;
        }
        let dw = even(v.width * sar), dh = even(v.height);
        if (quarterTurn) [dw, dh] = [dh, dw];

        const { fps, fpsStr } = pickFrameRate(v);
        if (!(v.width > 0) || !(v.height > 0)) return reject(new Error('Could not read the video size'));
        // Frame-aligned length of the VIDEO stream. MP4 reports it per stream; Matroska/WebM only in a per-track
        // DURATION tag ("00:00:08.000000000"); the container's duration (usually the longer audio) is the last resort.
        const tag = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec((v.tags && (v.tags.DURATION || v.tags['DURATION-eng'])) || '');
        const tagDuration = tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : 0;
        const rawDuration = Number(v.duration) || tagDuration || Number(j.format && j.format.duration) || 0;
        const duration = Math.floor(rawDuration * fps + 1e-3) / fps;
        if (!(duration > 0)) return reject(new Error('Could not read the video length'));
        const clean = x => (x && x !== 'unknown' ? x : null);
        // Bit depth: ffprobe's bits_per_raw_sample when it knows it, else the "...p10le" suffix of the pixel format.
        const pf = v.pix_fmt || 'yuv420p';
        const sfx = /[a-z](\d{1,2})(?:le|be)$/.exec(pf) || /^p0(\d{2})/.exec(pf);
        const bitDepth = Number(v.bits_per_raw_sample) || (sfx ? Number(sfx[1]) : 8);

        resolve({
          duration,
          rawDuration,
          videoStart: Math.max(0, Number(v.start_time) || 0),
          width: v.width,
          height: v.height,
          displayWidth: dw,
          displayHeight: dh,
          rotation,
          fps,
          fpsStr,
          videoIndex: v.index,
          audioIndex: a ? a.index : null,
          vcodec: v.codec_name,
          pixFmt: pf,
          bitDepth,
          bitrate: Number(v.bit_rate || (j.format && j.format.bit_rate)) || 0,
          colorPrimaries: clean(v.color_primaries),
          colorTrc: clean(v.color_transfer),
          colorSpace: clean(v.color_space),
          colorRange: clean(v.color_range),
          hasAudio: !!a,
          acodec: a ? a.codec_name : null,
          sampleRate: a ? Number(a.sample_rate) || 48000 : null,
          channels: a ? a.channels : 0,
          container: (j.format && j.format.format_name) || '',
          size: Number(j.format && j.format.size) || 0,
        });
      });
  });
}

// ---------- hardware encoder detection ----------
// Which hardware encoders actually work on THIS PC. Each one is tried with a tiny synthetic encode, so a driver that
// is installed without a matching card, or a card too old for HEVC or 10-bit, is correctly reported as unavailable.

const VENDORS = [
  { kind: 'nvenc', fallbackName: 'NVIDIA GPU (NVENC)', match: /nvidia|geforce|quadro/i, pix8: 'yuv420p' },
  { kind: 'qsv', fallbackName: 'Intel GPU (Quick Sync)', match: /intel/i, pix8: 'nv12' },
  { kind: 'amf', fallbackName: 'AMD GPU (AMF)', match: /\bamd\b|radeon/i, pix8: 'nv12' },
];
// What a card must be able to do for a given export: 8-bit H.264, 8-bit HEVC, or 10-bit HEVC.
const CAPS = [
  { cap: 'h264', family: 'h264', pix: v => v.pix8 },
  { cap: 'hevc', family: 'hevc', pix: v => v.pix8 },
  { cap: 'hevc10', family: 'hevc', pix: () => 'p010le' },
];

function tryEncode(encoder, pix, extra) {
  return new Promise(res => {
    let err = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.2',
      '-frames:v', '2', '-pix_fmt', pix, '-c:v', encoder, ...extra, '-f', 'null', '-'], { windowsHide: true });
    p.stderr.on('data', d => { err = (err + d.toString()).slice(-600); });
    p.on('close', c => res({ ok: c === 0, why: c === 0 ? '' : (err.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${c}`) }));
    p.on('error', e => res({ ok: false, why: e.message }));
  });
}

// { caps: { h264, hevc, hevc10 }, why: { <cap>: ffmpeg's last error line for the ones that failed } }
async function capsFor(vendor, extra) {
  const results = await Promise.all(CAPS.map(c => tryEncode(`${c.family}_${vendor.kind}`, c.pix(vendor), extra)));
  const caps = {}, why = {};
  CAPS.forEach((c, i) => { caps[c.cap] = results[i].ok; if (!results[i].ok) why[c.cap] = results[i].why; });
  return { caps, why };
}

// `-gpu list` makes nvenc print every CUDA device it can use, e.g. "[ GPU #1 - < NVIDIA GeForce RTX 4070 > has Compute SM 8.9 ]".
function listNvencGpus() {
  return new Promise(res => {
    let log = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1',
      '-c:v', 'h264_nvenc', '-gpu', 'list', '-f', 'null', '-'], { windowsHide: true });
    p.stderr.on('data', d => { log += d.toString(); });
    p.on('error', () => res([]));
    p.on('close', () => {
      const gpus = [];
      for (const m of log.matchAll(/GPU #(\d+) - < (.+?) >/g)) gpus.push({ index: Number(m[1]), name: m[2].trim() });
      res(gpus);
    });
  });
}

// Names of the video cards Windows knows about, used to label the Intel and AMD encoders.
function listVideoControllers() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(res => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object Name'],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => res(err ? [] : String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  });
}

let encoderCache = null;
// Resolves to { devices: [{ id, kind, index, name, caps: { h264, hevc, hevc10 }, why }, ...], unavailable: { <kind>: reason } }.
// An empty device list means CPU only.
function detectEncoders() {
  if (!encoderCache) {
    encoderCache = (async () => {
      const [controllers, nvGpus, ...vendorResults] = await Promise.all([
        listVideoControllers(),
        listNvencGpus(),
        ...VENDORS.map(v => capsFor(v, [])),
      ]);
      const devices = [];
      const unavailable = {};
      for (let i = 0; i < VENDORS.length; i++) {
        const v = VENDORS[i], { caps, why } = vendorResults[i];
        if (!caps.h264 && !caps.hevc) { unavailable[v.kind] = why.h264; continue; }
        if (v.kind === 'nvenc' && nvGpus.length > 1) {
          // Several NVIDIA cards: test each one, they can differ in what they encode.
          const perGpu = await Promise.all(nvGpus.map(g => capsFor(v, ['-gpu', String(g.index)])));
          nvGpus.forEach((g, k) => {
            if (perGpu[k].caps.h264 || perGpu[k].caps.hevc) {
              devices.push({ id: `nvenc:${g.index}`, kind: 'nvenc', index: g.index, name: g.name, caps: perGpu[k].caps, why: perGpu[k].why });
            }
          });
        } else {
          const nv = v.kind === 'nvenc' ? nvGpus[0] : null;
          const name = (nv && nv.name) || controllers.find(n => v.match.test(n)) || v.fallbackName;
          devices.push({ id: v.kind, kind: v.kind, index: nv ? nv.index : null, name, caps, why });
        }
      }
      return { devices, unavailable, controllers };
    })();
  }
  return encoderCache;
}

// ---------- export ----------

// The output matches the first clip on the timeline. Other clips are converted to fit it.
function targetFor(info) {
  const tenBit = (info.bitDepth || 8) > 8;
  return {
    width: info.displayWidth,
    height: info.displayHeight,
    fps: info.fps,
    fpsStr: info.fpsStr,
    family: info.vcodec === 'hevc' || tenBit ? 'hevc' : 'h264',
    tenBit,
  };
}

// The card an export runs on: the one the user picked, if it can encode what this video needs; otherwise the CPU.
function pickDevice(plan, enc, t) {
  if (!plan.useGpu) return null;
  const need = t.tenBit ? 'hevc10' : t.family;
  const d = enc.devices.find(x => x.id === plan.device) ||
    enc.devices.find(x => x.kind === plan.gpu && (plan.gpuIndex == null || x.index === plan.gpuIndex));
  return d && d.caps[need] ? d : null;
}

const QUALITY = { best: { cq: 16, crf: 14 }, high: { cq: 19, crf: 17 }, small: { cq: 24, crf: 22 } };

function videoEncoderArgs(t, quality, gpu, gpuIndex) {
  const q = QUALITY[quality] || QUALITY.high;
  const hevcTag = t.family === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  if (gpu === 'nvenc') {
    return ['-c:v', `${t.family}_nvenc`, ...(Number.isInteger(gpuIndex) ? ['-gpu', String(gpuIndex)] : []),
      '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q.cq),
      '-b:v', '0', '-spatial-aq', '1', ...(t.family === 'h264' ? ['-profile:v', 'high'] : []), ...hevcTag];
  }
  if (gpu === 'qsv') {
    return ['-c:v', `${t.family}_qsv`, '-preset', 'slower', '-global_quality', String(q.cq), ...hevcTag];
  }
  if (gpu === 'amf') {
    return ['-c:v', `${t.family}_amf`, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q.cq),
      '-qp_p', String(q.cq + 2), ...(t.family === 'h264' ? ['-qp_b', String(q.cq + 4)] : []), ...hevcTag];
  }
  if (t.family === 'hevc') {
    return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q.crf), '-x265-params', 'log-level=error', ...hevcTag];
  }
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q.crf)];
}

function pixFmtFor(t, gpu) {
  if (t.tenBit) return gpu ? 'p010le' : 'yuv420p10le';
  return gpu === 'qsv' || gpu === 'amf' ? 'nv12' : 'yuv420p';
}

// Colour tags are copied from the source so HDR/wide-gamut footage keeps its meaning. Only values ffmpeg accepts as
// option values are passed on (ffprobe reports a few names, like "gbr" or "reserved", that the encoder options reject).
const COLOR_VALUES = {
  primaries: ['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432', 'jedec-p22', 'ebu3213'],
  trc: ['bt709', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m', 'linear', 'log100', 'log316', 'iec61966-2-4', 'bt1361e',
    'iec61966-2-1', 'bt2020-10', 'bt2020-12', 'smpte2084', 'smpte428', 'arib-std-b67'],
  space: ['rgb', 'bt709', 'fcc', 'bt470bg', 'smpte170m', 'smpte240m', 'ycgco', 'bt2020nc', 'bt2020c', 'smpte2085',
    'chroma-derived-nc', 'chroma-derived-c', 'ictcp'],
  range: ['tv', 'pc'],
};
function colorArgs(info) {
  const a = [];
  const space = info.colorSpace === 'gbr' ? 'rgb' : info.colorSpace;
  if (COLOR_VALUES.primaries.includes(info.colorPrimaries)) a.push('-color_primaries', info.colorPrimaries);
  if (COLOR_VALUES.trc.includes(info.colorTrc)) a.push('-color_trc', info.colorTrc);
  if (COLOR_VALUES.space.includes(space)) a.push('-colorspace', space);
  if (COLOR_VALUES.range.includes(info.colorRange)) a.push('-color_range', info.colorRange);
  return a;
}

const isMp4Like = out => /\.(mp4|mov|m4v)$/i.test(out);

let current = null; // { proc, cancelled } while an export runs

function cancelledError() {
  const e = new Error('Export cancelled');
  e.cancelled = true;
  return e;
}

function runFfmpeg(args, onProgressLine) {
  return new Promise((resolve, reject) => {
    if (current && current.cancelled) return reject(cancelledError()); // cancelled between two ffmpeg runs
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    if (current) current.proc = proc;
    let errTail = '';
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (onProgressLine) onProgressLine(line);
      }
    });
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (current && current.cancelled) return reject(cancelledError());
      if (code === 0) return resolve();
      const lines = errTail.trim().split(/\r?\n/).filter(Boolean);
      reject(new Error(lines.slice(-3).join('\n') || `ffmpeg exited with code ${code}`));
    });
  });
}

// Re-encode with frame-accurate cuts. The output keeps the first clip's resolution, frame rate and orientation.
async function exportExact(plan, tmp, onProgress, target, fmtArgs, using) {
  const segs = plan.segments;
  const first = segs[0].info;
  const t = targetFor(first);
  const [tc, enc] = await Promise.all([checkToolchain(), detectEncoders()]);
  const device = pickDevice(plan, enc, t);
  const gpu = device ? device.kind : null;
  const pix = pixFmtFor(t, gpu);
  const anyAudio = segs.some(s => s.info.hasAudio);
  const sr = (segs.find(s => s.info.hasAudio) || { info: {} }).info.sampleRate || 48000;
  using.name = device ? device.name : 'CPU';
  onProgress({ percent: 0, speed: '', using: using.name });

  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  const graph = [];
  const labels = [];
  const fpsStr = /^\d+(\/\d+)?$/.test(t.fpsStr) ? t.fpsStr : String(t.fps);
  segs.forEach((s, i) => {
    const half = 0.5 / s.info.fps;
    // Start half a frame early and stop half a frame early, so the cut includes exactly the frames shown in the editor.
    const ss = s.in > 0 ? Math.max(0, s.in - half) : 0;
    const len = Math.max(0.001, (s.out - half) - ss);
    if (ss > 0) args.push('-ss', ss.toFixed(6));
    args.push('-t', len.toFixed(6), '-i', s.path);

    const dur = (s.out - s.in).toFixed(6);
    const vIn = `[${i}:${Number.isInteger(s.info.videoIndex) ? s.info.videoIndex : 'v:0'}]`;
    const aIn = `[${i}:${Number.isInteger(s.info.audioIndex) ? s.info.audioIndex : 'a:0'}]`;
    // The first scale gives anamorphic (non-square-pixel) sources square pixels before they are fitted to the output size.
    graph.push(`${vIn}setpts=PTS-STARTPTS,scale=trunc(iw*sar/2)*2:ih,setsar=1,` +
      `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease,` +
      `pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fpsStr},format=${pix}[v${i}]`);
    if (anyAudio) {
      if (s.info.hasAudio) {
        // Keep the audio on the same clock as the picture rather than rebasing it to its own first sample (that would
        // slide a late-starting audio track, as in OBS recordings, earlier). After a seek ffmpeg has put the seek point
        // at t=0 and the first wanted frame at t=half, so drop that half frame of audio; without a seek, shift by the
        // video's own start time. aresample's first_pts=0 then pads silence if the audio really starts after the picture.
        const shift = ss > 0 ? half : (s.info.videoStart || 0);
        const align = shift > 0 ? `atrim=start=${shift.toFixed(6)},asetpts=PTS-${shift.toFixed(6)}/TB,` : 'asetpts=PTS,';
        graph.push(`${aIn}${align}aresample=${sr}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=whole_dur=${dur},atrim=0:${dur}[a${i}]`);
      } else {
        graph.push(`anullsrc=r=${sr}:cl=stereo,atrim=0:${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      }
    }
    labels.push(`[v${i}]` + (anyAudio ? `[a${i}]` : ''));
  });
  graph.push(`${labels.join('')}concat=n=${segs.length}:v=1:a=${anyAudio ? 1 : 0}[vout]${anyAudio ? '[aout]' : ''}`);

  // The graph goes in a file (it can be long). ffmpeg 7+ reads it with "-/filter_complex", older versions with the
  // equivalent "-filter_complex_script".
  const graphFile = path.join(tmp, 'graph.txt');
  fs.writeFileSync(graphFile, graph.join(';\n'));
  args.push(tc.major >= 7 ? '-/filter_complex' : '-filter_complex_script', graphFile, '-map', '[vout]');
  if (anyAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '320k');
  args.push(...videoEncoderArgs(t, plan.quality, gpu, device ? device.index : null), ...colorArgs(first), '-max_muxing_queue_size', '9999');
  if (isMp4Like(plan.output)) args.push('-movflags', '+faststart');
  args.push(...fmtArgs, target);

  const total = segs.reduce((a, s) => a + (s.out - s.in), 0);
  let speed = '';
  await runFfmpeg(args, line => {
    const [k, v] = line.split('=');
    if (k === 'speed') speed = v;
    if (k === 'out_time_us' && v !== 'N/A') {
      const sec = Number(v) / 1e6;
      onProgress({ percent: Math.min(99.5, (sec / total) * 100), speed });
    }
  });
}

// Lossless stream copy. No re-encoding, but each cut snaps back to the previous keyframe.
async function exportFast(plan, tmp, onProgress, target, fmtArgs) {
  const segs = plan.segments;
  const total = segs.reduce((a, s) => a + (s.out - s.in), 0);
  let done = 0;
  const list = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    // Each piece is written in the same container type as its source, which is guaranteed to accept its codecs.
    const ext = (path.extname(s.path) || '.mkv').toLowerCase();
    const segPath = path.join(tmp, `seg${String(i).padStart(4, '0')}${ext}`);
    const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
    if (s.in > 0) args.push('-ss', s.in.toFixed(6));
    args.push('-i', s.path, '-t', (s.out - s.in).toFixed(6), '-map', `0:${Number.isInteger(s.info.videoIndex) ? s.info.videoIndex : 'v:0'}`);
    if (s.info.hasAudio) args.push('-map', `0:${Number.isInteger(s.info.audioIndex) ? s.info.audioIndex : 'a:0'}`);
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', segPath);
    await runFfmpeg(args);
    done += s.out - s.in;
    onProgress({ percent: (done / total) * 90, speed: '' });
    list.push(`file '${segPath.replace(/'/g, "'\\''")}'`);
  }
  const listFile = path.join(tmp, 'list.txt');
  fs.writeFileSync(listFile, list.join('\n'));
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v', '-map', '0:a?', '-c', 'copy'];
  if (segs[0].info.vcodec === 'hevc' && isMp4Like(plan.output)) args.push('-tag:v', 'hvc1');
  if (isMp4Like(plan.output)) args.push('-movflags', '+faststart');
  args.push(...fmtArgs, target);
  await runFfmpeg(args);
}

// Output containers ffmpeg can't infer from a ".part" file name, so they are passed explicitly.
const FORMATS = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm' };

// Resolves to { using } = the encoder that did the work ('copy' for Fast mode).
async function exportVideo(plan, onProgress) {
  if (current) throw new Error('An export is already running');
  const outNorm = path.resolve(plan.output).toLowerCase();
  if (plan.segments.some(s => path.resolve(s.path).toLowerCase() === outNorm)) {
    throw new Error("Can't overwrite one of the source videos. Choose a different file name.");
  }
  // The folder name carries our process id so cleanupTemp() can tell a live export from a crashed one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`));
  current = { proc: null, cancelled: false };
  // Write to "<name>.part" and rename at the end: a failed or cancelled export never damages a file that was already
  // there, and a finished file never appears half-written.
  const fmt = FORMATS[path.extname(plan.output).slice(1).toLowerCase()];
  const target = fmt ? plan.output + '.part' : plan.output;
  const fmtArgs = fmt ? ['-f', fmt] : [];
  const using = { name: 'CPU' };
  try {
    if (plan.mode === 'fast') await exportFast(plan, tmp, onProgress, target, fmtArgs);
    else await exportExact(plan, tmp, onProgress, target, fmtArgs, using);
    if (target !== plan.output) fs.renameSync(target, plan.output);
    onProgress({ percent: 100, speed: '' });
    return { using: plan.mode === 'fast' ? 'copy' : using.name };
  } catch (e) {
    if (target !== plan.output) { try { fs.rmSync(target, { force: true }); } catch { /* ignore */ } }
    throw e;
  } finally {
    current = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cancelExport() {
  if (!current) return;
  current.cancelled = true;
  if (current.proc) current.proc.kill();
}

function isExporting() { return !!current; }

function isRunning(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Remove temp folders left behind by a FrameSeam that was killed mid-export (never those of one still running).
function cleanupTemp() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const m = /^frameseam-(\d+)-/.exec(name);
      if (!m || isRunning(Number(m[1]))) continue;
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

module.exports = { checkToolchain, probe, detectEncoders, exportVideo, cancelExport, isExporting, cleanupTemp, targetFor };
