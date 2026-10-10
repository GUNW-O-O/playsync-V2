/**
 * 백엔드 실패 응답에서 화면에 띄울 문구를 꺼낸다.
 *
 * Nest는 `message`를 문자열로도(`HttpException`) 배열로도(`ValidationPipe`) 준다.
 * 본문이 JSON이 아니었거나 `message`가 없으면 `fallback`이다. 화면마다 이 함수를
 * 따로 적어 두었다가 일곱 벌이 됐다 — 여기가 한 곳이다.
 */
export function failureMessage(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return fallback;
}
