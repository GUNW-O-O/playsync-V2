import { ConflictException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PlayerStatus } from '@prisma/client';
import { PayMentDto } from 'shared/dto/payment.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  RegistrationGateSource,
  closeRegistration,
  isRegistrationOpenLive,
} from 'src/store/session/registration-gate';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import { approveCharge } from './mock-approval';
import * as playerOtp from './player-otp';
import { NOT_CLOSED_TOURNAMENT_FILTER, isClosedTournament } from 'src/store/session/tournament-status';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private user: UserService,
    private session: SessionService,
    private prismaService: PrismaService,
    private redisService: RedisService,
  ) { };

  /**
   * 가맹점 이름으로 검색. 가드가 없다 — 참가자용 대회 목록 화면
   * (`(player)/tournaments/page.tsx`의 `fetchStores('')`)이 빈 쿼리로
   * 불러 **전체 목록**을 받는 것을 그대로 쓴다. `contains: undefined`를
   * Prisma가 "조건 없음"으로 처리해서 빈 문자열이 전체 조회가 된다 —
   * 의도된 동작이라 유지한다(T66).
   *
   * `ownerId`는 select에서 뺀다. 가드도 페이징도 없는 공개 라우트라, 이
   * 목록을 그대로 두면 상점 관리자 uuid가 전부 열거됐다 — 화면
   * (`(player)/tournaments/page.tsx`의 `Store` 타입)이 쓰는 것도 `id`·
   * `name`뿐이다.
   */
  async searchStore(name: string) {
    return await this.prismaService.store.findMany({
      where: { name: { contains: name } },
      select: { id: true, name: true },
    });
  }

  // 해당 매장의 참가가능 토너먼트 정보
  async getStoreAvailableSessions(storeId: string) {
    return await this.prismaService.tournament.findMany({
      where: {
        storeId: storeId,
        status: NOT_CLOSED_TOURNAMENT_FILTER,
      },
      // 참가자용 조회다. 해시라도 응답에 실으면 안 된다.
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // `SessionService.getGameSession`을 재사용하지 않는다 — 그건 상점 콘솔의
  // 소유자 조회용이라 tornamentParticipations·tablePlayers까지 include한다.
  // 여기는 가드 없는 공개 라우트(`GET /tournaments/:id`)의 조회라 화면이
  // 실제로 읽는 필드만 select한다 — 참가자 목록·좌석 배정 같은 남의 정보가
  // 실려 나가지 않게.
  async getTournamentInfo(tournamentId: string) {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        isRegistrationOpen: true,
        entryFee: true,
        startStack: true,
        rebuyUntil: true,
        payoutTable: true,
        totalPlayers: true,
        activePlayers: true,
        avgStack: true,
        totalBuyinAmount: true,
        storeId: true,
        startedAt: true,
        createdAt: true,
        // `id`·`tableOrder`만 쓴다(`(terminal)/table/[tableId]/page.tsx`와
        // `(terminal)/dealer/table/[tableId]/page.tsx`가 테이블 번호를 구하는
        // 두 자리뿐이다). `tables: true`로 통째로 select하면 `dealerId`
        // (딜러 세션 FK)까지 가드 없는 공개 라우트로 나간다(T66).
        tables: { select: { id: true, tableOrder: true } },
        blindStructure: true,
      },
    });
    if (!tournament) throw new ConflictException('잘못된 세션 ID 입니다.');
    // **읽기 경로는 읽기만 한다.** 예전에는 좌석 해시가 비어 있으면 여기서
    // `tables[0]`의 비트맵을 다시 세웠다. 셋 다 틀린 일이었다.
    //
    // - 되살리는 대상이 0번 하나뿐이라, 테이블이 셋이면 둘은 없는 채로 남는다.
    //   유실도 정상도 아닌 세 번째 모양이 Redis에 남아 다음에 읽는 코드가
    //   무엇을 믿을지 정할 수 없게 된다.
    // - 되살린 값을 응답에 반영하지도 않았다. 이 함수가 돌려주는 `seatStatus`는
    //   그 위에서 이미 읽은 것이라 그대로 빈 배열이다 — 부르는 쪽이 얻는 것이
    //   없는 순수한 부수효과였다.
    // - 유실을 되세우는 권위는 `RecoveryService.recoverTournament`(T46) 하나다.
    //   그쪽은 좌석 행이 있는 테이블 **전부**를 스냅샷 기준으로 세운다.
    //   가드 없는 공개 조회가 두 번째 권위가 되면 둘이 어긋난다.
    const seatStatus = await this.redisService.getTournamentTables(tournamentId);
    return { tournament, seatStatus };
  }

  /**
   * 등록이 지금 열려 있는지 보고, 닫혔으면 거절한다.
   *
   * **컬럼(`Tournament.isRegistrationOpen`)만 보면 안 된다.** 그것은 상점이
   * 손으로 정한 스위치일 뿐이고, 블라인드가 `rebuyUntil`에 닿아 자동으로 닫힌
   * 마감은 담고 있지 않다. T47 전에는 이 문지기가 그 컬럼만 봐서, 전광판에는
   * "등록 마감"인데 그 시각에 결제하면 참가가 됐다.
   *
   * 무엇을 보는지는 대회가 시작했는지로 갈린다.
   *
   * - **시작 전**(`startedAt`이 없다): 레벨이라는 개념이 없다. 상점 스위치만 본다.
   *   Redis 대회 메타도 `startSession` 전에는 존재하지 않으므로 여기서 캐시를
   *   찾으면 사전 등록이 통째로 막힌다.
   * - **진행 중**: Redis 메타를 본다. 그 값은 핸드가 시작될 때마다
   *   `checkAndSyncBlindLevel`이 갱신하므로 이미 신선하고, DB에서 레벨을 다시
   *   계산할 이유가 없다 — 캐시를 둔 목적이 그것이다.
   * - **진행 중인데 메타가 없다**(Redis 유실): 거절하지 않는다. 레벨 재료
   *   (`startedAt`·`pausedMs`·블라인드 구조)가 전부 DB에 있어 **정확한 답을
   *   계산할 수 있다**. 이 드문 경로에서만 DB를 한 번 더 읽는다.
   *
   * 닫혀 있으면 거절하면서 **DB 컬럼도 닫는다**(아래). 판정 규칙 자체는
   * `registration.ts` 한 곳뿐이고, 전광판·리바인·여기가 모두 그것을 지난다.
   */
  private async assertRegistrationOpen(session: RegistrationGateSource) {
    const open = await isRegistrationOpenLive(this.prismaService, this.redisService, session);
    if (open) return;

    await closeRegistration(this.prismaService, session.id, (m) => this.logger.warn(m));
    throw new ConflictException('등록이 마감된 대회입니다.');
  }

  // 참가비 결제. **좌석은 여기서 정하지 않는다**(T28) — 오프라인에서 돈은
  // 미리 내고 의자는 현장에서 정해진다. 좌석 확정은 EntryService가 참가
  // OTP를 받는 순간에 한다.
  /**
   * 포인트 충전. **승인 판정과 반영을 갈라 둔다.**
   *
   * 목업이 성공/실패를 돌려주는 자리가 그 사이다(`approveCharge`). 지금은
   * 규칙이 한 줄이어도 그 경계가 있어야 나중에 실 PG를 끼워 넣을 수 있고,
   * 그때 이 함수는 판정의 출처만 바뀐다.
   *
   * **거절은 402고 포인트 부족은 409다.** 갈라야 화면이 "결제가 거절됐다"와
   * "돈이 모자란다"를 다르게 안내할 수 있다 — 전자는 다시 시도할 일이고
   * 후자는 충전할 일이다.
   *
   * 거절이면 트랜잭션을 아예 열지 않는다. 열고 던져도 되돌아가지만, **되돌릴
   * 것이 없는 일에 트랜잭션을 여는 것은 부하 아래서 공짜가 아니다** — 이
   * 경로는 부하가 실제로 밟는다(T72).
   */
  async chargePoint(userId: string, amount: number) {
    const approval = approveCharge(amount);
    if (!approval.approved) {
      throw new HttpException(approval.reason!, HttpStatus.PAYMENT_REQUIRED);
    }

    await this.prismaService.$transaction(async (tx) => {
      await this.user.chargePoint(tx, userId, amount);
    });

    return { charged: amount };
  }

  async joinSession(dto: PayMentDto, userId: string) {
    const user = await this.user.findByUUID(userId);
    const session = await this.prismaService.tournament.findUnique({
      where: { id: dto.tournamentId },
    });
    if (!session) throw new ConflictException('잘못된 세션 ID 입니다.');
    if (isClosedTournament(session.status)) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }
    await this.assertRegistrationOpen(session);
    if (user.points < session.entryFee) {
      throw new ConflictException('포인트가 부족합니다.');
    }

    // OTP가 대회 안에서 겹치면 다시 뽑는다. 8자리라 드물지만 드문 것은 안 나는
    // 것이 아니다. 트랜잭션 전체를 다시 도는 이유는 참가비 차감과 참가 생성이
    // 같은 트랜잭션 안이라 OTP만 따로 바꿀 수 없기 때문이다.
    let participation: { id: string; status: PlayerStatus } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        participation = await this.prismaService.$transaction(async (tx) => {
          await this.user.paymentPoint(
            tx, userId, dto.tournamentId, session.name, session.entryFee,
          );
          // 착석 여부와 무관하게 WAITING이다. PLAYING으로 올리는 것은
          // 입장(EntryService)의 몫이다 — PlayerStatus의 주석이 원래
          // 그렇게 적혀 있다("바이인 완료 후 대기" / "테이블 착석 중").
          //
          // 칩은 여기서 정해진다. 좌석이 아니라 **돈을 낸 것**이므로 T28이 그은
          // 경계(결제는 좌석을 정하지 않는다)를 넘지 않는다.
          const created = await tx.tournamentParticipation.create({
            data: {
              userId,
              tournamentId: dto.tournamentId,
              status: PlayerStatus.WAITING,
              currentStack: session.startStack,
              playerOtp: playerOtp.generatePlayerOtp(),
            },
          });
          // **닫힌 대회에는 쓰지 않는다.** 위의 `isClosedTournament`는
          // 트랜잭션 **밖**이라, 그 검사와 이 UPDATE 사이에 대회가 닫히면
          // 참가비와 참가 행이 죽은 대회에 들어간다. 조건이 걸리면 그 둘도
          // 함께 되돌아간다 — 같은 트랜잭션이다.
          await tx.tournament.update({
            where: { id: dto.tournamentId, status: NOT_CLOSED_TOURNAMENT_FILTER },
            data: {
              totalPlayers: { increment: 1 },
              // `activePlayers`는 **여기서 올리지 않는다**(T55). 결제는 "돈을
              // 냈다"이고 그 축은 위 둘(`totalPlayers`·`totalBuyinAmount`)이
              // 든다. 인원수가 세는 것은 지금 대회에 살아 있는 사람이고, 그건
              // 첫 착석(`EntryService`의 `claimSeat`)이 올린다 — 결제에서
              // 올리면 끝내 안 온 사람이 카운터에 영원히 남아 최후 1인 판정이
              // 걸리지 않는다.
              totalBuyinAmount: { increment: session.entryFee },
            },
          });
          return { id: created.id, status: created.status };
        });
        break;
      } catch (e) {
        // 같은 사람이 두 번 참가한 경우(tournamentId, userId)는 재시도해도
        // 같은 결과다. OTP 충돌만 다시 뽑는다.
        //
        // `meta.target`이 아니라 `meta.driverAdapterError...constraint.fields`를
        // 보는 이유: 드라이버 어댑터(@prisma/adapter-pg) 구성에서는 P2002 메타에
        // `target`이 없다. 대신 postgres가 준 제약 조건 정보를 그대로 담아
        // 필드 이름에 큰따옴표가 붙은 채로(`"playerOtp"`) 내려온다.
        const err = e as {
          code?: string;
          meta?: {
            target?: string[];
            driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
          };
        };
        const violatedFields =
          err.meta?.target ?? err.meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
        const isOtpCollision =
          err.code === 'P2002' && violatedFields.some((field) => field.includes('playerOtp'));
        if (isOtpCollision) continue;

        // **같은 사람이 같은 대회에 두 번 참가한 경우다.** 재시도해도 같은
        // 결과라는 판단은 예전부터 서 있었는데 응답이 안 붙어 있어서, 원본
        // P2002가 그대로 올라가 500이 됐다 — 화면에는 원인 없는 실패로
        // 보인다(`failureMessage`가 꺼낼 문구가 없다). 사람이 아는 상황이라
        // 안내가 가능하다.
        //
        // 전역 필터(`PrismaExceptionFilter`)도 P2002를 409로 내리지만 문구는
        // 일반적이다("이미 있는 값입니다"). 여기서 무엇이 겹쳤는지 아는 이상
        // 그 자리에서 말하는 편이 낫다.
        const isDuplicateEntry =
          err.code === 'P2002' && violatedFields.some((field) => field.includes('userId'));
        if (isDuplicateEntry) {
          throw new ConflictException('이미 참가한 대회입니다.');
        }

        // **참가하는 사이에 대회가 닫혔다.** 위 `where`의 `status` 조건이
        // 걸린 것이고, 재시도해도 같은 결과다(마감은 단조다). 그대로 올리면
        // P2025가 500이 되어 화면에 원인 없는 실패로 보인다 — 위에서 이미
        // 닫힌 대회를 거절할 때 쓰는 문구와 같은 문구를 준다.
        if (err.code === 'P2025') {
          throw new ConflictException('이미 닫힌 세션입니다.');
        }

        throw e;
      }
    }
    if (!participation) {
      throw new ConflictException('참가 OTP를 만들지 못했습니다. 다시 시도해 주세요.');
    }

    // 대회 카운터의 Redis 미러다. 방금 DB에 올린 세 필드와 같은 값이라
    // 좌석과 무관하고, 그래서 여기 남는다.
    await this.redisService.joinPlayer(dto.tournamentId, session.entryFee);

    return participation;
  }
}
