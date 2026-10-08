// 원시 시계열(k6 --out json)을 단계 태그로 갈라 한 줄씩 낸다.
//
// 요약 하나로는 "터졌다"까지만 알 수 있다. 필요한 것은 언제부터 지연이
// 보이기 시작했고 언제 급해졌는가이고, 그건 단계별로 놓아야 보인다.
//
// **줄 단위로 읽는다**(T113). 예전에는 `readFileSync`로 통째로 읽었는데,
// 1,400테이블 70분 실행의 원시 파일이 2GB라 V8 문자열 상한(약 512MB)에 걸려
// 리포트가 아예 안 나왔다.
//
// 단계 태그(`grow-N` · `steady-N`)의 N은 그 순간 실제로 도는 테이블 수라
// 값이 잘게 갈린다. 100테이블 단위 띠로 묶는다.
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const path = process.argv[2];
if (!path) {
  console.error('사용법: node scripts/load-report.mjs <raw.json>');
  process.exit(1);
}

const WANT = new Set([
  'my_action_ms',
  'dealer_action_ms',
  'others_action_ms',
  'my_action_server_ms',
  'server_lag_p95_ms',
  'server_cpu_percent',
  'server_rss_mb',
]);

/** 지표별 · 띠별 표본 모음 */
const buckets = new Map();
const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row.type !== 'Point' || !WANT.has(row.metric)) continue;
  const m = /^(grow|steady)-(\d+)$/.exec(row.data?.tags?.step ?? '');
  if (!m) continue;
  const band = `${m[1]}-${Math.floor(Number(m[2]) / 100) * 100}`;
  // 딜러 액션은 딜(`deal`)과 승자 입력(`winners`)을 가른다 — 승자 입력이 가장
  // 무거운 경로라 섞으면 묻힌다.
  const metric =
    row.metric === 'dealer_action_ms' && row.data.tags.action
      ? `dealer_${row.data.tags.action}`
      : row.metric;
  const key = `${band} ${metric}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(row.data.value);
}

function pick(values, p) {
  if (!values || values.length === 0) return '-';
  const s = values.sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
}
const max = (values) => (values && values.length ? Math.round(Math.max(...values) * 10) / 10 : '-');

const bands = [...new Set([...buckets.keys()].map((k) => k.split(' ')[0]))].sort((a, b) => {
  const [ka, na] = a.split('-');
  const [kb, nb] = b.split('-');
  return Number(na) - Number(nb) || ka.localeCompare(kb);
});

console.log(
  '띠 | 내액션p95 | 딜p95 | 승자입력p95 | 남의액션p95 | 내액션 서버p95 | 서버lag p95 | CPU 최대 | rss 최대 | 표본',
);
for (const band of bands) {
  const get = (m) => buckets.get(`${band} ${m}`);
  console.log(
    [
      band,
      pick(get('my_action_ms'), 0.95),
      pick(get('dealer_deal'), 0.95),
      pick(get('dealer_winners'), 0.95),
      pick(get('others_action_ms'), 0.95),
      pick(get('my_action_server_ms'), 0.95),
      pick(get('server_lag_p95_ms'), 0.95),
      max(get('server_cpu_percent')),
      max(get('server_rss_mb')),
      (get('my_action_ms') || []).length,
    ].join(' | '),
  );
}
