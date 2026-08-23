import http from 'k6/http';
import { fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * 부하 봇이 타는 REST 경로.
 *
 * **제품 경로를 그대로 탄다.** 토큰을 미리 발급해 두고 건너뛰지 않는다 —
 * 회원가입과 로그인의 bcrypt, 딜러 OTP 대조의 bcrypt가 전부 진짜 부하이고,
 * 1코어에서는 그 비중이 작지 않다. 건너뛰면 정원이 실제보다 높게 나온다.
 *
 * 프론트(Next)는 타지 않는다. `POST /ws/ticket`은 원래 Next의 route handler가
 * 쿠키를 읽어 중계하지만, 인증이 `Authorization: Bearer`라 봇이 직접 부를 수
 * 있다(`jwt.strategy.ts:27`). 측정 대상을 게임 서버로 좁히려는 것이다.
 */

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3001';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function bearer(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

/**
 * 응답을 검사하고 본문을 돌려준다.
 *
 * k6의 `check`는 실패를 세기만 하고 흐름을 멈추지 않는다. 부하 봇은 앞
 * 단계가 실패하면 뒤가 전부 무의미해지므로(토큰 없이 착석, 좌석 없이 WS)
 * 여기서 끊는다 — 그러지 않으면 실패가 조용히 번져 "소켓은 붙었는데 아무
 * 일도 안 일어나는" 실행이 되고, 그 실행의 지연 수치는 아무 의미가 없다.
 */
function must(res, what) {
  if (res.status < 200 || res.status >= 300) {
    fail(`${what} 실패 (${res.status}): ${String(res.body).slice(0, 200)}`);
  }
  if (!res.body) return null;
  // 모든 응답이 JSON은 아니다 — `POST /auth/join`은 평문 문자열을 돌려준다
  // (`auth.service.ts`의 `createUser`). 파싱을 강제하면 성공 경로가 죽는다.
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return res.body;
  }
}

export function signup(nickname, password) {
  const res = http.post(
    `${BASE}/auth/join`,
    JSON.stringify({ nickname, password }),
    { headers: JSON_HEADERS, tags: { step: 'signup' } },
  );
  must(res, `회원가입(${nickname})`);
}

export function login(nickname, password) {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ nickname, password }),
    { headers: JSON_HEADERS, tags: { step: 'login' } },
  );
  return must(res, `로그인(${nickname})`).accessToken;
}

/**
 * 목업 결제가 거절하는 금액의 나머지. **백엔드의 `DECLINE_REMAINDER`와 같은
 * 값이어야 한다**(`backend/src/payment/mock-approval.ts`).
 *
 * 손으로 맞춘 사본이라 어긋날 수 있는 자리다. 계약(`packages/contract`)에
 * 넣지 않은 이유는 이것이 경계를 넘는 값이 아니라 **목업의 내부 규칙**이기
 * 때문이다 — 프론트는 이 값을 모르고, 알 이유도 없다.
 */
const DECLINE_REMAINDER = 999;

/** 나머지를 재는 단위. 백엔드의 `DECLINE_MODULUS`와 같아야 한다. */
const DECLINE_MODULUS = 1000;

/** 거절을 밟는 봇의 비율. 0이면 충전 경로 자체를 안 탄다. */
const DECLINE_RATIO = Number(__ENV.LOAD_DECLINE_RATIO || 0);

/** 거절당한 충전과, 그 뒤 다시 시도해 성공한 충전. */
export const chargeDeclines = new Counter('charge_declines');
export const chargeRetries = new Counter('charge_retries');

/**
 * 포인트 충전. **`MOCK_PAYMENT=1`일 때만 라우트가 있다.**
 *
 * 부하가 이 경로를 타는 이유는 충전 자체가 아니라 **거절**이다. 지금까지
 * 부하는 결제 실패를 한 번도 밟은 적이 없어서, 거절 뒤에 참가 행 · 참가 OTP ·
 * 거래 내역 · 프라이즈풀이 안 남는지를 아무도 재지 않았다(T72).
 *
 * @returns 402로 거절당했으면 `false`. 그 외 실패는 `must`가 끊는다.
 */
export function chargePoint(token, amount) {
  const res = http.post(
    `${BASE}/payments/charge`,
    JSON.stringify({ amount }),
    { headers: bearer(token), tags: { step: 'charge' } },
  );
  // 402는 실패가 아니라 **재려던 것**이다. `must`에 태우면 VU가 죽어 거절이
  // 부하 모양을 바꿔 버린다.
  if (res.status === 402) return false;
  must(res, '포인트 충전');
  return true;
}

/**
 * 거절을 한 번 밟고 다시 충전한다. **선택된 봇만 이 경로를 탄다.**
 *
 * `LOAD_DECLINE_RATIO`가 0이면 아무 요청도 안 보낸다 — 기본 부하 모양을
 * 바꾸지 않으려는 것이다. 켜야 거절이 부하에 들어간다.
 *
 * **재시도하는 이유.** 사람이 하는 일이 그렇다 — 돈이 그대로 있는 것을 보고
 * 다시 누른다. 죽는 선택지도 있었지만 그러면 VU가 줄어 램프의 규모 축이
 * 흔들리고, 재는 것이 정원이 아니라 거절 비율이 된다.
 *
 * 재시도는 **한 번**이다. 두 번째 금액은 거절 규칙을 안 밟으므로 반드시
 * 통과하고, 그래도 실패하면 그것은 목업이 아니라 진짜 결함이라 끊는 편이 옳다.
 */
