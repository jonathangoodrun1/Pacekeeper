/* PaceKeeper — coaching engine.
   Pure functions: pace plan + cue timeline. No DOM, no audio. Testable in node.

   Scheduling note: coaching cues are placed in slots *within each mile block*,
   not on a wall-clock grid. A fixed 10-minute grid collides with every mile
   split when you're running 10:00 pace, which silently eats the breathing and
   block-transition cues. Per-mile slots stay clear of the splits at any pace. */

(function (root) {
  'use strict';

  // ---------------------------------------------------------------- pace plan
  function buildPlan(distance, goalPace, structure) {
    const n = Math.max(1, Math.ceil(distance));
    const miles = [];
    if (structure === 'flat' || n < 3) {
      for (let i = 0; i < n; i++) miles.push(goalPace);
      return { miles, warm: 0, fin: 0 };
    }
    const warm = distance >= 8 ? 2 : 1;
    const fin  = distance >= 8 ? 3 : 1;
    const back = [10, 15, 20];
    for (let i = 0; i < n; i++) {
      if (i < warm)              miles.push(goalPace + (warm === 2 ? (i === 0 ? 45 : 25) : 30));
      else if (i >= n - fin)     miles.push(goalPace - (back[i - (n - fin)] || 15));
      else                       miles.push(goalPace);
    }
    return { miles, warm, fin };
  }

  function cumulative(plan) {
    const cum = [0];
    for (let i = 0; i < plan.miles.length; i++) cum.push(cum[i] + plan.miles[i]);
    return cum;
  }

  // Snap to the 5-second grid the pace clips were rendered on (5:00–14:00).
  function paceClip(sec) {
    return 'pace_' + Math.max(300, Math.min(840, Math.round(sec / 5) * 5));
  }

  const PRI = { split: 10, structure: 9, fuel: 7, breath: 6, form: 5, cheer: 3 };
  const rot = (list, i) => list[((i % list.length) + list.length) % list.length];

  const B32  = ['b_32_a','b_32_b','b_32_c','b_32_d','b_32_e','b_32_f'];
  const B33  = ['b_33_a','b_33_b'];
  const B21  = ['b_21_a','b_21_b'];
  const FORM = ['f_a','f_b','f_c','f_d','f_e','f_f','f_g','f_h','f_i'];
  const FUEL = ['u_fuel_a','u_fuel_b','u_fuel_c'];
  const HYD  = ['u_hydr_a','u_hydr_b'];
  const EARLY= ['e_a','e_b','e_c','e_d','e_e'];
  const GRIND= ['g_a','g_b','g_c','g_d','g_e','g_f','g_g','g_h','g_i'];
  const CHK  = ['p_hold','p_hot','p_cold'];

  // ------------------------------------------------------------- cue timeline
  function buildTimeline(distance, goalPace, structure, opts) {
    opts = opts || {};
    const MIN_GAP = opts.minGap || 20;
    const plan = buildPlan(distance, goalPace, structure);
    const cum  = cumulative(plan);
    const n    = plan.miles.length;
    const total = cum[n];
    const cues = [];
    const add = (t, pri, kind, clips, text) => {
      if (t < 0 || t > total + 60) return;
      cues.push({ t: Math.round(t), pri, kind, clips, text });
    };

    // --- opening -----------------------------------------------------------
    add(0,  PRI.structure, 'structure', ['s_start', paceClip(plan.miles[0])],
        'Starting now. Ease into it.');
    if (plan.warm > 0) {
      add(26, PRI.structure, 'structure', ['s_warmnote'],
          'These first miles are deliberately slower than goal pace.');
    }
    add(52, PRI.structure, 'cadence', ['c_intro'],
        'Cadence track is running underneath. Match your footstrike to the click.');

    // --- mile markers, and the on-pace self-check --------------------------
    for (let m = 1; m <= n; m++) {
      const p = plan.miles[m - 1];
      const idx = Math.min(m, 40);
      // "coming up" ~13% of a mile out. If he passes the marker before this
      // fires he's hot; if the marker is still ahead he's behind. Every third
      // marker carries the explicit adjustment.
      const cuClips = ['milecu_' + idx];
      if (m % 3 === 0 && m < n) cuClips.push(rot(CHK, m / 3));
      add(cum[m] - p * 0.13, PRI.split, 'split', cuClips, 'Mile ' + m + ' coming up.');
      add(cum[m], PRI.split, 'split', ['mile_' + idx], 'Mile ' + m + '.');
    }

    // --- block transitions --------------------------------------------------
    if (plan.warm > 0) {
      add(cum[plan.warm] + 26, PRI.structure, 'structure',
          ['s_warmend', paceClip(goalPace)], 'Warm up done. Settle into goal pace.');
    }
    if (plan.fin > 0 && n - plan.fin > 0) {
      add(cum[n - plan.fin] + 26, PRI.structure, 'structure',
          ['s_finblk', paceClip(plan.miles[n - plan.fin])], 'Final block. Time to lift.');
    }

    // --- per-mile coaching slots -------------------------------------------
    // Slot A is always rhythmic breathing. Slots B/C/D are filled from a
    // want-list so density scales with need: quiet early, busy in the grind.
    let bi = 0, fi = 0, ei = 0, gi = 0, ui = 0, hi = 0;
    let nextFuel = total > 3000 ? 2700 : Infinity;   // carbs matter past ~60 min
    let nextHyd  = total > 1500 ? 1200 : Infinity;
    let nextForm = 420;                              // form degrades early and often
    const grindFrom = Math.max(1, Math.floor(n * 0.52));
    const SLOTS = [0.46, 0.66, 0.82];

    for (let m = 1; m <= n; m++) {
      const p = plan.miles[m - 1], start = cum[m - 1];
      const inWarm = m <= plan.warm;
      const inFin  = plan.fin > 0 && m > n - plan.fin;
      const isLast = m === n;

      // slot A — rhythmic breathing, pattern follows the effort block
      const bank = inWarm ? B33 : (inFin ? B21 : B32);
      add(start + p * 0.22, PRI.breath, 'breath', [rot(bank, bi++)], 'Breathing check.');

      // build the want-list for this mile, most important first
      const wants = [];
      const midT = start + p * 0.5;
      if (midT >= nextFuel)     { wants.push(['fuel', PRI.fuel, [rot(FUEL, ui++)], 'Fuel time.']); nextFuel += 1800; }
      else if (midT >= nextHyd) { wants.push(['fuel', PRI.fuel, [rot(HYD,  hi++)], 'Hydrate.']);   nextHyd  += 1500; }
      if (midT >= nextForm)     { wants.push(['form', PRI.form, [rot(FORM, fi++)], 'Form check.']); nextForm += 900; }
      if (!isLast) {
        if (m >= grindFrom)   wants.push(['cheer', PRI.cheer, [rot(GRIND, gi++)], 'Stay in it.']);
        else if (m % 2 === 1) wants.push(['cheer', PRI.cheer, [rot(EARLY, ei++)], 'Looking smooth.']);
      }
      wants.slice(0, SLOTS.length).forEach((w, i) =>
        add(start + p * SLOTS[i], w[1], w[0], w[2], w[3]));
    }

    // --- the close ----------------------------------------------------------
    if (n >= 2) {
      const lp = plan.miles[n - 1];
      add(cum[n - 1] + 46, PRI.structure, 'structure', ['h_last'], 'Last mile.');
      add(cum[n - 1] + lp * 0.42, PRI.cheer, 'cheer', ['h_close'], 'Lift the cadence.');
      add(cum[n] - lp * 0.50, PRI.cheer, 'cheer', ['h_half'], 'Half a mile left.');
      add(cum[n] - 40, PRI.cheer, 'cheer', ['h_home'], 'Bring it home.');
    }
    add(cum[n] + 26, PRI.structure, 'done', ['s_done'], 'Session complete.');

    // --- de-conflict: highest priority keeps its exact slot -----------------
    cues.sort((a, b) => (b.pri - a.pri) || (a.t - b.t));
    const kept = [];
    const dropped = [];
    for (const c of cues) {
      if (kept.some(k => Math.abs(k.t - c.t) < MIN_GAP)) dropped.push(c);
      else kept.push(c);
    }
    kept.sort((a, b) => a.t - b.t);
    return { plan, cum, total, cues: kept, dropped };
  }

  const api = { buildPlan, cumulative, buildTimeline, paceClip, PRI };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
