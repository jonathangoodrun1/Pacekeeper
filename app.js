/* PaceKeeper — application shell.
 *
 * Layering (kept deliberately strict so each piece stays testable on its own):
 *   engine.js  pure functions   pace plan + cue timeline, no DOM, no audio
 *   audio.js   playback         pre-rendered session stream + music deck
 *   app.js     this file        state, screens, run drivers, UI
 *
 * Two drivers implement the same tiny interface — time(), pause(), resume(),
 * stop() — so the run screen never branches on mode:
 *   PocketDriver  pre-rendered continuous stream. Survives a locked screen.
 *   CoachDriver   live speech + GPS. Adaptive, needs the screen on.
 */
'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = id => document.getElementById(id) || stub(id);
function stub(id) {
  console.warn('missing element:', id);
  return { textContent: '', value: '', checked: false, files: [], style: {},
           classList: { toggle() {}, add() {}, remove() {} },
           addEventListener() {}, removeAttribute() {}, setAttribute() {} };
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
const show = screen =>
  ['setup', 'loading', 'run', 'summary'].forEach(s =>
    $('sc-' + s).classList.toggle('on', s === screen));

/* -------------------------------------------------------------------- state */
const S = {
  mode: 'pocket', distance: 15, pace: 600, structure: 'coached',
  cadence: 175, accent: true, clickVol: 0.5, musicVol: 0.7,
  timeline: null, driver: null, music: null,
  running: false, paused: false,
  splits: [], lastCue: 'Getting started…',
};

/* ------------------------------------------------------------ pocket driver */
class PocketDriver {
  constructor(timeline) { this.tl = timeline; }

  async prepare(onProgress) {
    this.audio = new SessionAudio({
      cues: this.tl.cues, total: this.tl.total,
      cadence: S.cadence, accent: S.accent,
      clickGain: S.clickVol,
      onCue: c => {
        S.lastCue = c.text;
        if (S.music) { S.music.duck(true); setTimeout(() => S.music.duck(false), 4200); }
      },
      onProgress: t => render(t),
      onEnd: () => finish(),
    });
    await this.audio.decodeClips(window.PK_VOICES || {},
      (a, b) => onProgress('Decoding coach audio', a, b));
    await this.audio.prepare((a, b) => onProgress('Building your session', a, b));
  }

  async begin() { await this.audio.start(); if (S.music) await S.music.play(); }
  time() { return this.audio.time(); }
  pause() { this.audio.pause(); if (S.music) S.music.pause(); }
  resume() { this.audio.resume(); if (S.music) S.music.resume(); }
  stop() { this.audio.stop(); }
  livePace() { return NaN; }
  distance(t) { return plannedMile(t); }
}

/* ------------------------------------------------------------- coach driver */
class CoachDriver {
  constructor(timeline) {
    this.tl = timeline;
    this.gps = { pts: [], dist: 0, ok: false };
    this.idx = 0; this.t0 = 0; this.pausedMs = 0; this.pausedAt = 0; this.isPaused = false;
  }

  async prepare(onProgress) {
    onProgress('Getting location', 1, 2);
    await this._wakeLock();
    this._geo();
    onProgress('Ready', 2, 2);
  }

  async begin() {
    this.t0 = Date.now();
    if (S.music) await S.music.play();
    this.timer = setInterval(() => this._tick(), 500);
    this._speak('Starting now. Ease into it. Goal pace ' + fmtPace(S.pace) + ' per mile.');
  }

  time() {
    const base = this.isPaused ? this.pausedAt : Date.now();
    return (base - this.t0 - this.pausedMs) / 1000;
  }

  _tick() {
    if (this.isPaused) return;
    const t = this.time();
    let fire = null;
    while (this.idx < this.tl.cues.length && this.tl.cues[this.idx].t <= t) {
      const c = this.tl.cues[this.idx++];
      if (t - c.t >= 40) continue;
      if (!fire || c.pri > fire.pri || (c.pri === fire.pri && c.t >= fire.t)) fire = c;
    }
    if (fire) { S.lastCue = fire.text; this._speak(this._text(fire, t)); }
    render(t);
    if (t > this.tl.total + 90) finish();
  }

  // Coach mode can speak real numbers, so it says more than the clip bank can.
  _text(cue, t) {
    if (cue.kind === 'split' && cue.clips[0] && cue.clips[0].startsWith('mile_')) {
      const m = parseInt(cue.clips[0].split('_')[1], 10);
      let s = 'Mile ' + m + '.';
      const drift = this.drift(t);
      if (isFinite(drift) && Math.abs(drift) > 8) {
        s += drift > 0
          ? ' You are ' + Math.round(drift) + ' seconds behind plan. Lift it slightly.'
          : ' You are ' + Math.round(-drift) + ' seconds ahead. Ease off, that is banked.';
      } else s += ' Right on plan.';
      return s;
    }
    return cue.text;
  }

  _speak(text) {
    if (!('speechSynthesis' in window)) return;
    if (S.music) S.music.duck(true);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.pitch = 0.95;
    u.onend = () => { if (S.music) S.music.duck(false); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  async _wakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.lock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible' && S.running) {
            try { this.lock = await navigator.wakeLock.request('screen'); } catch (e) {}
          }
        });
      }
    } catch (e) { console.warn('wakelock', e); }
  }

  _geo() {
    if (!navigator.geolocation) return;
    this.watch = navigator.geolocation.watchPosition(pos => {
      if (pos.coords.accuracy > 30) return;              // junk fix
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: pos.timestamp / 1000 };
      const last = this.gps.pts[this.gps.pts.length - 1];
      if (last) {
        const d = haversine(last, p);
        if (d > 0.0006 && d < 0.05) this.gps.dist += d;  // reject jitter and jumps
      }
      this.gps.pts.push(p);
      this.gps.ok = true;
      if (this.gps.pts.length > 400) this.gps.pts.splice(0, 200);
    }, e => console.warn('geo', e), { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }

  // Raw GPS pace is unusably noisy; average over the last 30 seconds.
  livePace() {
    const pts = this.gps.pts;
    if (pts.length < 4) return NaN;
    const now = pts[pts.length - 1].t;
    let i = pts.length - 1, d = 0;
    while (i > 0 && now - pts[i - 1].t < 30) { d += haversine(pts[i - 1], pts[i]); i--; }
    const dt = now - pts[i].t;
    return (d < 0.004 || dt < 8) ? NaN : dt / d;
  }

  drift(t) {
    if (!this.gps.ok || this.gps.dist < 0.2) return NaN;
    const miles = this.tl.plan.miles;
    let planned = 0, rem = this.gps.dist;
    for (let i = 0; i < miles.length && rem > 0; i++) { planned += miles[i] * Math.min(1, rem); rem -= 1; }
    return t - planned;
  }

  distance() { return this.gps.ok && this.gps.dist > 0.05 ? this.gps.dist : plannedMile(this.time()); }
  pause() { this.pausedAt = Date.now(); this.isPaused = true; if (S.music) S.music.pause(); }
  resume() { this.pausedMs += Date.now() - this.pausedAt; this.isPaused = false; if (S.music) S.music.resume(); }
  stop() {
    clearInterval(this.timer);
    try { speechSynthesis.cancel(); } catch (e) {}
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    if (this.lock) { try { this.lock.release(); } catch (e) {} }
  }
}

