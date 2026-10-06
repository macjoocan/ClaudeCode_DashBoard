'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Explorer copies a FileDropList, which browsers do not always expose as Files.
// Read only when the user explicitly pastes. Never modify the clipboard.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })',
  'ConvertTo-Json -InputObject $paths -Compress',
].join('\n');

function readClipboardFiles(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return Promise.resolve({ files: [], skipped: 0 });
  const run = options.execFile || execFile;
  const stat = options.stat || fs.statSync;
  return new Promise((resolve, reject) => {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error('Windows 파일 클립보드를 읽지 못했습니다'));
        try {
          const paths = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
          if (!Array.isArray(paths)) throw new Error('invalid file list');
          const files = []; let skipped = 0;
          for (const p of paths) {
            try {
              if (typeof p !== 'string' || !path.win32.isAbsolute(p) || /[\x00-\x1f]/.test(p)) throw new Error('invalid path');
              const s = stat(p);
              if (!s.isFile()) throw new Error('not a file');
              files.push({ path: p, bytes: s.size });
            } catch { skipped++; }
          }
          resolve({ files, skipped });
        } catch { reject(new Error('Windows 파일 클립보드 응답을 읽지 못했습니다')); }
      });
  });
}
module.exports = { readClipboardFiles };
