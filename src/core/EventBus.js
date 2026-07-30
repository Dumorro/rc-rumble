/**
 * Tiny synchronous event bus. Zero allocation on emit for the common case.
 *
 * Canonical event names live in ARCHITECTURE.md — use those, don't invent
 * parallel names for the same thing.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._map = new Map();
    this._depth = 0;
    this._pendingOff = [];
  }

  /** @returns {() => void} unsubscribe */
  on(name, fn) {
    let set = this._map.get(name);
    if (!set) { set = new Set(); this._map.set(name, set); }
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const wrap = (payload) => { this.off(name, wrap); fn(payload); };
    return this.on(name, wrap);
  }

  off(name, fn) {
    if (this._depth > 0) { this._pendingOff.push([name, fn]); return; }
    this._map.get(name)?.delete(fn);
  }

  emit(name, payload) {
    const set = this._map.get(name);
    if (!set || set.size === 0) return;
    this._depth++;
    try {
      for (const fn of set) {
        try { fn(payload); }
        catch (err) { console.error(`[EventBus] handler for "${name}" threw:`, err); }
      }
    } finally {
      this._depth--;
      if (this._depth === 0 && this._pendingOff.length) {
        for (const [n, f] of this._pendingOff) this._map.get(n)?.delete(f);
        this._pendingOff.length = 0;
      }
    }
  }

  clear(name) {
    if (name) this._map.delete(name);
    else this._map.clear();
  }
}

export default EventBus;
