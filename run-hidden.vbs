' Start the launcher server with no console window (for the Startup folder).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists("node_modules\node-pty") Then
  sh.Run "cmd /c npm install --no-audit --no-fund", 0, True
End If
sh.Run "node server.js", 0, False