function haversine(a, b) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function plannedMile(t) {
  const cum = S.timeline.cum, miles = S.timeline.plan.miles;
  for (let m = 1; m < cum.length; m++) {
    if (t < cum[m]) return m - 1 + (t - cum[m - 1]) / miles[m - 1];
  }
  return miles.length;
}

/* ------------------------------------------------------------------- render */
function render(t) {
  const T = S.timeline;
  $('rTime').textContent = fmtClock(t);

  const pm = plannedMile(t);
  const mi = clamp(Math.floor(pm), 0, T.plan.miles.length - 1);
  const dist = S.driver ? S.driver.distance(t) : pm;
  const gps = S.mode === 'coach' && S.driver && S.driver.gps && S.driver.gps.ok;
  $('rDist').textContent = dist.toFixed(2);
  $('rDistLabel').textContent = gps ? 'miles (GPS)' : 'miles (on plan)';
  $('rTarget').textContent = fmtPace(T.plan.miles[mi]);

  const inFin = T.plan.fin > 0 && mi >= T.plan.miles.length - T.plan.fin;
  const block = mi < T.plan.warm ? 'WARM UP' : (inFin ? 'FINISH' : 'GOAL PACE');
  $('rBlock').textContent = block;
  $('rBreath').textContent = mi < T.plan.warm ? '3:3' : (inFin ? '2:1' : '3:2');

  if (S.mode === 'coach') {
    $('rActual').textContent = fmtPace(S.driver ? S.driver.livePace() : NaN);
    $('rActualK').textContent = 'actual pace';
  } else {
    $('rActual').textContent = fmtClock(Math.max(0, T.total - t));
    $('rActualK').textContent = 'remaining';
  }
  $('rCad').textContent = S.cadence;

  const chip = $('rStatus');
  const drift = S.driver && S.driver.drift ? S.driver.drift(t) : NaN;
  if (!isFinite(drift))            { chip.textContent = 'ON PLAN';  chip.className = 'chip neutral'; }
  else if (Math.abs(drift) <= 10)  { chip.textContent = 'ON PACE';  chip.className = 'chip good'; }
  else if (drift > 0)              { chip.textContent = Math.round(drift) + 's BEHIND'; chip.className = 'chip warn'; }
  else                             { chip.textContent = Math.round(-drift) + 's HOT';   chip.className = 'chip hot'; }

  $('rCue').textContent = S.lastCue;
  $('rBar').style.width = clamp(t / T.total * 100, 0, 100) + '%';
  const next = T.cues.find(c => c.t > t);
  $('rNext').textContent = next ? 'next cue in ' + fmtClock(next.t - t) : 'finishing';
}

