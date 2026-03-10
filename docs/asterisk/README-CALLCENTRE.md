# Call Centre – Simple Asterisk Setup

Two files only:

1. **extensions.conf** – `[globals]` and one include
2. **callcentre.conf** – all dialplan (inbound, queue, extension, agent login)

---

## 1. extensions.conf

In the **`[globals]`** section, add (replace `YOUR_APP_HOST:3001` with your Node app):

```ini
[globals]
; Call centre app (no trailing slash)
APP_URL=http://YOUR_APP_HOST:3001/api/asterisk/
AGENT_LOGIN=${APP_URL}AgentLogin?
AGENT_LOGOUT=${APP_URL}AgentLogout?
AGENT_LOGIN_SUCCESS=${APP_URL}AgentLoginSuccess?
INBOUND_ROUTE=${APP_URL}InboundRoute?
QUEUE_MEMBERS=${APP_URL}QueueMembers?
CALL_INCOMING=${APP_URL}IncomingCall?
CALL_ANSWERED=${APP_URL}CallAnswered?
CALL_HANGUP=${APP_URL}CallHangup?
RECORDING=${APP_URL}Recording?
```

Then include the dialplan file:

```ini
#include "callcentre.conf"
```

---

## 2. callcentre.conf

- Copy **callcentre.conf** from this folder to your Asterisk config directory (e.g. `/etc/asterisk/`).
- It contains everything: inbound, WhereToGO, Queue, SipExtension, callstatus, AgentLogin, notify-incoming/answered/hangup, ring-agent, hangup-customer, from-pstn, from-internal.

---

## 3. Queue calls: dashboard-only (no softphone ring until agent answers)

For **queue** calls, the dialplan sends the customer to the Stasis app **queue-dashboard**. The call appears **only** on the agent’s dashboard; the agent’s softphone does **not** ring until the agent clicks **Answer**. Then the app uses ARI to create a bridge and ring the agent’s phone; when they answer, the call is connected.

**Requirements:**

- **ARI** must be enabled on Asterisk and reachable from the Node app (`.env`: `ASTERISK_ARI_URL`, `ASTERISK_ARI_USER`, `ASTERISK_ARI_PASSWORD`).
- In **ari.conf**, ensure the Stasis app **queue-dashboard** is allowed (or use the default `allowed_origins` so the Node app can connect to the ARI WebSocket).
- The Node app connects to ARI’s WebSocket and handles Stasis events for `queue-dashboard`; no extra Asterisk config is needed beyond ARI.

After a call ends (hangup from dashboard or phone), the agent session stays connected and the agent is ready for the next call.

---

## 4. What to do on Asterisk

1. Set **APP_URL** in `[globals]` to your Node app (e.g. `http://10.0.0.5:3001/api/asterisk/`).
2. Point your trunk/DID to context **inbound** (e.g. from your trunk context: `Goto(inbound,s,1)`).
3. For agent SIP login, ARI/originate to context **AgentLogin** with channel variables **AgentNumber** and **AgentPassword**.
4. Ensure the app database has **inbound_routes**, **queues**, **queue_members**, and **sip_extensions** (or equivalent) configured.
5. For queue-dashboard flow, enable ARI and set the Node app’s ARI credentials in `.env`.

---

## Variable names (purpose)

| Variable | Purpose |
|----------|---------|
| APP_URL | Base URL of the call centre Node app API |
| AGENT_LOGIN | Agent login start (before Authenticate) |
| AGENT_LOGOUT | Agent logout / login failed |
| AGENT_LOGIN_SUCCESS | Agent login success (after AgentLogin()) |
| INBOUND_ROUTE | DID → queue or extension lookup |
| QUEUE_MEMBERS | List of queue members for a queue |
| CALL_INCOMING | Notify app: call ringing at agent |
| CALL_ANSWERED | Notify app: call answered |
| CALL_HANGUP | Notify app: call ended |
| RECORDING | Notify app: recording path (optional) |

---

## Stasis app queue-dashboard

- **Queue** calls use `Stasis(queue-dashboard, agentExten, queueName, UNIQUEID)` so the customer is held in the app.
- The Node app notifies the dashboard (IncomingCall) and, when the agent clicks **Answer**, creates an ARI bridge, adds the customer, and originates a call to the agent’s PJSIP extension; when the agent answers, the channel is added to the bridge.
- **Reject** or **Hangup** from the dashboard hangs up the customer and clears state; the agent remains logged in.
