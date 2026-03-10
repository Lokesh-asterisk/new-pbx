# Two ways to use the dialplan

You can either **keep your current files** and add only the inbound/queue flow, or use **one full file**. Pick one.

---

## Option 1: Keep your current setup (recommended if you already have it)

You already have:

- **[globals]** in **extensions.conf** (with APIURL, Phase 3 URLs, etc.)
- **#include "pbx.conf"** (with AgentLogin)
- **#include "phase3-dialplan.conf"** (Phase 3 subroutines)

**Keep all of that as-is.** Then:

### 1. Add two variables to [globals] in extensions.conf

Add these two lines to your existing `[globals]` section (if not already there):

```ini
INBOUND_ROUTE=${APIURL}InboundRoute?
QUEUE_MEMBERS=${APIURL}QueueMembers?
```

So your globals might look like:

```ini
[globals]
APIURL=http://YOUR_APP_HOST:3001/api/asterisk/
US4GROUP_AgentLogin=${APIURL}US4GROUP_Agent/AgentLogin?
US4GROUP_AgentLogout=${APIURL}US4GROUP_Agent/AgentLogout?
US4GROUP_AgentLoginSuccess=${APIURL}US4GROUP_Agent/AgentLoginSuccess?
PHASE3_INCOMING_CALL=${APIURL}IncomingCall?
PHASE3_CALL_ANSWERED=${APIURL}CallAnswered?
PHASE3_CALL_HANGUP=${APIURL}CallHangup?
PHASE3_RECORDING=${APIURL}Recording?
INBOUND_ROUTE=${APIURL}InboundRoute?
QUEUE_MEMBERS=${APIURL}QueueMembers?
```

### 2. Add the inbound/queue/extension file

- Copy **pbx-inbound.conf** to the Asterisk server (e.g. `/etc/asterisk/pbx-inbound.conf`).
- In **extensions.conf** add one more include (order can be after phase3-dialplan.conf):

```ini
#include "phase3-dialplan.conf"
#include "pbx-inbound.conf"
```

**Do not** include **pbx-callcentre.conf** here; that would duplicate AgentLogin and Phase 3.

### 3. Point inbound calls to the new flow

Point your trunk/DID to context **inbound** (e.g. in the context that receives the call):

```ini
exten => _X.,1,Goto(inbound,s,1)
```

**Summary for Option 1:**

| File / place | Role |
|--------------|------|
| **extensions.conf** | [globals] + `#include "pbx.conf"` + `#include "phase3-dialplan.conf"` + `#include "pbx-inbound.conf"`. Add INBOUND_ROUTE and QUEUE_MEMBERS to [globals]. |
| **pbx.conf** | Keep as-is (AgentLogin). |
| **phase3-dialplan.conf** | Keep as-is (Phase 3 subroutines). |
| **pbx-inbound.conf** | New: [inbound], [WhereToGO], [Queue], [SipExtension], [callstatus], [from-pstn], [from-internal]. |
| **pbx-callcentre.conf** | Do **not** use in this setup. |

---

## Option 2: One file only (no pbx.conf / phase3-dialplan.conf)

If you prefer a single dialplan file and are **not** using the split setup above:

- Use **only pbx-callcentre.conf** (it has [globals], AgentLogin, Phase 3, and inbound/queue/extension).
- In **extensions.conf** have only:

```ini
#include "pbx-callcentre.conf"
```

- Do **not** include pbx.conf or phase3-dialplan.conf (everything is in pbx-callcentre.conf).
- Set **APIURL** inside the [globals] in pbx-callcentre.conf (or merge those variables into your existing [globals] and remove the [globals] block from pbx-callcentre.conf).

---

## Quick decision

- **Already using globals + pbx.conf + phase3-dialplan.conf** → stay with them, add **INBOUND_ROUTE** and **QUEUE_MEMBERS** to globals, and add **pbx-inbound.conf** (Option 1). Do **not** add pbx-callcentre.conf.
- **Starting fresh or want one file** → use **pbx-callcentre.conf** only and do not include pbx.conf or phase3-dialplan.conf (Option 2).
