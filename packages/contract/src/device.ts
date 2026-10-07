/**
 * 매장 태블릿의 기기 토큰(T112).
 *
 * 쿠키·헤더 이름이 경계를 넘는다 — Next 서버 액션이 쿠키를 읽어 헤더로 싣고,
 * 백엔드가 그 헤더(없으면 rewrite가 들고 온 쿠키)를 읽는다. 양쪽이 손으로
 * 적으면 한쪽만 바뀌는 날 조용히 갈라진다.
 */
export const DEVICE_TOKEN_COOKIE = "deviceToken" as const;
export const DEVICE_TOKEN_HEADER = "x-device-token" as const;

/**
 * 기기 토큰 페이로드의 `role`. 프론트가 쿠키를 해석해 등록 폼을 고를 때도 읽으므로
 * 경계를 넘는다. Prisma `Role` 밖의 값이다(`SEAT_ROLE`과 같은 이유).
 */
export const DEVICE_ROLE = "STORE_DEVICE" as const;

/**
 * 기기 토큰이 없거나, 다른 상점 것이거나, 해제된 버전일 때의 401 문구.
 * 프론트가 이 문구를 보고 쿠키를 지운다 — 다시 그리면 등록 폼이 뜬다.
 */
export const DEVICE_UNREGISTERED_MESSAGE =
  "등록된 매장 태블릿이 아닙니다. 상점에 문의해주세요." as const;
