# Nexus — Practical Guide

Step-by-step recipes for running your own server with Nexus, using your real setup.
(For the explain-everything version, see [HOW-TO-USE-NEXUS.md](HOW-TO-USE-NEXUS.md).)

**Your setup at a glance**

| Thing | Value |
|---|---|
| This computer's local address | `192.168.0.9` (router: `192.168.0.1`) |
| Public internet address | `65.33.27.76` |
| Domain | `mohamedgad.com` (the main domain and `www` currently point to another host, `216.24.57.x`) |
| Router forwards | TCP 80 and 443 → `192.168.0.9` |
| Control center | Nexus app from the Start menu (or `http://127.0.0.1:7780`) |
| Nexus username | `owner` |
| Test app | `C:\Users\moham\Desktop\nexus-test-app` |
| Your app | `projectOne` from `D:\projectOne` |

---

## Recipe 0 — Get to a clean, current install (do this first)

1. Run **`dist\NexusSetup.exe`** (the newest one) → **Yes** → **Install**. Your data is kept.
2. Open **Nexus** from the Start menu. You're signed in automatically.
3. Check **Dashboard → System Health** is green.

Why this matters: older builds had no built-in Python, links didn't open, and saves didn't confirm. The newest build fixes all three.

---

## Recipe 1 — Lock the doors (5 minutes, once)

1. **Settings → Sign-in & Security → Set Password**. Use a long passphrase and save it in a password manager.
2. **Two-step verification → Set Up**:
   - Install **Aegis** (Android) or **FreeOTP** (iPhone/Android). Both are free and open source.
   - Scan the code, type the 6-digit number.
   - Write down the **recovery codes** and keep them somewhere other than this computer.
3. Find your **Server Recovery Key** (shown at first setup) and make sure it's written down. Without it, backups can't be restored on another computer.

✅ Done when: the Password row says **Set** and Two-step verification says **Enabled**.

---

## Recipe 2 — Prove the server works with the test app (10 minutes)

1. **Applications → Add Application**.
2. Browse to `C:\Users\moham\Desktop\nexus-test-app` → **Choose** → **Analyze Folder**.
3. Nexus should find: **Python + Flask backend**, **PostgreSQL database**, **File storage**.
4. **Continue** → **Create a new database** → **Private to this computer** → **Continue**.
5. Wait for **"deployed and tested successfully"** → **Open Application**.

✅ Done when the page shows four green lines: **Web server**, **Database: Connected**, **File storage**, **Secret key: Provided**.

**Node.js version:** do the same with `C:UsersmohamDesktop
exus-test-node` (Node.js + Express). It shows the same four green lines and keeps its own guestbook.

Try it: sign the guestbook, upload a file, refresh (the visit counter goes up). Then **Databases →** the test app's database → table **guestbook**: your message is there.

---

## Recipe 3 — Deploy projectOne

1. **Applications → projectOne → Deployments → Deploy Latest**.
2. Watch the steps. If one fails:
   - **"Python is needed"**: you're on an old build; do Recipe 0. If you are on the new build, the app wants a Python version other than 3.12. Install that version from python.org with **Customize installation → Install Python for all users**, then deploy again.
   - **"Installing components" failed**: open **Logs** → **Explain these errors**. Usually a package in `requirements.txt` needs a different version.
   - **The app starts then stops**: **Logs** → look at the last red lines → **Explain these errors**.
3. Your folder has a `Procfile` and several `.pkl` / `.csv` files. Nexus copies the whole folder, so the models and data files come along.
4. **Your `.env` file is not copied** (it holds passwords). projectOne needs `MONGO_URL`, `MONGO_URL_MOVIES` and `MONGO_URL_TESLA` from it:
   **projectOne → Settings →** the **"Settings from your app's .env file"** card → **Import 3 settings** → **Restart now**.
   Until you do this, projectOne uses a new, empty Nexus document database and crashes with `KeyError: "['_id'] not found in axis"`.
5. `requirements.txt` is installed automatically. To get rid of the "Importing plotly failed" warning, add a `plotly` line to it and **Deploy Latest**.

Where is it? The box at the top of the app page lists **every address**: on the internet, on this computer, on your private network, and the app's own port. Each has a copy button.

