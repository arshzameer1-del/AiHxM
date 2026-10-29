/**
 * Response cache for GET answers, kept warm in the background (PERF-2).
 *
 * Why: every API call crosses to a database in another region, so a page can
 * take seconds to answer. The app therefore loads the main screens' data in the
 * background right after sign-in and refreshes it every minute, so a click
 * finds the data already here.
 *
 * Rules:
 * - Only GETs of known-safe paths are cached (see `isCacheablePath`).
 * - An answer younger than FRESH_MS is used as it is. An older one is never
 *   shown: the page asks the server and shows "Loading", exactly as before.
 *   Nothing is shown first and replaced later, so the screen never jumps.
 * - Anything that is not a GET (a save, approve, delete...) empties the whole
 *   cache, so the read that follows a change always goes to the server.
 * - Cached text is parsed anew for every caller, so one screen can never
 *   change the object another screen holds.
 * - Held in memory and mirrored to sessionStorage (this tab only, gone when
 *   the tab closes, wiped on sign-out or when the signed-in user changes).
 * - `bypass` (polling a status that changes every few seconds) always asks
 *   the server.
 */

export const FRESH_MS = 120_000;
/** A page reload is the person asking for fresh data: only answers younger than this survive it. */
export const RELOAD_KEEP_MS = 15_000;
/** Paths read within this long count as "in use" and are kept warm. */
export const IN_USE_MS = 10 * 60_000;
const PERSIST_KEY = "aihxm.swr.v1";
const MAX_PERSIST_CHARS = 2_500_000;
const MAX_ENTRY_PERSIST_CHARS = 250_000;
const MAX_ENTRIES = 300;

type Entry = { text: string; at: number };

export interface CacheEnv {
  now: () => number;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** Paths that must never be served from a cache: credentials, files, exports, one-time values. */
const NEVER_CACHE = /\/(download|downloads|export|exports|backups|documents|receipts|asset|step-up|mfa|password|password-reset|token|tokens|secrets?|api-keys?|recovery-codes?|logout|sessions|inbox|preferences|employee-requests|announcements|data-subject-requests|delegations|completeness|medical|disciplinary|languages|appearance|careers)(\/|\?|$)/i;

export function isCacheablePath(pathWithQuery: string): boolean {
  const path = pathWithQuery.split("?")[0] ?? "";
  if (path === "/auth/me") return true;
  if (path.startsWith("/auth")) return false;
  return !NEVER_CACHE.test(pathWithQuery);
}

export function createResponseCache(env: CacheEnv) {
  const mem = new Map<string, Entry>();
  const lastUsed = new Map<string, number>();
  const tracked = new Set<string>();
  const inflight = new Map<string, Promise<string>>();
  let epoch = 0;
  let owner = "";
  let hydrated = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    if (!env.storage) return;
    try {
      const raw = env.storage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { owner: string; entries: [string, number, string][] };
      if (parsed.owner !== owner) {
        env.storage.removeItem(PERSIST_KEY);
        return;
      }
      for (const [path, at, text] of parsed.entries) {
        if (env.now() - at < RELOAD_KEEP_MS) mem.set(path, { text, at });
      }
    } catch {
      /* unreadable snapshot: start empty */
    }
  }

  function schedulePersist() {
    if (!env.storage || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const rows: [string, number, string][] = [];
        let size = 0;
        const newestFirst = [...mem.entries()].sort((a, b) => b[1].at - a[1].at);
        for (const [path, e] of newestFirst) {
          if (e.text.length > MAX_ENTRY_PERSIST_CHARS) continue;
          if (size + e.text.length > MAX_PERSIST_CHARS || rows.length >= MAX_ENTRIES) break;
          size += e.text.length;
          rows.push([path, e.at, e.text]);
        }
        env.storage?.setItem(PERSIST_KEY, JSON.stringify({ owner, entries: rows }));
      } catch {
        /* storage full or blocked: memory cache still works */
      }
    }, 400);
  }

  function store(path: string, text: string) {
    mem.set(path, { text, at: env.now() });
    if (mem.size > MAX_ENTRIES * 2) {
      const oldest = [...mem.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, mem.size - MAX_ENTRIES);
      for (const [k] of oldest) mem.delete(k);
    }
    schedulePersist();
  }

  function load(path: string, doFetch: () => Promise<string>): Promise<string> {
    const existing = inflight.get(path);
    if (existing) return existing;
    const startedIn = epoch;
    const p = doFetch()
      .then((text) => {
        // A change was saved while this was on its way: its answer may predate the change, so do not keep it.
        if (startedIn === epoch) store(path, text);
        return text;
      })
      .finally(() => {
        if (inflight.get(path) === p) inflight.delete(path);
      });
    inflight.set(path, p);
    return p;
  }

  return {
    /** Who the cache belongs to (a hash of the session token); a different owner starts empty. */
    setOwner(next: string) {
      if (next === owner) return;
      mem.clear();
      lastUsed.clear();
      tracked.clear();
      inflight.clear();
      epoch++;
      owner = next;
      hydrated = false;
      if (next) {
        hydrate();
      } else {
        try {
          env.storage?.removeItem(PERSIST_KEY);
        } catch {
          /* ignore */
        }
      }
    },

    /** Empty everything (sign-out, session change, or after any save). */
    clear() {
      mem.clear();
      lastUsed.clear();
      tracked.clear();
      inflight.clear();
      epoch++;
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      try {
        env.storage?.removeItem(PERSIST_KEY);
      } catch {
        /* ignore */
      }
    },

    /** Called after any non-GET finished. */
    invalidateAll() {
      this.clear();
      hydrated = true;
    },

    get(path: string, doFetch: () => Promise<string>, opts: { bypass?: boolean } = {}): Promise<string> {
      hydrate();
      lastUsed.set(path, env.now());
      if (opts.bypass) return load(path, doFetch);
      const entry = mem.get(path);
      if (entry && env.now() - entry.at < FRESH_MS) return Promise.resolve(entry.text);
      return load(path, doFetch);
    },

    /** Paths worth keeping fresh: what screens read recently (newest first), then everything that was warmed ahead. */
    inUse(max: number): string[] {
      const cutoff = env.now() - IN_USE_MS;
      const used = [...lastUsed.entries()]
        .filter(([, t]) => t >= cutoff)
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p);
      return [...new Set([...used, ...tracked])].slice(0, max);
    },

    /** Fetch again and keep the answer (background refresh), unless it is already younger than `minAgeMs`; never throws. */
    async refresh(path: string, doFetch: () => Promise<string>, minAgeMs = 0): Promise<void> {
      const entry = mem.get(path);
      if (entry && env.now() - entry.at < minAgeMs) return;
      try {
        await load(path, doFetch);
      } catch {
        tracked.delete(path); // refused or failing: stop asking every minute; the cached answer simply ages out
      }
    },

    /** Background warm-up: fetch only when there is nothing recent. Never throws. */
    async prefetch(path: string, doFetch: () => Promise<string>): Promise<void> {
      hydrate();
      tracked.add(path);
      const entry = mem.get(path);
      if (entry && env.now() - entry.at < FRESH_MS / 2) return;
      try {
        await load(path, doFetch);
      } catch {
        tracked.delete(path); // not allowed for this person, or failing: not worth asking again
      }
    },

    /** Test/diagnostic helpers. */
    size: () => mem.size,
    has: (path: string) => mem.has(path),
  };
}

export type ResponseCache = ReturnType<typeof createResponseCache>;
