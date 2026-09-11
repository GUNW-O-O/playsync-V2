/**
 * 요청율 상한.
 *
 * **막으려는 것은 추측이 아니라 폭주다.** 딜러 OTP는 이미 대회 단위 잠금이
 * 추측을 막는다(`dealer/otp-attempts.ts`). 여기서 다루는 것은 그 잠금이
 * 만들어 낸 대가 — `POST /dealer/auth`도 `POST /auth/login`도 인증이 없어,
 * 같은 망의 누구나 원하는 만큼 때릴 수 있다는 것이다. `/auth/login`은 잠금
 * 장치조차 없이 bcrypt를 돌리므로(T41 실측 p50 58ms) 스레드풀을 직접 태울 수
 * 있는 자리다.
 *
 * ## 어디까지 막나
 *
 * IP당 요청 수 상한 하나다. **주소를 바꿔 가며 오는 공격은 못 막는다** —
 * 그건 잠금 단위를 IP로 옮겨도 마찬가지고(`otp-attempts.ts` 첫 주석), 막으려
 * 들면 끝이 없다. 이 도메인의 신뢰 경계는 행사장 폐쇄망이고 현장에 직원이
 * 있다(`docs/threat-model.md`). 자동화된 폭주를 자르는 선에서 멈춘다.
 *
 * ## 이 토폴로지에서 IP 하나가 뜻하는 것
 *
 * 브라우저가 백엔드를 직접 부르지 않는다. 서버 액션·서버 컴포넌트는
 * `BACKEND_URL`로 직통하고 클라이언트 fetch는 Next rewrite를 탄다 — **어느
 * 쪽이든 백엔드가 보는 주소는 Next 프로세스 하나다.** 그래서 전역 한도는
 * "단말 하나의 몫"이 아니라 **모든 사용자 트래픽의 몫**으로 잡아야 한다
 * (전광판만 해도 1초 폴링이다). 반대로 백엔드에 직접 붙는 스크립트는 자기
 * 주소로 잡히므로, 이 상한이 실제로 값을 내는 자리는 그쪽이다.
 *
 * 단말별로 가르려면 프론트가 실어 주는 `X-Forwarded-For`를 믿어야 하는데,
 * 그 헤더는 백엔드에 직접 붙는 쪽도 위조할 수 있어서 "프론트에서 온 연결일
 * 때만 믿는다"는 판별이 따로 필요하다. **하지 않는다** — 얻는 것이 세분화된
 * 버킷 하나뿐이고, 잘못 켜면 아무나 남의 버킷을 채울 수 있다.
 *
 * ## 값
 *
 * 기본값이 방어값이고, 부하 프로파일만 환경변수로 올린다. 반대로 두면
 * (기본 느슨 + 운영에서만 조임) 실제로 도는 경로는 늘 느슨한 쪽이고 조인
 * 설정은 아무도 밟지 않은 코드가 된다 — T51의 `createTestPrisma()`와 같은
 * 함정이다. 끄는 스위치를 두지 않은 이유도 같다: 부하에서도 제한 코드가
 * 그대로 실행돼야 "켜면 무너지는" 상태가 안 생긴다.
 */

/** 창 하나의 길이. 짧으면 버스트를 잡고 길면 지속 도착을 잡는다. 1분이 둘의 중간이다. */
const WINDOW_MS = 60_000;

/**
 * 전역 상한. Next 프로세스 하나가 전체 사용자 트래픽을 중계한다는 전제로 잡은
 * 값이다 — 전광판 1초 폴링(분당 60)에 폰·태블릿 조회를 더해도 한참 남는다.
 */
const DEFAULT_LIMIT = 600;

/**
 * 인증 라우트 상한. bcrypt가 도는 자리라 전역보다 좁다.
 *
 * 분당 120이면 초당 2다. 행사 시작 전 참가자가 몰려 로그인하는 실제 도착률
 * (T41 램프의 지속 9~10/s는 부하 무대의 값이고, 그때는 env로 올린다)보다
 * 넉넉하면서, 스크립트가 스레드풀을 태우는 속도는 아니다.
 */
const AUTH_LIMIT = 120;

