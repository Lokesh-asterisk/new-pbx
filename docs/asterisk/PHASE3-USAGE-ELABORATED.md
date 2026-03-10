# Point 3 – Using Phase 3 when ringing an agent (elaborated)

This note explains **where** in your dialplan “ringing an agent” happens and **how** to use Phase 3 there so the Node app gets IncomingCall, CallAnswered, and CallHangup and the agent dashboard updates in real time.

---

## What “ringing an agent” means

“Ringing an agent” = the moment you **dial the agent’s phone/extension** (e.g. 1001) so the **customer** (inbound caller) is waiting for the agent to answer.

In your current dialplan that happens in two main ways:

1. **Inbound → single extension**  
   Call goes to one specific extension (e.g. DID → extension 1001).  
   In **us4group.conf** this is **`exten => SipExtension`** (when `Destination_Action = 9` in WhereToGO).

2. **Inbound → queue**  
   Call enters a queue and Asterisk’s **Queue()** app rings multiple members (e.g. 1001, 1002).  
   In **us4group.conf** this is **`exten => Queue`** with `Queue(${QueueName}, ...)`.

Phase 3’s **`pbx-phase3-ring-one`** subroutine is for **one agent at a time**. You call it wherever you would otherwise do a single **`Dial(…/agent_extension,…)`** for that inbound customer.

---

## Scenario A – Inbound to single extension (SipExtension)

Here the call is sent to **one** extension (e.g. 1001). That is “ringing one agent”.

### Where it is today

In **us4group.conf** (or wherever you have the same logic), something like:

```ini
exten => SipExtension,1,Set(ExtensionInformation=${SHELL(curl "${US4GROUP_GetExtensionDetail}ExtensionID=${Destination_Value}&UserID=${UserID}")})
 same => n,Set(LastLocation=SipExtension)
 same => n,...
 same => n,Set(AgentNumber=${ExtensionNumber})
 same => n,Set(AgentCallStartTime=${EPOCH})
 same => n,MixMonitor(${RecPath}${RecName}.wav,b)
 same => n,Dial(SIP/${ExtensionNumber},${ExtensionTimeout},tTU(InAnswerTime^${CDRID}))
 same => n,Hangup()
 same => n(hang),HangUp()
```

The line that actually “rings the agent” is:

```ini
same => n,Dial(SIP/${ExtensionNumber},${ExtensionTimeout},tTU(InAnswerTime^${CDRID}))
```

So **“using Phase 3 when ringing an agent”** here means: **instead of that `Dial(...)` (and the hangup that follows), call Phase 3 so it can send IncomingCall/CallAnswered/CallHangup to the Node app and still ring the same extension.**

### What to change (paste this)

**Option 1 – Replace only the Dial with Phase 3 (keep your API/MixMonitor if you want)**

- **File:** `us4group.conf` (or the file that contains `SipExtension`).
- **Find:** the `Dial(SIP/${ExtensionNumber},...)` line and the `Hangup()` right after it.
- **Replace** that Dial + Hangup with a **Gosub** to Phase 3, then Hangup.

Example:

**Before:**

```ini
 same => n,Set(AgentNumber=${ExtensionNumber})
 same => n,Set(AgentCallStartTime=${EPOCH})
 same => n,MixMonitor(${RecPath}${RecName}.wav,b)
 same => n,Dial(SIP/${ExtensionNumber},${ExtensionTimeout},tTU(InAnswerTime^${CDRID}))
 same => n,Hangup()
```

**After (using Phase 3):**

```ini
 same => n,Set(AgentNumber=${ExtensionNumber})
 same => n,Set(AgentCallStartTime=${EPOCH})
 same => n,MixMonitor(${RecPath}${RecName}.wav,b)
 same => n,Gosub(pbx-phase3-ring-one,s,1(${ExtensionNumber},Inbound))
 same => n,Hangup()
 same => n(hang),HangUp()
```

- **First argument** `ExtensionNumber` = agent extension (e.g. 1001). Phase 3 will ring that (e.g. `PJSIP/1001` or `SIP/1001`).
- **Second argument** `Inbound` = queue/label name for the UI (e.g. “Inbound”). You can use `${QueueName}` or a fixed string like `Support` if you prefer.

So in **point 3**, “paste” means: in the **SipExtension** block, **replace the single `Dial(SIP/...)` + `Hangup()`** with **`Gosub(pbx-phase3-ring-one,s,1(${ExtensionNumber},Inbound))`** then **`Hangup()`**, as above.

### If you use PJSIP

Phase 3 dialplan uses **PJSIP** by default. If your agents are registered as **SIP** (chan_sip), either:

- Change in **phase3-dialplan.conf** the `Dial(PJSIP/${ARG1},30,...)` line to `Dial(SIP/${ARG1},30,...)`, or  
- Keep PJSIP and ensure 1001/1002 are in **pjsip.conf** (or equivalent).

---

## Scenario B – Inbound to queue (Queue())

Here the call is put in a **queue** and **Queue()** rings multiple members. The “ringing” is done inside the Queue() app, so you don’t have a single “Dial(agent)” line to replace.

