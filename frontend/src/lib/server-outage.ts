import { SERVER_RECOVERING_STATUS } from '@playsync/contract';

/**
 * 백엔드가 Redis 장애를 복구하는 중인가(T97). **판정은 여기 하나다** —
 * 화면마다 `status === 503`을 적으면 한쪽만 고쳐지는 날이 온다. 문구는
 * 계약의 `SERVER_RECOVERING_MESSAGE`를 쓴다.
 */
export function isServerRecovering(res: { status: number }): boolean {
  return res.status === SERVER_RECOVERING_STATUS;
}
