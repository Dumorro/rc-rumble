/**
 * Standings — position, gap and interval maths shared by the HUD, the AI and
 * the race rules.
 *
 * Ordering key is the race entry's `progress` (laps + fraction of lap), with
 * finishers pinned above everyone still driving in the order they crossed the
 * line. Gaps are *real* time gaps: every car records a small trace of
 * (progress, time) samples, so "how long ago was the car ahead where I am now?"
 * is answered by looking up the leader's trace rather than dividing distance by
 * a guessed speed. That is what makes the interval readout stop wobbling.
 *
 * Nothing here allocates per frame — the sorted array is reused and sorted with
 * an insertion sort, which is optimal for an 8-element list that changes by one
 * swap at a time.
 */

/** Ring buffer of (progress, time) samples for one car. */
export class ProgressTrace {
  /**
   * @param {number} [capacity] samples kept (default 20 s at 20 Hz)
   * @param {number} [interval] seconds between samples
   */
  constructor(capacity = 512, interval = 0.05) {
    this.capacity = capacity;
    this.interval = interval;
    this.progress = new Float64Array(capacity);
    this.time = new Float64Array(capacity);
    this.head = -1;         // index of the newest sample
    this.count = 0;
    this._nextAt = -1;
  }

  reset() {
    this.head = -1;
    this.count = 0;
    this._nextAt = -1;
  }

  /** Record a sample if the interval has elapsed. Cheap to call every step. */
  sample(progress, time) {
    if (time < this._nextAt) return;
    this._nextAt = time + this.interval;
    this.head = (this.head + 1) % this.capacity;
    this.progress[this.head] = progress;
    this.time[this.head] = time;
    if (this.count < this.capacity) this.count++;
  }

  /** Newest recorded progress (−Infinity when empty). */
  get latestProgress() { return this.count > 0 ? this.progress[this.head] : -Infinity; }
  get latestTime() { return this.count > 0 ? this.time[this.head] : 0; }
  get oldestProgress() {
    if (this.count === 0) return Infinity;
    const i = (this.head - this.count + 1 + this.capacity) % this.capacity;
    return this.progress[i];
  }

  /**
   * The time at which this car reached `p`, linearly interpolated between the
   * two straddling samples.
   * @returns {number} NaN when `p` is outside the recorded window.
   */
  timeAtProgress(p) {
    const n = this.count;
    if (n < 2) return NaN;
    if (p > this.progress[this.head]) return NaN;
    // Walk backwards from newest; progress is (near-)monotonic so this exits fast.
    let prevI = this.head;
    for (let k = 1; k < n; k++) {
      const i = (this.head - k + this.capacity) % this.capacity;
      if (this.progress[i] <= p) {
        const p0 = this.progress[i], p1 = this.progress[prevI];
        const t0 = this.time[i], t1 = this.time[prevI];
        const span = p1 - p0;
        if (span <= 1e-9) return t1;
        const f = (p - p0) / span;
        return t0 + (t1 - t0) * f;
      }
      prevI = i;
    }
    return NaN;
  }
}

export class Standings {
  /** @param {import('./RaceSystem.js').RaceSystem} race */
  constructor(race) {
    this.race = race;
    this.game = race?.game ?? null;
    /** @type {object[]} race entries, best first */
    this.order = [];
    /** @type {import('../vehicle/Car.js').Car[]} cars, best first (mirrors `order`) */
    this.cars = [];
    /** carId → entry */
    this._byId = new Map();
    this.count = 0;
    this.time = 0;
    /** Reused scratch for gap lookups so nothing allocates. */
    this._gap = { seconds: 0, metres: 0, estimated: false, lapped: 0 };
  }

  /** Adopt a fresh entry list (called by RaceSystem.onRaceStart). */
  bind(entries) {
    this.order.length = 0;
    this.cars.length = 0;
    this._byId.clear();
    for (let i = 0; i < entries.length; i++) {
      this.order.push(entries[i]);
      this.cars.push(entries[i].car);
      this._byId.set(entries[i].id, entries[i]);
    }
    this.count = entries.length;
  }

  clear() {
    this.order.length = 0;
    this.cars.length = 0;
    this._byId.clear();
    this.count = 0;
  }