/**
 * 상한을 넘긴 키를 막아 두는 길이. 지정하지 않으면 라이브러리가 `ttl`로
 * 떨어뜨려 60초가 된다(T92) — 브라우저가 전부 Next 프로세스 하나를 거치는
 * 이 토폴로지에서는 한 사람이 걸어도 대기열 전체가 그 창을 그대로 문다.
 * 30초로 짧게 잡아 피해 시간을 반으로 줄인다. 상한(120)은 그대로 둔다 —
 * 몰림의 크기는 사람 수가 정하는 것이라 상한을 만지는 건 다른 문제다.
 * (블록 중에는 히트를 세지 않고 벽시계로 풀린다 —
 * `throttler.service.js`의 `increment`가 `isBlocked`면 `fireHitCount`를
 * 건너뛴다. 막혀서 못 풀리는 일은 없다.)
 */
const BLOCK_MS = 30_000;

/**
 * 429 본문의 `message`. 기본값(`ThrottlerException: Too Many Requests`)은
 * 라이브러리가 박아 둔 영어 문구인데, 프론트의 `failureMessage`들이 본문의
 * `message`를 그대로 띄우므로 영어 예외 이름이 화면에 나온다(T92).
 *
 * **주어를 쓰지 않는다.** 이 문구는 `forRoot`의 것이라 APP_GUARD를 지나는
 * 모든 라우트의 429 본문이 된다 — 딜러 단말도 좌석 태블릿도 상점 콘솔도
 * 이것을 읽는다. "로그인 요청이"라고 적으면 그 화면들에서 틀린 말이 된다.
 *
 * 남은 초는 여기 넣지 않는다 — 요청마다 다른 값이고 `Retry-After` 헤더가
 * 이미 들고 있다. 로그인·가입 화면은 이 본문을 아예 안 읽고 그 헤더로
 * 자기 문구를 만든다(`frontend/src/app/auth/action.ts`의 `throttleMessage`).
 */
const ERROR_MESSAGE = '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.';

type Env = Record<string, string | undefined>;

/**
 * 양의 정수만 받고 나머지는 기본값으로 되돌린다.
 *
 * `Number('')`는 0, `Number('abc')`는 NaN이다. 0은 **모든 요청을 막고** NaN은
 * 비교가 전부 false라 **아무도 안 막는다.** 오타 하나가 어느 쪽으로든 조용히
 * 무너뜨리는 자리라, 파싱에서 막는다.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function throttleWindowMs(env: Env = process.env): number {
  return positiveInt(env.THROTTLE_WINDOW_MS, WINDOW_MS);
}

export function defaultLimit(env: Env = process.env): number {
  return positiveInt(env.THROTTLE_LIMIT, DEFAULT_LIMIT);
}

export function authLimit(env: Env = process.env): number {
  return positiveInt(env.THROTTLE_AUTH_LIMIT, AUTH_LIMIT);
}

export function blockDurationMs(env: Env = process.env): number {
  return positiveInt(env.THROTTLE_BLOCK_MS, BLOCK_MS);
}

/**
 * `ThrottlerModule.forRoot`에 그대로 넘긴다.
 *
 * 배열이 아니라 `{ throttlers, errorMessage }` 객체 형태다 — `getErrorMessage`가
 * 옵션이 배열이면 커스텀 `errorMessage`를 아예 안 보기 때문이다(T92,
 * `throttler.guard.js`의 `if (!Array.isArray(this.options))`). 배열로
 * 돌리던 시절에는 문구를 실어도 조용히 무시됐다.
 */
export function throttlerOptions(env: Env = process.env) {
  return {
    throttlers: [
      { ttl: throttleWindowMs(env), limit: defaultLimit(env), blockDuration: blockDurationMs(env) },
    ],
    errorMessage: ERROR_MESSAGE,
  };
}

/**
 * 인증 라우트에 붙이는 `@Throttle(...)`의 인자.
 *
 * 데코레이터는 클래스가 import될 때 한 번 평가되므로 여기서 읽는 env도 그
 * 시점의 값이다. `main.ts`가 첫 줄에서 `dotenv/config`를 부르고 그 뒤에
 * `AppModule`을 들이므로 순서는 맞다.
 *
 * **블록 길이는 여기서 안 준다.** 라이브러리의 해석 순서가 라우트 → 모듈 →
 * ttl이라(`throttler.guard.js`의
 * `routeOrClassBlockDuration || namedThrottler.blockDuration || ttl`),
 * 이 데코레이터가 `blockDuration`을 비워 두면 모듈의 `throttlerOptions()`가
 * 정한 값(30초)이 그대로 인증 라우트에도 내려온다. 여기서 따로 값을 실으면
 * 다음 사람이 두 자리를 맞춰야 한다고 착각하게 된다.
 */
export function authThrottle(env: Env = process.env) {
  return { default: { ttl: throttleWindowMs(env), limit: authLimit(env) } };
}
