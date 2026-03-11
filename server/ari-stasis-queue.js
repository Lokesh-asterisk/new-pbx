/**
 * ARI Stasis app "queue-dashboard": queue calls show only on dashboard; phone rings when agent clicks Answer.
 * Dialplan: Stasis(queue-dashboard, QueueName, UNIQUEID). App picks first agent by queue ring strategy.
 */
import { WebSocket } from 'ws';
import { createCallRecord, updateCallRecordAgent, setAgentRinging, setAgentAnswered, setAgentHangup, updateCallRecordAbandon, updateCallRecordTransfer, notifyTransferredCallToAgent } from './call-handler.js';
import { query, queryOne } from './db.js';
import { addChannelToBridge, removeChannelFromBridge, hangupChannel, createBridge, answerChannel, startMohOnChannel, stopMohOnChannel, muteChannel, getChannelVariable, setChannelVariable, continueInDialplan, redirectChannel } from './asterisk-ari.js';
import { getOrderedQueueMembers } from './queue-strategy.js';
import { resolveAgentUserByExtensionName } from './agent-extension-resolver.js';
import { broadcastToWallboard } from './realtime.js';
import { registerStateMaps, loadStateFromRedis, startAriStateSync } from './ari-state-redis.js';

function broadcastQueueChange(queueName, tenantId) {
  if (!tenantId) return;
  const counts = getQueueWaitingCountsInternal();
  const info = counts.byQueue[queueName] || { count: 0, longestWaitMs: 0 };
  broadcastToWallboard(tenantId, {
    type: 'queue_activity',
    payload: { queue_name: queueName, waiting: info.count },
  });
}

function getQueueWaitingCountsInternal() {
  const byQueue = {};
  let total = 0;
  const now = Date.now();
  for (const [, c] of pendingCustomers) {
    const q = c.queueName || 'unknown';
    if (!byQueue[q]) byQueue[q] = { count: 0, longestWaitMs: 0 };
    byQueue[q].count++;
    const waitMs = c.joinedAt ? now - c.joinedAt : 0;
    if (waitMs > byQueue[q].longestWaitMs) byQueue[q].longestWaitMs = waitMs;
    total++;
  }
  return { total, byQueue };
}

const QUEUE_APP = 'queue-dashboard';
const AGENT_RING_TIMEOUT_SEC = parseInt(process.env.AGENT_RING_TIMEOUT_SEC || '20', 10);

// Customer channel id -> { agentId, queueName, uniqueId, memberList, memberIndex, callerNumber, campaignName, didTfn, agentRingTimerId }
const pendingCustomers = new Map();
// Agent channel id (we originated) -> { bridgeId, customerChannelId, uniqueId, agentId }
const pendingAgents = new Map();
// Tracks bridged call pairs for cleanup: customerChannelId -> { agentChannelId, bridgeId, agentId, uniqueId }
const activeBridgedCalls = new Map();
// agentId -> login channel ID (Stasis-based login channels)
const agentLoginStasisChannels = new Map();
// Supervisor barge/listen: channelId -> { bridgeId, mode: 'barge'|'listen' }
const pendingSupervisorJoin = new Map();
// Outbound call: outbound channel id -> { agentChannelId, uniqueId } until answered
const pendingOutbound = new Map();
// Outbound call active: outbound channel id -> { agentChannelId, bridgeId, uniqueId }
const activeOutboundCalls = new Map();

registerStateMaps({
  pendingCustomers,
  pendingAgents,
  activeBridgedCalls,
  agentLoginStasisChannels,
  pendingSupervisorJoin,
  pendingOutbound,
  activeOutboundCalls,
});

function parseAriError(body) {
  if (!body || typeof body !== 'string') return null;
  const s = body.trim();
  if (!s) return null;
  try {
    const data = JSON.parse(s);
    const msg = data.message || data.error || data.response;
    return msg ? String(msg).trim().slice(0, 120) : null;
  } catch {
    return s.length <= 120 ? s : null;
  }
}

function findAgentIdByChannel(agentChannelId) {
  if (!agentChannelId) return null;
  for (const [aid, chId] of agentLoginStasisChannels) {
    if (chId === agentChannelId) return aid;
  }
  return null;
}

