// 회선 끊김 측정의 표(T121). 백엔드 로그의 `[event]` · `[stage]` 줄만 읽는다.
//
//   node load/outage-report.mjs <백엔드 로그> <끊은 대회 id> <끊은 시각 ms> <이은 시각 ms>
//
// 항목은 고정이다 — 실행마다, 수정 전후로 같은 것을 읽어야 비교가 된다.
//   2. 끊긴 동안  서버가 언제 알았고 그 사이 무엇을 진행시켰나
//   3. 돌아온 뒤  게임이 이어지기까지
//   4. 최종 피해  참가자가 잃은 것 (수정의 합격 기준)
//   5. 대조군     다른 대회를 건드렸나, 이 실행을 믿어도 되나
import { readFileSync } from 'node:fs';

const [file, victim, t0s, t1s] = process.argv.slice(2);
const T0 = Number(t0s);
const T1 = Number(t1s);
// 이은 뒤 이만큼까지를 「이 끊김의 일」로 센다 — 딜러의 첫 재접속(최대 50초)과 재개를 덮는다.
const TAIL_MS = 180_000;
const END = T1 + TAIL_MS;

const events = [];
const stages = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const e = line.indexOf('[event] ');
  if (e >= 0) { try { events.push(JSON.parse(line.slice(e + 8))); } catch { /* 잘린 줄 */ } continue; }
  const s = line.indexOf('[stage] ');
  if (s >= 0) { try { stages.push(JSON.parse(line.slice(s + 8))); } catch { /* 잘린 줄 */ } }
}

const sec = (ms) => (ms === null || ms === undefined ? '-' : ((ms - T0) / 1000).toFixed(1));
const after = (ms) => (ms === null || ms === undefined ? '-' : ((ms - T1) / 1000).toFixed(1));
const inWindow = (e) => e.t >= T0 && e.t <= END;
const mine = (e) => e.tournament === victim;
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const min = (xs) => (xs.length ? Math.min(...xs) : null);

const v = events.filter((e) => mine(e) && inWindow(e));
const of = (name, extra = () => true) => v.filter((e) => e.name === name && extra(e));

// ── 2. 끊긴 동안
const dealerGone = of('ws.gone', (e) => e.role === 'dealer' && e.t <= T1 + 30_000);
const seatGone = of('ws.gone', (e) => e.role === 'seat' && e.t <= T1 + 30_000);
const lastDealerGone = max(dealerGone.map((e) => e.t)); // 마지막 딜러가 사라진 시각
// 서버가 안 시각. 대회를 멈춘 기록이 있으면 그것이다 — 딜러 빠른 확인(T121)은 소켓을
// 끊기 전에 침묵만으로 멈춘다. 없으면(수정 전 로그) 마지막 딜러가 사라진 시각이다.
const paused = min(of('tournament.paused', (e) => e.t <= T1 + 30_000).map((e) => e.t));
const detected = paused ?? lastDealerGone;
const folds = of('timeout.fold');
const rebuys = of('rebuy.timeout');
// 셋으로 가른다: 서버가 알기 전 / 안 뒤부터 회선이 돌아올 때까지 / 돌아온 뒤(다시 붙는 중).
const split = (xs) => {
  const known = detected ?? T1;
  return [xs.filter((e) => e.t <= known), xs.filter((e) => e.t > known && e.t <= T1), xs.filter((e) => e.t > Math.max(known, T1))]
    .map((g) => g.length).join(' / ');
};
const victimBefore = events.filter((e) => mine(e) && e.t >= T0 - (END - T0) && e.t < T0);
const lost = (xs) => xs.reduce((sum, e) => sum + (e.lost ?? 0), 0);
const cmdsDown = of('dealer.cmd', (e) => e.t <= T1);

// ── 3. 돌아온 뒤
const back = (role) => of('ws.back', (e) => e.role === role && e.t >= T1).map((e) => e.t);
const tablesOf = (xs) => new Set(xs.map((e) => e.table)).size;
const resumes = of('dealer.cmd', (e) => e.action === 'RESUME_TABLE' && e.t >= T1);
const starts = of('dealer.cmd', (e) => e.action === 'START_PRE_FLOP' && e.t >= T1);

