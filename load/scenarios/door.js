import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Gauge } from 'k6/metrics';
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
 * 다만 그 이유가 "같은 버킷을 나눠 쓴다"는 아니다. `ThrottlerGuard.generateKey`가
 * 컨트롤러 클래스명·핸들러명을 키에 해시하므로(`node_modules/@nestjs/throttler`),
 * `/auth/login` · `/auth/join` · `/dealer/auth`는 IP당 각자 자기 몫의 120을
 * 따로 가진다 — 서로 갉아먹지 않는다. 이 무대에서 진짜로 공유되는 것은
 * "IP 하나"라는 사실 자체다(행사장의 모든 트래픽이 Next 프로세스 하나로
 * 모인다, `throttle.ts`). 그래서 로그인 버킷은 참가자 전원이 실제로 나눠
 * 쓰지만, 회원가입·딜러 인증은 각자 자기 버킷이라 안 섞어도 상관없다.
 * 안 섞는 진짜 이유는 이 도구가 재려는 것이 **로그인 문**(잠금 없이 bcrypt를
 * 태우는 자리)이지 가입 문이 아니라서다 — 가입을 섞으면 다른 버킷을 재는
 * bcrypt.hash 비용만 얹힐 뿐 이 질문에는 신호를 안 보탠다.
 *
 * 실행 (README의 "문(door) — 상한이 실제로 몇 개에서 닫히는가" 절):
 *
 *   # 이 둘은 셸 세션 내내 켜 둔다 — 아래 `run --rm k6 run` 두 줄도
 *   # depends_on으로 backend-load를 다시 조정하므로, 그 호출에 없으면
 *   # 보간이 기본값(100000)으로 풀려 문이 도로 열린다. 실행이 끝나면 반드시
 *   # unset한다 — 안 그러면 같은 셸에서 다음 load:up + 램프가 이 값을 물려받아
 *   # 제품 기본값으로 뜨고, 램프가 자기 자신에게 막힌다(compose 주석의 이유
 *   # 그대로).
 *   export LOAD_THROTTLE_LIMIT=600
 *   export LOAD_THROTTLE_AUTH_LIMIT=120
 *
 *   docker compose -f backend/docker-compose.test.yml --profile load up -d --build
 *   npm run seed:load
 *   docker compose -f backend/docker-compose.test.yml --profile load --profile k6 \
 *     run --rm k6 run -e DOOR_PHASE=boundary /load/scenarios/door.js \
 *     2>&1 | tee load/results/door-boundary-console.log
 *   # 60초 이상 쉰 뒤 — 창이 안 비면 앞 단계가 쓴 버킷이 다음 단계에 섞인다
 *   docker compose -f backend/docker-compose.test.yml --profile load --profile k6 \
 *     run --rm k6 run -e DOOR_PHASE=arrival /load/scenarios/door.js \
 *     2>&1 | tee load/results/door-arrival-console.log
 *
 *   unset LOAD_THROTTLE_LIMIT LOAD_THROTTLE_AUTH_LIMIT
 *
 * `arrival` 단계는 상한을 건 부분지표가 하나라도 FAIL이면 k6가 종료 코드
 * 99로 끝난다 — 크래시가 아니라 "적어도 한 구간은 깨끗하지 않았다"는 정상적인
 * 결과 보고다.
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

/**
 * 무대가 실제로 이 값으로 떠 있어야 한다. 기본 120은 `throttle.ts`의
 * `AUTH_LIMIT` 상수를 손으로 옮겨 적은 값이라 그쪽이 바뀌면 여기도 조용히
 * 어긋날 수 있다 — 그래서 지어내지 않고 첫 성공 응답의 `X-RateLimit-Limit`과
 * 대조한다(`verifyDoorOnce`).
 */
const EXPECT_LIMIT = Number(__ENV.DOOR_EXPECT_LIMIT || 120);

/** 창 하나의 길이. `throttle.ts`의 `WINDOW_MS`와 같은 값이다. */
const WINDOW_MS = 60_000;

