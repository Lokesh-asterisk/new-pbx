import { z } from 'zod';

// ─── Reusable field types ─────────────────────────────────────────────────────

const str = z.string().trim();
const optStr = z.string().trim().optional().or(z.literal(''));
const posInt = z.coerce.number().int().positive();
const optPosInt = z.coerce.number().int().positive().optional();
const optNonNeg = z.coerce.number().int().nonnegative().optional();

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  username: str.min(1, 'Username is required'),
  password: str.min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  current_password: str.min(1, 'Current password is required'),
  new_password: str.min(6, 'New password must be at least 6 characters'),
});

// ─── Agent ────────────────────────────────────────────────────────────────────

export const breakStartSchema = z.object({
  reason: optStr,
});

export const breakEndSchema = z.object({
  startTime: z.union([z.string(), z.number()]).optional(),
  reason: optStr,
});

export const selectExtensionSchema = z.object({
  extension_id: posInt.optional(),
  extension_name: optStr,
}).refine(d => d.extension_id || d.extension_name, {
  message: 'Either extension_id or extension_name is required',
});

export const blockNumberSchema = z.object({
  number: str.min(1, 'Phone number is required'),
});

export const callExtensionSchema = z.object({
  extension_id: posInt.optional(),
  extension_name: optStr,
});

export const channelActionSchema = z.object({
  channel_id: optStr,
  channelId: optStr,
});

export const transferSchema = z.object({
  target: optStr,
  extension: optStr,
  type: z.enum(['blind', 'attended']).optional().default('blind'),
}).refine(d => d.target || d.extension, {
  message: 'Transfer target is required',
});

export const dialSchema = z.object({
  number: optStr,
  destination: optStr,
}).refine(d => d.number || d.destination, {
  message: 'Number or destination is required',
});

// ─── Admin ────────────────────────────────────────────────────────────────────

export const blacklistSchema = z.object({
  tenant_id: optPosInt,
  number: str.min(1, 'Number or pattern is required'),
  match_type: z.enum(['exact', 'prefix', 'suffix', 'contains', 'regex']).optional().default('exact'),
});

export const monitorSchema = z.object({
  agent_id: optPosInt,
  mode: z.enum(['listen', 'whisper', 'barge']).optional().default('listen'),
  supervisor_extension: optStr,
});

// ─── SuperAdmin: Users ────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  username: str.min(1, 'Username is required'),
  password: str.min(4, 'Password must be at least 4 characters'),
  role: z.enum(['superadmin', 'admin', 'user', 'agent']),
  email: z.string().email().optional().or(z.literal('')),
  parent_id: optPosInt,
  phone_login_number: optStr,
  phone_login_password: optStr,
});

export const createTenantSchema = z.object({
  name: str.min(1, 'Tenant name is required'),
});

// ─── SuperAdmin: SIP / Trunks ─────────────────────────────────────────────────

export const createSipExtensionSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Extension name is required'),
  secret: str.min(1, 'Secret is required'),
  context: optStr,
  host: optStr,
  type: optStr,
  failover_destination_type: optStr,
  failover_destination_id: optPosInt,
});

export const createSipTrunkSchema = z.object({
  tenant_id: posInt,
  trunk_name: str.min(1, 'Trunk name is required'),
  config_json: optStr,
});

// ─── SuperAdmin: Campaigns / Routes ───────────────────────────────────────────

export const createCampaignSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Campaign name is required'),
  description: optStr,
});

export const createInboundRouteSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Route name is required'),
  did: str.min(1, 'DID is required'),
  destination_type: str.min(1, 'Destination type is required'),
  destination_id: posInt,
  campaign_id: optPosInt,
});

export const outboundRouteSchema = z.object({
  tenant_id: posInt,
  trunk_id: posInt,
});

// ─── SuperAdmin: Queues ───────────────────────────────────────────────────────

export const createQueueSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Queue name is required'),
  display_name: optStr,
  strategy: z.enum(['ringall', 'roundrobin', 'leastrecent', 'fewestcalls', 'random', 'rrmemory']).optional().default('ringall'),
  timeout: optNonNeg,
  failover_destination_type: optStr,
  failover_destination_id: optPosInt,
});

export const addQueueMemberSchema = z.object({
  member_name: str.min(1, 'Member name is required'),
});

// ─── SuperAdmin: IVR / Time / Voicemail ───────────────────────────────────────

export const createIvrMenuSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'IVR menu name is required'),
  config: z.any().optional(),
  options: z.any().optional(),
});

export const createTimeGroupSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Time group name is required'),
  description: optStr,
  rules: z.any().optional(),
});

export const createTimeConditionSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Time condition name is required'),
  time_group_id: posInt,
  match_destination_type: str.min(1),
  match_destination_id: posInt,
  nomatch_destination_type: str.min(1),
  nomatch_destination_id: posInt,
});

export const createSoundFileSchema = z.object({
  tenant_id: posInt,
  name: str.min(1, 'Sound file name is required'),
  file_path: str.min(1, 'File path is required'),
});

export const createVoicemailBoxSchema = z.object({
  tenant_id: posInt,
  mailbox: str.min(1, 'Mailbox number is required'),
  password: optStr,
  email: z.string().email().optional().or(z.literal('')),
  config: z.any().optional(),
});

export const roleModuleSchema = z.object({
  role: str.min(1, 'Role is required'),
  module_key: str.min(1, 'Module key is required'),
  enabled: z.boolean(),
});

// ─── Wallboard ────────────────────────────────────────────────────────────────

export const wallboardMonitorSchema = z.object({
  agent_id: posInt,
  mode: z.enum(['listen', 'whisper', 'barge']).optional().default('listen'),
  supervisor_extension: optStr,
});

// ─── Validation middleware factory ────────────────────────────────────────────

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map(i => i.message).join('; ');
      return res.status(400).json({ success: false, error: errors });
    }
    req.body = result.data;
    next();
  };
}