/* --------------------------------------------------------------- transitions */
function readSetup() {
  S.distance = clamp(parseFloat($('fDist').value) || 15, 0.5, 40);
  S.pace = clamp((parseInt($('fPaceMin').value, 10) || 10) * 60 +
                 (parseInt($('fPaceSec').value, 10) || 0), 300, 840);
  S.structure = $('fStruct').value;
  S.mode = $('fMode').value;
  S.cadence = parseInt($('fCadence').value, 10) || 175;
  S.accent = $('fAccent').checked;
  S.clickVol = S.mode === 'pocket' ? parseInt($('fBedVol').value, 10) / 100 : 0;
  S.musicVol = parseInt($('fMusicVol').value, 10) / 100;
}

async function start() {
  readSetup();
  S.timeline = Engine.buildTimeline(S.distance, S.pace, S.structure);
  S.splits = []; S.lastCue = 'Getting started…';

  show('loading');
  const onProgress = (label, a, b) => {
    $('loadTxt').textContent = label + '  ' + a + ' / ' + b;
    $('loadBar').style.width = (a / b * 100) + '%';
  };

  // Music, if the user picked any. Must be kicked off inside the tap on iOS.
  const files = $('fMusic').files;
  if (files && files.length) {
    S.music = new MusicDeck();
    S.music.load(files);
    S.music.setVolume(S.musicVol);
  } else {
    S.music = null;
  }

  try {
    S.driver = S.mode === 'pocket' ? new PocketDriver(S.timeline) : new CoachDriver(S.timeline);
    await S.driver.prepare(onProgress);
    await S.driver.begin();
  } catch (e) {
    console.error('start failed', e);
    $('loadTxt').textContent = 'Could not start audio — tap Start again.';
    show('setup');
    return;
  }

  S.running = true; S.paused = false;
  $('bPause').textContent = 'Pause';
  show('run');
  render(0);
  // Foreground-only heartbeat. Pocket mode does not depend on this for cues —
  // the audio stream carries them — it just keeps the display honest.
  clearInterval(S._ui);
  S._ui = setInterval(() => { if (S.running && !S.paused) render(S.driver.time()); }, 1000);
}

function togglePause() {
  if (!S.running) return;
  S.paused = !S.paused;
  S.paused ? S.driver.pause() : S.driver.resume();
  $('bPause').textContent = S.paused ? 'Resume' : 'Pause';
}

function tapSplit() {
  if (!S.running) return;
  const t = S.driver.time();
  const prev = S.splits.length ? S.splits[S.splits.length - 1].at : 0;
  S.splits.push({ at: t, split: t - prev });
  S.lastCue = 'Manual split — mile ' + S.splits.length + ' in ' + fmtPace(t - prev);
  render(t);
}

function finish() {
  if (!S.running) return;
  S.running = false;
  clearInterval(S._ui);
  const t = S.driver ? S.driver.time() : 0;
  const dist = S.driver ? S.driver.distance(t) : S.distance;
  if (S.driver) S.driver.stop();
  if (S.music) { S.music.stop(); S.music = null; }

  $('sumTime').textContent = fmtClock(t);
  $('sumDist').textContent = dist.toFixed(2) + ' mi';
  $('sumPace').textContent = fmtPace(t / Math.max(0.01, dist)) + ' /mi';
  $('sumPlan').textContent = fmtClock(S.timeline.total) + ' planned';
  show('summary');

  try {
    const log = JSON.parse(localStorage.getItem('pk_log') || '[]');
    log.unshift({ d: new Date().toISOString(), dist, time: t, mode: S.mode });
    localStorage.setItem('pk_log', JSON.stringify(log.slice(0, 60)));
  } catch (e) {}
}