/** 상한의 몇 배까지 쏘나. 제품 기본값(분당 120)의 두 배쯤이 기본이다. */
const BOUNDARY_REQUESTS = Number(__ENV.DOOR_BOUNDARY_REQUESTS || 240);

/** 도착률 계단(초당). 기본 1~4 — 분당 120(=초당 2)의 앞뒤를 낀다. */
const ARRIVAL_RATES = (__ENV.DOOR_ARRIVAL_RATES || '1,2,3,4').split(',').map(Number);
/** 구간 하나의 길이. 창(60초)보다 한참 길어야 정착 구간을 떼어내고도 신호가 남는다. */
const ARRIVAL_STAGE_S = Number(__ENV.DOOR_ARRIVAL_STAGE_S || 180);
/**
 * 정착 구간. 지배적인 메커니즘은 개별 히트 만료가 아니라 **블록**이다 —
 * 한도를 넘기면 `ThrottlerStorageService.increment`가 `blockDuration`(설정을
 * 안 하면 `ttl`로 대체되므로 60초) 동안 `isBlocked`를 세우고, 그동안은
 * `totalHits`가 더 안 늘고, 블록이 풀리는 순간 `totalHits`를 0으로 되돌린다
 * (`resetBlockdRequest`). 즉 한 번 걸리면 "마지막 히트로부터 60초"가 아니라
 * "블록이 걸린 시점으로부터 60초"에 카운터가 통째로 리셋된다. 안 걸린
 * 요청들은 히트마다 개별로 60초 뒤 만료되는 원래 방식(`fireHitCount`)을
 * 따른다. 어느 경로든 창보다 긴 65초면 이전 구간의 흔적이 다 빠진다 —
 * 그래서 65초를 판정에서 뺀다(요청 자체는 계속 보낸다 — 도착률을 끊으면
 * 재려는 것 자체가 바뀐다).
 */
const ARRIVAL_SETTLE_S = Number(__ENV.DOOR_ARRIVAL_SETTLE_S || 65);

const TOTAL_ARRIVAL_S = ARRIVAL_RATES.length * ARRIVAL_STAGE_S;
/**
 * 경계 단계의 상한. 요청당 넉넉히 1초를 잡고 60초를 더한다 — 기본값
 * (240건)에서는 그대로 5분이라 예전과 같지만, `DOOR_BOUNDARY_REQUESTS`를
 * 키운 실행이 5분에 조용히 잘리지 않는다.
 */
const BOUNDARY_MAX_DURATION_S = Math.max(300, BOUNDARY_REQUESTS + 60);

export const doorPass = new Counter('door_pass');
export const doorLimited = new Counter('door_limited');
export const doorOther = new Counter('door_other');
/** 첫 상한의 순번. 429 본문과 달리 숫자라 지표에 담아 JSON에 남길 수 있다. */
export const doorFirstLimitIndex = new Gauge('door_first_limit_index');

/**
 * 도착률 단계마다 두 상한을 건다. k6는 태그로 지정한 부분지표를
 * `handleSummary`의 `data.metrics`에 따로 올려 주므로, 구간마다 깨끗했는지를
 * 별도 저장소 없이 그 자리에서 읽을 수 있다.
 *
 * `door_limited==0`만으로는 `isClean()`의 절반만 담는다 — 429가 없어도
 * 통과가 하나도 없으면(계정이 죄다 401, 서버가 죽어 500) 깨끗한 게 아니라
 * **못 잰 것**인데, 그 구간도 `door_limited==0`은 그대로 PASS다. 그래서
 * `door_pass>0`을 나란히 건다 — 어느 한쪽이라도 FAIL이면 그 구간은
 * `isClean()`이 false였다는 뜻이고, 어느 쪽이 FAIL인지로 이유(상한 vs 못 잼)를
 * 가른다.
 */
function stageThresholds() {
  const th = {};
  ARRIVAL_RATES.forEach((rate) => {
    th[`door_limited{stage:rate-${rate}}`] = ['count==0'];
    th[`door_pass{stage:rate-${rate}}`] = ['count>0'];
  });
  return th;
}

