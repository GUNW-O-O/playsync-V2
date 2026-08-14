import http from 'k6/http';
import { fail } from 'k6';

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

/** 서버 내부 지표. 램프의 단계마다 한 번씩 읽는다(창이 그때 닫히고 다시 열린다). */
export function metrics() {
  const res = http.get(`${BASE}/internal/metrics`, { tags: { step: 'metrics' } });
  return must(res, '메트릭 조회');
}
