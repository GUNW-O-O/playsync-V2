import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { createTableWithRetry, login, startTournament } from '../lib/api.js';
import { sample, stepLabel as monitorLabel } from '../lib/monitor.js';
import { buildSummary } from '../lib/summary.js';
import { runHands, seatPlayers } from '../lib/table.js';

/**
 * 성장 램프 — 붙은 테이블은 내려가지 않는다.
 *
 * 답하려는 것이 둘이다. **동시접속을 어디까지 받나**(고원 구간)와 **몰림을
 * 어디까지 견디나**(증설 구간). 둘은 같은 실행의 다른 구간이라 태그로 가른다.
 *
 * 계단 램프(단계마다 세우고 재고 내린다)를 버린 이유: 재는 것이 "N테이블의
 * 부하"가 아니라 "N테이블을 세우는 비용"이 된다.
 *
 *   LOAD_TABLES_PER_STORE 미설정 → 램프 B. 대회 하나 안에서 테이블을 늘린다
 *                                  (`SEAT_LIST_UPDATED`의 O(T²) 곡선)
 *   LOAD_TABLES_PER_STORE=6      → 램프 A. 6테이블마다 다음 대회로 넘어간다
 *                                  ("홀덤펍이 하나 더 생겼다")
 */

const manifest = JSON.parse(open('/load/.load-seed.json'));

const SEAT_COUNT = 9;
const START_TABLES = Number(__ENV.LOAD_START_TABLES || 4);
const STEP_TABLES = Number(__ENV.LOAD_STEP_TABLES || 2);
const MAX_TABLES = Number(__ENV.LOAD_MAX_TABLES || 66);
/** 한 단계를 늘리는 데 주는 시간. 증설 자체가 몰림이라 짧을수록 험한 부하다. */
const GROW_S = Number(__ENV.LOAD_GROW_S || 30);
/** 고원. 핸드 하나가 약 2분이라 그보다 짧으면 딜링 대기만 잡는 단계가 생긴다. */
const STEADY_S = Number(__ENV.LOAD_STEADY_S || 180);
/** 0이면 램프 B(전부 한 대회). 6이면 램프 A. */
const TABLES_PER_STORE = Number(__ENV.LOAD_TABLES_PER_STORE || 0);
const NAME = __ENV.LOAD_RAMP_NAME || (TABLES_PER_STORE > 0 ? 'ramp-a' : 'ramp-b');

/** 사용자가 "이거 왜 이래"라고 말하는 지점. HCI 응답 한계의 1초다. */
const MY_ACTION_ABORT_MS = Number(__ENV.LOAD_MY_ACTION_ABORT_MS || 1000);
const ABORT_STREAK = Number(__ENV.LOAD_BREACH_STREAK || 2);

/**
 * 재접속 폭발을 일으킬 테이블 수. 그 단계의 고원 중간에 전원이 끊었다 붙는다.
 * 0이면 하지 않는다.
 */
const RECONNECT_AT_TABLES = Number(__ENV.LOAD_RECONNECT_AT_TABLES || 0);

/**
 * 테이블이 아닌 VU 수. 모니터 하나다. 단계 라벨에서 빼야 라벨의 숫자가
 * 곧 테이블 수가 된다.
 */
const NON_TABLE_VUS = 1;

/** 테이블 생성이 409로 거절된 횟수. 상점 콘솔에서는 안 보이는 값이다. */
export const tableCreateConflicts = new Counter('table_create_conflicts');
/** 한 VU가 자기 테이블을 열고 좌석 아홉을 채우는 데 걸린 시간. 증설 비용이다. */
export const tableSetupMs = new Trend('table_setup_ms', true);

function stages() {
  const out = [];
  for (let n = START_TABLES; n <= MAX_TABLES; n += STEP_TABLES) {
    out.push({ target: n, duration: `${GROW_S}s` });
    out.push({ target: n, duration: `${STEADY_S}s` });
  }
  return out;
}

