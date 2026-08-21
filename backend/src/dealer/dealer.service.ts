import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, TournamentStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { DealerDto } from 'shared/dto/dealer.dto';
import { deriveAnteAmount } from 'shared/util/util';
import { tokenTtl } from 'src/auth/token-ttl';
import { verifyDealerOtp } from 'src/dealer/dealer-otp';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { TableEngine } from 'src/game-engine/table-engine';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { isClosedTournament } from 'src/store/session/tournament-status';

/**
 * 이 테이블의 Redis 스냅샷이 없다.
 *
 * 딜러 경로의 실패는 상태코드가 아니라 **메시지**로 나간다
 * (`{ event: 'error', data: e.message }`). 그래서 문자열 자체가 안내다.
 *
 * 예전에는 스냅샷 없음과 토너먼트 정보 없음이 똑같이 '예기치 못한 오류가
 * 발생했습니다.'였다. 둘은 딜러가 할 일이 다르다 — 스냅샷이 없으면 이 테이블은
 * 더 진행할 수 없어 운영자를 불러야 하고, 토너먼트 정보가 없으면 대회 자체의
 * 문제다. 같은 문자열이면 딜러는 그냥 다시 누르고, 로그에도 구분이 남지 않는다.
 *
 * 상수인 이유는 여섯 곳이 같은 원인이기 때문이다. 원인이 같으면 문구도 같아야
 * 하고, 한 곳만 고쳐 어긋나는 일이 없어야 한다.
 */
const SNAPSHOT_MISSING = '테이블 상태를 찾을 수 없습니다. 진행을 멈추고 운영자에게 알려주세요.';

@Injectable()
export class DealerService {
  constructor(
    @InjectQueue('player-timeout') private timeoutQueue: Queue,
    private prisma: PrismaService,
    private redis: RedisService,
    private playsync: PlaysyncService,
    private jwtService: JwtService,
    private otpAttempts: OtpAttempts,
  ) { }