export const options = {
  scenarios: {
    door: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: PHASE === 'arrival' ? `${TOTAL_ARRIVAL_S + 120}s` : `${BOUNDARY_MAX_DURATION_S}s`,
    },
  },
  thresholds: PHASE === 'arrival' ? stageThresholds() : {},
};

/** 풀 계정 닉네임. `backend/prisma/seed-load.ts`가 만드는 형식과 같다. */
function poolNickname(i) {
  return `${manifest.accountPrefix}${String(i % manifest.accountPool).padStart(4, '0')}`;
}

/**
 * 응답 헤더에서 이름으로 값을 찾는다. k6가 Go의 `net/http`를 거쳐 넘겨주는
 * 헤더 키는 정규화된 대소문자라 서버가 보낸 그대로("X-RateLimit-Limit")와
 * 다를 수 있다 — 대소문자를 안 가리고 찾는다.
 */
function header(response, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(response.headers || {}).find((k) => k.toLowerCase() === lower);
  return key ? response.headers[key] : undefined;
}

/**
 * 무대가 실제로 `EXPECT_LIMIT`으로 떠 있는지, 이 실행에서 딱 한 번 확인한다.
 *
 * **왜 있어야 하는가**: `ThrottlerGuard`는 요청을 막을 때는(429) 상한 헤더를
 * 안 찍고 `Retry-After`만 찍는다(가드가 `throwThrottlingException`으로
 * 던지고 끝나 버려서 — `throttler.guard.js`의 `handleRequest`). 통과한
 * 응답에만 `X-RateLimit-Limit` · `-Remaining` · `-Reset`이 붙는다. 이 헤더
 * 하나로 이 무대가 열린 문(100000)인지 닫힌 문(120)인지 실제로 구분할 수
 * 있는데, 지금까지는 그 확인을 **사람이 손으로**(`X-RateLimit-Remaining`을
 * curl로 찍어) 했다 — 도구 자신은 안 봤다. 무대가 열린 채로 실행되면 경계
 * 단계는 "429가 한 번도 없었다"만 찍고, 도착률 단계는 네 구간이 전부
 * 깨끗하다고 JSON에 남는다 — 완벽한 모양의 거짓말이다.
 *
 * 첫 **통과** 응답에서만 확인한다(429는 이 헤더가 없다). 어긋나면 즉시
 * 실행을 멈춘다 — 나머지 요청을 계속 쏴 봐야 전부 같은 거짓 전제 위에
 * 선 값이다.
 */
let doorVerified = false;
function verifyDoorOnce(response) {
  if (doorVerified || classify(response) !== 'pass') return;
  doorVerified = true;

  const observed = Number(header(response, 'X-RateLimit-Limit'));
  console.log(`[door] 무대 확인 — X-RateLimit-Limit=${observed} (기대 ${EXPECT_LIMIT})`);
  if (observed !== EXPECT_LIMIT) {
    exec.test.abort(
      `무대가 기대한 상한(${EXPECT_LIMIT})이 아니다 — 관측값 ${observed}. ` +
        'LOAD_THROTTLE_AUTH_LIMIT이 이 compose 호출의 셸에 안 실렸을 수 있다' +
        '(README "문(door)" 절 — export가 셸 세션 전체에 걸쳐 있어야 한다).',
    );
  }
}

/**
 * `lib/api.js`의 `login()`을 쓰지 않는다. 그 함수는 `must()`로 2xx가 아니면
 * `fail()`로 VU를 죽이는데, 이 시나리오는 정확히 그 429를 보려는 것이라
 * 상태 코드와 본문을 그대로 돌려받아야 한다 — 죽이면 다음 요청을 못 쏜다.
 *
 * **카운터를 여기서 올리지 않는다.** 도착률 단계는 정착 구간(꼬리가 섞인
 * 구간)을 뺀 응답만 판정에 써야 하는데, 여기서 무조건 올리면 지표
 * (`door_limited{stage:rate-N}`)에는 정착 구간의 응답까지 들어간다 —
 * 콘솔에 찍는 로컬 판정(`signal`)과 JSON에 남는 판정(`thresholds`)이
 * 서로 다른 데이터를 보고 어긋나게 된다. 그래서 응답만 돌려주고, 셀 것인지는
 * 호출한 쪽이 `recordCount`로 정한다.
 */