### Why Phase 3 “ring one” doesn’t fit Queue() directly

- **Phase 3** expects: **one** customer channel, **one** agent extension; you call **Gosub(pbx-phase3-ring-one,s,1(agent_id,queue_name))** and it does Dial + callbacks.
- **Queue()** does: “ring many members, answer when one answers” and only gives you a macro/URL when the call is **answered** (e.g. SendResponse), not “when we start ringing agent 1001”.

So you **cannot** “paste” Phase 3 **inside** Queue() without changing the flow.

### Two ways to use Phase 3 with a “queue”

**Option B1 – Keep Queue() for routing; add Phase 3 only when one agent is chosen**

- Keep your current **Queue()** and **SendResponse** as they are (SendResponse runs when an agent answers).
- In **SendResponse** you already notify the old app (AgentOnCall). You can **also** call the Node app’s **CallAnswered** (and optionally **IncomingCall** for the ring state) from that same macro if you pass the right data (agent id, uniqueid, etc.). That would require adding a small curl in SendResponse to your Node **CallAnswered** (and optionally **IncomingCall**) endpoint with the same parameters as in Phase 3.
- So “using Phase 3 when ringing an agent” in a queue setup can mean: **when the agent answers**, call **CallAnswered** (and, if you want ring state, **IncomingCall** when the member is tried). The **ring-one** subroutine is not used here; only the **HTTP callbacks** (and your Node app) are used.

**Option B2 – Replace Queue() with “try agents in order” using Phase 3**

- Remove the **Queue()** call for that queue.
- Implement “try agent 1001, then 1002, then …” yourself with a loop, and each time you try an agent you call **Gosub(pbx-phase3-ring-one,s,1(agent_id,queue_name))**.
- Then “using Phase 3 when ringing an agent” means: **each** time you ring the next agent, you paste that **Gosub** in the loop (see below).

Example of a **simple** “try two agents in order” using Phase 3 (you can extend with more agents or get the list from an API):

```ini
; Replace "Queue" for this queue with a custom “try agents” loop
exten => Queue,1,NoOp(Phase3 try agents in order)
 same => n,Set(LastLocation=Queue)
 same => n,Set(PHASE3_QUEUE_NAME=${QueueName})
 ; Try agent 1001 first
 same => n,Gosub(pbx-phase3-ring-one,s,1(1001,${PHASE3_QUEUE_NAME}))
 same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?Queue,HangME)
 ; Try agent 1002 next
 same => n,Gosub(pbx-phase3-ring-one,s,1(1002,${PHASE3_QUEUE_NAME}))
 same => n,GotoIf($["${DIALSTATUS}" = "ANSWER"]?Queue,HangME)
 ; No one answered
 same => n(Queue,HangME),Hangup()
```

Here, **each** **Gosub(pbx-phase3-ring-one,s,1(1001,...))** and **Gosub(pbx-phase3-ring-one,s,1(1002,...))** is “using Phase 3 when ringing an agent” for that agent.

---

## Summary table – where to paste / what to do

| Your flow | Where “ring agent” happens | What to do for Point 3 |
|-----------|-----------------------------|--------------------------|
| **Inbound → single extension** (SipExtension, Destination_Action=9) | `Dial(SIP/${ExtensionNumber},...)` in **SipExtension** | Replace that Dial (+ Hangup after) with **Gosub(pbx-phase3-ring-one,s,1(${ExtensionNumber},Inbound))** then Hangup. |
| **Inbound → queue** (Queue()) | Inside Queue() app | Either: (B1) Only add CallAnswered/IncomingCall from SendResponse; or (B2) Replace Queue() with a loop and call **Gosub(pbx-phase3-ring-one,s,1(agent_id,queue_name))** for each agent you try. |
| **Any other “ring one extension”** | Any `Dial(SIP/1001,...)` or `Dial(PJSIP/1001,...)` | Replace that Dial (and following Hangup if any) with **Gosub(pbx-phase3-ring-one,s,1(1001,YourQueueName))** then Hangup. |

---

## Gosub parameters explained

```ini
Gosub(pbx-phase3-ring-one,s,1(agent_id,queue_name))
```

- **pbx-phase3-ring-one** – context in **phase3-dialplan.conf** that does Dial + IncomingCall/CallAnswered/CallHangup.
- **s** – extension (start).
- **1** – priority.
- **agent_id** – extension number to ring (e.g. `1001` or `${ExtensionNumber}`). Must match your PJSIP/SIP endpoint.
- **queue_name** – label for the UI (e.g. `Inbound`, `Support`, `${QueueName}`). Shown as “queue” in the agent dashboard.

Usually the channel will **hang up inside** Phase 3 (agent or customer hung up), so the next line after `Gosub(...)` in your context may not run. If the Gosub ever returns (e.g. in edge cases), **DIALSTATUS** is set (e.g. `ANSWER`, `NOANSWER`, `BUSY`), so you can branch on it if needed.

So when you “use Phase 3 when ringing an agent”, you are literally **adding or replacing** the place that rings that agent with this **Gosub** and the two arguments above.