Remove an app: **Overview → Controls → Remove** (or **Settings → Remove Application**), then type the app's name to confirm. Its database and backups are kept.
Delete its database too: **Databases →** the database → bottom of the page → **Delete database** → type its name. (It's refused while an app still uses it.)

✅ Done when projectOne shows **Running** and **Open Application** shows your site.

> Updating later: change files in `D:\projectOne`, then **Dashboard → Refresh**. The **Updates ready** card offers **Deploy update** (or **Apply all**). If the new version is broken: **Deployments → pick the previous release → Roll Back**.

---

## Recipe 3½ — How your app gets connected to its database

You never type a database password into your app. Nexus hands it over when the app starts. Here's exactly what happens.

### 1. Nexus reads your code to see what it needs
When you press **Analyze Folder**, Nexus looks at:
- **Libraries:** `psycopg`, `pg`, `SQLAlchemy`, `Prisma`, `pymongo`, `mongoose`, …
- **Setting names** your code reads: `DATABASE_URL`, `DB_HOST`/`DB_USER`/`DB_PASSWORD`, `MONGO_URL`, `MONGODB_URI`, …

From this it knows the kind of database (**tables** = PostgreSQL, **documents** = MongoDB-style) and **which setting names** your app expects.

### 2. You choose where the data lives (the "Set up application data" step)
| Choice | What Nexus does |
|---|---|
| **Create a new database** (recommended) | Makes a fresh, empty database just for this app. |
| **Use an existing Nexus database** | Gives the app its own login to a database you already have (for example, one you imported data into). |
| **Connect an external database** | You paste a connection address (e.g. MongoDB Atlas, a hosted PostgreSQL). Nexus stores it **encrypted** and passes it to the app. |

### 3. Nexus gives the app its own login
For a Nexus database, the app gets:
- its **own username and a random password**, stored encrypted in Nexus's vault (you never see it or need to);
- rights to **its own database only**, not other apps' databases and not the server itself;
- a connection to PostgreSQL at `127.0.0.1` on a private port. The database is **never reachable from the internet**, only by apps on this computer.

### 4. Nexus fills in your app's own setting names at start
Every time the app starts, Nexus puts the connection into the **exact setting names your code uses**:

| Your code reads… | Nexus provides |
|---|---|
| `DATABASE_URL` | `postgres://<app login>:<password>@127.0.0.1:<port>/<database>` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` (any similar names) | each piece separately |
| nothing recognisable | the standard ones: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` |
| `MONGO_URL` / `MONGODB_URI` (document apps) | `mongodb://…` to the app's Nexus document database |

Your code keeps doing what it always did, e.g. `os.getenv("DATABASE_URL")` or `process.env.DATABASE_URL`.

If the app has **two** possible database configurations, Nexus asks which one is its main data.

### 5. It checks the connection
During deploy, the step **Connecting the application** checks that the login works, and **Preparing database tables** runs your migrations if the app has them (Prisma, Alembic, Django, Knex…). At the end, **Testing everything** shows **Database: Connected**.

### Where you can see and change it
- **The app → Overview → Database:** which database it uses (click to open it).
- **Databases → the database:** the tables and rows (and how many connections are open right now).
- **The app → Settings → Application Settings:** your own values. **A setting you add here wins over Nexus's.** Example: to make projectOne use your existing MongoDB Atlas instead of a new, empty Nexus database, add `MONGO_URL` = your Atlas address (or use **Import from .env**) → **Restart now**.
- **Settings → Advanced › Developer → Application internals →** pick the app → **Database connection:** the host, port, database name, the app's username and (when you choose to reveal it) its password, plus every setting Nexus manages for the app.

### Connect to a database from another server
Want another computer (a second server, your laptop, a reporting tool) to use one of your databases? Share it over the **private network**. It's never opened to the internet.
1. Set up the private network once (Recipe 5).
2. **Databases →** the database → **Connect from another server → Share**.
3. Nexus shows a link like `postgres://…@10.73.0.1:43xxx/shop` (or `mongodb://…` for document databases). Press **Show & copy**.
4. On the other computer, install **WireGuard** and add it as a device: **Settings → External Access → Private network → Add device → Download file for a laptop** → import it there → switch the tunnel on.
5. Use the link as that computer's database address (e.g. its `DATABASE_URL` or `MONGO_URL`).
- The link has **its own login for that one database**. It can't open any other database, and it's separate from your apps' logins.
- **New password** changes it (the old one stops working at once). **Stop sharing** switches the link off.
- Connections from anywhere outside the private network are refused, by Windows Firewall and again by Nexus.

### MongoDB apps: the compatibility layer
Nexus's document databases use **FerretDB**, an open-source MongoDB-compatible engine (real MongoDB isn't open source). FerretDB doesn't support every MongoDB feature, for example `$cond` inside a `$group` aggregation. Nexus handles this for you automatically: your app talks to a **compatibility layer**. Anything FerretDB supports goes straight through. When FerretDB answers "not implemented", Nexus runs that aggregation itself (with `$lookup`, `$facet` and so on), using the app's own login, and returns the result MongoDB would have given. You don't change your code.
- It never emulates write stages (`$out`, `$merge`) and returns FerretDB's original error for those.
- Very large aggregations are slower when emulated, because Nexus has to read the documents first. A `$match` at the start of the pipeline keeps this fast.

