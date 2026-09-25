NEXUS SERVER — PORTABLE COPY
============================

Runs Nexus straight from this folder. Nothing is installed, and you can copy
the whole folder to a USB drive or another computer.

START
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
  Keep your Server Recovery Key safe: backups can't be opened without it.

The full guide is HOW-TO-USE-NEXUS.md.
