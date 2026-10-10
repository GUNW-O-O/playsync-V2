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

/**
 * 실패한 뒤의 걸음(T119). 5초에서 두 배씩 가다 40초에 멈춘다.
 *
 * **폭을 다시 벌리지 않는다.** 첫 시도의 지터가 기기마다 다른 출발 시각을 이미
 * 줬으므로, 그 뒤를 같은 걸음으로 가도 무리는 흩어진 채다. 예전에는 실패마다
 * 폭이 두 배(80 · 160 · 320초)였는데, `SYNCING`은 가장 늦은 한 대가 풀어서
 * (T117) 그 꼬리가 곧 대회 전체의 대기였다 — 667테이블 kill에서 서버는 2분째부터
 * 한가한데 해제가 407초였다(`docs/results/`).
 */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 40_000;

/**
 * 몇 번까지 다시 붙나. 넘으면 사람에게 새로고침을 맡긴다.
 *
 * **10번이면 약 5분이다** — 복구의 합격선(재기동 뒤 5분)과 같다. 그보다 오래
 * 혼자 두드리게 두지 않는다: 자리에 사람이 있으면 옆 태블릿이 붙은 것을 보고
 * 먼저 새로고침하고, 5분 넘게 죽은 서버는 자동 재접속으로 풀 일이 아니다.
 */
export const MAX_ATTEMPTS = 10;

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

  // 실패한 뒤 — 짧은 걸음. 걸음마다 ±50%로 흩어, 서버가 같은 순간에 거절한
  // 기기들이 같은 순간에 돌아오지 않게 한다. 상한에 걸린 경우(429)는 서버가
  // 말한 `Retry-After`가 바닥으로 깔린다(`waitFor`). 딜러를 좌석 뒤로 미는
  // 것은 첫 시도뿐이다 — 재시도마다 깔면 딜러가 꼬리가 된다.
  if (attempt > 0) {
    const step = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    return Math.floor(step * (0.5 + rand()));
  }

  const spread = role === 'dealer' ? DEALER_SPREAD_MS : SEAT_SPREAD_MS;
  const offset = role === 'dealer' ? DEALER_OFFSET_MS : 0;

  // **전폭 지터다.** `폭/2 ± 조금`처럼 가운데로 모으면 무리가 흩어지는 것이
  // 아니라 통째로 늦춰졌다가 다시 뭉친다. **바닥은 안 만든다**: 일찍 열린 문을
  // 못 쓰게 된다.
  return offset + Math.floor(rand() * spread);
}

/**
 * 서버가 준 `Retry-After`(초)를 바닥으로 삼는다. 없으면 `null`.
 *
 * 429는 "지금은 안 된다"를 **서버가 숫자로 말해 준** 유일한 경우다. 그 값을
 * 무시하고 우리 지터만 쓰면 아직 닫힌 문을 때려 헛 429를 받고 시도 하나를 태운다
 * (블록 중의 히트는 세지 않아 블록이 길어지지는 않는다 — `throttle.ts`의 `BLOCK_MS`).
 * 시도는 `MAX_ATTEMPTS`번뿐이라 헛 429가 쌓이면 「새로고침」에 멈춘다(T114).
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
 * 순간에 깨어나 몰림이 그대로 반복되고, 지터만 있으면 아직 닫힌 문을 때려 시도를 헛쓴다.
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
