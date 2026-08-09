/* PaceKeeper — runtime. Audio engine, run loop, UI wiring. */
'use strict';

const $ = id => document.getElementById(id) || $missing(id);
// A half-updated cache can pair an old index.html with a new app.js. Rather than
// throwing on the first missing node and killing the app, hand back an inert stub.
function $missing(id) {
  console.warn('missing element:', id);
  return { textContent: '', value: '', checked: false, style: {},
           classList: { toggle(){}, add(){}, remove(){} },
           addEventListener(){}, removeAttribute(){}, setAttribute(){} };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtClock = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
};
const fmtPace = s => {
  if (!isFinite(s) || s <= 0) return '--:--';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/* ------------------------------------------------------------------ audio bed
   The cadence metronome is generated in-browser as a WAV blob rather than
   shipped as a file: MP3 has encoder padding, so a looped MP3 ticks with a gap
   at the loop point. A WAV in a looping <audio> element is sample-exact, and
   it's the continuously-playing media element that keeps iOS from suspending
   the page in your pocket. */
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = clamp(samples[i], -1, 1);
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Pausing is not enough: iOS only hands the audio session back to Apple Music
// when the media element is actually torn down. Without this, your music stays
// dead after the app stops talking.
function releaseBed() {
  try {
    bedEl.pause();
    bedEl.removeAttribute('src');
    bedEl.load();
  } catch (e) {}
}

function makeBed(bpm, group) {
  const sr = 22050;
  // whole number of accent groups so the loop point lands on a downbeat
  const g = group || 1;
  const beats = g * Math.max(1, Math.round(24 * bpm / 60 / g));
  const N = Math.round(beats * 60 / bpm * sr);
  const data = new Float32Array(N);
  for (let b = 0; b < beats; b++) {
    const accent = group > 0 && b % g === 0;
    const f = accent ? 1350 : 880;
    const amp = accent ? 0.55 : 0.30;
    const decay = accent ? 0.008 : 0.005;
    const start = Math.round(b * 60 / bpm * sr);
    const len = Math.round(0.035 * sr);
    for (let i = 0; i < len && start + i < N; i++) {
      data[start + i] += amp * Math.exp(-i / (sr * decay)) * Math.sin(2 * Math.PI * f * i / sr);
    }
  }
  return URL.createObjectURL(encodeWav(data, sr));
}

/* ------------------------------------------------------------------ app state */
const S = {
  mode: 'pocket', distance: 15, pace: 600, structure: 'coached',
  cadence: 175, accent: true, bedVol: 0.5, bedOn: true,
  running: false, paused: false,
  t0: 0, pausedAt: 0, pausedMs: 0,
  timeline: null, idx: 0,
  clipUrls: new Map(), bedUrl: null,
  wakeLock: null, geoId: null,
  gps: { pts: [], dist: 0, ok: false },
  splits: [], lastCue: '—',
};

/* ---------------------------------------------------------------- clip loader */
// Clips come from the inlined voice pack (voices.js). Decoding to real Blob
// URLs rather than handing data: URLs straight to <audio> — iOS is far happier
// seeking and chaining blob-backed media, especially with the screen locked.
function b64ToBlob(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: 'audio/mpeg' });
}

async function preload(keys, onProgress) {
  const uniq = [...new Set(keys)];
  let done = 0;
  for (const k of uniq) {
    if (!S.clipUrls.has(k)) {
      try {
        const pack = window.PK_VOICES;
        if (pack && pack[k]) {
          S.clipUrls.set(k, URL.createObjectURL(b64ToBlob(pack[k])));
        } else {
          const r = await fetch('audio/' + k + '.mp3');   // fallback for dev
          if (!r.ok) throw new Error(r.status);
          S.clipUrls.set(k, URL.createObjectURL(await r.blob()));
        }
      } catch (e) { console.warn('clip failed', k, e); }
    }
    if (++done % 12 === 0) await new Promise(r => setTimeout(r, 0));  // keep UI alive
    onProgress(done, uniq.length);
  }
}

/* --------------------------------------------------------------- voice output */
const bedEl = new Audio();
bedEl.loop = true;
bedEl.preload = 'auto';
const voiceEl = new Audio();
voiceEl.preload = 'auto';
let vQueue = [];

voiceEl.addEventListener('ended', playNextClip);
voiceEl.addEventListener('error', playNextClip);