export function chargeForEntry(token, entryFee) {
  if (DECLINE_RATIO <= 0 || Math.random() >= DECLINE_RATIO) return;

  // 거절을 부르는 금액은 규칙에 맞춰 만든다.
  const declineAmount = Math.ceil(entryFee / DECLINE_MODULUS) * DECLINE_MODULUS + DECLINE_REMAINDER;
  if (chargePoint(token, declineAmount)) {
    fail(`거절돼야 할 금액이 승인됐다 (${declineAmount}) — 목업 규칙이 어긋났다`);
  }
  chargeDeclines.add(1);

  // 나머지가 규칙에 걸리면 1을 더해 비껴간다.
  const clean = entryFee % DECLINE_MODULUS === DECLINE_REMAINDER ? entryFee + 1 : entryFee;
  chargePoint(token, clean);
  chargeRetries.add(1);
}

/** 참가비 결제. 참가 행과 참가 OTP가 여기서 생긴다. */
export function joinTournament(token, tournamentId) {
  const res = http.post(
    `${BASE}/tournaments/payment`,
    JSON.stringify({ tournamentId }),
    { headers: bearer(token), tags: { step: 'pay' } },
  );
  must(res, '참가 결제');
}

/**
 * 참가 OTP를 읽는다. 실제로는 손님이 폰 마이페이지에서 보는 값이다.
 *
 * 이 조회도 부하다 — 대회 직전에 전원이 한 번씩 친다.
 */
export function myPlayerOtp(token, tournamentId) {
  const res = http.get(`${BASE}/user/me/participations`, {
    headers: bearer(token),
    tags: { step: 'otp' },
  });
  const list = must(res, '참가 목록 조회');
  const mine = (Array.isArray(list) ? list : list.participations || []).find(
    (p) => (p.tournamentId || (p.tournament && p.tournament.id)) === tournamentId,
  );
  if (!mine || !mine.playerOtp) {
    fail(`참가 OTP를 찾지 못했다: ${String(res.body).slice(0, 200)}`);
  }
  return mine.playerOtp;
}

/** 좌석 확정. 돌려받는 것은 좌석 토큰(`role: SEAT`)이다. */
export function enterSeat(tournamentId, otp, tableId, seatIndex) {
  const res = http.post(
    `${BASE}/tournaments/${tournamentId}/enter`,
    JSON.stringify({ otp, tableId, seatIndex }),
    { headers: JSON_HEADERS, tags: { step: 'enter' } },
  );
  return must(res, `착석(${seatIndex}번)`).accessToken;
}

/** 딜러 인증. 여기서 bcrypt 대조가 한 번 돈다(T23). */
export function dealerLogin(tournamentId, tableId, otp) {
  const res = http.post(
    `${BASE}/dealer/auth`,
    JSON.stringify({ tournamentId, tableId, otp }),
    { headers: JSON_HEADERS, tags: { step: 'dealer-auth' } },
  );
  const body = must(res, '딜러 인증');
  return body.accessToken || body.dealerToken || body.token;
}

/**
 * WS 핸드셰이크용 1회용 티켓(T24). 30초 만료이고 Redis `GETDEL`로 소비된다.
 *
 * 소켓 하나마다 한 번씩 필요하다 — 재사용할 수 없다.
 */
export function wsTicket(token) {
  const res = http.post(`${BASE}/ws/ticket`, null, {
    headers: bearer(token),
    tags: { step: 'ticket' },
  });
  return must(res, 'WS 티켓 발급').ticket;
}

/** 상점이 대회를 시작한다. 최소 인원이 앉아 있어야 통과한다. */
export function startTournament(ownerToken, tournamentId) {
  const res = http.patch(`${BASE}/store/sessions/${tournamentId}/start`, null, {
    headers: bearer(ownerToken),
    tags: { step: 'start' },
  });
  must(res, '대회 시작');
}

/** 상점이 테이블을 하나 더 연다. 램프가 규모를 늘리는 경로다. */
export function createTable(ownerToken, tournamentId) {
  const res = http.post(`${BASE}/store/sessions/${tournamentId}/tables`, null, {
    headers: bearer(ownerToken),
    tags: { step: 'create-table' },
  });
  return must(res, '테이블 추가');
}

/**
 * 테이블을 열되 409를 재시도한다.
 *
 * `insertTable`이 트랜잭션 **안에서** `tableOrder` 최댓값을 뽑고 최종 방어가
 * `@@unique([tournamentId, tableOrder])`다(`session.service.ts:195-197`).
 * 램프에서는 여러 VU가 같은 순간에 같은 대회의 테이블을 열므로 진 쪽이
 * 409를 받는다. 상점 콘솔에서는 사람이 다시 누르면 되지만 봇은 스스로
 * 다시 눌러야 한다.
 *
 * **재시도 횟수 자체가 산출물이다.** 버튼 하나로는 보이지 않는 값이다.
 */
export function createTableWithRetry(ownerToken, tournamentId, onRetry) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = http.post(`${BASE}/store/sessions/${tournamentId}/tables`, null, {
      headers: bearer(ownerToken),
      tags: { step: 'create-table' },
    });
    if (res.status >= 200 && res.status < 300) return JSON.parse(res.body);
    if (res.status !== 409) {
      fail(`테이블 추가 실패 (${res.status}): ${String(res.body).slice(0, 200)}`);
    }
    if (onRetry) onRetry();
    // 같은 간격으로 다시 부딪히지 않게 흩는다.
    sleep((50 + Math.random() * 150) / 1000);
  }
  fail('테이블 추가가 10번 연속 409로 거절됐다');
}

/** 서버 내부 지표. 램프의 단계마다 한 번씩 읽는다(창이 그때 닫히고 다시 열린다). */
export function metrics() {
  const res = http.get(`${BASE}/internal/metrics`, { tags: { step: 'metrics' } });
  return must(res, '메트릭 조회');
}
