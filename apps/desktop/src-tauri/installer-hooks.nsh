; Nexus installer hooks (Tauri NSIS). The installer runs elevated (per-machine install).
; The Windows service does the real work; the desktop app is only a window onto it.

!macro NSIS_HOOK_PREINSTALL
  ; Upgrading: stop the running service so its files can be replaced.
  IfFileExists "$INSTDIR\app\service\NexusServer.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\app\service\NexusServer.exe" stop'
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
  StrCmp $4 "0" +2
    MessageBox MB_ICONEXCLAMATION "Nexus was installed, but its background service could not be started. Restart your computer, then open Nexus."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and remove the service. Your data (databases, files, backups) is kept.
  nsExec::ExecToLog '"$INSTDIR\app\node\node.exe" "$INSTDIR\app\scripts\service.mjs" uninstall --install-dir "$INSTDIR\app"'
!macroend