function playNextClip() {
  if (!vQueue.length) { if (S.bedOn) bedEl.volume = S.bedVol; return; }
  const url = vQueue.shift();
  if (!url) return playNextClip();
  voiceEl.src = url;
  voiceEl.play().catch(playNextClip);
}

function speakClips(keys) {
  const urls = keys.map(k => S.clipUrls.get(k)).filter(Boolean);
  if (!urls.length) return;
  if (S.bedOn) bedEl.volume = S.bedVol * 0.18;   // duck the click under the voice
  vQueue = urls;
  try { voiceEl.pause(); } catch (e) {}
  playNextClip();
}

function speakLive(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02; u.pitch = 0.95; u.volume = 1;
  if (S.bedOn) {
    bedEl.volume = S.bedVol * 0.18;
    u.onend = () => { bedEl.volume = S.bedVol; };
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ------------------------------------------------------------------- geo (coach) */
function haversine(a, b) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function startGeo() {
  if (!navigator.geolocation) return;
  S.geoId = navigator.geolocation.watchPosition(pos => {
    const acc = pos.coords.accuracy;
    if (acc > 30) return;                       // junk fix, ignore
    const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: pos.timestamp / 1000 };
    const last = S.gps.pts[S.gps.pts.length - 1];
    if (last) {
      const d = haversine(last, p);
      if (d > 0.0006 && d < 0.05) S.gps.dist += d;   // reject GPS jitter and jumps
    }
    S.gps.pts.push(p);
    S.gps.ok = true;
    if (S.gps.pts.length > 400) S.gps.pts.splice(0, 200);
  }, err => console.warn('geo', err), { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}

// rolling 30-second pace, because instantaneous GPS pace is unusably noisy
function rollingPace() {
  const pts = S.gps.pts;
  if (pts.length < 4) return NaN;
  const now = pts[pts.length - 1].t;
  let i = pts.length - 1, d = 0;
  while (i > 0 && now - pts[i - 1].t < 30) { d += haversine(pts[i - 1], pts[i]); i--; }
  const dt = now - pts[i].t;
  if (d < 0.004 || dt < 8) return NaN;
  return dt / d;
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && S.running && S.mode === 'coach') {
          try { S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
        }
      });
    }
  } catch (e) { console.warn('wakelock', e); }
}

/* ------------------------------------------------------------------- run loop */
function elapsed() {
  if (!S.running) return 0;
  const base = S.paused ? S.pausedAt : Date.now();
  return (base - S.t0 - S.pausedMs) / 1000;
}

function plannedMile(el) {
  const cum = S.timeline.cum;
  for (let m = 1; m < cum.length; m++) if (el < cum[m]) return m - 1 + (el - cum[m - 1]) / S.timeline.plan.miles[m - 1];
  return S.timeline.plan.miles.length;
}

function tick() {
  if (!S.running || S.paused) return;
  const el = elapsed();

  // Fire every cue that has come due. If iOS suspended us in a pocket, several
  // may be due at once — rather than machine-gunning stale cues, play the one
  // that matters most. Highest priority wins; ties go to the most recent, so a
  // mile split or block transition never loses its slot to an encouragement.
  let fire = null;
  while (S.idx < S.timeline.cues.length && S.timeline.cues[S.idx].t <= el) {
    const c = S.timeline.cues[S.idx++];
    if (el - c.t >= 40) continue;                       // too stale to be useful
    if (!fire || c.pri > fire.pri || (c.pri === fire.pri && c.t >= fire.t)) fire = c;
  }
  if (fire) {
    S.lastCue = fire.text;
    if (S.mode === 'pocket') speakClips(fire.clips);
    else speakLive(coachText(fire, el));
  }

  render(el);
  if (el > S.timeline.total + 90) finish();
}

// Coach mode can say real numbers, so it gets richer text than the clip bank.
function coachText(cue, el) {
  if (cue.kind === 'split' && cue.clips[0].startsWith('mile_')) {
    const m = parseInt(cue.clips[0].split('_')[1], 10);
    const sp = S.splits[m - 1];
    let t = 'Mile ' + m + '.';
    if (sp) t += ' Split ' + fmtPace(sp.split) + '.';
    const drift = driftSeconds(el);
    if (isFinite(drift) && Math.abs(drift) > 8) {
      t += drift > 0 ? ' You are ' + Math.round(drift) + ' seconds behind plan. Lift it slightly.'
                     : ' You are ' + Math.round(-drift) + ' seconds ahead. Ease off, that is banked.';
    } else t += ' Right on plan.';
    return t;
  }
  return cue.text;
}

