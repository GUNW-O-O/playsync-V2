import { BlindLevelDto } from "shared/dto/blind-structure.dto";
import { BlindTimingResult } from "shared/types/blind";

export function getCurrentBlindLevel(
  structure: BlindLevelDto[],
  startedAt: number
): BlindTimingResult {
  const now = Date.now();
  const elapsedMs = now - startedAt;
  let accumulatedMs = 0;

  for (let i = 0; i < structure.length; i++) {
    const levelMs = structure[i].duration * 60 * 1000;
    accumulatedMs += levelMs;

    if (elapsedMs < accumulatedMs) {
      const nextLevelAt = new Date(startedAt + accumulatedMs);
      return {
        currentIndex: i,
        nextLevelAt: nextLevelAt.getTime(), // 계산 편의를 위해 timestamp(number) 반환 권장
        isBreak: structure[i].lv === 99
      };
    }
  }

  // [수정 포인트] 모든 레벨을 초과한 경우 (마지막 레벨)
  // nextLevelAt을 현재로부터 24시간(86,400,000ms) 뒤로 설정하여 '레벨업 체크'에 걸리지 않게 함
  return {
    currentIndex: structure.length - 1,
    nextLevelAt: now + (24 * 60 * 60 * 1000),
    isBreak: structure[structure.length - 1].lv === 99
  };
}
/**
 * 앤티 금액을 sb에서 뽑는다.
 *
 * `TableEngine.payAnte`(`game-engine/table-engine.ts`)는 이 계산을 하지
 * 않는다 — 값을 받아서 쓸 뿐이다. `state.ante`를 채우는 자리가
 * `DealerService.startPreFlop`과 `RecoveryService`(스냅샷 재구성) 둘이라,
 * 계산식을 양쪽에 각각 적으면 T64가 막 걷어낸 "두 벌" 문제가 여기서 다시
 * 생긴다. 그래서 함수 하나로 묶는다(T58).
 *
 * `BlindLevelDto.sb`가 입구(`@IsDivisibleBy(5)`)에서 5의 배수로 강제되므로
 * 여기서 `Math.floor`하지 않는다. 소수가 나온다면 그건 경계를 지나온 값이
 * 이미 잘못됐다는 뜻이고, 몰래 반올림하면 그 오류를 감추는 것이다 — 딜러가
 * 모르는 사이에 칩이 증발한다.
 */
export function deriveAnteAmount(sb: number, hasAnte: boolean): number {
  return hasAnte ? sb / 5 : 0;
}

/**
 * 블라인드 구조를 **경계 밖으로 내보낼 모양**으로 바꾼다.
 *
 * 바뀌는 것은 `ante` 하나다 — DB와 입력 DTO는 "앤티가 붙나"(`boolean`)를 들고,
 * 계약(`BlindLevelSchema.ante`)은 금액을 받는다. 그 사이를 잇는 자리를 여기
 * 하나로 둔 이유는 `deriveAnteAmount`의 머리말과 같다: **식이 두 곳에 있으면
 * 한쪽만 고쳐지는 날이 온다.** 프론트가 `sb / 5`를 다시 적을 이유를 없앤다.
 *
 * **새 배열을 만든다.** 같은 배열을 내부 경로도 들고 있어서
 * (`DealerService.startPreFlop`이 보는 `blind.blindStructure`), 제자리에서
 * 고치면 그쪽의 `ante`가 숫자가 되어 `deriveAnteAmount(sb, 120)`처럼 불린다.
 */
export function toWireBlindStructure(
  structure: BlindLevelDto[],
): { lv: number; sb: number; ante: number; duration: number }[] {
  return structure.map(({ lv, sb, ante, duration }) => ({
    lv,
    sb,
    ante: deriveAnteAmount(sb, ante),
    duration,
  }));
}

export function parseBlindStructure(data: unknown): BlindLevelDto[] {
  if (!Array.isArray(data)) {
    throw new Error("Invalid blind structure");
  }

  // 빈 구조를 여기서 끊는다. 통과시키면 `getCurrentBlindLevel`이 마지막 레벨을
  // 읽는 대목에서 `structure[-1]`이 되어 `undefined.lv`로 죽는다. 입구(DTO)와
  // 여기가 둘인 것은 **검사가 둘**이라서가 아니라 경계가 둘이기 때문이다 —
  // DTO는 요청을, 여기는 DB에 이미 있는 행을 받는다.
  if (data.length === 0) {
    throw new Error("Invalid blind structure");
  }

  return data.map((item) => {
    if (
      typeof item.lv !== "number" ||
      typeof item.sb !== "number" ||
      typeof item.ante !== "boolean" ||
      typeof item.duration !== "number"
    ) {
      throw new Error("Invalid blind level format");
    }

    return item as BlindLevelDto;
  });
}