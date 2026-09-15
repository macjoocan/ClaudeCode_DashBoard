// Codex 사용량과 계정 한도를 rollout JSONL 에서 읽는다.
//
// Codex 는 token_count 이벤트에 두 종류의 정보를 함께 기록한다.
//   - info.last_token_usage: 방금 응답의 토큰 수
//   - rate_limits: 현재 계정의 시간 창별 사용률과 리셋 시각
//
// 이 파일 형식은 공개 API 계약이 아니므로 모든 진입점은 실패를 정상 상태로 다룬다.
// Claude 지표와 결합하는 쪽에서 Codex 부분만 숨길 수 있도록 예외를 밖으로 던지지 않는다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WIN5H_MS = 5 * 60 * 60 * 1000;
const TAIL_START = 2 * 1024 * 1024;
const TAIL_MAX = 32 * 1024 * 1024;
const LIMIT_TAIL = 512 * 1024;
const CACHE_MAX = 400;

const entryCache = new Map(); // file -> {mtimeMs,size,entries}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), start, size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function usageFromTokenCount(j) {
  if (j?.payload?.type !== 'token_count') return null;
  const u = j?.payload?.info?.last_token_usage;
  const at = Date.parse(j?.timestamp || '');
  if (!u || typeof u !== 'object' || !Number.isFinite(at)) return null;

  const inAll = num(u.input_tokens);
  const cacheRead = num(u.cached_input_tokens);
  const cacheWrite = num(u.cache_write_input_tokens);
  const output = num(u.output_tokens);
  const input = Math.max(0, inAll - cacheRead - cacheWrite);
  return {
    at, input, output, cacheWrite, cacheRead,
    thinking: num(u.reasoning_output_tokens),
    total: input + output + cacheWrite + cacheRead,
    // 같은 누계 스냅샷이 반복 기록된 경우 방금 사용량을 두 번 세지 않는다.
    snapshot: JSON.stringify(j?.payload?.info?.total_token_usage || null),
  };
}

function parseUsageEntries(text, skipFirst) {
  const out = [];
  const seen = new Set();
  const lines = String(text || '').split('\n');
  if (skipFirst) lines.shift();
  for (const line of lines) {
    if (!line || line.indexOf('"token_count"') < 0 || line.indexOf('"last_token_usage"') < 0) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const e = usageFromTokenCount(j);
    if (!e || e.total <= 0) continue;
    if (e.snapshot !== 'null' && seen.has(e.snapshot)) continue;
    if (e.snapshot !== 'null') seen.add(e.snapshot);
    out.push(e);
  }
  return out;
}

function entriesFromFile(file, cutoff) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const hit = entryCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entries;

  let want = Math.min(TAIL_START, stat.size);
  let entries = [];
  while (true) {
    const r = readTail(file, want);
    if (!r) break;
    entries = parseUsageEntries(r.text, r.start > 0);
    const oldest = entries.reduce((v, e) => Math.min(v, e.at), Infinity);
    if (!(oldest > cutoff && r.start > 0 && want < TAIL_MAX)) break;
    want = Math.min(want * 4, TAIL_MAX, stat.size);
  }

  if (entryCache.size > CACHE_MAX) entryCache.clear();
  entryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries;
}

function emptyBucket() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    thinking: 0, cache1h: 0, cache5m: 0, total: 0, calls: 0 };
}

function addTo(b, e) {
  b.input += e.input;
  b.output += e.output;
  b.cacheWrite += e.cacheWrite;
  b.cacheRead += e.cacheRead;
  b.thinking += e.thinking;
  b.total += e.total;
  b.calls++;
}

function validRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const file = row && row.rolloutPath ? path.resolve(row.rolloutPath) : '';
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    out.push({ id: row.id || null, cwd: row.cwd || null, file, stat });
  }
  return out;
}

