import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import { apiFetch, API_BASE } from '../utils/api';
import { formatDurationVerbose, formatSecVerbose } from '../utils/format';
import './Dashboard.css';
import './SuperAdmin.css';

const ROLES = ['superadmin', 'admin', 'user', 'agent'];

const ROLE_LABEL = { 2: 'Admin', 3: 'User', 5: 'Agent' };
const MANAGEABLE_ROLES = [2, 3, 5];

const ALL_NAV_GROUPS = [
  {
    group: 'User Management',
    items: [
      { id: 'tenants', label: 'Tenants', moduleKey: 'tenants' },
      { id: 'users', label: 'Users', moduleKey: 'users' },
    ],
  },
  {
    group: 'PBX Configuration',
    items: [
      { id: 'extensions', label: 'PJSIP Extensions', moduleKey: 'extensions' },
      { id: 'trunks', label: 'SIP Trunks', moduleKey: 'trunks' },
      { id: 'campaigns', label: 'Campaigns', moduleKey: 'campaigns' },
      { id: 'inbound', label: 'Inbound Routes', moduleKey: 'inbound' },
      { id: 'outbound', label: 'Outbound Routes', moduleKey: 'outbound' },
      { id: 'queues', label: 'Queues', moduleKey: 'queues' },
      { id: 'ivr', label: 'IVR Menus', moduleKey: 'ivr' },
      { id: 'timeconditions', label: 'Time Conditions', moduleKey: 'timeconditions' },
      { id: 'sounds', label: 'Sound Files', moduleKey: 'sounds' },
      { id: 'voicemail', label: 'Voicemail', moduleKey: 'voicemail' },
      { id: 'blacklist', label: 'Blacklist', moduleKey: 'blacklist' },
    ],
  },
  {
    group: 'Reports & Monitoring',
    items: [
      { id: 'overview', label: 'Dashboard', moduleKey: 'dashboard' },
      { id: 'cdr', label: 'CDR & Recordings', moduleKey: 'cdr' },
      { id: 'did-tfn-report', label: 'Calls per DID/TFN', moduleKey: 'cdr' },
      { id: 'live-agents', label: 'Agent Live Monitoring', moduleKey: 'wallboard' },
      { id: 'wallboard', label: 'Wallboard', moduleKey: 'wallboard', href: '/wallboard' },
      { id: 'reports', label: 'Agent Reports', moduleKey: 'wallboard', href: '/reports' },
    ],
  },
  {
    group: 'System',
    superadminOnly: true,
    items: [
      { id: 'asterisk-logs', label: 'Asterisk Logs', moduleKey: '_system' },
      { id: 'role-permissions', label: 'Role Permissions', moduleKey: '_system' },
    ],
  },
];