function driftSeconds(el) {
  if (!S.gps.ok || S.gps.dist < 0.2) return NaN;
  const cum = S.timeline.cum, miles = S.timeline.plan.miles;
  const d = S.gps.dist;
  let planned = 0, rem = d;
  for (let i = 0; i < miles.length && rem > 0; i++) { planned += miles[i] * Math.min(1, rem); rem -= 1; }
  return el - planned;   // positive = behind plan
}

/* ---------------------------------------------------------------------- render */
function render(el) {
  const T = S.timeline;
  $('rTime').textContent = fmtClock(el);
  const pm = plannedMile(el);
  const useGps = S.mode === 'coach' && S.gps.ok && S.gps.dist > 0.05;
  const dist = useGps ? S.gps.dist : pm;
  $('rDist').textContent = dist.toFixed(2);
  $('rDistLabel').textContent = useGps ? 'miles (GPS)' : 'miles (on plan)';

  const mi = clamp(Math.floor(pm), 0, T.plan.miles.length - 1);
  $('rTarget').textContent = fmtPace(T.plan.miles[mi]);
  const block = mi < T.plan.warm ? 'WARM UP'
              : (T.plan.fin > 0 && mi >= T.plan.miles.length - T.plan.fin ? 'FINISH' : 'GOAL PACE');
  $('rBlock').textContent = block;
  $('rBreath').textContent = mi < T.plan.warm ? '3:3' : (block === 'FINISH' ? '2:1' : '3:2');

  // Pocket mode has no GPS, so "actual pace" would sit at --:-- for 2.5 hours.
  // Show time remaining there instead — the number you actually want mid-run.
  if (S.mode === 'coach') {
    $('rActual').textContent = fmtPace(rollingPace());
    $('rActualK').textContent = 'actual pace';
  } else {
    $('rActual').textContent = fmtClock(Math.max(0, T.total - el));
    $('rActualK').textContent = 'remaining';
  }
  $('rCad').textContent = S.cadence;

  const drift = driftSeconds(el);
  const chip = $('rStatus');
  if (S.mode !== 'coach' || !isFinite(drift)) {
    chip.textContent = 'ON PLAN'; chip.className = 'chip neutral';
  } else if (Math.abs(drift) <= 10) {
    chip.textContent = 'ON PACE'; chip.className = 'chip good';
  } else if (drift > 0) {
    chip.textContent = Math.round(drift) + 's BEHIND'; chip.className = 'chip warn';
  } else {
    chip.textContent = Math.round(-drift) + 's HOT'; chip.className = 'chip hot';
  }

  $('rCue').textContent = S.lastCue;
  const pct = clamp(el / T.total * 100, 0, 100);
  $('rBar').style.width = pct + '%';
  const nx = S.timeline.cues[S.idx];
  $('rNext').textContent = nx ? 'next cue in ' + fmtClock(Math.max(0, nx.t - el)) : 'finishing';
}

/* ----------------------------------------------------------------- transitions */
function tlKeys(tl) { return tl.cues.flatMap(c => c.clips); }

