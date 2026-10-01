# Nexus Server: Easy Step-by-Step Manual

This manual explains Nexus Server in very simple words. You do not need to be a server expert.

Think of Nexus as a careful robot helper living inside your Windows computer. You give it an application folder, and it can help run the application, give it a database, watch it, back it up, and explain problems.

---

## The three most important rules

1. **If you are unsure, choose the option marked Recommended.**
2. **Keep remote administration turned off until you truly need it.** Local-only access is safest.
3. **Make a backup before changing or deleting important things.**

> **Stop sign:** Do not manually delete Nexus folders, database files, or backup files. Use the buttons inside Nexus.

---

## What the common words mean

- **Application:** A program or website you want Nexus to run.
- **Application folder:** The folder containing the application's files.
- **Database:** An organized box of information, like customers, orders, or messages.
- **Backup:** A safe copy you can use if something breaks.
- **Restore:** Going back to an older safe copy.
- **Pipeline:** A robot-like list of steps that moves or changes data.
- **Gateway:** The guarded front door used for websites and remote access.
- **Owner:** The main person who controls the whole server.
- **MFA or two-step verification:** A password plus a changing code from an authenticator app.

---

# Part 1: Install Nexus Server

## Normal installation

Use these steps if you have a file named `NexusSetup.exe`.

1. Find `NexusSetup.exe` in File Explorer.
2. Double-click it.
3. Windows may ask, **Do you want to allow this app to make changes?**
4. Check that you expected to install Nexus, then click **Yes**.
5. Follow the installer until it says the installation is finished.
6. Open the Windows **Start** menu.
7. Search for **Nexus Server**.
8. Open it.
9. Wait while the Nexus window connects to the background service.

The Nexus window is only the control panel. Closing the window does **not** stop your applications. The Nexus background service keeps working.

### If Nexus says it cannot connect

