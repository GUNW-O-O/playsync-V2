import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlayerStatus, Prisma, TournamentStatus } from '@prisma/client';
import type { FinishPreview } from '@playsync/contract';
import { CreateBlindStructureDto } from 'shared/dto/blind-structure.dto';
import { CreateTournamentDto, UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { generateDealerOtp, hashDealerOtp } from 'src/dealer/dealer-otp';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { GamePhase, TableState, createEmptyTableState } from 'src/game-engine/types';
import {
  DEFAULT_PAYOUT_TABLE,
  parsePayoutTable,
  PayoutTier,
} from 'src/playsync/payout-table';
import { awardPrize, prizePoolOf, rakeOf } from 'src/playsync/prize';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildTournamentMeta } from './tournament-meta';
import { isFinalTable } from './final-table';
import { LIVE_PLAYER_STATUSES, isLiveParticipant } from './player-status';
import { isRegistrationOpenLive } from './registration-gate';
import { calculateAbortSettlement, calculateChop, completeBlocker, groupAbortRefunds } from './settlement';
import { NOT_CLOSED_TOURNAMENT_FILTER, isClosedTournament } from './tournament-status';
import { FINISH_BLOCKERS } from './finish-blockers';

/**
 * 대회를 시작할 수 있는 최소 인원.
 *
 * 코드에는 2가 박혀 있었는데 제품 규칙이 아니라 **수동 테스트 편의**였다.
 * 크롬 창을 6개 띄우고 각각 로그인하는 데 드는 시간 때문에 낮춰둔 값이다.
 *
 * 그래서 2를 6으로 바꾸는 것은 답이 아니다 — 로컬에서 다시 못 돌리게 된다.
 * 환경으로 빼되 **기본값은 운영 규칙**이어야 한다. 기본값을 테스트 편의값으로
 * 두면 설정을 빠뜨린 배포가 조용히 2로 뜬다. T10의 `JWT_SECRET='super-secret'`과
 * 같은 실수다.
 *
 * 호출 시점에 읽는 것은 `rebuyTimeoutMs`와 같은 이유다 — 모듈 로드 시점에
 * 고정하면 테스트가 값을 바꿀 수 없다.
 */
function minPlayersToStart(): number {
  return Number(process.env.MIN_PLAYERS_TO_START ?? 6);
}

/**
 * `RedisService.withTableLock`이 락을 못 잡고 던진 것인가.
 *
 * 그쪽은 전용 타입 없이 문구로만 구별되는 `Error`를 던진다. 전용 타입으로
 * 바꾸면 그 변화가 `withTableLock`의 **모든** 호출자에 퍼지므로, 판별을
 * 여기서 문구로 한다. 두 자리가 한 쌍이라는 것을 여기 적어 둔다 —
 * `grep '락 획득 실패'`가 둘을 함께 낸다.
 *
 * 이것으로 거르는 이유는 그 실패가 **500에 인프라 언어**로 나가기 때문이다.
 * 상점 콘솔에 "락"은 없는 말이다(`domain.md`의 「상점도 손님이다」).
 */
function isTableLockTimeout(e: unknown): boolean {
  return e instanceof Error && e.message.includes('락 획득 실패');
}

@Injectable()
export class SessionService {
  constructor(
    private prismaService: PrismaService,
    private redis: RedisService,
    private otpAttempts: OtpAttempts,
    private readonly eventEmitter: EventEmitter2,
  ) { };

  // dealerOtpHash는 어느 조회 경로에도 담아 보내지 않는다 — 해시라도 값이
  // 새어 나가면 오프라인 무차별 대입을 시도할 수 있다.
  //
  // 쿼리마다 `omit`을 붙이지 않는다(T51). `PrismaService`가 기본을 감춤으로
  // 두므로 여기 아무것도 안 써도 해시는 안 나가고, 새 쿼리를 무심코 써도
  // 마찬가지다. 반대로 실으려면 명시해야 하고 그 줄이 리뷰에 보인다.
  async getGameSession(id: string) {
    return await this.prismaService.tournament.findUnique({
      where: { id },
      include: {
        tables: true,
        tornamentParticipations: true,
        tablePlayers: true,
        blindStructure: true,
      }
    });
  }


  /**
   * `GET /dealer/:id` — 딜러·좌석 태블릿이 **로그인 전**에 부르는 조회다.
   * 대기 화면(`(terminal)/dealer/page.tsx`·`(terminal)/table/page.tsx`)이
   * 테이블 목록을 그려야 OTP를 넣을 테이블을 고를 수 있는데, 그 시점의
   * 태블릿은 자격 증명이 하나도 없다 — 그래서 가드를 걸 수 없다
   * (`EntryController`의 `enter`·`seats`와 같은 이유).
   *
   * 가드를 못 거는 대신 **싣는 것을 줄인다.** 예전에는 `tables: true`가
   * `Tournament` 행 전체(해시만 제외)와 테이블의 `dealerId`(딜러 세션 FK)까지
   * 실었다(T66) — 소비자 셋(딜러/좌석 대기 화면, 상점 콘솔의 `fetchTables`)
   * 모두 `tables[].{id,tableOrder}`만 읽는다.
   */
  async getGameSessionWithTables(tournamentId: string) {
    return await this.prismaService.tournament.findUnique({
      where: {
        id: tournamentId,
        status: NOT_CLOSED_TOURNAMENT_FILTER,
      },
      select: {
        id: true,
        tables: { select: { id: true, tableOrder: true } },
      },
    });
  }

