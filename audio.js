/* PaceKeeper — session audio engine.
 *
 * ARCHITECTURE NOTE (this is the whole ballgame on iOS):
 *
 * The previous design fired each coaching cue from a setInterval. iOS suspends
 * JS timers the moment the screen locks, so the coach went silent in your
 * pocket. Media *playback* is the one thing iOS keeps running in the background.
 *
 * So: JavaScript is removed from the critical path. The entire session — the
 * cadence metronome and every voice cue at its exact offset — is rendered ahead
 * of time into a continuous audio stream and simply played. Nothing needs to
 * wake up on schedule. If the phone is playing, the coach is coaching.
 *
 * The stream is built in chunks with OfflineAudioContext (which renders far
 * faster than real time) and played through two alternating <audio> elements
 * chained on 'ended', so one is always sounding and the audio session is never
 * dropped. Chunk boundaries land on exact beat multiples, so the click stays
 * metrically continuous across the seam.
 *
 * Playback position is also the clock. Date.now() drifts out of sync with what
 * you're actually hearing after a suspend; currentTime cannot.
 */
'use strict';

const CHUNK_TARGET = 360;    // seconds of audio per rendered chunk
const SR = 16000;            // speech-band; keeps a 6-minute chunk near 11 MB
const CLIP_GAP = 0.12;       // pause between clips inside one cue
const DUCK = 0.16;           // metronome gain while the coach is talking

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const dv = new DataView(new ArrayBuffer(44 + n * 2));
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class SessionAudio {
  constructor(opts) {
    this.cues = opts.cues;
    this.total = opts.total;
    this.bpm = opts.cadence;
    this.group = opts.accent ? 5 : 0;      // accent every 5th beat = the 3:2 grid
    this.clickGain = opts.clickGain;
    this.onCue = opts.onCue || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.onEnd = opts.onEnd || (() => {});

    this.buffers = new Map();
    this.chunks = [];            // {start, dur, url}
    this.idx = 0;
    this.els = [new Audio(), new Audio()];
    this.els.forEach(e => { e.preload = 'auto'; });
    this.active = 0;
    this.started = false;
    this.ended = false;
    this._cueIdx = 0;

    this._clicks = null;
    // Beat-aligned chunk length so the click never stutters at a seam.
    const beat = 60 / this.bpm;
    this.chunkLen = Math.max(beat, Math.round(CHUNK_TARGET / beat) * beat);
  }

  /* One short click waveform, synthesized once and stamped into the bed by hand.
     The obvious implementation — an OscillatorNode per beat — costs ~1050 nodes
     per chunk and took 20 seconds to render. Writing samples directly is ~100x
     faster and sounds identical. */
  _clickWaves() {
    if (this._clicks) return this._clicks;
    const make = (freq, amp, decay) => {
      const n = Math.round(0.05 * SR), w = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        w[i] = amp * Math.exp(-i / (SR * decay)) * Math.sin(2 * Math.PI * freq * i / SR);
      }
      return w;
    };
    this._clicks = { plain: make(880, 0.30, 0.005), accent: make(1350, 0.55, 0.008) };
    return this._clicks;
  }

  /* ---------------------------------------------------------------- decoding */
  async decodeClips(pack, onProgress) {
    const keys = [...new Set(this.cues.flatMap(c => c.clips))].filter(k => pack[k]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    this.ctx = ctx;
    let done = 0;
    for (const k of keys) {
      try {
        const bytes = b64ToBytes(pack[k]);
        const buf = await new Promise((res, rej) =>
          ctx.decodeAudioData(bytes.buffer.slice(0), res, rej));
        this.buffers.set(k, buf);
      } catch (e) { console.warn('decode failed', k, e); }
      onProgress(++done, keys.length);
    }
    this._layout();
  }

  /* Resolve every cue to absolute clip start times once, up front. Rendering a
     chunk then becomes a pure lookup — no scheduling logic at playback time. */
  _layout() {
    this.placed = [];
    for (const cue of this.cues) {
      let t = cue.t;
      const spans = [];
      for (const k of cue.clips) {
        const buf = this.buffers.get(k);
        if (!buf) continue;
        spans.push({ key: k, at: t, dur: buf.duration });
        t += buf.duration + CLIP_GAP;
      }
      if (spans.length) this.placed.push({ cue, spans, end: t });
    }
    this.audioTotal = Math.max(
      this.total + 8,
      this.placed.length ? this.placed[this.placed.length - 1].end + 4 : 0);
    this.chunkCount = Math.ceil(this.audioTotal / this.chunkLen);
  }

  /* ---------------------------------------------------------------- rendering */
  async _render(i) {
    const start = i * this.chunkLen;
    const dur = Math.min(this.chunkLen, this.audioTotal - start);
    if (dur <= 0) return null;

    const ctx = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
    const clickBus = ctx.createGain();
    clickBus.gain.value = this.clickGain;
    clickBus.connect(ctx.destination);

    // metronome — stamped straight into one buffer, then played as a single node
    if (this.clickGain > 0) {
      const { plain, accent } = this._clickWaves();
      const beat = 60 / this.bpm;
      const len = Math.ceil(dur * SR);
      const bed = new Float32Array(len);
      for (let n = Math.ceil(start / beat - 1e-6); n * beat < start + dur; n++) {
        const at = Math.round((n * beat - start) * SR);
        if (at < 0) continue;
        const w = (this.group > 0 && n % this.group === 0) ? accent : plain;
        const end = Math.min(w.length, len - at);
        for (let i = 0; i < end; i++) bed[at + i] += w[i];
      }
      const buf = ctx.createBuffer(1, len, SR);
      buf.copyToChannel(bed, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(clickBus);
      src.start(0);
    }

    // voice cues — including any that straddle the chunk boundary
    for (const p of this.placed) {
      if (p.end < start || p.spans[0].at > start + dur) continue;
      // duck the click across the whole spoken span
      const d0 = Math.max(0, p.spans[0].at - start);
      const d1 = Math.min(dur, p.end - start);
      if (this.clickGain > 0 && d1 > d0) {
        clickBus.gain.setValueAtTime(this.clickGain, Math.max(0, d0 - 0.25));
        clickBus.gain.linearRampToValueAtTime(this.clickGain * DUCK, d0);
        clickBus.gain.setValueAtTime(this.clickGain * DUCK, d1);
        clickBus.gain.linearRampToValueAtTime(this.clickGain, Math.min(dur, d1 + 0.4));
      }
      for (const s of p.spans) {
        if (s.at + s.dur < start || s.at > start + dur) continue;
        const buf = this.buffers.get(s.key);
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const when = Math.max(0, s.at - start);
        const offset = Math.max(0, start - s.at);
        src.connect(ctx.destination);
        src.start(when, offset);
      }
    }

    const rendered = await ctx.startRendering();
    const url = URL.createObjectURL(encodeWav(rendered.getChannelData(0), SR));
    return { start, dur, url };
  }

  async _ensure(i) {
    if (i >= this.chunkCount) return null;
    if (!this.chunks[i]) this.chunks[i] = await this._render(i);
    return this.chunks[i];
  }

  /* ---------------------------------------------------------------- playback */
  async prepare(onProgress) {
    // Only chunk 0 gates the start. Chunk 1 has a full chunk-length of runway to
    // render while you are already running, so making you wait for it is waste.
    onProgress(0, 1);
    await this._ensure(0);
    onProgress(1, 1);
  }

  async start() {
    const first = this.chunks[0];
    if (!first) throw new Error('audio not prepared');
    const el = this.els[0];
    el.src = first.url;
    this._wire();
    await el.play();
    this.started = true;
    // build the next chunk in the background now that sound is coming out
    this._ensure(1).then(c => { if (c) this.els[1].src = c.url; });
  }

  _wire() {
    this.els.forEach((el, n) => {
      el.onended = () => this._advance(n);
      // timeupdate is a playback event, so it keeps firing in the background
      // where setInterval would not. This drives the UI and cue highlighting.
      el.ontimeupdate = () => { if (n === this.active) this._pulse(); };
    });
  }

  async _advance(from) {
    if (from !== this.active) return;
    const next = this.idx + 1;
    if (next >= this.chunkCount) { this.ended = true; this.onEnd(); return; }
    this.idx = next;
    this.active = 1 - this.active;
    const el = this.els[this.active];
    const chunk = await this._ensure(next);
    if (!chunk) { this.ended = true; this.onEnd(); return; }
    if (el.src !== chunk.url) el.src = chunk.url;
    el.currentTime = 0;
    el.play().catch(e => console.warn('chunk play', e));
    // free the chunk we just finished, and pre-render the one after next
    const doneChunk = this.chunks[next - 1];
    if (doneChunk) { URL.revokeObjectURL(doneChunk.url); this.chunks[next - 1] = null; }
    this._ensure(next + 1);
  }

  _pulse() {
    const t = this.time();
    while (this._cueIdx < this.cues.length && this.cues[this._cueIdx].t <= t) {
      this.onCue(this.cues[this._cueIdx++]);
    }
    this.onProgress(t);
  }

  /* Playback position is the clock — immune to timer suspension and always in
     sync with what you are actually hearing. */
  time() {
    const el = this.els[this.active];
    return this.idx * this.chunkLen + (el && isFinite(el.currentTime) ? el.currentTime : 0);
  }

  pause() { this.els.forEach(e => { try { e.pause(); } catch (x) {} }); }
  resume() { const el = this.els[this.active]; return el.play().catch(() => {}); }

  stop() {
    this.els.forEach(e => {
      try { e.onended = null; e.ontimeupdate = null; e.pause(); e.removeAttribute('src'); e.load(); } catch (x) {}
    });
    this.chunks.forEach(c => c && URL.revokeObjectURL(c.url));
    this.chunks = [];
    if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (x) {} }
  }
}