export default function SuperAdmin() {
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const navGroups = useMemo(() => {
    if (!user) return [];
    if (isSuperadmin) return ALL_NAV_GROUPS;
    const enabledSet = new Set(user.modules || []);
    return ALL_NAV_GROUPS
      .filter(g => !g.superadminOnly)
      .map(g => ({
        ...g,
        items: g.items.filter(item =>
          (item.id === 'wallboard' || item.id === 'live-agents')
            ? enabledSet.has('wallboard') || enabledSet.has('live_agents')
            : enabledSet.has(item.moduleKey)
        ),
      }))
      .filter(g => g.items.length > 0);
  }, [user, isSuperadmin]);

  const validViewIds = useMemo(
    () => navGroups.flatMap(g => g.items.filter(i => !i.href).map(i => i.id)),
    [navGroups]
  );
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewFromUrl = searchParams.get('view');
  const defaultView = validViewIds.includes('overview') ? 'overview' : (validViewIds[0] || 'overview');
  const view = validViewIds.includes(viewFromUrl) ? viewFromUrl : defaultView;
  const setView = useCallback(
    (id) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === 'overview') next.delete('view');
          else next.set('view', id);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const [users, setUsers] = useState([]);
  const [extensions, setExtensions] = useState([]);
  const [trunks, setTrunks] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [inboundRoutes, setInboundRoutes] = useState([]);
  const [outboundRoutes, setOutboundRoutes] = useState([]);
  const [queues, setQueues] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createUserRole, setCreateUserRole] = useState('user');
  const [showCreateExtension, setShowCreateExtension] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('user');
  const [editParentId, setEditParentId] = useState('');
  const [editAccountStatus, setEditAccountStatus] = useState(1);
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editPhonePassword, setEditPhonePassword] = useState('');
  const [editWebPassword, setEditWebPassword] = useState('');
  const [createFormRole, setCreateFormRole] = useState('user');
  const [editingExtension, setEditingExtension] = useState(null);
  const [editExtName, setEditExtName] = useState('');
  const [editExtSecret, setEditExtSecret] = useState('');
  const [editExtContext, setEditExtContext] = useState('');
  const [editExtHost, setEditExtHost] = useState('');
  const [editExtType, setEditExtType] = useState('friend');
  const [editExtTenantId, setEditExtTenantId] = useState('');
  const [createExtensionFailoverType, setCreateExtensionFailoverType] = useState('hangup');
  const [editExtFailoverType, setEditExtFailoverType] = useState('hangup');
  const [editExtFailoverId, setEditExtFailoverId] = useState('');
  const [showCreateTrunk, setShowCreateTrunk] = useState(false);
  const [editingTrunk, setEditingTrunk] = useState(null);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [showCreateInbound, setShowCreateInbound] = useState(false);
  const [createInboundTenantId, setCreateInboundTenantId] = useState('');
  const [editingInbound, setEditingInbound] = useState(null);
  const [inboundDestType, setInboundDestType] = useState('hangup');
  const [showCreateQueue, setShowCreateQueue] = useState(false);
  const [editingQueue, setEditingQueue] = useState(null);
  const [createQueueFailoverType, setCreateQueueFailoverType] = useState('hangup');
  const [editingQueueFailoverType, setEditingQueueFailoverType] = useState('hangup');
  const [queueMembers, setQueueMembers] = useState([]);
  const [selectedQueueId, setSelectedQueueId] = useState(null);
  const [newMemberName, setNewMemberName] = useState('');
  const [syncAsteriskMessage, setSyncAsteriskMessage] = useState(null);
  const [userFilterRole, setUserFilterRole] = useState('');
  const [userFilterStatus, setUserFilterStatus] = useState('');
  const [userSortKey, setUserSortKey] = useState('id');
  const [userSortDir, setUserSortDir] = useState('asc');

  const [tenants, setTenants] = useState([]);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [editTenantName, setEditTenantName] = useState('');
  const [editTenantMaskCaller, setEditTenantMaskCaller] = useState(false);
  const [tenantSearchName, setTenantSearchName] = useState('');
  const [tenantFilterHas, setTenantFilterHas] = useState({
    users: false,
    extensions: false,
    trunks: false,
    queues: false,
    inbound_routes: false,
    outbound_routes: false,
    campaigns: false,
  });
  const [resourceTenantFilter, setResourceTenantFilter] = useState({
    users: '',
    extensions: '',
    trunks: '',
    campaigns: '',
    inbound: '',
    queues: '',
    outbound: '',
  });

  const [ivrMenus, setIvrMenus] = useState([]);
  const [showCreateIvr, setShowCreateIvr] = useState(false);
  const [editingIvr, setEditingIvr] = useState(null);
  const [ivrOptions, setIvrOptions] = useState([]);

  const [timeGroups, setTimeGroups] = useState([]);
  const [timeConditions, setTimeConditions] = useState([]);
  const [showCreateTimeGroup, setShowCreateTimeGroup] = useState(false);
  const [showCreateTimeCond, setShowCreateTimeCond] = useState(false);
  const [createTcMatchType, setCreateTcMatchType] = useState('queue');
  const [createTcNomatchType, setCreateTcNomatchType] = useState('hangup');
  const [editingTimeCond, setEditingTimeCond] = useState(null);
  const [timeGroupRules, setTimeGroupRules] = useState([]);

  const [soundFiles, setSoundFiles] = useState([]);
  const [showCreateSound, setShowCreateSound] = useState(false);

  const [voicemailBoxes, setVoicemailBoxes] = useState([]);
  const [showCreateVoicemail, setShowCreateVoicemail] = useState(false);
  const [editingVoicemail, setEditingVoicemail] = useState(null);

  const [liveAgents, setLiveAgents] = useState([]);
  const [liveAgentStats, setLiveAgentStats] = useState(null);
  const [liveAgentTenantId, setLiveAgentTenantId] = useState('all');
  const [liveAgentSearch, setLiveAgentSearch] = useState('');
  const [liveAgentStatusFilter, setLiveAgentStatusFilter] = useState('all');
  const [liveAgentSupervisorExt, setLiveAgentSupervisorExt] = useState('');

  const [cdrList, setCdrList] = useState([]);
  const [cdrTotal, setCdrTotal] = useState(0);
  const [cdrPage, setCdrPage] = useState(1);
  const [cdrTotalPages, setCdrTotalPages] = useState(1);
  const [cdrLoading, setCdrLoading] = useState(false);
  const [cdrFrom, setCdrFrom] = useState('');
  const [cdrTo, setCdrTo] = useState('');
  const [cdrAgent, setCdrAgent] = useState('');
  const [cdrQueue, setCdrQueue] = useState('');
  const [cdrDirection, setCdrDirection] = useState('');
  const [cdrStatus, setCdrStatus] = useState('');
  const [playingRecordingId, setPlayingRecordingId] = useState(null);
  const [recordingAudioUrl, setRecordingAudioUrl] = useState(null);
  const [cdrTableMissing, setCdrTableMissing] = useState(false);
  const [cdrError, setCdrError] = useState('');

  const [didTfnReport, setDidTfnReport] = useState([]);
  const [didTfnDateFrom, setDidTfnDateFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [didTfnDateTo, setDidTfnDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [didTfnTenantId, setDidTfnTenantId] = useState('all');
  const [didTfnLoading, setDidTfnLoading] = useState(false);

  const [blacklistList, setBlacklistList] = useState([]);
  const [blacklistLoading, setBlacklistLoading] = useState(false);
  const [blacklistError, setBlacklistError] = useState('');
  const [blacklistTenantId, setBlacklistTenantId] = useState('');
  const [blacklistAddNumber, setBlacklistAddNumber] = useState('');
  const [blacklistAddLoading, setBlacklistAddLoading] = useState(false);
  const [blacklistDeleteLoading, setBlacklistDeleteLoading] = useState(null);

  const loadTenants = useCallback(async () => {
    try {
      const res = await apiFetch('/api/superadmin/tenants');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setTenants(data.tenants || []);
    } catch {
      setTenants([]);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/users');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setUsers(data.users || []);
      else setError(data.error || 'Failed to load users');
    } catch (e) {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExtensions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/sip-extensions');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setExtensions(data.extensions || []);
      else setError(data.error || 'Failed to load SIP extensions');
    } catch (e) {
      setError('Failed to load SIP extensions');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await apiFetch('/api/superadmin/stats');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setStats(data.stats || null);
    } catch {
      setStats(null);
    }
  }, []);

  const loadLiveAgents = useCallback(async () => {
    try {
      const url = liveAgentTenantId && liveAgentTenantId !== 'all'
        ? `/api/superadmin/live-agents?tenant_id=${liveAgentTenantId}`
        : '/api/superadmin/live-agents';
      const res = await apiFetch(url);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setLiveAgents(data.agents || []);
        setLiveAgentStats(data.stats || null);
      }
    } catch {
      setLiveAgents([]);
      setLiveAgentStats(null);
    }
  }, [liveAgentTenantId]);

  const handleLiveAgentMonitor = useCallback(async (agentId, mode) => {
    const ext = (liveAgentSupervisorExt || '').trim();
    if (!ext) throw new Error('Supervisor extension required');
    const res = await apiFetch(`/api/superadmin/live-agents/${encodeURIComponent(agentId)}/monitor`, {
      method: 'POST',
      body: JSON.stringify({ mode, supervisor_extension: ext }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || 'Monitor request failed');
  }, [liveAgentSupervisorExt]);

  const loadCDR = useCallback(async (overridePage) => {
    setCdrLoading(true);
    setCdrError('');
    const pageToUse = overridePage != null ? overridePage : cdrPage;
    if (overridePage != null) setCdrPage(overridePage);
    try {
      const q = new URLSearchParams();
      if (cdrFrom) q.set('from', cdrFrom);
      if (cdrTo) q.set('to', cdrTo);
      if (cdrAgent) q.set('agent', cdrAgent);
      if (cdrQueue) q.set('queue', cdrQueue);
      if (cdrDirection) q.set('direction', cdrDirection);
      if (cdrStatus) q.set('status', cdrStatus);
      q.set('page', String(pageToUse));
      q.set('limit', '25');
      const res = await apiFetch(`/api/superadmin/cdr?${q.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setCdrList(Array.isArray(data.list) ? data.list : []);
        setCdrTotal(Number(data.total) || 0);
        setCdrTotalPages(Math.max(1, Number(data.total_pages) || 1));
        setCdrTableMissing(!!data.table_missing);
      } else {
        setCdrList([]);
        setCdrTotal(0);
        setCdrTotalPages(1);
        setCdrTableMissing(false);
        setCdrError(data.error || `Request failed (${res.status})`);
      }
    } catch (e) {
      setCdrList([]);
      setCdrTotal(0);
      setCdrTotalPages(1);
      setCdrTableMissing(false);
      setCdrError(e?.message || 'Failed to load CDR');
    } finally {
      setCdrLoading(false);
    }
  }, [cdrPage, cdrFrom, cdrTo, cdrAgent, cdrQueue, cdrDirection, cdrStatus]);

  const downloadCDR = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      q.set('format', 'csv');
      if (cdrFrom) q.set('from', cdrFrom);
      if (cdrTo) q.set('to', cdrTo);
      if (cdrAgent) q.set('agent', cdrAgent);
      if (cdrQueue) q.set('queue', cdrQueue);
      if (cdrDirection) q.set('direction', cdrDirection);
      if (cdrStatus) q.set('status', cdrStatus);
      const res = await apiFetch(`/api/superadmin/cdr?${q.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Download failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition');
      const match = disp && disp.match(/filename="?([^";\n]+)"?/);
      const name = (match && match[1]) || `cdr-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e?.message || 'Download failed');
    }
  }, [cdrFrom, cdrTo, cdrAgent, cdrQueue, cdrDirection, cdrStatus]);

  const loadDidTfnReport = useCallback(async () => {
    setDidTfnLoading(true);
    try {
      const q = new URLSearchParams();
      q.set('date_from', didTfnDateFrom);
      q.set('date_to', didTfnDateTo);
      if (didTfnTenantId && didTfnTenantId !== 'all') q.set('tenant_id', didTfnTenantId);
      const res = await apiFetch(`/api/superadmin/reports/did-tfn?${q.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setDidTfnReport(Array.isArray(data.report) ? data.report : []);
      else setDidTfnReport([]);
    } catch {
      setDidTfnReport([]);
    } finally {
      setDidTfnLoading(false);
    }
  }, [didTfnDateFrom, didTfnDateTo, didTfnTenantId]);

  const downloadDidTfnReport = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      q.set('format', 'csv');
      q.set('date_from', didTfnDateFrom);
      q.set('date_to', didTfnDateTo);
      if (didTfnTenantId && didTfnTenantId !== 'all') q.set('tenant_id', didTfnTenantId);
      const res = await apiFetch(`/api/superadmin/reports/did-tfn?${q.toString()}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `did-tfn-report-${didTfnDateFrom}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, [didTfnDateFrom, didTfnDateTo, didTfnTenantId]);

  const loadTrunks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/sip-trunks');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setTrunks(data.trunks || []);
      else setError(data.error || 'Failed to load trunks');
    } catch (e) {
      setError('Failed to load trunks');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/campaigns');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setCampaigns(data.campaigns || []);
      else setError(data.error || 'Failed to load campaigns');
    } catch (e) {
      setError('Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInboundRoutes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/inbound-routes');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setInboundRoutes(data.routes || []);
      else setError(data.error || 'Failed to load inbound routes');
    } catch (e) {
      setError('Failed to load inbound routes');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOutboundRoutes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/outbound-routes');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setOutboundRoutes(data.routes || []);
      else setError(data.error || 'Failed to load outbound routes');
    } catch (e) {
      setError('Failed to load outbound routes');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueues = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/queues');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setQueues(data.queues || []);
      else setError(data.error || 'Failed to load queues');
    } catch (e) {
      setError('Failed to load queues');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueueMembers = useCallback(async (queueId) => {
    if (!queueId) return;
    try {
      const res = await apiFetch(`/api/superadmin/queues/${queueId}/members`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setQueueMembers(data.members || []);
      else setQueueMembers([]);
    } catch {
      setQueueMembers([]);
    }
  }, []);

  const loadIvrMenus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/ivr-menus');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setIvrMenus(data.menus || []);
      else setError(data.error || 'Failed to load IVR menus');
    } catch { setError('Failed to load IVR menus'); }
    finally { setLoading(false); }
  }, []);

  const loadTimeGroups = useCallback(async () => {
    try {
      const res = await apiFetch('/api/superadmin/time-groups');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setTimeGroups(data.groups || []);
    } catch { setTimeGroups([]); }
  }, []);

  const loadTimeConditions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/time-conditions');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setTimeConditions(data.conditions || []);
      else setError(data.error || 'Failed to load time conditions');
    } catch { setError('Failed to load time conditions'); }
    finally { setLoading(false); }
  }, []);

  const loadSoundFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/sound-files');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setSoundFiles(data.files || []);
      else setError(data.error || 'Failed to load sound files');
    } catch { setError('Failed to load sound files'); }
    finally { setLoading(false); }
  }, []);

  const loadVoicemailBoxes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/superadmin/voicemail-boxes');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setVoicemailBoxes(data.boxes || []);
      else setError(data.error || 'Failed to load voicemail boxes');
    } catch { setError('Failed to load voicemail boxes'); }
    finally { setLoading(false); }
  }, []);

  const loadBlacklist = useCallback(async () => {
    setBlacklistError('');
    setBlacklistLoading(true);
    try {
      const url = blacklistTenantId ? `/api/admin/blacklist?tenant_id=${blacklistTenantId}` : '/api/admin/blacklist';
      const res = await apiFetch(url);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setBlacklistList(data.list || []);
      else setBlacklistError(data.error || 'Failed to load blacklist');
    } catch (e) { setBlacklistError(e?.message || 'Failed to load blacklist'); }
    finally { setBlacklistLoading(false); }
  }, [blacklistTenantId]);

  useEffect(() => {
    if (view === 'blacklist') loadBlacklist();
  }, [view, blacklistTenantId, loadBlacklist]);

  useEffect(() => {
    if (view === 'users') loadUsers();
  }, [view, loadUsers]);

  useEffect(() => {
    if (view === 'tenants') loadTenants();
  }, [view, loadTenants]);

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  const tenantNameById = useMemo(() => {
    const map = {};
    tenants.forEach((t) => { map[t.id] = t.name || `Tenant ${t.id}`; });
    return map;
  }, [tenants]);

  const filteredTenants = useMemo(() => {
    let list = tenants || [];
    const q = (tenantSearchName || '').trim().toLowerCase();
    if (q) {
      list = list.filter((t) => (t.name || '').toLowerCase().includes(q) || String(t.id).includes(q));
    }
    const has = tenantFilterHas || {};
    const activeFilters = [
      has.users && 'has_users',
      has.extensions && 'has_extensions',
      has.trunks && 'has_trunks',
      has.queues && 'has_queues',
      has.inbound_routes && 'has_inbound_routes',
      has.outbound_routes && 'has_outbound_routes',
      has.campaigns && 'has_campaigns',
    ].filter(Boolean);
    if (activeFilters.length > 0) {
      list = list.filter((t) => activeFilters.every((key) => t[key] === 1));
    }
    return list;
  }, [tenants, tenantSearchName, tenantFilterHas]);

  const getTenantLabel = (id) => {
    if (id == null) return '—';
    const name = tenantNameById[id];
    return name ? `${id} · ${name}` : String(id);
  };

  const ResourceTenantFilterDropdown = ({ viewKey, label = 'Filter by tenant' }) => (
    <label className="superadmin-tenant-filter-label">
      <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>{label}</span>
      <select
        className="superadmin-select superadmin-select-filter"
        value={resourceTenantFilter[viewKey] ?? ''}
        onChange={(e) => setResourceTenantFilter((prev) => ({ ...prev, [viewKey]: e.target.value }))}
      >
        <option value="">All tenants</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>{getTenantLabel(t.id)}</option>
        ))}
      </select>
    </label>
  );

  const normalizeQueueStrategy = (s) => {
    const v = (s || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    if (v === 'roundrobin' || v === 'rrordered') return 'rrordered';
    if (v === 'leastrecent') return 'leastrecent';
    if (v === 'fewestcalls') return 'fewestcalls';
    if (v === 'random') return 'random';
    if (v === 'rrmemory') return 'rrmemory';
    if (v === 'linear') return 'linear';
    return 'ringall';
  };

  const getInboundDestinationLabel = (r) => {
    const type = (r.destination_type || 'hangup').toLowerCase();
    const labels = {
      hangup: 'Terminate Call',
      announcement: 'Announcement',
      ivr: 'IVR',
      queue: 'Queue',
      voicemail: 'Voicemail',
      timecondition: 'Time condition',
      extension: 'Extension',
      exten: 'Extension',
      outbound_queue: 'Outbound Queue',
    };
    const base = labels[type] || type;
    if (type === 'queue' && r.destination_id) {
      const q = queues.find((qu) => qu.id === r.destination_id);
      return q ? `Queue: ${q.name}` : `Queue (${r.destination_id})`;
    }
    if ((type === 'extension' || type === 'exten') && r.destination_id) {
      const ext = extensions.find((e) => e.id === r.destination_id);
      return ext ? `Extension: ${ext.name}` : `Extension (${r.destination_id})`;
    }
    if (type === 'ivr' && r.destination_id) {
      const m = ivrMenus.find((i) => i.id === r.destination_id);
      return m ? `IVR: ${m.name}` : `IVR (${r.destination_id})`;
    }
    if (type === 'timecondition' && r.destination_id) {
      const tc = timeConditions.find((t) => t.id === r.destination_id);
      return tc ? `Time: ${tc.name}` : `Time Cond (${r.destination_id})`;
    }
    if (type === 'voicemail' && r.destination_id) {
      const v = voicemailBoxes.find((vm) => vm.id === r.destination_id);
      return v ? `VM: ${v.mailbox}` : `Voicemail (${r.destination_id})`;
    }
    if (type === 'announcement' && r.destination_id) {
      const s = soundFiles.find((sf) => sf.id === r.destination_id);
      return s ? `Announce: ${s.name}` : `Announcement (${r.destination_id})`;
    }
    return base;
  };

  const agentUsers = useMemo(() =>
    users.filter((u) => u.role === 'agent' && u.phone_login_number),
    [users]
  );

  const filteredAndSortedUsers = useMemo(() => {
    let list = [...users];
    if (resourceTenantFilter.users) {
      list = list.filter((u) => String(u.parent_id) === String(resourceTenantFilter.users));
    }
    if (userFilterRole) {
      list = list.filter((u) => u.role === userFilterRole);
    }
    if (userFilterStatus === 'active') {
      list = list.filter((u) => u.account_status === 1);
    } else if (userFilterStatus === 'inactive') {
      list = list.filter((u) => u.account_status !== 1);
    }
    const key = userSortKey;
    const dir = userSortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let va = a[key];
      let vb = b[key];
      if (key === 'created_at') {
        va = va ? new Date(va).getTime() : 0;
        vb = vb ? new Date(vb).getTime() : 0;
        return (va - vb) * dir;
      }
      if (key === 'account_status' || key === 'id' || key === 'parent_id') {
        va = va != null ? Number(va) : 0;
        vb = vb != null ? Number(vb) : 0;
        return (va - vb) * dir;
      }
      if (key === 'phone_login_set') {
        va = a.phone_login_set ? 1 : 0;
        vb = b.phone_login_set ? 1 : 0;
        return (va - vb) * dir;
      }
      va = (va ?? '') + '';
      vb = (vb ?? '') + '';
      return va.localeCompare(vb, undefined, { numeric: true }) * dir;
    });
    return list;
  }, [users, resourceTenantFilter.users, userFilterRole, userFilterStatus, userSortKey, userSortDir]);

  const handleUserSort = (columnKey) => {
    if (userSortKey === columnKey) {
      setUserSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setUserSortKey(columnKey);
      setUserSortDir('asc');
    }
  };

  const USER_COLUMNS = [
    { key: 'id', label: 'ID' },
    { key: 'username', label: 'Username' },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role' },
    { key: 'parent_id', label: 'Tenant' },
    { key: 'phone_login_number', label: 'Extensions' },
    { key: 'phone_login_set', label: 'PIN' },
    { key: 'account_status', label: 'Status' },
    { key: 'created_at', label: 'Created' },
  ];

  useEffect(() => {
    if (view === 'extensions') {
      loadExtensions();
      loadQueues();
      loadIvrMenus();
      loadTimeConditions();
      loadVoicemailBoxes();
      loadSoundFiles();
    }
  }, [view, loadExtensions, loadQueues, loadIvrMenus, loadTimeConditions, loadVoicemailBoxes, loadSoundFiles]);

  useEffect(() => {
    if (view === 'overview') loadStats();
  }, [view, loadStats]);

  useEffect(() => {
    if (view === 'live-agents') loadLiveAgents();
  }, [view, loadLiveAgents]);

  // Poll live agents every 2s when on live monitoring so status/break changes appear instantly
  useEffect(() => {
    if (view !== 'live-agents') return;
    const t = setInterval(loadLiveAgents, 2000);
    return () => clearInterval(t);
  }, [view, loadLiveAgents]);

  useEffect(() => {
    if (view === 'cdr') loadCDR();
    if (view === 'did-tfn-report') loadDidTfnReport();
  }, [view, loadCDR, loadDidTfnReport]);

  const playRecording = useCallback(async (uniqueId) => {
    if (playingRecordingId === uniqueId) {
      setPlayingRecordingId(null);
      if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl);
      setRecordingAudioUrl(null);
      return;
    }
    if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl);
    setRecordingAudioUrl(null);
    setPlayingRecordingId(uniqueId);
    try {
      const res = await fetch(`${API_BASE}/api/superadmin/cdr/recording/${encodeURIComponent(uniqueId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to load recording');
        setPlayingRecordingId(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setRecordingAudioUrl(url);
    } catch (e) {
      alert(e.message || 'Failed to load recording');
      setPlayingRecordingId(null);
    }
  }, [playingRecordingId, recordingAudioUrl]);

  useEffect(() => {
    return () => {
      if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl);
    };
  }, [recordingAudioUrl]);

  useEffect(() => {
    if (view === 'trunks') loadTrunks();
  }, [view, loadTrunks]);

  useEffect(() => {
    if (view === 'campaigns') {
      loadCampaigns();
      loadTenants();
    }
  }, [view, loadCampaigns, loadTenants]);

  useEffect(() => {
    if (view === 'inbound') {
      loadInboundRoutes();
      loadCampaigns();
      loadExtensions();
      loadQueues();
      loadIvrMenus();
      loadTimeConditions();
      loadVoicemailBoxes();
      loadSoundFiles();
    }
  }, [view, loadInboundRoutes, loadCampaigns, loadExtensions, loadQueues, loadIvrMenus, loadTimeConditions, loadVoicemailBoxes, loadSoundFiles]);

  useEffect(() => {
    if (editingInbound) setInboundDestType(editingInbound.destination_type || 'hangup');
  }, [editingInbound]);

  useEffect(() => {
    if (showCreateInbound) {
      setInboundDestType('hangup');
      setCreateInboundTenantId(tenants[0]?.id ?? '');
    }
  }, [showCreateInbound, tenants]);

  useEffect(() => {
    if (view === 'outbound') {
      loadOutboundRoutes();
      loadTrunks();
    }
  }, [view, loadOutboundRoutes, loadTrunks]);

  useEffect(() => {
    if (view === 'queues') {
      loadQueues();
      loadUsers();
      loadExtensions();
      loadIvrMenus();
      loadTimeConditions();
      loadVoicemailBoxes();
      loadSoundFiles();
    }
  }, [view, loadQueues, loadUsers, loadExtensions, loadIvrMenus, loadTimeConditions, loadVoicemailBoxes, loadSoundFiles]);

  useEffect(() => {
    if (selectedQueueId) loadQueueMembers(selectedQueueId);
  }, [selectedQueueId, loadQueueMembers]);

  useEffect(() => {
    if (editingQueue) setEditingQueueFailoverType(editingQueue.failover_destination_type || 'hangup');
  }, [editingQueue]);

  useEffect(() => {
    if (view === 'ivr') { loadIvrMenus(); loadSoundFiles(); }
  }, [view, loadIvrMenus, loadSoundFiles]);

  useEffect(() => {
    if (view === 'timeconditions') { loadTimeGroups(); loadTimeConditions(); loadQueues(); loadExtensions(); }
  }, [view, loadTimeGroups, loadTimeConditions, loadQueues, loadExtensions]);

  useEffect(() => {
    if (view === 'sounds') loadSoundFiles();
  }, [view, loadSoundFiles]);

  useEffect(() => {
    if (view === 'voicemail') { loadVoicemailBoxes(); loadSoundFiles(); }
  }, [view, loadVoicemailBoxes, loadSoundFiles]);

  const handleBlacklistAdd = async () => {
    const num = (blacklistAddNumber || '').trim();
    if (!num) return;
    const tid = blacklistTenantId || (tenants[0]?.id);
    if (!tid) { setBlacklistError('Select a tenant first'); return; }
    setBlacklistAddLoading(true);
    setBlacklistError('');
    try {
      const res = await apiFetch('/api/admin/blacklist', { method: 'POST', body: JSON.stringify({ tenant_id: Number(tid), number: num }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setBlacklistAddNumber(''); loadBlacklist(); }
      else setBlacklistError(data.error || 'Failed to add');
    } catch (e) { setBlacklistError(e?.message || 'Failed to add'); }
    finally { setBlacklistAddLoading(false); }
  };

  const handleBlacklistDelete = async (id) => {
    setBlacklistDeleteLoading(id);
    setBlacklistError('');
    try {
      const res = await apiFetch(`/api/admin/blacklist/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadBlacklist();
      else setBlacklistError(data.error || 'Failed to delete');
    } catch (e) { setBlacklistError(e?.message || 'Failed to delete'); }
    finally { setBlacklistDeleteLoading(null); }
  };

  const openAddUser = (role) => {
    setView('users');
    setCreateUserRole(role);
    setCreateFormRole(role);
    setShowCreateUser(true);
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    const form = e.target;
    const username = form.username?.value?.trim();
    const password = form.password?.value;
    const role = createFormRole;
    const email = form.email?.value?.trim();
    const parent_id = form.parent_id?.value?.trim();
    const phone_login_number = form.phone_login_number?.value?.trim();
    const phone_login_password = form.phone_login_password?.value;
    setError('');
    if (!username || !password) {
      setError('Username and password required');
      return;
    }
    if (role === 'agent' && (!phone_login_number || !phone_login_password)) {
      setError('Agents require phone login number (extension) and PIN');
      return;
    }
    setLoading(true);
    try {
      const body = { username, password, role, email, parent_id: parent_id || undefined };
      if (role === 'agent') {
        body.phone_login_number = phone_login_number;
        body.phone_login_password = phone_login_password;
      }
      const res = await apiFetch('/api/superadmin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateUser(false);
        form.reset();
        loadUsers();
      } else {
        setError(data.error || 'Failed to create user');
      }
    } catch (e) {
      setError('Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  const openEditUser = (u) => {
    setEditingUser(u);
    setEditUsername(u.username || '');
    setEditEmail(u.email || '');
    setEditRole(u.role || 'user');
    setEditParentId(u.parent_id != null ? String(u.parent_id) : '');
    setEditAccountStatus(u.account_status === 1 ? 1 : 0);
    setEditPhoneNumber(u.phone_login_number || '');
    setEditPhonePassword('');
    setEditWebPassword('');
    setError('');
  };

  const closeEditUser = () => {
    setEditingUser(null);
    setEditUsername('');
    setEditEmail('');
    setEditRole('user');
    setEditParentId('');
    setEditAccountStatus(1);
    setEditPhoneNumber('');
    setEditPhonePassword('');
    setEditWebPassword('');
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    setError('');
    if (!editUsername.trim()) {
      setError('Username is required');
      return;
    }
    if (editingUser.role === 'agent' && editRole === 'agent') {
      if (!editPhoneNumber.trim()) {
        setError('Phone login number (extension) required for agents');
        return;
      }
      if (!editPhonePassword.trim()) {
        setError('PIN required for agents');
        return;
      }
    }
    if (editWebPassword.trim() !== '' && editWebPassword.length < 6) {
      setError('Web login password must be at least 6 characters');
      return;
    }
    setLoading(true);
    try {
      const body = {
        username: editUsername.trim(),
        email: editEmail.trim(),
        account_status: editAccountStatus,
      };
      if (isSuperadmin) {
        body.role = editRole;
        body.parent_id = editParentId === '' ? null : editParentId;
      }
      if (editingUser.role === 'agent' || editRole === 'agent') {
        body.phone_login_number = editPhoneNumber.trim();
        body.phone_login_password = editPhonePassword || undefined;
        if (editWebPassword.trim() !== '') body.password = editWebPassword;
      }
      const res = await apiFetch(`/api/superadmin/users/${editingUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        closeEditUser();
        loadUsers();
      } else {
        setError(data.error || 'Failed to update user');
      }
    } catch (e) {
      setError('Failed to update user');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateExtension = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.name?.value?.trim();
    const secret = form.secret?.value?.trim();
    const context = form.context?.value?.trim();
    const host = form.host?.value?.trim();
    const type = form.type?.value?.trim() || 'friend';
    const failover_destination_type = form.failover_destination_type?.value || 'hangup';
    const failover_destination_id = form.failover_destination_id?.value?.trim() || null;
    setError('');
    if (!tenant_id || !name) {
      setError('Tenant ID and extension name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/sip-extensions', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id, name, secret, context, host, type,
          failover_destination_type: failover_destination_type === 'hangup' ? 'hangup' : failover_destination_type,
          failover_destination_id: failover_destination_id ? parseInt(failover_destination_id, 10) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateExtension(false);
        form.reset();
        loadExtensions();
      } else {
        setError(data.error || 'Failed to create SIP extension');
      }
    } catch (e) {
      setError('Failed to create SIP extension');
    } finally {
      setLoading(false);
    }
  };

  const openEditExtension = (ext) => {
    setEditingExtension(ext);
    setEditExtName(ext.name || '');
    setEditExtSecret(''); // leave blank to keep existing
    setEditExtContext(ext.context || '');
    setEditExtHost(ext.host || '');
    setEditExtType(ext.type || 'friend');
    setEditExtTenantId(String(ext.tenant_id ?? ''));
    setEditExtFailoverType(ext.failover_destination_type || 'hangup');
    setEditExtFailoverId(ext.failover_destination_id != null ? String(ext.failover_destination_id) : '');
    setError('');
  };

  const handleUpdateExtension = async (e) => {
    e.preventDefault();
    if (!editingExtension) return;
    setError('');
    if (!editExtName.trim()) {
      setError('Extension name required');
      return;
    }
    setLoading(true);
    try {
      const body = {
        tenant_id: editExtTenantId.trim() || undefined,
        name: editExtName.trim(),
        context: editExtContext.trim() || undefined,
        host: editExtHost.trim() || undefined,
        type: editExtType.trim() || 'friend',
        failover_destination_type: editExtFailoverType === 'hangup' ? 'hangup' : editExtFailoverType,
        failover_destination_id: editExtFailoverId ? parseInt(editExtFailoverId, 10) : null,
      };
      if (editExtSecret.trim() !== '') body.secret = editExtSecret.trim();
      const res = await apiFetch(`/api/superadmin/sip-extensions/${editingExtension.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingExtension(null);
        setEditExtName('');
        setEditExtSecret('');
        setEditExtContext('');
        setEditExtHost('');
        setEditExtType('friend');
        setEditExtTenantId('');
        setEditExtFailoverType('hangup');
        setEditExtFailoverId('');
        loadExtensions();
      } else {
        setError(data.error || 'Failed to update extension');
      }
    } catch (e) {
      setError('Failed to update extension');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/users/${u.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadUsers();
      } else {
        setError(data.error || 'Failed to delete user');
      }
    } catch (e) {
      setError('Failed to delete user');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleUserStatus = async (u) => {
    const isActive = Number(u.account_status) === 1;
    const nextStatus = isActive ? 0 : 1;
    const action = nextStatus === 1 ? 'activate' : 'deactivate';
    if (!window.confirm(`${action === 'deactivate' ? 'Deactivate' : 'Activate'} user "${u.username}"?`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ account_status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadUsers();
      } else {
        setError(data.error || `Failed to ${action} user`);
      }
    } catch (e) {
      setError(`Failed to ${action} user`);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncToAsterisk = async () => {
    setSyncAsteriskMessage(null);
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/sync-asterisk', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const msg = data.message || (data.success ? 'Synced.' : 'Sync skipped or failed.');
        setSyncAsteriskMessage(data.skipped ? `⚠ ${msg}` : msg);
      } else {
        setError(data.message || data.error || 'Sync failed');
      }
    } catch (e) {
      setError('Sync request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteExtension = async (ext) => {
    if (!window.confirm(`Delete SIP extension "${ext.name}" (${getTenantLabel(ext.tenant_id)})? This cannot be undone.`)) return;
    const extId = ext?.id != null ? Number(ext.id) : null;
    if (extId == null || Number.isNaN(extId)) {
      setError('Invalid extension (missing ID). Refresh the list and try again.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/sip-extensions/${extId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadExtensions();
      } else {
        setError(data.error || 'Failed to delete extension');
      }
    } catch (e) {
      setError('Failed to delete extension');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTrunk = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const trunk_name = form.trunk_name?.value?.trim();
    const peer_details = form.peer_details?.value?.trim();
    setError('');
    if (!tenant_id || !trunk_name || !peer_details) {
      setError('Tenant ID, trunk name, and peer details are required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/sip-trunks', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, trunk_name, config_json: peer_details }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateTrunk(false);
        form.reset();
        loadTrunks();
      } else {
        setError(data.error || 'Failed to create trunk');
      }
    } catch (e) {
      setError('Failed to create trunk');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateTrunk = async (e) => {
    e.preventDefault();
    if (!editingTrunk) return;
    const form = e.target;
    const trunk_name = form.trunk_name?.value?.trim();
    const peer_details = form.peer_details?.value?.trim();
    setError('');
    if (!trunk_name || !peer_details) {
      setError('Trunk name and peer details are required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/sip-trunks/${editingTrunk.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ trunk_name, config_json: peer_details }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingTrunk(null);
        loadTrunks();
      } else {
        setError(data.error || 'Failed to update trunk');
      }
    } catch (e) {
      setError('Failed to update trunk');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTrunk = async (t) => {
    if (!window.confirm(`Delete trunk "${t.trunk_name}"?`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/sip-trunks/${t.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadTrunks();
      else setError(data.error || 'Failed to delete trunk');
    } catch (e) {
      setError('Failed to delete trunk');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCampaign = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.campaign_name?.value?.trim();
    const description = form.campaign_description?.value?.trim();
    setError('');
    if (!tenant_id || !name) {
      setError('Tenant and campaign name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, name, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateCampaign(false);
        form.reset();
        loadCampaigns();
      } else setError(data.error || 'Failed to create campaign');
    } catch (e) {
      setError('Failed to create campaign');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateCampaign = async (e) => {
    e.preventDefault();
    if (!editingCampaign) return;
    const form = e.target;
    const name = form.campaign_name?.value?.trim();
    const description = form.campaign_description?.value?.trim();
    setError('');
    if (!name) {
      setError('Campaign name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/campaigns/${editingCampaign.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingCampaign(null);
        loadCampaigns();
      } else setError(data.error || 'Failed to update campaign');
    } catch (e) {
      setError('Failed to update campaign');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCampaign = async (c) => {
    if (!window.confirm(`Delete campaign "${c.name}"? This will fail if any inbound route uses it.`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/campaigns/${c.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadCampaigns();
      else setError(data.error || 'Failed to delete campaign');
    } catch (e) {
      setError('Failed to delete campaign');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTenant = async (e) => {
    e.preventDefault();
    const name = e.target.tenant_name?.value?.trim();
    setError('');
    if (!name) {
      setError('Tenant name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/tenants', { method: 'POST', body: JSON.stringify({ name }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateTenant(false);
        e.target.reset();
        loadTenants();
      } else setError(data.error || 'Failed to create tenant');
    } catch (e) {
      setError('Failed to create tenant');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateTenant = async (e) => {
    e.preventDefault();
    if (!editingTenant) return;
    const name = editTenantName.trim();
    setError('');
    if (!name) {
      setError('Tenant name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/tenants/${editingTenant.id}`, { method: 'PATCH', body: JSON.stringify({ name, mask_caller_number_agent: editTenantMaskCaller ? 1 : 0 }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingTenant(null);
        setEditTenantName('');
        setEditTenantMaskCaller(false);
        loadTenants();
      } else setError(data.error || 'Failed to update tenant');
    } catch (e) {
      setError('Failed to update tenant');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTenant = async (t) => {
    if (!window.confirm(`Delete tenant "${t.name}" (ID ${t.id})? This will fail if the tenant has extensions, trunks, routes, or queues.`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/tenants/${t.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadTenants();
      else setError(data.error || 'Failed to delete tenant');
    } catch (e) {
      setError('Failed to delete tenant');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateInbound = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.inbound_name?.value?.trim();
    const did = form.did?.value?.trim();
    const campaign_id = form.campaign_id?.value?.trim();
    const destination_type = form.destination_type?.value || 'hangup';
    const destination_target = form.destination_target?.value?.trim();
    const destination_id = destination_type !== 'hangup' && destination_target
      ? parseInt(destination_target, 10)
      : null;
    setError('');
    if (!tenant_id || !did) {
      setError('Tenant ID and DID/TFN required');
      return;
    }
    if (!campaign_id) {
      setError('Campaign required. Create a campaign under Campaigns first, then assign it here.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/inbound-routes', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id,
          name: name || `DID ${did}`,
          did,
          campaign_id,
          destination_type,
          destination_id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateInbound(false);
        form.reset();
        loadInboundRoutes();
      } else {
        setError(data.error || 'Failed to create inbound route');
      }
    } catch (e) {
      setError('Failed to create inbound route');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateInbound = async (e) => {
    e.preventDefault();
    if (!editingInbound) return;
    const form = e.target;
    const name = form.inbound_name?.value?.trim();
    const did = form.did?.value?.trim();
    const campaign_id = form.campaign_id?.value?.trim();
    const destination_type = form.destination_type?.value || 'hangup';
    const destination_target = form.destination_target?.value?.trim();
    const destination_id = destination_type !== 'hangup' && destination_target
      ? parseInt(destination_target, 10)
      : null;
    setError('');
    if (!did) {
      setError('DID/TFN required');
      return;
    }
    if (!campaign_id) {
      setError('Campaign required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/inbound-routes/${editingInbound.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name || `DID ${did}`,
          did,
          campaign_id,
          destination_type,
          destination_id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingInbound(null);
        loadInboundRoutes();
      } else {
        setError(data.error || 'Failed to update inbound route');
      }
    } catch (e) {
      setError('Failed to update inbound route');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteInbound = async (r) => {
    if (!window.confirm(`Delete inbound route "${r.did}"?`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/inbound-routes/${r.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadInboundRoutes();
      else setError(data.error || 'Failed to delete');
    } catch (e) {
      setError('Failed to delete');
    } finally {
      setLoading(false);
    }
  };

  const handleSetOutbound = async (tenantId, trunkId) => {
    if (!trunkId) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/outbound-routes', {
        method: 'PUT',
        body: JSON.stringify({ tenant_id: tenantId, trunk_id: trunkId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadOutboundRoutes();
      else setError(data.error || 'Failed to set outbound trunk');
    } catch (e) {
      setError('Failed to set outbound trunk');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateQueue = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.queue_name?.value?.trim();
    const display_name = form.display_name?.value?.trim();
    const strategy = form.strategy?.value || 'ringall';
    const timeout = form.timeout?.value || '60';
    setError('');
    if (!tenant_id || !name) {
      setError('Tenant ID and queue name required');
      return;
    }
    const failover_destination_type = form.failover_destination_type?.value || 'hangup';
    const failover_destination_id = form.failover_destination_id?.value?.trim() || null;
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/queues', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id, name, display_name, strategy, timeout: parseInt(timeout, 10),
          failover_destination_type: failover_destination_type === 'hangup' ? 'hangup' : failover_destination_type,
          failover_destination_id: failover_destination_id ? parseInt(failover_destination_id, 10) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setShowCreateQueue(false);
        form.reset();
        loadQueues();
      } else {
        setError(data.error || 'Failed to create queue');
      }
    } catch (e) {
      setError('Failed to create queue');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateQueue = async (e) => {
    e.preventDefault();
    if (!editingQueue) return;
    const form = e.target;
    const name = form.queue_name?.value?.trim();
    const display_name = form.display_name?.value?.trim();
    const strategy = form.strategy?.value || 'ringall';
    const timeout = form.timeout?.value || '60';
    const failover_destination_type = form.failover_destination_type?.value || 'hangup';
    const failover_destination_id = form.failover_destination_id?.value?.trim() || null;
    setError('');
    if (!name) {
      setError('Queue name required');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/queues/${editingQueue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name, display_name, strategy, timeout: parseInt(timeout, 10),
          failover_destination_type: failover_destination_type === 'hangup' ? 'hangup' : failover_destination_type,
          failover_destination_id: failover_destination_id ? parseInt(failover_destination_id, 10) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setEditingQueue(null);
        loadQueues();
        if (selectedQueueId === editingQueue.id) setSelectedQueueId(null);
      } else {
        setError(data.error || 'Failed to update queue');
      }
    } catch (e) {
      setError('Failed to update queue');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteQueue = async (q) => {
    if (!window.confirm(`Delete queue "${q.name}" and all its members?`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/queues/${q.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        loadQueues();
        if (selectedQueueId === q.id) setSelectedQueueId(null);
      } else setError(data.error || 'Failed to delete queue');
    } catch (e) {
      setError('Failed to delete queue');
    } finally {
      setLoading(false);
    }
  };

  const handleAddQueueMember = async (e) => {
    e.preventDefault();
    if (!selectedQueueId || !newMemberName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/queues/${selectedQueueId}/members`, {
        method: 'POST',
        body: JSON.stringify({ member_name: newMemberName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setNewMemberName('');
        loadQueueMembers(selectedQueueId);
      } else setError(data.error || 'Failed to add member');
    } catch (e) {
      setError('Failed to add member');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveQueueMember = async (queueId, memberName) => {
    if (!window.confirm(`Remove "${memberName}" from queue?`)) return;
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/queues/${queueId}/members/${encodeURIComponent(memberName)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadQueueMembers(queueId);
      else setError(data.error || 'Failed to remove member');
    } catch (e) {
      setError('Failed to remove member');
    } finally {
      setLoading(false);
    }
  };

  // ---- IVR Handlers ----
  const DEST_TYPES = [
    { value: 'hangup', label: 'Terminate Call' },
    { value: 'queue', label: 'Queue' },
    { value: 'extension', label: 'Extension' },
    { value: 'ivr', label: 'IVR' },
    { value: 'timecondition', label: 'Time Condition' },
    { value: 'voicemail', label: 'Voicemail' },
    { value: 'announcement', label: 'Announcement' },
  ];

  const getDestTargetOptions = (type) => {
    if (type === 'queue') return queues.map(q => ({ value: q.id, label: q.name }));
    if (type === 'extension') return extensions.map(e => ({ value: e.id, label: e.name }));
    if (type === 'ivr') return ivrMenus.map(m => ({ value: m.id, label: m.name }));
    if (type === 'timecondition') return timeConditions.map(t => ({ value: t.id, label: t.name }));
    if (type === 'voicemail') return voicemailBoxes.map(v => ({ value: v.id, label: v.mailbox }));
    if (type === 'announcement') return soundFiles.map(s => ({ value: s.id, label: s.name }));
    return [];
  };

  const handleCreateIvr = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.ivr_name?.value?.trim();
    const type = form.ivr_type?.value || 'dtmf';
    const welcome_sound_id = form.welcome_sound_id?.value || null;
    const timeout = parseInt(form.timeout?.value || '5', 10);
    const noinput_retries = parseInt(form.noinput_retries?.value || '3', 10);
    const invalid_retries = parseInt(form.invalid_retries?.value || '3', 10);
    setError('');
    if (!tenant_id || !name) { setError('Tenant and IVR name required'); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/ivr-menus', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id, name,
          config: { type, welcome_sound_id: welcome_sound_id ? parseInt(welcome_sound_id, 10) : null, timeout, noinput_retries, invalid_retries },
          options: ivrOptions.filter(o => o.dtmf_key),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setShowCreateIvr(false); setIvrOptions([]); loadIvrMenus(); }
      else setError(data.error || 'Failed to create IVR');
    } catch { setError('Failed to create IVR'); }
    finally { setLoading(false); }
  };

  const handleUpdateIvr = async (e) => {
    e.preventDefault();
    if (!editingIvr) return;
    const form = e.target;
    const name = form.ivr_name?.value?.trim();
    const type = form.ivr_type?.value || 'dtmf';
    const welcome_sound_id = form.welcome_sound_id?.value || null;
    const timeout = parseInt(form.timeout?.value || '5', 10);
    const noinput_retries = parseInt(form.noinput_retries?.value || '3', 10);
    const invalid_retries = parseInt(form.invalid_retries?.value || '3', 10);
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/ivr-menus/${editingIvr.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          config: { type, welcome_sound_id: welcome_sound_id ? parseInt(welcome_sound_id, 10) : null, timeout, noinput_retries, invalid_retries },
          options: ivrOptions.filter(o => o.dtmf_key),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setEditingIvr(null); setIvrOptions([]); loadIvrMenus(); }
      else setError(data.error || 'Failed to update IVR');
    } catch { setError('Failed to update IVR'); }
    finally { setLoading(false); }
  };

  const handleDeleteIvr = async (m) => {
    if (!window.confirm(`Delete IVR "${m.name}"?`)) return;
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/ivr-menus/${m.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadIvrMenus();
      else setError(data.error || 'Failed to delete IVR');
    } catch { setError('Failed to delete IVR'); }
    finally { setLoading(false); }
  };

  // ---- Time Condition Handlers ----
  const handleCreateTimeGroup = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.group_name?.value?.trim();
    setError('');
    if (!tenant_id || !name) { setError('Tenant and group name required'); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/time-groups', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, name, rules: timeGroupRules.filter(r => r.day_of_week !== '' || r.start_time || r.end_time) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setShowCreateTimeGroup(false); setTimeGroupRules([]); loadTimeGroups(); }
      else setError(data.error || 'Failed to create time group');
    } catch { setError('Failed to create time group'); }
    finally { setLoading(false); }
  };

  const handleDeleteTimeGroup = async (g) => {
    if (!window.confirm(`Delete time group "${g.name}"?`)) return;
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/time-groups/${g.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadTimeGroups();
      else setError(data.error || 'Failed to delete time group');
    } catch { setError('Failed to delete time group'); }
    finally { setLoading(false); }
  };

  const handleCreateTimeCond = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.tc_name?.value?.trim();
    const time_group_id = form.time_group_id?.value || null;
    const match_destination_type = form.match_dest_type?.value || 'hangup';
    const match_destination_id = form.match_dest_id?.value || null;
    const nomatch_destination_type = form.nomatch_dest_type?.value || 'hangup';
    const nomatch_destination_id = form.nomatch_dest_id?.value || null;
    setError('');
    if (!tenant_id || !name) { setError('Tenant and name required'); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/time-conditions', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, name, time_group_id: time_group_id ? parseInt(time_group_id, 10) : null, match_destination_type, match_destination_id: match_destination_id ? parseInt(match_destination_id, 10) : null, nomatch_destination_type, nomatch_destination_id: nomatch_destination_id ? parseInt(nomatch_destination_id, 10) : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setShowCreateTimeCond(false); loadTimeConditions(); }
      else setError(data.error || 'Failed to create time condition');
    } catch { setError('Failed to create time condition'); }
    finally { setLoading(false); }
  };

  const handleDeleteTimeCond = async (tc) => {
    if (!window.confirm(`Delete time condition "${tc.name}"?`)) return;
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/time-conditions/${tc.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadTimeConditions();
      else setError(data.error || 'Failed to delete time condition');
    } catch { setError('Failed to delete time condition'); }
    finally { setLoading(false); }
  };

  // ---- Sound File Handlers ----
  const handleCreateSound = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const name = form.sound_name?.value?.trim();
    const file_path = form.file_path?.value?.trim();
    setError('');
    if (!tenant_id || !name || !file_path) { setError('Tenant, name, and file path required'); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/sound-files', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, name, file_path }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setShowCreateSound(false); form.reset(); loadSoundFiles(); }
      else setError(data.error || 'Failed to create sound file');
    } catch { setError('Failed to create sound file'); }
    finally { setLoading(false); }
  };

  const handleDeleteSound = async (s) => {
    if (!window.confirm(`Delete sound file "${s.name}"?`)) return;
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/sound-files/${s.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadSoundFiles();
      else setError(data.error || 'Failed to delete sound file');
    } catch { setError('Failed to delete sound file'); }
    finally { setLoading(false); }
  };

  // ---- Voicemail Handlers ----
  const handleCreateVoicemail = async (e) => {
    e.preventDefault();
    const form = e.target;
    const tenant_id = form.tenant_id?.value?.trim();
    const mailbox = form.mailbox?.value?.trim();
    const password = form.vm_password?.value?.trim();
    const email = form.vm_email?.value?.trim();
    const greeting_sound_id = form.greeting_sound_id?.value || null;
    const max_duration = parseInt(form.max_duration?.value || '120', 10);
    setError('');
    if (!tenant_id || !mailbox) { setError('Tenant and mailbox number required'); return; }
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/voicemail-boxes', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, mailbox, password, email, config: { greeting_sound_id: greeting_sound_id ? parseInt(greeting_sound_id, 10) : null, max_duration } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setShowCreateVoicemail(false); form.reset(); loadVoicemailBoxes(); }
      else setError(data.error || 'Failed to create voicemail box');
    } catch { setError('Failed to create voicemail box'); }
    finally { setLoading(false); }
  };

  const handleUpdateVoicemail = async (e) => {
    e.preventDefault();
    if (!editingVoicemail) return;
    const form = e.target;
    const mailbox = form.mailbox?.value?.trim();
    const password = form.vm_password?.value?.trim();
    const email = form.vm_email?.value?.trim();
    const greeting_sound_id = form.greeting_sound_id?.value || null;
    const max_duration = parseInt(form.max_duration?.value || '120', 10);
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/voicemail-boxes/${editingVoicemail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ mailbox, password: password || undefined, email, config: { greeting_sound_id: greeting_sound_id ? parseInt(greeting_sound_id, 10) : null, max_duration } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) { setEditingVoicemail(null); loadVoicemailBoxes(); }
      else setError(data.error || 'Failed to update voicemail box');
    } catch { setError('Failed to update voicemail box'); }
    finally { setLoading(false); }
  };

  const handleDeleteVoicemail = async (v) => {
    if (!window.confirm(`Delete voicemail box "${v.mailbox}"?`)) return;
    setError(''); setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/voicemail-boxes/${v.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) loadVoicemailBoxes();
      else setError(data.error || 'Failed to delete voicemail box');
    } catch { setError('Failed to delete voicemail box'); }
    finally { setLoading(false); }
  };

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const layoutTitle = isSuperadmin ? 'Super Admin' : (user?.role === 'admin' ? 'Admin' : user?.role === 'user' ? 'User' : 'Dashboard');
  const layoutSubtitle = isSuperadmin ? 'PBX Call Centre — Full system control' : 'PBX Call Centre';

  return (
    <Layout title={layoutTitle} subtitle={layoutSubtitle}>
      <div className="superadmin-layout">
        <nav className="superadmin-sidebar">
          {navGroups.map((group) => (
            <div key={group.group} className="superadmin-nav-group">
              <div className="superadmin-nav-group-label">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`superadmin-nav-item ${view === item.id ? 'active' : ''}`}
                  onClick={() => item.href ? navigate(item.href) : setView(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="superadmin-main">
          {error && <p className="superadmin-error">{error}</p>}

          {view === 'overview' && (
            <>
              <h2 className="superadmin-section-title">System overview</h2>
              <div className="superadmin-stats-grid">
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.active_agents ?? '—'}</div>
                  <div className="superadmin-stat-label">Active agents</div>
                </div>
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.total_users ?? '—'}</div>
                  <div className="superadmin-stat-label">Total users</div>
                </div>
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.extensions ?? '—'}</div>
                  <div className="superadmin-stat-label">PJSIP extensions</div>
                </div>
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.trunks ?? '—'}</div>
                  <div className="superadmin-stat-label">SIP trunks</div>
                </div>
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.queues ?? '—'}</div>
                  <div className="superadmin-stat-label">Queues</div>
                </div>
                <div className="superadmin-stat-card">
                  <div className="superadmin-stat-value">{stats?.inbound_routes ?? '—'}</div>
                  <div className="superadmin-stat-label">Inbound routes</div>
                </div>
              </div>
              <section className="dashboard-section">
                <h2>Quick actions</h2>
                <div className="superadmin-quick-actions">
                  {navGroups.filter(g => !g.superadminOnly && g.items.length > 0).map(g => (
                    <div className="superadmin-qa-group" key={g.group}>
                      <h4 className="superadmin-qa-group-title">{g.group}</h4>
                      <div className="action-list">
                        {g.items.map(item => (
                          <button key={item.id} type="button" className="action-btn" onClick={() => item.href ? navigate(item.href) : setView(item.id)}>{item.label}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {isSuperadmin && (
                    <div className="superadmin-qa-group">
                      <h4 className="superadmin-qa-group-title">System</h4>
                      <div className="action-list">
                        <button type="button" className="action-btn" onClick={handleSyncToAsterisk} disabled={loading} title="Push agents, extensions, trunks, and dialplan config to Asterisk">Sync to Asterisk</button>
                        <button type="button" className="action-btn" onClick={() => setView('role-permissions')}>Role Permissions</button>
                      </div>
                    </div>
                  )}
                </div>
                {syncAsteriskMessage && (
                  <p className="superadmin-sync-message" role="status">{syncAsteriskMessage}</p>
                )}
              </section>
            </>
          )}

        {view === 'tenants' && (
          <section className="dashboard-section">
            <h2 className="superadmin-section-title">Tenants (companies)</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>Add tenants to show company names next to tenant IDs in extensions, trunks, queues, and outbound.</p>
            <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateTenant(true)}>
              Add tenant
            </button>
            <div className="superadmin-tenant-filters" style={{ marginTop: '1rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Search:</span>
                <input
                  type="text"
                  placeholder="Name or ID"
                  value={tenantSearchName}
                  onChange={(e) => setTenantSearchName(e.target.value)}
                  style={{ padding: '0.35rem 0.5rem', minWidth: '140px' }}
                />
              </label>
              <span style={{ color: '#64748b', fontSize: '0.875rem' }}>Has:</span>
              {[
                { key: 'users', label: 'Users' },
                { key: 'extensions', label: 'PJSIP extensions' },
                { key: 'trunks', label: 'SIP trunks' },
                { key: 'queues', label: 'Queues' },
                { key: 'inbound_routes', label: 'Inbound routes' },
                { key: 'outbound_routes', label: 'Outbound routes' },
                { key: 'campaigns', label: 'Campaigns' },
              ].map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                  <input
                    type="checkbox"
                    checked={tenantFilterHas[key] || false}
                    onChange={(e) => setTenantFilterHas((prev) => ({ ...prev, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
              {(tenantSearchName.trim() || Object.values(tenantFilterHas).some(Boolean)) && (
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => { setTenantSearchName(''); setTenantFilterHas({ users: false, extensions: false, trunks: false, queues: false, inbound_routes: false, outbound_routes: false, campaigns: false }); }}
                >
                  Clear filters
                </button>
              )}
              <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                {filteredTenants.length}{tenants.length !== filteredTenants.length ? ` of ${tenants.length}` : ''} tenants
              </span>
            </div>
            {showCreateTenant && (
              <form className="superadmin-form" onSubmit={handleCreateTenant}>
                <h3>Create tenant</h3>
                <label>Company / tenant name <input name="tenant_name" type="text" required placeholder="e.g. Acme Corp" /></label>
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>Create</button>
                  <button type="button" className="action-btn" onClick={() => setShowCreateTenant(false)}>Cancel</button>
                </div>
              </form>
            )}
            {editingTenant && (
              <form className="superadmin-form" onSubmit={handleUpdateTenant}>
                <h3>Edit tenant: {editingTenant.name}</h3>
                <label>Company / tenant name
                  <input
                    type="text"
                    value={editTenantName}
                    onChange={(e) => setEditTenantName(e.target.value)}
                    required
                    placeholder="e.g. Acme Corp"
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
                  <input
                    type="checkbox"
                    checked={editTenantMaskCaller}
                    onChange={(e) => setEditTenantMaskCaller(e.target.checked)}
                  />
                  Mask caller number on agent dashboard (show only last 4 digits on incoming call)
                </label>
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>Update</button>
                  <button type="button" className="action-btn" onClick={() => { setEditingTenant(null); setEditTenantName(''); setEditTenantMaskCaller(false); }}>Cancel</button>
                </div>
              </form>
            )}
            {loading && tenants.length === 0 ? (
              <p className="superadmin-loading">Loading tenants…</p>
            ) : (
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead>
                    <tr><th>ID</th><th>Name</th><th>Has</th><th>Mask number (agent)</th><th>Created</th><th></th></tr>
                  </thead>
                  <tbody>
                    {filteredTenants.map((t) => (
                      <tr key={t.id}>
                        <td>{t.id}</td>
                        <td>{t.name}</td>
                        <td>
                          <span className="superadmin-tenant-has-badges" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', fontSize: '0.75rem' }}>
                            {t.has_users === 1 && <span title="Users">Users</span>}
                            {t.has_extensions === 1 && <span title="PJSIP extensions">Ext</span>}
                            {t.has_trunks === 1 && <span title="SIP trunks">Trunks</span>}
                            {t.has_queues === 1 && <span title="Queues">Queues</span>}
                            {t.has_inbound_routes === 1 && <span title="Inbound routes">Inbound</span>}
                            {t.has_outbound_routes === 1 && <span title="Outbound routes">Outbound</span>}
                            {t.has_campaigns === 1 && <span title="Campaigns">Campaigns</span>}
                            {!(t.has_users === 1 || t.has_extensions === 1 || t.has_trunks === 1 || t.has_queues === 1 || t.has_inbound_routes === 1 || t.has_outbound_routes === 1 || t.has_campaigns === 1) && '—'}
                          </span>
                        </td>
                        <td>{t.mask_caller_number_agent === 1 ? 'Yes' : 'No'}</td>
                        <td>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</td>
                        <td>
                          <button type="button" className="action-btn" onClick={() => { setEditingTenant(t); setEditTenantName(t.name || ''); setEditTenantMaskCaller(t.mask_caller_number_agent === 1); }}>Edit</button>
                          <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteTenant(t)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {view === 'users' && (
          <section className="dashboard-section">
            <h2>Users</h2>
            <button type="button" className="action-btn superadmin-add-btn" onClick={() => openAddUser('user')}>
              Add user
            </button>
            {showCreateUser && (
              <form className="superadmin-form" onSubmit={handleCreateUser}>
                <h3>Create user</h3>
                <label>
                  Username <input name="username" type="text" required />
                </label>
                <label>
                  Password <input name="password" type="password" required minLength={6} />
                </label>
                <label>
                  Role
                  <select
                    name="role"
                    value={createFormRole}
                    onChange={(e) => setCreateFormRole(e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Email <input name="email" type="email" placeholder="optional" />
                </label>
                <label className="superadmin-parent-label">
                  Tenant (for agents)
                  <select name="parent_id" className="superadmin-select">
                    <option value="">—</option>
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                    ))}
                  </select>
                </label>
                {createFormRole === 'agent' && (
                  <>
                    <label>
                      Phone login number (extension)
                      <input name="phone_login_number" type="text" placeholder="e.g. 1001" required />
                    </label>
                    <label>
                      Phone login password (PIN)
                      <input name="phone_login_password" type="password" placeholder="e.g. 1234" required minLength={1} />
                    </label>
                  </>
                )}
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Create
                  </button>
                  <button type="button" className="action-btn" onClick={() => setShowCreateUser(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {editingUser && (
              <form className="superadmin-form" onSubmit={handleUpdateUser}>
                <h3>Edit user: {editingUser.username}</h3>
                <label>
                  Username
                  <input
                    type="text"
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    placeholder="optional"
                  />
                </label>
                {isSuperadmin && (
                  <>
                    <label>
                      Role
                      <select
                        className="superadmin-select"
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </label>
                    <label className="superadmin-parent-label">
                      Tenant
                      <select
                        className="superadmin-select"
                        value={editParentId}
                        onChange={(e) => setEditParentId(e.target.value)}
                      >
                        <option value="">—</option>
                        {tenants.map((t) => (
                          <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  Account status
                  <select
                    className="superadmin-select"
                    value={editAccountStatus}
                    onChange={(e) => setEditAccountStatus(Number(e.target.value))}
                  >
                    <option value={1}>Active</option>
                    <option value={0}>Inactive</option>
                  </select>
                </label>
                {(editingUser.role === 'agent' || editRole === 'agent') && (
                  <>
                    <label>
                      Phone login number (extension)
                      <input
                        type="text"
                        value={editPhoneNumber}
                        onChange={(e) => setEditPhoneNumber(e.target.value)}
                        placeholder="e.g. 1001"
                      />
                    </label>
                    <label>
                      Phone login password (PIN)
                      <input
                        type="password"
                        value={editPhonePassword}
                        onChange={(e) => setEditPhonePassword(e.target.value)}
                        placeholder="Enter new PIN"
                      />
                    </label>
                    <label>
                      Web login password (dashboard)
                      <input
                        type="password"
                        value={editWebPassword}
                        onChange={(e) => setEditWebPassword(e.target.value)}
                        placeholder="Leave blank to keep current"
                        minLength={6}
                      />
                    </label>
                  </>
                )}
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Update
                  </button>
                  <button type="button" className="action-btn" onClick={closeEditUser}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {loading && users.length === 0 ? (
              <p className="superadmin-loading">Loading users…</p>
            ) : (
              <>
                <div className="superadmin-users-filters">
                  <ResourceTenantFilterDropdown viewKey="users" label="Tenant" />
                  <label>
                    Role
                    <select
                      className="superadmin-select"
                      value={userFilterRole}
                      onChange={(e) => setUserFilterRole(e.target.value)}
                      aria-label="Filter by role"
                    >
                      <option value="">All roles</option>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Status
                    <select
                      className="superadmin-select"
                      value={userFilterStatus}
                      onChange={(e) => setUserFilterStatus(e.target.value)}
                      aria-label="Filter by status"
                    >
                      <option value="">All statuses</option>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                </div>
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead>
                    <tr>
                      {USER_COLUMNS.map(({ key, label }) => (
                        <th
                          key={key}
                          className={`sortable ${userSortKey === key ? `sorted-${userSortDir}` : ''}`}
                          onClick={() => handleUserSort(key)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleUserSort(key); } }}
                          aria-sort={userSortKey === key ? (userSortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                        >
                          {label}
                          {userSortKey === key && (
                            <span className="sort-indicator" aria-hidden="true">
                              {userSortDir === 'asc' ? ' ↑' : ' ↓'}
                            </span>
                          )}
                        </th>
                      ))}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAndSortedUsers.map((u) => (
                      <tr key={u.id}>
                        <td>{u.id}</td>
                        <td>{u.username}</td>
                        <td>{u.email}</td>
                        <td>{u.role}</td>
                        <td>{u.parent_id != null ? getTenantLabel(u.parent_id) : '—'}</td>
                        <td>{u.phone_login_number || '—'}</td>
                        <td>{u.phone_login_set ? 'Set' : '—'}</td>
                        <td>{u.account_status === 1 ? 'Active' : 'Inactive'}</td>
                        <td>{u.created_at ? new Date(u.created_at).toLocaleString() : '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="action-btn"
                            onClick={() => openEditUser(u)}
                            title="Edit user"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="action-btn"
                            onClick={() => handleToggleUserStatus(u)}
                            title={u.account_status === 1 ? 'Deactivate user (cannot login)' : 'Activate user'}
                          >
                            {u.account_status === 1 ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            className="action-btn superadmin-delete-btn"
                            onClick={() => handleDeleteUser(u)}
                            title="Delete user"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </section>
        )}

        {view === 'extensions' && (
          <section className="dashboard-section">
            <h2>SIP extensions</h2>
            {error && <p className="superadmin-error">{error}</p>}
            <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateExtension(true)}>
              Add SIP extension
            </button>
            {showCreateExtension && (
              <form className="superadmin-form" onSubmit={handleCreateExtension}>
                <h3>Create SIP extension</h3>
                <label>
                  Tenant
                  <select name="tenant_id" className="superadmin-select" required>
                    {tenants.length === 0 && <option value="1">1 (add tenants in Tenants section)</option>}
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Extension name <input name="name" type="text" required placeholder="e.g. 1001" />
                </label>
                <label>
                  Secret <input name="secret" type="text" placeholder="optional" />
                </label>
                <label>
                  Context <input name="context" type="text" placeholder="optional" />
                </label>
                <label>
                  Host <input name="host" type="text" placeholder="optional" />
                </label>
                <label>
                  Type <input name="type" type="text" defaultValue="friend" placeholder="friend" />
                </label>
                <label>Failover when no answer
                  <select name="failover_destination_type" className="superadmin-select" defaultValue="hangup" onChange={(e) => setCreateExtensionFailoverType(e.target.value)}>
                    {DEST_TYPES.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </label>
                {createExtensionFailoverType === 'queue' && (
                  <label>Queue
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select queue —</option>
                      {queues.map((q) => (
                        <option key={q.id} value={q.id}>{q.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {createExtensionFailoverType === 'extension' && (
                  <label>Extension
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select extension —</option>
                      {extensions.map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {createExtensionFailoverType === 'ivr' && (
                  <label>IVR
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select IVR —</option>
                      {ivrMenus.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {createExtensionFailoverType === 'timecondition' && (
                  <label>Time condition
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select —</option>
                      {timeConditions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {createExtensionFailoverType === 'voicemail' && (
                  <label>Voicemail
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select —</option>
                      {voicemailBoxes.map((v) => (
                        <option key={v.id} value={v.id}>{v.mailbox}</option>
                      ))}
                    </select>
                  </label>
                )}
                {createExtensionFailoverType === 'announcement' && (
                  <label>Announcement (sound)
                    <select name="failover_destination_id" className="superadmin-select">
                      <option value="">— Select —</option>
                      {soundFiles.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Create
                  </button>
                  <button type="button" className="action-btn" onClick={() => setShowCreateExtension(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {editingExtension && (
              <form className="superadmin-form" onSubmit={handleUpdateExtension}>
                <h3>Edit SIP extension: {editingExtension.name}</h3>
                <label>
                  Tenant
                  <select
                    className="superadmin-select"
                    value={editExtTenantId}
                    onChange={(e) => setEditExtTenantId(e.target.value)}
                  >
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Extension name
                  <input
                    type="text"
                    value={editExtName}
                    onChange={(e) => setEditExtName(e.target.value)}
                    placeholder="e.g. 1001"
                    required
                  />
                </label>
                <label>
                  Secret <input type="text" value={editExtSecret} onChange={(e) => setEditExtSecret(e.target.value)} placeholder="leave blank to keep" />
                </label>
                <label>
                  Context <input type="text" value={editExtContext} onChange={(e) => setEditExtContext(e.target.value)} placeholder="optional" />
                </label>
                <label>
                  Host <input type="text" value={editExtHost} onChange={(e) => setEditExtHost(e.target.value)} placeholder="optional" />
                </label>
                <label>
                  Type <input type="text" value={editExtType} onChange={(e) => setEditExtType(e.target.value)} placeholder="friend" />
                </label>
                <label>Failover when no answer
                  <select className="superadmin-select" value={editExtFailoverType} onChange={(e) => setEditExtFailoverType(e.target.value)}>
                    {DEST_TYPES.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </label>
                {editExtFailoverType === 'queue' && (
                  <label>Queue
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select queue —</option>
                      {queues.map((q) => (
                        <option key={q.id} value={q.id}>{q.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editExtFailoverType === 'extension' && (
                  <label>Extension
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select extension —</option>
                      {extensions.filter((e) => e.id !== editingExtension?.id).map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editExtFailoverType === 'ivr' && (
                  <label>IVR
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select IVR —</option>
                      {ivrMenus.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editExtFailoverType === 'timecondition' && (
                  <label>Time condition
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select —</option>
                      {timeConditions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editExtFailoverType === 'voicemail' && (
                  <label>Voicemail
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select —</option>
                      {voicemailBoxes.map((v) => (
                        <option key={v.id} value={v.id}>{v.mailbox}</option>
                      ))}
                    </select>
                  </label>
                )}
                {editExtFailoverType === 'announcement' && (
                  <label>Announcement (sound)
                    <select className="superadmin-select" value={editExtFailoverId} onChange={(e) => setEditExtFailoverId(e.target.value)}>
                      <option value="">— Select —</option>
                      {soundFiles.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="superadmin-form-actions">
                  <button type="submit" className="action-btn" disabled={loading}>
                    Update
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      setEditingExtension(null);
                      setEditExtName('');
                      setEditExtSecret('');
                      setEditExtContext('');
                      setEditExtHost('');
                      setEditExtType('friend');
                      setEditExtTenantId('');
                      setEditExtFailoverType('hangup');
                      setEditExtFailoverId('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <ResourceTenantFilterDropdown viewKey="extensions" />
            {loading && extensions.length === 0 ? (
              <p className="superadmin-loading">Loading SIP extensions…</p>
            ) : (
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Tenant</th>
                      <th>Name</th>
                      <th>Secret</th>
                      <th>Context</th>
                      <th>Host</th>
                      <th>Type</th>
                      <th>Registered (Asterisk)</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(resourceTenantFilter.extensions ? extensions.filter((e) => String(e.tenant_id) === String(resourceTenantFilter.extensions)) : extensions).map((ext) => (
                      <tr key={ext.id}>
                        <td>{ext.id}</td>
                        <td>{getTenantLabel(ext.tenant_id)}</td>
                        <td>{ext.name}</td>
                        <td>{ext.secret ? '••••' : '—'}</td>
                        <td>{ext.context || '—'}</td>
                        <td>{ext.host || '—'}</td>
                        <td>{ext.type || '—'}</td>
                        <td>
                          {ext.registered === true ? (
                            <span className="superadmin-ext-registered" title="Extension is registered with Asterisk">Yes</span>
                          ) : ext.asterisk_state != null ? (
                            <span className="superadmin-ext-offline" title={`Asterisk state: ${ext.asterisk_state}`}>No</span>
                          ) : (
                            <span className="superadmin-ext-unknown" title="ARI not configured or unreachable">—</span>
                          )}
                        </td>
                        <td>{ext.created_at ? new Date(ext.created_at).toLocaleString() : '—'}</td>
                        <td>
                          <button type="button" className="action-btn" onClick={() => openEditExtension(ext)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="action-btn superadmin-delete-btn"
                            onClick={() => handleDeleteExtension(ext)}
                            title="Delete extension"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

          {view === 'trunks' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">SIP Trunks</h2>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateTrunk(true)}>
                Add trunk
              </button>
              {showCreateTrunk && (
                <form className="superadmin-form superadmin-form-trunk" onSubmit={handleCreateTrunk}>
                  <h3>Create SIP trunk</h3>
                  <label>
                    Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1 (add tenants in Tenants section)</option>}
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                    <span className="superadmin-field-hint">Use the tenant (company) that will use this trunk. Assign the trunk to that tenant under Outbound.</span>
                  </label>
                  <label>Trunk name <input name="trunk_name" type="text" required placeholder="e.g. my-provider" /></label>
                  <label>
                    Peer details
                    <textarea
                      name="peer_details"
                      className="superadmin-textarea"
                      rows={12}
                      required
                      placeholder={'JSON for inbound (recommended):\n{"type":"endpoint","context":"from-pstn","username":"user","password":"secret","identify_match":"208.93.46.221"}\n\nOr plain key=value (add identify in Asterisk manually).'}
                      spellCheck="false"
                    />
                    <span className="superadmin-field-hint">For inbound calls: use JSON and set identify_match to your provider IP (e.g. "208.93.46.221") so Asterisk matches the trunk. Plain key=value is also supported.</span>
                  </label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateTrunk(false)}>Cancel</button>
                  </div>
                </form>
              )}
              {editingTrunk && (
                <form className="superadmin-form superadmin-form-trunk" onSubmit={handleUpdateTrunk}>
                  <h3>Edit trunk: {editingTrunk.trunk_name}</h3>
                  <label>Trunk name <input name="trunk_name" type="text" defaultValue={editingTrunk.trunk_name} required /></label>
                  <label>
                    Peer details
                    <textarea
                      name="peer_details"
                      className="superadmin-textarea"
                      rows={12}
                      required
                      defaultValue={typeof editingTrunk.config_json === 'string'
                        ? editingTrunk.config_json
                        : (editingTrunk.config_json && typeof editingTrunk.config_json === 'object'
                          ? Object.entries(editingTrunk.config_json).map(([k, v]) => {
                              if (v == null || v === '') return '';
                              return `${k}=${Array.isArray(v) ? v.join(',') : v}`;
                            }).filter(Boolean).join('\n')
                          : '')}
                      spellCheck="false"
                    />
                    <span className="superadmin-field-hint">JSON with identify_match (provider IP) for inbound, or plain key=value.</span>
                  </label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Update</button>
                    <button type="button" className="action-btn" onClick={() => setEditingTrunk(null)}>Cancel</button>
                  </div>
                </form>
              )}
              <ResourceTenantFilterDropdown viewKey="trunks" />
              {loading && trunks.length === 0 ? (
                <p className="superadmin-loading">Loading trunks…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead>
                      <tr><th>ID</th><th>Tenant</th><th>Trunk name</th><th>Type</th><th>Created</th><th></th></tr>
                    </thead>
                    <tbody>
                      {(resourceTenantFilter.trunks ? trunks.filter((x) => String(x.tenant_id) === String(resourceTenantFilter.trunks)) : trunks).map((t) => (
                        <tr key={t.id}>
                          <td>{t.id}</td>
                          <td>{getTenantLabel(t.tenant_id)}</td>
                          <td>{t.trunk_name}</td>
                          <td>{typeof t.config_json === 'string' ? 'plain text' : (t.config_json?.type || 'endpoint')}</td>
                          <td>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => setEditingTrunk(t)}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteTrunk(t)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'campaigns' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Campaigns</h2>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Create campaigns and assign them to inbound routes (DID/TFN). Every inbound number must be assigned to a campaign so agents see which campaign the call belongs to.
              </p>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateCampaign(true)}>Add campaign</button>
              {showCreateCampaign && (
                <form className="superadmin-form" onSubmit={handleCreateCampaign}>
                  <h3>Create campaign</h3>
                  <label>
                    Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Name <input name="campaign_name" type="text" required placeholder="e.g. Sales Q1" /></label>
                  <label>Description <input name="campaign_description" type="text" placeholder="optional" /></label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateCampaign(false)}>Cancel</button>
                  </div>
                </form>
              )}
              {editingCampaign && (
                <form className="superadmin-form" onSubmit={handleUpdateCampaign}>
                  <h3>Edit campaign: {editingCampaign.name}</h3>
                  <label>Name <input name="campaign_name" type="text" defaultValue={editingCampaign.name} required /></label>
                  <label>Description <input name="campaign_description" type="text" defaultValue={editingCampaign.description ?? ''} placeholder="optional" /></label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Update</button>
                    <button type="button" className="action-btn" onClick={() => setEditingCampaign(null)}>Cancel</button>
                  </div>
                </form>
              )}
              <ResourceTenantFilterDropdown viewKey="campaigns" />
              {loading && campaigns.length === 0 ? (
                <p className="superadmin-loading">Loading campaigns…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead>
                      <tr><th>ID</th><th>Tenant</th><th>Name</th><th>Description</th><th></th></tr>
                    </thead>
                    <tbody>
                      {(resourceTenantFilter.campaigns ? campaigns.filter((c) => String(c.tenant_id) === String(resourceTenantFilter.campaigns)) : campaigns).map((c) => (
                        <tr key={c.id}>
                          <td>{c.id}</td>
                          <td>{getTenantLabel(c.tenant_id)}</td>
                          <td>{c.name}</td>
                          <td>{c.description ?? '—'}</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => setEditingCampaign(c)}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteCampaign(c)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'inbound' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Inbound routes (DID / TFN)</h2>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateInbound(true)}>Add inbound route</button>
              {showCreateInbound && (
                <form className="superadmin-form" onSubmit={handleCreateInbound}>
                  <h3>Create inbound route</h3>
                  <label>
                    Tenant
                    <select name="tenant_id" className="superadmin-select" required onChange={(e) => setCreateInboundTenantId(e.target.value)}>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Name <input name="inbound_name" type="text" placeholder="optional" /></label>
                  <label>DID / TFN <input name="did" type="text" required placeholder="e.g. 15551234567" /></label>
                  <label>
                    Campaign
                    <select name="campaign_id" className="superadmin-select" required>
                      <option value="">— Select campaign —</option>
                      {campaigns.filter((c) => !createInboundTenantId || String(c.tenant_id) === String(createInboundTenantId)).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      {createInboundTenantId && campaigns.filter((c) => String(c.tenant_id) === String(createInboundTenantId)).length === 0 && (
                        <option value="">No campaigns for this tenant — create one under Campaigns</option>
                      )}
                    </select>
                    <span className="superadmin-field-hint">Every inbound number must be assigned to a campaign (for agent display).</span>
                  </label>
                  <label>Destination
                    <select name="destination_type" className="superadmin-select" value={inboundDestType} onChange={(e) => setInboundDestType(e.target.value)}>
                      <option value="hangup">Terminate Call</option>
                      <option value="announcement">Announcement</option>
                      <option value="ivr">IVR</option>
                      <option value="queue">Queue</option>
                      <option value="voicemail">Voicemail</option>
                      <option value="timecondition">Time condition</option>
                      <option value="extension">Extension</option>
                      <option value="outbound_queue">Outbound Queue</option>
                    </select>
                  </label>
                  {inboundDestType === 'queue' && (
                    <label>
                      Queue
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select queue —</option>
                        {queues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'extension' && (
                    <label>
                      Extension
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select extension —</option>
                        {extensions.map((ext) => (
                          <option key={ext.id} value={ext.id}>{ext.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'ivr' && (
                    <label>IVR
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select IVR —</option>
                        {ivrMenus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'timecondition' && (
                    <label>Time Condition
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select —</option>
                        {timeConditions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'voicemail' && (
                    <label>Voicemail Box
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select —</option>
                        {voicemailBoxes.map((v) => <option key={v.id} value={v.id}>{v.mailbox}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'announcement' && (
                    <label>Sound File
                      <select name="destination_target" className="superadmin-select">
                        <option value="">— Select —</option>
                        {soundFiles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateInbound(false)}>Cancel</button>
                  </div>
                </form>
              )}
              {editingInbound && (
                <form className="superadmin-form" onSubmit={handleUpdateInbound}>
                  <h3>Edit inbound route</h3>
                  <label>Name <input name="inbound_name" type="text" defaultValue={editingInbound.name} /></label>
                  <label>DID / TFN <input name="did" type="text" defaultValue={editingInbound.did} required /></label>
                  <label>
                    Campaign
                    <select name="campaign_id" className="superadmin-select" required defaultValue={editingInbound.campaign_id ?? ''}>
                      <option value="">— Select campaign —</option>
                      {campaigns.filter((c) => String(c.tenant_id) === String(editingInbound.tenant_id)).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Destination
                    <select name="destination_type" className="superadmin-select" value={inboundDestType} onChange={(e) => setInboundDestType(e.target.value)}>
                      <option value="hangup">Terminate Call</option>
                      <option value="announcement">Announcement</option>
                      <option value="ivr">IVR</option>
                      <option value="queue">Queue</option>
                      <option value="voicemail">Voicemail</option>
                      <option value="timecondition">Time condition</option>
                      <option value="extension">Extension</option>
                      <option value="outbound_queue">Outbound Queue</option>
                    </select>
                  </label>
                  {inboundDestType === 'queue' && (
                    <label>
                      Queue
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select queue —</option>
                        {queues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'extension' && (
                    <label>
                      Extension
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select extension —</option>
                        {extensions.map((ext) => (
                          <option key={ext.id} value={ext.id}>{ext.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'ivr' && (
                    <label>IVR
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select IVR —</option>
                        {ivrMenus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'timecondition' && (
                    <label>Time Condition
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {timeConditions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'voicemail' && (
                    <label>Voicemail Box
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {voicemailBoxes.map((v) => <option key={v.id} value={v.id}>{v.mailbox}</option>)}
                      </select>
                    </label>
                  )}
                  {inboundDestType === 'announcement' && (
                    <label>Sound File
                      <select name="destination_target" className="superadmin-select" defaultValue={editingInbound.destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {soundFiles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Update</button>
                    <button type="button" className="action-btn" onClick={() => setEditingInbound(null)}>Cancel</button>
                  </div>
                </form>
              )}
              <ResourceTenantFilterDropdown viewKey="inbound" />
              {loading && inboundRoutes.length === 0 ? (
                <p className="superadmin-loading">Loading inbound routes…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead>
                      <tr><th>ID</th><th>Tenant</th><th>Name</th><th>DID/TFN</th><th>Campaign</th><th>Destination</th><th></th></tr>
                    </thead>
                    <tbody>
                      {(resourceTenantFilter.inbound ? inboundRoutes.filter((r) => String(r.tenant_id) === String(resourceTenantFilter.inbound)) : inboundRoutes).map((r) => (
                        <tr key={r.id}>
                          <td>{r.id}</td>
                          <td>{getTenantLabel(r.tenant_id)}</td>
                          <td>{r.name}</td>
                          <td>{r.did}</td>
                          <td>{r.campaign_name ?? '—'}</td>
                          <td>{getInboundDestinationLabel(r)}</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => setEditingInbound(r)}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteInbound(r)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'outbound' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Outbound (default trunk per tenant)</h2>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>Set which SIP trunk agents use for outbound calls. If no route exists for a tenant, add one below.</p>
              <ResourceTenantFilterDropdown viewKey="outbound" />
              {loading && outboundRoutes.length === 0 && trunks.length === 0 ? (
                <p className="superadmin-loading">Loading…</p>
              ) : (
                <>
                  <div className="superadmin-table-wrap">
                    <table className="superadmin-table">
                      <thead>
                        <tr><th>Tenant</th><th>Current trunk</th><th>Set trunk</th></tr>
                      </thead>
                      <tbody>
                        {outboundRoutes.length === 0 ? (
                          <tr><td colSpan={3} style={{ color: '#94a3b8' }}>No outbound routes yet. Add one below.</td></tr>
                        ) : (
                          (resourceTenantFilter.outbound ? outboundRoutes.filter((r) => String(r.tenant_id) === String(resourceTenantFilter.outbound)) : outboundRoutes).map((r) => (
                            <tr key={r.id}>
                              <td>{getTenantLabel(r.tenant_id)}</td>
                              <td>{r.trunk_name}</td>
                              <td>
                                <select
                                  className="superadmin-select"
                                  style={{ maxWidth: 200 }}
                                  value={r.trunk_id}
                                  onChange={(e) => handleSetOutbound(r.tenant_id, parseInt(e.target.value, 10))}
                                >
                                  {trunks.map((t) => (
                                    <option key={t.id} value={t.id}>{t.trunk_name}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
              <div className="superadmin-form" style={{ maxWidth: 400, marginTop: '1rem' }}>
                <h3>Add outbound route for tenant</h3>
                <form onSubmit={async (e) => { e.preventDefault(); const t = e.target.tenant_id?.value; const tr = e.target.trunk_id?.value; if (t && tr) await handleSetOutbound(parseInt(t, 10), parseInt(tr, 10)); e.target.reset(); }}>
                  <label>
                    Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Trunk
                    <select name="trunk_id" className="superadmin-select" required>
                      <option value="">Select trunk</option>
                      {trunks.map((t) => <option key={t.id} value={t.id}>{t.trunk_name}</option>)}
                    </select>
                  </label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Set default trunk</button>
                  </div>
                </form>
              </div>
                </>
              )}
            </section>
          )}

          {view === 'queues' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Queues</h2>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateQueue(true)}>Add queue</button>
              {showCreateQueue && (
                <form className="superadmin-form" onSubmit={handleCreateQueue}>
                  <h3>Create queue</h3>
                  <label>
                    Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Queue name <input name="queue_name" type="text" required placeholder="e.g. Support" /></label>
                  <label>Display name <input name="display_name" type="text" placeholder="optional" /></label>
                  <label>Strategy
                    <select name="strategy" className="superadmin-select" defaultValue="rrordered">
                      <option value="rrordered">rrordered (round-robin, distribute calls)</option>
                      <option value="rrmemory">rrmemory (round-robin by last answered)</option>
                      <option value="ringall">ringall (always first agent)</option>
                      <option value="linear">linear</option>
                      <option value="leastrecent">leastrecent</option>
                      <option value="fewestcalls">fewestcalls</option>
                      <option value="random">random</option>
                    </select>
                  </label>
                  <label>Timeout (s) <input name="timeout" type="number" defaultValue="60" /></label>
                  <label>Failover when no answer / no agents
                    <select name="failover_destination_type" className="superadmin-select" defaultValue="hangup" onChange={(e) => setCreateQueueFailoverType(e.target.value)}>
                      {DEST_TYPES.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </label>
                  {createQueueFailoverType === 'queue' && (
                    <label>Queue
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select queue —</option>
                        {queues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {createQueueFailoverType === 'extension' && (
                    <label>Extension
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select extension —</option>
                        {extensions.map((e) => (
                          <option key={e.id} value={e.id}>{e.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {createQueueFailoverType === 'ivr' && (
                    <label>IVR
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select IVR —</option>
                        {ivrMenus.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {createQueueFailoverType === 'timecondition' && (
                    <label>Time condition
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select —</option>
                        {timeConditions.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {createQueueFailoverType === 'voicemail' && (
                    <label>Voicemail
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select —</option>
                        {voicemailBoxes.map((v) => (
                          <option key={v.id} value={v.id}>{v.mailbox}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {createQueueFailoverType === 'announcement' && (
                    <label>Announcement (sound)
                      <select name="failover_destination_id" className="superadmin-select">
                        <option value="">— Select —</option>
                        {soundFiles.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateQueue(false)}>Cancel</button>
                  </div>
                </form>
              )}
              {editingQueue && (
                <form className="superadmin-form" onSubmit={handleUpdateQueue}>
                  <h3>Edit queue: {editingQueue.name}</h3>
                  <label>Queue name <input name="queue_name" type="text" defaultValue={editingQueue.name} required /></label>
                  <label>Display name <input name="display_name" type="text" defaultValue={editingQueue.display_name || ''} /></label>
                  <label>Strategy
                    <select name="strategy" className="superadmin-select" defaultValue={normalizeQueueStrategy(editingQueue.strategy)}>
                      <option value="ringall">ringall</option>
                      <option value="leastrecent">leastrecent</option>
                      <option value="fewestcalls">fewestcalls</option>
                      <option value="random">random</option>
                      <option value="rrmemory">rrmemory</option>
                      <option value="rrordered">rrordered</option>
                      <option value="linear">linear</option>
                    </select>
                  </label>
                  <label>Timeout (s) <input name="timeout" type="number" defaultValue={editingQueue.timeout} /></label>
                  <label>Failover when no answer / no agents
                    <select name="failover_destination_type" className="superadmin-select" defaultValue={editingQueue.failover_destination_type || 'hangup'} onChange={(e) => setEditingQueueFailoverType(e.target.value)}>
                      {DEST_TYPES.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </label>
                  {editingQueueFailoverType === 'queue' && (
                    <label>Queue
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select queue —</option>
                        {queues.map((q) => (
                          <option key={q.id} value={q.id}>{q.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {editingQueueFailoverType === 'extension' && (
                    <label>Extension
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select extension —</option>
                        {extensions.map((e) => (
                          <option key={e.id} value={e.id}>{e.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {editingQueueFailoverType === 'ivr' && (
                    <label>IVR
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select IVR —</option>
                        {ivrMenus.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {editingQueueFailoverType === 'timecondition' && (
                    <label>Time condition
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {timeConditions.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {editingQueueFailoverType === 'voicemail' && (
                    <label>Voicemail
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {voicemailBoxes.map((v) => (
                          <option key={v.id} value={v.id}>{v.mailbox}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {editingQueueFailoverType === 'announcement' && (
                    <label>Announcement (sound)
                      <select name="failover_destination_id" className="superadmin-select" defaultValue={editingQueue.failover_destination_id ?? ''}>
                        <option value="">— Select —</option>
                        {soundFiles.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Update</button>
                    <button type="button" className="action-btn" onClick={() => setEditingQueue(null)}>Cancel</button>
                  </div>
                </form>
              )}
              <ResourceTenantFilterDropdown viewKey="queues" />
              {loading && queues.length === 0 ? (
                <p className="superadmin-loading">Loading queues…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead>
                      <tr><th>ID</th><th>Tenant</th><th>Name</th><th>Display</th><th>Strategy</th><th>Timeout</th><th></th></tr>
                    </thead>
                    <tbody>
                      {(resourceTenantFilter.queues ? queues.filter((q) => String(q.tenant_id) === String(resourceTenantFilter.queues)) : queues).map((q) => (
                        <tr key={q.id}>
                          <td>{q.id}</td>
                          <td>{getTenantLabel(q.tenant_id)}</td>
                          <td>{q.name}</td>
                          <td>{q.display_name || '—'}</td>
                          <td>{q.strategy || '—'}</td>
                          <td>{q.timeout ?? '—'}</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => { setSelectedQueueId(selectedQueueId === q.id ? null : q.id); setEditingQueue(null); }}>{selectedQueueId === q.id ? 'Hide members' : 'Members'}</button>
                            <button type="button" className="action-btn" onClick={() => { setEditingQueue(q); setSelectedQueueId(null); }}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteQueue(q)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {selectedQueueId && (
                <div className="superadmin-form" style={{ marginTop: '1rem', maxWidth: 500 }}>
                  <h3>Queue members</h3>
                  <form onSubmit={handleAddQueueMember} className="superadmin-form-inline-row">
                    <label>
                      Add agent
                      <select value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)} className="superadmin-select">
                        <option value="">— Select agent —</option>
                        {agentUsers
                          .filter((a) => !queueMembers.some((m) => m.member_name === a.phone_login_number))
                          .map((a) => (
                            <option key={a.id} value={a.phone_login_number}>
                              {a.username} ({a.phone_login_number})
                            </option>
                          ))}
                      </select>
                    </label>
                    <button type="submit" className="action-btn" disabled={loading || !newMemberName.trim()}>Add</button>
                  </form>
                  {queueMembers.length === 0 ? (
                    <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No agents in this queue yet.</p>
                  ) : (
                    <div className="superadmin-table-wrap" style={{ marginTop: '0.75rem' }}>
                      <table className="superadmin-table">
                        <thead>
                          <tr><th>Agent Name</th><th>Agent ID</th><th></th></tr>
                        </thead>
                        <tbody>
                          {queueMembers.map((m) => (
                            <tr key={m.member_name}>
                              <td>{m.agent_name || '—'}</td>
                              <td>{m.agent_id || m.member_name}</td>
                              <td>
                                <button type="button" className="action-btn superadmin-delete-btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleRemoveQueueMember(selectedQueueId, m.member_name)}>Remove</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {view === 'ivr' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">IVR Menus</h2>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => { setShowCreateIvr(true); setIvrOptions([]); }}>Add IVR</button>
              {(showCreateIvr || editingIvr) && (
                <form className="superadmin-form" onSubmit={editingIvr ? handleUpdateIvr : handleCreateIvr}>
                  <h3>{editingIvr ? `Edit IVR: ${editingIvr.name}` : 'Create IVR menu'}</h3>
                  {!editingIvr && (
                    <label>Tenant
                      <select name="tenant_id" className="superadmin-select" required>
                        {tenants.length === 0 && <option value="1">1</option>}
                        {tenants.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>IVR Name <input name="ivr_name" type="text" required defaultValue={editingIvr?.name || ''} placeholder="e.g. Main Menu" /></label>
                  <label>Type
                    <select name="ivr_type" className="superadmin-select" defaultValue={editingIvr?.config_json?.type || 'dtmf'}>
                      <option value="dtmf">DTMF (caller presses keys)</option>
                      <option value="normal">Normal (play then route to default)</option>
                    </select>
                  </label>
                  <label>Welcome Sound
                    <select name="welcome_sound_id" className="superadmin-select" defaultValue={editingIvr?.config_json?.welcome_sound_id || ''}>
                      <option value="">None</option>
                      {soundFiles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                  <label>DTMF Timeout (s) <input name="timeout" type="number" defaultValue={editingIvr?.config_json?.timeout || 5} min="1" max="30" /></label>
                  <label>No-input retries <input name="noinput_retries" type="number" defaultValue={editingIvr?.config_json?.noinput_retries || 3} min="0" max="10" /></label>
                  <label>Invalid retries <input name="invalid_retries" type="number" defaultValue={editingIvr?.config_json?.invalid_retries || 3} min="0" max="10" /></label>

                  <h4 style={{ marginTop: '1rem' }}>DTMF Key Options</h4>
                  {ivrOptions.map((opt, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                      <input type="text" value={opt.dtmf_key} maxLength={1} placeholder="Key" style={{ width: 50 }}
                        onChange={(e) => { const n = [...ivrOptions]; n[idx] = { ...n[idx], dtmf_key: e.target.value }; setIvrOptions(n); }} />
                      <select value={opt.destination_type || 'hangup'} className="superadmin-select" style={{ minWidth: 120 }}
                        onChange={(e) => { const n = [...ivrOptions]; n[idx] = { ...n[idx], destination_type: e.target.value, destination_id: null }; setIvrOptions(n); }}>
                        {DEST_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                      {opt.destination_type && opt.destination_type !== 'hangup' && (
                        <select value={opt.destination_id || ''} className="superadmin-select" style={{ minWidth: 120 }}
                          onChange={(e) => { const n = [...ivrOptions]; n[idx] = { ...n[idx], destination_id: e.target.value ? parseInt(e.target.value, 10) : null }; setIvrOptions(n); }}>
                          <option value="">Select...</option>
                          {getDestTargetOptions(opt.destination_type).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                      <button type="button" className="action-btn superadmin-delete-btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        onClick={() => setIvrOptions(ivrOptions.filter((_, i) => i !== idx))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="action-btn" style={{ fontSize: '0.85rem' }}
                    onClick={() => setIvrOptions([...ivrOptions, { dtmf_key: '', destination_type: 'hangup', destination_id: null }])}>
                    + Add key option
                  </button>

                  <div className="superadmin-form-actions" style={{ marginTop: '1rem' }}>
                    <button type="submit" className="action-btn" disabled={loading}>{editingIvr ? 'Update' : 'Create'}</button>
                    <button type="button" className="action-btn" onClick={() => { setShowCreateIvr(false); setEditingIvr(null); setIvrOptions([]); }}>Cancel</button>
                  </div>
                </form>
              )}
              {loading && ivrMenus.length === 0 ? (
                <p className="superadmin-loading">Loading IVR menus…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead>
                      <tr><th>ID</th><th>Tenant</th><th>Name</th><th>Type</th><th>Keys</th><th></th></tr>
                    </thead>
                    <tbody>
                      {ivrMenus.map(m => (
                        <tr key={m.id}>
                          <td>{m.id}</td>
                          <td>{getTenantLabel(m.tenant_id)}</td>
                          <td>{m.name}</td>
                          <td>{m.config_json?.type || 'dtmf'}</td>
                          <td>{(m.options || []).map(o => o.dtmf_key).join(', ') || '—'}</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => { setEditingIvr(m); setShowCreateIvr(false); setIvrOptions(m.options || []); }}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteIvr(m)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'timeconditions' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Time Conditions</h2>

              <h3 style={{ marginTop: '1rem' }}>Time Groups</h3>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => { setShowCreateTimeGroup(true); setTimeGroupRules([]); }}>Add time group</button>
              {showCreateTimeGroup && (
                <form className="superadmin-form" onSubmit={handleCreateTimeGroup}>
                  <h3>Create time group</h3>
                  <label>Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                    </select>
                  </label>
                  <label>Group name <input name="group_name" type="text" required placeholder="e.g. Business Hours" /></label>
                  <h4>Rules</h4>
                  {timeGroupRules.map((r, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                      <select value={r.day_of_week ?? ''} style={{ minWidth: 80 }} className="superadmin-select"
                        onChange={(e) => { const n = [...timeGroupRules]; n[idx] = { ...n[idx], day_of_week: e.target.value !== '' ? parseInt(e.target.value, 10) : null }; setTimeGroupRules(n); }}>
                        <option value="">Any day</option>
                        {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                      </select>
                      <input type="time" value={r.start_time || ''} onChange={(e) => { const n = [...timeGroupRules]; n[idx] = { ...n[idx], start_time: e.target.value }; setTimeGroupRules(n); }} />
                      <span>to</span>
                      <input type="time" value={r.end_time || ''} onChange={(e) => { const n = [...timeGroupRules]; n[idx] = { ...n[idx], end_time: e.target.value }; setTimeGroupRules(n); }} />
                      <button type="button" className="action-btn superadmin-delete-btn" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        onClick={() => setTimeGroupRules(timeGroupRules.filter((_, i) => i !== idx))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="action-btn" style={{ fontSize: '0.85rem' }}
                    onClick={() => setTimeGroupRules([...timeGroupRules, { day_of_week: null, start_time: '09:00', end_time: '17:00' }])}>+ Add rule</button>
                  <div className="superadmin-form-actions" style={{ marginTop: '1rem' }}>
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => { setShowCreateTimeGroup(false); setTimeGroupRules([]); }}>Cancel</button>
                  </div>
                </form>
              )}
              <div className="superadmin-table-wrap" style={{ marginBottom: '2rem' }}>
                <table className="superadmin-table">
                  <thead><tr><th>ID</th><th>Tenant</th><th>Name</th><th>Rules</th><th></th></tr></thead>
                  <tbody>
                    {timeGroups.map(g => (
                      <tr key={g.id}>
                        <td>{g.id}</td>
                        <td>{getTenantLabel(g.tenant_id)}</td>
                        <td>{g.name}</td>
                        <td>{(g.rules || []).map(r => `${r.day_of_week != null ? DAY_NAMES[r.day_of_week] : 'Any'} ${r.start_time || ''}-${r.end_time || ''}`).join('; ') || '—'}</td>
                        <td><button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteTimeGroup(g)}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3>Time Conditions</h3>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => { setShowCreateTimeCond(true); setCreateTcMatchType('queue'); setCreateTcNomatchType('hangup'); }}>Add time condition</button>
              {showCreateTimeCond && (
                <form className="superadmin-form" onSubmit={handleCreateTimeCond}>
                  <h3>Create time condition</h3>
                  <label>Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                    </select>
                  </label>
                  <label>Name <input name="tc_name" type="text" required placeholder="e.g. Office Hours" /></label>
                  <label>Time Group
                    <select name="time_group_id" className="superadmin-select">
                      <option value="">None</option>
                      {timeGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>
                  <label>Match destination type
                    <select name="match_dest_type" className="superadmin-select" value={createTcMatchType} onChange={(e) => setCreateTcMatchType(e.target.value)}>
                      {DEST_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </label>
                  <label>Match destination
                    {createTcMatchType && createTcMatchType !== 'hangup' ? (
                      <select name="match_dest_id" className="superadmin-select">
                        <option value="">— Select —</option>
                        {getDestTargetOptions(createTcMatchType).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <span className="superadmin-form-hint">No selection needed for Terminate Call</span>
                    )}
                  </label>
                  <label>No-match destination type
                    <select name="nomatch_dest_type" className="superadmin-select" value={createTcNomatchType} onChange={(e) => setCreateTcNomatchType(e.target.value)}>
                      {DEST_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </label>
                  <label>No-match destination
                    {createTcNomatchType && createTcNomatchType !== 'hangup' ? (
                      <select name="nomatch_dest_id" className="superadmin-select">
                        <option value="">— Select —</option>
                        {getDestTargetOptions(createTcNomatchType).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <span className="superadmin-form-hint">No selection needed for Terminate Call</span>
                    )}
                  </label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateTimeCond(false)}>Cancel</button>
                  </div>
                </form>
              )}
              <div className="superadmin-table-wrap">
                <table className="superadmin-table">
                  <thead><tr><th>ID</th><th>Tenant</th><th>Name</th><th>Time Group</th><th>Match</th><th>No-match</th><th></th></tr></thead>
                  <tbody>
                    {timeConditions.map(tc => (
                      <tr key={tc.id}>
                        <td>{tc.id}</td>
                        <td>{getTenantLabel(tc.tenant_id)}</td>
                        <td>{tc.name}</td>
                        <td>{tc.time_group_name || (tc.time_group_id ? `#${tc.time_group_id}` : '—')}</td>
                        <td>{tc.match_destination_type || 'hangup'}{tc.match_destination_id ? ` #${tc.match_destination_id}` : ''}</td>
                        <td>{tc.nomatch_destination_type || 'hangup'}{tc.nomatch_destination_id ? ` #${tc.nomatch_destination_id}` : ''}</td>
                        <td><button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteTimeCond(tc)}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === 'sounds' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Sound Files</h2>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Register sound files for IVR prompts, announcements, and voicemail greetings.
                Provide the Asterisk-side file path (e.g. /var/lib/asterisk/sounds/custom/greeting).
              </p>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateSound(true)}>Add sound file</button>
              {showCreateSound && (
                <form className="superadmin-form" onSubmit={handleCreateSound}>
                  <h3>Register sound file</h3>
                  <label>Tenant
                    <select name="tenant_id" className="superadmin-select" required>
                      {tenants.length === 0 && <option value="1">1</option>}
                      {tenants.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                    </select>
                  </label>
                  <label>Name <input name="sound_name" type="text" required placeholder="e.g. Welcome Greeting" /></label>
                  <label>File path (Asterisk) <input name="file_path" type="text" required placeholder="/var/lib/asterisk/sounds/custom/welcome" /></label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>Create</button>
                    <button type="button" className="action-btn" onClick={() => setShowCreateSound(false)}>Cancel</button>
                  </div>
                </form>
              )}
              {loading && soundFiles.length === 0 ? (
                <p className="superadmin-loading">Loading sound files…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead><tr><th>ID</th><th>Tenant</th><th>Name</th><th>Path</th><th></th></tr></thead>
                    <tbody>
                      {soundFiles.map(s => (
                        <tr key={s.id}>
                          <td>{s.id}</td>
                          <td>{getTenantLabel(s.tenant_id)}</td>
                          <td>{s.name}</td>
                          <td style={{ wordBreak: 'break-all', maxWidth: 300 }}>{s.file_path}</td>
                          <td><button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteSound(s)}>Delete</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'voicemail' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Voicemail Boxes</h2>
              <button type="button" className="action-btn superadmin-add-btn" onClick={() => setShowCreateVoicemail(true)}>Add voicemail box</button>
              {(showCreateVoicemail || editingVoicemail) && (
                <form className="superadmin-form" onSubmit={editingVoicemail ? handleUpdateVoicemail : handleCreateVoicemail}>
                  <h3>{editingVoicemail ? `Edit voicemail: ${editingVoicemail.mailbox}` : 'Create voicemail box'}</h3>
                  {!editingVoicemail && (
                    <label>Tenant
                      <select name="tenant_id" className="superadmin-select" required>
                        {tenants.length === 0 && <option value="1">1</option>}
                        {tenants.map(t => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>Mailbox number <input name="mailbox" type="text" required defaultValue={editingVoicemail?.mailbox || ''} placeholder="e.g. 1001" /></label>
                  <label>Password <input name="vm_password" type="password" defaultValue="" placeholder="PIN for voicemail access" /></label>
                  <label>Email <input name="vm_email" type="email" defaultValue={editingVoicemail?.email || ''} placeholder="optional notification email" /></label>
                  <label>Greeting sound
                    <select name="greeting_sound_id" className="superadmin-select" defaultValue={editingVoicemail?.config_json?.greeting_sound_id || ''}>
                      <option value="">Default</option>
                      {soundFiles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                  <label>Max message duration (s) <input name="max_duration" type="number" defaultValue={editingVoicemail?.config_json?.max_duration || 120} min="10" max="600" /></label>
                  <div className="superadmin-form-actions">
                    <button type="submit" className="action-btn" disabled={loading}>{editingVoicemail ? 'Update' : 'Create'}</button>
                    <button type="button" className="action-btn" onClick={() => { setShowCreateVoicemail(false); setEditingVoicemail(null); }}>Cancel</button>
                  </div>
                </form>
              )}
              {loading && voicemailBoxes.length === 0 ? (
                <p className="superadmin-loading">Loading voicemail boxes…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead><tr><th>ID</th><th>Tenant</th><th>Mailbox</th><th>Email</th><th>Max Duration</th><th></th></tr></thead>
                    <tbody>
                      {voicemailBoxes.map(v => (
                        <tr key={v.id}>
                          <td>{v.id}</td>
                          <td>{getTenantLabel(v.tenant_id)}</td>
                          <td>{v.mailbox}</td>
                          <td>{v.email || '—'}</td>
                          <td>{v.config_json?.max_duration || 120}s</td>
                          <td>
                            <button type="button" className="action-btn" onClick={() => { setEditingVoicemail(v); setShowCreateVoicemail(false); }}>Edit</button>
                            <button type="button" className="action-btn superadmin-delete-btn" onClick={() => handleDeleteVoicemail(v)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'blacklist' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Blacklist</h2>
              <p className="dashboard-muted">Blocked numbers will not reach queues or agents. Add prank/robocall numbers here.</p>
              {tenants.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <label>
                    Tenant:{' '}
                    <select
                      value={blacklistTenantId}
                      onChange={(e) => { setBlacklistTenantId(e.target.value); }}
                      className="superadmin-select"
                    >
                      <option value="">All</option>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="superadmin-select"
                  placeholder="Phone number to block"
                  value={blacklistAddNumber}
                  onChange={(e) => setBlacklistAddNumber(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleBlacklistAdd())}
                  style={{ width: '12rem' }}
                />
                <button type="button" className="action-btn" onClick={handleBlacklistAdd} disabled={blacklistAddLoading || !blacklistAddNumber.trim()}>
                  {blacklistAddLoading ? '…' : 'Add'}
                </button>
              </div>
              {blacklistError && <p className="dashboard-error">{blacklistError}</p>}
              {blacklistLoading ? (
                <p className="superadmin-loading">Loading…</p>
              ) : (
                <div className="superadmin-table-wrap">
                  <table className="superadmin-table">
                    <thead><tr><th>Number</th><th>Tenant</th><th>Added</th><th></th></tr></thead>
                    <tbody>
                      {blacklistList.length === 0 && <tr><td colSpan={4}>No entries. Add a number above.</td></tr>}
                      {blacklistList.map((e) => (
                        <tr key={e.id}>
                          <td>{e.number}</td>
                          <td>{getTenantLabel(e.tenant_id)}</td>
                          <td>{e.created_at || '—'}</td>
                          <td>
                            <button type="button" className="action-btn superadmin-delete-btn" disabled={blacklistDeleteLoading === e.id} onClick={() => handleBlacklistDelete(e.id)}>
                              {blacklistDeleteLoading === e.id ? '…' : 'Remove'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {view === 'did-tfn-report' && (
            <section className="dashboard-section">
              <h2 className="superadmin-section-title">Calls per DID/TFN</h2>
              <p className="superadmin-sync-message">Inbound calls and abandoned per number (inbound route).</p>
              <div className="cdr-filters" style={{ marginBottom: '0.75rem' }}>
                <label className="cdr-filter-label">
                  From
                  <input type="date" className="cdr-input" value={didTfnDateFrom} onChange={(e) => setDidTfnDateFrom(e.target.value)} />
                </label>
                <label className="cdr-filter-label">
                  To
                  <input type="date" className="cdr-input" value={didTfnDateTo} onChange={(e) => setDidTfnDateTo(e.target.value)} />
                </label>
                <label className="cdr-filter-label">
                  Tenant
                  <select className="superadmin-select cdr-select" value={didTfnTenantId} onChange={(e) => setDidTfnTenantId(e.target.value)}>
                    <option value="all">All tenants</option>
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="superadmin-add-btn cdr-refresh-btn" onClick={loadDidTfnReport} disabled={didTfnLoading}>Refresh</button>
                <button type="button" className="superadmin-add-btn cdr-download-btn" onClick={downloadDidTfnReport}>Download CSV</button>
              </div>
              {didTfnLoading && <p className="superadmin-loading">Loading report…</p>}
              <div className="cdr-table-wrap">
                <table className="superadmin-table cdr-table">
                  <thead>
                    <tr>
                      <th>DID/TFN</th>
                      <th>Total calls</th>
                      <th>Answered</th>
                      <th>Abandoned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!didTfnLoading && didTfnReport.length === 0 && (
                      <tr>
                        <td colSpan={4} className="cdr-empty">No data for this period.</td>
                      </tr>
                    )}
                    {didTfnReport.map((row, i) => (
                      <tr key={i}>
                        <td>{row.did_tfn || '—'}</td>
                        <td>{row.total_calls ?? 0}</td>
                        <td>{row.answered ?? 0}</td>
                        <td>{row.abandoned ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === 'cdr' && (
            <CDRView
              list={cdrList}
              total={cdrTotal}
              page={cdrPage}
              totalPages={cdrTotalPages}
              loading={cdrLoading}
              tableMissing={cdrTableMissing}
              from={cdrFrom}
              to={cdrTo}
              agent={cdrAgent}
              queue={cdrQueue}
              direction={cdrDirection}
              status={cdrStatus}
              onFromChange={setCdrFrom}
              onToChange={setCdrTo}
              onAgentChange={setCdrAgent}
              onQueueChange={setCdrQueue}
              onDirectionChange={setCdrDirection}
              onStatusChange={setCdrStatus}
              onPageChange={setCdrPage}
              onRefresh={loadCDR}
              onDownload={downloadCDR}
              error={cdrError}
              playingRecordingId={playingRecordingId}
              recordingAudioUrl={recordingAudioUrl}
              onPlayRecording={playRecording}
              onStopRecording={() => {
                setPlayingRecordingId(null);
                if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl);
                setRecordingAudioUrl(null);
              }}
            />
          )}

          {view === 'live-agents' && (
            <LiveAgentsView
              agents={liveAgents}
              stats={liveAgentStats}
              tenants={tenants}
              tenantId={liveAgentTenantId}
              onTenantChange={setLiveAgentTenantId}
              search={liveAgentSearch}
              onSearchChange={setLiveAgentSearch}
              statusFilter={liveAgentStatusFilter}
              onStatusFilterChange={setLiveAgentStatusFilter}
              supervisorExtension={liveAgentSupervisorExt}
              onSupervisorExtensionChange={setLiveAgentSupervisorExt}
              onMonitor={handleLiveAgentMonitor}
              apiBase="/api/superadmin"
              onRefresh={loadLiveAgents}
            />
          )}

          {view === 'asterisk-logs' && isSuperadmin && (
            <AsteriskLogsView />
          )}

          {view === 'role-permissions' && isSuperadmin && (
            <RolePermissionsView />
          )}
      </div>
    </div>
  </Layout>
  );
}

function AsteriskLogsView() {
  const [config, setConfig] = useState({ configured: false, source: null, message: '' });
  const [logFile, setLogFile] = useState('full');
  const [tailLines, setTailLines] = useState(2000);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const logEndRef = useRef(null);
  const eventSourceRef = useRef(null);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/superadmin/asterisk-logs/config');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setConfig({
          configured: data.configured,
          source: data.source,
          message: data.message || '',
        });
      }
    } catch { setConfig({ configured: false, source: null, message: '' }); }
  }, []);

  const loadLogs = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/asterisk-logs?file=${encodeURIComponent(logFile)}&tail=${tailLines}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setLines(data.lines || []);
      } else {
        setError(data.error || 'Failed to load logs');
      }
    } catch (e) {
      setError(e.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [logFile, tailLines]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!live) return;
    setError('');
    const url = `${API_BASE}/api/superadmin/asterisk-logs/stream?file=${encodeURIComponent(logFile)}`;
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;
    es.onmessage = (ev) => {
      const line = ev.data;
      if (line) setLines((prev) => [...prev.slice(-9999), line]);
    };
    es.onerror = () => {
      es.close();
      setLive(false);
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [live, logFile]);

  useEffect(() => {
    if (live) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [live]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <section className="dashboard-section">
      <h2 className="superadmin-section-title">Asterisk Logs</h2>
      <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
        View Asterisk log files without logging into the server. Same server: set ASTERISK_LOG_DIR. Remote: set ASTERISK_CONFIG_API_URL and run config-receiver on the Asterisk server.
      </p>
      {config.message && (
        <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginBottom: '1rem' }}>
          {config.message}
        </p>
      )}
      {!config.configured && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          Logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote) in .env.
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: '#94a3b8' }}>Log file:</span>
          <select
            value={logFile}
            onChange={(e) => setLogFile(e.target.value)}
            disabled={live}
            className="superadmin-select"
            style={{ minWidth: '120px' }}
          >
            <option value="full">full</option>
            <option value="messages">messages</option>
            <option value="queue_log">queue_log</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: '#94a3b8' }}>Lines:</span>
          <input
            type="number"
            min={100}
            max={50000}
            value={tailLines}
            onChange={(e) => setTailLines(parseInt(e.target.value, 10) || 2000)}
            disabled={live}
            className="superadmin-input"
            style={{ width: '90px' }}
          />
        </label>
        <button
          type="button"
          onClick={loadLogs}
          disabled={loading || live || !config.configured}
          className="superadmin-btn primary"
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            disabled={!config.configured}
          />
          <span style={{ color: '#94a3b8' }}>Live</span>
        </label>
      </div>
      {error && <p style={{ color: '#ef4444', marginBottom: '0.5rem' }}>{error}</p>}
      <div
        style={{
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '6px',
          padding: '0.75rem',
          maxHeight: '70vh',
          overflow: 'auto',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.8rem',
          lineHeight: 1.4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {lines.length === 0 && !loading && !live && config.configured && (
          <span style={{ color: '#64748b' }}>Click Load to fetch log lines.</span>
        )}
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

function RolePermissionsView() {
  const [roleModules, setRoleModules] = useState({});
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/superadmin/role-modules');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setRoleModules(data.role_modules || {});
        setModules(data.modules || []);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (roleId, moduleKey, currentValue) => {
    const key = `${roleId}_${moduleKey}`;
    setSaving(key);
    try {
      const res = await apiFetch('/api/superadmin/role-modules', {
        method: 'PUT',
        body: JSON.stringify({ role: roleId, module_key: moduleKey, enabled: !currentValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setRoleModules(prev => ({
          ...prev,
          [roleId]: { ...(prev[roleId] || {}), [moduleKey]: !currentValue },
        }));
      }
    } catch { /* ignore */ }
    finally { setSaving(null); }
  };

  const groups = useMemo(() => {
    const map = {};
    for (const m of modules) {
      if (!map[m.group]) map[m.group] = [];
      map[m.group].push(m);
    }
    return Object.entries(map);
  }, [modules]);

  if (loading) return <p className="superadmin-loading">Loading role permissions…</p>;

  return (
    <section className="dashboard-section">
      <h2 className="superadmin-section-title">Role Permissions</h2>
      <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
        Enable or disable modules for each role. SuperAdmin always has full access. Changes take effect on next login.
      </p>
      {groups.map(([groupName, mods]) => (
        <div key={groupName} style={{ marginBottom: '2rem' }}>
          <h3 style={{ color: '#e2e8f0', fontSize: '1rem', marginBottom: '0.75rem', borderBottom: '1px solid #334155', paddingBottom: '0.5rem' }}>
            {groupName}
          </h3>
          <div className="superadmin-table-wrap">
            <table className="superadmin-table">
              <thead>
                <tr>
                  <th style={{ minWidth: '200px' }}>Module</th>
                  {MANAGEABLE_ROLES.map(r => (
                    <th key={r} style={{ textAlign: 'center', minWidth: '100px' }}>{ROLE_LABEL[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mods.map(mod => (
                  <tr key={mod.key}>
                    <td>{mod.label}</td>
                    {MANAGEABLE_ROLES.map(roleId => {
                      const enabled = !!(roleModules[roleId] || {})[mod.key];
                      const isSaving = saving === `${roleId}_${mod.key}`;
                      return (
                        <td key={roleId} style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            onClick={() => toggle(roleId, mod.key, enabled)}
                            disabled={!!isSaving}
                            className={`role-perm-toggle ${enabled ? 'enabled' : 'disabled'}`}
                            title={enabled ? 'Click to disable' : 'Click to enable'}
                          >
                            {isSaving ? '…' : (enabled ? 'ON' : 'OFF')}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function CDRView({
  list, total, page, totalPages, loading, tableMissing, error,
  from, to, agent, queue, direction, status,
  onFromChange, onToChange, onAgentChange, onQueueChange, onDirectionChange, onStatusChange,
  onPageChange, onRefresh, onDownload,
  playingRecordingId, recordingAudioUrl, onPlayRecording, onStopRecording,
}) {
  const audioRef = useRef(null);
  useEffect(() => {
    if (recordingAudioUrl && audioRef.current) {
      audioRef.current.src = recordingAudioUrl;
      audioRef.current.play().catch(() => {});
    }
  }, [recordingAudioUrl]);

  const formatDt = (v) => (v ? new Date(v).toLocaleString() : '—');
  const formatSec = (s) => (s != null && s >= 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');

  return (
    <>
      <h2 className="superadmin-section-title">CDR & Recordings</h2>
      {tableMissing ? (
        <div className="cdr-empty-state cdr-empty-state--error">
          <p><strong>Call records table is missing.</strong></p>
          <p>Run this migration on your MySQL database: <code>docs/migrations/002_phase3_call_records_realtime.sql</code></p>
          <p>Example: <code>mysql -u root -p pbx_callcentre &lt; docs/migrations/002_phase3_call_records_realtime.sql</code></p>
        </div>
      ) : (
        <>
          <p className="superadmin-sync-message">
            Call detail records and playback. Set RECORDINGS_BASE_PATH (or ASTERISK_RECORDING_PATH) on the server so recordings can be streamed.
          </p>
          {error && (
            <div className="cdr-empty-state cdr-empty-state--error">
              <p><strong>CDR load failed:</strong> {error}</p>
            </div>
          )}
        </>
      )}

      <div className="cdr-filters">
        <label className="cdr-filter-label">
          From
          <input type="date" className="cdr-input" value={from} onChange={(e) => onFromChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          To
          <input type="date" className="cdr-input" value={to} onChange={(e) => onToChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Agent
          <input type="text" className="cdr-input" placeholder="Extension or name" value={agent} onChange={(e) => onAgentChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Queue
          <input type="text" className="cdr-input" placeholder="Queue name" value={queue} onChange={(e) => onQueueChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Direction
          <select className="superadmin-select cdr-select" value={direction} onChange={(e) => onDirectionChange(e.target.value)}>
            <option value="">All</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </label>
        <label className="cdr-filter-label">
          Status
          <select className="superadmin-select cdr-select" value={status} onChange={(e) => onStatusChange(e.target.value)}>
            <option value="">All</option>
            <option value="answered">Answered</option>
            <option value="abandoned">Abandoned</option>
            <option value="transferred">Transferred</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button type="button" className="superadmin-add-btn cdr-refresh-btn" onClick={() => onRefresh(1)}>Search</button>
        <button type="button" className="superadmin-add-btn cdr-download-btn" onClick={onDownload}>Download CDR</button>
      </div>

      {recordingAudioUrl && (
        <div className="cdr-audio-bar">
          <audio ref={audioRef} controls onEnded={onStopRecording} />
          <button type="button" className="cdr-stop-btn" onClick={onStopRecording}>Stop</button>
        </div>
      )}

      {loading && <p className="superadmin-loading">Loading CDR…</p>}
      <div className="cdr-table-wrap">
        <table className="superadmin-table cdr-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>Caller</th>
              <th>Destination</th>
              <th>DID/TFN</th>
              <th>Agent</th>
              <th>Queue</th>
              <th>Direction</th>
              <th>Duration</th>
              <th>Talk</th>
              <th>Wait</th>
              <th>Status</th>
              <th>Details</th>
              <th>Recording</th>
            </tr>
          </thead>
          <tbody>
            {!loading && list.length === 0 && !tableMissing && (
              <tr>
                <td colSpan={13} className="cdr-empty">
                  <span className="cdr-empty-title">No call records yet.</span>
                  <span className="cdr-empty-hint">Records are created when: (1) inbound/queue calls use the Stasis app or when the dialplan calls the app&apos;s IncomingCall URL, or (2) agents make outbound calls from the console.</span>
                </td>
              </tr>
            )}
            {list.map((row) => {
              const statusCls = row.status === 'abandoned' ? 'cdr-status-abandoned' :
                row.transfer_status === 1 ? 'cdr-status-transferred' :
                row.status === 'failed' ? 'cdr-status-failed' : '';
              const details = row.transfer_status === 1
                ? `Transfer: ${row.transfer_from || '?'} → ${row.transfer_to || '?'}${row.transfer_type ? ` (${row.transfer_type})` : ''}`
                : row.abandon_reason
                  ? `Abandon: ${row.abandon_reason}${row.failover_destination ? ` → ${row.failover_destination}` : ''}`
                  : '—';
              return (
                <tr key={row.unique_id || row.id} className={statusCls}>
                  <td>{formatDt(row.start_time)}</td>
                  <td>{row.source_number || '—'}</td>
                  <td>{row.destination_number || '—'}</td>
                  <td>{row.did_tfn || '—'}</td>
                  <td>{row.agent_name}</td>
                  <td>{row.queue_name || '—'}</td>
                  <td>{row.direction || '—'}</td>
                  <td>{formatSec(row.duration_sec)}</td>
                  <td>{formatSec(row.talk_sec)}</td>
                  <td>{formatSec(row.wait_time_sec)}</td>
                  <td>{row.status || '—'}</td>
                  <td className="cdr-details" title={details}>{details}</td>
                  <td>
                    {row.has_recording ? (
                      <button
                        type="button"
                        className={`cdr-play-btn ${playingRecordingId === row.unique_id ? 'cdr-playing' : ''}`}
                        onClick={() => onPlayRecording(row.unique_id)}
                      >
                        {playingRecordingId === row.unique_id ? 'Stop' : 'Play'}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cdr-pagination">
        <span className="cdr-pagination-info">
          {total} call(s) · page {page} of {totalPages}
        </span>
        <div className="cdr-pagination-btns">
          <button type="button" className="superadmin-add-btn cdr-page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Prev</button>
          <button type="button" className="superadmin-add-btn cdr-page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</button>
        </div>
      </div>
    </>
  );
}

function getAgentStatusDisplay(status, breakName) {
  const s = (status || '').toUpperCase();
  if (s === 'RINGING') return { label: 'Ringing', cls: 'la-status-ringing' };
  if (s === 'ON CALL' || s === 'ONCALL') return { label: 'On Call', cls: 'la-status-oncall' };
  if (s === 'OUTBOUND') return { label: 'Outbound', cls: 'la-status-oncall' };
  if (s.includes('BREAK') || s === 'PAUSED' || (breakName != null && breakName !== ''))
    return { label: breakName ? `Break (${breakName})` : 'Break', cls: 'la-status-break' };
  if (s === 'LOGGEDIN' || s === 'SIP PHONE RINGING' || s === 'LOGININITIATED')
    return { label: 'Available', cls: 'la-status-available' };
  if (s === 'LOGGEDOUT' || s === 'LOGINFAILED')
    return { label: 'Logged Out', cls: 'la-status-loggedout' };
  if (s === 'DISABLED')
    return { label: 'Disabled', cls: 'la-status-loggedout' };
  return { label: status || 'Unknown', cls: 'la-status-unknown' };
}


function LiveAgentDuration({ sessionStartedAt }) {
  const [elapsed, setElapsed] = useState(() =>
    sessionStartedAt ? Date.now() - new Date(sessionStartedAt).getTime() : 0
  );
  const ref = useRef(null);
  useEffect(() => {
    if (!sessionStartedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - new Date(sessionStartedAt).getTime());
    tick();
    ref.current = setInterval(tick, 1000);
    return () => clearInterval(ref.current);
  }, [sessionStartedAt]);
  return <span>{formatDurationVerbose(elapsed)}</span>;
}

function LiveBreakDuration({ breakStartedAt }) {
  const [elapsed, setElapsed] = useState(() =>
    breakStartedAt ? Date.now() - new Date(breakStartedAt).getTime() : 0
  );
  const ref = useRef(null);
  useEffect(() => {
    if (!breakStartedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - new Date(breakStartedAt).getTime());
    tick();
    ref.current = setInterval(tick, 1000);
    return () => clearInterval(ref.current);
  }, [breakStartedAt]);
  return <span>{formatDurationVerbose(elapsed)}</span>;
}


function LiveAgentsView({
  agents, stats, tenants, tenantId, onTenantChange,
  search, onSearchChange, statusFilter, onStatusFilterChange,
  supervisorExtension, onSupervisorExtensionChange, onMonitor,
  apiBase = '/api/superadmin',
  onRefresh,
}) {
  const [monitorLoading, setMonitorLoading] = useState(null);
  const [monitorError, setMonitorError] = useState('');
  const [forceLoading, setForceLoading] = useState(null);
  const [forceError, setForceError] = useState('');

  const filtered = useMemo(() => {
    let list = agents || [];
    if (statusFilter && statusFilter !== 'all') {
      list = list.filter((a) => {
        const s = (a.status || '').toUpperCase();
        switch (statusFilter) {
          case 'available':
            return s === 'LOGGEDIN' || s === 'SIP PHONE RINGING' || s === 'LOGININITIATED';
          case 'oncall':
            return s === 'ON CALL' || s === 'ONCALL' || s === 'RINGING' || s === 'OUTBOUND';
          case 'break':
            return s.includes('BREAK') || s === 'PAUSED' || (a.break_name != null && a.break_name !== '');
          case 'loggedout':
            return s === 'LOGGEDOUT' || s === 'LOGINFAILED' || s === 'DISABLED' || !s;
          default:
            return true;
        }
      });
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          (a.name || '').toLowerCase().includes(q) ||
          (a.agent_id || '').toLowerCase().includes(q) ||
          (a.extension || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [agents, statusFilter, search]);

  const isOnCall = (a) => {
    const s = (a.status || '').toUpperCase();
    return s === 'ON CALL' || s === 'ONCALL' || s === 'RINGING' || s === 'OUTBOUND';
  };

  const isOnBreak = (a) => {
    const s = (a.status || '').toUpperCase();
    return s === 'PAUSED' || (s && s.includes('BREAK')) || (a.break_name != null && a.break_name !== '');
  };

  const isOnline = (a) => {
    const s = (a.status || '').toUpperCase();
    return s && !['LOGGEDOUT', 'LOGINFAILED', 'DISABLED', 'UNKNOWN'].includes(s);
  };

  const handleForceEndBreak = async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const res = await apiFetch(`${apiBase}/live-agents/${encodeURIComponent(agentId)}/force-end-break`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed');
      if (onRefresh) onRefresh();
    } catch (e) {
      setForceError(e.message || 'Failed to end break');
    } finally {
      setForceLoading(null);
    }
  };

  const handleForceLogout = async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const res = await apiFetch(`${apiBase}/live-agents/${encodeURIComponent(agentId)}/force-logout`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed');
      if (onRefresh) onRefresh();
    } catch (e) {
      setForceError(e.message || 'Force logout failed');
    } finally {
      setForceLoading(null);
    }
  };

  const handleMonitor = async (agentId, mode) => {
    if (!onMonitor) return;
    if (!(supervisorExtension || '').trim()) {
      setMonitorError('Supervisor extension required');
      return;
    }
    setMonitorError('');
    setMonitorLoading(agentId);
    try {
      await onMonitor(agentId, mode);
    } catch (e) {
      setMonitorError(e.message || 'Request failed');
    } finally {
      setMonitorLoading(null);
    }
  };

  return (
    <>
      <div className="la-header">
        <h2 className="superadmin-section-title">Agent Live Monitoring</h2>
        <span className="la-live-badge">
          <span className="la-live-dot" />
          Live
        </span>
      </div>

      <div className="la-filters">
        {tenants.length > 0 && (
          <label className="la-filter-label">
            Tenant
            <select
              className="superadmin-select la-select"
              value={tenantId}
              onChange={(e) => onTenantChange(e.target.value)}
            >
              <option value="all">All tenants</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
              ))}
            </select>
          </label>
        )}
        <label className="la-filter-label">
          Status
          <select
            className="superadmin-select la-select"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="available">Available</option>
            <option value="oncall">On Call / Ringing</option>
            <option value="break">Break</option>
            <option value="loggedout">Logged Out</option>
          </select>
        </label>
        <label className="la-filter-label">
          Search
          <input
            type="text"
            className="la-search-input"
            placeholder="Agent name, ID or extension…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </label>
        <label className="la-filter-label">
          Supervisor ext.
          <input
            type="text"
            className="la-search-input la-supervisor-ext"
            placeholder="e.g. 7002"
            value={supervisorExtension || ''}
            onChange={(e) => onSupervisorExtensionChange(e.target.value)}
            title="Your extension for Listen / Whisper / Barge"
          />
        </label>
      </div>
      {(monitorError || forceError) && (
        <div className="la-monitor-error">{monitorError || forceError}</div>
      )}

      {stats && (
        <div className="la-stats-grid">
          <div className="la-stat-card">
            <div className="la-stat-value">{stats.total}</div>
            <div className="la-stat-label">Total</div>
          </div>
          <div className="la-stat-card la-stat-online">
            <div className="la-stat-value">{stats.online}</div>
            <div className="la-stat-label">Online</div>
          </div>
          <div className="la-stat-card la-stat-available">
            <div className="la-stat-value">{stats.available}</div>
            <div className="la-stat-label">Available</div>
          </div>
          <div className="la-stat-card la-stat-oncall">
            <div className="la-stat-value">{stats.onCall}</div>
            <div className="la-stat-label">On Call</div>
          </div>
          <div className="la-stat-card la-stat-break">
            <div className="la-stat-value">{stats.onBreak}</div>
            <div className="la-stat-label">On Break</div>
          </div>
          <div className="la-stat-card la-stat-loggedout">
            <div className="la-stat-value">{stats.loggedOut}</div>
            <div className="la-stat-label">Logged Out</div>
          </div>
        </div>
      )}

      <div className="la-table-wrap">
        <table className="superadmin-table la-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Extension</th>
              <th>Status</th>
              <th>Queue</th>
              <th>Customer</th>
              <th>DID/TFN</th>
              <th>Calls</th>
              <th>Login Duration</th>
              <th>On break for</th>
              <th>Tenant</th>
              <th>Last Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="la-empty">No agents found.</td>
              </tr>
            ) : (
              filtered.map((a) => {
                const disp = getAgentStatusDisplay(a.status, a.break_name);
                const onCall = isOnCall(a);
                const loading = monitorLoading === a.agent_id;
                return (
                  <tr key={a.agent_id} className={disp.cls.includes('loggedout') ? 'la-row-dimmed' : ''}>
                    <td>
                      <span className="la-agent-name">{a.name}</span>
                      <span className="la-agent-ext">{a.extension || a.agent_id || '—'}</span>
                    </td>
                    <td>{a.extension || '—'}</td>
                    <td>
                      <span className={`la-status-badge ${disp.cls}`}>
                        <span className="la-status-dot" />
                        {disp.label}
                      </span>
                    </td>
                    <td>{a.queue_name || '—'}</td>
                    <td>{a.customer_number || '—'}</td>
                    <td>{onCall ? (a.call_did || '—') : '—'}</td>
                    <td>{a.calls_taken}</td>
                    <td>
                      {a.session_started_at ? (
                        <LiveAgentDuration sessionStartedAt={a.session_started_at} />
                      ) : '—'}
                    </td>
                    <td>
                      {a.break_started_at ? (
                        <LiveBreakDuration breakStartedAt={a.break_started_at} />
                      ) : '—'}
                    </td>
                    <td>{a.tenant_name || a.tenant_id || '—'}</td>
                    <td className="la-timestamp">
                      {a.timestamp
                        ? new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : '—'}
                    </td>
                    <td className="la-actions">
                      {onCall ? (
                        <>
                          <span className="la-monitor-btns">
                            <button
                              type="button"
                              className="la-btn la-btn-listen"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'listen')}
                              title="Listen only (you hear call, no one hears you)"
                            >
                              {loading ? '…' : 'Listen'}
                            </button>
                            <button
                              type="button"
                              className="la-btn la-btn-whisper"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'whisper')}
                              title="Whisper to agent only"
                            >
                              {loading ? '…' : 'Whisper'}
                            </button>
                            <button
                              type="button"
                              className="la-btn la-btn-barge"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'barge')}
                              title="Join call (everyone hears everyone)"
                            >
                              {loading ? '…' : 'Barge'}
                            </button>
                          </span>
                          {isOnline(a) && (
                            <>
                              <span className="la-actions-sep" aria-hidden="true" />
                              <span className="la-force-btns">
                                <button
                                  type="button"
                                  className="la-btn la-btn-force-logout"
                                  disabled={forceLoading === a.agent_id}
                                  onClick={() => handleForceLogout(a.agent_id)}
                                  title="Force logout: hang up channels, clear session, agent can re-login"
                                >
                                  {forceLoading === a.agent_id ? '…' : 'Force logout'}
                                </button>
                              </span>
                            </>
                          )}
                        </>
                      ) : (
                        <span className="la-force-btns">
                          {isOnBreak(a) && (
                            <button
                              type="button"
                              className="la-btn la-btn-end-break"
                              disabled={forceLoading === a.agent_id}
                              onClick={() => handleForceEndBreak(a.agent_id)}
                              title="Set agent to Available (clear break)"
                            >
                              {forceLoading === a.agent_id ? '…' : 'End break'}
                            </button>
                          )}
                          {isOnline(a) && (
                            <button
                              type="button"
                              className="la-btn la-btn-force-logout"
                              disabled={forceLoading === a.agent_id}
                              onClick={() => handleForceLogout(a.agent_id)}
                              title="Force logout: hang up Asterisk channels, clear session, ready for re-login"
                            >
                              {forceLoading === a.agent_id ? '…' : 'Force logout'}
                            </button>
                          )}
                          {!isOnline(a) && !isOnBreak(a) && '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
