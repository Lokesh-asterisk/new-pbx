/**
 * Redis persistence layer for ARI call state Maps.
 * Keeps in-memory Maps as primary (fast sync access), periodically
 * serializes to Redis for durability across server restarts.
 * Falls back gracefully when Redis is unavailable.
 */

let redis = null;
let available = false;
const KEY = 'ari:state';
const SYNC_INTERVAL_MS = 5000;
let syncTimer = null;
let stateMaps = {};

export async function initAriRedisState() {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return;
  try {
    const { createClient } = await import('redis');
    redis = createClient({ url });
    redis.on('error', () => { available = false; });
    redis.on('ready', () => { available = true; });
    await redis.connect();
    available = true;
    console.log('[ari-state-redis] Connected');
  } catch (err) {
    console.warn('[ari-state-redis] Redis not available:', err.message);
    redis = null;
    available = false;
  }
}

export function registerStateMaps(maps) {
  stateMaps = maps;
}

export async function loadStateFromRedis() {
  if (!available || !redis) return false;
  try {
    const raw = await redis.get(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    for (const [name, entries] of Object.entries(data)) {
      const map = stateMaps[name];
      if (map && Array.isArray(entries)) {
        map.clear();
        for (const [k, v] of entries) {
          map.set(k, v);
        }
      }
    }
    console.log('[ari-state-redis] Restored state from Redis');
    return true;
  } catch (err) {
    console.warn('[ari-state-redis] Failed to load state:', err.message);
    return false;
  }
}

async function syncToRedis() {
  if (!available || !redis || Object.keys(stateMaps).length === 0) return;
  try {
    const data = {};
    for (const [name, map] of Object.entries(stateMaps)) {
      data[name] = Array.from(map.entries());
    }
    await redis.set(KEY, JSON.stringify(data), { EX: 3600 });
  } catch {}
}

export function startAriStateSync() {
  if (syncTimer) return;
  syncTimer = setInterval(syncToRedis, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopAriStateSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

export async function flushAriState() {
  await syncToRedis();
}
