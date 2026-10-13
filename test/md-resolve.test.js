'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveMarkdownPath } = require('../md-resolve');

test('Windows에서 Git Bash 경로와 file URL을 같은 실제 문서로 해석한다', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-md-link-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const actual = path.join(base, '한글 문서.md');
  fs.writeFileSync(actual, '# test');
  const slash = actual.replace(/\\/g, '/');
  const bash = '/' + slash[0].toLowerCase() + slash.slice(2);
  assert.equal(resolveMarkdownPath('/' + slash, __dirname).full, actual);
  assert.equal(resolveMarkdownPath(bash, __dirname).full, actual);
  assert.equal(resolveMarkdownPath(require('node:url').pathToFileURL(actual).href, __dirname).full, actual);
});

test('터미널 시작 폴더 밖의 프로젝트 작업 트리에서도 상대 문서 경로를 찾는다', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-md-resolve-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dashboard = path.join(base, 'dashboard');
  const project = path.join(base, 'CoinTrade');
  const worktree = path.join(project, '.worktrees', 'orderflow-offline');
  const relative = 'docs/superpowers/specs/2026-09-27-orderflow-paper-forward-validation-design.md';
  const actual = path.join(worktree, ...relative.split('/'));
  fs.mkdirSync(dashboard);
  fs.mkdirSync(path.dirname(actual), { recursive: true });
  fs.writeFileSync(actual, '# design');
  const result = resolveMarkdownPath(relative, dashboard, [dashboard, project]);
  assert.equal(result.full, actual);
  assert.equal(result.file, path.basename(actual));
});

test('터미널 시작 폴더에 같은 문서가 있으면 그 파일을 우선한다', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-md-resolve-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'dashboard');
  const project = path.join(base, 'project');
  const relative = path.join('docs', 'spec.md');
  const direct = path.join(cwd, relative);
  const other = path.join(project, '.worktrees', 'branch', relative);
  fs.mkdirSync(path.dirname(direct), { recursive: true });
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(direct, 'dashboard');
  fs.writeFileSync(other, 'worktree');
  assert.equal(resolveMarkdownPath(relative, cwd, [project]).full, direct);
});

test('여러 작업 트리에 같은 상대 경로가 있으면 임의로 고르지 않는다', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-md-resolve-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'dashboard');
  const project = path.join(base, 'project');
  fs.mkdirSync(cwd);
  for (const name of ['branch-a', 'branch-b']) {
    const target = path.join(project, '.worktrees', name, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, name);
  }
  assert.throws(() => resolveMarkdownPath('docs/spec.md', cwd, [project]), /여러 작업 폴더/);
});
