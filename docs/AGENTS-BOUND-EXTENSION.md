# Bound extension (Option 2): one extension per agent

Agents are fixed to a single extension. When you create an agent in Super Admin and set their "extension" (phone login number), that extension is bound to them via `sip_extensions.agent_user_id`. The agent can only log in with that extension.

## Existing agents – no need to remove or recreate

- **Already-created agents** (e.g. Reeta with ext 6002) are already bound: Super Admin set `users.phone_login_number = 6002` and `sip_extensions.agent_user_id = <Reeta's user id>` for extension 6002.
- You do **not** need to delete and recreate them. They will work as soon as they use **their** extension (6002 for Reeta).
- If an agent had previously logged in with a different extension (e.g. 6001), they will now see only their assigned extension (6002) in the agent dashboard. They must use that extension to receive calls.

## Behaviour

1. **Ring resolution**: When a call is offered to extension 6002, the app resolves the user via `sip_extensions.agent_user_id` for that tenant + extension, so the correct agent gets the ring on their dashboard.
2. **Agent dashboard**: GET `/api/agent/extensions` returns only the extension where `agent_user_id = current user`. The agent cannot pick another extension.
3. **Select / call extension**: Only the bound extension can be selected or used for SIP login.

## If an agent has no bound extension

If `sip_extensions.agent_user_id` was never set for that agent (e.g. created before binding existed), the agent will see **no extensions** and cannot log in. Fix: in Super Admin, edit the agent and set their phone number/extension again (Edit phone / PIN); that will call `setExtensionAgentUserId` and bind the extension to them.
