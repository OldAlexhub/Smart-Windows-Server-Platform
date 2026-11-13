NEXUS SERVER — PORTABLE COPY
============================

Runs Nexus straight from this folder. Nothing is installed, and you can copy
the whole folder to a USB drive or another computer.

START
  Extract the complete ZIP first. Do not run Start Nexus.cmd inside the ZIP.
  Double-click "Start Nexus.cmd". Nexus starts and opens in your web browser.
  The first time, it asks a few questions (like the installed version).
  Everything you create is kept in the "data" folder next to this file.

STOP
  Double-click "Stop Nexus.cmd". Nexus stops your applications and databases
  properly, then closes.

DIFFERENCES FROM THE INSTALLED VERSION
  - It runs only while you are signed in to Windows and until you press Stop.
    (The installed version runs in the background all the time, even after a
    restart.)
  - It uses the address http://127.0.0.1:7781, so it can run next to an
    installed Nexus (which uses 7780).
  - Publishing apps to the internet (ports 80/443), the firewall and the
    private network need administrator rights. Use the installed version for
    those.

MOVING IT
  Stop Nexus first, then copy the whole folder (including "data").
  On the same Windows account, saved portable paths are repaired at startup.
  Before repair, a copy of the settings database is saved beside nexus.db.
  Moving existing encrypted data to another computer or Windows account needs
  Nexus backup/recovery: Windows protects the vault key for the original account.
  Keep your Server Recovery Key safe: backups can't be opened without it.

UPDATING IT
  Stop Nexus first. Extract the new ZIP into a separate folder, then copy your
  existing "data" folder into it. Keep the old folder until the new copy works.

IF IT DOES NOT START
  The launcher keeps the error visible. Startup details are saved in
  data\nexus\logs\startup-error.log (and startup-output.log).
  Only one portable copy can use port 7781 at a time; stop the other copy first.

The full guide is HOW-TO-USE-NEXUS.md.
