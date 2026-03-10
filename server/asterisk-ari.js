/**
 * ARI (Asterisk REST Interface) helper. Used to originate the agent-login call to the SIP extension.
 * Configure via .env: ASTERISK_ARI_URL, ASTERISK_ARI_USER, ASTERISK_ARI_PASSWORD
 */
const ARI_BASE = process.env.ASTERISK_ARI_URL || ''; // e.g. http://10.50.2.190:8088
const ARI_USER = process.env.ASTERISK_ARI_USER || '';
const ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || '';

export function isAriConfigured() {
  return Boolean(ARI_BASE && ARI_USER);
}

/**
 * Originate a call to PJSIP endpoint, execute extension s in the given context with channel variables.
 * Uses PJSIP/ (not SIP/) so it works when chan_sip is not loaded.
 * @param {string} channelId - Unique channel id (e.g. "Agent-1001-abc123")
 * @param {string} extensionNumber - Extension to ring (e.g. "1001")
 * @param {string} context - Dialplan context (e.g. "AgentLogin")
 * @param {object} variables - Channel variables (e.g. { AgentNumber: "1001", AgentPassword: "1234" })
 * @param {number} timeout - Ring timeout in seconds
 * @returns {Promise<{ status: number, body: string }>} ARI response status and body (for logging/errors)
 */
export async function originateAgentLogin(channelId, extensionNumber, context, variables, timeout = 45) {
  if (!ARI_BASE || !ARI_USER) {
    throw new Error('ARI not configured: set ASTERISK_ARI_URL, ASTERISK_ARI_USER, ASTERISK_ARI_PASSWORD in .env');
  }
  const hangupHandler = `${context},callstatus,1`;
  const body = {
    variables: {
      'CHANNEL(hangup_handler_push)': hangupHandler,
      ...variables,
    },
  };
  const params = new URLSearchParams({
    endpoint: `PJSIP/${extensionNumber}`,
    extension: 's',
    context,
    callerId: extensionNumber,
    timeout: String(timeout),
  });
  const url = `${ARI_BASE.replace(/\/$/, '')}/ari/channels/${channelId}?${params}`;
  const auth = Buffer.from(`${ARI_USER}:${ARI_PASSWORD}`).toString('base64');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    const msg = err.cause?.code === 'ECONNREFUSED'
      ? `Cannot reach Asterisk ARI at ${ARI_BASE}. Check ASTERISK_ARI_URL and firewall.`
      : err.message || 'Network error calling Asterisk ARI';
    throw new Error(msg);
  }
  const text = await res.text();
  return { status: res.status, body: text };
}

/**
 * Hang up a channel by ID (e.g. the agent login channel). Used when agent logs out from the dashboard.
 * @param {string} channelId - Channel id (e.g. "Agent-1001-abc123")
 * @returns {Promise<{ status: number, body: string }>} ARI response; 404 if channel already gone
 */
async function ariRequest(path, options = {}) {
  if (!ARI_BASE || !ARI_USER) return { status: 0, body: '' };
  const base = ARI_BASE.replace(/\/$/, '');
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/ari/${path}`}`;
  const auth = Buffer.from(`${ARI_USER}:${ARI_PASSWORD}`).toString('base64');
  try {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Basic ${auth}`, ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (err) {
    console.error('ARI request error:', err.message);
    return { status: 0, body: err.message || 'Network error' };
  }
}

/**
 * Hang up a channel by ID (e.g. the agent login channel). Used when agent logs out from the dashboard.
 * @param {string} channelId - Channel id (e.g. "Agent-1001-abc123")
 * @returns {Promise<{ status: number, body: string }>} ARI response; 404 if channel already gone
 */
export async function hangupChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}

/**
 * Get a channel variable (e.g. CampaignName set by dialplan before Stasis).
 * @param {string} channelId - Channel id
 * @param {string} variableName - Variable name (e.g. "CampaignName")
 * @returns {Promise<string|null>} Variable value or null if not set / error
 */
export async function getChannelVariable(channelId, variableName) {
  if (!channelId || !variableName) return null;
  const res = await ariRequest(
    `/ari/channels/${encodeURIComponent(channelId)}/variable?variable=${encodeURIComponent(variableName)}`,
    { method: 'GET' }
  );
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body);
    const val = data?.value;
    return val != null ? String(val).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Set a channel variable (e.g. before redirect for queue failover).
 * @param {string} channelId
 * @param {string} variableName
 * @param {string} value
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function setChannelVariable(channelId, variableName, value) {
  if (!channelId || !variableName) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/variable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variable: variableName, value: value != null ? String(value) : '' }),
  });
}

/**
 * Redirect channel to a dialplan context (e.g. QueueFailover). Uses Local channel so the channel runs in that context with same vars.
 * Note: ARI requires endpoint technology to match channel technology. PJSIP channels cannot redirect to Local; use redirectToQueueFailoverContext for queue failover.
 * @param {string} channelId
 * @param {string} context - dialplan context name
 * @param {string} [extension='s']
 * @param {number} [priority=1]
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function redirectToContext(channelId, context, extension = 's', priority = 1) {
  if (!channelId || !context) return { status: 0, body: '' };
  const endpoint = `Local/${extension}@${context}`;
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/redirect?endpoint=${encodeURIComponent(endpoint)}`, {
    method: 'POST',
  });
}

