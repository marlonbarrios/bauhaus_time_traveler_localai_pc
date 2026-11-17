' Double-click this, or the desktop shortcut, to open the piece in a Chrome window with no browser bars.
Set sh = CreateObject("Wscript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\Open-Bauhaus-Chrome.ps1""", 0, False
