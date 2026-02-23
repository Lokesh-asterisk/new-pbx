# Asterisk agent SIP login – setup (new app + VM)

Use this when the **Asterisk server** runs on a VM (e.g. 10.50.2.190) and the **new Node/Express app** runs on your host (e.g. 10.50.7.181, port 3001).

---

## 1. New app config (on host 10.50.7.181)

The app uses ARI on the Asterisk VM to originate the agent-login call.

**File:** `.env` (copy from `.env.example` and set):

```env
# Asterisk ARI – app calls this to ring the agent's SIP phone. No /ari suffix.
ASTERISK_ARI_URL=http://10.50.2.190:8088
ASTERISK_ARI_USER=myuser
ASTERISK_ARI_PASSWORD=india@123
```

- **ASTERISK_ARI_URL** = base URL of Asterisk HTTP server (e.g. `http://10.50.2.190:8088`). Do not include `/ari`.
- **ASTERISK_ARI_USER** / **ASTERISK_ARI_PASSWORD** = ARI user from Asterisk `ari.conf`.

---

## 2. Asterisk VM config (10.50.2.190)

The dialplan calls the **new app** for AgentLogin, AgentLogout, and AgentLoginSuccess. Those HTTP requests are made **from the Asterisk VM**, so the VM must be able to reach the host.

### 2.1 Dialplan (reference: `old/asterisk/`)

Use the **old** PBX files in `old/asterisk/` only as **reference**. On the VM you need:

- An **AgentLogin** context that:
  - Answers the call, sets `AgentStatus=LoginInitiated`, curls **AgentLogin?AgentID=${AgentNumber}&AgentStatus=LoginInitiated**
  - Runs **Authenticate(${AgentPassword})**
  - Sets `AgentStatus=LoginCompleted`, runs **AgentLogin(${AgentNumber})**
  - Curls **AgentLoginSuccess?AgentID=${AgentNumber}** (so the new app sets LOGGEDIN and soft_phone_login_status)
  - Hangup
- A **callstatus** extension that on hangup calls **AgentLogout?AgentID=...&AgentStatus=LoginFailed** if login did not complete.

In `extensions.conf` **[globals]** set:

```ini
; New app base URL (Asterisk VM must reach this). Port 3001, path /api/asterisk/
APIURL=http://10.50.7.181:3001/api/asterisk/

US4GROUP_AgentLogin=${APIURL}US4GROUP_Agent/AgentLogin?
US4GROUP_AgentLogout=${APIURL}US4GROUP_Agent/AgentLogout?
US4GROUP_AgentLoginSuccess=${APIURL}US4GROUP_Agent/AgentLoginSuccess?
```

If your app runs on a different port or path, change **APIURL** accordingly (the new app serves Asterisk callbacks at `/api/asterisk/`).

### 2.2 Reload dialplan

On the Asterisk VM:

```bash
sudo asterisk -rx 'dialplan reload'
```

---

## 3. New app API (no changes needed)

| Endpoint | Method | Called by |
|----------|--------|-----------|
| `/api/asterisk/US4GROUP_Agent/AgentLogin` | GET | Dialplan when call answered |
| `/api/asterisk/US4GROUP_Agent/AgentLogout` | GET | Dialplan on hangup (login failed) |
| `/api/asterisk/US4GROUP_Agent/AgentLoginSuccess` | GET | Dialplan after successful AgentLogin() |
| `/api/agent/call-extension` | POST | Frontend when agent selects extension for SIP login |
| `/api/agent/status` | GET | Frontend to poll until agentStatus === 'LOGGEDIN' |

---

## 4. Agent data (new app DB)

- **users**: For each agent (role 5), set **phone_login_number** (e.g. `1001`) and **phone_login_password** (numeric PIN for Authenticate, e.g. `1234`). These are sent to Asterisk as channel variables.
- **agent_status**: Updated by the Asterisk API routes (LoginInitiated, SIP Phone Ringing, LoginFailed, LOGGEDIN).
- **sip_extensions**: Extensions listed for the tenant (e.g. 1001, 1002). Agent selects one; the app originates to `SIP/<name>`.

---

## 5. Reachability

| From          | To              | Requirement |
|---------------|-----------------|-------------|
| Host (app)    | Asterisk VM     | TCP 8088 (ARI) open. Set ASTERISK_ARI_* in .env. |
| Asterisk VM   | Host (app)      | VM can reach `http://10.50.7.181:3001`. App listens on 0.0.0.0 or the host IP. |

From the VM, test:

```bash
curl -v "http://10.50.7.181:3001/api/asterisk/US4GROUP_Agent/AgentLogin?AgentID=1001&AgentStatus=LoginInitiated"
```

You should get HTTP 200 and body `CONTINUE,LoginInitiated`.

---

## 6. Agent login flow (summary)

1. Agent logs in to the new app and selects a SIP extension (or calls `POST /api/agent/call-extension` with extension_id/extension_name).
2. App calls ARI to originate to that extension (context AgentLogin, variables AgentNumber, AgentPassword).
3. SIP phone rings; agent answers; dialplan runs: Answer → AgentLogin (app sets LoginInitiated) → Authenticate(AgentPassword) → AgentLogin(AgentNumber) → **AgentLoginSuccess** (app sets LOGGEDIN and soft_phone_login_status=1) → Hangup.
4. Frontend polls `GET /api/agent/status` until `agentStatus === 'LOGGEDIN'`, then redirects to dashboard.

If the agent hangs up before entering the correct password, the dialplan calls AgentLogout and the app sets status to LoginFailed.