// ── 5. 대조군
const others = events.filter((e) => !mine(e) && inWindow(e) && e.tournament);
const baseline = events.filter((e) => !mine(e) && e.tournament && e.t >= T0 - (END - T0) && e.t < T0);
const count = (xs, name) => xs.filter((e) => e.name === name).length;
const lagIn = stages.filter((s) => { const t = Date.parse(s.t); return t >= T0 && t <= END; });
const lagMax = max(lagIn.map((s) => s.lag?.p99 ?? 0));
const cpuMax = max(lagIn.map((s) => s.cpu ?? 0));

const rows = [
  ['끊은 길이(초)', ((T1 - T0) / 1000).toFixed(0)],
  ['', ''],
  ['[2] 끊긴 동안', ''],
  ['서버가 끊은 딜러 소켓 / 좌석 소켓', `${dealerGone.length} / ${seatGone.length}`],
  ['그중 응답 없어 끊은 것(종료 신호 없이)', `${[...dealerGone, ...seatGone].filter((e) => e.swept).length}`],
  ['첫 딜러가 사라진 시각(끊은 뒤 초)', sec(min(dealerGone.map((e) => e.t)))],
  ['마지막 딜러가 사라진 시각', sec(lastDealerGone)],
  ['서버가 안 시각(대회를 멈춘 시각. 기록이 없으면 위와 같다)', sec(detected)],
  ['시간 초과 폴드: 알기 전 / 안 뒤 / 이은 뒤', split(folds)],
  ['리바인 시간 초과 탈락: 알기 전 / 안 뒤 / 이은 뒤', split(rebuys)],
  ['끊기 직전 같은 길이의 폴드 / 리바인 시간 초과', `${victimBefore.filter((e) => e.name === 'timeout.fold').length} / ${victimBefore.filter((e) => e.name === 'rebuy.timeout').length}`],
  ['끊긴 동안 받은 딜러 명령', `${cmdsDown.length}`],
  ['', ''],
  ['[3] 돌아온 뒤', ''],
  ['마지막 좌석이 붙은 시각(이은 뒤 초)', after(max(back('seat')))],
  ['마지막 딜러가 붙은 시각', after(max(back('dealer')))],
  ['다시 붙은 딜러 테이블 수', `${tablesOf(of('ws.back', (e) => e.role === 'dealer' && e.t >= T1))}`],
  ['딜러 재개: 첫 / 마지막(이은 뒤 초), 테이블 수', `${after(min(resumes.map((e) => e.t)))} / ${after(max(resumes.map((e) => e.t)))}, ${tablesOf(resumes)}`],
  ['첫 핸드 시작(이은 뒤 초)', after(min(starts.map((e) => e.t)))],
  ['', ''],
  ['[4] 최종 피해', ''],
  ['시간 초과 폴드 합계', `${folds.length}`],
  ['그 폴드로 잃은 칩 합계', `${lost(folds)}`],
  ['리바인 시간 초과 탈락 합계', `${rebuys.length}`],
  ['', ''],
  ['[5] 대조군 (다른 세 대회, 같은 구간)', ''],
  ['시간 초과 폴드: 구간 / 직전 같은 길이', `${count(others, 'timeout.fold')} / ${count(baseline, 'timeout.fold')}`],
  ['리바인 시간 초과: 구간 / 직전 같은 길이', `${count(others, 'rebuy.timeout')} / ${count(baseline, 'rebuy.timeout')}`],
  ['끊긴 소켓', `${count(others, 'ws.gone')}`],
  ['핸드 시작: 구간 / 직전 같은 길이', `${others.filter((e) => e.action === 'START_PRE_FLOP').length} / ${baseline.filter((e) => e.action === 'START_PRE_FLOP').length}`],
  ['서버 이벤트 루프 지연 p99 최대(ms) / CPU 최대(%)', `${lagMax ?? '-'} / ${cpuMax ?? '-'}`],
];
for (const [k, val] of rows) console.log(k ? `${k.padEnd(44)} ${val}` : '');