function usage(rows, nowMs) {
  const t0 = Date.now();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.getTime();
  const winStart = now - WIN5H_MS;
  const cutoff = Math.min(dayStart, winStart);
  const files = validRows(rows).filter(x => x.stat.mtimeMs >= cutoff);

  const today = emptyBucket();
  const win5h = emptyBucket();
  const sessions = [];
  let count = 0;
  let bytes = 0;
  for (const f of files) {
    bytes += f.stat.size;
    const sb = emptyBucket();
    for (const e of entriesFromFile(f.file, cutoff)) {
      if (e.at >= dayStart && e.at <= now) { addTo(today, e); addTo(sb, e); }
      if (e.at >= winStart && e.at <= now) addTo(win5h, e);
      count++;
    }
    if (sb.calls) sessions.push({ sessionId: f.id, cwd: f.cwd, ...sb });
  }

  sessions.sort((a, b) => b.total - a.total);
  return {
    provider: 'codex', at: now, today, win5h,
    models: today.calls ? [{ model: 'Codex', ...today }] : [],
    sessions: sessions.slice(0, 8), win5hStart: winStart, dayStart,
    scanned: { files: files.length, bytes, ms: Date.now() - t0, entries: count },
  };
}

function planName(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'prolite' || key === 'pro') return 'Pro';
  if (key === 'team') return 'Team';
  if (key === 'plus') return 'Plus';
  if (!key) return null;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function windowLabel(minutes, fallback) {
  if (minutes === 300) return '5시간 세션';
  if (minutes === 10080) return '주간';
  if (minutes > 0 && minutes % 1440 === 0) return (minutes / 1440) + '일';
  if (minutes > 0 && minutes % 60 === 0) return (minutes / 60) + '시간';
  return fallback;
}

function gauge(window, fallback, active) {
  if (!window || typeof window.used_percent !== 'number') return null;
  const seconds = Number(window.resets_at);
  return {
    label: windowLabel(Number(window.window_minutes), fallback),
    percent: Math.round(window.used_percent * 10) / 10,
    resetsAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
    active: !!active,
    model: null,
  };
}

function parseRateLimits(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"rate_limits"') < 0 || line.indexOf('"token_count"') < 0) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const r = j?.payload?.rate_limits;
    if (!r || typeof r !== 'object') continue;
    const gauges = [
      gauge(r.primary, '기본 한도', r.rate_limit_reached_type === 'primary'),
      gauge(r.secondary, '보조 한도', r.rate_limit_reached_type === 'secondary'),
      gauge(r.individual_limit, r.limit_name || '개별 한도', r.rate_limit_reached_type === 'individual'),
    ].filter(Boolean);
    if (!gauges.length && r.rate_limit_reached_type) {
      gauges.push({
        label: r.limit_name || r.limit_id || '사용 한도',
        percent: 100,
        resetsAt: null,
        active: true,
        model: null,
      });
    }
    if (!gauges.length) continue;
    const at = Date.parse(j.timestamp || '');
    return {
      plan: planName(r.plan_type), subscription: r.plan_type || null, tier: r.limit_id || null,
      gauges,
      credits: r.credits && typeof r.credits === 'object' ? {
        hasCredits: !!r.credits.has_credits,
        unlimited: !!r.credits.unlimited,
        balance: r.credits.balance == null ? null : String(r.credits.balance),
      } : null,
      reached: r.rate_limit_reached_type || null,
      extra: null,
      at: Number.isFinite(at) ? at : Date.now(),
      source: 'local-rollout',
    };
  }
  return null;
}

function limits(rows) {
  const files = validRows(rows).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const f of files.slice(0, 20)) {
    const r = readTail(f.file, LIMIT_TAIL);
    const data = r && parseRateLimits(r.text);
    if (data) return { ok: true, data };
  }
  return { ok: false, reason: 'Codex 한도 기록을 찾지 못했습니다', noData: true };
}

module.exports = { usageFromTokenCount, parseUsageEntries, usage, parseRateLimits, limits,
  planName, windowLabel };
