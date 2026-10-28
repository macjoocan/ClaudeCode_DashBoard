'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPreview } = require('../studio-preview');

test('real Chromium renders, selects, crops and builds an AI request for a local development page',
  { skip: process.env.CC_STUDIO_BROWSER_TEST !== '1', timeout: 45000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-studio-browser-'));
    const preview = createPreview({ stateDir: dir });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><style>body{margin:0;height:1800px}button{position:absolute;left:40px;top:40px;width:200px;height:70px;background:rgb(12,34,56)}#later{top:1000px}</style><button id="hello">Hello studio</button><button id="later">Below fold</button>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { preview.close(); server.close(); /* Chrome may still hold profile files while shutting down. */ });
    const shot = await preview.navigate('test', `http://127.0.0.1:${server.address().port}/`);
    assert.match(shot.image, /^data:image\/png;base64,/);
    const pick = await preview.act('test', { action: 'pick', x: 80, y: 70 });
    assert.equal(pick.selection.selector, 'button#hello');
    assert.match(pick.selection.html, /Hello studio/);
    assert.equal(pick.selection.css['background-color'], 'rgb(12, 34, 56)');
    const png = Buffer.from(pick.image.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 200); assert.equal(png.readUInt32BE(20), 70);
    const request = preview.message('test', pick.id, 'Make this accessible');
    assert.match(request, /Make this accessible/); assert.match(request, /HTML:/); assert.match(request, /\.png/);
    assert.throws(() => preview.message('other-task', pick.id, 'Wrong task'), /만료/);
    await preview.act('test', { action: 'scroll', delta: 700 });
    const lower = await preview.act('test', { action: 'pick', x: 80, y: 320 });
    assert.equal(lower.selection.selector, 'button#later');
    const crop = Buffer.from(lower.image.split(',')[1], 'base64');
    assert.equal(crop.readUInt32BE(16), 200); assert.equal(crop.readUInt32BE(20), 70);
    await preview.release('test');
  });