const RAMP_STAGES = stages();
const TOTAL_S = RAMP_STAGES.reduce((sum, s) => sum + Number(s.duration.replace('s', '')), 0);

export const options = {
  scenarios: {
    tables: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: RAMP_STAGES,
      // **아무도 내려가지 않는다.** 누적이라야 소켓 수가 실제로 쌓인다.
      gracefulRampDown: '0s',
      exec: 'table',
    },
    monitor: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${TOTAL_S + 60}s`,
      exec: 'monitor',
    },
  },
  thresholds: {
    // 합격선. 실행 전체 누적이라 중단 판정에는 못 쓰지만 기록으로 남는다.
    my_action_ms: ['p(95)<200'],
    others_action_ms: ['p(95)<500'],
    socket_errors: ['count==0'],
    hands_played: ['count>0'],
  },
};

export function setup() {
  const ownerToken = login(manifest.ownerNickname, manifest.password);
  // **대회는 여기서 시작시키지 않는다.** `startSession`이 최소 인원을 세고
  // (`MIN_PLAYERS_TO_START`, 컨테이너에서 2) 아무도 앉기 전에는 0명이라
  // 409다. 실제 순서도 착석이 먼저다 — 그래서 대회마다 첫 VU가 자기 좌석을
  // 채운 뒤에 시작시킨다(`table()`).
  //
  // 실행마다 다른 접두사. 닉네임이 유니크라 시드를 다시 돌리지 않고
  // 재실행하면 `POST /auth/join`이 400으로 거절한다. 네 글자로 자른다 —
  // 닉네임은 3~10자이고 뒤에 VU와 좌석이 붙는다.
  const runId = Math.random().toString(36).slice(2, 6);
  return { ownerToken, runId, startedAt: Date.now(), endAt: Date.now() + TOTAL_S * 1000 };
}

export function table(data) {
  // **VU가 아니라 반복 순번으로 자리를 정한다.** 각 VU는 실행이 끝날 때까지
  // 반복 하나를 붙들고 있으므로 순번이 곧 테이블 번호이고, `__VU`와 달리
  // 시나리오가 둘이어도 겹치지 않는다.
  const index = exec.scenario.iterationInTest;

  // 램프 B는 전부 첫 대회다(perStore = Infinity → storeIdx = 0).
  // 램프 A는 6테이블마다 다음 대회로 넘어간다.
  const perStore = TABLES_PER_STORE > 0 ? TABLES_PER_STORE : Infinity;
  const storeIdx = Math.min(Math.floor(index / perStore), manifest.tournaments.length - 1);
  const tournament = manifest.tournaments[storeIdx];
  const localIdx = index - storeIdx * (TABLES_PER_STORE > 0 ? TABLES_PER_STORE : 0);

  const setupStart = Date.now();
  // 그 대회의 첫 VU는 시드가 열어 둔 테이블을 쓰고, 나머지는 직접 연다.
  // 여는 것도 부하다 — 상점 콘솔의 버튼과 같은 경로다.
  const table =
    localIdx === 0
      ? tournament.tables[0]
      : createTableWithRetry(data.ownerToken, tournament.id, () => tableCreateConflicts.add(1));

  // 회원가입 → 로그인 → 결제 → OTP → 착석. 전부 제품 경로다.
  const players = seatPlayers({
    tournamentId: tournament.id,
    tableId: table.id,
    password: manifest.password,
    seatCount: SEAT_COUNT,
    // 접두사 4 + 순번(base36) + 좌석(1). 순번 66까지는 base36으로 두 글자다.
    prefix: `${data.runId}${index.toString(36)}`,
    // 테이블끼리 겹치면 `@@unique([tournamentId, userId])`가 409로 막는다.
    poolBase: index * SEAT_COUNT,
    accountPrefix: manifest.accountPrefix,
    accountPool: manifest.accountPool,
  });
  tableSetupMs.add(Date.now() - setupStart);

  // 그 대회의 첫 VU만 시작시킨다. 시작해야 Redis에 블라인드 메타가 서고
  // `startPreFlop`이 통과한다(`dealer.service.ts:193`). 두 번 부르면
  // `initializeGame`이 다시 돌아 이미 도는 테이블의 상태를 갈아엎으므로
  // **한 번만** 부른다 — 실제로도 상점이 시작 버튼을 한 번 누른다.
  //
  // 뒤늦게 붙는 테이블은 시작할 필요가 없다. 블라인드 메타는 대회 단위라
  // 이미 서 있고, `createTable`이 스냅샷을 세운다(T38).
  if (localIdx === 0) startTournament(data.ownerToken, tournament.id);

  // 이 VU의 단계 라벨. 모듈 상태를 모니터와 나눠 쓰지 않으려고 여기서 만든다.
  let lastVus = -1;
  function label() {
    const vus = exec.instance.vusActive - NON_TABLE_VUS;
    const l = vus === lastVus ? `steady-${vus}` : `grow-${vus}`;
    lastVus = vus;
    return l;
  }

  // 그 단계의 고원 중간. `setup`이 잡은 시작 시각 기준이라 전 VU가 같은
  // 순간에 끊는다 — 그게 "배너를 본 사람들이 동시에 새로고침"의 모양이다.
  let reconnectAtMs = null;
  if (RECONNECT_AT_TABLES > 0) {
    const stepsBefore = Math.max(
      0,
      Math.ceil((RECONNECT_AT_TABLES - START_TABLES) / STEP_TABLES),
    );
    const absolute =
      data.startedAt + (stepsBefore + 1) * (GROW_S + STEADY_S) * 1000 - (STEADY_S / 2) * 1000;
    const delta = absolute - Date.now();
    // 이미 지난 시각이면 이 VU는 그 단계 뒤에 붙은 것이다 — 하지 않는다.
    if (delta > 0) reconnectAtMs = delta;
  }

  // 남은 시간만큼만 돈다. 늦게 붙은 VU도 같은 시각에 끝난다.
  return runHands({
    tournamentId: tournament.id,
    tableId: table.id,
    dealerOtp: manifest.dealerOtp,
    players,
    durationMs: Math.max(5000, data.endAt - Date.now()),
    bigBlind: manifest.bigBlind,
    stepLabel: label,
    onMyAction: makeAbortWatcher(),
    reconnectAtMs,
  });
}

/**
 * 내 액션 지연의 롤링 창. 최근 30건의 p95가 불편선을 `ABORT_STREAK`번
 * 연속으로 넘으면 실행을 멈춘다.
 *
 * 실행 전체 누적인 `thresholds`로는 못 하는 판정이다 — 성장 램프에서는
 * 앞 단계의 좋은 표본이 뒤 단계의 나쁜 표본을 희석한다.
 */
function makeAbortWatcher() {
  const window = [];
  let streak = 0;
  return (elapsed) => {
    window.push(elapsed);
    if (window.length > 30) window.shift();
    if (window.length < 30) return;
    const sorted = [...window].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    if (p95 > MY_ACTION_ABORT_MS) {
      streak += 1;
      if (streak >= ABORT_STREAK) {
        exec.test.abort(
          `내 액션 p95가 ${MY_ACTION_ABORT_MS}ms를 ${streak}번 연속 넘었다 ` +
            `(테이블 ${exec.instance.vusActive - NON_TABLE_VUS}개, 최근 30건 p95 ${p95}ms)`,
        );
      }
    } else {
      streak = 0;
    }
  };
}

export function monitor() {
  const every = Number(__ENV.LOAD_SAMPLE_MS || 5000);
  const until = Date.now() + TOTAL_S * 1000;
  // 첫 샘플은 버린다 — 직전 창이 부팅부터 지금까지라 램프와 무관한 구간이다.
  sample('warmup');
  while (Date.now() < until) {
    // k6의 `sleep`은 초 단위다. 밀리초로 다루는 다른 값들과 섞이지 않게 나눈다.
    sleep(every / 1000);
    sample(monitorLabel(NON_TABLE_VUS));
  }
}

export function handleSummary(data) {
  return buildSummary(data, NAME);
}
