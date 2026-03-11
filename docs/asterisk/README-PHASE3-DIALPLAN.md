# Phase 3 Asterisk dialplan – where to paste

This folder contains dialplan snippets for **Phase 3 real-time call handling**. The Asterisk server must be able to reach your Node app over HTTP (e.g. `http://YOUR_APP_HOST:3001`).

---

## 1. Where Asterisk keeps dialplan

On a typical Linux Asterisk server:

| File / directory | Purpose |
|------------------|--------|
| **`/etc/asterisk/extensions.conf`** | Main dialplan. You add `#include` and/or paste `[globals]` lines here. |
| **`/etc/asterisk/`** | Other config (e.g. `pjsip.conf`, `queues.conf`). |

So:

- **Globals** → add the Phase 3 variables into the **`[globals]`** section of **`/etc/asterisk/extensions.conf`**.
- **Dialplan** → either paste the Phase 3 contexts into **`/etc/asterisk/extensions.conf`**, or put them in a separate file and **`#include`** that file from `extensions.conf`.

---

## 2. Step-by-step placement

### Step 2.1 – Add Phase 3 globals

Open **`/etc/asterisk/extensions.conf`** and find the **`[globals]`** section. Add (or merge) these lines. Replace `http://YOUR_APP_HOST:3001` with the URL of your Node app (host/IP and port) so Asterisk can reach it:

```ini
[globals]
; ... your existing globals (APIURL, US4GROUP_AgentLogin, etc.) ...

; Phase 3 – Node app base URL (no trailing slash)
APIURL=http://YOUR_APP_HOST:3001/api/asterisk/

; Phase 3 call event URLs (used by phase3-dialplan.conf)
PHASE3_INCOMING_CALL=${APIURL}IncomingCall?
PHASE3_CALL_ANSWERED=${APIURL}CallAnswered?
PHASE3_CALL_HANGUP=${APIURL}CallHangup?
PHASE3_RECORDING=${APIURL}Recording?
```

Example: if the app runs on `10.50.7.181` port `3001`:

```ini
APIURL=http://10.50.7.181:3001/api/asterisk/
PHASE3_INCOMING_CALL=${APIURL}IncomingCall?
PHASE3_CALL_ANSWERED=${APIURL}CallAnswered?
PHASE3_CALL_HANGUP=${APIURL}CallHangup?
PHASE3_RECORDING=${APIURL}Recording?
```

If you already have `APIURL` for the new app (e.g. from ASTERISK-AGENT-LOGIN-SETUP.md), add only the `PHASE3_*` lines.

---

### Step 2.2 – Add Phase 3 dialplan

**Option A – Include a separate file (recommended)**

1. Copy **`phase3-dialplan.conf`** from this repo to the Asterisk server, for example:
   ```bash
   sudo cp phase3-dialplan.conf /etc/asterisk/
   ```
2. In **`/etc/asterisk/extensions.conf`**, add an include **after** the `[globals]` section and **before** any context that uses Phase 3 (e.g. before `#include us4group.conf` if you use it):

   ```ini
   #include "phase3-dialplan.conf"
   ```

**Option B – Paste into extensions.conf**

1. Open **`phase3-dialplan.conf`** from this repo.
2. Copy its contents (from `[pbx-phase3-incoming]` to the end of the file).
3. Paste them into **`/etc/asterisk/extensions.conf`** after `[globals]` and before your main contexts (e.g. before `[US4GROUP]` or `#include us4group.conf`).

---

### Step 2.3 – Use Phase 3 when ringing an agent

Where you currently **ring a single agent** (e.g. “inbound to extension” or “ring agent 1001”), call the Phase 3 subroutine instead of (or in addition to) a plain `Dial()`.

**Example – ring one agent with Phase 3 (e.g. from your inbound flow):**

```ini
; Agent extension number (e.g. 1001) and optional queue name
Set(PHASE3_AGENT_ID=1001)
Set(PHASE3_QUEUE_NAME=Support)
Gosub(pbx-phase3-ring-one,s,1(${PHASE3_AGENT_ID},${PHASE3_QUEUE_NAME}))
```

So:

- **Where to paste this:** in the place in **`/etc/asterisk/extensions.conf`** (or in **`us4group.conf`** if you `#include` it) where you today do something like `Dial(SIP/1001,...)` or `GoSub(...,SipExtension,...)` for a **single** agent. Replace that with the three lines above (with the right agent id and queue name), or call `Gosub(pbx-phase3-ring-one,s,1(1001,Support))` with your own variables.

**Example – replace “SipExtension” with Phase 3 (in us4group.conf or equivalent):**

If you have something like:

```ini
exten => SipExtension,1,...
 same => n,Dial(SIP/${ExtensionNumber},...)
```

you can change it to:

```ini
exten => SipExtension,1,...
 same => n,Gosub(pbx-phase3-ring-one,s,1(${ExtensionNumber},Inbound))
 same => n,Return()
```

(Adjust `ExtensionNumber` / queue name to match your variables.)

---

### Step 2.4 – Optional: Recording callback

To send the recording path to the Node app when a call is recorded:

- After **MixMonitor** or **Record**, when you have the file path and the call’s **UniqueID**, call the Recording URL, e.g. from a shell script or from the dialplan:

  ```ini
  Set(PHASE3_REC_PATH=${URIENCODE(${RECORDED_FILE})})
  Set(PHASE3_REC_RESULT=${SHELL(curl -s "${PHASE3_RECORDING}UniqueID=${UNIQUEID}&Path=${PHASE3_REC_PATH}")})
  ```

- Or from the command line (for testing):

  ```bash
  curl -s "http://YOUR_APP_HOST:3001/api/asterisk/Recording?UniqueID=UNIQUEID&Path=/path/to/file.wav"
  ```

---

## 3. Reload and test

On the Asterisk server:

```bash
sudo asterisk -rx 'dialplan reload'
```

From the Asterisk server, test that it can reach the app:

```bash
curl -s "http://YOUR_APP_HOST:3001/api/asterisk/IncomingCall?AgentID=1001&UniqueID=test123&ChannelID=ch1&CustomerChannelID=ch2&CustomerNumber=15551234567&QueueName=Support"
```

You should get a JSON response like `{"ok":true}`.

---

## 4. File summary

| File in repo | Purpose | Where it goes on Asterisk |
|--------------|--------|----------------------------|
| **phase3-globals.conf** | Reference for globals to add | Copy the lines into `[globals]` in `/etc/asterisk/extensions.conf` |
| **phase3-dialplan.conf** | Phase 3 contexts and subroutines | Copy to `/etc/asterisk/phase3-dialplan.conf` and `#include "phase3-dialplan.conf"` in `extensions.conf`, or paste contents into `extensions.conf` |
| **phase3-example-inbound-extension.conf** | Example “inbound to extension” with Phase 3 | Optional; use as reference or include if you want that example |

---

## 5. PJSIP vs SIP

The Phase 3 dialplan uses **PJSIP** (e.g. `Dial(PJSIP/1001,...)`). If your agents are registered as **chan_sip** (SIP), change in **phase3-dialplan.conf**:

- Replace **`PJSIP/`** with **`SIP/`** in the `Dial()` line in `[pbx-phase3-ring-one]`.
