import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { isRegistrationOpenNow } from './registration';

/**
 * 등록 마감을 **읽는 경로**. 판정 규칙 자체는 `registration.ts` 하나뿐이고,
 * 여기는 그 규칙에 넣을 재료를 어디서 가져오는지만 정한다.
 *
 * **컬럼을 그대로 믿으면 안 된다.** `Tournament.isRegistrationOpen`은 마감
 * 시각에 스스로 닫히지 않는다 — 마감 시각에 발화하는 스케줄러가 없고,
 * `closeRegistration`이 **누군가 그 대회를 건드렸을 때만** 게으르게 flip한다.
 * 그래서 그 컬럼은 "상점이 손으로 닫았는가"에 가깝고, "지금 마감인가"는
 * **레벨에서 파생된 값**이다.
 *
 * T77이 그 둘을 같은 것으로 보고 원시 컬럼을 읽었다. 마감 레벨을 지났는데 그
 * 뒤 아무도 참가를 시도하지 않은 대회는 컬럼이 `true`로 남아, 파이널 테이블
 * 게이트가 헤즈업에서도 안 걸렸다.
 */

/**
 * 판정에 필요한 대회의 최소 형태.
 *
 * Prisma·Redis는 구체 타입을 받는다. 최소 인터페이스로 좁히려 했더니
 * `findUniqueOrThrow`의 실제 시그니처가 더 구체적이라 구조적으로 안 맞았고,
 * 억지로 맞추면 `unknown` 캐스팅이 늘어 오히려 타입이 약해진다. 좁혀서 얻는
 * 것(모델 전체를 안 넘긴다)은 아래 `RegistrationGateSource`가 이미 준다.
 */
export interface RegistrationGateSource {
  id: string;
  startedAt: Date | null;
  isRegistrationOpen: boolean;
}

/**
 * 지금 등록이 열려 있는가.
 *
 * **Redis를 먼저 본다.** `getTournamentDashboard`가 `checkAndSyncBlindLevel`을
 * 거쳐 동기화된 레벨로 판정을 다시 세우므로, 그 값은 스스로 최신이다.
 *
 * **없으면 DB만으로 같은 규칙을 다시 센다**(`isRegistrationOpenNow`). 레벨을
 * 정하는 재료(`startedAt` · `pausedMs` · 블라인드 구조)가 전부 DB에 있어
 * 캐시가 필요 없다 — Redis를 잃은 동안에도 마감이 유지된다.
 *
 * **시작 전 대회에는 레벨이 없다.** 그때는 상점의 스위치가 곧 답이다.
 */
export async function isRegistrationOpenLive(
  prisma: PrismaService,
  redis: RedisService,
  session: RegistrationGateSource,
): Promise<boolean> {
  if (!session.startedAt) return session.isRegistrationOpen;

  const dashboard = await redis.getTournamentDashboard(session.id);
  if (dashboard) return dashboard.isRegistrationOpen;

  const withBlind = await prisma.tournament.findUniqueOrThrow({
    where: { id: session.id },
    include: { blindStructure: { select: { structure: true } } },
  });
  return isRegistrationOpenNow(withBlind);
}

/**
 * 마감을 DB에도 남긴다. **한 번 닫히면 다시 열리지 않는다**(단조).
 *
 * 그래야 Redis를 잃은 뒤의 fallback이 이미 닫힌 상태에서 출발하고, 복구가
 * 정지 시간을 과잉 보정해 레벨이 한 칸 내려가는 경우에도(T31이 테스트로
 * 잡아 둔 자리) 등록이 되살아나지 않는다.
 *
 * **조건부 갱신이라 실제 쓰기는 최초 한 번뿐이다.** 이미 닫혔으면 0행이라,
 * 마감 뒤 요청이 몰려도 UPDATE가 반복되지 않는다.
 *
 * **실패해도 삼킨다.** 부르는 쪽은 이미 판정을 마쳤고, 이 쓰기는 다음 호출이
 * 다시 시도한다 — 여기서 던지면 "마감된 대회에 참가 실패"나 "파이널
 * 테이블이라 막았다"가 500으로 나가 원인을 가린다.
 *
 * @param onError 로깅. 호출자마다 로거가 달라 주입받는다.
 */
export async function closeRegistration(
  prisma: PrismaService,
  tournamentId: string,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await prisma.tournament.updateMany({
      where: { id: tournamentId, isRegistrationOpen: true },
      data: { isRegistrationOpen: false },
    });
  } catch (e) {
    onError(
      `등록 마감을 DB에 남기지 못했습니다 (tournament=${tournamentId}): ${(e as Error).message}`,
    );
  }
}
