-- Peerless outbound SIP trunk (VoIP provider 208.93.46.221)
-- Run after schema and other migrations. USE pbx_callcentre;
-- Adjust tenant_id if your agents use a different tenant (e.g. 2).

INSERT INTO sip_trunks (tenant_id, trunk_name, config_json)
SELECT 1, 'peerless_outbound', JSON_OBJECT(
  'type', 'endpoint',
  'context', 'from-trunk',
  'aor_contact', 'sip:208.93.46.221:5060',
  'username', 'peerless_outbound',
  'password', '',
  'identify_match', '208.93.46.221'
)
WHERE NOT EXISTS (SELECT 1 FROM sip_trunks WHERE trunk_name = 'peerless_outbound');

INSERT INTO outbound_routes (tenant_id, trunk_id, trunk_name)
SELECT 1, t.id, 'peerless_outbound'
FROM sip_trunks t
WHERE t.trunk_name = 'peerless_outbound' AND t.tenant_id = 1
  AND NOT EXISTS (SELECT 1 FROM outbound_routes WHERE tenant_id = 1 LIMIT 1)
LIMIT 1;
