/**
 * Real-time event delivery via Server-Sent Events (SSE).
 * Agents subscribe by agent user id; call-handler and routes broadcast events.
 * Wallboard supervisors subscribe by tenant id for live dashboard updates.
 */

const clients = new Map(); // agentUserId -> Set<res>
const wallboardClients = new Map(); // tenantId -> Set<res>
const HEARTBEAT_INTERVAL_MS = 25000;

function sendEvent(res, event) {
  if (res.writableEnded) return;
  const data = typeof event === 'string' ? event : JSON.stringify(event);
  res.write(`data: ${data}\n\n`);
}

/**
 * Subscribe an agent to real-time events. Call with the Express res for SSE.
 * @param {number} agentUserId - req.agentUser.id
 * @param {object} res - Express response (must not have been sent yet)
 */
export function subscribe(agentUserId, res) {
  const key = Number(agentUserId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);

  res.on('close', () => {
    unsubscribe(agentUserId, res);
  });
  res.on('error', () => {
    unsubscribe(agentUserId, res);
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  res.on('close', () => clearInterval(heartbeat));
}

/**
 * Unsubscribe one response for an agent.
 */
export function unsubscribe(agentUserId, res) {
  const key = Number(agentUserId);
  const set = clients.get(key);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(key);
  }
}

/**
 * Broadcast an event to a single agent (all their tabs).
 * @param {number} agentUserId
 * @param {object} payload - { type: string, payload: any }
 */
export function broadcastToAgent(agentUserId, payload) {
  const key = Number(agentUserId);
  const set = clients.get(key);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    if (!res.writableEnded) res.write(`data: ${data}\n\n`);
  }
}

/**
 * Subscribe a wallboard viewer to real-time events for a tenant.
 * @param {number} tenantId
 * @param {object} res - Express response (SSE stream)
 */
export function subscribeWallboard(tenantId, res) {
  const key = Number(tenantId);
  if (!wallboardClients.has(key)) wallboardClients.set(key, new Set());
  wallboardClients.get(key).add(res);

  res.on('close', () => unsubscribeWallboard(tenantId, res));
  res.on('error', () => unsubscribeWallboard(tenantId, res));

  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  res.on('close', () => clearInterval(heartbeat));
}

export function unsubscribeWallboard(tenantId, res) {
  const key = Number(tenantId);
  const set = wallboardClients.get(key);
  if (set) {
    set.delete(res);
    if (set.size === 0) wallboardClients.delete(key);
  }
}

/**
 * Broadcast to all wallboard viewers watching a tenant.
 * @param {number} tenantId
 * @param {object} payload - { type: string, payload: any }
 */
export function broadcastToWallboard(tenantId, payload) {
  const key = Number(tenantId);
  const set = wallboardClients.get(key);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    if (!res.writableEnded) res.write(`data: ${data}\n\n`);
  }
}

/**
 * Broadcast to all agents in a tenant (e.g. queue activity for supervisor).
 * @param {number} tenantId
 * @param {object} payload - { type: string, payload: any }
 */
export function broadcastToTenant(tenantId, payload) {
  broadcastToWallboard(tenantId, payload);
}

/**
 * Event types: incoming_call, call_answered, call_ended, agent_status, queue_activity, call_held, call_resumed
 */
export const EventTypes = {
  INCOMING_CALL: 'incoming_call',
  CALL_ANSWERED: 'call_answered',
  CALL_ENDED: 'call_ended',
  AGENT_STATUS: 'agent_status',
  QUEUE_ACTIVITY: 'queue_activity',
  CALL_HELD: 'call_held',
  CALL_RESUMED: 'call_resumed',
};