/** PJSIP endpoint name used for queue failover (must have context=QueueFailover in Asterisk). */
const QUEUE_FAILOVER_PJSIP_ENDPOINT = 'queue-failover';

/**
 * Redirect a channel (typically PJSIP) to the QueueFailover dialplan context.
 * Uses a PJSIP endpoint so technology matches (ARI rejects Local endpoint for PJSIP channels).
 * The endpoint "queue-failover" is synced by config sync with context=QueueFailover.
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function redirectToQueueFailoverContext(channelId) {
  if (!channelId) return { status: 0, body: '' };
  const endpoint = `PJSIP/${QUEUE_FAILOVER_PJSIP_ENDPOINT}`;
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/redirect?endpoint=${encodeURIComponent(endpoint)}`, {
    method: 'POST',
  });
}

/**
 * Continue channel in dialplan at the given context/extension/priority (e.g. leave Stasis and run QueueFailover).
 * Use this for queue failover so the channel runs dialplan without redirecting to a PJSIP endpoint.
 * @param {string} channelId
 * @param {string} context - e.g. 'QueueFailover'
 * @param {string} [extension='s']
 * @param {number} [priority=1]
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function continueInDialplan(channelId, context, extension = 's', priority = 1) {
  if (!channelId || !context) return { status: 0, body: '' };
  const params = new URLSearchParams({ context, extension, priority: String(priority) });
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/continue?${params}`, {
    method: 'POST',
  });
}

/**
 * Answer a channel (ringing -> answered).
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function answerChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/answer`, { method: 'POST' });
}

export async function startMohOnChannel(channelId, mohClass) {
  if (!channelId) return { status: 0, body: '' };
  const qs = mohClass ? `?mohClass=${encodeURIComponent(mohClass)}` : '';
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/moh${qs}`, { method: 'POST', timeoutMs: 5000 });
}

export async function stopMohOnChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/moh`, { method: 'DELETE', timeoutMs: 5000 });
}

/**
 * Put channel on hold.
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function holdChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/hold`, { method: 'POST' });
}

/**
 * Remove channel from hold.
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function unholdChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/hold`, { method: 'DELETE' });
}

/**
 * Mute a channel (outbound audio only). Used for listen-only supervisor on bridge.
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function muteChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/mute`, { method: 'POST' });
}

/**
 * Unmute a channel.
 * @param {string} channelId
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function unmuteChannel(channelId) {
  if (!channelId) return { status: 0, body: '' };
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/mute`, { method: 'DELETE' });
}

/**
 * Redirect channel to an endpoint (e.g. for blind transfer).
 * @param {string} channelId
 * @param {string} endpoint - e.g. "PJSIP/1002" or "Local/1002@context"
 * @param {string} [context] - optional dialplan context for redirect
 * @param {string} [extension] - optional dialplan extension for redirect
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function redirectChannel(channelId, endpoint, context, extension) {
  if (!channelId || !endpoint) return { status: 0, body: '' };
  const params = new URLSearchParams({ endpoint });
  if (context) params.set('context', context);
  if (extension) params.set('extension', extension);
  return ariRequest(`/ari/channels/${encodeURIComponent(channelId)}/redirect?${params}`, {
    method: 'POST',
  });
}

/**
 * Originate outbound call (trunk to number). Dialplan should handle bridge to agent.
 * @param {string} channelId - unique channel id
 * @param {string} endpoint - e.g. "PJSIP/trunk_name/15551234567"
 * @param {string} [callerId] - caller ID to present
 * @param {number} [timeout] - ring timeout seconds
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function originateOutbound(channelId, endpoint, callerId = '', timeout = 60) {
  if (!ARI_BASE || !ARI_USER || !channelId || !endpoint) {
    return { status: 0, body: '' };
  }
  const params = new URLSearchParams({
    endpoint,
    extension: 's',
    context: 'default',
    callerId: callerId || 'Outbound',
    timeout: String(timeout),
  });
  return ariRequest(`/ari/channels/${channelId}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeoutMs: 15000,
  });
}

/**
 * Fetch PJSIP endpoint list from ARI to determine registration status.
 * GET /ari/endpoints/pjsip returns list of endpoints with resource and state.
 * @returns {Promise<Record<string, string>>} Map of endpoint resource (extension name) -> state (e.g. "online", "offline", "unknown")
 */
