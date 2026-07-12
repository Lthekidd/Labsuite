!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VaultSync"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.vaultsync.app"
  Delete "$SMSTARTUP\VaultSync.lnk"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\.txt\ShellNew" "NullFile" ""
  WriteRegStr SHCTX "Software\Classes\.txt\ShellNew" "ItemName" "Text Document"
!macroend
