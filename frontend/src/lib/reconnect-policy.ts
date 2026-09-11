/**
 * 끊긴 소켓을 언제 다시 열지.
 *
 * 순수 함수만 둔다 — 타이머도 `fetch`도 여기 없다. 그래야 "몇 초 뒤인가"를
 * 실제로 기다리지 않고 검사할 수 있다.
 *
 * ## 왜 지터가 필요한가
 *
 * 서버가 한 번 내려가면 **행사장 전원이 동시에 끊긴다.** 백오프 없이 바로
 * 다시 붙으면 그 전원이 같은 순간에 `POST /api/ws-ticket`을 친다. 브라우저
 * 트래픽은 전부 Next 프로세스 하나를 거치므로 그 요청들은 **한 IP의 한
 * 버킷**을 나눠 쓴다(`backend/src/auth/throttle.ts`).
 *
 * 실측이 그 모양을 보여 준다. 660소켓이 제품 기본 상한에서 한꺼번에 몰리자
 * 600이 통과하고 60이 막혔고, 막힌 쪽은 30초를 기다린 뒤에야 돌아왔다 —
 * **첫 사람과 마지막 사람의 차이가 31.9초**다. 문을 열어 둔 무대에서 같은
 * 660이 2.1초였으니, 그 30초는 서버가 아니라 상한이 만든 시간이다.
 *
 * ## 딜러는 늦게 붙는다
 *
 * 얻는 것이 "딜러가 일찍 못 누르게 막는다"가 아니라 **딜러가 보는 그림이 이미
 * 가라앉은 뒤라는 것**이다. 먼저 붙으면 아홉 중 둘만 찬 테이블을 보게 되고,
 * 사람이 재개를 이르게 누르는 순간이 정확히 거기다.
 *
 * **창을 줄이지 닫지는 않는다.** 딜러가 나중이어도 태블릿이 꺼진 참가자는
 * 여전히 없다. 닫는 것은 딜러의 판단이고, 이 순서는 그 판단이 흔들리는 그림
 * 위에서 내려지지 않게 하는 장치다.
 */

/** 좌석이 흩어지는 폭. 실측 31.9초를 덮는다. */
export const SEAT_SPREAD_MS = 40_000;

/** 딜러가 그 뒤에 붙기 시작하는 시각. 좌석 폭이 끝난 자리다. */
export const DEALER_OFFSET_MS = SEAT_SPREAD_MS;

/** 딜러끼리도 흩는다 — 테이블 수만큼의 딜러 단말이 있다. */
export const DEALER_SPREAD_MS = 10_000;

/** 몇 번까지 다시 붙나. 넘으면 사람에게 새로고침을 맡긴다. */
export const MAX_ATTEMPTS = 8;

export type SocketRole = 'seat' | 'dealer';

/**
 * 다음 시도까지 기다릴 밀리초. **더 시도하지 않을 때는 `null`.**
 *
 * 첫 시도(`attempt` 0)도 기다린다. 0으로 두면 전원이 같은 순간에 몰려 지터가
 * 있으나 마나가 된다 — 막는 대상이 바로 그 순간이다.
 *
 * @param attempt 0부터. 이미 몇 번 실패했나
 * @param role 좌석인가 딜러인가
 * @param rand 0 이상 1 미만. 테스트가 고정한다
 */
export function reconnectDelayMs(
  attempt: number,
  role: SocketRole,
  rand: () => number = Math.random,
): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;

  const spread = role === 'dealer' ? DEALER_SPREAD_MS : SEAT_SPREAD_MS;
  const offset = role === 'dealer' ? DEALER_OFFSET_MS : 0;

  // **전폭 지터다.** `폭/2 ± 조금`처럼 가운데로 모으면 무리가 흩어지는 것이
  // 아니라 통째로 늦춰졌다가 다시 뭉친다.
  const jitter = Math.floor(rand() * spread);

  // 거듭 실패하면 폭을 늘린다. 상한이 30초 블록을 걸고 있으면 같은 폭으로
  // 계속 두드려 봐야 전부 429다 — 두 배씩 벌려 블록이 풀린 뒤에 닿게 한다.
  // 다만 폭만 늘리고 **바닥은 안 만든다**: 일찍 열린 문을 못 쓰게 된다.
  const widened = jitter * 2 ** Math.min(attempt, 3);

  return offset + widened;
}

/**
 * 서버가 준 `Retry-After`(초)를 바닥으로 삼는다. 없으면 `null`.
 *
 * 429는 "지금은 안 된다"를 **서버가 숫자로 말해 준** 유일한 경우다. 그 값을
 * 무시하고 우리 지터만 쓰면 아직 닫힌 문을 때려 블록이 갱신된다.
 *
 * HTTP 날짜 형식은 읽지 않는다 — `ThrottlerGuard`가 싣는 것은 초 단위 정수다.
 * 안 보내는 모양을 반쯤 읽는 것보다 `null`로 떨어져 지터만 쓰는 편이 낫다.
 */
export function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;

  // `Number('')`는 0이다. 빈 헤더를 "0초 뒤"로 읽으면 막힌 문을 곧바로
  // 다시 두드린다.
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * 이번 시도의 대기 시간. 429면 서버가 말한 바닥 위에 지터를 얹는다.
 *
 * 바닥과 지터가 **다른 일을 한다.** 바닥만 있으면 막힌 단말 전원이 정확히 같은
 * 순간에 깨어나 몰림이 그대로 반복되고, 지터만 있으면 아직 닫힌 문을 때린다.
 */
export function waitFor(
  attempt: number,
  role: SocketRole,
  floorMs: number | null,
  rand: () => number = Math.random,
): number | null {
  const jittered = reconnectDelayMs(attempt, role, rand);
  if (jittered === null) return null;
  return (floorMs ?? 0) + jittered;
}
