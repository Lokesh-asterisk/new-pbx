# Full dialplan for new app (no us4group.conf)

This describes the **standalone** dialplan that works with the new Node app only. You do **not** use `us4group.conf` anymore.

---

## Files

| File | Purpose |
|------|--------|
| **pbx-callcentre.conf** | Full dialplan: globals, inbound, queue, extension, AgentLogin, Phase 3. Paste or include this on the Asterisk server. |

---

## Where to paste on the Asterisk server

### Option A – Single include (recommended)

1. Copy **pbx-callcentre.conf** to the Asterisk config directory:
   ```bash
   sudo cp pbx-callcentre.conf /etc/asterisk/
   ```
2. Edit **/etc/asterisk/extensions.conf** and add **one line** (e.g. at the top, after `[general]` if present):
   ```ini
   #include "pbx-callcentre.conf"
   ```
3. In **pbx-callcentre.conf** (on the server), set **APIURL** in the `[globals]` section to your Node app URL, for example:
   ```ini
   APIURL=http://10.50.7.181:3001/api/asterisk/
   ```
   Use your app’s host/IP and port (default 3001). No trailing slash.

### Option B – You already have [globals] in extensions.conf

If **extensions.conf** already has a `[globals]` section:

1. Do **not** add another `[globals]` block. Open **pbx-callcentre.conf**, copy **only the variable lines** (from `APIURL=` through `PHASE3_RECORDING=...`), and paste them into the existing `[globals]` in **extensions.conf**. Set **APIURL** to your Node app URL.
2. Copy the **rest** of **pbx-callcentre.conf** (from `[inbound]` to the end) into **extensions.conf**, or put that part in a separate file and `#include` it.

---

## Pointing calls at the new dialplan

- **Inbound from trunk / DID**  
  Your trunk or DID must send calls into the **inbound** context.  
  Example: in the context that receives the DID (e.g. `from-pstn` or your trunk context), use:
  ```ini
  exten => _X.,1,Goto(inbound,s,1)
  ```
  The dialplan uses **CALLERID(dnid)** as the DID; set it before `Goto(inbound,s,1)` if your trunk doesn’t set it (see `[from-pstn]` in the conf).

- **Agent SIP login**  
  The Node app uses ARI to originate a call into the **AgentLogin** context with channel variables **AgentNumber** and **AgentPassword**. No change needed if you already use that.

---

## What the dialplan does (same idea as old app)

| Flow | Behaviour |
|------|------------|
| **Inbound** | Call enters `inbound` → curl **InboundRoute** (DID + caller) → app returns destination (queue or extension) from `inbound_routes` table. |
| **WhereToGO** | Branches: 0 = hangup, 2 = Queue, 9 = SipExtension. |
| **Queue** | Curl **QueueMembers** to get the list of agents for that queue → try each agent in order with **Phase 3** (IncomingCall → ring → CallAnswered / CallHangup). First to answer gets the call. |
| **SipExtension** | Ring a single extension with **Phase 3** (IncomingCall, CallAnswered, CallHangup). |
| **AgentLogin** | Answer → curl AgentLogin → Authenticate(AgentPassword) → AgentLogin(AgentNumber) → curl AgentLoginSuccess → Hangup. On hangup before success, curl AgentLogout. |

So the new app behaves like the old one: inbound → route by DID → queue (try agents in order) or single extension, plus agent SIP login, all without us4group.conf.

---

## Database (Node app)

- **inbound_routes** – DID, `destination_type` (`queue` or `extension`), `destination_id` (id in `queues` or `sip_extensions`). Used by **InboundRoute**.
- **queues** – Queue names. **QueueMembers** is called with `QueueName` (from `queues.name`).
- **queue_members** – Which agents are in which queue: `queue_name`, `member_name` (extension number, e.g. 1001). Used by **QueueMembers**.
- **sip_extensions** – Extension names/numbers for “inbound to extension”.

---

## PJSIP vs SIP

The dialplan uses **PJSIP** (e.g. `Dial(PJSIP/1001,...)`). If your agents are on **chan_sip**, in **pbx-callcentre.conf** replace **PJSIP/** with **SIP/** in the `Dial()` line inside `[pbx-phase3-ring-one]`.

---

## Reload

After editing:

```bash
sudo asterisk -rx 'dialplan reload'
```