async function start() {
  const d = parseFloat($('fDist').value) || 15;
  const pmin = parseInt($('fPaceMin').value, 10) || 10;
  const psec = parseInt($('fPaceSec').value, 10) || 0;
  S.distance = clamp(d, 0.5, 40);
  S.pace = clamp(pmin * 60 + psec, 300, 840);
  S.structure = $('fStruct').value;
  S.mode = $('fMode').value;
  S.cadence = parseInt($('fCadence').value, 10) || 175;
  S.accent = $('fAccent').checked;
  S.bedVol = parseInt($('fBedVol').value, 10) / 100;
  // Pocket mode needs the bed — it's the continuously-playing element that keeps
  // iOS from suspending us. Coach mode must NOT hold the audio session, or Apple
  // Music gets interrupted and never resumes.
  S.bedOn = S.mode === 'pocket' || ($('fClickCoach').checked && S.bedVol > 0);

  S.timeline = Engine.buildTimeline(S.distance, S.pace, S.structure);
  S.idx = 0; S.splits = []; S.lastCue = 'Getting started…';
  S.gps = { pts: [], dist: 0, ok: false };

  show('loading');
  // iOS requires audio to be kicked off inside the tap that started it
  if (S.bedOn) {
    bedEl.src = S.bedUrl = makeBed(S.cadence, S.accent ? 5 : 0);
    bedEl.volume = 0;
    try { await bedEl.play(); } catch (e) { console.warn('bed play', e); }
  } else {
    releaseBed();
  }
  // Prime the voice element inside the tap. Decode synchronously from the pack —
  // an await here can cost us the iOS user-activation window, and without that
  // priming the first cue of the run is silent.
  if (!S.clipUrls.has('s_start') && window.PK_VOICES && window.PK_VOICES['s_start']) {
    S.clipUrls.set('s_start', URL.createObjectURL(b64ToBlob(window.PK_VOICES['s_start'])));
  }
  const primer = S.clipUrls.get('s_start');
  if (primer) { try { voiceEl.src = primer; await voiceEl.play(); voiceEl.pause(); } catch (e) {} }
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }

  if (S.mode === 'pocket') {
    await preload(tlKeys(S.timeline), (a, b) => {
      $('loadBar').style.width = (a / b * 100) + '%';
      $('loadTxt').textContent = 'Loading coach audio  ' + a + ' / ' + b;
    });
  } else {
    await acquireWakeLock();
    startGeo();
  }

  if (S.bedOn) bedEl.volume = S.bedVol;
  S.t0 = Date.now(); S.pausedMs = 0; S.paused = false; S.running = true;
  show('run');
  render(0);
  setInterval(tick, window.__PK_TICK || 500);
}

function togglePause() {
  if (!S.running) return;
  if (S.paused) {
    S.pausedMs += Date.now() - S.pausedAt;
    S.paused = false;
    if (S.bedOn) bedEl.play().catch(() => {});
    $('bPause').textContent = 'Pause';
    if (S.mode === 'pocket') speakClips(['s_resumed']); else speakLive('Resuming.');
  } else {
    S.pausedAt = Date.now();
    S.paused = true;
    if (S.bedOn) bedEl.pause();
    $('bPause').textContent = 'Resume';
  }
}

function tapSplit() {
  const el = elapsed();
  const prev = S.splits.length ? S.splits[S.splits.length - 1].at : 0;
  S.splits.push({ at: el, split: el - prev });
  const n = S.splits.length;
  if (S.mode === 'coach') {
    speakLive('Manual split. Mile ' + n + '. ' + fmtPace(el - prev) + '.');
  } else {
    speakClips(['mile_' + Math.min(n, 40)]);
  }
  S.lastCue = 'Manual split at mile ' + n + ' — ' + fmtPace(el - prev);
}

function finish() {
  S.running = false;
  releaseBed();
  try { speechSynthesis.cancel(); } catch (e) {}
  if (S.geoId != null) navigator.geolocation.clearWatch(S.geoId);
  if (S.wakeLock) { try { S.wakeLock.release(); } catch (e) {} S.wakeLock = null; }
  const el = elapsed();
  const dist = S.mode === 'coach' && S.gps.ok && S.gps.dist > 0.05 ? S.gps.dist : S.distance;
  $('sumTime').textContent = fmtClock(el);
  $('sumDist').textContent = dist.toFixed(2) + ' mi';
  $('sumPace').textContent = fmtPace(el / Math.max(0.01, dist)) + ' /mi';
  $('sumPlan').textContent = fmtClock(S.timeline.total) + ' planned';
  show('summary');
  try {
    const log = JSON.parse(localStorage.getItem('pk_log') || '[]');
    log.unshift({ d: new Date().toISOString(), dist, time: el, pace: el / Math.max(0.01, dist), mode: S.mode });
    localStorage.setItem('pk_log', JSON.stringify(log.slice(0, 60)));
  } catch (e) {}
}

function show(screen) {
  ['setup', 'loading', 'run', 'summary'].forEach(s => $('sc-' + s).classList.toggle('on', s === screen));
}

