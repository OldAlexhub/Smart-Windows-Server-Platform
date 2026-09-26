# How to Use Nexus Server — The Super Simple Guide

Hi! This guide explains **every part of Nexus**, step by step, like you're 10 years old. No computer-wizard words needed.

**Contents**

1. [What is Nexus?](#what-is-nexus)
2. [Installing Nexus](#1-installing-nexus-you-only-do-this-once) (or the portable copy)
3. [The first time you open it](#2-the-first-time-you-open-it)
4. [How to sign in](#3-how-to-sign-in)
5. [Finding your way around](#4-finding-your-way-around)
6. [The Dashboard](#5-the-dashboard)
7. [Try it! Put the test app on your server](#6-try-it-put-the-test-app-on-your-server)
8. [Applications](#7-applications)
9. [Databases (tables)](#8-databases-tables)
10. [Document databases](#9-document-databases)
11. [Importing data from a file](#10-importing-data-from-a-file)
12. [Asking questions about your data](#11-asking-questions-about-your-data)
13. [Pipelines (the conveyor belts)](#12-pipelines-the-conveyor-belts)
14. [Backups](#13-backups-your-safety-copies)
15. [Nexus AI (the robot helper)](#14-nexus-ai-the-robot-helper)
16. [Notifications (the bell)](#15-notifications-the-bell)
17. [Settings: People](#16-settings-people)
18. [Settings: Sign-in & Security](#17-settings-sign-in--security)
19. [Settings: External Access](#18-settings-external-access-reaching-nexus-from-outside)
20. [Settings: Plugins](#19-settings-plugins)
21. [Settings: Advanced › Developer](#20-settings-advanced--developer)
22. [When something goes wrong](#21-when-something-goes-wrong)
23. [Installing Nexus on another computer](#22-installing-nexus-on-another-computer)
24. [The 5 Golden Rules](#the-5-golden-rules-)

---

## What is Nexus?

Imagine your computer is a **big house**. Nexus is the **friendly house manager** who lives inside it.

- It keeps your **apps** (programs you or your friends made) running, like keeping the lights on.
- It keeps your **data** (lists, tables, numbers) safe in special boxes called **databases**.
- It makes **copies of everything** (called **backups**), so nothing gets lost.
- It has **conveyor belts** (called **pipelines**) that move data from one place to another all by themselves.
- It has a **robot helper** (Nexus AI) that answers questions and explains problems in plain words.
- It has a **secret tunnel** (the private network) so your own phone can reach it from anywhere.

Nexus works quietly in the background, even when its window is closed, just like a fridge keeps working when the door is shut.

---

## 1. Installing Nexus (you only do this once)

1. Find the file called **NexusSetup.exe**.
2. **Double-click** it.
3. Windows asks *"Do you want to allow this app to make changes?"* → click **Yes**.
4. Click **Next**, then **Install**, and wait for the bar to fill up.
5. Click **Finish**. The Nexus window opens by itself.

To **update** Nexus later, just run the newer **NexusSetup.exe** the same way. Your apps, data and backups are kept.

### Or: the portable copy (no installing)

**NexusPortable.zip** runs Nexus straight from a folder, even from a USB drive.
1. Unzip **NexusPortable.zip** anywhere you like.
2. Double-click **Start Nexus.cmd**. Nexus opens in your web browser (at `http://127.0.0.1:7781`).
3. When you're done, double-click **Stop Nexus.cmd**. Nexus closes your apps and databases properly.
- Everything you make is kept in the **data** folder inside it. To move it, stop Nexus and copy the whole folder.
- It only runs while you're signed in to Windows and until you press Stop. The installed version keeps running all the time.
- Publishing to the internet, the firewall and the private network need the installed version.

---

## 2. The first time you open it

Nexus looks at your computer and picks the best settings for you.

1. You'll see **Recommended Configuration**. Nexus already chose where to keep apps, databases, files and backups.
   - If you have a second drive (like **D:**), Nexus puts backups there, so a broken main drive doesn't take the backups with it.
2. You **don't need to change anything**. Press the big button to continue.
3. Nexus shows your **Server Recovery Key**. This is the **spare key to your house**.
   - **Write it down on paper** and keep it somewhere safe.
   - Without it, backups can't be opened on a new computer.
4. When you see **"Your server is ready."**, you did it! 🎉

---

## 3. How to sign in

- **On the Nexus computer:** open **Nexus** from the Start menu. It lets you in automatically, because it knows it's you. No password needed.
- **From a web browser or another device:** Nexus asks for:
  - **Username:** `owner` (the first account; see **Settings → People** for the exact name)
  - **Password:** the one you set in **Settings → Sign-in & Security → Set Password**
  - **Two-step code:** from another device, you also need the 6-digit code from an authenticator app on your phone (see [part 17](#17-settings-sign-in--security)).

---

## 4. Finding your way around

The **left menu** has one button for each room:

| Button | What's in this room |
|---|---|
| **Dashboard** | The front door. Is everything healthy? |
| **Applications** | Your apps. Add, start, stop, update, back up. |
| **Databases** | Your data boxes. Look inside like a spreadsheet, import files, ask questions. |
| **Pipelines** | Conveyor belts that move and clean data automatically. |
| **Backups** | Safety copies. Make one or bring an old one back. |
| **Nexus AI** | Your robot helper. |
| **Settings** | People, passwords, internet access, plugins, developer tools. |

Also:
- The **bell 🔔** at the top: messages from Nexus. A red number means something new.
- **Automatic theme** at the bottom: switch between light and dark colours.

---

## 5. The Dashboard

Open **Dashboard** to see, at a glance:
- **System Health**: green means everything is running normally.
- **This Computer**: how busy the **Processor**, **Memory**, **Storage** and **Graphics** are.
- **Applications**: your apps and whether they're running.
- **Services**: the database, the secure gateway, the AI.
- **Backups**: whether all your apps are protected.
- **Recent Activity**: what happened lately.

If something needs attention, the Dashboard says so in plain words. Press **Refresh** (top right) to reload everything and check your apps for changes you made. If there are any, **Updates ready** lets you apply them.

---

## 6. Try it! Put the test app on your server

There's a ready-made test app in **`C:\Users\moham\Desktop\nexus-test-app`** (a small Python website). It checks that Nexus can run an app, give it a database, store its files, and keep it healthy.

1. Click **Applications** → **Add Your First Application** (or **Add Application**).
2. **Choose your application folder**: click through to `C:\Users\moham\Desktop\nexus-test-app`, then click **Choose**.
3. Click **Analyze Folder**. Nexus says *"Here's what Nexus found"*:
   - **Python + Flask backend**
   - it **needs a PostgreSQL database**
   - **File storage detected**
4. Click **Continue**. For the data, choose **Create a new database**.
5. **Choose who can access it**: pick **Private to this computer** for now.
6. Click **Continue** and wait. Nexus installs what the app needs (this takes a minute the first time), starts it and tests it.
7. When it says **"Nexus deployed and tested the application successfully."**, click **Open Application**.

On the test app's page you should see:
- ✅ **Web server: Working**
- ✅ **Database: Connected**
- ✅ **File storage: Working**
- ✅ **Secret key from Nexus: Provided**

Now try it:
- Sign the **Guestbook**. The message is saved in the app's database.
- **Upload** a file. It's saved in the app's storage.
- Refresh the page. The visit number goes up.
- Go to **Databases**, open the test app's database, and you'll find the **guestbook** and **visits** tables with your data inside!

---

## 7. Applications

### Add an app
Follow the same steps as the test app in [part 6](#6-try-it-put-the-test-app-on-your-server). Nexus understands Node.js, Python, static websites and more. If the app needs private settings (like an API key), Nexus asks for them and keeps them **encrypted**.

### Choose who can see it
When adding an app, or later in the app's **Settings** tab under **Who can access**:
- **Private to this computer**: only you, on this computer. The safest choice.
- **Public website**: anyone on the internet who knows the address. You need a **domain name** (see [part 18](#18-settings-external-access-reaching-nexus-from-outside)).
- **Authorized users only**: on the internet, but visitors must sign in with a Nexus account first.
- **API access only**: for other programs, which must send an **API key**.

### Look after an app
Click an app's name. You'll find these tabs:
- **Overview**: is it running, memory, processor, address, database, **File Storage**, and **Controls** (start, stop, restart).
- **Logs**: what the app has been saying. Filter by **Errors**, **Warnings** or **All levels**, or type in **Search logs**. Press **Explain these errors** and Nexus tells you, in plain words, what went wrong and what to do.
- **Deployments**: every version you've put on the server. If a new version is broken, pick an older one and press **Roll Back**.
- **Backups**: this app's safety copies. Press **Manual backup** to make one now.
- **Settings**: the app's name, **Who can access**, and its settings (**Configuration**). Private values are stored as **Encrypted secret**.

### Stop, start or restart an app
Open the app → **Overview** → **Controls**: **Stop**, **Start** or **Restart**. Stopping never deletes anything.

### Settings from your app's .env file
Nexus never copies an app's `.env` file (it holds passwords). If your app has one, the app's **Settings** tab shows **"Settings from your app's .env file"**. Press **Import** and then **Restart now**. The values are stored encrypted.

### Change an app's settings
You **don't** need to stop the app first.
- **Who can access / Domain name** (app → **Settings** → **External Access**): press **Save**. It works straight away; no restart needed.
- **Application Settings** (like an API key): type the **Name** and **Value** → **Add Setting**, or **Remove** one. The app reads its settings when it starts, so press **Restart now** in the green message to use the new value.

### Update an app (it never goes offline)
When you update an app, Nexus starts the new version **next to** the old one. Visitors move to the new version only once it answers. If the new version is broken, the old one just keeps running and nobody notices. It's like opening a new checkout lane before closing the old one.

There are four ways to send an update. They all work this way.
1. **Change the files in the app's folder**, then **Dashboard → Refresh → Deploy update** (or **Apply all**). You can also press **Deploy Latest** on the app's page.
2. **Let it happen by itself.** On the app's **Deployments** tab, tick **Update automatically when files in this folder change**. Save your code (or run `git pull` in the folder) and about half a minute later it's live.
3. **Upload a zip.** On the **Deployments** tab, press **Upload New Version (.zip)** and choose a zip of your project folder. Leave out `node_modules` and `.venv`, because Nexus installs those itself. You can zip the folder itself or the folder around it; both work.
4. **Push it from your laptop.** On the **Deployments** tab, press **Create Deploy Key**. Nexus shows the key once, with a ready-made command to copy. Run it in your project folder on your laptop (with WireGuard on) and the new version goes live. **Turn Off** stops the key working.

Every version is kept. If something is wrong, open **Deployments**, pick an older version and press **Roll Back** (also without going offline).

### Remove (delete) an app
1. Open the app → **Overview** → **Controls** → **Remove** (or **Settings** tab → **Remove Application** at the bottom).
3. Type the app's name to confirm, then press **Remove Application**.
- Nexus stops the app and removes it. Its **database and backups are kept**, just in case. Delete the database separately under **Databases** if you really don't need it.

---

## 8. Databases (tables)

A database is like a **notebook full of tables**. Each table is a page with rows and columns.

- **Make one:** **Databases** → **Create Database** → choose **Tables (recommended)** → type a **Database name** → **Create**.
  (Apps usually get their own database automatically when you add them.)
- **Make a table (no code):** open the database → **New Table**.
  1. Pick a starting point (**Customers**, **Products**, **Orders**, **Employees**) or **Blank**, then give the table a name.
  2. Fill in one row per column: **Column name**, **Type** (Text, Whole number, Money, Yes / no, Date, Email address…), tick **Required**, **Unique** or **Key**, and set a **Default** if you like (for dates, "now" means the moment the row is added).
  3. To connect it to another table, choose it under **Links to** (for example orders.customer_id → customers → id), and choose what happens when that row is deleted.
  4. The message at the bottom says **Ready to create** when everything is right (**Show SQL** shows exactly what Nexus will do). Press **Create Table**.
- **Print a blueprint:** open any database (tables or documents) → **Blueprint**. You get a diagram of the tables and how they link, every column, which apps use the database and how. Press **Print / Save as PDF**.
- **Look inside:** click the database → pick a table on the left.
- **Find things:** type in **Filter column…**, use **Next** to see more pages.
- **Change a value:** click a box, type, then **Save**.
- **Add a row:** press **Add Row**.
- **Delete a row:** Nexus asks *"Delete this row?"* first, so you don't do it by accident.
- **Back it up:** press **Backup** on the database page.
- **Connect another program:** the **Connections** section shows the connection details.
- **Use it from another computer:** at the bottom of the database page, **Connect from another server → Share** gives you a link that works only inside your private network (WireGuard). The other computer joins the private network as a device, then uses the link. Nothing opens to the internet.
- **Delete a database:** open it and scroll to the bottom → **Delete database** → type its name → **Delete Database**. This can't be undone.
  - If an app still uses it, Nexus says **In use by …** and won't delete it. Remove that app first (app → **Overview → Remove**), then delete the database.
  - The same works for **document databases**.

---

## 9. Document databases

For apps that store **documents** (bundles of information, like a contact card with name, phone and address together) instead of tables. They work with MongoDB apps.

1. **Databases** → **Create Database** → choose **Documents** → **Create**.
2. Open it and press **Create Collection**. A collection is a drawer for one kind of document, like "customers".
3. Press **Add Document**, type the information, and **Save Changes**.
4. Click a document to **Edit document**, or use **Show JSON** to see it in computer form.
5. **Filter documents** to find things. **Import** brings documents in from a file.
6. **Moving from another MongoDB (like Atlas)?** Press **Copy from MongoDB**, paste the old database's address, and press **Start Copy**. Everything comes across exactly as it was.
7. See a **yellow notice** saying ids or dates are "stored as plain text"? That means the data came from a file and lost its special types. Press **Fix types** and it's repaired in a few seconds.

---

## 10. Importing data from a file

Have a list in **Excel**, **CSV** or **JSON**? Put it into a database:

1. Open a database and click **Import data**.
2. **Choose a data file**.
3. Nexus reads it and suggests everything: *"I found these columns: Driver ID, Driver Name, Balance…"*
4. **Review the suggested names and types.** Each column gets a type: **Text**, **Whole number**, **Decimal number**, **Date**, **Date and time** or **Yes / no**. Untick a column to leave it out.
5. Pick the **primary key**: the column that's different for every row, like a student ID. Or choose **Add an automatic ID**.
6. Choose **Create a new table** (recommended; keeps existing data unchanged) or **Add rows to an existing table** (column names must match the table).
7. Press **Import**. When you see **Import complete**, your data is in!

If a value doesn't fit (like "hello" in a number column), Nexus stops, **changes nothing**, and shows exactly which values are wrong.

---

## 11. Asking questions about your data

1. Open a database and find **Ask about this data**.
2. Type a question like: *"How many trips did each driver do last month?"*
3. Nexus answers with a **chart**, a **table** and a short sentence.
   - Hover over the chart to see exact numbers.
   - If there are several measures, switch between them.
4. You can also choose **SQL** and type your own query.

Nexus can only **read** data here. It can never change or delete anything. (Needs the AI to be ready for plain-English questions; SQL always works.)

---

## 12. Pipelines (the conveyor belts)

A pipeline does a data job for you, again and again. Example: *"Every night, copy the new orders into my reports."*

### Make one: the easy way (describe it)
1. **Pipelines** → **Create Pipeline**.
2. In **Describe it**, type what you want in normal words:
   *"Every night, take the completed trips from TaxiOps, remove duplicates, and load them into the Warehouse."*
3. Press **Propose pipeline**. Nexus shows the plan: the steps, **when it will run**, **what Nexus assumed**, and any warnings. If it wrote a Python or R script, you can read and change it.
4. Happy? Press **Create Pipeline**. Not happy? Press **Change description**.

### Make one: from a starting point
Below **Describe it**, pick a card (**Import data**, **Move data between databases**, **Load warehouse**, **Run Python script**, **Run R script**, **Transform data**, **Call API**, **Export data**), choose a template, answer a few questions, and press **Create Pipeline**.

### Make one: build it yourself
Pick **Build custom pipeline**. In the **Designer**, click blocks on the left to add them (**Get data from**, **Change the data**, **Save to**). Drag from a block's right-hand dot to another block to connect them. Use **−**, **+** and **Fit** to zoom, and **Tidy up** to straighten things. Press **Save**.

### Test it, then switch it on
New pipelines start **switched OFF**, so nothing happens by surprise.
1. Open the pipeline and press **Run**. Choose a small test first, or **Run for real**.
2. Watch the steps turn green ✅ (**Succeeded**). Click **Preview** on a step to see its data.
3. Happy? Flip the **Switched on** switch. Now it follows its schedule.

### Choose when it runs (Settings tab)
Under **When it runs**: **Only when started**, **Every few minutes or hours**, **Every day**, **Every week**, **Every month**, **When a file arrives**, or **After other pipelines**.

### Notifications
In the pipeline's **Settings**, choose when Nexus should tell you: when it fails, when it succeeds, when a run looks unusual, or **When a data quality check finds problems**.

### When a pipeline breaks
1. Open the run that says **Failed** (red).
2. Press **Explain what went wrong**. Nexus says something like: *"The data no longer contains provider_id. It now has provider_code instead."*
3. Fix the step it points to, then press **Resume from where it stopped**. Steps that already worked don't run again.

### Extra tools
- **Pipelines → Secrets:** store passwords and keys that pipelines need (they're encrypted, and never shown in the pipeline).
- **Versions:** every save is kept. **Compare** two versions, or **Go back to this** one.
- **Pipeline file:** see or edit the whole pipeline as text, or **Download** it.
- **Start from other systems:** press **Create webhook** so another program can start the pipeline through a web address. **Copy this now**, because the secret is shown once.
- **Parameters:** values you choose each time it runs (like a start date). **Add parameter** in Settings.

---

## 13. Backups (your safety copies)

Nexus makes backups **automatically** after an app's first deployment. You don't have to remember!

- **See them:** click **Backups**. **Protected** means an app is safe.
- **Make one now:** open an app's **Backups** tab → **Manual backup**.
- **Change how often:** in **Automatic backups**, choose **Daily**, **Weekly** or a **Custom interval**, the **Time**, and how many restore points to keep (**Keep restore points**).
- **Go back in time:**
  1. Pick a **restore point** and press **Restore**.
  2. Choose **Entire application**, or **Restore only selected parts** (database, files, configuration).
  3. ⚠️ **Current data will be replaced.** Nexus asks before doing it.

Backups are locked with your **Server Recovery Key** (AES-256 encryption) and checked after every backup (**Verified after every backup**).

---

## 14. Nexus AI (the robot helper)

### Turn it on
1. Install **Ollama** (free and open source) from **ollama.com** and open it.
2. Click **Nexus AI**. Nexus finds Ollama by itself and downloads the best model for your computer. Wait until it says **Ready**.
   - Your computer's graphics card decides the model. The page shows it under **How it runs** (**Mode**, **Model**, **Engine**).
   - Keep Ollama open. If it's closed, Nexus says so and connects again when you open it.

### Use it
Type a question in **Ask about this server**, like:
- *"Is everything healthy?"*
- *"Why did my app stop?"*
- *"Which apps don't have a backup?"*

It remembers what you just talked about, so follow-up questions work.

### How much it may do (Permission)
- **Observe only**: it just watches.
- **Recommend** (the default): it suggests, you decide.
- **Execute after approval**: it can do things, but only after you say yes.

It **never** changes anything important on its own. Everything stays **on your computer**; nothing is sent to the internet.

---

## 15. Notifications (the bell)

Click the **bell 🔔** at the top to read messages: a pipeline failed, a pipeline recovered, a run looked unusual, a data check found problems. Click a message to go straight to it.

---

## 16. Settings: People

Let family or coworkers use Nexus, each with their own account.

1. **Settings → People → Add Person**.
2. Fill in **Display name**, **Username**, **Password** (and **Email** if you like).
3. Choose a **role**:
   - **Owner**: can do everything.
   - **Administrator**: manages server, applications, databases and people.
   - **Operator**: can monitor apps, restart them and run backups.
   - **Developer**: can deploy and configure applications.
   - Others can be allowed into **one app only** (**Application-specific access**).
4. To stop someone, open their account and switch it off or remove it. **Existing sessions stop working immediately.**

---

## 17. Settings: Sign-in & Security

- **Password:** press **Set Password** (or **Change**), type it twice, **Save Password**. A green message confirms it's saved.
- **Two-step verification (turn this on!):** it's a second lock on your door.
  1. Install an authenticator app on your phone (for example **Aegis** or **FreeOTP**, both free and open source).
  2. Press **Set Up** next to **Two-step verification**.
  3. Scan the code with the app (or type the **setup key**).
  4. Type the 6-digit code the app shows.
  5. **Save your recovery codes** somewhere safe. They're shown once, and they get you in if you lose your phone.

---

## 18. Settings: External Access (reaching Nexus from outside)

There are three ways, and **none of them needs an account with any company**:

### A. Private network (WireGuard): for YOU, from your phone or laptop, anywhere
Best for private apps and managing Nexus while you're away. Only your own devices can use it.
1. Download **WireGuard for Windows** (free) from **wireguard.com/install** and install it on the Nexus computer.
2. **Settings → External Access** → **Private network (WireGuard)** → press **Set up**.
3. Press **Add device**, type a name like "My phone", press **Add**.
4. On your phone, install the **WireGuard** app → tap **+** → **Scan from QR code** → scan the square code → switch the tunnel **on**.
   (For a laptop: **Download file for a laptop**, then in WireGuard choose **Import tunnel from file**.)
5. On your phone, open the addresses listed under **Addresses on your devices** (like `http://10.73.0.1:8431` for the control center).
- **"One router setting needed"**: forward the UDP port it shows (usually **51820**) on your router to this computer.
- **"Only works at home for now"**: your internet company shares one address between many homes. Ask them for a **public IP address**.
- The QR code is shown **only once**. Lost it? Remove the device and add it again.

### B. Direct connection: for PUBLIC websites
For apps that everyone on the internet should reach.
1. On your **router**, forward ports **80** and **443** to this computer (this computer is **192.168.0.9**).
   - Also reserve that address for this computer in the router (**Address Reservation**), so it never changes.
2. Buy a **domain name** (like `mohamedgad.com`) from any registrar.
3. At the registrar, create an **A record** pointing to your public address (shown under **Public Address**).
4. In Nexus, **Domains → Base domain** → type your domain → **Save**. A green message confirms it.
5. Set an app to **Public website**. Nexus gets the HTTPS certificate for free, automatically, and shows **DNS connected** and **HTTPS active** when it's ready.

### C. Remote administration: the control center on the internet
Lets you manage Nexus from a web address like `server.mohamedgad.com`. Leave it **off** unless you need it (the private network is safer).
1. First set a **password** and **two-step verification** (part 17).
2. **Remote administration → Configure** → tick **Allow remote administration** → type the **Control center address** → tick **I understand…** → **Save Access**.
3. Point that address to your public IP at your domain registrar.

(The **Secure tunnel (Cloudflare)** and **Tailscale** rows are optional extras for people who already use those services. They need accounts; you don't have to use them.)

---

## 19. Settings: Plugins

Plugins add extra abilities to Nexus.
1. **Settings → Plugins → Install Plugin** → choose the plugin.
2. **Review Plugin**: Nexus shows what the plugin wants to do (**Approve capabilities**). **Install only plugins you trust.**
3. Turn it on or **Off**, **Update Plugin**, or **Remove Plugin** anytime. **Recent plugin log** shows what it's been doing.

---

## 20. Settings: Advanced › Developer

For people who build apps or connect other programs:
- **API credentials**: keys that let other programs talk to Nexus (for example, to start a pipeline).
- **Local API**: the address other programs on this computer use.
- **Audit** (audit trail): a list of everything important that happened and who did it, protected against tampering (**Audit Integrity**).
- **Environment variables**, **PostgreSQL** details, and storage information.

---

## 21. When something goes wrong

### "Nexus isn't running yet"
The background helper isn't answering. Try these in order:
1. **Wait 1 minute**, then click **Try Again**.
2. **Restart the computer**, then open Nexus again.
3. Start the helper by hand: press the **Windows key**, type **Services**, open it, find **Nexus Server Core**, right-click → **Start**. Then **Try Again**.
4. Still stopping? Ask your developer to read the log:
   - Right-click **Start** → **Terminal (Admin)** → click **Yes**. The window title must say **Administrator**, or you'll get "Access is denied".
   - Paste this and press Enter, then send what it prints:
     ```powershell
     Get-ChildItem C:\ProgramData\Nexus\logs -Recurse -File | Sort-Object LastWriteTime | Select-Object -Last 3 | ForEach-Object { "== $($_.FullName)"; Get-Content $_.FullName -Tail 30 }
     ```
5. Last resort: run **NexusSetup.exe** again to repair Nexus. Your data and backups are kept.

### Quick fixes

| Problem | What to do |
|---|---|
| An app says **Stopped** | Open it → **Overview** → start it. Still stopped? **Logs** → **Explain these errors**. |
| A pipeline **Failed** | Open the run → **Explain what went wrong** → fix → **Resume from where it stopped**. |
| AI says **Engine not installed** | Install **Ollama** from ollama.com and open it. Nexus connects by itself. |
| A deployment says **Python is needed** | Nexus includes Python 3.12. If your app needs a different version, install it from python.org → **Customize installation** → tick **Install Python for all users**, then deploy again. (Pythons installed only for your own account can't be used by Nexus, for safety.) |
| AI is **Preparing model** for a long time | It's downloading (can be several GB). Keep Ollama open and wait. |
| Import says a value doesn't fit | Change that column to **Text**, or fix the value in your file. |
| Can't sign in from another device | Set a password **and** two-step verification first (part 17). |
| Forgot your password | Ask the **Owner** to set a new one in **Settings → People**. |
| The private network says **One router setting needed** | Forward the UDP port it shows on your router to this computer. |

---

## 22. Installing Nexus on another computer

1. Copy **NexusSetup.exe** to the new computer and install it (part 1).
2. Nexus brings everything it needs: the database engine, the secure gateway, the data tools, the document database, Node.js and **its own Python 3.12** for apps and pipeline scripts.
3. Two free extras are separate downloads, if you want them:
   - **Ollama** (ollama.com) for Nexus AI.
   - **WireGuard** (wireguard.com/install) for the private network.
4. Your apps and data **don't move by themselves**. To bring them over, restore them from a backup using your **Server Recovery Key**.

---

## The 5 Golden Rules 🌟

1. **Keep your Server Recovery Key safe** (on paper, in a drawer).
2. **Turn on two-step verification.**
3. **Test pipelines before switching them on.**
4. **Read before you click Restore, Remove or Delete.**
5. **When confused, ask Nexus AI.** That's what it's there for!

You're now a Nexus expert. Great job! 🚀
