import { z } from 'zod';

/**
 * WS 핸드셰이크용 단명 티켓.
 *
 * 아웃바운드이므로 zod 기본 스트립이 적용된다 — 백엔드가 이 응답에 필드를
 * 더해도 스키마에 없으면 조용히 제거된다. 액세스 토큰이 실수로 이 경로를
 * 타고 나가는 것을 막는 마지막 그물이다.
 */
export const WsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
});

export type WsTicketResponse = z.infer<typeof WsTicketResponseSchema>;