export async function getPjsipEndpointStates() {
  if (!ARI_BASE || !ARI_USER) return {};
  let list = [];
  const result = await ariRequest('endpoints/pjsip', { timeoutMs: 5000 });
  if (result.status === 200 && result.body) {
    try {
      const data = JSON.parse(result.body);
      list = Array.isArray(data) ? data : (data.endpoints || []);
    } catch (_) {
      list = [];
    }
  }

  if (list.length === 0) {
    const allResult = await ariRequest('endpoints', { timeoutMs: 5000 });
    if (allResult.status === 200 && allResult.body) {
      try {
        const data = JSON.parse(allResult.body);
        const allList = Array.isArray(data) ? data : (data.endpoints || []);
        list = allList.filter((ep) => String(ep.technology || ep.tech || '').toLowerCase() === 'pjsip');
      } catch (_) {
        list = [];
      }
    }
  }

  const map = {};
  for (const ep of list) {
    let key = ep.resource ?? ep.name ?? ep.id ?? '';
    key = String(key).replace(/^pjsip\//i, '').trim();
    if (!key) key = String(ep.resource ?? ep.name ?? ep.id ?? '').trim();
    const state = ep.state ?? ep.device_state ?? ep.deviceState ?? 'unknown';
    if (key) map[key] = state;
  }
  if (list.length === 0 && process.env.NODE_ENV !== 'production') {
    console.log('[ARI endpoints] No PJSIP endpoints returned. Check ASTERISK_ARI_URL, ASTERISK_ARI_USER and that Asterisk ARI is enabled.');
  }
  return map;
}

/** Raw ARI endpoints for debugging. */
export async function getPjsipEndpointsRaw() {
  if (!ARI_BASE || !ARI_USER) return { configured: false, pjsip: { status: 0, body: '' }, all: { status: 0, body: '' } };
  const pjsip = await ariRequest('endpoints/pjsip', { timeoutMs: 5000 });
  const all = await ariRequest('endpoints', { timeoutMs: 5000 });
  return { configured: true, pjsip: { status: pjsip.status, body: pjsip.body }, all: { status: all.status, body: all.body } };
}

// ----- Queue dashboard flow: bridge + originate into Stasis (no phone ring until agent clicks Answer) -----

const QUEUE_STASIS_APP = 'queue-dashboard';

/**
 * Create a mixing bridge. Returns { status, body, bridgeId }.
 */
export async function createBridge() {
  const res = await ariRequest('/ari/bridges?type=mixing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeoutMs: 5000,
  });
  let bridgeId = null;
  if (res.status === 200 && res.body) {
    try {
      const data = JSON.parse(res.body);
      bridgeId = data.id || null;
    } catch (_) {}
  }
  return { status: res.status, body: res.body, bridgeId };
}

/**
 * Add a channel to a bridge.
 */
export async function addChannelToBridge(bridgeId, channelId) {
  if (!bridgeId || !channelId) return { status: 0, body: '' };
  return ariRequest(
    `/ari/bridges/${encodeURIComponent(bridgeId)}/addChannel?channel=${encodeURIComponent(channelId)}`,
    { method: 'POST', timeoutMs: 5000 }
  );
}