function attemptLogin(i, stage) {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ nickname: poolNickname(i), password: manifest.password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { step: 'door-login', stage } },
  );
  const response = { status: res.status, body: res.body, headers: res.headers };
  verifyDoorOnce(response);
  return response;
}

/** 응답 하나를 분류해 그 갈래의 카운터를 올린다. */
function recordCount(response, stage) {
  const kind = classify(response);
  if (kind === 'pass') doorPass.add(1, { stage });
  else if (kind === 'limited') doorLimited.add(1, { stage });
  else doorOther.add(1, { stage });
}

/**
 * 경계 단계 — 60초 창 안에 순차로 쏴 첫 429를 찾는다.
 *
 * `firstLimitIndex`를 "이것이 상한이다"로 읽으려면 전제 둘이 맞아야 한다 —
 * **버킷이 비어서 시작했다**와 **N건이 60초 창 안에 다 들어갔다**. 둘 다
 * 이 함수는 확인하지 않은 채 그냥 가정해 왔다. 앞선 실행의 잔여 히트가
 * 있으면 첫 429가 실제보다 일찍 나오고, 창을 넘겨 버리면 늦게 나온다 —
 * 어느 쪽도 순번이 상한과 같다는 보장을 깬다.
 */
function runBoundary() {
  const start = Date.now();
  const responses = [];
  for (let i = 0; i < BOUNDARY_REQUESTS; i++) {
    const res = attemptLogin(i, 'boundary');

    // 첫 요청으로 "버킷이 비어서 시작했다"를 확인한다. 통과했다면
    // `X-RateLimit-Remaining`이 정확히 `EXPECT_LIMIT - 1`이어야 한다 — 그보다
    // 작으면 이전 실행(또는 같은 IP의 다른 트래픽)의 히트가 이미 들어 있었다는
    // 뜻이다. 아예 429로 시작했다면 그 자체가 더 강한 신호다.
    if (i === 0) {
      const firstKind = classify(res);
      if (firstKind === 'limited') {
        console.log(
          '[door] 경고 — 첫 요청부터 429다. 버킷이 비어서 시작하지 않았다 ' +
            '(이전 실행의 잔여 히트로 보인다). 첫 429 순번은 상한을 안 나타낸다.',
        );
      } else if (firstKind === 'pass') {
        const remaining = Number(header(res, 'X-RateLimit-Remaining'));
        console.log(`[door] 첫 요청 X-RateLimit-Remaining=${remaining} (기대 ${EXPECT_LIMIT - 1})`);
        if (remaining !== EXPECT_LIMIT - 1) {
          console.log(
            '[door] 경고 — 버킷이 비어서 시작하지 않았을 수 있다(잔여값이 기대와 다르다).',
          );
        }
      } else {
        console.log(`[door] 첫 요청이 통과도 429도 아니다(상태 ${res.status}) — 버킷 상태를 확인할 수 없다.`);
      }
    }

    recordCount(res, 'boundary');
    responses.push(res);
  }
  const elapsedMs = Date.now() - start;

  const dist = {};
  responses.forEach((r) => {
    dist[r.status] = (dist[r.status] || 0) + 1;
  });

  const firstLimit = firstLimitIndex(responses);
  if (firstLimit !== null) doorFirstLimitIndex.add(firstLimit);

  // handleSummary는 이 VU의 상태를 못 본다 — `lib/summary.js`가 이미 같은
  // 벽에 부딪혔다("teardown에서 모듈 변수에 담아 두고 handleSummary에서
  // 꺼내려 했는데 비어 있었다"). 429 본문은 이 실행의 결과물이므로 잘라
  // 내지 않고 여기서 그대로 찍는다.
  console.log(`[door] 요청 ${BOUNDARY_REQUESTS}건 · ${elapsedMs}ms · 상태 분포 ${JSON.stringify(dist)}`);
  if (elapsedMs > WINDOW_MS) {
    console.log(
      `[door] 경고 — 실행이 창(${WINDOW_MS}ms)을 넘겼다(${elapsedMs}ms). 뒤쪽 요청은 새 창에서 ` +
        '나간 것일 수 있어 첫 429 순번이 실제 상한보다 늦게 잡혔을 수 있다.',
    );
  }
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
    // **카운터도 같은 조건으로 가른다.** `door_limited{stage:rate-N}`이
    // JSON에 남는 유일한 판정이므로, 여기서 안 가르면 콘솔은 깨끗하다고
    // 찍는데 JSON은 상한에 걸렸다고 남는 어긋남이 생긴다 — 정착 구간의
    // 꼬리 429가 지표에는 그대로 들어가기 때문이다.
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
      if (Date.now() >= settleEnd) {
        recordCount(res, stage);
        signal.push(res);
      }
    }

    // `isClean()`은 이진이지만 false인 이유가 둘이다 — 429가 있었거나(문에
    // 걸렸다), 통과가 하나도 없었거나(계정이 죄다 401, 서버가 죽어 500 등 —
    // **못 잰 것**이다). 콘솔이 이 둘을 가리지 않고 전부 "상한에 걸렸다"로
    // 찍으면, 후자(통과가 하나도 없는데 429도 없는 경우)는 door_limited==0이
    // 그대로 PASS라 JSON은 "깨끗한 도착률"로 남는다 — 정작 아무것도 못 쟀는데.
    // 그래서 세 갈래로 가른다. `door_pass{stage:rate-N}>0` 상한이 JSON에서
    // 이 갈림을 그대로 보여 준다.
    const clean = isClean(signal);
    const limitedSeen = signal.some((r) => classify(r) === 'limited');
    let verdict;
    if (signal.length === 0) {
      // 상한에 걸린 것이 아니라 정착 구간이 구간 길이보다 길다는 설정
      // 실수다 — `isClean([])`은 false이지만 "상한에 걸렸다"로 찍으면
      // 원인을 잘못 가리킨다.
      verdict = '표본 없음(정착 구간이 구간 길이보다 김)';
    } else if (clean) {
      verdict = '깨끗함';
    } else if (limitedSeen) {
      verdict = '상한에 걸렸다';
    } else {
      verdict = '미측정(통과가 하나도 없다 — 계정·비밀번호·서버 상태를 확인해라)';
    }
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

