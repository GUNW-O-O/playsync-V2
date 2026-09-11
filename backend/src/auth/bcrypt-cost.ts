/**
 * bcrypt 코스트(솔트 라운드)를 한 자리에서 정한다.
 *
 * **제품 값은 10이고, 이 파일은 그것을 내리는 스위치가 아니라 노브다.**
 * 부하 무대가 "정원"을 잴 때 bcrypt가 답을 가린다 — 2026-08-21 실측에서
 * 착석 구간 CPU가 12코어를 줘도 250~370%에서 멈췄고, 원인이 bcrypt가 JS
 * 스레드가 아니라 libuv 스레드풀에서 도는 것이었다(`backlog.md`의 B11).
 * 그 실행의 정원 수치 중 얼마가 방의 크기이고 얼마가 문의 비용인지 가를
 * 길이 없었다.
 *
 * 코스트는 지수다 — 10에서 4로 내리면 2^6, 즉 64배 싸진다. 실측 58ms가
 * 1ms가 된다. **그런데도 호출·await·스레드풀 경로는 그대로 남는다.** 끄는
 * 스위치를 두지 않은 이유가 이것이고, 요청율 상한이 부하 무대에서 값만
 * 올리고 코드는 그대로 도는 것과 같은 판단이다(`throttle.ts`).
 *
 * 그래서 같은 무대를 10과 4로 두 번 돌려 빼면 **정원 수치 중 bcrypt의 몫**이
 * 그대로 나온다. 한 번 끄고 마는 것보다 이쪽이 값이 크다.
 *
 * **`compare`의 비용은 이 값이 아니라 저장된 해시가 정한다.** bcrypt 해시
 * 문자열이 자기 코스트를 싣고 다니기 때문이다(`$2b$10$...`). 백엔드만 낮추면
 * 실행 중 가입(`NEW_USER_RATIO`, 기본 10%)만 싸지고, 나머지 90%가 타는
 * 로그인은 시드가 구운 코스트 그대로다. **시드를 다시 깔아야 한다** —
 * `seed-load.ts`가 이 함수를 import하는 이유이고, 두 벌로 두면 어긋난다.
 */

type Env = Record<string, string | undefined>;

/** 제품 값. 이 상수를 바꾸는 것이 곧 정책 변경이다. */
const PRODUCTION_ROUNDS = 10;

/**
 * bcrypt 자체가 받는 범위다. 4 미만은 라이브러리가 던지고, 31을 넘으면
 * 역시 던진다. 범위 밖을 기본값으로 되돌리는 이유는 **오타가 서버를 세우지
 * 않게** 하려는 것이다 — `BCRYPT_ROUNDS=100`이 기동 시점이 아니라 첫
 * 회원가입에서 터지면 그 자리가 원인처럼 보이지 않는다.
 *
 * 범위 안의 큰 값(예: 20, 한 번에 분 단위)은 되돌리지 않는다. 그것은 오타가
 * 아니라 운영자가 고른 값이고, 코스트를 올리는 것은 정당한 보안 강화다.
 */
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 31;

/**
 * 호출 시점에 읽는다 — 모듈 로드 시점에 고정하면 테스트가 값을 바꿀 수 없다.
 * `signupInitialPoints`(`auth.service.ts`)와 같은 이유다.
 */
export function bcryptRounds(env: Env = process.env): number {
  const raw = env.BCRYPT_ROUNDS;
  if (raw === undefined) return PRODUCTION_ROUNDS;

  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_ROUNDS || n > MAX_ROUNDS) return PRODUCTION_ROUNDS;
  return n;
}

/** 제품 값보다 낮은가. 기동 경고(`main.ts`)가 이것으로 판단한다. */
export function isWeakenedBcrypt(env: Env = process.env): boolean {
  return bcryptRounds(env) < PRODUCTION_ROUNDS;
}
