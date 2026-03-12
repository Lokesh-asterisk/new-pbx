/**
 * Single source of truth for permissionable modules (Role Permissions).
 * Keep in sync with SuperAdmin sidebar: same moduleKey in ALL_NAV_GROUPS.
 * Adding a new entry here makes it show in Role Permissions automatically.
 */
const ALL_MODULES = [
  { key: 'dashboard',      label: 'Dashboard',             group: 'Reports & Monitoring' },
  { key: 'cdr',            label: 'CDR & Recordings',       group: 'Reports & Monitoring' },
  { key: 'wallboard',      label: 'Wallboard',              group: 'Reports & Monitoring' },
  { key: 'live_agents',    label: 'Agent Live Monitoring',  group: 'Reports & Monitoring' },
  { key: 'tenants',        label: 'Tenants',                group: 'User Management' },
  { key: 'users',          label: 'Users',                  group: 'User Management' },
  { key: 'extensions',     label: 'PJSIP Extensions',       group: 'PBX Configuration' },
  { key: 'trunks',         label: 'SIP Trunks',             group: 'PBX Configuration' },
  { key: 'campaigns',      label: 'Campaigns',             group: 'PBX Configuration' },
  { key: 'inbound',        label: 'Inbound Routes',         group: 'PBX Configuration' },
  { key: 'outbound',       label: 'Outbound Routes',        group: 'PBX Configuration' },
  { key: 'queues',         label: 'Queues',                 group: 'PBX Configuration' },
  { key: 'ivr',            label: 'IVR Menus',              group: 'PBX Configuration' },
  { key: 'timeconditions', label: 'Time Conditions',        group: 'PBX Configuration' },
  { key: 'sounds',         label: 'Sound Files',            group: 'PBX Configuration' },
  { key: 'voicemail',      label: 'Voicemail',              group: 'PBX Configuration' },
  { key: 'blacklist',      label: 'Blacklist',              group: 'PBX Configuration' },
];

export default ALL_MODULES;
