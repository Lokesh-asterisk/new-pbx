# Asterisk config sync (GUI → config files)

When you create or update **agents**, **SIP extensions**, or **SIP trunks** in the Super Admin dashboard, the app can push the config to your Asterisk server so `agents.conf`, PJSIP extension config, and PJSIP trunk config are updated automatically.

## Overview

- **PBX app** (e.g. 10.50.7.181): After creating/updating an agent, extension, or trunk, it POSTs the full list to a small HTTP service on the Asterisk server.
- **Asterisk server** (e.g. 10.50.2.190): A small “config receiver” service listens for those POSTs, **creates or overwrites** the target config files (`agents.conf`, `pjsip_custom.conf`, `pjsip_trunks_custom.conf`), then runs the appropriate Asterisk reload. You do not need to create the included files by hand—the receiver creates them on first write.

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
   | `PJSIP_CUSTOM_PATH` | `/etc/asterisk/pjsip_custom.conf` | Path to PJSIP extensions (app-generated). |
   | `PJSIP_TRUNKS_PATH` | `/etc/asterisk/pjsip_trunks_custom.conf` | Path to PJSIP trunks (app-generated). |
   | `CONFIG_API_KEY` | (none) | If set, the PBX app must send header `X-Config-API-Key: <value>`. |
   | `ASTERISK_LOG_DIR` | `/var/log/asterisk` | Directory for log files (used by GET `/logs/:file` for the dashboard). |

4. The process must be able to **write** to `/etc/asterisk/` and run `asterisk -rx '...'`. For the **Asterisk Logs** dashboard view (remote setup), it must also be able to **read** files under `ASTERISK_LOG_DIR` (e.g. `full`, `messages`, `queue_log`).

5. Keep it running (e.g. systemd service or screen/tmux). Open firewall port 9999 (or your `PORT`) from the PBX app host only.

## 2. Include the PJSIP custom files in Asterisk

On the Asterisk server, ensure the generated extensions and trunks are loaded. In your main **`pjsip.conf`**, add **both** includes (order can matter if trunks reference transports; typically extensions first, then trunks):

```ini
; App-generated PJSIP extensions (created/overwritten by config receiver)
#include "pjsip_custom.conf"
; App-generated PJSIP trunks (created/overwritten by config receiver)
#include "pjsip_trunks_custom.conf"
```

You do **not** need to create `pjsip_custom.conf` or `pjsip_trunks_custom.conf` manually. The config receiver **creates both files on startup** if they are missing (with a placeholder line), then overwrites them when the app pushes config. **Restart the config receiver** before loading Asterisk so the files exist. Alternatively, use `#tryinclude` so Asterisk does not fail if a file is missing:

```ini
#tryinclude "pjsip_custom.conf"
#tryinclude "pjsip_trunks_custom.conf"
```

Use `#include` (required files) for normal operation; use `#tryinclude` only if you want Asterisk to start even when the receiver has not run yet. If you set `PJSIP_CUSTOM_PATH` or `PJSIP_TRUNKS_PATH` to different paths, use those paths in the includes (relative to Asterisk config directory or absolute as supported). After adding the includes, run:

```bash
asterisk -rx 'module reload res_pjsip.so'
```

so the includes are read.

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
| Create SIP trunk | Full list of all sip_trunks | pjsip_trunks_custom.conf | res_pjsip.so |
| Update SIP trunk | Full list of all sip_trunks | pjsip_trunks_custom.conf | res_pjsip.so |
| Delete SIP trunk | Full list of all sip_trunks (deleted trunk removed) | pjsip_trunks_custom.conf | res_pjsip.so |

- **agents.conf** is overwritten with `[general]` and one `[agent_id]` + `fullname=...` per agent.
- **pjsip_custom.conf** is overwritten with endpoint, auth, and aor sections for each extension (name, secret, context from DB).
- **pjsip_trunks_custom.conf** is overwritten with endpoint, auth, aor (and optionally registration, identify) sections for each trunk from the `sip_trunks` table; trunk options come from `config_json`.
- Add, update, and delete in the GUI all trigger a full sync so Asterisk config files stay in sync.

