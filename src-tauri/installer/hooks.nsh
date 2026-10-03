; Reuse the app's one startup registration when moving from a portable build.
; Leave StartupApproved untouched so a Windows-disabled entry stays disabled.
!macro NSIS_HOOK_PREINSTALL
  ; The main executable now contains the version. Also check the old name before
  ; copying or deleting it so an old running app cannot retain the shortcut.
  !insertmacro CheckIfAppIsRunning "prompt-copilot.exe" "Prompt Copilot"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Prompt Copilot"
  ${If} $0 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Prompt Copilot" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart'
  ${EndIf}
  Pop $0
!macroend

; Remove only a registration belonging to this installation. Keep local data
; and Credential Manager keys for reinstalling the personal app.
!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Prompt Copilot"
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart'
  ${AndIf} $UpdateMode != 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Prompt Copilot"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Prompt Copilot"
  ${EndIf}
  Pop $0
!macroend
