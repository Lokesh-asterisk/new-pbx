/**
 * Queue ring strategy: order queue members by strategy for incoming queue calls.
 * Used by Stasis queue-dashboard to pick which agent(s) to try and in what order.
 * All strategies are per-queue and work for any number of queues and any number of agents per queue.
 *
 * Default behaviour (all queues and agents): only available agents are considered.
 * Agents who are LoggedOut, LoginFailed, Outbound, On Call, Ringing, or Transferring are excluded
 * so the next call always goes to the next available agent.
 *
 * Strategies:
 * - ringall: fixed order by member_name (first agent first every time)
 * - linear: same as ringall (member_name order)
 * - rrordered: round-robin by position (each new call tries next agent in list)
 * - rrmemory: round-robin by last answered (next call goes to agent after who last answered)
 * - leastrecent: agent with oldest last_called time first (from call_records)
 * - fewestcalls: agent with fewest answered calls first (from call_records)
 * - random: shuffle order per call
 */
import { query, queryOne } from './db.js';

// In-memory state per queue: rrordered = last tried index, rrmemory = last agent who answered
const queueLastIndex = new Map();
const queueLastAgent = new Map();

function normalizeStrategy(str) {
  const s = (str || '').toString().trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
  if (s === 'roundrobin' || s === 'rrordered') return 'rrordered';
  if (s === 'rrmemory') return 'rrmemory';
  if (s === 'leastrecent') return 'leastrecent';
  if (s === 'fewestcalls') return 'fewestcalls';
  if (s === 'random') return 'random';
  if (s === 'linear') return 'linear';
  if (s === 'ringall') return 'ringall';
  return 'ringall'; // default
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Get queue members ordered by the queue's ring strategy.
 * @param {string} queueIdOrName - Queue id (numeric) or queue name
 * @returns {Promise<{ members: string[], strategy: string }>} Ordered list of member_name (extension numbers) and strategy used
 */
export async function getOrderedQueueMembers(queueIdOrName) {
  const raw = (queueIdOrName || '').toString().trim();
  if (!raw) return { members: [], strategy: 'ringall', queueName: null };

  let queue = await queryOne('SELECT id, name, strategy FROM queues WHERE name = ? LIMIT 1', [raw]);
  if (!queue && /^\d+$/.test(raw)) {
    queue = await queryOne('SELECT id, name, strategy FROM queues WHERE id = ? LIMIT 1', [parseInt(raw, 10)]);
  }
  if (!queue) return { members: [], strategy: 'ringall', queueName: null };

  const queueName = queue.name;
  const mapKey = String(queueName).trim(); // canonical key for in-memory state (all queues)
  // When no strategy is set in DB, default to rrordered so calls distribute across agents
  const rawStrategy = queue.strategy != null && String(queue.strategy).trim() !== '' ? queue.strategy : 'rrordered';
  const strategy = normalizeStrategy(rawStrategy);
  const rows = await query(
    'SELECT member_name FROM queue_members WHERE queue_name = ? AND (paused = 0 OR paused IS NULL) ORDER BY member_name',
    [queueName]
  );
  let members = (rows || []).map((r) => String(r.member_name || '').trim()).filter(Boolean);
  const rawMembers = [...members];

  // Single query to get all agent_status rows — classify each as available, busy, or offline
  const allStatusRows = await query(
    'SELECT agent_id, extension_number, status FROM agent_status'
  );
  const availableIds = new Set();
  const busyIds = new Set();
  for (const r of allStatusRows || []) {
    const ext = String(r.extension_number || '').trim();
    const aid = String(r.agent_id || '').trim();
    const st = (r.status || '').toString().trim();
    const stLower = st.toLowerCase();
    // Treat LoggedOut / login in-progress / SIP phone ringing as offline
    if (
      stLower === 'loggedout' ||
      stLower === 'loginfailed' ||
      stLower === 'logininitiated' ||
      stLower === 'sip phone ringing'
    ) {
      continue;
    }
    // Treat PAUSED / Break statuses as not available for queue calls
    if (stLower === 'paused' || stLower.includes('break')) {
      continue;
    }
    // Busy: on call / ringing / transferring / outbound
    if (['On Call', 'Ringing', 'Transferring', 'Outbound'].includes(st)) {
      if (ext) busyIds.add(ext);
      if (aid) busyIds.add(aid);
    } else {
      if (ext) availableIds.add(ext);
      if (aid) availableIds.add(aid);
    }
  }
  members = members.filter((m) => availableIds.has(m) && !busyIds.has(m));

  console.log('[queue-strategy]', queueName, '| strategy:', strategy,
    '| rawMembers:', rawMembers,
    '| available:', [...availableIds],
    '| busy:', [...busyIds],
    '| finalMembers:', members);

  if (members.length === 0) return { members: [], strategy, queueName };

  switch (strategy) {
    case 'random':
      members = shuffle(members);
      break;
    case 'rrordered': {
      const last = queueLastIndex.get(mapKey) ?? -1;
      const next = Math.max(0, (last + 1) % Math.max(1, members.length));
      queueLastIndex.set(mapKey, next);
      members = [...members.slice(next), ...members.slice(0, next)];
      break;
    }
    case 'rrmemory': {
      const lastAgent = queueLastAgent.get(mapKey);
      const idx = lastAgent ? members.indexOf(lastAgent) : -1;
      const start = idx >= 0 ? (idx + 1) % members.length : 0;
      if (members.length > 0) queueLastAgent.set(mapKey, members[start] ?? members[0]);
      members = [...members.slice(start), ...members.slice(0, start)];
      break;
    }
    case 'leastrecent': {
      const recents = await query(
        `SELECT agent_extension, MAX(end_time) AS last_called FROM call_records
         WHERE queue_name = ? AND agent_extension IS NOT NULL AND agent_extension != ''
         GROUP BY agent_extension`,
        [queueName]
      );
      const lastByExt = new Map((recents || []).map((r) => [String(r.agent_extension).trim(), r.last_called]));
      members.sort((a, b) => {
        const ta = lastByExt.get(a) ? new Date(lastByExt.get(a)).getTime() : 0;
        const tb = lastByExt.get(b) ? new Date(lastByExt.get(b)).getTime() : 0;
        if (ta !== tb) return ta - tb; // least recent first
        return String(a).localeCompare(String(b), undefined, { numeric: true }); // stable tie-break
      });
      break;
    }
    case 'fewestcalls': {
      const counts = await query(
        `SELECT agent_extension, COUNT(*) AS cnt FROM call_records
         WHERE queue_name = ? AND status = 'answered' AND agent_extension IS NOT NULL AND agent_extension != ''
         GROUP BY agent_extension`,
        [queueName]
      );
      const countByExt = new Map((counts || []).map((r) => [String(r.agent_extension).trim(), Number(r.cnt) || 0]));
      members.sort((a, b) => {
        const ca = countByExt.get(a) ?? 0;
        const cb = countByExt.get(b) ?? 0;
        if (ca !== cb) return ca - cb; // fewest first
        return String(a).localeCompare(String(b), undefined, { numeric: true }); // stable tie-break
      });
      break;
    }
    case 'linear':
    case 'ringall':
    default:
      // already ordered by member_name (stable, deterministic)
      break;
  }

  return { members, strategy, queueName };
}

/**
 * Update last agent for rrmemory when a call is answered (so next call uses next agent).
 * Uses same canonical queue key as getOrderedQueueMembers so strategy state stays consistent.
 */
export function setQueueLastAgent(queueName, agentExtension) {
  const key = queueName != null ? String(queueName).trim() : '';
  const ext = agentExtension != null ? String(agentExtension).trim() : '';
  if (key && ext) queueLastAgent.set(key, ext);
}