  /**
   * Re-sort the field. Insertion sort: O(n) when nothing changed, which is the
   * common case at 120 Hz.
   * @param {number} time current race time (seconds)
   */
  update(time) {
    this.time = time;
    const a = this.order;
    for (let i = 1; i < a.length; i++) {
      const e = a[i];
      let j = i - 1;
      while (j >= 0 && compareEntries(a[j], e) > 0) { a[j + 1] = a[j]; j--; }
      a[j + 1] = e;
    }
    for (let i = 0; i < a.length; i++) this.cars[i] = a[i].car;
  }

  // ───────────────────────────────────────────────────────────── lookups

  entryOf(carOrId) {
    if (!carOrId) return null;
    const id = typeof carOrId === 'number' ? carOrId : carOrId.id;
    return this._byId.get(id) ?? null;
  }

  /** 1-based race position. Returns 0 for unknown cars. */
  placeOf(carOrId) {
    const e = this.entryOf(carOrId);
    return e ? e.place : 0;
  }

  /** @param {number} place 1-based */
  entryAt(place) { return this.order[place - 1] ?? null; }
  carAt(place) { return this.order[place - 1]?.car ?? null; }

  get leader() { return this.order[0] ?? null; }
  get leaderCar() { return this.order[0]?.car ?? null; }
  get lastEntry() { return this.order[this.order.length - 1] ?? null; }
  get lastCar() { return this.order[this.order.length - 1]?.car ?? null; }

  /** Entry directly ahead on the road (null for the leader). */
  entryAhead(carOrId) {
    const e = this.entryOf(carOrId);
    if (!e) return null;
    const i = this.order.indexOf(e);
    return i > 0 ? this.order[i - 1] : null;
  }

  entryBehind(carOrId) {
    const e = this.entryOf(carOrId);
    if (!e) return null;
    const i = this.order.indexOf(e);
    return i >= 0 && i < this.order.length - 1 ? this.order[i + 1] : null;
  }

  carAhead(carOrId) { return this.entryAhead(carOrId)?.car ?? null; }
  carBehind(carOrId) { return this.entryBehind(carOrId)?.car ?? null; }