**SIP trunk config_json (for Super Admin GUI):** Each trunk has a `config_json` object (or JSON string). Supported shape: **type** `"endpoint"` (default) or `"registration"`; **common:** `transport`, `context`, `username`, `password`, `realm`; **endpoint:** `aor_contact`, **`identify_match`** (provider IP string or array, e.g. `"208.93.46.221"`); **registration:** `server_uri`, `client_uri`, `contact_user`. **Inbound calls:** For trunks that receive inbound from a provider, you must set `identify_match` to the provider’s IP so PJSIP can match the INVITE to this endpoint (otherwise Asterisk logs "No matching endpoint found").

## 5. Asterisk Logs (Super Admin dashboard)

The **Asterisk Logs** view in Super Admin lets you view `full`, `messages`, and `queue_log` without logging into the Asterisk server.

- **Same server (production):** Set `ASTERISK_LOG_DIR=/var/log/asterisk` in the app's `.env`. The Node app reads log files directly. No config-receiver needed for logs.
- **Remote (Asterisk on another host):** Leave `ASTERISK_LOG_DIR` unset. Set `ASTERISK_CONFIG_API_URL` (and optionally `ASTERISK_CONFIG_API_KEY`) as above. The config-receiver on the Asterisk server exposes GET `/logs/:file` and GET `/logs/:file/stream`; the app proxies these. Ensure the receiver has read access to `ASTERISK_LOG_DIR` (default `/var/log/asterisk`) and that you are running the updated config-receiver that includes the log endpoints.

## 6. Manual sync

From the Super Admin dashboard **Overview**, use the **Sync to Asterisk** button to push the current DB state (agents, extensions, trunks) to the Asterisk config receiver. Use this after bulk changes or if automatic sync after add/update/delete did not run (e.g. `ASTERISK_CONFIG_API_URL` was not set). The button shows a message when sync is skipped or succeeds.

## 7. Troubleshooting

- **Sync not happening:** Check `ASTERISK_CONFIG_API_URL` and `ASTERISK_CONFIG_API_KEY` in `.env`, and that the API server was restarted. Check API logs for “Asterisk agents sync”, “Asterisk extensions sync”, or “Asterisk trunks sync” errors.
- **401 Unauthorized:** Set `ASTERISK_CONFIG_API_KEY` in the app’s `.env` and `CONFIG_API_KEY` on the receiver to the same value; the app sends `X-Config-API-Key`.
- **Receiver cannot write:** Run the receiver as root or give the node user write permission to `/etc/asterisk/` and the config files.
- **Reload fails:** Run `asterisk -rx 'module reload app_agent_pool.so'` and `asterisk -rx 'module reload res_pjsip.so'` by hand on the Asterisk server to see errors; fix config syntax or paths.
- **"pjsip_trunks_custom.conf was listed as a #include but it does not exist":** Asterisk requires every `#include`d file to exist. Fix by: (1) **Restart the config receiver** (`node server.js`)—it now creates `pjsip_custom.conf` and `pjsip_trunks_custom.conf` on startup if missing. (2) Or create the files by hand: `touch /etc/asterisk/pjsip_custom.conf /etc/asterisk/pjsip_trunks_custom.conf`. (3) Or in `pjsip.conf` use `#tryinclude` instead of `#include` for these two lines so Asterisk skips them if the file is missing (then reload will succeed and the next sync will populate the files).
- **Endpoint still shows after delete:** If you removed a PJSIP extension in the dashboard but it still appears in `pjsip show endpoints`: (1) Ensure `ASTERISK_CONFIG_API_URL` is set so sync runs when you delete; (2) Ensure that endpoint is **not** defined in the main `pjsip.conf`—only in the app-generated file (e.g. `pjsip_custom.conf`). If it is in the main config, remove it there and keep it only in the included file. (3) Click **Sync to Asterisk** to push the current DB state, then on the Asterisk server run `asterisk -rx 'module reload res_pjsip.so'`. If the endpoint still appears, try `asterisk -rx 'core reload'` or restart Asterisk.
- **"No matching endpoint found" on inbound:** Inbound INVITEs from your provider are matched by PJSIP using an **identify** section (by IP). Edit the trunk in Super Admin and use **JSON** for peer details with **`identify_match`** set to your provider’s IP (e.g. `"identify_match": "208.93.46.221"`). Then click **Sync to Asterisk**. The generated `pjsip_trunks_custom.conf` will include `type=identify` and `match=208.93.46.221` for that trunk so Asterisk accepts the call.
