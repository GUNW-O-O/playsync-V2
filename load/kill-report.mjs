// 백엔드를 죽였다 살린 측정의 표. 백엔드 로그의 `[event]` · `[stage]` 줄과
// `RecoveryService`의 「SYNCING 종료」 · 리바인 「미룬다」 줄만 읽는다.
//
//   node load/kill-report.mjs <백엔드 로그> <kill 시각 ms>
//
// 항목은 고정이다 — 실행마다, 수정 전후로 같은 것을 읽어야 비교가 된다.
//   1. 대회 해제  `SYNCING`이 언제 풀렸나 (합격선 300초)
//   2. 기기 복귀  그 해제를 정한 것 — 마지막 기기가 언제 돌아왔나
//   3. 피해      참가자가 잃은 것
//   4. 서버      복구 동안 1코어가 얼마나 찼나
import { readFileSync } from 'node:fs';

const [file, ks] = process.argv.slice(2);
const K = Number(ks);
// 이 안에서 풀리지 않은 대회는 없는 것으로 친다 — 스크립트가 10분에 포기한다. 같은 무대에서
// 이어 잰 회선 끊김(outage-run.sh의 KILL=1)의 정지 · 해제가 섞이지 않게 그 전에서 자른다.
const LIMIT_MS = 600_000;
// 해제 뒤 이만큼까지를 「이 kill의 일」로 센다 — 해제 순간의 몰림(T120)을 덮는다.
const TAIL_MS = 120_000;

const events = [];
const stages = [];
const releases = [];
let deferred = [];
for (const raw of readFileSync(file, 'utf8').split('\n')) {
  const e = raw.indexOf('[event] ');
  if (e >= 0) { try { events.push(JSON.parse(raw.slice(e + 8))); } catch { /* 잘린 줄 */ } continue; }
  const s = raw.indexOf('[stage] ');
  if (s >= 0) { try { stages.push(JSON.parse(raw.slice(s + 8))); } catch { /* 잘린 줄 */ } continue; }
  // Nest 로그의 시각은 초 단위다(컨테이너는 UTC).
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const at = line.match(/(\d+\/\d+\/\d+, \d+:\d+:\d+ [AP]M)/);
  const t = at ? Date.parse(`${at[1]} UTC`) : NaN;
  if (!(t >= K && t <= K + LIMIT_MS)) continue;
  const end = line.match(/SYNCING 종료 \(tournament=([0-9a-f-]+)/);
  if (end) releases.push({ tournament: end[1], t });
  else if (line.includes('리바인') && line.includes('미룬다')) deferred.push(t);
}

const sec = (ms) => (ms === null || ms === undefined ? '-' : ((ms - K) / 1000).toFixed(1));
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const dist = (xs) => `${xs.length}대, 중앙 ${sec(q(xs, 0.5))} · p90 ${sec(q(xs, 0.9))} · 최대 ${sec(max(xs))}`;

const lineDown = events.filter((e) => e.name === 'tournament.paused' && e.t >= K).map((e) => e.t);
const LIMIT = Math.min(K + LIMIT_MS, ...lineDown);

// 대회 하나에 해제가 둘이면(다시 멈췄다 풀렸다) 마지막 것이다.
const released = new Map();
for (const r of releases.filter((x) => x.t < LIMIT)) released.set(r.tournament, r.t);
const ts = [...released.values()];
const R = max(ts) ?? LIMIT;
const END = R + TAIL_MS;

const back = (role) => events.filter((e) => e.name === 'ws.back' && e.role === role && e.t >= K && e.t <= R).map((e) => e.t);
// 가장 큰 대회 — 해제를 정하는 것은 기기가 가장 많은 대회다.
const seatsOf = new Map();
for (const e of events) if (e.name === 'ws.back' && e.role === 'seat' && e.t >= K && e.t <= R) seatsOf.set(e.tournament, (seatsOf.get(e.tournament) ?? 0) + 1);
const [biggest, biggestSeats] = [...seatsOf.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

const count = (name, from, to) => events.filter((e) => e.name === name && e.t >= from && e.t <= to).length;
const lagIn = stages.filter((s) => { const t = Date.parse(s.t); return t >= K && t <= END; });

const rows = [
  ['[1] 대회 해제', ''],
  ['풀린 대회 수', `${released.size}`],
  ['해제 시각(kill 뒤 초): 최소 / 중앙 / 최대', `${sec(Math.min(...ts))} / ${sec(q(ts, 0.5))} / ${sec(max(ts))}`],
  ['가장 큰 대회(좌석 기기 수)의 해제', `${sec(released.get(biggest))} (${biggestSeats ?? 0}대)`],
  ['', ''],
  ['[2] 기기 복귀 (kill 뒤 초)', ''],
  ['좌석', dist(back('seat'))],
  ['딜러', dist(back('dealer'))],
  ['', ''],
  ['[3] 피해', ''],
  ['시간 초과 폴드: kill부터 마지막 해제까지 / 해제 뒤 120초', `${count('timeout.fold', K, R)} / ${count('timeout.fold', R + 1, END)}`],
  ['리바인 시간 초과 탈락 (해제 뒤 120초까지)', `${count('rebuy.timeout', K, END)}`],
  ['리바인 미룸 (DB 일시 실패, T118)', `${deferred.filter((t) => t <= END).length}`],
  ['', ''],
  ['[4] 서버 (kill부터 해제 뒤 120초까지)', ''],
  ['이벤트 루프 지연 p99 최대(ms) / CPU 최대(%)', `${max(lagIn.map((s) => s.lag?.p99 ?? 0)) ?? '-'} / ${max(lagIn.map((s) => s.cpu ?? 0)) ?? '-'}`],
];
for (const [k, val] of rows) console.log(k ? `${k.padEnd(44)} ${val}` : '');