  /**
   * The nearest car in front of `car` *on the road* (ignoring lap count), which
   * is what a homing weapon should chase. Falls back to the car ahead on
   * standings when nothing is within `maxMetres`.
   * @returns {object|null} Car
   */
  nearestAheadOnRoad(car, maxMetres = 90) {
    const self = this.entryOf(car);
    if (!self) return null;
    const nav = this.race?.nav;
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.order.length; i++) {
      const o = this.order[i];
      if (o === self || !o.car || o.dnf) continue;
      let d;
      if (nav?.ready) {
        d = nav.metresBetween(self.u, o.u);
        // metresBetween is the short way round; only accept genuinely ahead.
        if (d <= 0.2) continue;
      } else {
        d = (o.progress - self.progress) * 40;
        if (d <= 0) continue;
      }
      if (d < bestD && d <= maxMetres) { bestD = d; best = o; }
    }
    return (best ?? this.entryAhead(car))?.car ?? null;
  }

  /** Nearest car behind on the road — for rear-fired weapons. */
  nearestBehindOnRoad(car, maxMetres = 90) {
    const self = this.entryOf(car);
    if (!self) return null;
    const nav = this.race?.nav;
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.order.length; i++) {
      const o = this.order[i];
      if (o === self || !o.car || o.dnf) continue;
      let d;
      if (nav?.ready) {
        d = -nav.metresBetween(self.u, o.u);
        if (d <= 0.2) continue;
      } else {
        d = (self.progress - o.progress) * 40;
        if (d <= 0) continue;
      }
      if (d < bestD && d <= maxMetres) { bestD = d; best = o; }
    }
    return (best ?? this.entryBehind(car))?.car ?? null;
  }

  // ───────────────────────────────────────────────────────────── gaps

  /**
   * Time + distance gap from `car` to `other` (positive = `other` is ahead).
   * Reuses one scratch object — copy the numbers out if you keep them.
   * @returns {{seconds:number, metres:number, estimated:boolean, lapped:number}}
   */
  gapBetween(car, other) {
    const g = this._gap;
    g.seconds = 0; g.metres = 0; g.estimated = false; g.lapped = 0;
    const a = this.entryOf(car), b = this.entryOf(other);
    if (!a || !b || a === b) return g;

    const dProgress = b.progress - a.progress;
    const lapLen = this.race?.nav?.length ?? 60;
    g.metres = dProgress * lapLen;
    g.lapped = Math.trunc(dProgress);

    // Both finished → pure finish-time difference.
    if (a.finished && b.finished) {
      g.seconds = a.finishTime - b.finishTime;
      return g;
    }

    const ahead = dProgress >= 0 ? b : a;
    const behind = dProgress >= 0 ? a : b;
    const t = ahead.trace.timeAtProgress(behind.progress);
    if (Number.isFinite(t)) {
      const now = behind.finished ? behind.finishTime : this.time;
      g.seconds = (now - t) * (dProgress >= 0 ? 1 : -1);
    } else {
      // Outside the trace window: fall back to distance / reference speed.
      const speed = Math.max(1.2, Math.abs(behind.car?.speed ?? 0), Math.abs(ahead.car?.speed ?? 0));
      g.seconds = g.metres / speed;
      g.estimated = true;
    }
    return g;
  }

  /** Seconds behind the leader (0 for the leader). */
  gapToLeader(car) {
    const l = this.leader;
    if (!l) return 0;
    const e = this.entryOf(car);
    if (!e || e === l) return 0;
    return this.gapBetween(car, l.car).seconds;
  }

  /** Seconds to the car directly ahead (0 for the leader). */
  intervalAhead(car) {
    const a = this.entryAhead(car);
    if (!a) return 0;
    return this.gapBetween(car, a.car).seconds;
  }

  /** Seconds to the car directly behind (0 for last). */
  intervalBehind(car) {
    const b = this.entryBehind(car);
    if (!b) return 0;
    return -this.gapBetween(car, b.car).seconds;
  }

  /** Metres of centreline between `car` and the car ahead. */
  distanceAhead(car) {
    const a = this.entryAhead(car);
    if (!a) return Infinity;
    return this.gapBetween(car, a.car).metres;
  }

  /**
   * Normalised field position: 0 = leader, 1 = last. The single number the AI
   * and the pickup roll table use for rubber-banding.
   */
  fieldT(car) {
    const n = this.count;
    if (n < 2) return 0;
    const p = this.placeOf(car);
    if (p <= 0) return 0.5;
    return (p - 1) / (n - 1);
  }

  /**
   * Catch-up factor for the AI: >1 when behind the player, <1 when ahead.
   * Deliberately gentle — it nudges, it does not teleport.
   * @param {object} car
   * @param {number} [strength] 0..1, defaults to CONFIG.ai.rubberBand
   */
  rubberBand(car, strength = 0.1) {
    const player = this.game?.playerCar;
    if (!player || !car || car === player) return 1;
    const g = this.gapBetween(car, player).seconds;   // + = player ahead
    // Clamp to ±6 s so a hopeless backmarker does not get a rocket engine.
    const t = Math.max(-6, Math.min(6, g)) / 6;
    return 1 + t * strength;
  }

  /** Order snapshot for the UI ladder — fills and returns the given array. */
  fill(out) {
    out.length = 0;
    for (let i = 0; i < this.order.length; i++) out.push(this.order[i]);
    return out;
  }
}

/** Sort predicate: finishers first (by finish order), then by progress. */
export function compareEntries(a, b) {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
  if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
  if (b.progress !== a.progress) return b.progress - a.progress;
  return a.gridIndex - b.gridIndex;
}

/** `83.4567` → `1:23.457`. Millisecond precision, race-clock formatting. */
export function formatTime(seconds, { sign = false, ms = 3 } = {}) {
  if (!Number.isFinite(seconds)) return '--:--.---';
  const s = sign && seconds >= 0 ? '+' : seconds < 0 ? '-' : '';
  const a = Math.abs(seconds);
  const m = Math.floor(a / 60);
  const rest = a - m * 60;
  const pad = rest < 10 ? '0' : '';
  return `${s}${m}:${pad}${rest.toFixed(ms)}`;
}

/** `1.234` → `+1.234` — for interval/gap readouts. */
export function formatGap(seconds, { ms = 3 } = {}) {
  if (!Number.isFinite(seconds)) return '--.---';
  const a = Math.abs(seconds);
  if (a >= 60) return formatTime(seconds, { sign: true, ms });
  return `${seconds >= 0 ? '+' : '-'}${a.toFixed(ms)}`;
}

/** 1 → '1st', 12 → '12th'. */
export function ordinal(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export default Standings;