/* ------------------------------------------------------------------ preview */
function updatePreview() {
  const d = clamp(parseFloat($('fDist').value) || 15, 0.5, 40);
  const p = clamp((parseInt($('fPaceMin').value, 10) || 10) * 60 +
                  (parseInt($('fPaceSec').value, 10) || 0), 300, 840);
  const tl = Engine.buildTimeline(d, p, $('fStruct').value);
  const m = tl.plan.miles;
  $('pvTime').textContent = fmtClock(tl.total);
  $('pvCues').textContent = tl.cues.length + ' cues · talks every ~' +
                            Math.round(tl.total / tl.cues.length) + 's';
  $('pvPlan').textContent = tl.plan.warm
    ? `warm up ${fmtPace(m[0])}–${fmtPace(m[tl.plan.warm - 1])} · goal ${fmtPace(p)} · close ${fmtPace(m[m.length - 1])}`
    : `flat ${fmtPace(p)} the whole way`;

  const pocket = $('fMode').value === 'pocket';
  $('modeNote').textContent = pocket
    ? 'Screen off, phone anywhere. The whole session is pre-rendered and played as one continuous track, so nothing can be suspended mid-run.'
    : 'Screen stays on (armband). Live GPS pace and real split times, and the coach adapts to how you are actually running.';
  $('clickWrap').style.display = pocket ? 'block' : 'none';

  const n = ($('fMusic').files || []).length;
  $('musicCount').textContent = n ? n + ' track' + (n > 1 ? 's' : '') + ' loaded' : 'No tracks — coach only';
}

/* --------------------------------------------------------------------- boot */
function boot() {
  ['fDist', 'fPaceMin', 'fPaceSec', 'fStruct', 'fMode'].forEach(id =>
    $(id).addEventListener('input', updatePreview));
  $('fMusic').addEventListener('change', updatePreview);
  $('fCadence').addEventListener('input', () => $('cadVal').textContent = $('fCadence').value + ' spm');
  $('fBedVol').addEventListener('input', () => $('volVal').textContent = $('fBedVol').value + '%');
  $('fMusicVol').addEventListener('input', () => {
    $('musVal').textContent = $('fMusicVol').value + '%';
    if (S.music) S.music.setVolume(parseInt($('fMusicVol').value, 10) / 100);
  });
  $('bStart').addEventListener('click', start);
  $('bPause').addEventListener('click', togglePause);
  $('bSplit').addEventListener('click', tapSplit);
  $('bStop').addEventListener('click', finish);
  $('bAgain').addEventListener('click', () => show('setup'));
  $('bTest').addEventListener('click', testAudio);
  updatePreview();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// A 12-second sample of exactly what the run will sound like, built with the
// same renderer — so if the test sounds right, the run will too.
async function testAudio() {
  readSetup();
  const btn = $('bTest');
  btn.textContent = 'Building…';
  try {
    const demo = new SessionAudio({
      cues: [{ t: 1.5, pri: 9, kind: 'demo', clips: ['mile_8', 'b_32_a'], text: 'demo' }],
      total: 13, cadence: S.cadence, accent: S.accent,
      clickGain: S.mode === 'pocket' ? S.clickVol : 0,
      onEnd: () => { demo.stop(); btn.textContent = 'Test audio (12 sec)'; },
    });
    await demo.decodeClips(window.PK_VOICES || {}, () => {});
    await demo.prepare(() => {});
    await demo.start();
    btn.textContent = 'Playing…';
    setTimeout(() => { demo.stop(); btn.textContent = 'Test audio (12 sec)'; }, 13500);
  } catch (e) {
    console.warn('test failed', e);
    btn.textContent = 'Test audio (12 sec)';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try { boot(); } catch (e) {
    console.error('boot failed', e);
    document.body.innerHTML =
      '<div style="padding:32px;font:16px -apple-system,sans-serif;color:#f2f5f8">' +
      '<h2 style="color:#ff8a3d">Update problem</h2>' +
      '<p>The app files are out of sync — usually a half-finished cache update.</p>' +
      '<button id="pkReset" style="width:100%;padding:18px;border:none;border-radius:14px;' +
      'background:#ff8a3d;color:#12161a;font-weight:800;font-size:17px">Reset and reload</button></div>';
    document.getElementById('pkReset').onclick = async () => {
      try {
        await Promise.all((await caches.keys()).map(k => caches.delete(k)));
        await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
      } catch (err) {}
      location.reload(true);
    };
  }
});
