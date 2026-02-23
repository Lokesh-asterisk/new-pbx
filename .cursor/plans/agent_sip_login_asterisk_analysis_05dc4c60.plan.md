---
name: Agent SIP Login Asterisk Analysis
overview: Analysis of the agent login flow via SIP extension/softphone and a plan for using Asterisk to implement and test this flow, including current behavior, data flow, and testing options.
todos: []
isProject: false
---

# Agent Login via SIP Extension / Asterisk – Analysis and Testing Plan

## 1. Current flow (as implemented)

### Step-by-step sequence

```mermaid
sequenceDiagram
    participant Agent as Agent Browser
    participant Dashboard as Dashboard Controller
    participant ARI as Asterisk ARI
    participant Asterisk as Asterisk PBX
    participant Dialplan as AgentLogin context
    participant API as US4GROUP_Agent API
    participant DB as agent_status / main_list
    participant Capture as CaptureEvents SSE

    Agent->>Dashboard: 1. Login (web), land on AgentConsoleLogin
    Agent->>Dashboard: 2. Select SIP extension, submit
    Dashboard->>Dashboard: Load agent (phone_login_number, phone_login_password)
    Dashboard->>ARI: 3. POST originate: SIP/{ext}, context=AgentLogin, ext=s, vars AgentNumber, AgentPassword
    ARI->>Asterisk: Create channel, ring SIP extension
    Dashboard->>DB: Insert/update agent_status = "SIP Phone Ringing"
    Dashboard-->>Agent: "success"
    Agent->>Capture: 4. EventSource(CaptureEvents?AgentID=...)
    Asterisk->>Asterisk: 5. SIP phone answers
    Asterisk->>Dialplan: 6. AgentLogin,s: Answer, Set LoginInitiated, curl US4GROUP_AgentLogin
    Dialplan->>API: AgentLogin?AgentID=...
    API->>DB: agent_status = "LoginInitiated"
    Dialplan->>Dialplan: 7. Authenticate(AgentPassword) – prompt + DTMF
    Agent->>Agent: 8. User enters numeric password on soft/hard phone
    Dialplan->>Dialplan: 9. AgentLogin(AgentNumber) – Asterisk app
    Dialplan->>Dialplan: Hangup; callstatus: if LoginCompleted skip AgentLogout
    Capture->>Agent: SSE: AgentStatus (LoginInitiated then LOGGEDIN if updated)
    Agent->>Dashboard: 10. window.location = agent/Dashboard (when LOGGEDIN)
    Dashboard->>Agent: 11. Real agent dashboard (if soft_phone_login_status==1)
```



### Key files and roles


| Component                              | File(s)                                                                                     | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login screen (extension selection)** | [AgentConsoleLogin.php](old/US4TC/US4GROUP/APP/views/agent/Dashboard/AgentConsoleLogin.php) | Form with dropdown of SIP extensions from `sip_extension` (by AdminID). On submit: GET `agent/Dashboard/callExtension?extension_number=&agent_id=`. Then opens EventSource to `CaptureEvents?AgentID=<phone_login_number>`. On event `AgentStatus==LOGGEDIN` redirects to `agent/Dashboard`.                                                                                                                                                                                                                                  |
| **Dashboard controller**               | [dashboard.php](old/US4TC/US4GROUP/APP/controllers/agent/dashboard.php)                     | `index()`: If `soft_phone_login_status==1` → load dashboard; else load AgentConsoleLogin with `softphone_list` from `sip_extension`. `callExtension()`: Validates agent, loads `phone_login_number`, `phone_login_password`, builds ARI originate to `SIP/<extension_number>` with context `AgentLogin`, extension `s`, channel vars `AgentNumber`, `AgentPassword`; calls `RequestAgentLogin()` (which uses `sendRequestToPBX` = ARI). On HTTP 200, inserts/updates `agent_status` with `agentStatus = "SIP Phone Ringing"`. |
| **ARI / PBX helper**                   | [MeowBilla_Controller.php](old/US4TC/US4GROUP/APP/core/MeowBilla_Controller.php)            | `sendRequestToPBX()`: Builds ARI URL from config `asterisk_socket` (ip, user, password), POST with JSON body; returns HTTP status code.                                                                                                                                                                                                                                                                                                                                                                                       |
| **Asterisk dialplan – AgentLogin**     | [us4group.conf](old/asterisk/us4group.conf) (context `[AgentLogin]`)                        | **s**: Answer → Set `AgentStatus=LoginInitiated` → curl `US4GROUP_AgentLogin?AgentID=${AgentNumber}&AgentStatus=LoginInitiated` → `Authenticate(${AgentPassword})` (numeric password on phone) → Set `AgentStatus=LoginCompleted` → `AgentLogin(${AgentNumber})` (Asterisk app) → Hangup. **callstatus**: On hangup, if `AgentStatus != LoginCompleted` call `US4GROUP_AgentLogout?AgentID=...&AgentStatus=LoginFailed`.                                                                                                      |
| **Asterisk API (status updates)**      | [US4GROUP_Agent.php](old/US4TC/US4GROUP/APP/controllers/Asterisk/API/US4GROUP_Agent.php)    | `AgentLogin()`: Sets `agent_status.agentStatus = "LoginInitiated"`. `AgentLogout()`: Sets `agent_status.agentStatus = "LoginFailed"`. (No API is called when password is correct and Asterisk `AgentLogin()` succeeds.)                                                                                                                                                                                                                                                                                                       |
| **Real dashboard view**                | [dashboard.php](old/US4TC/US4GROUP/APP/views/agent/Dashboard/dashboard.php)                 | Shown after SIP login when `soft_phone_login_status==1`. Uses `AgentCode` = `phone_login_number`, EventSource to CaptureEvents; shows call controls, break, transfer, manual dial, CRM search, etc.                                                                                                                                                                                                                                                                                                                           |
| **Event stream**                       | [CaptureEvents.php](old/US4TC/US4GROUP/APP/controllers/agent/CaptureEvents.php)             | SSE endpoint; polls `agent_status` for given `AgentID` and pushes `AgentStatus` (and related fields) to the client.                                                                                                                                                                                                                                                                                                                                                                                                           |