/* ------------------------------------------------------------------- music
 * iOS gives web pages no way to duck another app, so Apple Music will always be
 * interrupted. The only way to have music AND a coach is to play the music
 * ourselves, where the gain is ours to automate. Files stay on the device; the
 * picker hands us local Blobs and nothing is uploaded anywhere.
 */
class MusicDeck {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.tracks = [];
    this.i = 0;
    this.vol = 0.7;
    this.el.onended = () => this.next();
  }
  load(files) {
    this.tracks.forEach(u => URL.revokeObjectURL(u));
    this.tracks = [...files].map(f => URL.createObjectURL(f));
    this.i = 0;
    return this.tracks.length;
  }
  async play() {
    if (!this.tracks.length) return;
    this.el.src = this.tracks[this.i];
    this.el.volume = this.vol;
    try { await this.el.play(); } catch (e) { console.warn('music', e); }
  }
  next() {
    if (!this.tracks.length) return;
    this.i = (this.i + 1) % this.tracks.length;
    this.el.src = this.tracks[this.i];
    this.el.play().catch(() => {});
  }
  duck(on) {
    // short ramp rather than a hard cut, so it sounds like a broadcast duck
    const target = on ? this.vol * 0.18 : this.vol;
    const step = (target - this.el.volume) / 8;
    let n = 0;
    clearInterval(this._ramp);
    this._ramp = setInterval(() => {
      this.el.volume = Math.max(0, Math.min(1, this.el.volume + step));
      if (++n >= 8) { this.el.volume = target; clearInterval(this._ramp); }
    }, 25);
  }
  setVolume(v) { this.vol = v; this.el.volume = v; }
  pause() { try { this.el.pause(); } catch (e) {} }
  resume() { if (this.tracks.length) this.el.play().catch(() => {}); }
  stop() {
    try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); } catch (e) {}
    this.tracks.forEach(u => URL.revokeObjectURL(u));
    this.tracks = [];
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { SessionAudio, MusicDeck, encodeWav };
else { window.SessionAudio = SessionAudio; window.MusicDeck = MusicDeck; }
