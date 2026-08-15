// 원시 시계열(k6 --out json)을 단계 태그로 갈라 한 줄씩 낸다.
//
// 요약 하나로는 "터졌다"까지만 알 수 있다. 필요한 것은 언제부터 지연이
// 보이기 시작했고 언제 급해졌는가이고, 그건 단계별로 놓아야 보인다.
import { readFileSync } from 'fs';

const path = process.argv[2];
if (!path) {
  console.error('사용법: node scripts/load-report.mjs <raw.json>');
  process.exit(1);
}

/** 지표별 · 단계별 표본 모음 */
const buckets = new Map();
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row.type !== 'Point' || !row.data || !row.data.tags) continue;
  const step = row.data.tags.step;
  if (!step || !/^(grow|steady)-\d+$/.test(step)) continue;
  const key = `${step} ${row.metric}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(row.data.value);
}

function p95(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length * 0.95)] * 100) / 100;
}

const steps = [...new Set([...buckets.keys()].map((k) => k.split(' ')[0]))].sort((a, b) => {
  const [ka, na] = a.split('-');
  const [kb, nb] = b.split('-');
  return Number(na) - Number(nb) || ka.localeCompare(kb);
});

console.log('단계 | 테이블 | 내액션p95 | 남의액션p95 | 서버lag p95 | 표본');
for (const step of steps) {
  const tables = step.split('-')[1];
  const my = p95(buckets.get(`${step} my_action_ms`));
  const others = p95(buckets.get(`${step} others_action_ms`));
  const lag = p95(buckets.get(`${step} server_lag_p95_ms`));
  const n = (buckets.get(`${step} my_action_ms`) || []).length;
  console.log(`${step} | ${tables} | ${my ?? '-'} | ${others ?? '-'} | ${lag ?? '-'} | ${n}`);
}
