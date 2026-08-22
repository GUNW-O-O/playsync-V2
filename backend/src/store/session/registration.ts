import { getCurrentBlindLevel, parseBlindStructure } from 'shared/util/util';

/**
 * 휴식 구간의 센티널. `getCurrentBlindLevel`이 이 값으로 `isBreak`을 정한다.
 * 센티널과 레벨 번호가 같은 필드에 있는 것이 T63의 뿌리인데, 계약을 바꾸면
 * 프론트·시드·복구가 함께 움직인다 — 판정 쪽에서 건너뛰는 것으로 좁혔다.
 */
const BREAK_LEVEL = 99;

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
/**
 * 마감 판정에 쓸 **레벨 번호**를 구조에서 뽑는다.
 *
 * **휴식은 레벨이 아니다.** 구조에서 휴식 구간은 `lv === 99`인 원소인데
 * (`BlindLevelSchema`가 `lv`에 상한을 안 거는 이유), 마감 판정은 같은 `lv`를
 * 숫자로 비교한다. 그래서 휴식에 들어가는 순간 `99 < rebuyUntil`이 어떤
 * 정상값에서도 거짓이 되고, 그 마감은 **단조라 되돌아오지 않는다**(T63).
 * 규정상 5레벨까지 리바인 가능한 대회에서 3레벨에 파산한 사람이 리바인 없이
 * 탈락한다 — `resolveWinners`가 `isRegistrationOpen`을 보고 팝업 자체를 안
 * 띄우기 때문이다.
 *
 * 휴식 중에는 **직전 실제 레벨**로 판정한다. 휴식은 시간이 흐를 뿐 블라인드가
 * 오르지 않는 구간이라, 그 사이의 등록 자격은 들어가기 직전과 같다.
 *
 * **이 계산이 호출자에 흩어지면 안 된다.** 판정하는 자리가 셋이고
 * (`isRegistrationOpenNow` · `getDashboardInfo` · `checkAndSyncBlindLevel`의
 * 자동 마감), 각자 "휴식이면 직전 것"을 적으면 한쪽만 고쳐지는 날이 온다 —
 * T47이 규칙을 한 곳으로 모은 것과 같은 이유다.
 *
 * 지나온 실제 레벨이 없으면(구조가 휴식으로 시작, 인덱스가 범위 밖) 0이다.
 * 0은 어떤 `rebuyUntil`보다도 작아 등록이 열린 것으로 판정된다 — 아직 아무
 * 레벨도 지나지 않았으니 그것이 맞다.
 */
export function currentRegistrationLevel(
  structure: { lv: number }[],
  currentIndex: number,
): number {
  for (let i = Math.min(currentIndex, structure.length - 1); i >= 0; i--) {
    const lv = structure[i]?.lv;
    if (lv !== undefined && lv !== BREAK_LEVEL) return lv;
  }
  return 0;
}

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

  return isRegistrationOpenAtLevel(
    t.isRegistrationOpen,
    currentRegistrationLevel(structure, currentIndex),
    t.rebuyUntil,
  );
}