### Common questions
- **"My app connected to an empty database!"** Nexus created a new one, but your real data is elsewhere (projectOne's is in MongoDB Atlas). Either put your address in the app's Settings as above, or bring the data into Nexus (**Databases → Import data**, or restore a backup).
- **"Can I open the database with pgAdmin / DBeaver / Compass on this computer?"** Yes. Get the details from **Settings → Advanced › Developer → Application internals →** the app → **Database connection**. It works only from this computer, because the database never listens on the network.
- **"What happens to the database if I remove the app?"** The database and backups are **kept**; only the app's login is cancelled. Delete the database separately if you don't need it (**Databases → the database → Delete database**).
- **"Is my password in my code or files?"** No. Nexus stores it encrypted and only gives it to the running app. Keep passwords out of your code too (projectOne's `app.py` has two MongoDB passwords written in it: move them to settings).

---

## Recipe 4 — Put projectOne on the internet at `projectone.mohamedgad.com`

Use a sub-address, not `mohamedgad.com` itself. The main domain already points to your other host and would stop working.

**At your domain registrar (once):**
1. Open the DNS settings for `mohamedgad.com`.
2. Add a record: **Type** `A`, **Name/Host** `*`, **Value** `65.33.27.76`, TTL automatic.
   - This one "wildcard" record covers `projectone.mohamedgad.com`, `anything.mohamedgad.com`, and so on.
   - Leave the existing records for `@` and `www` alone.
   - If `*` isn't allowed, add Name `projectone` instead (one record per app).

**On your router (once):**
3. You already forward TCP **80** and **443** to `192.168.0.9`.
4. Add an **Address Reservation** (DHCP reservation) for this computer at `192.168.0.9`, so its address never changes.

**In Nexus:**
5. **Settings → External Access → Domains → Base domain** = `mohamedgad.com` → **Save** (already done).
6. **projectOne → Settings → External Access**: **Who can access** = **Public website**, **Domain name** = `projectone.mohamedgad.com` → **Save**.
7. Wait 5–15 minutes, then look at **Settings → External Access → Domains**:
   - **DNS connected** → the record works.
   - **HTTPS active** → the certificate is issued (free, automatic).

✅ Done when `https://projectone.mohamedgad.com` opens on your phone **with Wi-Fi off** (mobile data), since that's the true outside test.

Troubleshooting:

| You see | Do this |
|---|---|
| **DNS pending** for a long time | Check the A record at the registrar. It can take up to an hour. |
| **DNS needs a change** | The name points somewhere else. The message shows the exact fix. |
| **HTTPS pending** | Ports 80/443 aren't reaching this computer. Re-check the router forwards to `192.168.0.9`. |
| "Internet access is blocked by another program" | Something else holds port 80/443. If it names a copy of Nexus, press **Stop Nexus.cmd** in the portable copy. Then press **Try Again**. |
| Works at home, not on mobile data | Test from outside only. Many routers can't open their own public address from inside. |

---

## Recipe 5 — Reach Nexus from your phone anywhere, privately (WireGuard)

For managing Nexus and using private apps while away, without putting them on the internet.

1. On this computer, install **WireGuard for Windows** from `wireguard.com/install` (free, no account).
2. **Settings → External Access → Private network (WireGuard) → Set up**.
3. On the router, add a forward: **UDP 51820** → `192.168.0.9`. (Nexus tries this automatically; do it yourself if the card says **One router setting needed**.)
4. **Add device** → "My phone" → **Add** → a QR code appears (shown only once).
5. On the phone, install **WireGuard** → **+** → **Scan from QR code** → switch the tunnel on.
6. On the phone, open the **control center** address shown on the card (like `http://10.73.0.1:8431`) and sign in: `owner`, your password, and the 6-digit code.

✅ Done when the device on the card says **Connected now**.

- Lost the phone? **Remove** the device on the card. It can't connect any more.
- Laptop: **Download file for a laptop** and import it in the WireGuard app.

---

## Recipe 6 — Keep everything backed up

1. **Backups**: every app should say **Protected**.
2. Set the schedule: **Automatic backups** → **Daily**, a quiet **Time** (e.g. 3:00 AM), **Keep restore points** = 14.
3. Best practice: keep backups on a **different drive** from the apps (Nexus chose one at setup; check it isn't `C:`).
4. Before a risky change: app → **Backups → Manual backup**.
5. Test a restore once. Deploy the test app, add a guestbook message, make a backup, add another message, then **Restore** the backup. The second message should be gone.

---

## Recipe 7 — Bring data in and ask questions about it

**Import a spreadsheet:**
1. **Databases** → open (or **Create Database**) → **Import data** → choose the `.csv` / `.xlsx` / `.json`.
   Example: `D:\projectOne\bayut_combined_all.csv`.
2. Check the suggested **table name**, **column types** and **primary key** (or **Add an automatic ID**) → **Import**.

**Ask about it** (needs Nexus AI, Recipe 9):
3. On the database page → **Ask about this data** → *"What's the average price per area?"*. You get a chart and a table.
4. Prefer SQL? Switch to **SQL** and type a `SELECT`. It's read-only, so it's safe.

---

## Recipe 8 — Automate a data job with a pipeline

Example: refresh a cleaned copy of a CSV into a database every night.

1. **Pipelines → Create Pipeline**.
2. **Describe it**: *"Every night at 2 AM, read D:\projectOne\encoded_data.csv, remove duplicate rows, and load it into the Warehouse table clean_data."* → **Propose pipeline**.
   (No AI yet? Use the **Import data** starting point instead.)
3. Read the plan → **Create Pipeline**. It starts **switched off**.
4. Press **Run** → choose a small test → check each step is ✅ and **Preview** the data.
5. Flip **Switched on**. It now runs every night.
6. If a run fails: open it → **Explain what went wrong** → fix → **Resume from where it stopped**.

---

## Recipe 9 — Turn on Nexus AI

1. Install **Ollama** from `ollama.com` (you have it) and keep it **open** (it sits in the system tray).
2. **Nexus AI**: it connects to your Ollama automatically and downloads the model it picked for your graphics card (`qwen3:14b`, about 9 GB).
3. Wait for **Ready**, then ask: *"Is everything healthy?"* or *"Why did projectOne stop?"*

If it says **Engine not installed**, open Ollama and wait a few seconds.

---

## Recipe 10 — Add another person

1. **Settings → People → Add Person** → name, username, password.
2. Pick a role: **Operator** (restart apps, run backups), **Developer** (deploy apps), **Administrator** (almost everything).
3. For remote sign-in, they must set up two-step verification first.

---

## Recipe 11 — Use the portable copy

1. Unzip **`dist\NexusPortable.zip`** (e.g. to a USB drive).
2. **Start Nexus.cmd** → it opens in the browser at `http://127.0.0.1:7781`.
3. **Stop Nexus.cmd** when done. It stops apps and databases cleanly.

It runs next to the installed Nexus without conflict. For the internet, the private network and running 24/7, use the installed version.

---

## Daily / weekly checklist

- **Daily (10 seconds):** open Nexus → **Dashboard** is green → the 🔔 bell has no red number.
- **Weekly:** **Backups**: all **Protected** · **Settings → External Access**: domains show **HTTPS active** · Windows Update done (Nexus restarts by itself afterwards).
- **After changing an app's files:** **Dashboard → Refresh → Apply all** → check **Running** → open it.
- **After changing an app setting:** press **Restart now** in the green message.

---

## When something breaks

| Problem | Fix |
|---|---|
| "Nexus isn't running yet" | Wait a minute → **Try Again**. Still stuck: Start → type **Services** → **Nexus Server Core** → **Start**. |
| App **Stopped** / **Failed** | App → **Logs** → **Explain these errors**. |
| Pipeline **Failed** | Run → **Explain what went wrong** → **Resume**. |
| Settings don't seem to save | Look for the green **Saved** message; you're on an old build if there isn't one (Recipe 0). |
| A link opens nothing | Old build: do Recipe 0. New build: links open in your normal browser. |
| Need the logs for support | Start → right-click → **Terminal (Admin)** → run the command in HOW-TO-USE-NEXUS.md, part 21. |

---

## Safety rules

1. Keep the **Server Recovery Key** and two-step **recovery codes** off this computer.
2. Only make an app **Public website** if strangers should see it. Otherwise use **Private** plus the WireGuard network.
3. Leave **Remote administration** off. Use WireGuard to manage Nexus from outside.
4. Make a **Manual backup** before big changes.
5. Test pipelines before switching them on.
