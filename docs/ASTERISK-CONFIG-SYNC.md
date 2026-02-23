# Asterisk config sync (GUI → config files)

When you create or update **agents** or **SIP extensions** in the Super Admin dashboard, the app can push the config to your Asterisk server so `agents.conf` and PJSIP extension config are updated automatically.

## Overview

- **PBX app** (e.g. 10.50.7.181): After creating/updating an agent or creating an extension, it POSTs the full agents list or PJSIP extensions list to a small HTTP service on the Asterisk server.
- **Asterisk server** (e.g. 10.50.2.190): A small “config receiver” service listens for those POSTs, writes the content to `agents.conf` and `pjsip_custom.conf`, then runs the appropriate Asterisk reload.

## 1. Run the config receiver on the Asterisk server

On the **Asterisk VM** (10.50.2.190):

1. Copy or clone the project so you have the `scripts/asterisk-config-receiver` folder (or copy only that folder and `server.js` + `package.json`).

2. Install and run (Node.js must be installed):

   ```bash
   cd scripts/asterisk-config-receiver
   npm install   # optional – no deps; or skip if using system node
   node server.js
   ```

3. Optional env vars (create a `.env` or export before running):

   | Variable | Default | Description |
   |----------|---------|--------------|
   | `PORT` | 9999 | HTTP port the receiver listens on. |
   | `AGENTS_CONF_PATH` | `/etc/asterisk/agents.conf` | Path to agents.conf. |
   | `PJSIP_CUSTOM_PATH` | `/etc/asterisk/pjsip_custom.conf` | Path to the PJSIP custom file. |
   | `CONFIG_API_KEY` | (none) | If set, the PBX app must send header `X-Config-API-Key: <value>`. |

4. The process must be able to **write** to `/etc/asterisk/` and run `asterisk -rx '...'`. Run as root or ensure the node user has write access and can execute `asterisk`.

5. Keep it running (e.g. systemd service or screen/tmux). Open firewall port 9999 (or your `PORT`) from the PBX app host only.

## 2. Include the PJSIP custom file in Asterisk

On the Asterisk server, ensure the generated extensions are loaded. In `pjsip.conf` (or your main PJSIP config), add:

```ini
#include "pjsip_custom.conf"
```

If you set `PJSIP_CUSTOM_PATH` to a different path, use that path here (relative to Asterisk config directory or absolute as supported). Then run:

```bash
asterisk -rx 'module reload res_pjsip.so'
```

so the include is read.

## 3. Configure the PBX app to push config

On the **host where the Node API runs** (e.g. 10.50.7.181), in `.env`:

```env
# URL of the config receiver (Asterisk VM). No trailing slash.
ASTERISK_CONFIG_API_URL=http://10.50.2.190:9999

# Optional: must match CONFIG_API_KEY on the receiver
ASTERISK_CONFIG_API_KEY=your-secret-key
```

Restart the API server. If these are not set, the app still works; it just does not push config to Asterisk (you manage agents.conf and PJSIP by hand).

## 4. What gets synced

| Action in Super Admin | What is pushed | Asterisk file | Reload |
|-----------------------|----------------|---------------|--------|
| Create user (role agent) | Full list of all agents (role 5 with phone_login_number) | agents.conf | app_agent_pool.so |
| Update agent phone / PIN | Full list of all agents | agents.conf | app_agent_pool.so |
| Delete user (agent) | Full list of all agents (deleted agent removed) | agents.conf | app_agent_pool.so |
| Create SIP extension | Full list of all sip_extensions | pjsip_custom.conf | res_pjsip.so |
| Update SIP extension | Full list of all sip_extensions | pjsip_custom.conf | res_pjsip.so |
| Delete SIP extension | Full list of all sip_extensions (deleted extension removed) | pjsip_custom.conf | res_pjsip.so |

- **agents.conf** is overwritten with `[general]` and one `[agent_id]` + `fullname=...` per agent.
- **pjsip_custom.conf** is overwritten with endpoint, auth, and aor sections for each extension (name, secret, context from DB).
- Add, update, and delete in the GUI all trigger a full sync so Asterisk config files stay in sync.

## 5. Troubleshooting

- **Sync not happening:** Check `ASTERISK_CONFIG_API_URL` and `ASTERISK_CONFIG_API_KEY` in `.env`, and that the API server was restarted. Check API logs for “Asterisk agents sync” or “Asterisk extensions sync” errors.
- **401 Unauthorized:** Set `ASTERISK_CONFIG_API_KEY` in the app’s `.env` and `CONFIG_API_KEY` on the receiver to the same value; the app sends `X-Config-API-Key`.
- **Receiver cannot write:** Run the receiver as root or give the node user write permission to `/etc/asterisk/` and the config files.
- **Reload fails:** Run `asterisk -rx 'module reload app_agent_pool.so'` and `asterisk -rx 'module reload res_pjsip.so'` by hand on the Asterisk server to see errors; fix config syntax or paths.
