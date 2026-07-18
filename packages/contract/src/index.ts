import { z } from "zod";

/**
 * 마이그레이션 스모크 테스트용 export.
 *
 * 이 패키지는 백엔드/프론트엔드 경계를 넘는 것(WS 이벤트 페이로드, HTTP DTO,
 * 게임 상태)만 정의한다. DB 모델처럼 백엔드 내부에만 필요한 것은 포함하지 않는다.
 *
 * 실제 계약 정의는 이후 단계에서 채운다.
 */
export const ContractVersionSchema = z.literal("0.0.0");

export type ContractVersion = z.infer<typeof ContractVersionSchema>;

export const CONTRACT_VERSION: ContractVersion = "0.0.0";
