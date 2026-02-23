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
