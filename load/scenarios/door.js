import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { classify, firstLimitIndex, isClean } from '../lib/door.js';

/**
 * 로그인 문 — `backend/src/auth/throttle.ts`의 인증 상한이 실제로 몇
 * 요청에서 닫히는가.
 *
 * 소켓을 열지 않는다. 재는 것이 `POST /auth/login` 하나이고 테이블도 게임도
 * 필요 없다. 이 실행만 무대를 **제품 기본값**으로 띄운다(분당 600 / 인증
 * 120) — 나머지 램프·스모크는 상한을 올린 무대에서 도는데, 그 무대에서는
 * 이 질문 자체가 성립하지 않는다(`backend/docker-compose.test.yml`).
 *
 * **단계 둘을 한 실행에 담지 않는다.** 창이 60초라 앞 단계가 다음 단계의
 * 버킷을 오염시킨다. `DOOR_PHASE`로 어느 쪽을 돌릴지 고르고, 둘을 이어서
 * 돌리려면 사이에 창(60초 이상)이 비도록 쉰다.
 *
 *   DOOR_PHASE=boundary (기본)  60초 창 안에 로그인 N건을 순차로 쏴 첫 429를 찾는다
 *   DOOR_PHASE=arrival          초당 도착률을 계단으로 올리며 구간마다 깨끗한지 본다
 *
 * 계정은 시드 풀에서만 쓴다(`.load-seed.json`). **신규 가입을 섞지 않는다** —
 * `POST /auth/join`도 같은 버킷이라, 섞으면 무엇이 문을 채웠는지 갈리지
 * 않는다.
 *
 * 실행 (README의 "문(door) — 상한이 실제로 몇 개에서 닫히는가" 절):
 *
 *   LOAD_THROTTLE_LIMIT=600 LOAD_THROTTLE_AUTH_LIMIT=120 \
 *     docker compose -f backend/docker-compose.test.yml --profile load up -d --build
 *   npm run seed:load
 *   docker compose -f backend/docker-compose.test.yml --profile load --profile k6 \
 *     run --rm k6 run -e DOOR_PHASE=boundary /load/scenarios/door.js
 *   # 60초 이상 쉰 뒤
 *   docker compose -f backend/docker-compose.test.yml --profile load --profile k6 \
 *     run --rm k6 run -e DOOR_PHASE=arrival /load/scenarios/door.js
 */

/**
 * 매니페스트는 `SharedArray`로 읽는다 — `ramp.js`와 같은 이유다. `JSON.parse`가
 * VU마다 다시 돌면 안 된다. 이 시나리오는 VU가 하나뿐이라 램프만큼 절실하진
 * 않지만, 선례를 갈라 쓸 이유가 없다.
 */
const manifest = new SharedArray('load-seed', () => [
  JSON.parse(open('/load/.load-seed.json')),
])[0];

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3001';
const PHASE = __ENV.DOOR_PHASE || 'boundary';

/** 상한의 몇 배까지 쏘나. 제품 기본값(분당 120)의 두 배쯤이 기본이다. */
const BOUNDARY_REQUESTS = Number(__ENV.DOOR_BOUNDARY_REQUESTS || 240);

/** 도착률 계단(초당). 기본 1~4 — 분당 120(=초당 2)의 앞뒤를 낀다. */
const ARRIVAL_RATES = (__ENV.DOOR_ARRIVAL_RATES || '1,2,3,4').split(',').map(Number);
/** 구간 하나의 길이. 창(60초)보다 한참 길어야 정착 구간을 떼어내고도 신호가 남는다. */
const ARRIVAL_STAGE_S = Number(__ENV.DOOR_ARRIVAL_STAGE_S || 180);
/**
 * 정착 구간. `ThrottlerStorageService.increment`는 고정 창이 아니라 히트마다
 * 개별로 60초 뒤 만료되는 타이머를 건다(`fireHitCount`) — 진짜 슬라이딩
 * 윈도다. 그래서 도착률을 올린 직후 최대 60초는 이전 구간의 꼬리가 섞인
 * 값이다. 창보다 긴 65초를 판정에서 뺀다(요청 자체는 계속 보낸다 — 도착률을
 * 끊으면 재려는 것 자체가 바뀐다).
 */
const ARRIVAL_SETTLE_S = Number(__ENV.DOOR_ARRIVAL_SETTLE_S || 65);

const TOTAL_ARRIVAL_S = ARRIVAL_RATES.length * ARRIVAL_STAGE_S;

export const doorPass = new Counter('door_pass');
export const doorLimited = new Counter('door_limited');
export const doorOther = new Counter('door_other');

/**
 * 도착률 단계마다 `door_limited{stage:rate-N}`에 상한을 건다. k6는 이렇게
 * 태그로 지정한 부분지표를 `handleSummary`의 `data.metrics`에 따로 올려
 * 주므로, 구간마다 깨끗했는지를 별도 저장소 없이 그 자리에서 읽을 수 있다.
 */
function stageThresholds() {
  const th = {};
  ARRIVAL_RATES.forEach((rate) => {
    th[`door_limited{stage:rate-${rate}}`] = ['count==0'];
  });
  return th;
}

export const options = {
  scenarios: {
    door: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: PHASE === 'arrival' ? `${TOTAL_ARRIVAL_S + 120}s` : '5m',
    },
  },
  thresholds: PHASE === 'arrival' ? stageThresholds() : {},
};

/** 풀 계정 닉네임. `backend/prisma/seed-load.ts`가 만드는 형식과 같다. */
function poolNickname(i) {
  return `${manifest.accountPrefix}${String(i % manifest.accountPool).padStart(4, '0')}`;
}

