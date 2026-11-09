'use strict';
// End-to-end test, run with `npm test`:
//   1. generates small synthetic videos with ffmpeg (60 fps, 10-bit HEVC with HDR tags, rotated portrait, silent 23.976 fps)
//   2. starts the real app and drives it through an edit plus every export path (test/ui.js)
//   3. checks the exported files with ffprobe: right size, frame rate, codec and an exact frame count.
// Hardware encoders are exercised only if the machine has them; the CPU paths always run.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const MEDIA = path.join(TMP, 'media');
const exe = n => n + (process.platform === 'win32' ? '.exe' : '');
const bundled = n => path.join(ROOT, 'tools', 'ffmpeg', exe(n));
const FFMPEG = fs.existsSync(bundled('ffmpeg')) ? bundled('ffmpeg') : 'ffmpeg';
const FFPROBE = fs.existsSync(bundled('ffprobe')) ? bundled('ffprobe') : 'ffprobe';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', exe('electron'));

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function ffmpeg(args) { execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }); }
function probe(file) {
  const j = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  const v = j.streams[0];
  const [n, d] = v.r_frame_rate.split('/').map(Number);
  const sd = (v.side_data_list || []).find(s => s.rotation !== undefined);
  return { codec: v.codec_name, w: v.width, h: v.height, pix: v.pix_fmt, fps: n / d, frames: Number(v.nb_read_frames),
    duration: Number(j.format.duration), rotation: sd ? Number(sd.rotation) : 0 };
}

// 1. Synthetic test footage
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(MEDIA, { recursive: true });
console.log('Generating test videos...');
const m = f => path.join(MEDIA, f);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=20', '-f', 'lavfi', '-i', 'sine=f=440:d=20',
  '-c:v', 'libx264', '-g', '120', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', m('landscape60.mp4')]);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=660:d=8',
  '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-ac', '1', '-c:a', 'aac', '-shortest', m('hevc10.mp4')]);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=330:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', m('unrotated.mp4')]);
ffmpeg(['-display_rotation', '90', '-i', m('unrotated.mp4'), '-c', 'copy', m('portrait.mov')]);
fs.unlinkSync(m('unrotated.mp4'));
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24000/1001:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', m('silent24.mp4')]);
// Anamorphic: 1440x1080 pixels with a 4:3 pixel aspect ratio displays as 1920x1080 (DV/HDV-style footage).
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1440x1080:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=550:d=4', '-vf', 'setsar=4/3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', m('anamorphic.mp4')]);
// Audio that starts half a second after the video (as in OBS recordings): the export must keep that offset.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=f=880:d=3.5',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', m('delayed.mp4')]);
// Matroska with an audio track half a second longer than the video: the clip must end with the last video frame.
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=660:d=4.5',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', m('tail.mkv')]);

// When does the sound start in a file? (seconds; 0 when there is no leading silence)
function soundStart(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-45dB:d=0.1', '-f', 'null', '-'], { encoding: 'utf8' });
  const first = /silence_start: (-?[\d.]+)/.exec(r.stderr), end = /silence_end: ([\d.]+)/.exec(r.stderr);
  return first && Number(first[1]) < 0.05 && end ? Number(end[1]) : 0;
}

// 2. Drive the app
console.log('Running the app...');
check(fs.existsSync(ELECTRON), `Electron binary present (${ELECTRON})`);
const run = spawnSync(ELECTRON, [ROOT], { env: { ...process.env, CLIPCUT_TEST: path.join(__dirname, 'ui.js') }, stdio: 'inherit', timeout: 10 * 60 * 1000 });
check(run.status === 0, `app exited cleanly (code ${run.status})`);
const resultFile = path.join(TMP, 'result.json');
check(fs.existsSync(resultFile), 'the harness wrote result.json');
if (!fs.existsSync(resultFile)) process.exit(1);
const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
for (const e of res.errors) console.log('       renderer error: ' + e);
check(res.errors.length === 0, 'no renderer errors');

