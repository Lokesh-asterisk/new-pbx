#!/usr/bin/env node
/**
 * Run this on the Asterisk server (e.g. 10.50.2.190).
 * The PBX app (10.50.7.181) POSTs config here; this script writes to Asterisk config files and reloads.
 *
 * Env (optional):
 *   PORT=9999
 *   AGENTS_CONF_PATH=/etc/asterisk/agents.conf
 *   PJSIP_CUSTOM_PATH=/etc/asterisk/pjsip_custom.conf
 *   CONFIG_API_KEY=secret  (if set, requests must send header X-Config-API-Key: secret)
 *
 * Endpoints:
 *   POST /config/agents  body: { content: "..." }  -> write agents.conf, reload app_agent_pool
 *   POST /config/pjsip   body: { content: "..." } -> write pjsip_custom.conf, reload pjsip
 */

import http from 'http';
import fs from 'fs/promises';
import { execSync } from 'child_process';

const PORT = parseInt(process.env.PORT || '9999', 10);
const AGENTS_CONF = process.env.AGENTS_CONF_PATH || '/etc/asterisk/agents.conf';
const PJSIP_CUSTOM = process.env.PJSIP_CUSTOM_PATH || '/etc/asterisk/pjsip_custom.conf';
const CONFIG_API_KEY = process.env.CONFIG_API_KEY?.trim() || '';

function checkAuth(req) {
  if (!CONFIG_API_KEY) return true;
  const key = req.headers['x-config-api-key'];
  return key === CONFIG_API_KEY;
}

async function writeAndReload(filePath, content, reloadCmd) {
  await fs.writeFile(filePath, content, 'utf8');
  try {
    execSync(reloadCmd, { stdio: 'inherit', timeout: 10000 });
  } catch (e) {
    console.error('Reload failed:', e.message);
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const url = req.url?.split('?')[0] || '';
  if (url !== '/config/agents' && url !== '/config/pjsip') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  const content = data?.content;
  if (typeof content !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid "content"' }));
    return;
  }
  try {
    if (url === '/config/agents') {
      await writeAndReload(AGENTS_CONF, content, "asterisk -rx 'module reload app_agent_pool.so'");
    } else {
      await writeAndReload(PJSIP_CUSTOM, content, "asterisk -rx 'module reload res_pjsip.so'");
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Write or reload failed' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Asterisk config receiver listening on port ${PORT}`);
  if (CONFIG_API_KEY) console.log('API key required (X-Config-API-Key)');
});
