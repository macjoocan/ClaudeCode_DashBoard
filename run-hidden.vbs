' Start the launcher server with no console window (for the Startup folder).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If ServerUp("http://127.0.0.1:7788/api/health") Or ServerUp("http://127.0.0.1:7788/") Then WScript.Quit 0
If Not fso.FolderExists("node_modules\node-pty") Then
  sh.Run "cmd /c npm install --no-audit --no-fund", 0, True
End If
sh.Run "node server.js", 0, False

Function ServerUp(u)
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then Exit Function
  http.setTimeouts 800, 800, 1500, 1500
  http.open "GET", u, False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 And (InStr(1, http.responseText, "cc-launcher", 1) > 0 Or InStr(1, http.responseText, "AI 코딩 세션 런처", 1) > 0) Then ServerUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
