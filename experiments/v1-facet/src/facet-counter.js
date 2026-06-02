// Dynamic facet code: a TRIVIAL SQLite-backed Durable Object class.
// Loaded into a fresh isolate by env.LOADER and instantiated as a facet by the
// supervisor via ctx.facets.get(). Proves: (a) a dynamically-loaded DO class can
// run as a facet, (b) the facet has its OWN ctx.storage.sql isolated from the
// supervisor and from sibling facets.
import { DurableObject } from "cloudflare:workers";

export class CounterFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);"
    );
  }

  _get(k) {
    const c = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k=?;", k).toArray();
    return c.length ? c[0].v : null;
  }
  _put(k, v) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
      k,
      v
    );
  }

  // RPC: bump and return a per-facet counter.
  async bump() {
    const n = (parseInt(this._get("n") || "0", 10) || 0) + 1;
    this._put("n", String(n));
    return n;
  }

  // RPC: read whatever is stored under a key (used to prove a facet CANNOT see the
  // supervisor's secret — the supervisor writes the secret to ITS own db, not here).
  async read(k) {
    return this._get(k);
  }

  // RPC: write a tenant-private value (used to prove two facets have independent dbs).
  async write(k, v) {
    this._put(k, v);
    return true;
  }

  // PROBE: can a facet schedule a Durable Object alarm? (undocumented for facets)
  async probeAlarm() {
    try {
      await this.ctx.storage.setAlarm(Date.now() + 1500);
      const at = await this.ctx.storage.getAlarm();
      return { setAlarm: true, getAlarm: at };
    } catch (e) {
      return { setAlarm: false, error: String((e && e.message) || e) };
    }
  }

  // PROBE: did the alarm actually FIRE? alarm() writes a marker into the facet's db.
  async alarm() {
    this._put("alarm_fired_at", String(Date.now()));
  }
  async readAlarmFired() {
    return this._get("alarm_fired_at");
  }

  // PROBE: can a facet accept a hibernatable WebSocket? (needs ctx.acceptWebSocket)
  async probeWebSocket() {
    return {
      hasAcceptWebSocket: typeof this.ctx.acceptWebSocket === "function",
      hasGetWebSockets: typeof this.ctx.getWebSockets === "function",
      hasSetWebSocketAutoResponse:
        typeof this.ctx.setWebSocketAutoResponse === "function",
    };
  }

  // PROBE: can a facet create its OWN facet (nesting)?
  async probeNesting() {
    return { hasFacets: !!(this.ctx.facets && typeof this.ctx.facets.get === "function") };
  }
}