function getWsUrl() {
  const base = (process.env.ASTERISK_ARI_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;
  const wsProto = base.startsWith('https') ? 'wss' : 'ws';
  const host = base.replace(/^https?:\/\//, '');
  const user = (process.env.ASTERISK_ARI_USER || '').trim();
  const pass = (process.env.ASTERISK_ARI_PASSWORD || '').trim();
  if (!user) return null;
  const auth = encodeURIComponent(`${user}:${pass}`);
  return `${wsProto}://${host}/ari/events?app=${encodeURIComponent(QUEUE_APP)}&api_key=${auth}`;
}


/**
 * Get failover destination for a queue (no agents / no answer / timeout). Returns dialplan action and value.
 * @param {string} queueName
 * @returns {Promise<{ action: string, value: string }>} action 0=hangup, 1=announcement, 2=queue, 3=ivr, 4=voicemail, 5=timecondition, 9=extension
 */
async function getQueueFailover(queueName) {
  const q = await queryOne(
    'SELECT tenant_id, failover_destination_type, failover_destination_id FROM queues WHERE name = ? LIMIT 1',
    [String(queueName || '').trim()]
  );
  if (!q || !q.failover_destination_id) return { action: '0', value: '' };
  const destType = (q.failover_destination_type || 'hangup').toLowerCase();
  if (destType === 'hangup') return { action: '0', value: '' };
  const ACTION_MAP = { announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9', exten: '9' };
  let action = ACTION_MAP[destType] || '0';
  let value = String(q.failover_destination_id);
  const tenantId = q.tenant_id;
  if (destType === 'queue') {
    const q2 = await queryOne('SELECT name FROM queues WHERE id = ? AND tenant_id = ? LIMIT 1', [q.failover_destination_id, tenantId]);
    if (q2?.name) value = q2.name;
    else action = '0';
  } else if (destType === 'extension' || destType === 'exten') {
    const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? AND tenant_id = ? LIMIT 1', [q.failover_destination_id, tenantId]);
    if (ext?.name) value = ext.name;
    else action = '0';
  }
  return { action, value };
}

/**
 * Redirect customer channel to queue failover destination (another queue/extension/IVR/announcement/voicemail/timecondition or hangup).
 * @param {string} channelId - customer channel id
 * @param {string} queueName - queue name (for failover lookup)
 * @returns {Promise<boolean>} true if redirected, false if hung up
 */
async function redirectToQueueFailover(channelId, queueName) {
  const { action, value } = await getQueueFailover(queueName);
  if (action === '0') {
    await hangupChannel(channelId);
    return false;
  }
  await setChannelVariable(channelId, 'Destination_Action', action);
  await setChannelVariable(channelId, 'Destination_Value', value);
  await stopMohOnChannel(channelId).catch(() => {});
  const res = await continueInDialplan(channelId, 'QueueFailover', 's', 1);
  if (res.status !== 200 && res.status !== 204) {
    console.warn('[ari-stasis-queue] Failover continueInDialplan failed:', res.status, res.body);
    await hangupChannel(channelId);
    return false;
  }
  return true;
}

/**
 * Notify an agent about a queue call. Returns true if the agent was successfully set to Ringing,
 * false if the agent was busy/unavailable (so caller can try the next agent).
 */
async function notifyAgentForQueueCall(channelId, callerNumber, queueName, uniqueId, agentExten, campaignName = null, didTfn = null) {
  const agentId = String(agentExten || '').replace(/\D/g, '') || null;
  if (!agentId) return false;
  const queueRow = await queryOne('SELECT tenant_id FROM queues WHERE name = ? LIMIT 1', [String(queueName || '').trim()]);
  const tenantId = queueRow?.tenant_id ?? null;
  let userRow = tenantId != null ? await resolveAgentUserByExtensionName(tenantId, agentExten) : null;
  if (!userRow) {
    userRow = await queryOne(
      'SELECT id, parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
      [agentId]
    );
  }
  const resolvedTenantId = userRow?.parent_id ?? 1;
  await createCallRecord({
    tenantId: resolvedTenantId,
    uniqueId: String(uniqueId || ''),
    channelId,
    sourceNumber: callerNumber,
    destinationNumber: agentExten,
    direction: 'inbound',
    queueName: String(queueName || ''),
    campaignName: campaignName || null,
    didTfn: didTfn || null,
    agentUserId: userRow?.id ?? null,
    agentExtension: agentExten,
    agentId,
  });
  await updateCallRecordAgent(String(uniqueId || ''), {
    agentUserId: userRow?.id ?? null,
    agentExtension: agentExten,
    agentId,
  });
  const loginCh = agentLoginStasisChannels.get(agentId) || null;
  const result = await setAgentRinging(agentId, loginCh || channelId, channelId, callerNumber, String(uniqueId || ''), String(queueName || ''), campaignName, resolvedTenantId, didTfn || null);
  if (result == null) {
    console.log('[ari-stasis-queue] notifyAgentForQueueCall: agent', agentId, 'could not be rung (busy/offline), will try next');
    return false;
  }
  return true;
}

async function onStasisStart(event) {
  const { channel, args = [] } = event;
  if (!channel?.id) return;
  const channelId = channel.id;
  const callerNumber = (channel.caller?.number || channel.caller?.name || '').toString().trim();

  // Agent login channel (from AgentLogin context): args = ['login', agentId]
  if (args.length >= 2 && args[0] === 'login') {
    const agentId = args[1];
    agentLoginStasisChannels.set(agentId, channelId);
    await startMohOnChannel(channelId);
    return;
  }

  // Outbound channel (from agent dialpad): args = ['outbound', agentChannelId, uniqueId]
  if (args.length >= 2 && args[0] === 'outbound') {
    const agentChannelId = args[1] || '';
    const uniqueId = (args[2] || '').toString().trim();
    pendingOutbound.set(channelId, { agentChannelId, uniqueId });
    return;
  }

  // Supervisor barge/listen: 2 args [bridgeId, mode]
  if (args.length >= 2 && (args[1] === 'barge' || args[1] === 'listen')) {
    const bridgeId = args[0];
    const mode = args[1];
    pendingSupervisorJoin.set(channelId, { bridgeId, mode });
    return;
  }

  // Agent bridge channel (from /calls/answer): 4 args [bridgeId, customerChannelId, uniqueId, agentId]
  if (args.length >= 4) {
    const bridgeId = args[0];
    const customerChannelId = args[1] || null;
    const uniqueId = args[2] || null;
    const agentId = args[3] || null;
    const chanState = (channel.state || '').toLowerCase();
    if (chanState === 'up') {
      const res = await addChannelToBridge(bridgeId, channelId);
      if ((res.status === 200 || res.status === 204) && customerChannelId) {
        activeBridgedCalls.set(customerChannelId, { agentChannelId: channelId, bridgeId, agentId, uniqueId });
      }
    } else {
      pendingAgents.set(channelId, { bridgeId, customerChannelId, uniqueId, agentId });
    }
    return;
  }

  // Customer queue call (from dialplan): 2 args [queueName, uniqueId]
  if (args.length >= 2) {
    const [queueName, uniqueId] = args;
    const qName = String(queueName || '').trim();
    const uId = String(uniqueId || '');
    if (!qName) return;

    await startMohOnChannel(channelId);

    // CampaignName was set in [inbound] dialplan (6th field from InboundRoute); pass to agent UI
    let campaignName = null;
    for (const varName of ['CampaignName', 'CAMPAIGN_NAME', 'CAMPAIGNNAME']) {
      try {
        const raw = await getChannelVariable(channelId, varName);
        if (raw) {
          campaignName = raw.includes('%') ? decodeURIComponent(raw) : raw;
          break;
        }
      } catch (_) {}
    }
    // DID/TFN for reporting (admin/user only)
    let didTfn = null;
    for (const varName of ['DID', 'CallerDnid', 'CALLERID(dnid)']) {
      try {
        const raw = await getChannelVariable(channelId, varName);
        if (raw && String(raw).trim()) {
          didTfn = String(raw).trim();
          break;
        }
      } catch (_) {}
    }

    const { members, strategy: resolvedStrategy, queueName: resolvedQueueName } = await getOrderedQueueMembers(qName);
    const queueNameForPending = resolvedQueueName || qName;
    const queueRow = await queryOne('SELECT tenant_id, timeout FROM queues WHERE name = ? LIMIT 1', [queueNameForPending]);
    const queueTimeoutSec = (queueRow?.timeout != null && parseInt(queueRow.timeout, 10) > 0) ? parseInt(queueRow.timeout, 10) : 60;
    const tenantId = queueRow?.tenant_id ?? null;

    // Create call record on queue entry so wallboard/live monitoring shows incoming queue calls
    if (tenantId != null) {
      await createCallRecord({
        tenantId,
        uniqueId: uId,
        channelId,
        sourceNumber: callerNumber,
        destinationNumber: queueNameForPending,
        direction: 'inbound',
        queueName: queueNameForPending,
        campaignName: campaignName || null,
        didTfn: didTfn || null,
        agentUserId: null,
        agentExtension: null,
        agentId: null,
      });
    }

    let timeoutTimerId = null;
    const doFailover = async () => {
      const pending = pendingCustomers.get(channelId);
      if (!pending || activeBridgedCalls.has(channelId)) return;
      pendingCustomers.delete(channelId);
      if (pending.timeoutTimerId) clearTimeout(pending.timeoutTimerId);
      if (pending.agentRingTimerId) clearTimeout(pending.agentRingTimerId);
      const agentIdForHangup = (pending.agentId && String(pending.agentId).trim()) || null;
      const { action, value } = await getQueueFailover(queueNameForPending);
      const failoverDest = action !== '0' ? value : null;
      const abandonReason = failoverDest ? 'failover' : 'queue_timeout';
      await updateCallRecordAbandon(pending.uniqueId, abandonReason, failoverDest).catch((e) =>
        console.error('[ari-stasis-queue] updateCallRecordAbandon on timeout:', e?.message)
      );
      setAgentHangup(agentIdForHangup, pending.uniqueId, 'abandoned', { skipCallRecordUpdate: true }).catch((e) =>
        console.error('[ari-stasis-queue] setAgentHangup(abandoned) on timeout:', e?.message)
      );
      redirectToQueueFailover(channelId, queueNameForPending).catch((e) => {
        console.error('[ari-stasis-queue] Failover on queue timeout:', e.message);
        hangupChannel(channelId).catch(() => {});
      });
    };

    // Try to ring the first available agent; if they're busy at ring-time, try the next one
    let selectedAgent = null;
    let selectedIndex = -1;
    for (let i = 0; i < members.length; i++) {
      console.log('[ari-stasis-queue] Queue', queueNameForPending, 'strategy=', resolvedStrategy, 'trying member', i, '=', members[i], 'of', members.length);
      const ok = await notifyAgentForQueueCall(channelId, callerNumber, queueNameForPending, uId, members[i], campaignName, didTfn);
      if (ok) {
        selectedAgent = members[i];
        selectedIndex = i;
        break;
      }
    }

    if (queueTimeoutSec > 0) {
      timeoutTimerId = setTimeout(doFailover, queueTimeoutSec * 1000);
    }

    if (!selectedAgent) {
      console.warn('[ari-stasis-queue] Queue has no available agents to ring; call will wait:', queueNameForPending);
      pendingCustomers.set(channelId, {
        agentId: '',
        queueName: queueNameForPending,
        uniqueId: uId,
        memberList: members,
        memberIndex: 0,
        callerNumber: callerNumber,
        campaignName: campaignName || null,
        didTfn: didTfn || null,
        timeoutTimerId,
        joinedAt: Date.now(),
      });
      broadcastQueueChange(queueNameForPending, tenantId);
      return;
    }

    console.log('[ari-stasis-queue] Queue', queueNameForPending, 'ringing agent', selectedAgent, 'index=', selectedIndex);
    pendingCustomers.set(channelId, {
      agentId: String(selectedAgent).replace(/\D/g, ''),
      queueName: queueNameForPending,
      uniqueId: uId,
      memberList: members,
      memberIndex: selectedIndex,
      callerNumber: callerNumber,
      campaignName: campaignName || null,
      didTfn: didTfn || null,
      timeoutTimerId,
      agentRingTimerId: null,
      joinedAt: Date.now(),
    });
    startAgentRingTimer(channelId);
    broadcastQueueChange(queueNameForPending, tenantId);
    return;
  }
}

async function onChannelStateChange(event) {
  const { channel } = event;
  if (!channel?.id) return;
  const state = (channel.state || '').toLowerCase().trim();
  if (state !== 'up') return;

  // Supervisor barge/listen: add to bridge when supervisor answers
  const supervisorInfo = pendingSupervisorJoin.get(channel.id);
  if (supervisorInfo) {
    const { bridgeId, mode } = supervisorInfo;
    const res = await addChannelToBridge(bridgeId, channel.id);
    if (res.status === 200 || res.status === 204) {
      if (mode === 'listen') {
        await muteChannel(channel.id).catch((e) => console.error('[ari-stasis-queue] mute supervisor channel:', e.message));
      }
      pendingSupervisorJoin.delete(channel.id);
    }
    return;
  }

  const info = pendingAgents.get(channel.id);
  if (info) {
    const { bridgeId } = info;
    const res = await addChannelToBridge(bridgeId, channel.id);
    if (res.status === 200 || res.status === 204) {
      pendingAgents.delete(channel.id);
      if (info.customerChannelId) {
        activeBridgedCalls.set(info.customerChannelId, {
          agentChannelId: channel.id,
          bridgeId: info.bridgeId,
          agentId: info.agentId,
          uniqueId: info.uniqueId,
        });
      }
    }
    return;
  }

  // Outbound channel answered: bridge to agent
  const outboundInfo = pendingOutbound.get(channel.id);
  if (!outboundInfo) return;
  const { agentChannelId, uniqueId } = outboundInfo;
  if (!agentChannelId) {
    pendingOutbound.delete(channel.id);
    return;
  }
  const bridgeRes = await createBridge();
  if (bridgeRes.status !== 200 || !bridgeRes.bridgeId) {
    pendingOutbound.delete(channel.id);
    return;
  }
  const addAgent = await addChannelToBridge(bridgeRes.bridgeId, agentChannelId);
  const addOutbound = await addChannelToBridge(bridgeRes.bridgeId, channel.id);
  if ((addAgent.status === 200 || addAgent.status === 204) && (addOutbound.status === 200 || addOutbound.status === 204)) {
    pendingOutbound.delete(channel.id);
    activeOutboundCalls.set(channel.id, { agentChannelId, bridgeId: bridgeRes.bridgeId, uniqueId });
    const agentId = findAgentIdByChannel(agentChannelId);
    if (agentId && uniqueId) await setAgentAnswered(agentId, uniqueId, { direction: 'outbound' }).catch(() => {});
  }
}

async function onChannelDestroyed(event) {
  const { channel } = event;
  if (!channel?.id) return;
  const channelId = channel.id;

  // Login channel destroyed → clean up agent login tracking
  for (const [aid, chId] of agentLoginStasisChannels) {
    if (chId === channelId) {
      agentLoginStasisChannels.delete(aid);
      break;
    }
  }

  // Outbound channel destroyed before answer (e.g. timeout)
  pendingOutbound.delete(channelId);

  // Outbound call: outbound leg hung up → remove agent from bridge, resume MOH, keep agent in Outbound mode
  const outboundBridged = activeOutboundCalls.get(channelId);
  if (outboundBridged) {
    activeOutboundCalls.delete(channelId);
    const isLoginChannel = agentLoginStasisChannels.get(findAgentIdByChannel(outboundBridged.agentChannelId)) === outboundBridged.agentChannelId;
    if (isLoginChannel) {
      await removeChannelFromBridge(outboundBridged.bridgeId, outboundBridged.agentChannelId).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      await startMohOnChannel(outboundBridged.agentChannelId).catch(() => {});
    } else {
      await hangupChannel(outboundBridged.agentChannelId).catch(() => {});
    }
    const agentId = findAgentIdByChannel(outboundBridged.agentChannelId);
    if (agentId && outboundBridged.uniqueId) {
      await setAgentHangup(agentId, outboundBridged.uniqueId, 'completed', { resumeStatus: 'Outbound' });
    }
    return;
  }

  // Outbound call: agent channel destroyed → hang up outbound leg; keep agent in Outbound mode (they may dial again)
  for (const [outChId, obInfo] of activeOutboundCalls) {
    if (obInfo.agentChannelId === channelId) {
      activeOutboundCalls.delete(outChId);
      await hangupChannel(outChId).catch(() => {});
      const agentId = findAgentIdByChannel(channelId);
      if (agentId && obInfo.uniqueId) {
        await setAgentHangup(agentId, obInfo.uniqueId, 'completed', { resumeStatus: 'Outbound' });
      }
      return;
    }
  }

  // Bridged customer destroyed → remove agent from bridge, resume MOH
  const bridged = activeBridgedCalls.get(channelId);
  if (bridged) {
    activeBridgedCalls.delete(channelId);
    pendingCustomers.delete(channelId);
    const isLoginChannel = agentLoginStasisChannels.get(bridged.agentId) === bridged.agentChannelId;
    if (isLoginChannel) {
      await removeChannelFromBridge(bridged.bridgeId, bridged.agentChannelId).catch(() => {});
      await startMohOnChannel(bridged.agentChannelId).catch(() => {});
    } else {
      await hangupChannel(bridged.agentChannelId).catch(() => {});
    }
    if (bridged.agentId && bridged.uniqueId) {
      await setAgentHangup(bridged.agentId, bridged.uniqueId, 'completed');
    }
    setTimeout(() => reassignWaitingCalls().catch((e) => console.error('[ari-stasis-queue] reassign after customer hangup:', e.message)), 500);
    return;
  }

  // Bridged agent destroyed → hang up customer (reverse lookup)
  for (const [custId, info] of activeBridgedCalls) {
    if (info.agentChannelId === channelId) {
      activeBridgedCalls.delete(custId);
      pendingCustomers.delete(custId);
      await hangupChannel(custId).catch(() => {});
      if (info.agentId && info.uniqueId) {
        await setAgentHangup(info.agentId, info.uniqueId, 'completed');
      }
      setTimeout(() => reassignWaitingCalls().catch((e) => console.error('[ari-stasis-queue] reassign after agent hangup:', e.message)), 500);
      return;
    }
  }

  const cust = pendingCustomers.get(channelId);
  if (cust) {
    pendingCustomers.delete(channelId);
    if (cust.timeoutTimerId) clearTimeout(cust.timeoutTimerId);
    if (cust.agentRingTimerId) clearTimeout(cust.agentRingTimerId);
    await updateCallRecordAbandon(cust.uniqueId, 'caller_hangup', null).catch((e) =>
      console.error('[ari-stasis-queue] updateCallRecordAbandon(caller_hangup):', e?.message)
    );
    if (cust.agentId) await setAgentHangup(cust.agentId, cust.uniqueId, 'abandoned', { skipCallRecordUpdate: true });
    return;
  }

  const agentInfo = pendingAgents.get(channelId);
  if (agentInfo) {
    pendingAgents.delete(channelId);
    if (agentInfo.customerChannelId) {
      await hangupChannel(agentInfo.customerChannelId);
    }
    if (agentInfo.uniqueId && agentInfo.agentId) {
      await setAgentHangup(agentInfo.agentId, agentInfo.uniqueId, 'completed');
    }
  }

  pendingSupervisorJoin.delete(channelId);
}

/**
 * Get bridge and channel ids for an agent's active bridged queue call (for barge/whisper/listen).
 * @param {string} agentId - agent_id (phone_login_number)
 * @returns {{ bridgeId: string, agentChannelId: string, customerChannelId: string } | null}
 */
export function getBridgedCallInfo(agentId) {
  const aid = String(agentId || '').replace(/\D/g, '');
  if (!aid) return null;
  const custId = findCustomerIdByAgent(aid);
  if (!custId) return null;
  const info = activeBridgedCalls.get(custId);
  if (!info) return null;
  return {
    bridgeId: info.bridgeId,
    agentChannelId: info.agentChannelId,
    customerChannelId: custId,
  };
}

async function onStasisEnd(event) {
  const { channel } = event;
  if (!channel?.id) return;
  const channelId = channel.id;
  if (activeBridgedCalls.has(channelId)) {
    return;
  }
  if (pendingCustomers.has(channelId)) {
    const cust = pendingCustomers.get(channelId);
    pendingCustomers.delete(channelId);
    if (cust?.timeoutTimerId) clearTimeout(cust.timeoutTimerId);
    if (cust?.agentRingTimerId) clearTimeout(cust.agentRingTimerId);
    if (cust?.uniqueId) {
      await updateCallRecordAbandon(cust.uniqueId, 'caller_hangup', null).catch((e) =>
        console.error('[ari-stasis-queue] updateCallRecordAbandon(caller_hangup) onStasisEnd:', e?.message)
      );
    }
    if (cust?.agentId) await setAgentHangup(cust.agentId, cust.uniqueId, 'abandoned', { skipCallRecordUpdate: true });
  }
}

function handleMessage(data) {
  try {
    const str = typeof data === 'string' ? data : data.toString('utf8');
    const msg = JSON.parse(str);
    const type = msg.type || msg.Event || '';
    switch (type) {
      case 'StasisStart':
        onStasisStart(msg).catch((e) => console.error('[ari-stasis-queue] StasisStart error:', e.message));
        break;
      case 'ChannelStateChange':
        onChannelStateChange(msg).catch((e) => console.error('[ari-stasis-queue] ChannelStateChange error:', e.message));
        break;
      case 'ChannelDestroyed':
        onChannelDestroyed(msg).catch((e) => console.error('[ari-stasis-queue] ChannelDestroyed error:', e.message));
        break;
      case 'StasisEnd':
        onStasisEnd(msg).catch((e) => console.error('[ari-stasis-queue] StasisEnd error:', e.message));
        break;
      default:
        break;
    }
  } catch (e) {
    console.error('[ari-stasis-queue] handleMessage error:', e.message);
  }
}

let ws = null;
let reconnectTimer = null;
const RECONNECT_MS = 10000;

function connect() {
  const url = getWsUrl();
  if (!url) return;
  try {
    ws = new WebSocket(url);
    ws.on('open', () => {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[ari-stasis-queue] WebSocket connected to ARI');
      }
    });
    ws.on('message', handleMessage);
    ws.on('close', () => {
      ws = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
    ws.on('error', (err) => {
      console.error('[ari-stasis-queue] WebSocket error:', err.message);
    });
  } catch (err) {
    console.error('[ari-stasis-queue] connect error:', err.message);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }
}

export async function startQueueStasisClient() {
  if (!process.env.ASTERISK_ARI_URL || !process.env.ASTERISK_ARI_USER) return;
  await loadStateFromRedis().catch(() => {});
  startAriStateSync();
  connect();
}

export function getPendingCustomerChannel(agentId) {
  const aid = String(agentId).replace(/\D/g, '');
  for (const [chId, c] of pendingCustomers) {
    if (c.agentId === aid) return chId;
  }
  return null;
}

/**
 * Start a per-agent ring timer: if agent doesn't answer/reject within AGENT_RING_TIMEOUT_SEC,
 * automatically advance to the next agent in the queue.
 */
function startAgentRingTimer(customerChannelId) {
  const pending = pendingCustomers.get(customerChannelId);
  if (!pending || !pending.agentId) return;
  if (pending.agentRingTimerId) clearTimeout(pending.agentRingTimerId);
  pending.agentRingTimerId = setTimeout(() => {
    const p = pendingCustomers.get(customerChannelId);
    if (!p || activeBridgedCalls.has(customerChannelId)) return;
    console.log('[ari-stasis-queue] Agent ring timeout for agent', p.agentId, 'on queue', p.queueName, '— trying next');
    tryNextQueueAgent(customerChannelId).catch((e) =>
      console.error('[ari-stasis-queue] tryNextQueueAgent on ring timeout:', e.message)
    );
  }, AGENT_RING_TIMEOUT_SEC * 1000);
}

function clearAgentRingTimer(customerChannelId) {
  const pending = pendingCustomers.get(customerChannelId);
  if (pending?.agentRingTimerId) {
    clearTimeout(pending.agentRingTimerId);
    pending.agentRingTimerId = null;
  }
}

/**
 * On agent reject/timeout: try next agents in queue (skip busy ones); if none left, failover.
 */
export async function tryNextQueueAgent(customerChannelId) {
  const pending = pendingCustomers.get(customerChannelId);
  if (!pending) return;
  if (activeBridgedCalls.has(customerChannelId)) return;
  clearAgentRingTimer(customerChannelId);
  const { agentId: rejectingAgentId, queueName, uniqueId, memberList, memberIndex, callerNumber } = pending;
  if (rejectingAgentId) {
    await setAgentHangup(rejectingAgentId, uniqueId, 'completed', { skipCallRecordUpdate: true });
  }

  // Iterate through remaining members, skipping any that are busy
  for (let i = memberIndex + 1; i < memberList.length; i++) {
    const nextExten = memberList[i];
    const nextAgentId = String(nextExten || '').replace(/\D/g, '') || null;
    if (!nextAgentId) continue;

    const queueRow = await queryOne('SELECT tenant_id FROM queues WHERE name = ? LIMIT 1', [String(queueName).trim()]);
    const tenantId = queueRow?.tenant_id ?? null;
    let userRow = tenantId != null ? await resolveAgentUserByExtensionName(tenantId, nextExten) : null;
    if (!userRow) {
      userRow = await queryOne('SELECT id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [nextAgentId]);
    }
    await query(
      'UPDATE call_records SET agent_extension = ?, agent_user_id = ? WHERE unique_id = ? LIMIT 1',
      [nextExten, userRow?.id ?? null, uniqueId]
    );
    const ok = await notifyAgentForQueueCall(customerChannelId, callerNumber || '', queueName, uniqueId, nextExten, pending.campaignName, pending.didTfn);
    if (ok) {
      pending.agentId = nextAgentId;
      pending.memberIndex = i;
      startAgentRingTimer(customerChannelId);
      console.log('[ari-stasis-queue] tryNextQueueAgent: now ringing agent', nextAgentId, 'index=', i);
      return;
    }
    console.log('[ari-stasis-queue] tryNextQueueAgent: agent', nextAgentId, 'busy, trying next');
  }

  // No more agents — failover
  console.log('[ari-stasis-queue] tryNextQueueAgent: exhausted all members for', queueName, '— failover');
  pending.agentId = '';
  pendingCustomers.delete(customerChannelId);
  if (pending.timeoutTimerId) clearTimeout(pending.timeoutTimerId);
  const { action, value } = await getQueueFailover(queueName);
  const failoverDest = action !== '0' ? value : null;
  await updateCallRecordAbandon(uniqueId, failoverDest ? 'failover' : 'no_agents', failoverDest).catch((e) =>
    console.error('[ari-stasis-queue] updateCallRecordAbandon(no_agents):', e?.message)
  );
  setAgentHangup(null, uniqueId, 'abandoned', { skipCallRecordUpdate: true }).catch((e) =>
    console.error('[ari-stasis-queue] setAgentHangup(abandoned) no more agents:', e?.message)
  );
  const redirected = await redirectToQueueFailover(customerChannelId, queueName);
  if (!redirected) await hangupChannel(customerChannelId);
}

/**
 * End a bridged queue call: remove agent from bridge (resume MOH if login channel),
 * hang up customer, update status. Called from /calls/hangup.
 */
export async function hangupBridgedQueueCall(customerChannelId, agentId) {
  const bridged = activeBridgedCalls.get(customerChannelId) || findBridgedByAgent(agentId);
  const custId = bridged ? (activeBridgedCalls.has(customerChannelId) ? customerChannelId : findCustomerIdByAgent(agentId)) : null;
  if (!bridged || !custId) return false;

  activeBridgedCalls.delete(custId);
  pendingCustomers.delete(custId);

  const isLoginChannel = agentLoginStasisChannels.get(bridged.agentId) === bridged.agentChannelId;
  if (isLoginChannel) {
    await removeChannelFromBridge(bridged.bridgeId, bridged.agentChannelId).catch(() => {});
    await startMohOnChannel(bridged.agentChannelId).catch(() => {});
  } else {
    await hangupChannel(bridged.agentChannelId).catch(() => {});
  }
  await hangupChannel(custId).catch(() => {});
  if (bridged.agentId && bridged.uniqueId) {
    await setAgentHangup(bridged.agentId, bridged.uniqueId, 'completed');
  }
  setTimeout(() => reassignWaitingCalls().catch((e) => console.error('[ari-stasis-queue] reassign after dashboard hangup:', e.message)), 500);
  return true;
}

function findBridgedByAgent(agentId) {
  if (!agentId) return null;
  const aid = String(agentId).replace(/\D/g, '');
  for (const [, info] of activeBridgedCalls) {
    if (info.agentId === aid) return info;
  }
  return null;
}

function findCustomerIdByAgent(agentId) {
  if (!agentId) return null;
  const aid = String(agentId).replace(/\D/g, '');
  for (const [custId, info] of activeBridgedCalls) {
    if (info.agentId === aid) return custId;
  }
  return null;
}

const TRANSFER_CONTEXT = process.env.ASTERISK_TRANSFER_CONTEXT || 'TMain';

/**
 * Transfer a bridged queue call to another PJSIP extension.
 * Removes the customer from the bridge, sends the customer channel to dialplan (or redirects to endpoint),
 * then removes the agent from the bridge and updates state. Caller (customer) rings the target extension.
 * @param {string} agentId - agent_id (phone_login_number)
 * @param {string} targetEndpoint - e.g. "PJSIP/7002"
 * @param {string} [transferType] - 'blind' or 'attended'
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function transferBridgedCallToExtension(agentId, targetEndpoint, transferType = 'blind') {
  const aid = String(agentId || '').replace(/\D/g, '');
  if (!aid || !targetEndpoint) return { success: false, error: 'Agent and target extension required' };

  const targetExt = targetEndpoint.replace(/^[^/]+\//, '').trim() || targetEndpoint;

  const custId = findCustomerIdByAgent(aid);
  if (!custId) {
    if (process.env.NODE_ENV !== 'production') console.log('[transfer] No customer channel found for agent', aid, 'activeBridgedCalls size:', activeBridgedCalls.size);
    return { success: false, error: 'No active call to transfer' };
  }

  const bridged = activeBridgedCalls.get(custId);
  if (!bridged) {
    return { success: false, error: 'No active call to transfer' };
  }

  const { bridgeId, agentChannelId, uniqueId } = bridged;

  // Check if target agent has an ARI login channel — if so, bridge directly (no second SIP call)
  const targetLoginChannel = agentLoginStasisChannels.get(targetExt);

  if (targetLoginChannel) {
    return await transferViaAriBridge(custId, bridged, targetExt, targetLoginChannel, transferType);
  }

  // Fallback: target not logged in via ARI — use dialplan TMain
  return await transferViaDialplan(custId, bridged, targetExt, targetEndpoint, transferType);
}

/**
 * ARI-based transfer: reuse target agent's existing login channel. No second SIP call.
 * Same pattern as answerQueueCallWithLoginChannel.
 */
async function transferViaAriBridge(custId, bridged, targetExt, targetLoginChannel, transferType) {
  const { bridgeId, agentChannelId, uniqueId } = bridged;
  const isLoginChannel = agentLoginStasisChannels.get(bridged.agentId) === agentChannelId;

  // Remove customer from current bridge
  const removeCust = await removeChannelFromBridge(bridgeId, custId);
  if (removeCust.status !== 200 && removeCust.status !== 204) {
    console.warn('[transfer-ari] Failed to remove customer from bridge:', removeCust.status, removeCust.body);
    return { success: false, error: 'Failed to remove caller from bridge' };
  }
  activeBridgedCalls.delete(custId);
  pendingCustomers.delete(custId);

  // Free Agent1's login channel back to MOH
  if (isLoginChannel) {
    await removeChannelFromBridge(bridgeId, agentChannelId).catch(() => {});
    await startMohOnChannel(agentChannelId).catch(() => {});
  } else {
    await hangupChannel(agentChannelId).catch(() => {});
  }

  // Record transfer and clear Agent1 state
  await updateCallRecordTransfer(uniqueId, {
    transferFrom: bridged.agentId,
    transferTo: targetExt,
    transferType: transferType || 'blind',
  }).catch(() => {});
  await setAgentHangup(bridged.agentId, uniqueId, 'transferred');

  // Notify Agent2 dashboard (Ringing + "Transfer from")
  await notifyTransferredCallToAgent(targetExt, uniqueId, bridged.agentId, null, targetLoginChannel, custId).catch((e) =>
    console.warn('[transfer-ari] notify target agent:', e?.message || e)
  );

  // Stop MOH on both channels before bridging
  await stopMohOnChannel(targetLoginChannel).catch(() => {});
  await stopMohOnChannel(custId).catch(() => {});

  // Create new bridge and bridge customer with Agent2's login channel
  const newBridge = await createBridge();
  if (newBridge.status !== 200 || !newBridge.bridgeId) {
    console.warn('[transfer-ari] Failed to create bridge for transfer');
    await hangupChannel(custId).catch(() => {});
    return { success: false, error: 'Failed to create bridge for transfer' };
  }

  const addCust = await addChannelToBridge(newBridge.bridgeId, custId);
  if (addCust.status !== 200 && addCust.status !== 204) {
    console.warn('[transfer-ari] Failed to add customer to new bridge:', addCust.status, addCust.body);
    await startMohOnChannel(targetLoginChannel).catch(() => {});
    await hangupChannel(custId).catch(() => {});
    return { success: false, error: 'Failed to bridge caller with target agent' };
  }

  const addAgent2 = await addChannelToBridge(newBridge.bridgeId, targetLoginChannel);
  if (addAgent2.status !== 200 && addAgent2.status !== 204) {
    console.warn('[transfer-ari] Failed to add target agent to bridge:', addAgent2.status, addAgent2.body);
    await startMohOnChannel(targetLoginChannel).catch(() => {});
    await hangupChannel(custId).catch(() => {});
    return { success: false, error: 'Failed to bridge target agent' };
  }

  // Track the new bridged call
  activeBridgedCalls.set(custId, {
    agentChannelId: targetLoginChannel,
    bridgeId: newBridge.bridgeId,
    agentId: targetExt,
    uniqueId: uniqueId || '',
  });

  // Update call record with new agent
  await updateCallRecordAgent(uniqueId, {
    agentExtension: targetExt,
    agentId: targetExt,
  }).catch(() => {});

  // Set Agent2 to "On Call" and broadcast call_answered
  await setAgentAnswered(targetExt, uniqueId).catch((e) =>
    console.warn('[transfer-ari] setAgentAnswered:', e?.message || e)
  );

  console.log('[transfer-ari] Successfully bridged customer', custId, 'with agent', targetExt, 'login channel', targetLoginChannel);

  setTimeout(() => reassignWaitingCalls().catch((e) => console.error('[ari-stasis-queue] reassign after transfer:', e.message)), 500);
  return { success: true };
}

/**
 * Dialplan-based transfer: target has no ARI login channel, use TMain Dial().
 */
async function transferViaDialplan(custId, bridged, targetExt, targetEndpoint, transferType) {
  const { bridgeId, agentChannelId, uniqueId } = bridged;
  activeBridgedCalls.delete(custId);
  pendingCustomers.delete(custId);

  const isLoginChannel = agentLoginStasisChannels.get(bridged.agentId) === agentChannelId;

  const removeCust = await removeChannelFromBridge(bridgeId, custId);
  if (removeCust.status !== 200 && removeCust.status !== 204) {
    activeBridgedCalls.set(custId, bridged);
    console.warn('[transfer-dialplan] Failed to remove customer from bridge:', removeCust.status, removeCust.body);
    return { success: false, error: 'Failed to remove caller from bridge' };
  }

  await setChannelVariable(custId, 'CDRID', uniqueId);
  await setChannelVariable(custId, 'AgentNumber', bridged.agentId);

  let sent = false;
  const continueRes = await continueInDialplan(custId, TRANSFER_CONTEXT, targetExt, 1);
  if (continueRes.status === 200 || continueRes.status === 204) {
    sent = true;
  } else {
    const redirectWithCtx = await redirectChannel(custId, targetEndpoint, TRANSFER_CONTEXT, targetExt);
    if (redirectWithCtx.status === 200 || redirectWithCtx.status === 204) {
      sent = true;
    } else {
      const redirectRes = await redirectChannel(custId, targetEndpoint);
      if (redirectRes.status === 200 || redirectRes.status === 204) {
        sent = true;
      } else {
        console.warn('[transfer-dialplan] continueInDialplan and redirect failed. continue:', continueRes.status, 'redirect:', redirectRes.status, redirectRes.body?.slice(0, 200));
        await hangupChannel(custId).catch(() => {});
      }
    }
  }

  if (isLoginChannel) {
    await removeChannelFromBridge(bridgeId, agentChannelId).catch(() => {});
    await startMohOnChannel(agentChannelId).catch(() => {});
  } else {
    await hangupChannel(agentChannelId).catch(() => {});
  }

  await setAgentHangup(bridged.agentId, uniqueId, sent ? 'transferred' : 'completed');
  if (sent) {
    await updateCallRecordTransfer(uniqueId, {
      transferFrom: bridged.agentId,
      transferTo: targetExt,
      transferType: transferType || 'blind',
    }).catch(() => {});
    await notifyTransferredCallToAgent(targetExt, uniqueId, bridged.agentId).catch((e) =>
      console.warn('[transfer-dialplan] notify target agent:', e?.message || e)
    );
  }

  setTimeout(() => reassignWaitingCalls().catch((e) => console.error('[ari-stasis-queue] reassign after transfer:', e.message)), 500);
  if (!sent) {
    return { success: false, error: 'Transfer failed: could not connect caller to extension. Check Asterisk has dialplan context "' + TRANSFER_CONTEXT + '" with extension ' + targetExt + ' (e.g. Dial(PJSIP/' + targetExt + ')).' };
  }
  return { success: true };
}

/**
 * Answer a queue call by bridging the agent's login channel with the customer.
 * No new PJSIP call needed - reuses the existing login channel.
 */
export async function answerQueueCallWithLoginChannel(customerChannelId, agentId, uniqueId) {
  const aid = String(agentId).replace(/\D/g, '');
  const loginChannelId = agentLoginStasisChannels.get(aid);
  if (!loginChannelId) {
    return { success: false, error: 'Agent login channel not found in Stasis. Try logging in again from the agent console.' };
  }

  if (!customerChannelId) {
    return { success: false, error: 'Customer call no longer available. The caller may have hung up.' };
  }

  await stopMohOnChannel(loginChannelId).catch(() => {});
  await stopMohOnChannel(customerChannelId).catch(() => {});

  const bridgeRes = await createBridge();
  if (bridgeRes.status !== 200 || !bridgeRes.bridgeId) {
    return { success: false, error: 'Failed to create bridge' };
  }

  const answerCust = await answerChannel(customerChannelId);
  if (answerCust.status !== 200 && answerCust.status !== 204) {
    console.warn('[ari-stasis-queue] Answer customer channel failed:', answerCust.status, answerCust.body);
    return { success: false, error: 'Could not answer caller. The call may have ended or timed out.' };
  }

  const addCust = await addChannelToBridge(bridgeRes.bridgeId, customerChannelId);
  if (addCust.status !== 200 && addCust.status !== 204) {
    await startMohOnChannel(loginChannelId).catch(() => {});
    const msg = parseAriError(addCust.body) || 'The caller may have hung up.';
    return { success: false, error: `Failed to add customer to bridge: ${msg}` };
  }

  const addAgent = await addChannelToBridge(bridgeRes.bridgeId, loginChannelId);
  if (addAgent.status !== 200 && addAgent.status !== 204) {
    await startMohOnChannel(loginChannelId).catch(() => {});
    const msg = parseAriError(addAgent.body) || 'Agent channel may have been disconnected.';
    return { success: false, error: `Failed to add agent to bridge: ${msg}` };
  }

  activeBridgedCalls.set(customerChannelId, {
    agentChannelId: loginChannelId,
    bridgeId: bridgeRes.bridgeId,
    agentId: aid,
    uniqueId: uniqueId || '',
  });
  const pending = pendingCustomers.get(customerChannelId);
  if (pending?.timeoutTimerId) {
    clearTimeout(pending.timeoutTimerId);
    pending.timeoutTimerId = null;
  }
  clearAgentRingTimer(customerChannelId);
  // Remove from waiting count so wallboard shows correct "calls waiting"
  if (pending) {
    pendingCustomers.delete(customerChannelId);
    const queueName = pending.queueName || '';
    if (queueName) {
      const queueRow = await queryOne('SELECT tenant_id FROM queues WHERE name = ? LIMIT 1', [queueName]).catch(() => null);
      if (queueRow?.tenant_id) broadcastQueueChange(queueName, queueRow.tenant_id);
    }
  }

  return { success: true };
}

export function getAgentLoginChannel(agentId) {
  const aid = String(agentId || '').replace(/\D/g, '');
  return agentLoginStasisChannels.get(aid) || null;
}

/**
 * Force logout an agent from supervisor/live-monitoring: hang up Asterisk channels and clear in-memory state.
 * Does not update DB; caller must set agent_status to LoggedOut and clear agent_extension_usage.
 */
export async function forceLogoutAgent(agentId) {
  const aid = String(agentId || '').replace(/\D/g, '');
  if (!aid) return { success: false, error: 'Invalid agent' };
  const custId = findCustomerIdByAgent(aid);
  if (custId) {
    await hangupBridgedQueueCall(custId, aid).catch(() => {});
  }
  const loginCh = agentLoginStasisChannels.get(aid);
  if (loginCh) {
    agentLoginStasisChannels.delete(aid);
    await hangupChannel(loginCh).catch(() => {});
  }
  return { success: true };
}

export function setPendingAgentInfo(agentChannelId, customerChannelId, uniqueId, agentId) {
  const info = pendingAgents.get(agentChannelId);
  if (info) {
    info.customerChannelId = customerChannelId;
    info.uniqueId = uniqueId;
    info.agentId = agentId;
  }
}

/**
 * Returns waiting-call counts from in-memory pendingCustomers.
 * @returns {{ total: number, byQueue: Record<string, { count: number, longestWaitMs: number }> }}
 */
export function getQueueWaitingCounts() {
  return getQueueWaitingCountsInternal();
}

/**
 * Called when an agent becomes available (after hangup/break-end).
 * Checks pendingCustomers for calls that have no agent assigned (agentId: '') and
 * tries to offer the longest-waiting call to an available agent.
 */
export async function reassignWaitingCalls() {
  let oldest = null;
  let oldestChId = null;
  for (const [chId, c] of pendingCustomers) {
    if (activeBridgedCalls.has(chId)) continue;
    if (c.agentId && c.agentId !== '') continue;
    if (!oldest || (c.joinedAt && c.joinedAt < oldest.joinedAt)) {
      oldest = c;
      oldestChId = chId;
    }
  }
  if (!oldest || !oldestChId) return;

  const { queueName, uniqueId, callerNumber, campaignName, didTfn } = oldest;
  console.log('[ari-stasis-queue] reassignWaitingCalls: found waiting call', uniqueId, 'in queue', queueName);

  const { members } = await getOrderedQueueMembers(queueName);
  if (members.length === 0) {
    console.log('[ari-stasis-queue] reassignWaitingCalls: still no available agents for', queueName);
    return;
  }

  for (let i = 0; i < members.length; i++) {
    const ok = await notifyAgentForQueueCall(oldestChId, callerNumber || '', queueName, uniqueId, members[i], campaignName, didTfn);
    if (ok) {
      oldest.agentId = String(members[i]).replace(/\D/g, '');
      oldest.memberList = members;
      oldest.memberIndex = i;
      startAgentRingTimer(oldestChId);
      console.log('[ari-stasis-queue] reassignWaitingCalls: ringing agent', members[i], 'for waiting call', uniqueId);
      const queueRow = await queryOne('SELECT tenant_id FROM queues WHERE name = ? LIMIT 1', [String(queueName).trim()]).catch(() => null);
      if (queueRow?.tenant_id) broadcastQueueChange(queueName, queueRow.tenant_id);
      return;
    }
  }
  console.log('[ari-stasis-queue] reassignWaitingCalls: no available agent could be rung for', queueName);
}