/**
 * `lib/api.js`의 `login()`을 쓰지 않는다. 그 함수는 `must()`로 2xx가 아니면
 * `fail()`로 VU를 죽이는데, 이 시나리오는 정확히 그 429를 보려는 것이라
 * 상태 코드와 본문을 그대로 돌려받아야 한다 — 죽이면 다음 요청을 못 쏜다.
 */
function attemptLogin(i, stage) {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ nickname: poolNickname(i), password: manifest.password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { step: 'door-login', stage } },
  );
  const response = { status: res.status, body: res.body };

  const kind = classify(response);
  if (kind === 'pass') doorPass.add(1, { stage });
  else if (kind === 'limited') doorLimited.add(1, { stage });
  else doorOther.add(1, { stage });

  return response;
}

/** 경계 단계 — 60초 창 안에 순차로 쏴 첫 429를 찾는다. */
function runBoundary() {
  const responses = [];
  for (let i = 0; i < BOUNDARY_REQUESTS; i++) {
    responses.push(attemptLogin(i, 'boundary'));
  }

  const dist = {};
  responses.forEach((r) => {
    dist[r.status] = (dist[r.status] || 0) + 1;
  });

  const firstLimit = firstLimitIndex(responses);

  // handleSummary는 이 VU의 상태를 못 본다 — `lib/summary.js`가 이미 같은
  // 벽에 부딪혔다("teardown에서 모듈 변수에 담아 두고 handleSummary에서
  // 꺼내려 했는데 비어 있었다"). 429 본문은 이 실행의 결과물이므로 잘라
  // 내지 않고 여기서 그대로 찍는다.
  console.log(`[door] 요청 ${BOUNDARY_REQUESTS}건 · 상태 분포 ${JSON.stringify(dist)}`);
  if (firstLimit !== null) {
    console.log(`[door] 첫 429 — ${firstLimit}번째. 본문: ${responses[firstLimit - 1].body}`);
  } else {
    console.log(`[door] ${BOUNDARY_REQUESTS}건 안에 429가 한 번도 없었다`);
  }
}

/** 도착률 단계 — 계단을 올리며 구간마다 깨끗했는지를 기록한다. */
function runArrival() {
  let i = 0;

  ARRIVAL_RATES.forEach((rate) => {
    const stage = `rate-${rate}`;
    const intervalMs = 1000 / rate;
    const stageStart = Date.now();
    const stageEnd = stageStart + ARRIVAL_STAGE_S * 1000;
    const settleEnd = stageStart + ARRIVAL_SETTLE_S * 1000;

    // 정착 구간(이전 구간의 슬라이딩 윈도 꼬리) 뒤에 온 응답만 판정에 쓴다.
    const signal = [];
    let n = 0;
    while (Date.now() < stageEnd) {
      // 다음 예정 시각까지 잰다 — `sleep(간격)`을 매번 고정으로 부르면 요청
      // 자체에 걸리는 시간만큼 누적으로 밀린다.
      const wait = stageStart + n * intervalMs - Date.now();
      if (wait > 0) sleep(wait / 1000);

      const res = attemptLogin(i, stage);
      i += 1;
      n += 1;
      if (Date.now() >= settleEnd) signal.push(res);
    }

    const clean = isClean(signal);
    // 표본이 0건이면 상한에 걸린 것이 아니라 정착 구간이 구간 길이보다
    // 길다는 설정 실수다 — `isClean([])`은 false이지만 "상한에 걸렸다"로
    // 찍으면 원인을 잘못 가리킨다.
    const verdict = signal.length === 0 ? '표본 없음(정착 구간이 구간 길이보다 김)' : clean ? '깨끗함' : '상한에 걸렸다';
    console.log(
      `[door] 구간 ${stage} — 표본 ${signal.length}건(정착 ${ARRIVAL_SETTLE_S}s 제외) · ${verdict}`,
    );
  });
}

export default function () {
  if (PHASE === 'arrival') runArrival();
  else runBoundary();
}

function metricCounter(data, name) {
  const m = data.metrics[name];
  return m && m.values ? m.values.count : 0;
}

/**
 * 도착률 단계의 판정은 콘솔 로그와 `thresholds`에 남는다 — 마지막으로
 * `PASS`인 `door_limited{stage:rate-N}`가 답이다.
 */
export function handleSummary(data) {
  const name = `door-${PHASE}`;
  const at = new Date().toISOString();

  const thresholds = {};
  Object.keys(data.metrics).forEach((metric) => {
    const th = data.metrics[metric].thresholds;
    if (!th) return;
    Object.keys(th).forEach((expr) => {
      thresholds[`${metric}:${expr}`] = th[expr].ok === false ? 'FAIL' : 'PASS';
    });
  });

  const summary = {
    name,
    at,
    phase: PHASE,
    pass: metricCounter(data, 'door_pass'),
    limited: metricCounter(data, 'door_limited'),
    other: metricCounter(data, 'door_other'),
    thresholds,
  };

  const line =
    PHASE === 'arrival'
      ? `door-arrival · 구간별 판정 ${JSON.stringify(thresholds)} · 상세는 stdout 로그`
      : `door-boundary · 통과 ${summary.pass} · 상한 ${summary.limited} · 그 외 ${summary.other}` +
        ' · 첫 429 순번과 본문은 stdout 로그를 본다';

  const stamp = at.replace(/[:.]/g, '-');
  return {
    stdout: `\n${line}\n\n`,
    [`/load/results/${name}-${stamp}.json`]: JSON.stringify(summary, null, 2),
    [`/load/results/${name}-latest.json`]: JSON.stringify(summary, null, 2),
  };
}