### Data and config dependencies

- **main_list** (per agent): `phone_login_number` (agent number used in Asterisk/queues), `phone_login_password` (numeric, for `Authenticate()`), `soft_phone_login_status` (1 = show dashboard; only ever set to 0 in code on “End Session”).
- **sip_extension**: `name` = extension number (e.g. 1001) shown in dropdown; must match a SIP peer in Asterisk and be registered (soft/hard phone).
- **agent_status**: Tracks state per `agentId` (= `phone_login_number`): e.g. SIP Phone Ringing → LoginInitiated → (optionally) LOGGEDIN.
- **extensions.conf**: Includes `us4group.conf`; globals define `US4GROUP_AgentLogin`, `US4GROUP_AgentLogout` (and other) API base URLs pointing at the web app (e.g. `http://localhost/US4TC/Asterisk/API/`).
- **ARI**: Configured in app config (e.g. `asterisk_socket`: ip, user_name, password); used to originate the call to the selected SIP extension.

### Gaps / clarifications

1. **Who sets `agent_status` to LOGGEDIN?**
  The dialplan only calls `US4GROUP_AgentLogin` (→ LoginInitiated) and `US4GROUP_AgentLogout` (→ LoginFailed). After a successful `AgentLogin(${AgentNumber})` there is no dialplan step or API call that sets `agent_status` to `LOGGEDIN`. So either: (a) Asterisk `agents.conf` (or another integration) triggers a callback to the app when an agent logs in, or (b) the dialplan should be extended to call a “login success” API (e.g. `US4GROUP_AgentLoginSuccess`) after `AgentLogin()` and before Hangup, to set `agent_status = LOGGEDIN` (and optionally `main_list.soft_phone_login_status = 1`).
2. **Who sets `soft_phone_login_status = 1`?**
  In the codebase, `soft_phone_login_status` is only set to `0` (in `endAgentSession()`). So either it is set elsewhere (e.g. admin when enabling “softphone login” for the agent) or it must be set when SIP login succeeds (e.g. in the same “login success” API above).
3. **SIP extension vs agent number**
  The user selects a **SIP extension** (from `sip_extension.name`); the app uses that as the ARI target (`SIP/<extension_number>`). The **agent number** (`phone_login_number`) and password come from `main_list`. The dialplan expects channel variables `AgentNumber` and `AgentPassword`; these are set in the controller from the logged-in agent’s record, not from the selected extension. So the selected extension is only “which phone rings”; the identity and password are the web-logged-in agent’s. Typically you’d have the same extension mapped to that agent (e.g. extension 1001 = agent 1001).

---

## 2. How to use Asterisk for this flow

### A. Prerequisites on the Asterisk machine

