# Folder picker for the dashboard's "folder" buttons.
#
# Uses the Explorer-style dialog (IFileOpenDialog + FOS_PICKFOLDERS): address bar,
# paste a path, quick access, search. The old FolderBrowserDialog tree was hard to use.
#
# The dialog opens on the monitor of its owner window, so an invisible owner is put
# at the mouse position (the user just clicked the button in the browser). Without it
# the dialog went to the primary monitor, i.e. the other screen on dual setups.
#
# Prints the chosen path as UTF-8 (Korean folder names) or nothing when cancelled.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI codepage.
param([string]$Start = '')

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ModernFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr specs);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem si);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem si, uint hint, out int order);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem si);

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(IntPtr owner, string start, string title) {
    var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try {
        var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        dlg.SetFolder(folder);
      } catch (Exception e) { Console.Error.WriteLine("start folder: " + e.Message); }
    }
    if (dlg.Show(owner) != 0) return null;          // cancelled
    IShellItem result; dlg.GetResult(out result);
    string path; result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
'@

$top = New-Object System.Windows.Forms.Form
$top.TopMost = $true; $top.ShowInTaskbar = $false
$top.StartPosition = 'Manual'; $top.FormBorderStyle = 'None'; $top.Opacity = 0
$top.Size = New-Object System.Drawing.Size(1, 1)
$top.Location = [System.Windows.Forms.Cursor]::Position
$top.Show(); $top.Activate()
try {
  # PowerShell variable names ignore case: a local $start would overwrite the $Start param.
  $initial = ''
  if ($Start -and (Test-Path -LiteralPath $Start -PathType Container)) { $initial = $Start }
  $picked = [ModernFolderPicker]::Pick($top.Handle, $initial, 'Select a project folder')
  if ($picked) { [Console]::Out.Write($picked) }
} finally { $top.Dispose() }
