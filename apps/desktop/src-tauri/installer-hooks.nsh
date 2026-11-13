; Nexus installer hooks (Tauri NSIS). The installer runs elevated (per-machine install).
; The Windows service does the real work; the desktop app is only a window onto it.
!define NEXUS_PREFLIGHT_SOURCE "${__FILEDIR__}\installer-preflight.ps1"

!macro NSIS_HOOK_PREINSTALL
  ; Stop through Windows even if an earlier partial install lost the wrapper.
  ; Run outside $INSTDIR so the check itself cannot lock the runtime.
  InitPluginsDir
  File /oname=$PLUGINSDIR\nexus-install-preflight.ps1 "${NEXUS_PREFLIGHT_SOURCE}"
  DetailPrint "Waiting for Nexus to stop and release its files..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\nexus-install-preflight.ps1" -InstallDir "$INSTDIR"'
  Pop $4
  Pop $5
  DetailPrint "$5"
  ${If} $4 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Nexus setup cannot replace files safely.$\r$\n$\r$\n$5$\r$\n$\r$\nClose Nexus applications and try setup again. If files remain in use, restart Windows and run setup before opening Nexus." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Remember which Windows account installed Nexus: only that account (plus Administrators)
  ; may use the desktop app's automatic sign-in.
  ReadEnvStr $0 "ProgramData"
  CreateDirectory "$0\Nexus"
  ReadEnvStr $1 "USERDOMAIN"
  ReadEnvStr $2 "USERNAME"
  FileOpen $3 "$0\Nexus\desktop-users.txt" a
  FileSeek $3 0 END
  FileWrite $3 "$1\$2$\r$\n"
  FileClose $3

  ; Register (or upgrade) and start the background service.
  DetailPrint "Starting the Nexus background service..."
  nsExec::ExecToLog '"$INSTDIR\app\node\node.exe" "$INSTDIR\app\scripts\service.mjs" install --install-dir "$INSTDIR\app"'
  Pop $4
  ${If} $4 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Nexus setup could not start its background service. Installation is incomplete. Check the setup details and the service logs in ProgramData\Nexus\logs\service, then run setup again." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and remove the service. Your data (databases, files, backups) is kept.
  nsExec::ExecToLog '"$INSTDIR\app\node\node.exe" "$INSTDIR\app\scripts\service.mjs" uninstall --install-dir "$INSTDIR\app"'
  Pop $4
  ${If} $4 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Nexus could not stop and remove its background service. Uninstall has stopped to avoid removing files from a running server. Restart Windows and try again." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