- **Asterisk** installed and running (with `us4group.conf` included from `extensions.conf`).
- **ARI** enabled and reachable from the app server (httpd, auth, CORS if needed). App uses ARI to originate the call (`POST /ari/channels/<id>?...`).
- **SIP** configured so that the extensions listed in `sip_extension` exist as peers and can register (e.g. `pjsip.conf` or `sip.conf`).
- **agents.conf** (and optionally **queues.conf**) if you use Asterisk’s `AgentLogin()` / queues; ensure agent numbers match `phone_login_number`.
- **curl** (and any dialplan prerequisites) so that `US4GROUP_AgentLogin` / `US4GROUP_AgentLogout` (and future “login success”) are reachable from Asterisk (same machine or network).

### B. Implementing / fixing the “login success” path

- **Option 1 – New API + dialplan call**  
  - Add an endpoint (e.g. `US4GROUP_Agent/AgentLoginSuccess`) that: sets `agent_status.agentStatus = 'LOGGEDIN'` for the agent, and optionally `main_list.soft_phone_login_status = 1`.  
  - In `[AgentLogin]` in `us4group.conf`, after `AgentLogin(${AgentNumber})`, call this URL (e.g. via `CURL()` or `SHELL(curl ...)`) then Hangup.
- **Option 2 – Asterisk agent callback**  
If you use Asterisk’s agent module and it supports a login callback URL, point it at your app to update `agent_status` and `soft_phone_login_status`. This depends on your Asterisk version and agent configuration.
- **Option 3 – Rely on existing behavior**  
If in your environment `soft_phone_login_status` is already 1 for agents who use SIP (e.g. set by admin), and `LOGGEDIN` is set by some other process (e.g. AMI/ARI listener), then the current dialplan may be enough; the plan would then focus on testing and documenting that path.

### C. Testing agent login with Asterisk

1. **Local / dev Asterisk**
  - Run Asterisk on the same machine or a dev VM.
  - Point `extensions.conf` globals (`US4GROUP_AgentLogin`, etc.) to your app (e.g. `http://<app-host>/US4TC/Asterisk/API/`).
  - Ensure `asterisk_socket` in the app points to this Asterisk’s ARI (host, user, password).
  - Register at least one SIP endpoint (softphone or SIP stack) with extension matching `sip_extension.name` for a test agent.
  - In DB: one agent with `soft_phone_login_status=0` (or 1 if you skip extension selection), correct `phone_login_number` / `phone_login_password`, and one `sip_extension` with same extension number.
2. **Test steps**
  - Log in as that agent → AgentConsoleLogin.
  - Select the SIP extension → submit → phone should ring.
  - Answer on the soft/hard phone; when prompted, enter the numeric `phone_login_password`.
  - Verify: dialplan runs (Answer → LoginInitiated → Authenticate → AgentLogin → Hangup); `agent_status` moves to LoginInitiated then (after implementing success path) to LOGGEDIN; browser redirects to dashboard and dashboard loads.
3. **Debugging**
  - **CLI**: `asterisk -rvvv`; watch channel and dialplan execution during the login call.
  - **Logs**: Full queue logging, ARI requests, and app logs (Dashboard, US4GROUP_Agent, CaptureEvents).
  - **DB**: Inspect `agent_status` and `main_list.soft_phone_login_status` before/after each step.
  - **ARI**: Confirm originate returns 200 and that the channel enters `AgentLogin,s`.
4. **Isolated Asterisk testing (no app)**
  - Use a test context that only does Answer → Authenticate(1234) → Playback(hello) → Hangup to confirm SIP registration and DTMF collection.
  - Then add a stub HTTP endpoint (or mock server) that returns “CONTINUE,LoginInitiated” for `US4GROUP_AgentLogin` and test the full `[AgentLogin]` flow against it.

---

## 3. Summary

- **AgentConsoleLogin** and **Dashboard** drive the UI; **callExtension()** uses **ARI** to ring the chosen **SIP extension**; **[AgentLogin]** in **us4group.conf** answers, notifies the app (**LoginInitiated**), runs **Authenticate(AgentPassword)**, then **AgentLogin(AgentNumber)**. The app never receives a “success” callback today, so **LOGGEDIN** and **soft_phone_login_status** may need to be set by a new API called from the dialplan (or by another integration).
- To **use Asterisk for agent login**: run Asterisk with ARI and SIP, include `us4group.conf`, point API URLs and ARI config at your app, register SIP endpoints for test extensions, and add (if missing) a “login success” API and dialplan call so the dashboard and EventSource see LOGGEDIN and the agent can land on the real dashboard after entering the numeric password on their soft/hard phone.

