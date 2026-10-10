'use server';

import { cookies } from 'next/headers';
import { failureMessage as messageOf } from '@/lib/failure-message';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ERROR = '참가하지 못했습니다.';
const NO_TOKEN_ERROR = '로그인이 필요합니다.';

/** 이 파일의 기본 문구로 묶은 것. 꺼내는 규칙은 `lib/failure-message.ts`에 있다. */
const failureMessage = (body: unknown) => messageOf(body, DEFAULT_ERROR);

/**
 * 참가비 결제. 몸통은 `{ tournamentId }` **하나뿐이다** — T28이 좌석 확정을
 * 결제에서 입장으로 옮기면서 `PayMentDto`에서 좌석이 빠졌다
 * (`backend/shared/dto/payment.dto.ts`).
 *
 * 응답(`{ id, status }`)을 반환값에 담지 않는다. 참가 OTP는 이 응답에 없고
 * `/me`가 따로 읽는다 — 돈이 움직이는 경로와 비밀을 보여주는 경로를 겹치지
 * 않게 둔다.
 */
export async function joinTournament(
  tournamentId: string,
): Promise<{ ok: true } | { error: string }> {
  const token = (await cookies()).get('accessToken')?.value;
  if (!token) return { error: NO_TOKEN_ERROR };

  const res = await fetch(`${BACKEND_URL}/tournaments/payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tournamentId }),
    cache: 'no-store',
  });

  if (!res.ok) return { error: failureMessage(await res.json().catch(() => null)) };
  return { ok: true };
}
