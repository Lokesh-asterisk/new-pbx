# How to install and start MySQL (Option B)

Use this when you want real login with the database (Option B).

**Do I need to create the database in MySQL Workbench?**  
No. Run `npm run seed` after MySQL is running and `.env` is set. The seed script creates the database `pbx_callcentre` and all tables automatically.

---

## Windows

### 1. Install MySQL

**Option A – MySQL Installer (recommended)**

1. Download **MySQL Installer** from: https://dev.mysql.com/downloads/installer/
2. Run the installer and choose **Developer Default** or **Server only**.
3. Set a **root password** when asked (remember it for `.env`).
4. Complete the setup. MySQL Server will be installed and can run as a Windows service.

**Option B – Chocolatey**

```powershell
choco install mysql
```

**Option C – Manual**

1. Download the ZIP from https://dev.mysql.com/downloads/mysql/
2. Extract and add the `bin` folder to your PATH.
3. Initialize and start MySQL manually (see MySQL docs).

### 2. Start MySQL

- If you used **MySQL Installer**, MySQL usually runs as a **Windows service** and starts with Windows.
- To check or start it:
  1. Press `Win + R`, type `services.msc`, press Enter.
  2. Find **MySQL** or **MySQL80** (version may vary).
  3. Right‑click → **Start** (or **Restart**).
- Or in **Command Prompt as Administrator**:
  ```cmd
  net start MySQL80
  ```
  (Use the exact service name from `services.msc` if different.)

### 3. Create `.env` and run seed

**You do not need to create the database in MySQL Workbench.** When you run `npm run seed`, the script:

1. Creates the database `pbx_callcentre` if it does not exist.
2. Creates all tables (users, permission_groups, agent_status, queues, etc.).
3. Inserts the demo users (superadmin, admin, user, agent with password `demo123`).

So: install MySQL, start the MySQL service, set `.env`, then run `npm run seed`. No manual database creation is required.

In your project folder:

```cmd
copy .env.example .env
```

Edit `.env` and set:

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_root_password_here
DB_NAME=pbx_callcentre
```

Then:

```cmd
npm run seed
```

If you see “Schema applied.” and “Seeded users: superadmin, admin, user, agent”, the database is ready. With the updated seed, both agent and agent2 share tenant 2 and can select extensions 1001 or 1002 (one per agent).

### 4. Create new users (admin / agent) to test

From the project folder, run:

```cmd
npm run add-user -- myadmin mypass123 admin
npm run add-user -- agent1 agentpass123 agent 2
npm run add-user -- agent2 agentpass123 agent 2
```

The optional fourth argument `2` is **parent_id** (tenant). Agents must have this set to the same tenant as your SIP extensions (e.g. `2`), or the extension selection dropdown will be empty.

**If an agent already exists and sees no extensions**, set their tenant in MySQL:

```sql
UPDATE users SET parent_id = 2 WHERE username = 'agent2' AND role = 5;
```

Then log in on the app with:
- **Admin:** username `myadmin`, password `mypass123`
- **Agent:** username `agent1`, password `agentpass123`

(Replace usernames and passwords with your own. Role must be one of: `superadmin`, `admin`, `user`, `agent`.)

### 5. Connect with MySQL Workbench to pbx_callcentre

When creating a connection in MySQL Workbench, use:

| Field | Value |
|-------|--------|
| **Connection Name** | e.g. `PBX Local` (any name) |
| **Hostname** | `localhost` (or `127.0.0.1`) |
| **Port** | `3306` |
| **Username** | `root` (or the user in your `.env`) |
| **Password** | Your MySQL root password (same as `DB_PASSWORD` in `.env`) |
| **Default Schema** | `pbx_callcentre` (optional; you can select it after connecting) |

After connecting, if you did not set Default Schema, double‑click `pbx_callcentre` in the left panel to use that database.

---

## macOS

### 1. Install MySQL

**Homebrew:**

```bash
brew install mysql
```

### 2. Start MySQL

```bash
brew services start mysql
```

Or run once:

```bash
mysql.server start
```

### 3. Set root password (if first time)

```bash
mysql_secure_installation
```

### 4. Create `.env` and run seed

```bash
cp .env.example .env
```

Edit `.env` and set `DB_PASSWORD` (and `DB_USER` if not `root`). Then:

```bash
npm run seed
```

---

## Linux (Ubuntu / Debian)

### 1. Install MySQL

```bash
sudo apt update
sudo apt install mysql-server
```

### 2. Start MySQL

```bash
sudo systemctl start mysql
sudo systemctl enable mysql
```

### 3. Secure and set root password (if first time)

```bash
sudo mysql_secure_installation
```

### 4. Create `.env` and run seed

```bash
cp .env.example .env
```

Edit `.env` and set `DB_PASSWORD`. Then:

```bash
npm run seed
```

---

## Check that MySQL is running

**Windows (Command Prompt):**

```cmd
mysql -u root -p
```

Enter your password. If you get a `mysql>` prompt, MySQL is running.

**macOS / Linux:**

```bash
mysql -u root -p
```

Same as above.

**Or** run the app seed:

```bash
npm run seed
```

If it prints “Schema applied.” and the seeded users message, MySQL is running and the app can connect.

---

## Troubleshooting

| Problem | What to do |
|--------|------------|
| `ECONNREFUSED` | MySQL is not running. Start the MySQL service (see “Start MySQL” above). |
| `ER_ACCESS_DENIED_ERROR` | Wrong user or password. Check `DB_USER` and `DB_PASSWORD` in `.env`. |
| `mysql` not found | Add MySQL `bin` to your PATH, or use the full path to `mysql`. |
| Port 3306 in use | Change `DB_PORT` in `.env` to match your MySQL port, or stop the other service using 3306. |