function metricGauge(data, name) {
  const m = data.metrics[name];
  return m && m.values ? m.values.value : null;
}

/**
 * 도착률 단계의 판정은 콘솔 로그와 `thresholds`에 남는다 — 마지막으로
 * `door_limited{stage:rate-N}`과 `door_pass{stage:rate-N}`이 **둘 다** PASS인
 * 구간이 답이다(하나만 보면 `isClean()`의 절반만 보는 것이다).
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
    // 429 본문은 문자열이라 k6 지표에 못 담지만 순번은 숫자다 — 이 실행에서
    // 가장 많이 인용될 값이 콘솔 로그에만 있지 않도록 여기 남긴다.
    firstLimitIndex: metricGauge(data, 'door_first_limit_index'),
    thresholds,
  };

  // "stdout 로그"라고 안 적는다 — k6는 console.log를 표준 에러로 낸다.
  // `2>&1`을 안 붙이고 `tee`한 사람이 "봤는데 없다"로 헤매지 않도록
  // 정확히 가리킨다.
  const line =
    PHASE === 'arrival'
      ? `door-arrival · 구간별 판정 ${JSON.stringify(thresholds)} · 상세는 콘솔 로그(표준 에러)`
      : `door-boundary · 통과 ${summary.pass} · 상한 ${summary.limited} · 그 외 ${summary.other}` +
        ` · 첫 429 ${summary.firstLimitIndex ?? '없음'}번째 · 본문은 콘솔 로그(표준 에러)를 본다`;

  const stamp = at.replace(/[:.]/g, '-');
  return {
    stdout: `\n${line}\n\n`,
    [`/load/results/${name}-${stamp}.json`]: JSON.stringify(summary, null, 2),
    [`/load/results/${name}-latest.json`]: JSON.stringify(summary, null, 2),
  };
}