  // 해당 매장의 전체 토너먼트 정보
  async getStoreAllSessions(storeId: string, ownerId: string) {
    await this.assertStoreOwnership(storeId, ownerId);

    return await this.prismaService.tournament.findMany({
      where: {
        storeId: storeId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createBlind(blindStructure: CreateBlindStructureDto) {
    const blind = await this.prismaService.blindStructure.create({
      data: {
        name: blindStructure.name,
        structure: blindStructure.structure as any,
        storeId: blindStructure.storeId
      }
    })
    return blind;
  }

  async createSession(
    dto: CreateTournamentDto,
    ownerId: string,
    blindStructure?: CreateBlindStructureDto,
  ) {
    // 대회가 어느 상점에 속하는지는 요청이 정한다(`dto.storeId`). 그래서
    // 여기서 묻지 않으면 상점주 아무나 남의 상점에 대회를 세울 수 있다 —
    // 그 대회의 참가비와 상금은 남의 상점 장부에 얹힌다.
    await this.assertStoreOwnership(dto.storeId, ownerId);

    // blindId와 blindStructure 둘 다 선택 인자라 "아무것도 안 넘긴" 호출이
    // 타입상 합법이다. 예전에는 그때 자리 채우기용 문자열이 FK로 들어갔고,
    // 운이 좋으면 외래키 에러로 즉시 죽고 운이 나쁘면 생성만 성공한 뒤
    // startSession의 blindStructure.structure 접근에서 죽었다 — 참가자가
    // 다 앉은 다음에. 기본값을 고치는 대신 입구에서 거부한다.
    if (!dto.blindId && !blindStructure) {
      throw new BadRequestException('블라인드 구조 정보가 필요합니다.');
    }

    // **상점 id가 요청에 두 번 실린다.** `dto.storeId`만 확인하면 나머지
    // 하나가 그대로 통과한다 — 본인 상점 대회를 만들면서 블라인드 구조는
    // 남의 상점에 심거나(아래 create의 storeId), 남의 상점 구조를 자기 대회에
    // 붙일 수 있다. 소유권은 위에서 한 번 봤으므로 여기서는 **두 값이 같은
    // 상점을 가리키는지**만 본다.
    if (blindStructure && blindStructure.storeId !== dto.storeId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
    if (dto.blindId) {
      await this.assertBlindBelongsToStore(dto.blindId, dto.storeId);
    }

    // dto.blindId(기존 구조 재사용)가 우선이고, 없을 때만 새로 만든다.
    // 이 시점 이후 blindId는 반드시 실재하는 BlindStructure를 가리킨다.
    let blindId = dto.blindId;
    if (!blindId) {
      const newBlind = await this.prismaService.blindStructure.create({
        data: {
          name: blindStructure!.name,
          structure: blindStructure!.structure as any,
          storeId: blindStructure!.storeId
        }
      })
      blindId = newBlind.id;
    }
    // 구간표는 트랜잭션 밖에서 검증한다. 합이 100이 아닌 구간은 그 규모의
    // 대회가 실제로 열리는 날에야 드러나는데, 그때는 이미 돈이 나간 뒤다.
    //
    // **안 주면 기본표다**(T81). 상금권 인원이 참가 규모를 따라가는 것이
    // 기본 동작이어야 한다 — 고정하고 싶으면 구간 하나짜리 표를 주면 된다.
    let table: PayoutTier[];
    try {
      table = parsePayoutTable(dto.payoutTable ?? DEFAULT_PAYOUT_TABLE);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    // 트랜잭션 진입 전에 뽑아 둔다. bcrypt 해싱은 CPU 작업이라 트랜잭션 안에서
    // 돌리면 그동안 DB 커넥션을 잡은 채 기다린다.
    const dealerOtp = generateDealerOtp();
    const dealerOtpHash = await hashDealerOtp(dealerOtp);

    const sessionInfo = await this.prismaService.$transaction(async (tx) => {
      // 1. 기본 게임 세션 생성 (블라인드 구조 연결 및 OTP 생성 포함)
      const session = await tx.tournament.create({
        data: {
          name: dto.name,
          type: dto.type,
          storeId: dto.storeId,
          payoutTable: table as unknown as Prisma.InputJsonValue,
          blindId: blindId,
          dealerOtpHash,
          startStack: dto.startStack,
          avgStack: dto.startStack,
          entryFee: dto.entryFee,
          rakePercent: dto.rakePercent ?? 0,
          rebuyUntil: dto.rebuyUntil,
          isRegistrationOpen: dto.isRegistrationOpen,
        },
      });

      const dealerSession = await tx.dealerSession.create({
        data: { tournamentId: session.id },
      });

      await tx.table.create({
        data: {
          tableOrder: 1,
          tournamentId: session.id,
          dealerId: dealerSession.id,
        }
      });
      const updatedSession = await tx.tournament.findUnique({
        where: { id: session.id },
          include: {
          tables: true,
        }
      });
      return updatedSession;
    });
    if (!sessionInfo) throw new InternalServerErrorException('세션을 만들지 못했습니다.');
    await this.redis.setSeatBitmap(sessionInfo.id, sessionInfo.tables[0].id);
    // **스냅샷의 수명을 테이블의 수명에 맞춘다.** T38이 `createTable`에서
    // 세운 불변식("테이블이 있으면 스냅샷이 있다")은 대회 생성 경로에도
    // 걸려야 한다. 아니면 "스냅샷이 없다"가 유실과 정상 둘 다를 뜻하게 되고,
    // 딜러가 손님보다 먼저 붙는 실제 순서에서 `GET /playsync/:tableId`가
    // 500을 낸다.
    await this.redis.saveSnapshotUnlocked(
      sessionInfo.tables[0].id,
      createEmptyTableState(sessionInfo.id),
      'table-created',
    );

    // 평문은 여기 한 번만 실린다. 저장은 해시로만 했으므로 이후로는 어디에도
    // 남지 않는다 — 상점 콘솔이 이 응답을 보여주는 것이 유일한 열람 경로다.
    return { ...sessionInfo, dealerOtp };
  }

  /**
   * 테이블을 하나 더 연다. 상점 콘솔의 버튼이 여기로 온다.
   *
   * 예전에는 착석이 좌석 점유 수를 세어 자동으로 불렀다. 소리 없이 늘어난
   * 테이블에 앉은 손님은 아무도 응대하지 못한다 — 테이블을 여는 것은 딜러를
   * 배치하고 칩을 세팅하는 물리적 행위다.
   *
   * `tableOrder`는 트랜잭션 **안에서** 최댓값을 뽑아 다음 번호를 정한다. 밖에서
   * 뽑으면 동시 호출이 같은 번호를 읽는다. 최종 방어는
   * `@@unique([tournamentId, tableOrder])`다.
   */
  async createTable(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { dealerSession: true },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    // completeSession·cancelSession이 대회를 닫으며 테이블과 딜러 세션을 함께
    // 지운다. 여기서 만들면 죽은 대회에 테이블이 되살아난다.
    if (isClosedTournament(tournament.status)) {
      throw new ConflictException('이미 닫힌 대회입니다.');
    }
    if (!tournament.dealerSession) {
      throw new ConflictException('딜러 세션이 없는 대회에는 테이블을 추가할 수 없습니다.');
    }
    const dealerId = tournament.dealerSession.id;

    // Task 2가 만든 private 헬퍼. P2002를 409로 바꾼다.
    const newTable = await this.insertTable(tournamentId, dealerId);

    await this.redis.setSeatBitmap(tournamentId, newTable.id);
    // **스냅샷의 수명을 테이블의 수명에 맞춘다.**
    //
    // 예전에는 스냅샷을 만드는 지점이 착석 하나뿐이었다. 그래서 물리 순서가
    // 그대로 결함이 됐다 — 딜러가 먼저 붙고 손님이 나중에 앉는데, 그 사이에
    // 딜러 화면이 부르는 `GET /playsync/:tableId`가 스냅샷 없음을 맨 `Error`로
    // 던져 500이 났다(`PlaysyncService.joinTable`). 정상 상태에 서버 오류다.
    //
    // 여기서 세우면 **"스냅샷이 없다"의 뜻이 하나로 좁아진다 — 유실이다.**
    // `deleteTable`이 이미 대칭으로 `deleteTableState`를 부른다.
    //
    // 락을 잡지 않는다. `newTable.id`는 방금 INSERT된 것이라 이 시점에 그
    // 테이블을 아는 경로가 아직 없다. 브로드캐스트보다 먼저 쓰는 것도
    // 그래서다 — `SEAT_LIST_UPDATED`를 보고 들어오는 화면이 상태를 찾지
    // 못하면 안 된다.
    await this.redis.saveSnapshotUnlocked(
      newTable.id,
      createEmptyTableState(tournamentId),
      'table-created',
    );
    await this.emitSeatList(tournamentId);

    return newTable;
  }

  /**
   * 잘못 연 테이블을 닫는다.
   *
   * **빈 테이블만** 지운다. `TablePlayer`는 `onDelete: Cascade`라 사람이 앉은
   * 테이블을 지우면 참가자 행이 조용히 함께 사라진다 — 참가비를 낸 사람이
   * 장부에서 없어지는 것이라 거부한다.
   *
   * **마지막 하나는 지우지 않는다.** 대회에 테이블이 0개인 상태는 어느 경로도
   * 상정하지 않는다.
   *
   * `tableOrder`는 재정렬하지 않는다. 2번을 지우면 1, 3이 남는다. 번호는
   * 물리 테이블을 가리키므로, 재정렬하면 전광판과 딜러 화면이 부르는 번호가
   * 통째로 바뀌어 방 안의 테이블과 어긋난다.
   */
  async deleteTable(tournamentId: string, tableId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    await this.prismaService.$transaction(async (tx) => {
      // 대상 행을 **먼저 잠근다.** 이 한 줄이 아래 점유 검사의 근거 전부다.
      //
      // TablePlayer의 INSERT는 외래키 때문에 부모 Table 행에 FOR KEY SHARE를
      // 자동으로 건다. FOR UPDATE는 그것과 충돌하므로 두 방향 모두 직렬화된다.
      //
      //  - 좌석 확정이 먼저 꽂았고 아직 커밋 전이면, 이 SELECT가 그 커밋까지
      //    막힌다. 풀린 뒤의 점유 검사는 **새 문장**이고 Read Committed는
      //    문장마다 스냅샷을 다시 뜨므로, 방금 커밋된 TablePlayer가 보인다 →
      //    409로 거부한다.
      //  - 이쪽이 먼저 잠갔으면 좌석 확정의 INSERT가 막힌다. 삭제를 커밋하고
      //    나면 그 INSERT는 외래키 위반으로 실패하고, `EntryService.claimSeat`의
      //    트랜잭션이 통째로 롤백된다(T28부터 이 INSERT는 결제가 아니라 입장이
      //    한다). 그쪽을 고칠 필요가 없는 이유가 이것이다 — 충돌하는 락을
      //    이미 걸고 있다.
      //
      // 예전에는 `deleteMany({ where: { ..., tablePlayers: { none: {} } } })`
      // 한 문장이 "구조로 막는다"고 적혀 있었지만 **그 보장은 성립하지 않았다.**
      // NOT EXISTS 서브쿼리는 DELETE 문장의 스냅샷으로 평가된다. DELETE는 그
      // 뒤 동시 INSERT가 쥔 FOR KEY SHARE에 막히는데, 상대가 커밋하면
      // 서브쿼리를 **다시 보지 않고** 그대로 진행한다(EvalPlanQual은 대상 행이
      // UPDATE된 경우만 재평가하고, 여기서는 key-share로 잠겼을 뿐이다).
      // 결과는 삭제 1건 + cascade로 방금 앉은 참가자 소멸이었다. 두 커넥션으로
      // 재현했다.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Table"
        WHERE id = ${tableId} AND "tournamentId" = ${tournamentId}
        FOR UPDATE
      `;
      // 404("테이블을 찾을 수 없습니다")와 아래 409를 구분되는 메시지로 남긴다.
      if (locked.length === 0) throw new NotFoundException('테이블을 찾을 수 없습니다.');

      const occupied = await tx.tablePlayer.count({ where: { tableId } });
      if (occupied > 0) {
        throw new ConflictException('좌석에 참가자가 있는 테이블은 삭제할 수 없습니다.');
      }

      // 마지막 하나는 남긴다. 대회는 테이블이 최소 하나 있다는 전제 위에 서
      // 있다 — `createSession`이 1번을 함께 만들고, 참가자는 좌석 목록에서
      // 자리를 고른다. 테이블이 0개인 대회는 열려 있는데 아무도 앉을 수 없는
      // 상태이고, 다시 여는 길은 상점 콘솔의 테이블 추가뿐이다.
      //
      // 예전에는 여기 근거로 `getTournamentInfo`가 `tables[0]`을 읽어 500을
      // 낸다고 적혀 있었다. 그 경로는 T52에서 통째로 사라졌다(읽기 경로는
      // 비트맵을 되살리지 않는다). 근거는 바뀌었지만 규칙은 남는다.
      const remaining = await tx.table.count({ where: { tournamentId } });
      if (remaining <= 1) {
        throw new ConflictException('대회의 마지막 테이블은 삭제할 수 없습니다.');
      }

      // **Redis를 먼저 치우고, 그것이 확인된 뒤에 DB를 지운다.**
      //
      // 예전에는 트랜잭션이 커밋된 **뒤에** 이 둘을 불렀다. 그 호출이 실패하면
      // DB에 없는 테이블이 좌석 목록에 24시간 남고, 그 자리를 고른 손님은
      // `tablePlayer.create`의 외래키 실패로 이유 없는 500을 본다. 아무도 안
      // 치운다 — DB에 행이 없으니 복구도 그 테이블을 모른다.
      //
      // 뒤집었을 때의 실패 모양이 더 낫다. Redis가 실패하면 트랜잭션이 통째로
      // 롤백돼 아무것도 안 지워지고 상점은 다시 누르면 된다. DB 커밋이
      // 실패하면 Redis만 지워진 채로 남는데, 그건 목록에서 잠시 사라지는
      // 것뿐이고 **재기동하면 복구가 되살린다**(T44가 빈 스냅샷을, T46이
      // 비트맵을 세운다). 어느 쪽으로 실패해도 스스로 낫거나 재시도로 끝난다.
      //
      // **검사 셋을 통과한 뒤라는 위치가 요건이다.** 트랜잭션 맨 앞으로 옮기면
      // 404 · 409로 거절되는 경로에서 **살아남은 테이블의** 비트맵과 스냅샷을
      // 날린 것이 된다.
      //
      // 왕복이 각각 하나로 정해져 있어 `docs/domain.md`의 "기다림이 무한정인
      // 일 금지"를 어기지 않는다.
      await this.redis.removeSeatBitmap(tournamentId, tableId);
      // 스냅샷도 함께 지운다. 남겨두면 24시간 동안 사라진 테이블의 게임 상태가
      // 떠 있고, 같은 id가 다시 쓰이지 않더라도 `completeSession`이 지우는 대상
      // 목록에서는 이미 빠져 있어 영영 남는다.
      await this.redis.deleteTableState(tableId);

      await tx.table.delete({ where: { id: tableId } });
    });

    await this.emitSeatList(tournamentId);
  }

  /**
   * 좌석 목록 브로드캐스트.
   *
   * 예전에는 `createTable`이 착석 경로 안에서만 불려서, 바로 뒤의 `buyIn`이
   * 대신 이벤트를 냈다. 상점이 단독으로 부르면 아무도 내지 않아 전광판과
   * 좌석 목록이 새 테이블을 모른다.
   */
  private async emitSeatList(tournamentId: string) {
    const state = await this.redis.getTournamentTables(tournamentId);
    this.eventEmitter.emit('SEAT_LIST_UPDATED', { tournamentId, state });
  }

  /**
   * 다음 번호를 정하고 행을 넣는다.
   *
   * 번호는 **개수가 아니라 최댓값**에서 뽑는다. `deleteTable`이 번호를
   * 재정렬하지 않기 때문이다(그 이유는 `deleteTable`의 주석에 있다). 1·2·3을
   * 만들고 2를 지우면 남는 것은 1과 3인데, 개수는 2라 `count + 1`은 이미
   * 쓰이고 있는 3을 고른다. 유니크 제약이 P2002로 거부하고 아래 409("다시
   * 시도해 주세요")가 나가지만, 다시 눌러도 같은 계산이라 영원히 같은 결과다 —
   * 그 대회의 테이블 추가가 통째로 죽는다. 번호가 비는 것을 감수한 결정이
   * 번호를 세는 쪽과 어긋나 있었다.
   *
   * Read Committed에서는 동시 트랜잭션이 같은 최댓값을 볼 수 있으므로,
   * `@@unique([tournamentId, tableOrder])`가 뒤늦은 쪽을 P2002로 거부한다.
   * 그대로 두면 500이 나가므로 409로 바꾼다 — 이쪽은 다시 누르면 실제로
   * 풀리는 상황이고, 서버 오류가 아니다.
   */
  private async insertTable(tournamentId: string, dealerId: string) {
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const { _max } = await tx.table.aggregate({
          _max: { tableOrder: true },
          where: { tournamentId },
        });
        // 테이블이 하나도 없는 대회면 _max는 null이다. 그때의 첫 번호는 1.
        const nextOrder = (_max.tableOrder ?? 0) + 1;
        return await tx.table.create({
          data: { tableOrder: nextOrder, tournamentId, dealerId },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('테이블 추가가 동시에 요청되었습니다. 다시 시도해 주세요.');
      }
      throw e;
    }
  }

  /**
   * 대회를 실제로 시작한다.
   *
   * 두 단계의 성격이 다르다. `initializeGame`은 **준비** — 게임 상태를 Redis에
   * 올리는 일이고, 이 시점에는 아직 아무도 그것을 보지 않는다. 그래서 실패해도
   * 되돌릴 것이 없다. 여기 커밋이 **시작** — 웹이 읽는 것은 DB이므로, 참가자
   * 눈에 "시작했다"가 보이는 순간이 바로 이 한 줄이다.
   *
   * 순서가 이 방향이어야 하는 이유: 반대면 Redis가 실패했을 때 DB만 진행 중으로
   * 남고 되돌릴 수 없다 — 이미 커밋된 뒤다. 참가자에게는 시작한 것으로 보이는데
   * 실제 게임 상태는 어디에도 없다.
   *
   * 예전에는 `initializeGame`이 `startedAt`과 참가자 `PLAYING`을 먼저 커밋하고
   * Redis를 나중에 썼다. 준비 단계가 시작 사실을 써버린 셈이다.
   *
   * 실패하면 `PENDING`으로 남으므로 **시작 버튼을 다시 누르는 것이 곧 재시도**다.
   * T9처럼 별도의 재시도 명령이 필요 없는 것은, 준비 단계가 전부 덮어쓰기라
   * 몇 번을 돌려도 같은 결과이기 때문이다.
   *
   * 소유권 확인이 첫 줄인 것은 다른 운영 조작(`createTable`, `deleteTable`,
   * `reissueDealerOtp`, `revokeDealerSession`)과 같은 이유다 — 서버 액션이
   * `tournamentId`를 클라이언트 값 그대로 넘기므로, 이게 없으면 A 상점
   * 관리자가 B 상점 대회를 시작시킬 수 있다.
   */
  async startSession(id: string, ownerId: string) {
    await this.assertTournamentOwnership(id, ownerId);

    const { startedAt, buttons, tableStates } = await this.initializeGame(id);

    // 참가자 상태는 여기서 건드리지 않는다. `PLAYING`은 **착석**이 올린다
    // (T28의 `EntryService`). 예전에는 이 자리에서 대회의 참가자 전원을
    // 조건 없이 승격시켰는데, 그러면 결제만 하고 오지 않은 사람도 시작 버튼
    // 한 번에 `PLAYING`이 되고 `tournamentFinished`의
    // `findFirst({ where: { status: PLAYING } })`가 한 번도 앉지 않은 사람을
    // 우승자로 뽑을 수 있었다.
    const started = await this.prismaService.$transaction(async (tx) => {
      // 첫 버튼 추첨 결과를 시작과 같은 트랜잭션에 남긴다. 이것이 없으면
      // 첫 핸드가 끝나기 전에 죽었을 때 복구가 읽을 버튼이 없다 — 핸드 종료
      // 체크포인트가 첫 독자가 되기 전까지 null인 구간이 생긴다.
      for (const b of buttons) {
        await tx.table.update({
          where: { id: b.tableId },
          data: { buttonUser: b.buttonUser },
        });
      }

      // startedAt은 준비 단계가 정한 값을 그대로 쓴다. 여기서 다시 찍으면
      // 대회 시작 시각이 Redis에 올린 블라인드 기준점보다 뒤가 되어, 시작
      // 직후 경과 시간이 음수 방향으로 벌어진다.
      //
      // 단 이 둘은 **같은 값을 유지해야 하는 관계가 아니다**(T31). 이 컬럼은
      // 대회가 실제로 시작한 시각이고 영구히 밀리지 않는다. Redis의
      // BlindField.startedAt은 진행 시간의 기준점이라 장애 정지만큼 뒤로
      // 밀린다. 시작 시점에 두 값이 같은 것은 정합이 아니라 t=0의 우연이다.
      return await tx.tournament.update({
        where: { id },
        data: { status: TournamentStatus.ONGOING, startedAt },
        });
    });

    /*
      **버튼은 지금 추첨됐다.** 그 결과가 스냅샷에만 남고 아무에게도 안 가면
      딜러와 좌석 태블릿의 펠트는 첫 핸드가 시작될 때까지 버튼이 어디 있는지
      모른다 — 딜러에게 "이제 시작해도 된다"를 알려 주는 변화가 화면에
      아무것도 없다는 뜻이기도 하다.

      좌석 해제·착석과 같은 자리다. 커밋이 끝난 뒤에 알린다.
    */
    for (const t of tableStates) {
      this.eventEmitter.emit('game.state.updated', { tableId: t.tableId, state: t.state });
    }

    return started;
  }

  /** 게임 상태를 Redis에 올린다. 아직 시작이 아니다 — 커밋은 호출자가 한다. */
  private async initializeGame(id: string) {
    // 1. DB에서 세션과 모든 테이블/플레이어 정보를 한 번에 가져옴
    const game = await this.prismaService.tournament.findUnique({
      where: { id },
      include: {
        tables: {
          include: {
            tablePlayers: true,
          }
        },
        blindStructure: true,
      }
    });

    const startedAt = new Date();
    if (!game) throw new NotFoundException('세션을 찾을 수 없습니다.');
    const { dashboard, blindField, payoutTable } = buildTournamentMeta(game, startedAt.getTime());

    const minPlayers = minPlayersToStart();
    if (game.totalPlayers < minPlayers) {
      throw new ConflictException(
        `시작하기에 충분한 인원이 아닙니다. (${game.totalPlayers}/${minPlayers}명)`,
      )
    }

    const seatedTables = game.tables.filter(t => t.tablePlayers.length > 0);

    /*
      **읽기와 쓰기가 같은 락 안에 있어야 한다**(T61). 예전에는 `getSnapShot`으로
      락 밖에서 읽고, `buttonUser`를 대입하고, 메타 왕복을 한 번 더 한 뒤
      `saveInitialTableSnapshots`가 `pipeline.set`으로 락 밖에서 썼다. 전형적인
      read-modify-write인데 중간에 왕복이 하나 더 껴서 창이 넓었다.

      그 창에 `EntryService.claimSeat`(락을 정상적으로 잡는다)이 끼면, DB 좌석
      행·좌석 비트맵·`activePlayers`는 새로 앉은 사람을 아는데 **게임 스냅샷에서만
      그가 지워진다.** 딜러가 그를 포함해 딜할 수 없고, `releaseSeats`의 스냅샷
      점유자 대조가 통과하지 않아 상점도 그를 뗄 수 없다. 부팅 복구도 스냅샷이
      "있으므로" 손대지 않는다. **대회 시작 순간이 착석이 가장 몰리는 시각**이라
      창이 가장 넓을 때 열려 있었다.

      버튼 추첨은 DB의 좌석 행에서 그대로 뽑는다. 버튼은 앉아 있는 사람 중
      아무나면 되므로 락 안의 스냅샷과 한 칸 어긋나도 무해하다 — 지켜야 하는
      것은 "덮어쓰지 않는다"뿐이다.

      사람이 앉은 테이블에 스냅샷이 없으면 **거부한다.** 예전에는 `return null`로
      조용히 빼고 진행했다 — 그 테이블만 상태 없이 시작되고, DB에는 사람이
      앉아 있는데 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를 이유도
      모른 채 본다. 게다가 전부 빠져도 대회는 시작됐다.

      **판정이 락 안으로 들어와 부분 쓰기가 생긴다** — 앞 테이블은 `buttonUser`가
      써지고 뒤 테이블에서 던진다. 감수한 것이다. 실패하면 대회는 `PENDING`으로
      남고 **시작 버튼을 다시 누르는 것이 곧 재시도**이며, 준비 단계는 메타도
      스냅샷도 전부 덮어쓰기라 몇 번을 돌려도 같은 결과다(`startSession`의
      주석이 그 근거를 든다).
    */
    let tableStates: { tableId: string; state: TableState | null }[];
    try {
      tableStates = await Promise.all(
        seatedTables.map(async t => {
          const randomCnt = Math.floor(Math.random() * t.tablePlayers.length);
          const btnIdx = t.tablePlayers[randomCnt].seatPosition;

          const state = await this.redis.mutateSnapshot(t.id, async (snapshot) => {
            if (!snapshot) return null; // 없으면 쓰지 않고 나간다. 아래에서 거부한다
            snapshot.buttonUser = btnIdx;
            return snapshot;
          });
          return { tableId: t.id, state };
        }),
      );
    } catch (e) {
      // 락 획득 실패**만** 고른다. 나머지(Redis 장애 등)는 그대로 올라가야
      // 한다 — 여기서 뭉뚱그리면 진짜 장애가 "잠시 후 다시"로 위장된다.
      //
      // 이 실패는 이 티켓이 새로 연 경로다. 준비가 테이블 락을 잡게 되면서
      // `withTableLock`의 5초 대기가 시작 경로에 들어왔다. 실제로 닿는다 —
      // `releaseSeats`는 `FOR UPDATE` 대기 때문에 5초를 넘길 수 있다고
      // `domain.md`가 명시적으로 감수한 자리라, 좌석 해제 중에 상점이 시작을
      // 누르면 이 갈래다.
      //
      // 그대로 두면 500에 "락 획득 실패"가 나간다. 상점이 할 수 있는 일로
      // 바꾼다 — 다시 누르는 것이 곧 재시도인 상황이므로 409가 맞다.
      if (!isTableLockTimeout(e)) throw e;
      throw new ConflictException(
        '지금 다른 조작이 처리 중입니다. 잠시 후 다시 시작해 주세요.',
      );
    }

    const missing = tableStates.filter(t => t.state === null).map(t => t.tableId);
    if (missing.length > 0) {
      throw new ConflictException(
        `테이블 상태가 준비되지 않아 시작할 수 없습니다: ${missing.join(', ')}`,
      );
    }

    /*
      **거부되는 시작은 메타를 남기지 않는다.** 그래서 이 왕복이 위 거부 검사
      뒤에 있다. 위로 올리면 락 밖이라는 점은 그대로지만 — 락은 각
      `mutateSnapshot` 안에서 열리고 닫히므로 그 밖의 문장은 앞이든 뒤든 락
      밖이다 — 얻는 것 없이 누출만 생긴다.

      **`blindField`의 존재가 "대회가 시작했다"의 대용으로 읽히기 때문이다.**
      착석의 `syncActivePlayer`도 시작 전에 `tournament:{id}:info`를 만들지만
      `blindField`는 쓰지 않아서, 그 필드의 유무가 판별식으로 서 있다.

      - `DealerService.startPreFlop`이 대회 상태를 보는 검사는
        `checkAndSyncBlindLevel`의 결과 하나뿐이다. 메타가 새면 그 문이 열려
        `PENDING` · `startedAt`이 null인 대회에서 실제로 핸드가 돈다. 그리고
        `cancelSession`은 `startedAt`으로만 막으므로, 칩이 움직인 뒤에도 전액
        환불 취소가 통과한다. 거부는 대회 단위인데 스냅샷은 테이블 단위라
        위 `missing`이 이것을 대신 막아 주지도 못한다 — 스냅샷이 멀쩡한 형제
        테이블의 딜러는 그대로 통과한다.
      - `PlaysyncService.getDashboardInfo`는 새어 나온 `blindField.startedAt`을
        전광판에 그리고, 그 폴링이 `checkAndSyncBlindLevel`을 밀어 **시작하지도
        않은 대회의 블라인드 시계가 스스로 올라간다.**
    */
    await this.redis.setTournamentMeta(id, dashboard, blindField, payoutTable);

    // 뽑은 버튼을 호출자에게 넘긴다. 여기서 DB에 쓰지 않는 이유는 이 메서드가
    // "아직 시작이 아니다"라는 계약을 갖기 때문이다 — 커밋은 startSession의
    // 트랜잭션 하나뿐이어야 실패 시 PENDING으로 남아 재시도가 성립한다.
    //
    // 넘기는 것은 **락 안에서 실제로 저장된 상태**다(`mutateSnapshot`의 반환값).
    // 락 밖에서 만든 사본을 넘기면 `startSession` 끝의 `game.state.updated`가
    // 저장된 것과 다른 판을 내보낸다 — 방금 앉은 사람이 화면에서만 사라진다.
    const ready = tableStates.filter(
      (t): t is { tableId: string; state: TableState } => t.state !== null,
    );
    const buttons = ready.map(t => ({ tableId: t.tableId, buttonUser: t.state.buttonUser }));

    return { startedAt, buttons, tableStates: ready };
  }

  // 세션 완료
  /**
   * 대회를 닫는다. **되돌릴 수 없다** — 테이블과 딜러 세션을 지우고 Redis를
   * 비우므로, 그 뒤에는 누가 몇 등이었고 얼마를 받아야 했는지 재구성할 근거가
   * 남지 않는다.
   *
   * 그래서 정산이 끝난 뒤에만 닫힌다. 걷은 참가비와 나간 상금의 합이 같아야
   * 한다 — 대회 하나의 회계가 맞아떨어졌다는 뜻이다.
   *
   * 마무리가 수동인 것은 설계다. ICM 찹으로 끝나는 대회가 있어 최후 1인이
   * 나오기 전에 관리자가 정산할 수 있어야 한다. 이 게이트는 그 자유를 막지
   * 않는다 — 어떻게 나눴든 합만 맞으면 통과한다.
   */
  async completeSession(id: string, ownerId: string) {
    // 종료는 대회를 닫고 정산을 확정하는 자리다. 다른 운영 조작과 같은 문을
    // 쓴다 — 남의 대회를 끝낼 수 있으면 그 상점의 장부가 남의 손에 닫힌다.
    await this.assertTournamentOwnership(id, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (isClosedTournament(tournament.status)) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }

    const participations = await this.prismaService.tournamentParticipation.findMany({
      where: { tournamentId: id },
      select: { prizeAmount: true },
    });
    const paid = participations.reduce((sum, p) => sum + p.prizeAmount, 0);

    /**
     * **게이트가 보는 것은 「걷은 것 == 상금 + 상점 몫」이다.**
     *
     * 예전에는 상금만 봤다. 레이크가 붙은 뒤로는 상금이 프라이즈풀만큼만
     * 나가므로 걷은 총액과는 상점 몫만큼 벌어지고, 그 차이를 남는 돈으로
     * 읽으면 **레이크 있는 대회는 영영 안 닫힌다.**
     *
     * 레이크가 0이면 `rake`도 0이라 이 식이 예전 식과 같아진다.
     */
    const rake = rakeOf(tournament.totalBuyinAmount, tournament.rakePercent);

    // **문장이 `completeBlocker` 하나에서 나온다.** 콘솔의 「종료」가 못 누를
    // 이유를 그 자리에 적는데(`getFinishPreview`), 그 판단을 화면이 따로
    // 계산하면 「닫을 수 있다」고 그려 놓고 누르면 409가 나는 날이 온다.
    const blocked = completeBlocker(tournament.totalBuyinAmount, paid, rake);
    if (blocked) throw new ConflictException(blocked);

    // **돈을 받는 사람은 상점 주인이다.** 상점 자체는 지갑이 없고
    // (`Store`에 포인트 컬럼이 없다) 주인은 이미 `User`라, 새 모델 없이
    // 포인트 증가 + 거래 내역으로 끝난다(`abortSession`과 같은 자리).
    const { ownerId: storeOwnerId } = await this.prismaService.store.findUniqueOrThrow({
      where: { id: tournament.storeId },
      select: { ownerId: true },
    });

    const tables = await this.prismaService.table.findMany({
      where : { tournamentId : id }
    });
    let tableIds: string[] = [];
    tables.forEach(t => {
      tableIds.push(t.id);
    })
    const closed = await this.prismaService.$transaction(async (tx) => {
      /**
       * **상태 전이가 문지기다.** 종료가 돈 경로가 됐으므로(상점 몫)
       * 두 번 눌리면 두 번 나간다. 위의 `isClosedTournament`는 트랜잭션
       * **밖**이라 순차 호출만 잡고, 동시 호출은 여기서만 갈린다 —
       * `abortSession`·`cancelSession`과 같은 모양이다.
       */
      const won = await tx.tournament.updateMany({
        where: { id, status: NOT_CLOSED_TOURNAMENT_FILTER },
        data: {
          status: TournamentStatus.FINISHED,
          finishedAt: new Date(),
        },
      });
      if (won.count === 0) return false;

      // 0원은 옮기지 않는다. 레이크 없는 대회에 0원짜리 거래가 쌓이면
      // 「상점이 가져갔다」와 「가져갈 것이 없었다」가 같은 모양으로 남는다.
      if (rake > 0) {
        await tx.user.update({
          where: { id: storeOwnerId },
          data: { points: { increment: rake } },
        });
        await tx.pointTransaction.create({
          data: {
            userId: storeOwnerId,
            amount: rake,
            type: 'SETTLEMENT',
            tournamentId: id,
            description: `${tournament.name} 상점 몫`,
          },
        });
      }

      await tx.table.deleteMany({
        where: {
          tournamentId: id,
        },
      });
      await tx.dealerSession.delete({
        where: {
          tournamentId: id,
        },
      });
      return true;
    });

    // **두 번째 호출은 아무것도 안 했다.** Redis는 이미 첫 번째가 비웠다.
    if (!closed) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }
    await this.redis.deleteTournament(id, tableIds);
  }

  /**
   * 대회를 취소하고 참가비를 **전액 환불**한다.
   *
   * `completeSession`이 닫지 못하는 구멍이 여기 있었다. 그쪽은 "걷은 참가비 ==
   * 나간 상금"이라야 닫히는데, 참가자만 모이고 시작하지 않은 대회는 상금이
   * 0이라 그 게이트에 영영 걸린다. 환불 경로도 없어서
   * (`TransactionType.REFUND`가 스키마에만 있었다) 돈을 돌려줄 방법 자체가
   * 없었다.
   *
   * **시작 전에만 취소한다.** 판정은 `status`가 아니라 `startedAt`으로 한다 —
   * 그것이 "시작했다"의 정본이다. 시작한 뒤에는 블라인드가 오르고 칩이 움직여
   * "전액 환불"의 뜻이 성립하지 않는다(이미 탈락한 사람에게도 전액을 주는
   * 것이 되고, 그건 정산이지 취소가 아니다).
   *
   * **한 사람에게 돌려줄 금액은 `entryFee` 하나다.** 리바인은 `HAND_END`에서만
   * 나가므로 시작 전 대회의 `buyInCount`는 언제나 1이다. `entryFee *
   * buyInCount`로 쓰지 않는 이유는 그 곱이 항상 1이라 **어떤 테스트도 그 곱을
   * 증명하지 못하기** 때문이다 — 리바인 환불을 처리하는 것처럼 보이는데 한
   * 번도 안 타는 코드가 된다.
   *
   * 대신 **장부를 대조한다.** 시작 전이면 `참가자 수 * entryFee ==
   * totalBuyinAmount`가 성립해야 한다. 어긋나면 얼마를 돌려줘야 하는지 서버가
   * 모른다는 뜻이므로, 조용히 덜 주는 대신 거절한다. `completeSession`의 정산
   * 게이트와 같은 자리다.
   *
   * **멱등이다.** 상태 전이를 조건부 `updateMany`에 태워 DB가 판정하게 하고,
   * 바뀐 행이 0이면 환불을 건너뛴다. 돈은 두 번 나가면 되돌릴 근거가 없다 —
   * `awardPrize`가 쓰는 방식 그대로다.
   *
   * 수수료·위약금은 다루지 않는다. 결제 도메인이라 여기서 정할 값이 아니다.
   */
  /**
   * **ICM 찹 — 파이널 테이블에서 딜로 끝낸다.**
   *
   * 최후 1인까지 가지 않고 남은 상금을 각자의 칩 비율로 나눈다. 오프라인
   * 대회에서 흔한 마무리라, 그 경로가 없으면 딜로 끝난 대회는 시스템이 닫지
   * 못한다 — `completeSession`의 게이트가 「걷은 것 == 나간 상금 + 상점 몫」인데
   * 딜은 그 합을 만드는 길이 없었다.
   *
   * **지급하고 그대로 닫는다.** 지급이 끝나면 게이트가 통과하므로
   * `completeSession`을 그대로 부른다 — 닫는 절차를 여기 복제하지 않는다.
   * 그 게이트가 **찹 계산이 맞았는지를 다시 재 주는** 자리이기도 하다.
   *
   * 문을 여는 조건 셋. 각각 막는 이유가 다르다.
   */
  /**
   * 대회 마무리 미리보기. **읽기만 한다.**
   *
   * 콘솔의 마무리 영역과 확인 대화 둘이 이 응답 하나로 그려진다. 라우트를
   * 셋으로 나누지 않은 이유는 화면이 **「합이 걷은 돈과 같다」를 눈으로
   * 확인하는 자리**이기 때문이다 — 세 시점의 값을 섞어 그리면 그 확인이
   * 무의미해진다.
   *
   * **금액을 여기서 정하지 않는다.** 실제 지급이 쓰는 계산
   * (`calculateChop`·`calculateAbortSettlement`)을 그대로 부른다. 미리보기
   * 전용 식을 따로 적으면 화면의 숫자와 실제 지급이 갈라지는데, 그 갈라짐을
   * 잡아 주는 장치가 없다.
   *
   * **프론트가 이 값을 되돌려 보내지 않는다.** 확정은 각 라우트가 서버에서
   * 다시 계산한다 — 이 응답은 근거가 아니라 미리 보여주는 그림이다.
   */
  async getFinishPreview(tournamentId: string, ownerId: string): Promise<FinishPreview> {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');

    const participations = await this.prismaService.tournamentParticipation.findMany({
      where: { tournamentId },
      select: {
        userId: true,
        status: true,
        buyInCount: true,
        prizeAmount: true,
        currentStack: true,
        user: { select: { nickname: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const rake = rakeOf(tournament.totalBuyinAmount, tournament.rakePercent);
    const prizePool = prizePoolOf(tournament.totalBuyinAmount, tournament.rakePercent);
    const paidPrize = participations.reduce((sum, p) => sum + p.prizeAmount, 0);
    // 음수가 되는 상태(지급이 풀을 넘었다)는 `completeBlocker`가 문장으로
    // 말한다. 여기서 0으로 눌러 두면 화면이 「나눌 것이 없다」로만 읽힌다.
    const remainingPrize = Math.max(0, prizePool - paidPrize);

    const closed = isClosedTournament(tournament.status);

    /**
     * **닫힌 대회는 셋 다 못 한다.** 조작마다 다른 이유를 적을 것이 없다 —
     * 이미 닫혔다는 사실 하나가 셋을 다 막는다.
     */
    const closedGate = { canRun: false, reason: FINISH_BLOCKERS.closed };

    const completeReason = closed
      ? FINISH_BLOCKERS.closed
      : completeBlocker(tournament.totalBuyinAmount, paidPrize, rake);

    const chopReason = closed ? FINISH_BLOCKERS.closed : await this.chopBlocker(tournament);
    /**
     * **문이 열렸을 때만 줄을 그린다.** 못 하는 상태에서 명단을 그리면
     * 「이렇게 나뉜다」가 화면에 남는데, 그 값은 조건이 갖춰진 뒤와 다르다 —
     * 핸드가 도는 중이면 `currentStack`이 낡았고, 그것이 애초에 막는 이유다.
     */
    const alive = chopReason === null
      ? participations.filter((p) => isLiveParticipant(p.status))
      : [];
    const nicknameByUser = new Map(
      participations.map((p) => [p.userId, p.user.nickname ?? null]),
    );
    const chopRows = calculateChop(alive, remainingPrize).map((row) => ({
      ...row,
      nickname: nicknameByUser.get(row.userId) ?? null,
      currentStack: alive.find((p) => p.userId === row.userId)?.currentStack ?? 0,
    }));

    const abortReason = closed
      ? FINISH_BLOCKERS.closed
      : tournament.startedAt === null
        ? FINISH_BLOCKERS.abortNotStarted
        : null;
    const settlement = calculateAbortSettlement(
      participations, tournament.entryFee, tournament.totalBuyinAmount,
    );

    return {
      totalBuyinAmount: tournament.totalBuyinAmount,
      rakePercent: tournament.rakePercent,
      rakeAmount: rake,
      prizePool,
      paidPrize,
      remainingPrize,
      complete: closed
        ? closedGate
        : { canRun: completeReason === null, reason: completeReason },
      chop: {
        canRun: chopReason === null && chopRows.length >= 2,
        // 문은 열렸는데 사람이 모자란 경우다. 트랜잭션 안의 검사와 같은 문장을
        // 쓴다(`FINISH_BLOCKERS.chopTooFew`).
        reason: chopReason ?? (chopRows.length >= 2 ? null : FINISH_BLOCKERS.chopTooFew),
        rows: chopRows,
      },
      abort: {
        canRun: abortReason === null,
        reason: abortReason,
        groups: groupAbortRefunds(participations, settlement.refunds),
        storeAmount: settlement.storeAmount,
        scaled: settlement.scaled,
      },
    };
  }

  /**
   * 딜로 끝낼 수 없는 이유. 끝낼 수 있으면 `null`이다.
   *
   * **실행과 미리보기가 같은 문을 지난다.** `chopSession`이 이것을 보고
   * 던지고, `getFinishPreview`가 같은 값을 화면의 「왜 못 누르나」로 그린다 —
   * 판단이 두 곳이면 「할 수 있다」고 그려 놓고 누르면 409가 나는 날이 온다.
   *
   * 여기서 보는 것은 **밖에서 확인할 수 있는 문 셋**이다. 인원(두 명 이상)은
   * 트랜잭션 안에서 다시 세므로 여기 없다 — 미리보기는 `rows.length`로 같은
   * 사실을 보여준다.
   */
  private async chopBlocker(
    tournament: { id: string; startedAt: Date | null; isRegistrationOpen: boolean },
  ): Promise<string | null> {
    // **시작 여부의 정본은 `startedAt`이다**(`cancelSession`과 같은 판정).
    if (tournament.startedAt === null) return FINISH_BLOCKERS.chopNotStarted;

    /**
     * **파이널 테이블에서만 받는다**(T77의 `isFinalTable`).
     *
     * 딜은 남은 사람 **전원의 합의**다. 테이블이 둘이면 그 자리에 없는 사람이
     * 있고, 등록이 열려 있으면 아직 안 온 사람이 있다.
     *
     * 마감은 컬럼이 아니라 파생값이다(`isRegistrationOpenLive`) — 컬럼은 마감
     * 시각에 스스로 닫히지 않는다.
     */
    const tournamentId = tournament.id;
    const tableCount = await this.prismaService.table.count({ where: { tournamentId } });
    const isRegistrationOpen = await isRegistrationOpenLive(
      this.prismaService, this.redis, tournament,
    );
    if (!isFinalTable({ isRegistrationOpen, tableCount })) {
      return FINISH_BLOCKERS.chopNotFinalTable;
    }

    /**
     * **핸드가 도는 중에는 안 받는다.**
     *
     * 딜은 핸드 사이에 한다. 그리고 나눌 재료인 장부의 칩(`currentStack`)은
     * 체크포인트가 **핸드 경계에서** 내리는 값이라(`syncTableInventoryToDb`),
     * 핸드 중에는 스냅샷보다 낡았다 — 그 값으로 나누면 방금 딴 칩이 반영되지
     * 않는다.
     *
     * 스냅샷이 없으면 유실이다(T38 이후 그 뜻이 하나다). 그때도 거절한다 —
     * 칩이 신선한지 확인할 방법이 없다.
     */
    const table = await this.prismaService.table.findFirstOrThrow({
      where: { tournamentId },
      select: { id: true },
    });
    const state = await this.redis.getSnapShot(table.id);
    if (!state || (state.phase !== GamePhase.WAITING && state.phase !== GamePhase.HAND_END)) {
      return FINISH_BLOCKERS.chopHandRunning;
    }

    return null;
  }

  async chopSession(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (isClosedTournament(tournament.status)) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }
    const blocked = await this.chopBlocker(tournament);
    if (blocked) throw new ConflictException(blocked);

    await this.prismaService.$transaction(async (tx) => {
      /**
       * **살아 있는 사람이 나눈다.** 좌석만 뗀 사람(`RELEASED`)도 칩을 들고
       * 있으므로 포함이다 — 인원수가 세는 집합과 같다(`LIVE_PLAYER_STATUSES`).
       *
       * 트랜잭션 안에서 다시 읽는 이유는 `abortSession`과 같다. 밖에서 읽은
       * 값은 이미 낡았을 수 있다.
       */
      const alive = await tx.tournamentParticipation.findMany({
        where: { tournamentId, status: { in: [...LIVE_PLAYER_STATUSES] } },
        select: { userId: true, currentStack: true },
        orderBy: { createdAt: 'asc' },
      });
      if (alive.length < 2) {
        throw new ConflictException(FINISH_BLOCKERS.chopTooFew);
      }

      const current = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { totalBuyinAmount: true, rakePercent: true },
      });
      const paid = await tx.tournamentParticipation.aggregate({
        where: { tournamentId },
        _sum: { prizeAmount: true },
      });

      // 나눌 돈은 **상점 몫을 뺀 프라이즈풀에서 이미 나간 상금을 뺀 것**이다.
      // 상금권 탈락이 있었으면 그 돈은 이미 풀에서 빠졌다.
      const remaining = prizePoolOf(current.totalBuyinAmount, current.rakePercent)
        - (paid._sum.prizeAmount ?? 0);

      await awardPrize(
        tx,
        tournamentId,
        calculateChop(alive, Math.max(0, remaining)),
        '딜 정산',
      );
    });

    // **지급이 끝나면 게이트가 통과한다.** 닫는 절차를 복제하지 않는다 —
    // 상점 몫 지급도 Redis 정리도 저쪽이 이미 들고 있다.
    return await this.completeSession(tournamentId, ownerId);
  }

  /**
   * **진행 중인 대회를 중단한다.** 천재지변으로 대회를 더 못 여는 경우다.
   *
   * `cancelSession`과 문을 나누는 이유는 **규칙이 다르기 때문**이다. 그쪽은
   * 시작 전이라 전액 환불이 성립하지만, 여기서는 이미 진 사람과 아직 지지 않은
   * 사람이 갈려 있다. 한 메서드에 두 규칙을 담으면 어느 쪽이 도는지가 인자에
   * 숨는다.
   *
   * **정지가 아니다.** 홀덤에 대회 전체 일시정지는 없다 — 테이블 하나가 못
   * 도는 것은 핸드 대기(`HAND_WAIT`)이고 그건 그 테이블의 상태다. 중단은
   * 대회가 끝나는 것이고 되돌릴 수 없다.
   *
   * 금액 계산은 `settlement.ts`의 `calculateAbortSettlement`. 순수 함수라
   * 인프라 없이 검증된다 — 여기는 **옮기는 일**만 한다.
   *
   * @returns 실제로 나간 환불 총액과 상점 몫. 깎였는지도 함께 알린다.
   */
  async abortSession(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      include: { store: { select: { ownerId: true } } },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (isClosedTournament(tournament.status)) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }
    // **시작 여부의 정본은 `startedAt`이다**(`cancelSession`과 같은 판정).
    if (tournament.startedAt === null) {
      throw new ConflictException(FINISH_BLOCKERS.abortNotStarted);
    }

    const tables = await this.prismaService.table.findMany({
      where: { tournamentId },
      select: { id: true },
    });

    // **돈을 받는 사람은 상점 주인이다.** 상점 자체는 지갑이 없고
    // (`Store`에 포인트 컬럼이 없다) 주인은 이미 `User`라, 새 모델 없이
    // 포인트 증가 + 거래 내역으로 끝난다.
    const storeOwnerId = tournament.store.ownerId;

    const settled = await this.prismaService.$transaction(async (tx) => {
      // **트랜잭션 안에서 다시 읽는다.** 밖에서 읽은 값은 이미 낡았을 수 있다 —
      // 검사와 정산 사이에 참가가 하나 더 들어오면 그 사람 돈은 계산에 안 들어간
      // 채로 대회가 닫힌다(`cancelSession`의 장부 대조와 같은 이유).
      const current = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { entryFee: true, totalBuyinAmount: true, name: true },
      });
      const participations = await tx.tournamentParticipation.findMany({
        where: { tournamentId },
        select: { userId: true, status: true, buyInCount: true, prizeAmount: true },
        orderBy: { createdAt: 'asc' },
      });

      const settlement = calculateAbortSettlement(
        participations, current.entryFee, current.totalBuyinAmount,
      );

      // **상태 전이가 문지기다.** 이 한 문장이 통과한 호출만 돈을 움직인다.
      // 두 번째 호출은 `status`가 이미 `CANCELLED`라 0행을 바꾸고 아래를
      // 통째로 건너뛴다 — 판정을 코드가 아니라 `where`에 태워 DB에 맡긴다.
      const closed = await tx.tournament.updateMany({
        where: {
          id: tournamentId,
          startedAt: { not: null },
          status: NOT_CLOSED_TOURNAMENT_FILTER,
        },
        data: {
          status: TournamentStatus.CANCELLED,
          finishedAt: new Date(),
          // 걷은 돈이 전부 나갔다 — 환불과 상점 몫으로. 남겨 두면 이 대회의
          // 회계가 "걷었는데 아무도 안 받았다"로 남는다(`cancelSession`과 같다).
          totalBuyinAmount: 0,
          activePlayers: 0,
        },
      });
      if (closed.count === 0) return null;

      let refunded = 0;
      for (const { userId, amount } of settlement.refunds) {
        // 0원은 옮기지 않는다. 거래 내역에 0원짜리가 쌓이면 "돌려받았다"와
        // "받을 것이 없었다"가 같은 모양으로 남는다.
        if (amount <= 0) continue;
        refunded += amount;
        await tx.user.update({
          where: { id: userId },
          data: { points: { increment: amount } },
        });
        await tx.pointTransaction.create({
          data: {
            userId,
            amount,
            type: 'REFUND',
            tournamentId,
            description: `${current.name} 중단 환불`,
          },
        });
      }

      if (settlement.storeAmount > 0) {
        await tx.user.update({
          where: { id: storeOwnerId },
          data: { points: { increment: settlement.storeAmount } },
        });
        await tx.pointTransaction.create({
          data: {
            userId: storeOwnerId,
            amount: settlement.storeAmount,
            type: 'SETTLEMENT',
            tournamentId,
            description: `${current.name} 중단 정산`,
          },
        });
      }

      // 참가 행은 지우지 않는다. 장부라서다 — 누가 얼마를 돌려받았는지가
      // `PointTransaction`과 짝이 맞아야 한다. 대회가 `CANCELLED`인 것으로
      // "이 참가는 중단으로 끝났다"가 이미 표현된다.

      await tx.table.deleteMany({ where: { tournamentId } });
      await tx.dealerSession.delete({ where: { tournamentId } });

      return { refunded, storeAmount: settlement.storeAmount, scaled: settlement.scaled };
    });

    // **두 번째 호출은 아무것도 안 했다.** Redis는 이미 첫 번째가 비웠다.
    if (settled === null) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }

    await this.redis.deleteTournament(tournamentId, tables.map((t) => t.id));
    return settled;
  }

  async cancelSession(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (isClosedTournament(tournament.status)) {
      throw new ConflictException('이미 닫힌 세션입니다.');
    }
    if (tournament.startedAt !== null) {
      throw new ConflictException('이미 시작한 대회는 취소할 수 없습니다.');
    }

    const tables = await this.prismaService.table.findMany({
      where: { tournamentId },
      select: { id: true },
    });

    await this.prismaService.$transaction(async (tx) => {
      const participations = await tx.tournamentParticipation.findMany({
        where: { tournamentId },
        select: { userId: true },
      });

      // 장부 대조. 트랜잭션 **안에서** 다시 읽는 이유는, 밖에서 읽은
      // `tournament`가 이미 낡았을 수 있어서다 — 검사와 환불 사이에 참가가
      // 하나 더 들어오면 그 사람 돈은 돌려주지 않은 채로 대회가 닫힌다.
      const current = await tx.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
        select: { entryFee: true, totalBuyinAmount: true },
      });
      const owed = participations.length * current.entryFee;
      if (owed !== current.totalBuyinAmount) {
        throw new ConflictException(
          `장부가 맞지 않아 취소할 수 없습니다. 걷은 금액 ${current.totalBuyinAmount}, 돌려줄 금액 ${owed}.`,
        );
      }

      // **상태 전이가 문지기다.** 이 한 문장이 통과한 호출만 돈을 움직인다.
      // `where`에 조건을 전부 실어 판정을 DB에 맡긴다 — 두 번째 호출은
      // `status`가 이미 `CANCELLED`라 0행을 바꾸고, 아래 환불을 건너뛴다.
      const closed = await tx.tournament.updateMany({
        where: {
          id: tournamentId,
          startedAt: null,
          status: { notIn: [TournamentStatus.FINISHED, TournamentStatus.CANCELLED] },
        },
        data: {
          status: TournamentStatus.CANCELLED,
          finishedAt: new Date(),
          // 걷은 돈을 전부 돌려줬으므로 0이다. 남겨 두면 이 대회의 회계가
          // "걷었는데 아무도 안 받았다"로 남는다.
          totalBuyinAmount: 0,
          activePlayers: 0,
        },
      });
      if (closed.count === 0) return;

      for (const { userId } of participations) {
        await tx.user.update({
          where: { id: userId },
          data: { points: { increment: current.entryFee } },
        });
        await tx.pointTransaction.create({
          data: {
            userId,
            amount: current.entryFee,
            type: 'REFUND',
            tournamentId,
            description: `${tournament.name} 취소 환불`,
          },
        });
      }

      // 참가 행은 지우지 않는다. 장부라서다 — 누가 참가했다가 취소로
      // 돌려받았는지가 남아야 `PointTransaction`의 REFUND와 짝이 맞는다.
      // 대회가 `CANCELLED`인 것으로 "이 참가는 무효"가 이미 표현된다.

      await tx.table.deleteMany({ where: { tournamentId } });
      await tx.dealerSession.delete({ where: { tournamentId } });
    });

    await this.redis.deleteTournament(tournamentId, tables.map((t) => t.id));
  }

  /**
   * 상점 소유권 확인.
   *
   * 재발급은 평문 OTP를 응답에 실어 돌려주고, 내보내기는 딜러 세션을 끊는다.
   * 둘 다 강한 동작이라 역할만 확인하고 지나가면 다른 상점 관리자가 남의
   * 대회의 딜러 접근권을 만들거나 끊을 수 있다.
   *
   * 컨트롤러가 아니라 `reissueDealerOtp`/`revokeDealerSession` 각각의 첫
   * 문장으로 둔다 — 컨트롤러에만 있으면 그 한 줄이 지워져도 서비스 메서드를
   * 직접 부르는 어떤 테스트도, 어떤 다른 호출부도 잡아내지 못한다. 이 검사가
   * 우회 불가능해야 값을 만든다. `store.service.ts`의 `updateStore`/
   * `removeStore`가 `getStoreDetail`을 내부에서 부르는 것과 같은 자리다.
   *
   * `PATCH /store/sessions/:id`(`updateSession`)에는 이 검사가 없었다. T23이
   * "별도 항목"으로 미뤄 둔 것을 T50이 닫았고, 지금은 운영 조작 여섯 곳
   * (`createTable` · `deleteTable` · `releaseSeats` · `startSession` ·
   * `cancelSession` · `updateSession`)과 재발급 · 내보내기 · 좌석 조회 ·
   * 종료(`completeSession`)가 전부 이 함수를 첫 문장으로 부른다.
   */
  async assertTournamentOwnership(tournamentId: string, ownerId: string): Promise<void> {
    const tournament = await this.prismaService.tournament.findUnique({
      where: { id: tournamentId },
      select: { store: { select: { ownerId: true } } },
    });
    if (!tournament) throw new NotFoundException('세션을 찾을 수 없습니다.');
    if (tournament.store.ownerId !== ownerId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
  }

  /**
   * 매장 소유권 확인.
   *
   * `assertTournamentOwnership`과 같은 일을 하되 **대회가 아직 없는 자리**에
   * 쓴다 — 대회 생성(`createSession`)과 목록 조회(`getStoreAllSessions`)다.
   * 이 둘은 대회 id가 아니라 상점 id를 요청에서 받으므로 대회를 거쳐 소유자를
   * 찾을 수가 없다.
   *
   * 없는 상점을 404로 가르지 않고 403으로 뭉갠다. 대회 쪽과 달리 여기서는
   * 상점 id가 곧 남의 테넌트를 가리키는 값이고, 404와 403이 갈리면 그 응답
   * 차이만으로 어떤 상점 id가 실재하는지 훑을 수 있다.
   */
  private async assertStoreOwnership(storeId: string, ownerId: string): Promise<void> {
    const store = await this.prismaService.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });
    if (!store || store.ownerId !== ownerId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
  }

  /**
   * 블라인드 구조가 그 상점의 것인지 본다.
   *
   * 생성에만 있던 검사다. 수정(`updateSession`)이 `blindId`를 그대로 저장해서,
   * 남의 상점 구조를 자기 대회에 붙일 수 있었고 그 대회가 다른 테넌트의
   * 구조로 돌았다. 없는 id는 외래키 위반(P2003)이 되어 예외 필터가 없는 이
   * 리포에서 500으로 나갔다.
   *
   * **판정이 한 곳이어야 한다.** 두 벌이 되면 한쪽만 고쳐지는 날이 온다.
   */
  private async assertBlindBelongsToStore(blindId: string, storeId: string) {
    const blind = await this.prismaService.blindStructure.findUnique({
      where: { id: blindId },
      select: { storeId: true },
    });
    if (!blind) throw new NotFoundException('블라인드 구조를 찾을 수 없습니다.');
    if (blind.storeId !== storeId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
  }

  /**
   * 좌석 해제 화면의 입력. `POST .../seats/release`의 DTO(`ReleaseSeatItem`)가
   * `seatIndex`뿐 아니라 `userId`도 요구한다 — 상점 콘솔이 조금 전에 그린
   * 판을 보고 체크하는 사이 그 자리 사람이 바뀔 수 있어서다(T28이 핸드
   * 도중 착석을 허용한다). 그런데 지금 있는 조회 셋 다 가드가 없는 공개
   * 라우트다 — `GET /tournaments/:id/seats`(entry.controller)와
   * `GET /dealer/:id`(`getGameSessionWithTables`)는 redis 비트맵이나
   * `{id, tableOrder}`로 좁힌 테이블 뼈대만 줘서 누가 앉았는지는 안 새지만
   * (`getGameSessionWithTables`가 예전에는 `tables: true`로 통째로 select해
   * `Tournament` 행 전체와 테이블의 `dealerId`까지 실었다 — T66이 좁혔다),
   * `GET /tournaments/:id`(payment.service.ts의
   * `getTournamentInfo`)는 `tablePlayers`까지 include하는 조회를 그대로
   * 썼던 적이 있다 — 참가자 userId·닉네임이 공개 라우트로 그대로 나갔다는
   * 뜻이다(그 조회는 이제 화면이 쓰는 필드만 select하도록 좁혔다,
   * `payment.service.ts`의 `getTournamentInfo` 주석 참고).
   *
   * 그래서 이 조회를 위해 셋 중 하나를 확장하지 않고 새로 만든다. 확장하면
   * 다음에 또 같은 실수가 공개 라우트에 얹힌다. 재발급·내보내기와 같은 문
   * (STORE_ADMIN 전용, 소유권 확인 첫 줄)을 쓴다 — 이 조회 자체가 해제라는
   * 강한 동작의 입력이라서다.
   *
   * `seatPosition`(DB 컬럼)을 `seatIndex`로 바꿔 내보낸다 — 해제 DTO가 그
   * 이름을 쓴다.
   */
  async getSeatOccupants(tournamentId: string, ownerId: string) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const tables = await this.prismaService.table.findMany({
      where: { tournamentId },
      orderBy: { tableOrder: 'asc' },
      include: {
        tablePlayers: {
          select: { seatPosition: true, userId: true, nickname: true },
        },
      },
    });

    return tables.map((table) => ({
      tableId: table.id,
      tableOrder: table.tableOrder,
      players: table.tablePlayers.map((p) => ({
        seatIndex: p.seatPosition,
        userId: p.userId,
        nickname: p.nickname,
      })),
    }));
  }

  /**
   * 태블릿이 토큰을 잃었을 때 쓰는 탈출구다. 해시로 저장하므로 원본을 다시
   * 보여줄 방법이 없고, 대신 새로 발급한다.
   *
   * 이미 붙어 있는 딜러는 끊지 않는다 — 그들은 갱신으로 살아 있고, 갱신은
   * OTP가 아니라 tokenVersion을 본다.
   */
  async reissueDealerOtp(tournamentId: string, ownerId: string): Promise<{ dealerOtp: string }> {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    const dealerOtp = generateDealerOtp();
    const dealerOtpHash = await hashDealerOtp(dealerOtp);

    await this.prismaService.tournament.update({
      where: { id: tournamentId },
      data: { dealerOtpHash },
    });

    // 재발급은 잠금을 푼다. 잠긴 원인이 남의 오타였다면 상점이 여기서 풀 수
    // 있어야 하고, 공격자였다면 값이 이미 바뀌어 카운터가 의미 없다.
    await this.otpAttempts.clear(tournamentId);

    return { dealerOtp };
  }

  /**
   * 붙어 있는 딜러를 끊는다. 남은 토큰은 만료(최대 1시간)까지 살아 있다.
   *
   * 소유권 확인이 먼저라, 없는 tournamentId를 넘기면 여기서 404로 걸린다
   * (예전에는 검사가 없어 `dealerSession.update`가 P2025를 던지고 그걸
   * 조용히 삼켜 존재하지도 않는 대회에 대해 성공을 돌려줬다).
   *
   * 실재하는 대회인데 딜러 세션 행이 없는 경우는 남아 있다 —
   * `completeSession`이 대회를 닫으며 테이블과 함께 이미 지운 경우다. 그때는
   * 끊을 대상이 없다는 것 자체가 목표 상태(붙어 있는 딜러 없음)가 이미
   * 달성돼 있다는 뜻이라, 상점 콘솔에서 "내보내기"를 누른 사람이 500을 볼
   * 이유가 없다 — 조용히 성공으로 둔다.
   */
  async revokeDealerSession(tournamentId: string, ownerId: string): Promise<void> {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    try {
      await this.prismaService.dealerSession.update({
        where: { tournamentId },
        data: { tokenVersion: { increment: 1 } },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return;
      }
      throw e;
    }
  }

  /**
   * 대회 설정을 고친다.
   *
   * **소유권 확인이 첫 문장이다.** 다른 운영 조작(`createTable`·`deleteTable`·
   * `startSession`·`cancelSession`·`reissueDealerOtp`·`revokeDealerSession`)과
   * 같은 자리다. 예전에는 이 경로만 검사가 없어서, 상점 관리자 역할만 있으면
   * **남의 대회를 고칠 수 있었다** — 참가비·시작 스택·블라인드 구조·상금
   * 분배율이 전부 여기로 바뀐다. 참가비를 0으로 만들거나 분배율을 자기 쪽으로
   * 몰 수 있다는 뜻이다.
   *
   * 컨트롤러가 아니라 여기 두는 이유도 같다 — 컨트롤러에만 있으면 그 한 줄이
   * 지워져도 서비스를 직접 부르는 어떤 호출부도 테스트도 잡아내지 못한다
   * (`assertTournamentOwnership` 주석 참고).
   *
   * 없는 대회가 404가 되는 것도 이 한 줄이 함께 고친다. 예전에는
   * `getGameSession`이 준 null을 그냥 지나가 `tournament.update`가 P2025로
   * 죽어 **500**이 났다 — 없는 것을 물었을 뿐인데 서버 오류다.
   * `revokeDealerSession`이 같은 모양이었고 T23이 고쳤다.
   */
  async updateSession(id: string, dto: UpdateTournamentDto, ownerId: string) {
    await this.assertTournamentOwnership(id, ownerId);

    const session = await this.getGameSession(id);
    if (session && isClosedTournament(session.status)) {
      throw new ConflictException('닫힌 세션은 수정할 수 없습니다.');
    }

    // 이미 걷은 돈이 있으면 참가비와 시작 스택을 잠근다. 한 번 바꾸면 그
    // 대회는 취소도 종료도 못 하게 굳는다 — `recalculateAvgStack`은
    // `totalBuyinAmount / entryFee`로 바이인 건수를 역산하고, `cancelSession`은
    // `참가자 수 × entryFee === totalBuyinAmount`를 요구한다. 둘 다 이미 걷은
    // 돈으로 계산된 값이라, 나눗셈의 분모만 바꾸면 영영 안 맞는다.
    //
    // 문지기는 **상태가 아니라 `totalBuyinAmount`**다. 돈은 대회가 시작하기
    // 전, `PENDING`에서 걷힌다 — `PaymentService.joinSession`은
    // `isClosedTournament`와 등록 마감만 보고 시작 여부는 묻지 않는다. 잠금이
    // `status === ONGOING`이던 때는 N명이 결제한 뒤 아직 시작 전인 대회의
    // entryFee를 그대로 바꿀 수 있었고, 위와 같은 굳음이 시작 전에도 그대로
    // 재현됐다. 시작 스택도 같은 성질이다.
    //
    // **레이크도 같은 성질이다.** 프라이즈풀이 `걷은 총액 - 레이크`라
    // 비율을 바꾸면 **이미 지급된 상금이 소급해서 틀린 금액이 된다** —
    // 나간 돈은 되돌릴 근거가 없고, `completeSession`의 게이트는 새 비율로
    // 다시 재므로 그 대회는 닫히지 않는다.
    if (session && session.totalBuyinAmount > 0) {
      if (
        dto.entryFee !== undefined
        || dto.startStack !== undefined
        || dto.rakePercent !== undefined
      ) {
        throw new ConflictException('이미 걷은 참가비가 있는 대회의 참가비와 시작 스택, 상점 몫은 바꿀 수 없습니다.');
      }
    }

    if (dto.blindId) {
      await this.assertBlindBelongsToStore(dto.blindId, session!.storeId);
    }

    const updateData: any = {
      name: dto.name,
      blindId: dto.blindId,
      startStack: dto.startStack,
      rebuyUntil: dto.rebuyUntil,
      entryFee: dto.entryFee,
      rakePercent: dto.rakePercent,
    };

    // 수정 경로에도 같은 검증이 걸려야 한다. 생성만 막으면 만든 뒤에 고쳐서
    // 합이 100이 아닌 대회를 만들 수 있다.
    if (dto.payoutTable) {
      try {
        const table = parsePayoutTable(dto.payoutTable);
        updateData.payoutTable = table as unknown as Prisma.InputJsonValue;
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    return await this.prismaService.tournament.update({
      where: {
        id: id,
      },
      data: updateData,
    });
  }

  /**
   * 상점이 좌석에서 사람을 뗀다.
   *
   * 시스템은 누구를 어디로 보낼지 정하지 않는다. 상점이 체크한 사람을 뗄
   * 뿐이고, 그 사람은 걸어가서 빈 자리에 앉아 자기 참가 OTP를 넣는다(T28).
   * 자동 밸런싱은 하지 않기로 한 것이다 — 언제 누구를 어디로 보낼지는 규칙이
   * 아니라 현장 판단이다.
   *
   * **트랜잭션이 락 안에 있다.** T28의 입장은 반대로 락 밖에 두는데, 그
   * 근거는 대회 시작에 수십 명이 한꺼번에 들어와 커넥션 풀이 차는 상황이었다.
   * 해제는 상점 운영자 한 명의 조작이고 행이 최대 9개다. 이 리포의 실제 규칙은
   * "트랜잭션 금지"가 아니라 **기다림이 무한정인 일 금지**다 —
   * `resolveWinners`가 3단계(탈락 확정)는 락 안에서 돌리고 2단계(사람이 리바인
   * 수락을 기다림)와 4단계(백오프 재시도)만 락 밖으로 뺀 것이 그 증거다.
   *
   * **그런데 레디스 락은 좌석의 DB 쓰기를 직렬화하지 않는다.** T28이 입장의
   * 트랜잭션을 락 밖으로 뺐기 때문에 입장은 테이블 락을 건드리지 않고
   * `TablePlayer`를 INSERT한다. 그래서 `deleteTable`과 같은
   * `SELECT ... FOR UPDATE`가 필요하다 — INSERT가 부모 `Table` 행에 거는
   * `FOR KEY SHARE`와 충돌해 두 방향 모두 직렬화된다.
   *
   * **`FOR UPDATE` 대기가 락 TTL을 넘길 수 있다.** 이 트랜잭션은 진행 중인
   * 입장 트랜잭션의 커밋을 기다리므로 대기 시간이 우리 손 밖이다. 5초를
   * 넘기면 레디스 락이 말없이 만료되고 뒤따르는 스냅샷 쓰기가 보호 없이
   * 돈다 — T28이 트랜잭션을 락 밖으로 뺀 바로 그 위험이다. 그래도 고치지
   * 않는다: 복구가 셀프서비스이고(참가 OTP를 다시 넣으면 `alreadySeated`
   * 경로가 점유자를 진실로 고쳐 쓴다) 해제는 착석 러시가 아니라 쉬는 시간에
   * 일어나 입장 트랜잭션과 겹칠 일이 드물다. 감수하는 것이지 막은 것이 아니다.
   */
  async releaseSeats(
    tournamentId: string,
    tableId: string,
    seats: { seatIndex: number; userId: string }[],
    ownerId: string,
  ) {
    await this.assertTournamentOwnership(tournamentId, ownerId);

    // 어떤 락보다도 먼저 확인한다(`claimSeat`의 "어떤 쓰기보다도 먼저"와 같은
    // 자리). 아래 `FOR UPDATE`가 tableId와 tournamentId를 묶어 주긴 하지만
    // 그건 이미 남의 테이블 락을 쥐고 DB를 한 바퀴 돈 뒤다 — A 대회 주인이
    // B 대회의 tableId를 넣어 B의 게임 락을 잡아 둘 수 있고, 404와 409의
    // 차이로 남의 좌석 상태를 떠볼 수도 있다.
    const table = await this.prismaService.table.findUnique({
      where: { tournamentId_id: { tournamentId, id: tableId } },
      select: { id: true },
    });
    if (!table) throw new NotFoundException('테이블을 찾을 수 없습니다.');

    // 락 안에서 만든 최종 스냅샷을 밖으로 들고 나온다. 브로드캐스트는 락을
    // 놓은 뒤에 하기 때문이다.
    let released: TableState | null = null;

    await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) throw new NotFoundException('테이블 상태를 찾을 수 없습니다.');

      // 핸드 중에는 자리가 움직이지 않는다. 이 가드 하나가 팟·차례·폴드
      // 상태·사이드팟을 전부 비껴간다. T28은 이 가드를 쓰지 않았다 — 신규
      // 착석은 핸드 도중이어도 폴드 상태로 들어가 아무것에도 끼지 않는다.
      // 이미 앉은 사람을 빼는 것은 다르다.
      if (state.phase !== GamePhase.WAITING) {
        throw new ConflictException('핸드 진행 중에는 좌석을 해제할 수 없습니다.');
      }

      // 검사 1 — 스냅샷(게임의 진실). 상점 화면이 낡았으면 여기서 걸린다.
      for (const s of seats) {
        if (state.players[s.seatIndex]?.id !== s.userId) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }
      }

      const seatIndexes = seats.map(s => s.seatIndex);
      const userIds = seats.map(s => s.userId);

      await this.prismaService.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Table"
          WHERE id = ${tableId} AND "tournamentId" = ${tournamentId}
          FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundException('테이블을 찾을 수 없습니다.');

        // 검사 2 — DB(좌석의 진실). 위 SELECT가 풀린 뒤의 **새 문장**이라
        // Read Committed가 스냅샷을 다시 뜬다. 방금 커밋된 입장이 보인다.
        const rows = await tx.tablePlayer.findMany({
          where: { tableId, seatPosition: { in: seatIndexes } },
          select: { seatPosition: true, userId: true },
        });
        const matched = rows.length === seats.length
          && seats.every(s => rows.some(r => r.seatPosition === s.seatIndex && r.userId === s.userId));
        if (!matched) {
          throw new ConflictException('좌석 정보가 바뀌었습니다. 화면을 새로 고쳐 주세요.');
        }

        // 검사 3 — 장부. 좌석 행과 스냅샷이 멀쩡해도 참가가 이미 끝난 사람이
        // 있다. **끝난 참가에 좌석이 남는 경로가 둘 있다.**
        //
        // - 킥: `handleDealerAction`이 상태를 `ELIMINATED`로 내리고
        //   `activePlayers`를 깎지만 `TablePlayer` 행은 지우지 않는다(엔진은
        //   폴드만 시킨다). 그 사람은 칩과 함께 스냅샷에 남는다.
        // - 우승: `tournamentFinished`가 `awardPrize`로 `AWARDED`를 매기고
        //   좌석은 그대로 둔다.
        //
        // 둘 다 좌석 행 + 스냅샷 점유 + `WAITING` 페이즈라 검사 1·2를 통과한다.
        // 그대로 `WAITING`으로 되돌리면 **끝난 참가가 되살아난다** —
        // `enterSeat`은 `ELIMINATED`/`AWARDED`만 막으므로 그 사람이 자기 OTP로
        // 다시 앉고, 나중에 진짜로 터질 때 `eliminatePlayer`가 같은 사람 몫으로
        // `activePlayers`를 두 번 깎는다. 상금 쪽은 더 직접적이다 —
        // `awardPrize`의 멱등 키가 곧 상태(`status: { notIn: [...] }`)라
        // `AWARDED`를 풀면 같은 등수의 포인트 지급이 다시 열린다.
        //
        // 조용히 건너뛰지 않고 요청 전체를 막는다. 상점이 체크한 사람 중
        // 하나가 실은 뗄 수 없는 사람이었다는 것은 화면이 낡았다는 뜻이고,
        // 부분 성공은 이 API가 하지 않기로 한 것이다.
        //
        // **이 검사는 위 `FOR UPDATE`가 지켜 주지 않는다.** 잠근 것은 `Table`
        // 행이라 `TablePlayer`의 INSERT/DELETE만 직렬화된다. 참가의 `status`는
        // 다른 행이고 다른 경로가 쓴다 — 킥은 같은 테이블 락 아래라 덤으로
        // 막히지만 `tournamentFinished`는 아니다. 그쪽은 `PLAYING`인 사람을
        // 테이블과 무관하게 `findFirst`로 골라 `AWARDED`를 매기므로, 1번
        // 테이블의 마지막 탈락이 2번 테이블에 앉은 사람에게 상금을 주는 동안
        // 우리가 2번 테이블에서 그 사람을 뗄 수 있다. 읽을 때는 `PLAYING`이던
        // 것이 쓸 때는 아니다.
        const parts = await tx.tournamentParticipation.findMany({
          where: { tournamentId, userId: { in: userIds } },
          select: { status: true },
        });
        const allPlaying = parts.length === userIds.length
          && parts.every(p => p.status === PlayerStatus.PLAYING);
        if (!allPlaying) {
          throw new ConflictException('앉아 있는 참가자만 해제할 수 있습니다. 화면을 새로 고쳐 주세요.');
        }

        await tx.tablePlayer.deleteMany({ where: { tableId, seatPosition: { in: seatIndexes } } });
        // 칩은 건드리지 않는다. 좌석만 사라지고 장부는 남는다(T29의 이사).
        //
        // `status: PLAYING`을 조건에 다시 건다. 위 검사와 중복으로 보이지만
        // 그 사이에 커밋된 수상을 덮어쓰지 않게 하는 것이 이 줄의 일이다 —
        // 조건이 없으면 방금 매겨진 `AWARDED`가 `WAITING`으로 지워지고,
        // 상금은 이미 나갔는데 멱등 키(=상태)가 다시 열려 같은 등수가 한 번 더
        // 지급될 수 있다. 조건에 걸려 0행이 되면 조용히 넘어가지 않고 던진다.
        //
        // **되돌리는 곳이 `WAITING`이 아니라 `RELEASED`다**(T55). `WAITING`은
        // "결제만 하고 한 번도 안 앉았다"는 뜻이고, 이 사람은 앉았다가 뗀
        // 사람이라 칩을 들고 살아 있다. 둘을 같은 값으로 두면
        // `activePlayers`가 셀 대상을 상태만으로 고를 수 없다 — 노쇼까지 세게
        // 되고, 그러면 최후 1인 판정이 영영 안 걸린다.
        //
        // 인원수는 여기서 줄이지 않는다. 자리를 뗐을 뿐 대회에서 나간 것이
        // 아니다(`store/session/player-status.ts`의 `LIVE_PLAYER_STATUSES`).
        const updated = await tx.tournamentParticipation.updateMany({
          where: { tournamentId, userId: { in: userIds }, status: PlayerStatus.PLAYING },
          data: { status: PlayerStatus.RELEASED },
        });
        if (updated.count !== userIds.length) {
          throw new ConflictException('해제 중 참가 상태가 바뀌었습니다. 다시 시도해 주세요.');
        }
      });

      for (const s of seats) state.players[s.seatIndex] = null;
      released = state;

      // **비트맵과 유저 컨텍스트도 락 안이다.** 원자 연산이라 그 자체는 락이
      // 필요 없지만, 필요한 것은 원자성이 아니라 **입장과의 순서**다. 락
      // 밖에 두면 우리가 락을 놓은 뒤 재입장이 비트를 1로 세우고 컨텍스트를
      // 쓴 **다음에** 우리 0과 삭제가 도착할 수 있다. 결과는 "비트 0 /
      // 스냅샷 있음 / 컨텍스트 없음"이고, 스스로 낫지 않는다 — 좌석 목록에는
      // 빈 자리로 보이는데 `TablePlayer`와 스냅샷은 앉아 있다고 말하는,
      // 시나리오 불변식(좌석 비트맵 == 스냅샷)이 깨진 상태다.
      //
      // 둘 다 왕복이 정해진 Redis 호출이라 "기다림이 무한정인 일 금지"를
      // 어기지 않는다. 브로드캐스트만 락 밖으로 남긴다.
      //
      // **스냅샷 쓰기보다 앞에 온다**(T42). `mutateSnapshot`이 fn이 돌아온
      // 뒤에 저장하기 때문이다. 예전에는 저장이 먼저였고 지금은 비트가 먼저
      // 내려가지만, 둘 다 같은 락 안이라 다른 쓰기가 그 사이에 끼지 못한다.
      // 갈리는 것은 락을 안 잡는 조회가 그 찰나에 볼 값뿐이고 — 예전에는
      // "빈 스냅샷 / 비트 1", 지금은 "앉은 스냅샷 / 비트 0" — 둘 다 이
      // 블록이 끝나며 사라진다. 위 문단이 말하는 **영구적인** 어긋남은
      // 순서가 아니라 "락 밖에 두는 것"에서 나온다.
      //
      // 이것이 닫는 것은 **해제 → 입장** 방향뿐이고, 그나마 **같은 테이블에
      // 한해서다.** 락이 테이블 단위라 그렇다. 비트맵은 테이블별 필드라
      // 문제가 없지만 유저 컨텍스트는 대회 단위이고, T29는 애초에 뗀 사람이
      // **다른 테이블**로 걸어가라고 있는 기능이다 — 트랜잭션이 커밋된 뒤
      // 2번 테이블에 앉은 사람의 컨텍스트를, 아직 1번 테이블 락을 쥔 우리가
      // 지울 수 있다. 그 컨텍스트를 읽는 곳은 `handleAction`의 KICKED 검사
      // 하나뿐이고 검사 3을 통과한 사람은 `PLAYING`이라 영향이 작아 감수한다.
      // 입장의 비트 쓰기가 자기 락 밖이라 늦게 도착하는 반대 방향(입장 →
      // 해제)도 그대로다. 그건 T28이 만든 자리라 여기서 고치지 않는다.
      //
      // 좌석 수만큼 반복 호출하지 않는다 — 한 테이블의 비트는 모두 같은
      // 해시 필드에 있어서, 여러 번 나눠 부르면 그 사이 Redis 장애가 끼었을 때
      // 일부 좌석만 비트가 내려가고 나머지는 영원히 "찬 자리"로 남는다(DB의
      // TablePlayer 행은 이미 사라진 뒤라 아무도 그 자리에 못 앉는다). 배치
      // 메서드 하나로 묶어 부분 성공을 없앤다.
      await this.redis.updateSeatBitmapMany(tournamentId, tableId, seatIndexes, false);
      await this.redis.deleteUserContexts(tournamentId, userIds);

      return state;
    });

    // 락 밖. 락을 쥔 채로 브로드캐스트하지 않는다.
    await this.emitSeatList(tournamentId);

    /*
      **뗀 사람의 태블릿은 그 자리에 그대로 켜져 있다.**

      위 `SEAT_LIST_UPDATED`는 대기 화면(아직 안 앉은 사람)이 듣는 신호다.
      이미 앉아 게임 화면을 보고 있는 사람에게는 아무것도 가지 않아서, 낡은
      펠트를 그대로 들고 있다가 다음 사람이 그 자리에 앉는 것을 보게 된다.
      좌석 화면은 자기 자리가 `null`이 된 스냅샷을 받아야 대기 화면으로
      돌아간다(`SeatGameClient`의 탈락 판정 (b)).

      `game.state.updated`는 게이트웨이가 그 테이블 방에 `renderGame`으로
      흘려보내는 이벤트다. 상태는 이미 락 안에서 저장한 것과 같은 값이고,
      여기서는 알리기만 한다.
    */
    if (released) this.eventEmitter.emit('game.state.updated', { tableId, state: released });
  }
}
