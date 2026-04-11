' launch.vbs - starts AI Medical Scribe with no console window
' Task Scheduler calls: wscript.exe "path\to\launch.vbs"
' Uses WScript.ScriptFullName so it works from any install location.

Dim fso, shell, installDir

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

installDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = installDir

' Run npm start (electron .) with window hidden (0 = no window, False = don't wait)
shell.Run "cmd /c npm start", 0, False

Set shell = Nothing
Set fso   = Nothing