// 3. What the app saw
const media = res.steps.media || [];
check(media.length === 7, `7 files imported (${media.length})`);
if (media.length === 7) {
  check(media[0].fps === 60 && media[1].pix === 'yuv420p10le' && media[1].bitDepth === 10 && media[2].w === 1080 && media[2].h === 1920 &&
    media[3].audio === false && media[4].w === 1920 && media[4].h === 1080 && media[4].bitDepth === 8,
    'probe: 60 fps, 10-bit HEVC, rotated portrait, silent and anamorphic files read correctly');
  check(near(media[6].dur, 4, 0.02), `probe: MKV length is the video's 4.0 s, not the 4.5 s audio tail (${media[6].dur})`);
  for (const x of media.filter(x => x.previewError)) console.log(`       no preview for ${x.name} (this PC can't decode it; export still works)`);
  check(media.every(x => x.poster || x.previewError), 'every file either got a preview thumbnail or reported "no preview"');
  check(media.filter(x => x.codec === 'h264').every(x => x.poster), 'every H.264 file got a preview thumbnail');
}
const clips = res.steps.clips || [];
check(JSON.stringify(clips.slice(0, 2)) === '[[1,0,2.5],[1,5,20]]', `split + delete removed exactly 2.5-5.0 s (${JSON.stringify(clips.slice(0, 2))})`);
// 20 s minus the 2.5 s that was deleted, plus 8 + 6 + 4 + 4 + 4 + 4 s for the other files (frame-aligned, so a hair under).
check(near(res.steps.total, 47.5, 0.1), `timeline length is 47.5 s (${res.steps.total})`);
const enc = res.steps.encoders || {};
const devices = enc.devices || [];
console.log(`       hardware encoders: ${devices.length ? devices.map(d => `${d.name} [${Object.keys(d.caps).filter(k => d.caps[k]).join(' ')}]`).join('; ') : 'none, CPU only'}`);
for (const [kind, why] of Object.entries(enc.unavailable || {})) console.log(`       no ${kind}: ${why}`);

// 4. Exported files
for (const [name, x] of Object.entries(res.exports)) {
  if (!x.ok) { check(false, `${name}: export failed: ${x.error}`); continue; }
  const p = probe(x.output);
  const f = x.first;
  if (x.mode === 'exact') {
    const expFrames = Math.round(x.expectedDuration * f.fps);
    check(p.w === f.w && p.h === f.h, `${name}: ${p.w}x${p.h} matches the first clip`);
    check(near(p.fps, f.fps, 0.01), `${name}: ${p.fps} fps matches the first clip`);
    check(p.frames === expFrames, `${name}: exactly ${expFrames} frames (got ${p.frames})`);
    check(p.codec === (f.hevc ? 'hevc' : 'h264'), `${name}: codec ${p.codec}`);
    if (f.tenBit) check(/10/.test(p.pix), `${name}: stays 10-bit (${p.pix})`);
    check(x.useGpu ? (x.using && x.using !== 'CPU') : x.using === 'CPU', `${name}: encoded on ${x.using}`);
    if (name.includes('late-audio')) {
      const t = soundStart(x.output);
      check(t > 0.4 && t < 0.65, `${name}: sound still starts 0.5 s after the picture (${t.toFixed(3)} s)`);
    }
  } else {
    check(p.w === f.streamW && p.h === f.streamH && p.codec === f.codec, `${name}: stream copied unchanged (${p.codec} ${p.w}x${p.h})`);
    check(near(p.fps, f.fps, 0.01), `${name}: ${p.fps} fps timing preserved`);
    check(p.duration >= x.expectedDuration - 0.05 && p.duration <= x.expectedDuration + 4.5,
      `${name}: duration ${p.duration.toFixed(2)} s covers the ${x.expectedDuration} s selection (keyframe-snapped)`);
  }
  console.log(`       ${name}: ${x.ms} ms`);
}
check(res.cancel && res.cancel.cancelled === true && res.cancel.fileLeftBehind === false, 'cancelling an export stops it and removes the partial file');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
