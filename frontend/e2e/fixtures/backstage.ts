import { APIRequestContext } from '@playwright/test';

/**
 * 카메라에 잡히지 않는 손. 백엔드 API를 직접 친다.
 *
 * 촬영에서 화면으로 해야 하는 것과 그렇지 않은 것이 갈린다. 상점이 대회를
 * 시작하는 것, 사람이 OTP를 넣고 앉는 것, 딜러가 액션을 받는 것은 **장면 자체**라
 * 브라우저로 해야 한다. 반면 "player2~7을 자리에 앉혀 놓는다" 같은 준비는
 * 장면이 아니라 배경이고, 태블릿 여섯 대를 띄워 여섯 번 찍는 것은 영상에
 * 아무것도 더하지 않으면서 실행 시간만 늘린다.
 *
 * 그 경계를 **여기 있느냐 없느냐로** 표시한다. 이 파일에 들어온 동작은
 * 화면 없이 일어난다고 선언한 것이다.
 */

export const BACKEND_URL = 'http://localhost:3001';

/** 시드가 만든 계정으로 토큰을 받는다. 실패하면 그 자리에서 멈춘다. */
export async function login(
  request: APIRequestContext,
  nickname: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { nickname, password },
  });
  if (!res.ok()) {
    throw new Error(`로그인 실패 (${nickname}): ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error(`로그인 응답에 accessToken이 없다 (${nickname}): ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}