/* --------------------------------------------------------------------- preview */
function updatePreview() {
  const d = clamp(parseFloat($('fDist').value) || 15, 0.5, 40);
  const p = clamp((parseInt($('fPaceMin').value, 10) || 10) * 60 + (parseInt($('fPaceSec').value, 10) || 0), 300, 840);
  const tl = Engine.buildTimeline(d, p, $('fStruct').value);
  $('pvTime').textContent = fmtClock(tl.total);
  $('pvCues').textContent = tl.cues.length + ' cues · talks every ~' + Math.round(tl.total / tl.cues.length) + 's';
  const m = tl.plan.miles;
  $('pvPlan').textContent = tl.plan.warm
    ? `warm up ${fmtPace(m[0])}–${fmtPace(m[tl.plan.warm - 1])} · goal ${fmtPace(p)} · close ${fmtPace(m[m.length - 1])}`
    : `flat ${fmtPace(p)} the whole way`;
  const coachMode = $('fMode').value === 'coach';
  $('modeNote').textContent = coachMode
    ? 'Screen stays on (armband). Apple Music keeps playing, live voice on top, GPS pace. Music dips for each cue, then comes back.'
    : 'Screen can go off, phone in a pocket. Coach audio + cadence click only — this replaces Apple Music.';
  $('clickCoachWrap').style.display = coachMode ? 'flex' : 'none';
  $('cadenceNote').textContent = coachMode && !$('fClickCoach').checked
    ? 'Click is off in Coach mode so your music keeps playing. Cadence still shows on screen as a target — 3 steps in, 2 steps out against 175.'
    : 'Three steps in, two steps out. The odd count means your exhale lands on alternating feet instead of hammering the same side every stride — that\u2019s the single best injury-prevention lever in a long run.';
}

/* ------------------------------------------------------------------------ init */
function boot() {
  ['fDist', 'fPaceMin', 'fPaceSec', 'fStruct', 'fMode'].forEach(id =>
    $(id).addEventListener('input', updatePreview));
  $('fCadence').addEventListener('input', () => $('cadVal').textContent = $('fCadence').value + ' spm');
  $('fBedVol').addEventListener('input', () => {
    $('volVal').textContent = $('fBedVol').value + '%';
    S.bedVol = parseInt($('fBedVol').value, 10) / 100;
    if (S.running) bedEl.volume = S.bedVol;
  });
  $('fClickCoach').addEventListener('change', updatePreview);
  $('bStart').addEventListener('click', start);
  $('bPause').addEventListener('click', togglePause);
  $('bSplit').addEventListener('click', tapSplit);
  $('bStop').addEventListener('click', finish);
  $('bAgain').addEventListener('click', () => show('setup'));
  $('bTest').addEventListener('click', async () => {
    const coachMode = $('fMode').value === 'coach';
    const wantBed = !coachMode || ($('fClickCoach').checked && parseInt($('fBedVol').value, 10) > 0);
    S.bedOn = wantBed;
    if (coachMode && !wantBed) {
      // Test exactly what a run will sound like: system voice only, no audio
      // session held, so your music ducks and then comes straight back.
      speakLive('Mile eight. You are right on plan. Three steps in, two steps out.');
      return;
    }
    await preload(['b_32_a', 'mile_8'], () => {});
    bedEl.src = makeBed(parseInt($('fCadence').value, 10), $('fAccent').checked ? 5 : 0);
    bedEl.volume = parseInt($('fBedVol').value, 10) / 100;
    bedEl.play().catch(() => {});
    setTimeout(() => speakClips(['mile_8', 'b_32_a']), 1200);
    setTimeout(releaseBed, 12000);          // release, don't just pause
  });
  updatePreview();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    boot();
  } catch (e) {
    // Last resort: show the problem instead of a dead screen, and give a way out.
    console.error('boot failed', e);
    document.body.innerHTML =
      '<div style="padding:32px;font:16px -apple-system,sans-serif;color:#f2f5f8">' +
      '<h2 style="color:#ff8a3d">Update problem</h2>' +
      '<p>The app files are out of sync — usually a half-finished cache update.</p>' +
      '<p><button id="pkReset" style="width:100%;padding:18px;border:none;border-radius:14px;' +
      'background:#ff8a3d;color:#12161a;font-weight:800;font-size:17px">Reset and reload</button></p>' +
      '<p style="color:#8b96a3;font-size:13px">If this keeps happening, delete the home screen icon ' +
      'and add it again from Safari.</p></div>';
    document.getElementById('pkReset').onclick = async () => {
      try {
        const ks = await caches.keys();
        await Promise.all(ks.map(k => caches.delete(k)));
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch (err) {}
      location.reload(true);
    };
  }
});
