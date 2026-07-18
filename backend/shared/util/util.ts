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
export function parseBlindStructure(data: unknown): BlindLevelDto[] {
  if (!Array.isArray(data)) {
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