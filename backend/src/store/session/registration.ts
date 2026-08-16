import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';

/**
 * 등록이 지금 열려 있는지 정하는 **유일한 규칙**.
 *
 * 마감에는 두 가지가 겹쳐 있다.
 *
 * - **상점이 손으로 닫은 것** — `Tournament.isRegistrationOpen` 컬럼. 상점이
 *   대회를 만들 때 정하고, 그 뒤로 바뀌지 않는다.
 * - **레벨이 지나가서 닫힌 것** — 블라인드가 `rebuyUntil`에 닿으면 자동이다.
 *
 * T47 전에는 이 둘이 **각자 다른 곳에 살았다.** 자동 마감은 Redis 해시에만
 * 쓰였고(`redis.service.ts`의 `checkAndSyncBlindLevel`), 결제 문지기는 DB
 * 컬럼만 봤다(`payment.service.ts`). 컬럼을 내리는 코드가 아무 데도 없어서,
 * 전광판에는 "등록 마감"인데 그 시각에 결제하면 참가가 됐다 — 블라인드가
 * 이미 커진 대회에 늦은 참가자가 돈을 내고 들어오고, 되돌리려면 환불이
 * 필요한데 환불 경로가 없다.
 *
 * 그래서 **판정을 한 곳으로 모은다.** 두 값을 합치는 식은 아래 하나뿐이고,
 * 결제·전광판·리바인이 전부 이것을 지난다.
 */
export function isRegistrationOpenAtLevel(
  manuallyOpen: boolean,
  currentLv: number,
  rebuyUntil: number,
): boolean {
  // `>=`이지 `===`가 아니다. 레벨은 시작 시각과 현재 시각으로 매번 다시
  // 계산되므로 한 번에 여러 칸 뛸 수 있다(재기동, 폴링 지연, 정지 시간 보정).
  // 정확히 일치할 때만 닫으면 마감 레벨을 밟지 못하고 지나간 대회는 등록이
  // 영영 열린 채로 남는다.
  return manuallyOpen && currentLv < rebuyUntil;
}

/**
 * 이 함수가 읽는 것만 받는다. Prisma 모델 전체를 받지 않는 이유는
 * `TournamentMetaSource`와 같다 — 호출자마다 `include`가 다르다.
 */
export interface RegistrationSource {
  isRegistrationOpen: boolean;
  rebuyUntil: number;
  startedAt: Date | null;
  pausedMs: number;
  blindStructure: { structure: unknown };
}

/**
 * **DB 행만으로** 지금 등록이 열려 있는지 계산한다.
 *
 * Redis를 보지 않는 것이 요점이다. 돈이 걸린 문지기(참가비 결제)의 정본을
 * 캐시에 두면, Redis를 잃은 동안 마감된 대회에 참가비가 들어온다 — 복구가
 * 메타를 다시 세우기 전까지 열린 창이다. 레벨을 정하는 재료(`startedAt`,
 * `pausedMs`, 블라인드 구조)가 전부 DB에 있으므로 캐시가 필요 없다.
 *
 * `pausedMs`를 더하는 이유: 장애로 서버가 멎어 있던 시간은 진행 시간이
 * 아니다. 블라인드 시계가 이미 같은 보정을 하므로(T31), 여기서 빼먹으면
 * 장애를 겪은 대회에서만 결제와 전광판이 서로 다른 레벨을 본다.
 *
 * **시작 전 대회에는 레벨이 없다.** `startedAt`이 null이면 기준점이 없어
 * 레벨을 물을 수 없다 — 사전 등록 구간이므로 상점의 스위치만 본다. 여기서
 * 0을 기준점으로 삼으면 경과가 수십 년이 되어 마지막 레벨이 나오고, 사전
 * 등록이 통째로 막힌다.
 */
export function isRegistrationOpenNow(t: RegistrationSource): boolean {
  if (!t.startedAt) return t.isRegistrationOpen;

  const structure = parseBlindStructure(t.blindStructure.structure);
  const blindBaseAt = t.startedAt.getTime() + t.pausedMs;
  const { currentIndex } = getCurrentBlindLevel(structure, blindBaseAt);
  const currentLv = structure[currentIndex]?.lv ?? 0;

  return isRegistrationOpenAtLevel(t.isRegistrationOpen, currentLv, t.rebuyUntil);
}
