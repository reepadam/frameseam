'use strict';
// Drives the real ClipCut window through a scripted edit-and-export session. Loaded by src/main.js when the
// CLIPCUT_TEST environment variable points at this file; test/run.js sets that up and checks the results.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP = path.join(__dirname, '.tmp');
const MEDIA = path.join(TMP, 'media').split(path.sep).join('/') + '/';
const FILES = ['landscape60.mp4', 'hevc10.mp4', 'portrait.mov', 'silent24.mp4', 'anamorphic.mp4', 'delayed.mp4', 'tail.mkv'];

module.exports = (win, ctl) => {
  const result = { steps: {}, exports: {}, errors: [] };
  win.webContents.on('console-message', e => { if (e.level === 'error') result.errors.push(e.message); });

  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code, true);
    try {
      await sleep(800);
      await js(`importPaths(${JSON.stringify(FILES.map(f => MEDIA + f))})`);
      // Posters come from Chromium decoding each file in turn; give a slow PC up to 30 s, and accept "no preview" (a
      // format this PC can't decode) as a settled state too.
      for (let i = 0; i < 60; i++) {
        if (await js(`state.media.length === ${FILES.length} && state.media.every(m => m.poster || m.previewError)`)) break;
        await sleep(500);
      }
      result.steps.media = await js(`state.media.map(m => ({ name: m.name, codec: m.info.vcodec, pix: m.info.pixFmt, bitDepth: m.info.bitDepth, fps: m.info.fps,
        w: m.info.displayWidth, h: m.info.displayHeight, dur: m.info.duration, audio: m.info.hasAudio, poster: !!m.poster, previewError: m.previewError }))`);
      const enc = await js('api.encoders()');
      result.steps.encoders = enc;

      // Edit like a user would: cut 2.5-5.0 s out of the 60 fps clip with split + delete, then append the other files.
      await js('addClips([state.media[0]])');
      await js('seek(2.5); split(); seek(5); split(); state.selected = state.clips[1].id; deleteSelected()');
      await js('addClips([state.media[1], state.media[2], state.media[3], state.media[4], state.media[5], state.media[6]])');
      await sleep(500);
      result.steps.clips = await js('state.clips.map(c => [c.mediaId, c.in, c.out])');
      result.steps.total = await js('totalDuration()');

      // b === 'end' means the clip's full frame-aligned length as probed, which is what addClips uses.
      const seg = (i, a, b) => js(`(() => { const m = state.media[${i}]; return { path: m.path, in: ${a}, out: ${b === 'end' ? 'm.info.duration' : b}, info: m.info }; })()`);
      const s60a = await seg(0, 2.5, 5), s60b = await seg(0, 10, 12), sH = await seg(1, 1, 3), sP = await seg(2, 0, 2), sS = await seg(3, 0, 1.5), sA = await seg(4, 1, 3);
      const sD = await seg(5, 0, 2), sT = await seg(6, 0, 'end');
      const plans = {
        'exact-cpu-h264': { mode: 'exact', quality: 'high', useGpu: false, segments: [s60a, s60b, sS] },
        'exact-cpu-portrait': { mode: 'exact', quality: 'high', useGpu: false, segments: [sP] },
        'exact-cpu-anamorphic': { mode: 'exact', quality: 'high', useGpu: false, segments: [sA, sS] },
        'exact-cpu-late-audio': { mode: 'exact', quality: 'high', useGpu: false, segments: [sD] },
        'exact-cpu-mkv-tail': { mode: 'exact', quality: 'high', useGpu: false, segments: [sT, sS] },
        'exact-cpu-hevc10-mixed': { mode: 'exact', quality: 'small', useGpu: false, segments: [sH, sP] },
        'fast-copy': { mode: 'fast', segments: [s60a, s60b] },
        'fast-copy-mkv': { mode: 'fast', segments: [sP] },
      };
      for (const d of enc.devices || []) {
        const caps = d.caps || {};
        const gpu = { useGpu: true, device: d.id, gpu: d.kind, gpuIndex: d.index };
        if (caps.h264) plans[`exact-${d.id}-h264`] = { mode: 'exact', quality: 'high', ...gpu, segments: [s60a, s60b] };
        if (caps.hevc10) plans[`exact-${d.id}-hevc10-mixed`] = { mode: 'exact', quality: 'high', ...gpu, segments: [sH, sP, s60a] };
      }
      for (const [name, plan] of Object.entries(plans)) {
        plan.output = `${MEDIA}out_${name.replace(/[^a-z0-9-]/gi, '_')}.${name.endsWith('mkv') ? 'mkv' : 'mp4'}`;
        const first = plan.segments[0].info;
        const t0 = Date.now();
        const r = await js(`api.exportStart(${JSON.stringify(plan)})`);
        result.exports[name] = {
          ...r, mode: plan.mode, useGpu: !!plan.useGpu, output: plan.output, ms: Date.now() - t0,
          expectedDuration: plan.segments.reduce((a, s) => a + (s.out - s.in), 0),
          first: { w: first.displayWidth, h: first.displayHeight, streamW: first.width, streamH: first.height, fps: first.fps,
            codec: first.vcodec, tenBit: /10|12/.test(first.pixFmt), hevc: first.vcodec === 'hevc' || /10|12/.test(first.pixFmt) },
        };
      }

      // Cancelling: start a long CPU export, cancel it right away; it must stop and leave no partial file behind.
      const cancelOut = MEDIA + 'out_cancelled.mp4';
      const pending = js(`api.exportStart(${JSON.stringify({ mode: 'exact', quality: 'best', useGpu: false, output: cancelOut, segments: [await seg(0, 0, 20)] })})`);
      await sleep(1500);
      await js('api.exportCancel()');
      const cr = await pending;
      result.cancel = { ...cr, fileLeftBehind: fs.existsSync(cancelOut) || fs.existsSync(cancelOut + '.part') };

      await js('seek(1.2)');
      await sleep(600);
      fs.writeFileSync(path.join(TMP, 'screenshot.png'), (await win.webContents.capturePage()).toPNG());
    } catch (e) {
      result.errors.push('harness: ' + (e.stack || e));
    }
    fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify(result, null, 2));
    ctl.setDirty(false);
    app.quit();
  });
};
