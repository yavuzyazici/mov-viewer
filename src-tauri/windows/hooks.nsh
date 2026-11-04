; Atak Viewer installer hooks (bundle.windows.nsis.installerHooks).
;
; 0.1.0 shipped the bundled FFmpeg as ffmpeg.exe; since 0.2.0 it is atak-ffmpeg.exe, and installers
; only replace the files they know, so the old 126 MB copy stayed behind. Remove it on install
; (upgrades) and on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\ffmpeg.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\ffmpeg.exe"
  ; Only removes the folder if nothing else is left in it.
  RMDir "$INSTDIR"
!macroend
