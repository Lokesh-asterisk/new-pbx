/**
 * Optional Redis real-time state cache for wallboard.
 * Stores agent and queue state for sub-second reads when REDIS_URL is set.
 * Gracefully degrades: all functions are no-ops when Redis is unavailable.
 */

let redis = null;
let redisAvailable = false;
const KEY_PREFIX = 'wb:';
const TTL_SEC = 120;

export async function initRedis() {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return;
  try {
    const { createClient } = await import('redis');
    redis = createClient({ url });
    redis.on('error', (err) => {
      if (redisAvailable) console.error('[redis-wallboard] Redis error:', err.message);
      redisAvailable = false;
    });
    redis.on('ready', () => { redisAvailable = true; });
    await redis.connect();
    redisAvailable = true;
    console.log('[redis-wallboard] Connected to Redis');
  } catch (err) {
    console.warn('[redis-wallboard] Redis not available:', err.message);
    redis = null;
    redisAvailable = false;
  }
}

export function isRedisAvailable() { return redisAvailable && redis != null; }

export async function setAgentState(tenantId, agentId, data) {
  if (!redisAvailable || !redis) return;
  try {
    const key = `${KEY_PREFIX}agent:${tenantId}:${agentId}`;
    await redis.set(key, JSON.stringify(data), { EX: TTL_SEC });
  } catch {}
}

export async function getAgentState(tenantId, agentId) {
  if (!redisAvailable || !redis) return null;
  try {
    const key = `${KEY_PREFIX}agent:${tenantId}:${agentId}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getAllAgentStates(tenantId) {
  if (!redisAvailable || !redis) return null;
  try {
    const pattern = `${KEY_PREFIX}agent:${tenantId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length === 0) return [];
    const pipeline = redis.multi();
    for (const k of keys) pipeline.get(k);
    const results = await pipeline.exec();
    return results.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

export async function setQueueState(tenantId, queueName, data) {
  if (!redisAvailable || !redis) return;
  try {
    const key = `${KEY_PREFIX}queue:${tenantId}:${queueName}`;
    await redis.set(key, JSON.stringify(data), { EX: TTL_SEC });
  } catch {}
}

export async function getQueueState(tenantId, queueName) {
  if (!redisAvailable || !redis) return null;
  try {
    const key = `${KEY_PREFIX}queue:${tenantId}:${queueName}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function deleteAgentState(tenantId, agentId) {
  if (!redisAvailable || !redis) return;
  try {
    const key = `${KEY_PREFIX}agent:${tenantId}:${agentId}`;
    await redis.del(key);
  } catch {}
}