/**
 * Remove a channel from a bridge (optional; hangup also removes).
 */
export async function removeChannelFromBridge(bridgeId, channelId) {
  if (!bridgeId || !channelId) return { status: 0, body: '' };
  return ariRequest(
    `/ari/bridges/${encodeURIComponent(bridgeId)}/removeChannel?channel=${encodeURIComponent(channelId)}`,
    { method: 'POST', timeoutMs: 5000 }
  );
}

/**
 * Originate a call to endpoint and put the channel into the Stasis app with appArgs.
 * Used when agent clicks Answer: ring agent's phone and when they answer, add to bridge.
 *
 * When `sipHeaders` are provided, uses create → setVar → dial so that
 * PJSIP_HEADER() dialplan functions are evaluated on the PJSIP channel
 * before the SIP INVITE is sent.
 *
 * @param {string} channelId - unique channel id (e.g. QueueAgent-7002-abc123)
 * @param {string} endpoint - e.g. PJSIP/7002
 * @param {string} app - Stasis app name (e.g. queue-dashboard)
 * @param {string[]} appArgs - args for Stasis (e.g. [bridgeId])
 * @param {number} timeout - ring timeout seconds
 * @param {Record<string, string>} [sipHeaders] - PJSIP_HEADER variables for auto-answer etc.
 */
export async function originateIntoStasis(channelId, endpoint, app, appArgs, timeout = 45, sipHeaders) {
  if (!ARI_BASE || !ARI_USER || !channelId || !endpoint || !app) {
    return { status: 0, body: '' };
  }

  if (sipHeaders && Object.keys(sipHeaders).length > 0) {
    const createParams = new URLSearchParams({ endpoint, app, channelId });
    if (appArgs && appArgs.length) {
      createParams.set('appArgs', appArgs.join(','));
    }
    const createRes = await ariRequest(`/ari/channels/create?${createParams}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      timeoutMs: 10000,
    });
    if (createRes.status !== 200) return createRes;

    for (const [varName, varValue] of Object.entries(sipHeaders)) {
      const varParams = new URLSearchParams({ variable: varName, value: varValue });
      await ariRequest(
        `/ari/channels/${encodeURIComponent(channelId)}/variable?${varParams}`,
        { method: 'POST', timeoutMs: 5000 }
      );
    }

    return ariRequest(
      `/ari/channels/${encodeURIComponent(channelId)}/dial?timeout=${timeout}`,
      { method: 'POST', timeoutMs: (timeout + 5) * 1000 }
    );
  }

  const params = new URLSearchParams({ endpoint, app, timeout: String(timeout) });
  if (appArgs && appArgs.length) {
    params.set('appArgs', appArgs.join(','));
  }
  return ariRequest(`/ari/channels/${channelId}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeoutMs: (timeout + 5) * 1000,
  });
}

export function getQueueStasisAppName() {
  return QUEUE_STASIS_APP;
}

/**
 * Originate a call to PJSIP endpoint with context and extension (dialplan), and channel variables.
 * Used for supervisor whisper: ring supervisor, when they answer dialplan runs ChanSpy(agentChannel, qw).
 * @param {string} channelId - unique channel id (e.g. Supervisor-7002-xyz)
 * @param {string} supervisorExtension - extension to ring (e.g. "7002")
 * @param {string} context - dialplan context (e.g. "BargeMe")
 * @param {string} extension - dialplan extension (e.g. "s")
 * @param {Record<string, string>} variables - channel variables (e.g. { BargeChannel: "ch-id", Mode: "whisper" })
 * @param {number} timeout - ring timeout seconds
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function originateToContext(channelId, supervisorExtension, context, extension, variables, timeout = 45) {
  if (!ARI_BASE || !ARI_USER || !channelId || !supervisorExtension || !context) {
    return { status: 0, body: '' };
  }
  const params = new URLSearchParams({
    endpoint: `PJSIP/${supervisorExtension}`,
    extension: extension || 's',
    context,
    callerId: supervisorExtension,
    timeout: String(timeout),
  });
  const body = { variables: variables || {} };
  return ariRequest(`/ari/channels/${channelId}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: (timeout + 5) * 1000,
  });
}
