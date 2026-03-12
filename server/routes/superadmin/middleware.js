import { query, queryOne } from '../../db.js';

export const ROLE_IDS = { superadmin: 1, admin: 2, user: 3, campaign: 4, agent: 5 };

export const PATH_MODULE_MAP = {
  'users': 'users',
  'tenants': 'tenants',
  'sip-extensions': 'extensions',
  'debug-ari-endpoints': 'extensions',
  'sip-trunks': 'trunks',
  'campaigns': 'campaigns',
  'stats': 'dashboard',
  'inbound-routes': 'inbound',
  'outbound-routes': 'outbound',
  'queues': 'queues',
  'ivr-menus': 'ivr',
  'time-conditions': 'timeconditions',
  'time-groups': 'timeconditions',
  'sound-files': 'sounds',
  'voicemail-boxes': 'voicemail',
  'live-agents': ['wallboard', 'live_agents'],
  'cdr': 'cdr',
  'asterisk-logs': '_system',
};

export function requireSuperadmin(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ success: false, error: 'Not authenticated' });
  if (user.role !== 'superadmin') return res.status(403).json({ success: false, error: 'Superadmin only' });
  next();
}

export function requireModuleAccess(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ success: false, error: 'Not authenticated' });
  if (user.role === 'superadmin') return next();
  const firstSegment = req.path.split('/').filter(Boolean)[0] || '';
  const required = PATH_MODULE_MAP[firstSegment];
  if (!required) return res.status(403).json({ success: false, error: 'Superadmin only' });
  const allowed = Array.isArray(required) ? required : [required];
  if (Array.isArray(user.modules) && allowed.some(m => user.modules.includes(m))) return next();
  return res.status(403).json({ success: false, error: 'Module not enabled for your role' });
}

export function getEffectiveTenantId(req) {
  const user = req.session?.user;
  if (!user || user.role === 'superadmin') return null;
  const pid = user.parent_id;
  if (pid == null || pid === '') return null;
  const n = parseInt(pid, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

export async function ensureSipExtensionForAgent(tenantId, extensionName, secret) {
  const tid = (tenantId != null && tenantId !== '' && !Number.isNaN(Number(tenantId)))
    ? Number(tenantId) : 1;
  const name = String(extensionName).trim();
  if (!name) return;
  const ext = await queryOne(
    'SELECT id FROM sip_extensions WHERE tenant_id = ? AND name = ? LIMIT 1',
    [tid, name]
  );
  if (!ext) {
    await query(
      `INSERT INTO sip_extensions (tenant_id, name, secret, context, host, type)
       VALUES (?, ?, ?, 'from-internal', NULL, 'friend')`,
      [tid, name, secret || name]
    );
  }
}