  async loginDealer(dto: DealerDto) {
    // 슬롯 예약이 곧 게이트다. 반드시 bcrypt **앞**이어야 한다 — 뒤로 가면
    // 대조 한 라운드(~80ms)만큼 창이 열려, 그 사이 동시에 들어온 요청이 전부
    // 한도를 지나쳐 스레드풀까지 함께 태운다.
    await this.otpAttempts.reserveAttempt(dto.tournamentId);

    // **해시를 읽는 유일한 곳이다.** `PrismaService`가 `dealerOtpHash`를 기본
    // 감춤으로 두므로 여기서만 켠다 — 이 한 줄이 곧 "열람 경로는 여기뿐"이라는
    // 선언이고, 다른 쿼리가 해시를 실으려면 같은 줄을 명시해야 해서 리뷰에
    // 걸린다.
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: dto.tournamentId },
      include: { dealerSession: true },
      omit: { dealerOtpHash: false },
    });

    // 대회가 없을 때와 OTP가 틀렸을 때의 응답을 가르지 않는다. 가르면
    // 존재하는 대회 id를 훑을 수 있다.
    const ok =
      tournament !== null &&
      (await verifyDealerOtp(dto.otp, tournament.dealerOtpHash));

    // 실패해도 여기서 셀 것이 없다. 슬롯은 이미 위에서 소비했다.
    if (!ok) {
      throw new UnauthorizedException('인증 정보가 올바르지 않습니다.');
    }

    // **여기서부터는 추측이 아니다.** 대조를 통과했으므로 위에서 쓴 슬롯을
    // 되돌린다. 아래 검사들(닫힌 대회 · 딜러 세션 없음 · 남의 테이블)은 OTP와
    // 무관한 이유로 막는 것이라, 카운터에 흔적을 남기면 여섯 번째 재시도부터
    // 안내가 "시도가 너무 많습니다"로 바뀌어 진짜 원인을 가린다(T53).
    //
    // 성공 경로의 `clear`와 겹치지 않는다 — `clear`는 토큰이 나간 뒤 카운터를
    // 통째로 지우는 것이고, 여기는 **이 요청이 쓴 한 칸**만 돌려준다.
    await this.otpAttempts.refund(dto.tournamentId);

    // 닫힌 대회의 OTP는 더 이상 유효하지 않다. 취소도 마찬가지다 — 환불까지
    // 끝난 대회에 딜러가 붙을 이유가 없다.
    if (isClosedTournament(tournament.status)) {
      throw new ForbiddenException('닫힌 대회입니다.');
    }

    if (!tournament.dealerSession) {
      // OTP는 맞았는데 딜러 세션이 없다. 인증 실패가 아니라 대회 준비가
      // 덜 된 상태라, 딜러가 OTP를 다시 입력해도 달라지지 않는다.
      throw new ConflictException(
        '딜러 세션이 준비되지 않았습니다. 상점에 문의해주세요.',
      );
    }

    /** 승격이 있었으면 갱신 후 인원. 없었으면 `null`이라 대입도 건너뛴다. */
    let activePlayersAfter: number | null = null;

    const issued = await this.prisma.$transaction(async (tx) => {
      // dto.tableId가 이 대회 소속인지 상태와 무관하게 먼저 확인한다. 이전에는
      // ONGOING일 때만 조회해서, 그 밖의 상태(PENDING·SYNCING)에서는 다른
      // 대회의 테이블 id를 그대로 서명해 버렸다 — 위협모델 관찰 5.
      const table = await tx.table.findUnique({
        where: { tournamentId_id: { tournamentId: dto.tournamentId, id: dto.tableId } },
        include: { tablePlayers: true }
      });

      if (!table) {
        throw new ForbiddenException('이 대회에 속하지 않은 테이블입니다.');
      }

      if (tournament.status === 'ONGOING') {
        // 앉아 있는데 아직 `WAITING`인 사람을 올린다. T28 이후로는 착석이
        // 이미 올리므로 평소에는 0행이고, 남겨 두는 것은 옛 데이터를 위한
        // 보정이다.
        //
        // **올렸으면 인원수도 같이 올린다**(T55). 여기가 두 번째 승격
        // 지점이라, 카운터를 착석 한 곳에만 붙이면 이 경로로 올라간 사람이
        // 영영 안 세어진다 — 그러면 최후 1인 판정이 실제보다 일찍 걸린다.
        const userIds = table.tablePlayers.map(p => p.userId);
        const promoted = await tx.tournamentParticipation.updateMany({
          where: {
            userId: { in: userIds },
            tournamentId: dto.tournamentId,
            status: 'WAITING'
          },
          data: { status: 'PLAYING' }
        });
        if (promoted.count > 0) {
          const updated = await tx.tournament.update({
            where: { id: dto.tournamentId },
            data: { activePlayers: { increment: promoted.count } },
            select: { activePlayers: true },
          });
          activePlayersAfter = updated.activePlayers;
        }
      }
      const accessToken = {
        sub: tournament.dealerSession!.id,
        tournamentId: dto.tournamentId,
        tableId: dto.tableId,
        role: Role.DEALER,
        tokenVersion: tournament.dealerSession!.tokenVersion,
      }
      return {
        // 딜러 태블릿도 근무 내내 켜져 있다. 갱신 경로(`POST /dealer/refresh`)가
        // 따로 있지만 그것은 **폐기**를 위한 것이고(`tokenVersion` 대조),
        // 수명이 짧아야 할 이유는 아니다. 근거는 `token-ttl.ts`에.
        accessToken: this.jwtService.sign(accessToken, {
          expiresIn: tokenTtl(Role.DEALER),
        }),
      }
    });

    // 카운터는 **토큰이 실제로 나간 뒤에** 지운다. OTP는 맞았지만 tableId가 남의
    // 것이라 위에서 403이 나가는 요청까지 리셋해 줄 이유가 없다.
    await this.otpAttempts.clear(dto.tournamentId);

    // 전광판이 읽는 인원도 DB 값으로 맞춘다(T60). 승격이 DB만 올리면 이 경로로
    // 올라간 사람이 전광판과 최후 1인 판정에서 영영 빠진다. 실패 경로에서
    // 부르지 않는 것은 위 `clear`와 같은 이유다 — 토큰이 나간 뒤가 맞는 자리다.
    if (activePlayersAfter !== null) {
      await this.redis.syncActivePlayer(
        dto.tournamentId, activePlayersAfter, tournament.startStack, tournament.entryFee,
      );
    }

    return issued;
  }

  /**
   * 이 딜러 세션이 지금도 유효한지 확인하고 세션을 돌려준다.
   *
   * 갱신(`refreshToken`)과 WS 티켓 발급이 같은 다섯 가지를 본다. 검사가 두
   * 벌이 되면 한쪽만 고쳐지는 날이 오고, 그날 폐기된 딜러가 한쪽 경로로
   * 계속 들어온다.
   */
  async assertDealerSessionValid(payload: {
    sub: string;
    tournamentId: string;
    tableId: string;
    tokenVersion: number;
  }) {
    const session = await this.prisma.dealerSession.findUnique({
      where: { id: payload.sub },
      include: {
        tournament: { select: { status: true } },
        tables: { select: { id: true } },
      },
    });

    if (!session || session.tournamentId !== payload.tournamentId) {
      throw new ForbiddenException('갱신할 수 없는 세션입니다.');
    }
    if (isClosedTournament(session.tournament.status)) {
      throw new ForbiddenException('닫힌 대회입니다.');
    }
    if (session.tokenVersion !== payload.tokenVersion) {
      throw new ForbiddenException('만료된 딜러 세션입니다.');
    }
    if (!session.tables.some((t) => t.id === payload.tableId)) {
      throw new ForbiddenException('이 세션에 속하지 않은 테이블입니다.');
    }

    return session;
  }

  /**
   * 갱신은 새 권한을 만들지 않는다.
   *
   * sub는 기존 토큰에서 그대로 옮긴다. tableId는 클라이언트가 보낸 값을 쓰되,
   * 이 세션(대회) 소속 테이블인지 확인한 뒤에만 서명한다 — 검증 없이 그대로
   * 옮기면 갱신이 다른 대회의 테이블로 넘어가는 권한 상승 경로가 된다.
   */
  async refreshToken(payload: {
    sub: string;
    tournamentId: string;
    tableId: string;
    tokenVersion: number;
  }) {
    const session = await this.assertDealerSessionValid(payload);

    return {
      accessToken: this.jwtService.sign(
        {
          sub: session.id,
          tournamentId: session.tournamentId,
          tableId: payload.tableId,
          role: Role.DEALER,
          tokenVersion: session.tokenVersion,
        },
        { expiresIn: tokenTtl(Role.DEALER) },
      ),
    };
  }

  async startPreFlop(tournamentId: string, tableId: string) {
    return this.redis.mutateSnapshot(tableId, async (state) => {
      const blind = await this.redis.checkAndSyncBlindLevel(tournamentId);
      // 이 값이 없다는 것은 **대회 메타가 Redis에 없다**는 뜻이고, 그건
      // 아직 `startSession`이 돌지 않았다는 뜻이다(T31의 복구 경로에서도
      // 메타부터 세운다). 딜러가 화면에서 읽는 문구이므로 원인이 아니라
      // 그가 할 수 있는 일로 적는다 — "블라인드 정보가 없습니다"는 딜러가
      // 어찌할 도리가 없는 말이다.
      if (!blind) throw new Error('대회가 아직 시작되지 않았습니다.');
      if (blind.isBreak) {
        throw new Error('휴식 상태입니다.');
      }
      // 시작할 수 없는 상태면 아무것도 건드리지 않고 거절한다.
      //
      // 이 검사가 잡 제거보다 뒤로 가면, 이미 진행 중인 핸드에서 액션을
      // 기다리던 플레이어의 타이머를 지우고 나가게 된다 — 아무도 타이머가
      // 없는 상태가 되어 그 유저가 자리를 비우면 라운드가 끝나지 않는다.
      //
      // 조용한 `return`이 아니라 `throw`인 이유: 실패를 undefined로 표현하면
      // 게이트웨이가 그걸 renderGame으로 브로드캐스트해 테이블 전원의 상태를
      // undefined로 덮는다. 딜러의 오조작 한 번에 전 화면이 날아가는 셈이다.
      // 실패는 예외로 올리고 경계에서 잡는다.
      if (!state) throw new Error('테이블을 찾을 수 없습니다.');
      if (state.phase !== GamePhase.WAITING) {
        throw new Error('대기 상태가 아닙니다.');
      }

      // T58: state.ante는 boolean이 아니라 금액이다. sb / 5 계산은
      // deriveAnteAmount 한 곳에만 둔다 — RecoveryService의 재구성도 같은
      // 함수를 쓴다. 여기서 각자 계산하면 T64가 걷어낸 "두 벌" 문제가
      // 다시 생긴다.
      const level = blind.blindStructure[blind.currentBlindLv];
      state.smallBlind = level.sb;
      state.ante = deriveAnteAmount(level.sb, level.ante);
      const engine = new TableEngine(state);
      engine.startPreFlop();

      await this.playsync.scheduleTurnTimeout(tableId, state);
      return engine.state;
    });
  }

  async handleDealerAction(tournamentId: string, tableId: string, targetUserId: string, type: 'FOLD' | 'KICK') {
    /**
     * 킥 트랜잭션이 돌려준 값. 전광판 카운터를 맞추는 데 쓴다(T60).
     *
     * **`mutateSnapshot` 콜백 안에서 Redis에 쓰지 않는다.** 대입 자체는 락과
     * 무관하지만, 콜백 안의 예외는 스냅샷 쓰기를 통째로 되돌린다 — 되돌아가지
     * 않는 부수효과를 그 안에 섞으면 스냅샷만 과거로 돌아간 세계가 남는다.
     */
    let counter: { activePlayers: number; startStack: number; entryFee: number } | null = null;

    const state = await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) throw new Error(SNAPSHOT_MISSING);
      const engine = new TableEngine(state);
      const targetIdx = state.players.findIndex(p => p?.id === targetUserId);

      // 대상이 없으면 큐를 건드리기 전에 나간다.
      if (targetIdx === -1) throw new Error("대상 플레이어를 찾을 수 없습니다.");

      if (type === 'FOLD') {
        await engine.act(targetIdx, ActionType.DEALER_FOLD);
      } else if (type === 'KICK') {
        await engine.act(targetIdx, ActionType.DEALER_KICK);
        await this.redis.setUserContext(tournamentId, targetUserId, tableId, targetIdx, 'KICKED');

        // 상태 변경과 카운터 감소가 한 트랜잭션이어야 한다. 따로 두면 두 번째가
        // 실패했을 때 탈락했는데 인원수는 그대로인 상태가 남는다.
        //
        // 그리고 `decrement: 1`은 멱등이 아니다. 딜러가 킥을 두 번 누르면 두 번
        // 준다. 이미 탈락한 사람은 `where`에서 걸러 **실제로 바뀐 행 수만큼만**
        // 줄인다.
        //
        // 바뀐 행이 없어도 현재 값을 읽어 나간다(T60). 전광판 카운터는 대입이라
        // 멱등을 위한 가드가 필요 없고, 중복 킥은 오히려 어긋난 값을 지우는
        // 기회다.
        counter = await this.prisma.$transaction(async (tx) => {
          const changed = await tx.tournamentParticipation.updateMany({
            where: {
              tournamentId,
              userId: targetUserId,
              status: { notIn: ['ELIMINATED', 'AWARDED'] },
            },
            data: { status: 'ELIMINATED' }
          });
          const select = { activePlayers: true, startStack: true, entryFee: true } as const;
          if (changed.count === 0) {
            return await tx.tournament.findUniqueOrThrow({
              where: { id: tournamentId },
              select,
            });
          }
          return await tx.tournament.update({
            where: { id: tournamentId },
            data: { activePlayers: { decrement: changed.count } },
            select,
          });
        });
      }

      await this.playsync.scheduleTurnTimeout(tableId, state);
      return state;
    });

    // 킥은 최후 1인 판정을 부르지 않는다. `tournamentFinished`를 부르는 자리는
    // `PlaysyncService.eliminatePlayer` 하나뿐이라, 킥으로 마지막 한 명이 남으면
    // 대회를 닫을 경로가 없다 — 그 상황("헤즈업에서 딜러가 킥한다")은 규칙으로
    // 막는다(`docs/backlog.md`의 파이널 테이블부터의 딜러 개입 제한).
    // **그 규칙이 서기 전까지 이 구멍은 남는다.** 여기서는 카운터만 맞춘다.
    if (counter !== null) {
      const { activePlayers, startStack, entryFee } = counter;
      await this.redis.syncActivePlayer(tournamentId, activePlayers, startStack, entryFee);
    }

    return state;
  }

  /**
   * 정산은 세 구간으로 나뉘고, 가운데만 락 밖이다.
   *
   * 1. 팟 분배 — 락 안. 짧고 순수한 계산이다.
   * 2. 리바인 응답 대기 — **락 밖.** 최대 15초짜리 사람 입력이다. 이걸 락 안에
   *    두면 그동안 테이블 전체가 멎는다(그래서 예전엔 TTL을 30초로 늘려야 했다).
   *    대신 1단계가 남긴 `HAND_END`가 문지기가 된다 — `startPreFlop`은 `WAITING`만
   *    받으므로 이 구간에 다음 핸드가 시작되지 않는다.
   * 3. 탈락 확정과 초기화 — 락 안. 스냅샷을 **다시 읽는다.** 2단계 동안 각 리바인이
   *    자기 락을 잡고 스택을 반영했으므로, 1단계의 객체는 이미 낡았다.
   *
   * @param winnerGroups 동점 그룹의 배열. 순서가 순위다.
   *   `[['a','b'], ['c']]` = a와 b가 공동 1위, c가 3위.
   *   보드 하이면 살아남은 전원이 한 그룹에 들어간다.
   */
  async resolveWinners(tableId: string, tournamentId: string, winnerGroups: string[][]) {
    const tournamentInfo = await this.redis.getTournamentDashboard(tournamentId);
    if (!tournamentInfo) throw new Error('토너먼트 정보를 찾을 수 없습니다. 대회 상태를 확인해야 합니다.');
    if (winnerGroups.length === 0 || winnerGroups.some(g => g.length === 0)) {
      throw new Error("유효한 승자가 없습니다.");
    }

    // 1. 팟 분배
    const settled = await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) throw new Error(SNAPSHOT_MISSING);

      const engine = new TableEngine(state);
      await engine.resolveWinner(winnerGroups);
      return state;
    });

    // 파산자 추리기는 **락 밖**이다. 다시 읽는 것이 아니라 방금 저장한 그
    // 객체를 순회하는 순수 계산이라 새 레이스가 아니다 — `mutateSnapshot`이
    // 상태를 돌려주는 이유가 이것이다.
    const brokePlayerIds = settled.players
      .filter((p): p is TablePlayer => p != null && p.stack <= 0)
      .map(p => p.id);

    // 2. 리바인 — 락 밖. 전원에게 동시에 묻고 같은 마감을 준다.
    //    수락한 사람은 남을 기다리지 않고 그 즉시 반영·전파된다.
    if (tournamentInfo.isRegistrationOpen && brokePlayerIds.length > 0) {
      await Promise.all(
        brokePlayerIds.map(playerId =>
          this.playsync.processRebuy(
            tournamentId,
            tableId,
            playerId,
            tournamentInfo.entryFee,
            tournamentInfo.startStack,
            tournamentInfo.tournamentName,
          ),
        ),
      );
    }

    // 3. 탈락 확정 — 락 안. 스냅샷은 아직 HAND_END다.
    await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) throw new Error(SNAPSHOT_MISSING);

      // 리바인으로 살아난 사람은 여기서 이미 스택이 있다.
      const eliminatedPlayers = state.players
        .filter((p): p is TablePlayer => p != null && p.stack <= 0);

      await this.playsync.eliminatePlayer(tournamentId, tableId, eliminatedPlayers, tournamentInfo);
      return state;
    });

    // 4. 체크포인트 — **락 밖.** 재시도가 백오프까지 포함하면 수 초가 되는데
    //    락 TTL은 5초다. 리바인 대기를 락 밖으로 뺀 것과 같은 이유다.
    //    HAND_END가 그동안 문지기 역할을 계속한다.
    const synced = await this.playsync.checkpointTableToDb(tableId);

    // 5. 다음 핸드 준비 — 락 안.
    //
    // 체크포인트가 실패했으면 여기로 오지 않는다. 핸드 경계에서 진실의 원천이
    // 교대하기 때문이다 — DB 트랜잭션이 성공한 시점까지는 DB가 원천이고,
    // initTable이 WAITING으로 넘기는 순간부터 Redis 스냅샷이 원천이다.
    // 체크포인트 없이 넘기면 복구 지점이 한 핸드 뒤에 남는데, 카드가 실물이라
    // 되돌릴 근거가 테이블 위에 없다.
    //
    // 그래서 HAND_END에 멈추는 것은 버그가 아니라 안전 상태다. 대신 나올
    // 길이 있어야 한다 — `retryCheckpoint`가 그것이다.
    if (!synced) {
      const failed = await this.redis.getSnapShot(tableId);
      if (!failed) throw new Error(SNAPSHOT_MISSING);
      return failed;
    }

    return this.finishHand(tableId);
  }

  /**
   * 실패한 체크포인트를 딜러가 다시 시도한다.
   *
   * 멈추는 것 자체는 올바른 동작이므로 되돌리는 기능이 아니다. 막다른 골목을
   * 없애는 기능이다.
   *
   * **문지기는 페이즈뿐이다**(T62). 예전에는 `dbSyncStatus === 'FAILED'`도
   * 요구했는데, 그 표시는 `markDbSyncStatus` → `mutateSnapshot` →
   * `withTableLock`이라 **Redis가 힘들면 남길 수 없다.** 표시를 조건에 두면
   * 표시를 못 남긴 실패가 바로 그 순간 나올 길을 닫는다 — 없애려던 막다른
   * 골목을 조건 자체가 만들고 있었다.
   *
   * 표시 없이 통과시켜도 안전한 이유는 `HAND_END`가 진짜 문지기라서다. 이
   * 페이즈에서는 `startPreFlop`도 `act()`도 거절하고, 체크포인트는 같은 값을
   * 다시 쓰는 것이라 겹쳐도 장부가 어긋나지 않는다. 실제 전이는 `finishHand`가
   * 락 안에서 페이즈를 다시 보고 결정한다.
   */
  async retryCheckpoint(tableId: string) {
    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new Error('테이블을 찾을 수 없습니다.');
    if (state.phase !== GamePhase.HAND_END) {
      throw new Error('재시도할 체크포인트가 없습니다.');
    }

    const synced = await this.playsync.checkpointTableToDb(tableId);
    if (!synced) {
      const failed = await this.redis.getSnapShot(tableId);
      if (!failed) throw new Error(SNAPSHOT_MISSING);
      return failed;
    }
    return this.finishHand(tableId);
  }

  /**
   * 체크포인트가 찍힌 뒤에만 부른다. 원천이 Redis로 넘어가는 지점.
   *
   * **락 안에서 페이즈를 다시 본다**(T62). 부르는 쪽이 페이즈를 확인한 뒤
   * 체크포인트가 **락 밖에서** 수 초를 돌기 때문에, 그사이 다른 경로가 다음
   * 핸드를 시작했을 수 있다. 그 상태에서 `initTable`을 돌리면 살아 있는 판의
   * `pot`과 베팅을 0으로 밀어 칩이 사라진다 — 카드가 실물이라 되돌릴 근거가
   * 테이블 위에 없다. 이미 넘어간 뒤라면 할 일이 없으므로 그대로 둔다.
   */
  private async finishHand(tableId: string): Promise<TableState> {
    const next = await this.redis.mutateSnapshot(tableId, async (state) => {
      if (!state) throw new Error(SNAPSHOT_MISSING);
      // null은 "쓰지 않는다"다. 현재 스냅샷이 그대로 돌아간다.
      if (state.phase !== GamePhase.HAND_END) return null;

      delete state.dbSyncStatus;
      await new TableEngine(state).initTable();
      return state;
    });
    // 위에서 없으면 던졌으므로 여기 null이 올 수 없다. 타입만 좁힌다.
    if (!next) throw new Error(SNAPSHOT_MISSING);
    return next;
  }

}