1. Wait one minute. The service may still be starting.
2. Click **Try Again** if that button appears.
3. If it still does not work, restart Windows.
4. Open Nexus Server again.
5. If it still fails, see [Simple troubleshooting](#part-14-simple-troubleshooting).

---

# Part 2: Do the first setup

The first setup normally happens only once.

## Step 1: Welcome

1. Open Nexus Server.
2. On the **Welcome to Nexus** screen, click **Get Started**.

## Step 2: Let Nexus check the computer

1. Wait on **Checking your computer...**
2. Nexus checks the processor, memory, drives, graphics, and network.
3. Read any item marked **Note** or **Problem**.
4. When the button becomes available, click **Continue**.

Do not worry if AI says **CPU Mode**. Nexus can still work; AI may simply be slower.

## Step 3: Review the recommended folders

You will see locations for:

- Application Storage
- Database Storage
- File Storage
- Backup Location
- AI Models

The easiest choice is to leave the recommended locations alone.

If you have a second drive or an external drive, it is smart to put backups there:

1. Find **Backup Location**.
2. Click **Change**.
3. Pick the separate drive.
4. Choose a drive marked **Recommended** or **OK**.

> A backup on the same broken drive may be lost too. A separate backup drive is safer.

## Step 4: Apply the setup

1. Click **Use Recommended Configuration**.
2. Wait while Nexus prepares the server.
3. Do not turn off the computer during this step.
4. When you see **Your server is ready**, choose one:
   - Click **Add Your First Application** if your application folder is ready.
   - Click **Go to the dashboard** if you want to look around first.

---

# Part 3: Learn the main menu

The menu on the left has these sections:

- **Dashboard:** A quick report card for the server.
- **Applications:** Programs and websites Nexus is running.
- **Databases:** Stored business information.
- **Pipelines:** Automatic data-moving jobs.
- **Backups:** Safe restore points.
- **Nexus AI:** Private help that runs on this server.
- **Settings:** People, security, outside access, plugins, and advanced details.

On a small screen, click the menu button at the top to show this list.

### Understanding colors

- **Green / Ready / Running:** Everything looks good.
- **Yellow / Warning / Needs Attention:** Read the message. The system may still work.
- **Red / Problem / Failed:** Open the item and follow the suggested repair.
- **Gray / Stopped / Off:** The item is not running. This may be intentional.

---

# Part 4: Your 30-second daily check

Do this once a day, or whenever something feels wrong.

1. Open **Dashboard**.
2. Look at the health score.
3. Check that important applications say **Running**.
4. Check that databases say **Online**.
5. Look for backup warnings.
6. Read **Recent Activity**.
7. If you see a problem card, read its plain-language explanation.
8. Use **Try Again** or another repair button only after reading what it will do.

You can also open **Nexus AI** and ask:

> Is everything healthy?

---

# Part 5: Add your first application

Before starting, place the application's files in one folder. The correct folder usually contains one of these files:

- `package.json` for a Node.js application
- `requirements.txt` or `pyproject.toml` for a Python application (including Streamlit)
- `index.html` for a static website

## Step 1: Open the wizard

1. Click **Applications**.
2. Click **Add Your First Application** or **Add Application**.

## Step 2: Choose the application folder

1. Browse to the folder containing the application.
2. Click **Choose**, or type the complete folder path.
3. Click **Analyze Folder**.

If Nexus says the folder is not recognized, go one folder deeper or higher until the folder directly containing `package.json`, `requirements.txt`, `pyproject.toml`, or `index.html` is selected.

## Step 3: Review what Nexus found

1. Read **Here's what Nexus found**.
2. Check the detected language, application type, database needs, and warnings.
3. Change the application name if needed.
4. Click **Continue**.

## Step 4: Choose the data option

Pick one choice:

- **Create a new database — Recommended:** The easiest and safest choice for most applications.
- **Use an existing Nexus database:** Use this only when the application is supposed to share existing data.
- **Connect an external database:** Use a PostgreSQL address supplied by another database owner.
- **This application doesn't need a database:** Choose this for apps that truly do not store database information.

Then click **Continue**.

> If you do not know which choice to make and Nexus detected a database, choose **Create a new database**.

## Step 5: Choose who can reach the application

You will see four choices:

1. **Private to this computer** — safest; only this server can open it.
2. **Public website** — anyone with the internet address can open it.
3. **Authorized users only** — visitors must sign in with a Nexus account.
4. **API access only** — software must use an API key; normal browser access is blocked.

For your first try, choose **Private to this computer**.

If you choose a public option, enter a domain such as `app.example.com`. You must own or control that domain.

## Step 6: Deploy

1. Click **Deploy Application**.
2. Watch the setup steps.
3. You may leave the page; the server keeps working.
4. If Nexus asks one question, read the choices and pick the one that matches your app.
5. If a step fails, read the problem card. Nexus will not secretly change application code.
6. When you see **is online**, look at the final checks.
7. Click the application address to open it.

Nexus makes its own release copy. Keep your original source folder too; it is still your working copy.

---

# Part 6: Control an application

1. Click **Applications**.
2. Click the application name.

## Overview tab

Use these buttons carefully:

- **Start:** Turns on a stopped application.
- **Stop:** Turns it off.
- **Restart:** Turns it off and on again.
- **Deploy Latest:** Copies and deploys the newest files from the source folder.

The page also shows processor use, memory use, stored files, recent activity, and the current release.

## Logs tab

Logs are the application's diary.

1. Open **Logs**.
2. Choose **Problems** or **Errors** if the list is long.
3. Click **Explain these errors**.
4. Read the cause and suggested next step.

Nexus removes known secrets before saving logs, but you should still avoid putting passwords into ordinary application messages.

## Backups tab

1. Open **Backups**.
2. Click **Back Up Now** before an important change.
3. Wait for the backup to say **Protected** or **Ready**.

## Settings tab

Here you can change:

- Who can access the application
- Its domain name
- Application settings and encrypted secrets

Names containing words such as `PASSWORD`, `SECRET`, `TOKEN`, or `KEY` are treated like secrets.

## Deployments tab

Each deployment is kept as a separate release.

If a new release is broken:

1. Open **Deployments**.
2. Find a previous good release.
3. Click **Roll Back**.
4. Read the warning.
5. Confirm only if you understand it.

## Removing an application

1. Make a backup first.
2. Open the application's **Settings** tab.
3. Click **Remove Application**.
4. Type the exact application name.
5. Confirm.

Removing an application stops and removes the app, but Nexus keeps its database and backups so the data is not immediately lost.

---

# Part 7: Use a database

## Create a database by hand

Applications normally receive a database during deployment. To create one yourself:

1. Click **Databases**.
2. Click **Create Database**.
3. Enter a friendly name, such as `Customer Records`.
4. Choose a kind:
   - **PostgreSQL:** Tables and rows, like a powerful spreadsheet.
   - **Documents / MongoDB-compatible:** JSON-like documents and collections.
5. Click **Create Database**.

## Look at PostgreSQL data

1. Click **Databases**.
2. Click a PostgreSQL database.
3. Choose a table on the left.
4. Use **Search every column** to find something.
5. Use the filter boxes for a more exact search.
6. Click a column heading to sort.
7. Click **Export CSV** to download the current table.

## Add or edit a row

1. Open a table.
2. Click **Add Row** to add a new record.
3. Fill in the needed boxes.
4. Click **Add Row** again to save.

To edit an existing value:

1. Click the value in the table.
2. Type the new value.
3. Click **Save**.

> **Be careful:** Database changes can affect a running application immediately.

## Delete a row

1. Make a backup first.
2. Find the row.
3. Click its delete button.
4. Read the confirmation.
5. Click **Delete Row** only if you are certain.

Deleting a row cannot be undone unless you restore a backup.

---

# Part 8: Import CSV, Excel, or JSON data

Use this for a PostgreSQL database.

Supported files include CSV, TSV, Excel `.xlsx`, JSON, JSONL, and NDJSON.

1. Click **Databases**.
2. Open the database that should receive the data.
3. Click **Import Data**.
4. Click **Choose File**.
5. Pick your data file.
6. Click the button to read and review the file.
7. If it is an Excel file with several sheets, choose the correct sheet.
8. Choose one:
   - **Create a new table — Recommended**
   - **Add rows to an existing table**
9. Check the table name.
10. For a new table, choose a primary key or leave **Add an automatic ID** selected.
11. Review every column:
    - Keep the check mark if you want the column.
    - Fix the database name if needed.
    - Check whether it is Text, Whole number, Decimal number, Date, Date and time, or Yes / no.
    - For dates, choose the matching date format.
12. Look at the sample rows.
13. Click **Import _ rows**.
14. Wait for **Import complete**.
15. Open the new table and check a few rows.

If Nexus reports a conversion problem, fix that value in the original file or change the column type to **Text**, then try again.

> Adding rows to an existing table is less forgiving. Column names and types must match. Use a new table if you are unsure.

---

# Part 9: Make and restore backups

## Make a backup now

1. Click **Backups**.
2. Click the application you want to protect.
3. Click **Back Up Now**.
4. Wait until it says **Ready**.

## Set an automatic schedule

1. Click **Backups**.
2. Open an application.
3. Click **Schedule**.
4. Turn on **Automatic backups**.
5. Choose Daily, Weekly, or Custom interval.
6. Choose the time or interval.
7. Leave the restore-point counts at their recommended values unless storage is running low.
8. Click **Save Schedule**.

Automatic backups continue even when the control-center window is closed.

## Save the server recovery key

The recovery key can unlock encrypted backups after Windows is reinstalled.

1. Click **Backups**.
2. As the Owner, click **Recovery Key**.
3. Click **Copy Key**.
4. Save it somewhere **separate from this computer**.
5. Good places include a password manager, a locked USB drive, or a printed copy in a safe place.

> Do not post the recovery key in chat, email, or a public document.

## Restore a backup

Restoring means replacing current information with older information.

1. Tell users the application may be unavailable for a little while.
2. Click **Backups**.
3. Open the application.
4. Find the correct restore point by date and time.
5. Click **Restore**.
6. Choose **Entire application** or **Choose what to restore**.
7. Read the warning carefully.
8. Type the exact application name.
9. Click **Start Restore**.
10. Wait until every step finishes.
11. Open the application and check the important data.

Nexus creates a safety backup before the restore.

---

# Part 10: Create and run a pipeline

A pipeline is a row of connected jobs. For example: read a CSV file, remove bad rows, and save the result in a database.

## The easy template way

1. Click **Pipelines**.
2. Click **Create Pipeline**.
3. Choose what you want to do, such as:
   - Import data
   - Move data
   - Load the Warehouse
   - Run Python or R
   - Transform data
   - Call an API
   - Export data
4. Pick the closest template.
5. Answer the plain-language questions.
6. Click **Create Pipeline**.

## Describe a pipeline in one sentence

If local AI is ready:

1. Open **Create Pipeline**.
2. Find **Describe it**.
3. Type a sentence such as:

   > Every night, copy new sales rows into the Warehouse.

4. Review the proposed blocks, settings, schedule, assumptions, warnings, and any script.
5. Fix missing database, file, or secret choices.
6. Click **Create** only when the proposal is correct.

Nexus does not save the proposal until you approve it. A newly created pipeline starts **Off**.

## Run a pipeline safely

1. Open the pipeline.
2. Use a test run first, such as 100 rows.
3. Read the preview and warnings.
4. If the result looks right, run it for real.
5. Open the run page to see each step, rows in, rows out, logs, and data-quality checks.
6. Turn the pipeline **On** only after a successful test.

## Add a secret for a pipeline

Use a secret for an API key or password.

1. Open **Pipelines**.
2. Click **Secrets**.
3. Enter a simple secret name, such as `shop_api`.
4. Paste the secret value.
5. Click **Save**.

The secret value is encrypted and is not shown again.

---

# Part 11: Use Nexus AI

Nexus AI runs locally. Server information stays on this computer unless an application or pipeline you configure sends something elsewhere.

1. Click **Nexus AI**.
2. Type a simple question, such as:
   - `Is everything healthy?`
   - `Which apps need attention?`
   - `Are my backups current?`
   - `Why did my pipeline fail?`
3. Click **Send**.
4. Read the answer and evidence.

## Change AI safety mode

1. Click **AI Settings**.
2. Turn **Use local AI** on or off.
3. Choose a permission level:
   - **Observe:** Explain only.
   - **Recommend:** Suggest changes, but do not make them.
   - **Execute after approval:** Prepare an action and wait for a person to approve it.
4. Leave **Model override** blank unless you understand model names and memory needs.
5. Click **Save Settings**.

The safe everyday choice is **Recommend**. Nexus AI cannot delete backups or disable security.

## Ask about database data

On a database page, use **Ask about this data** when available.

1. Ask a plain question, such as `How many orders were placed each month?`
2. Review the read-only query Nexus prepared.
3. Look at the chart and the complete table below it.

This feature is read-only. It is not allowed to change database rows.

---

# Part 12: Add people and control access

1. Click **Settings**.
2. Open **People**.
3. Click **Add Person**.
4. Enter the person's display name and username.
5. Add an email address if wanted.
6. Choose a role:
   - **Administrator:** Manages the server, applications, databases, and people.
   - **Developer:** Deploys and configures applications.
   - **Operator:** Watches apps, restarts them, and runs backups.
   - **Viewer:** Can look but normally cannot change things.
   - **Application user:** Uses only assigned applications.
7. Enter a strong temporary password if the person needs password sign-in.
8. Click **Add Person**.

To change access later:

1. Find the person.
2. Click **Manage**.
3. Change the server role or application-specific role.
4. Use **Suspend this account** to stop access immediately without deleting the person.
5. Click **Save Access**.

Give each person only the access they need.

---

# Part 13: Passwords, two-step verification, and remote administration

## Set the Owner password

1. Click **Settings**.
2. Open **Sign-in & Security**.
3. Under Password, click **Set Password**.
4. Enter a long, unique password.
5. Enter it again.
6. Click **Save Password**.

A good password is a long phrase that you do not use anywhere else.

## Turn on two-step verification

You need an authenticator app that supports TOTP codes.

1. In **Settings > Sign-in & Security**, find **Two-step verification**.
2. Click **Set Up**.
3. In your authenticator app, add an account manually.
4. Copy the setup key from Nexus into the authenticator app.
5. The authenticator app will show a six-digit code.
6. Type that code into Nexus.
7. Click **Verify and Enable**.
8. Copy the recovery codes.
9. Store the recovery codes somewhere separate and safe.
10. Click **I Saved Them** only after you truly saved them.

Each recovery code works only once.

## Turn on remote administration

Remote administration lets you open the Nexus control center from another computer. This is different from publishing an application.

> If you do not understand domains, DNS, HTTPS, or router/tunnel setup, leave remote administration off and ask a trusted network administrator for help.

Before starting, the Owner must have both a password and two-step verification.

1. Sit at the server computer. Remote administration can only be changed locally.
2. Click **Settings**.
3. Open **External Access**.
4. Find **Remote administration**.
5. Click **Configure**.
6. Turn on **Allow remote administration**.
7. Enter a domain you control, such as `server.example.com`.
8. Make the DNS change Nexus shows, if one is needed.
9. Check the box saying you understand the sign-in page will be reachable from the internet.
10. Click **Save Access**.
11. Wait for the secure gateway and HTTPS checks.
12. From another computer, open the exact address shown by Nexus.
13. Sign in with the username and password.
14. Enter the current authenticator code.

Every remote control-center sign-in requires MFA. Remote traffic is accepted only through the Nexus secure gateway at the exact configured hostname.

## Turn remote administration off

1. Return to the server computer.
2. Open **Settings > External Access**.
3. Click **Configure** under Remote administration.
4. Turn off **Allow remote administration**.
5. Click **Save Access**.

Existing remote control-center sessions are revoked. Published applications stay signed in and continue working.

---

# Part 14: Simple troubleshooting

## Nexus window stays on “Connecting to your server...”

1. Wait one minute.
2. Close and reopen Nexus.
3. Restart Windows.
4. If needed, press `Windows key + R`.
5. Type `services.msc` and press Enter.
6. Find **Nexus Server Core**.
7. Check whether it says **Running**.
8. If it is stopped, right-click it and choose **Start**.

## An application will not start

1. Open **Applications**.
2. Open the application.
3. Read the problem card.
4. Open **Logs**.
5. Choose **Problems**.
6. Click **Explain these errors**.
7. Use a offered repair only after reading it.
8. If the newest code is broken, open **Deployments** and roll back to the last good release.

## A port is already being used

Nexus normally moves a private application to a free port automatically.

If another program blocks the public web ports:

1. Read the problem card. It should name the blocking program when possible.
2. Close or reconfigure that other web server.
3. Click **Try Again**.

Do not randomly stop Windows processes you do not recognize.

## A database connection stopped working

1. Open the affected application's problem card or logs.
2. If Nexus offers **Repair Connection**, read the message.
3. Run the repair.
4. Nexus will create fresh managed credentials and restart the application.

## A pipeline failed

1. Open **Pipelines**.
2. Open the failed pipeline.
3. Open the failed run.
4. Find the first red step.
5. Read the plain-language explanation.
6. Check whether a file moved, a column was renamed, a credential expired, or a source is offline.
7. Fix the cause.
8. Click **Resume** when offered, or run a small test again.

## A backup failed

1. Make sure the backup drive is connected.
2. Make sure the drive has free space.
3. Open **Backups** and read the error.
4. Correct the problem.
5. Click **Back Up Now** again.

## Remote administration does not open

1. Make sure Remote Administration says **Enabled**.
2. Use the exact hostname shown in Nexus.
3. Check the DNS message in **Settings > External Access**.
4. Check that the Secure Gateway says **Running**.
5. Make sure another program is not blocking ports 80 or 443.
6. Never bypass the warning by exposing the private Nexus port directly to the internet.

---

# Part 15: Plugins — advanced and optional

A plugin adds an extra ability to Nexus. A plugin is still computer code, so use only a plugin from someone you trust.

The plugin folder must already contain `nexus-plugin.json` and all of its needed files.

## Install a plugin

1. Click **Settings**.
2. Open **Plugins**.
3. Click **Install from Folder**.
4. Choose the plugin folder.
5. Click **Review Plugin**.
6. Read the publisher, license, version, description, and every requested capability.
7. Approve only the capabilities you understand.
8. Click **Install Plugin**.

A new plugin is installed **Off**.

## Turn on or manage a plugin

1. Find the plugin under **Settings > Plugins**.
2. Switch it **On**.
3. Check that its status becomes healthy or running.
4. Use **Recent plugin log** if it needs attention.
5. Use **Restart** if it stopped responding.
6. Use **Update** to review a newer folder. Capabilities must be approved again.
7. Use **Remove** only after reading the warning and typing the exact plugin name.

Nexus does not run `npm install`, setup scripts, or automatic downloads for a plugin. It checks installed plugin files for changes before every start. This helps, but it does not make untrusted code safe.

---

# Part 16: Safe shutdown, restart, update, and uninstall

## Close only the control-center window

You can close the Nexus window. The background service and applications continue running.

## Restart Windows

1. Make sure no backup, restore, import, deployment, or pipeline is currently running.
2. Use the normal Windows **Restart** command.
3. Nexus Server Core starts automatically after Windows starts.
4. Open Nexus and check the Dashboard.

## Update Nexus

1. Make a fresh backup of important applications.
2. Save the recovery key somewhere separate.
3. Run the newer trusted `NexusSetup.exe`.
4. Allow the installer to update the service.
5. Open Nexus.
6. Check the Dashboard, applications, databases, and latest backups.

## Uninstall Nexus

Use **Windows Settings > Apps > Installed apps** to uninstall Nexus Server.

The uninstaller removes the service and program files but is designed to keep your data. Even so, make and verify an external backup before uninstalling.

---

# Part 17: A simple first-day checklist

Use this list the first time you set up a real server:

- [ ] Install Nexus Server.
- [ ] Use the recommended first-run configuration.
- [ ] Put backups on a separate drive if possible.
- [ ] Set the Owner password.
- [ ] Turn on two-step verification.
- [ ] Save the MFA recovery codes somewhere separate.
- [ ] Save the server recovery key somewhere separate.
- [ ] Add one application as **Private to this computer**.
- [ ] Open the application and test it.
- [ ] Make the first manual backup.
- [ ] Set an automatic backup schedule.
- [ ] Test a small pipeline before switching it on.
- [ ] Add other people with only the access they need.
- [ ] Leave remote administration off unless it is truly needed.

---

# Appendix A: Run this project from its source folder

This section is for a developer or the person building Nexus. Normal users should use `NexusSetup.exe` instead.

The project folder is:

```text
C:\Users\moham\Desktop\Smart Windows Server Platform
```

You need Node.js and the normal project build tools installed.

## Prepare and start a source copy

1. Open PowerShell.
2. Move into the project folder:

   ```powershell
   Set-Location "C:\Users\moham\Desktop\Smart Windows Server Platform"
   ```

3. Install the JavaScript packages:

   ```powershell
   npm install
   ```

4. Download the pinned open-source server components:

   ```powershell
   node scripts/fetch-components.mjs
   ```

5. Build the control-center pages:

   ```powershell
   npm run build -w apps/ui
   ```

6. Start the development server:

   ```powershell
   npm run dev:server
   ```

7. PowerShell prints a line beginning with **Open:**. Copy the entire address into a browser on this computer.
8. Keep that PowerShell window open while using the development server.
9. Press `Ctrl+C` in that window when you want to stop the development copy.

Development data is normally kept in the project's `.nexus-dev` folder. Do not use a development copy as your only production server.

## Build the normal installer

From the project folder, run:

```powershell
npm run build
```

When all build steps finish, the installer is expected here:

```text
C:\Users\moham\Desktop\Smart Windows Server Platform\dist\NexusSetup.exe
```

Run the test suite before giving the installer to another person:

```powershell
npm test
```

---

# Quick help card

If you remember only five things, remember these:

1. Start at the **Dashboard**.
2. Choose **Recommended** when unsure.
3. Keep apps **Private to this computer** until outside access is really needed.
4. Back up before changing, deleting, restoring, or updating.
5. Read the problem card and logs before pressing repair buttons.
