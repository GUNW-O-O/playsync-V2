/**
 * 재접속이 상한에 걸렸을 때 언제 다시 두드릴지.
 *
 * 시나리오가 아니라 **정책**이 여기 산다. 순수 함수만 둔다 — I/O도 k6 전역도
 * 쓰지 않는다(`windows.js`·`door.js`가 그 선례다).
 *
 * ## 왜 필요한가
 *
 * 재접속 폭발은 소켓만의 사건이 아니다. 티켓이 1회용이라 소켓마다
 * `POST /ws/ticket`을 새로 쳐야 하고(T24), 브라우저 트래픽이 전부 Next 프로세스
 * 하나를 거치므로 그 요청들은 **한 IP의 한 버킷**을 나눠 쓴다
 * (`backend/src/auth/throttle.ts`의 "이 토폴로지에서 IP 하나가 뜻하는 것").
 * 그래서 단말이 많아지면 복귀하려는 행위 자체가 문을 닫는다.
 *
 * 지금까지 하네스는 이 자리를 못 쟀다. `api.js`의 `wsTicket`이 429를 받으면
 * `must`가 VU를 죽여, 무대를 제품 기본 상한으로 돌리는 순간 테이블이 통째로
 * 사라졌다. 무대는 상한을 100000으로 열어 뒀으므로 지금까지의 `reconnect_ms`는
 * **문이 없는 세계의 값**이다.
 *
 * ## 바닥과 지터는 다른 일을 한다
 *
 * 둘을 한 값으로 뭉치면 하나가 조용히 사라진다.
 *
 * | | 무엇을 막나 |
 * |---|---|
 * | 바닥(`Retry-After`) | 닫힌 줄 아는 문을 계속 두드리는 것 |
 * | 지터 | 문이 열리는 순간 무리가 **다시 한꺼번에** 몰리는 것 |
 *
 * 바닥만 있으면 막힌 단말 전원이 정확히 같은 순간에 깨어나 몰림이 그대로
 * 반복된다. 지터만 있으면 아직 닫혀 있는 문을 때려 블록이 갱신된다.
 */

/** `Retry-After`가 없을 때 쓰는 바닥. `throttle.ts`의 `BLOCK_MS`와 같은 값이다. */
export const FALLBACK_FLOOR_MS = 30_000;

/** 몇 번까지 다시 두드리나. 넘으면 포기하고 그 사실을 실행 요약에 남긴다. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * 응답의 `Retry-After`를 밀리초로. 초 단위 정수만 다룬다 — `ThrottlerGuard`가
 * 싣는 것이 그 모양이다(`auth.throttle.spec.ts`가 `'7'`을 확인한다).
 *
 * HTTP 날짜 형식은 읽지 않는다. 이 서버가 안 보내는 모양을 읽으면, 언젠가
 * 보내기 시작했을 때 **이 함수가 조용히 틀린 값을 내는** 대신 바닥으로 떨어져
 * 눈에 띈다.
 *
 * @param {{headers?: Record<string, string>}} res
 * @returns {number|null} 헤더가 없거나 읽을 수 없으면 null
 */
export function retryAfterMs(res) {
  const headers = (res && res.headers) || {};
  // k6는 헤더 이름을 정규화해 돌려주지만(`Retry-After`), 대소문자에 기대지
  // 않는다 — 이 모듈은 순수 함수라 테스트가 아무 모양이나 먹일 수 있다.
  const key = Object.keys(headers).find((h) => h.toLowerCase() === 'retry-after');
  if (key === undefined) return null;

  // `Number('')`는 0이다. 빈 헤더를 "0초 뒤에 다시 오라"로 읽으면 막힌 문을
  // 곧바로 다시 두드린다 — bcrypt 코스트 파싱이 데인 자리와 같은 함정이다.
  const raw = String(headers[key]).trim();
  if (raw === '') return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * 무리 전체가 상한 안에 들어가려면 재시도를 몇 초에 걸쳐 흩어야 하나.
 *
 * **이것이 T93이 정해야 하는 숫자다.** 지터 폭을 무리 크기가 아니라 감으로
 * 잡으면 두 번째 파도가 또 문에 걸린다 — 400대가 30초 창에 몰리면 분당 800이라
 * 상한(600)을 그대로 다시 넘는다.
 *
 * @param {number} herd 동시에 복귀하려는 단말 수
 * @param {number} limitPerMin 그 버킷의 분당 상한 (`throttle.ts`의 `DEFAULT_LIMIT`)
 * @returns {number} 밀리초
 */
export function spreadForHerd(herd, limitPerMin) {
  if (!(herd > 0) || !(limitPerMin > 0)) return 0;
  return Math.ceil((herd / limitPerMin) * 60_000);
}

/**
 * 이 응답을 받고 한 번 더 두드릴지, 얼마나 기다릴지.
 *
 * **429만 다시 두드린다.** 401·5xx·연결 실패(k6는 `status` 0)를 재시도에 섞으면
 * "문에 걸렸다"와 "못 잰다"가 한 숫자로 뭉개진다 — `door.js`의 `classify`가
 * 같은 이유로 상태 코드만 본다.
 *
 * 지터는 **전폭(full jitter)**이다. `바닥 + rand()*폭`이라 대기 시각이 폭 전체에
 * 고르게 흩어진다. `바닥 + 폭/2 ± 조금`처럼 가운데로 모으면 무리가 흩어지는 게
 * 아니라 잠깐 늦춰졌다가 다시 뭉친다.
 *
 * @param {{status: number, headers?: Record<string, string>}} res
 * @param {number} attempt 0부터. 이미 몇 번 두드렸나
 * @param {{spreadMs?: number, maxAttempts?: number, rand?: () => number}} [opts]
 * @returns {{retry: boolean, waitMs: number, reason: 'ok'|'not-limited'|'gave-up'|'backoff'}}
 */
export function nextAttempt(res, attempt, opts = {}) {
  const { spreadMs = FALLBACK_FLOOR_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, rand = Math.random } = opts;
  const status = res && res.status;

  if (status >= 200 && status < 300) return { retry: false, waitMs: 0, reason: 'ok' };
  if (status !== 429) return { retry: false, waitMs: 0, reason: 'not-limited' };
  if (attempt + 1 >= maxAttempts) return { retry: false, waitMs: 0, reason: 'gave-up' };

  const floor = retryAfterMs(res);
  return {
    retry: true,
    waitMs: (floor === null ? FALLBACK_FLOOR_MS : floor) + Math.floor(rand() * spreadMs),
    reason: 'backoff',
  };
}
