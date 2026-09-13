import { z } from "zod";

/**
 * Redis 장애 알림(T97). 좌석·딜러 소켓 전원에게 간다.
 *
 * **스냅샷 필드가 아니라 별도 이벤트다.** 장애 중에는 스냅샷을 쓸 수 없다 —
 * 스냅샷이 Redis에 있다. 서버 프로세스 메모리에서 바로 나가는 이벤트라야
 * 끊긴 순간에 닿는다.
 */
export const ServerOutageSchema = z.object({ down: z.boolean() });
export type ServerOutage = z.infer<typeof ServerOutageSchema>;
export const SERVER_OUTAGE_EVENT = "serverOutage" as const;

/**
 * REST가 장애 중에 내는 상태와 문구. **문구는 여기 한 곳에만 있다** — 백엔드
 * 필터·게이트웨이·프론트 화면이 전부 이 값을 쓴다. 화면마다 적으면 한쪽만
 * 고쳐지는 날이 온다.
 */
export const SERVER_RECOVERING_STATUS = 503 as const;
export const SERVER_RECOVERING_MESSAGE = "서버 장애를 복구하는 중입니다." as const;
