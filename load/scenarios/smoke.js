import { login, startTournament } from '../lib/api.js';
import { sample } from '../lib/monitor.js';
import { buildSummary } from '../lib/summary.js';
import { runHands, seatPlayers } from '../lib/table.js';

/**
 * 스모크 — 테이블 하나.
 *
 * 램프가 아니다. **봇이 실제로 규칙대로 핸드를 돌리고 두 지연이 잡히는지**만
 * 본다. 여기가 초록이면 T41의 램프는 이 위에서 규모만 늘리면 된다.
 *
 * 실행:
 *   npm run seed:load
 *   npm run load:up
 *   docker compose -f backend/docker-compose.test.yml --profile k6 run --rm k6 \
 *     run /load/scenarios/smoke.js
 */

const manifest = JSON.parse(open('/load/.load-seed.json'));

const SEAT_COUNT = 9;
const DURATION_MS = Number(__ENV.LOAD_DURATION_MS || 30000);

export const options = {
  scenarios: {
    smoke: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '5m' },
  },
  thresholds: {
    // 합격선. 설계 문서의 "합격선" 절 그대로다.
    my_action_ms: ['p(95)<200'],
    others_action_ms: ['p(95)<500'],
    // 소켓이 하나라도 거절당하면 그 실행의 지연 수치는 못 믿는다.
    socket_errors: ['count==0'],
    // 봇이 실제로 게임을 돌렸다는 증거. 없으면 "소켓만 붙어 있는" 실행이다.
    hands_played: ['count>0'],
  },
};

export function setup() {
  // 상점 관리자는 시드가 만들어 뒀다. 여기서 bcrypt 대조가 한 번 돈다.
  const ownerToken = login(manifest.ownerNickname, manifest.password);
  // 실행마다 다른 접두사. 닉네임이 유니크라 시드를 다시 돌리지 않고 재실행하면
  // `POST /auth/join`이 400("이미 존재하는 ID입니다")으로 거절한다.
  //
  // **네 글자로 자른다.** 닉네임은 3~10자다(`CreateUserDto`). 뒤에 VU와 좌석이
  // 붙으므로 접두사가 길면 램프에서 VU 번호가 커질 때 상한을 넘는다.
  const runId = Math.random().toString(36).slice(2, 6);
  return { ownerToken, runId };
}

export default function (data) {
  // 스모크는 첫 대회의 첫 테이블만 쓴다. 시드가 대회를 여럿 세우는 것은
  // 램프 A를 위해서고(`LOAD_STORES`), 스모크의 관심사가 아니다.
  const tournament = manifest.tournaments[0];
  const table = tournament.tables[0];

  // 회원가입 → 로그인 → 결제 → OTP → 착석. 전부 제품 경로다.
  const players = seatPlayers({
    tournamentId: tournament.id,
    tableId: table.id,
    password: manifest.password,
    seatCount: SEAT_COUNT,
    // 접두사 4 + VU(base36) + 좌석(1) = 최대 10자 안쪽.
    prefix: `${data.runId}${__VU.toString(36)}`,
    // 스모크는 테이블 하나라 풀 앞에서부터 쓴다. 램프는 테이블마다 겹치지
    // 않게 밀어 준다.
    poolBase: (__VU - 1) * SEAT_COUNT,
    accountPrefix: manifest.accountPrefix,
    accountPool: manifest.accountPool,
    entryFee: manifest.entryFee,
  });

  // 대회를 시작해야 Redis에 블라인드 메타가 서고, 그래야 `startPreFlop`이
  // 통과한다(`dealer.service.ts:193`).
  startTournament(data.ownerToken, tournament.id);

  return runHands({
    tournamentId: tournament.id,
    tableId: table.id,
    dealerOtp: manifest.dealerOtp,
    players,
    durationMs: DURATION_MS,
    bigBlind: manifest.bigBlind,
  });
}

export function teardown() {
  // 서버 지표를 k6 지표로 기록한다. `handleSummary`는 모듈 변수를 못 보므로
  // (k6가 그 사이 상태를 이어 주지 않는다) 여기를 통해야 요약에 남는다.
  sample('end');
}

export function handleSummary(data) {
  return buildSummary(data, 'smoke');
}
