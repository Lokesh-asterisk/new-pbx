<<<<<<< HEAD
# PBX Call Centre — Role-based login

A clean, professional web app for a PBX call centre with role-based authentication and role-specific dashboards.

## Roles

| Role        | Route        | Description                    |
|------------|--------------|--------------------------------|
| Super Admin| `/superadmin`| Full system overview & control |
| Admin      | `/admin`     | Team & queue management        |
| User       | `/user`      | View & reports                 |
| Agent      | `/agent`     | Take calls, make outbound calls|

## Demo login

- **Password:** `demo123`
- **Username:** type one of `agent`, `admin`, `user`, `superadmin` (or leave blank and choose the same from the Role dropdown).
- Choose **Role**, enter **Password** `demo123`, then **Sign in**. You are redirected to that role’s page.

## Run locally (frontend only, demo auth)

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (e.g. http://localhost:5173).

**If "not running" or you see `Error: spawn EPERM`:**
- Run the command in a **normal terminal** (outside Cursor), or run the terminal as Administrator.
- On Windows, antivirus can block Node/Vite; allow the project folder or try temporarily disabling.
- Then run: `npm run dev`

## Database and API (real auth)

1. **MySQL:** Install MySQL and create a user that can create databases (or use root). Copy `.env.example` to `.env` and set `DB_HOST`, `DB_USER`, `DB_PASSWORD` (and optionally `DB_NAME`, default `pbx_callcentre`).

2. **Create DB and seed users:**
   ```bash
   npm install
   npm run seed
   ```
   This creates the `pbx_callcentre` database, runs [docs/database-schema.sql](docs/database-schema.sql), and inserts users: **superadmin**, **admin**, **user**, **agent** (password: **demo123**).

3. **Start the API server:**
   ```bash
   npm run server
   ```
   API runs at http://localhost:3001 (or `PORT` in `.env`).

4. **Start the frontend** (in another terminal):
   ```bash
   npm run dev
   ```
   Vite proxies `/api` to the backend, so login uses the real API. If the API is not running, login falls back to demo auth (same passwords).

5. **Create new users to test (optional):**  
   `npm run add-user -- <username> <password> <role>`  
   Example: `npm run add-user -- myadmin mypass123 admin` and `npm run add-user -- agent1 agentpass123 agent`. Then log in with those credentials to confirm database auth works.

**If the dev server does not start** (e.g. `spawn EPERM`), run `npm run dev` in a normal system terminal (not inside a restricted sandbox) or as Administrator.

**Option B – Install and start MySQL:** See [docs/MYSQL-SETUP.md](docs/MYSQL-SETUP.md) for step-by-step install and start on Windows, macOS, and Linux.

## Features

- **Login:** Role selection, username (optional), password. Redirects to the correct dashboard by role.
- **Protected routes:** Unauthenticated users go to `/login`. Authenticated users without access to a role are redirected to their own role’s page.
- **Agent dashboard:** Status (Available, On call, Break, Away), dial pad, outbound call, “Simulate incoming call”, contacts list, recent calls.
- **Super Admin / Admin / User:** Dashboards with stats and quick actions (UI placeholders for PBX integration).

## Tech

- React 19 + Vite 7, react-router-dom 7
- Backend: Node, Express, MySQL2, bcrypt, express-session
- Auth: session cookie; login/me/change-password APIs; demo fallback when API is down

To plug in a real PBX, replace the demo auth in `src/context/AuthContext.jsx` with your API and wire the Agent dial/call actions to your telephony backend.

## Database (new schema)

When implementing the full PBX feature set (see plan in `.cursor/plans/` or repo docs):

- Use a **new database** (e.g. `pbx_callcentre`), not the old MySQL schema.
- New schema is defined in [docs/database-schema.sql](docs/database-schema.sql) (users, permissions, agent status, queues, extensions, trunks, CDR, reports, etc.).
- **Asterisk integration concept** (agent login/logout, originate, transfer, queue membership, AMI/HTTP) stays **identical**; only the app’s data lives in the new DB.
=======
# PBX
New-PNX
>>>>>>> a7cb5cf5a05ca5eaadda73a77057cb887dba8e7c
