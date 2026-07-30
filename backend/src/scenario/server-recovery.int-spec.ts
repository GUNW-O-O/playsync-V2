import { ActionType, GamePhase, TableState } from 'src/game-engine/types';
import { getCurrentBlindLevel } from 'shared/util/util';
import { checkInvariants, forceClose, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T31 — 서버 장애 복구의 이음매.
 *
 * 부품은 각각 옳다(Task 1~3이 각자 통합 테스트로 증명했다). 여기서 보는 것은
 * **조립**이다 — 대회 하나 안에서 테이블 하나는 스냅샷을 잃고 하나는 살아
 * 있는 **부분 유실**, 그 위에 정지 시간 보정까지 겹쳤을 때 두 축(테이블 단위
 * 재구성 / 대회 단위 시간 보정)이 서로를 밟지 않는지.
 *
 * A와 B를 **일부러 다르게** 만든다(핸드 수를 다르게 돌려 스택과 버튼을
 * 갈라 놓는다). 둘이 같은 상태로 수렴하면 "손대지 않았다"와 "새로 세웠다"가
 * 같은 결과로 보여 구별할 수 없다 — recovery.service.int-spec.ts가 이미
 * 잡은 그 함정(CLAUDE.md 네 번째 가짜 초록)이다.
 */
describe('시나리오 — 서버 장애로부터의 부분 복구', () => {
  let h: Harness;
  let table2Id: string;

  const PLAYERS = ['p1', 'p2', 'p3', 'p4'];
  // 레벨 duration은 분 단위다(recovery.service.int-spec.ts와 같은 관례).
  // 1분짜리 레벨 둘 — 실제 몇 분을 기다리지 않고도 레벨 경계를 넘나든다.
  const STRUCTURE = [
    { lv: 1, sb: 100, ante: false, duration: 1 },
    { lv: 2, sb: 200, ante: false, duration: 1 },
  ];
  const TOTAL_CHIPS = SCENARIO.startStack * PLAYERS.length; // 40000
  const TABLE_CHIPS = SCENARIO.startStack * 2; // 테이블마다 두 명씩 — 20000
  const DOWNTIME_MS = 40_000;
  // 90초 전에 블라인드가 시작한 것으로 되돌려 둔다: duration 1분(60초)짜리
  // 레벨 둘이므로 90초 경과는 레벨 인덱스 1(두 번째 레벨, sb 200) 한가운데다.
  const ADVANCED_ELAPSED_MS = 90_000;

  // Step 0에서 캡처해 이후 단계가 비교하는 값들.
  let rawABefore: string;
  let buttonBAtLastCheckpoint: number;
  let blindStartedAtBeforeRecovery: number;

  afterAll(async () => { await forceClose(); });

  async function rawSnapshot(tableId: string): Promise<string | null> {
    return h.redis.get(`table:state:${tableId}`);
  }

  async function totalChips(): Promise<number> {
    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
    });
    return rows.reduce((sum, r) => sum + r.currentStack, 0);
  }

  async function setHeartbeatAgo(ms: number) {
    const beatAt = new Date(Date.now() - ms);
    await h.prisma.serverHeartbeat.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', beatAt },
      update: { beatAt },
    });
  }

  /** 핸드 하나를 열어서 쇼다운까지 체크/콜로만 밀고, 살아남은 사람 중 하나를 승자로 지명한다. */
  async function finishHandAt(tableId: string) {
    await h.dealer.startPreFlop(h.tournamentId, tableId);

    for (let guard = 0; guard < 40; guard++) {
      const state: TableState | null = await h.redisService.getSnapShot(tableId);
      if (!state) throw new Error(`핸드를 진행할 스냅샷이 없다 (table=${tableId})`);

      if (state.phase === GamePhase.SHOWDOWN) {
        const alive = state.players.filter(p => p && !p.hasFolded).map(p => p!.id);
        await h.dealer.resolveWinners(tableId, h.tournamentId, [alive.slice(0, 1)]);
        return;
      }

      const id = h.turnId(state);
      if (!id) {
        throw new Error(
          `핸드를 끝내지 못했다: table=${tableId} phase=${GamePhase[state.phase]} 차례없음`,
        );
      }
      const me = state.players[h.seatOf(state, id)]!;
      const action = me.bet === state.currentBet ? ActionType.CHECK : ActionType.CALL;
      await h.playsync.handleAction(id, tableId, { action } as never);
    }

    throw new Error(`핸드가 40번 안에 끝나지 않았다 (table=${tableId})`);
  }

  it('0. 두 테이블로 나누고, A와 B에서 각각 다른 수의 핸드를 돌린다', async () => {
    h = await setupTournament(PLAYERS, { blindStructure: STRUCTURE });

    // p1·p2는 테이블 A(기본 테이블)에 남긴다. p3·p4는 테이블 B로 옮긴다 —
    // `session.createTable` + 해제 + 재입장은 실제 상점 조작·플레이어 이동
    // 경로 그대로다(table-move.int-spec.ts와 같은 방식).
    const table2 = await h.session.createTable(h.tournamentId, SCENARIO.owner);
    table2Id = table2.id;

    await h.session.releaseSeats(
      h.tournamentId, h.tableId,
      [{ seatIndex: 2, userId: 'p3' }, { seatIndex: 3, userId: 'p4' }],
      SCENARIO.owner,
    );

    // 좌석은 일부러 인접하지 않게 고른다(0, 4) — 뒤에서 비트맵을 리터럴로
    // 검증할 때 "우연히 앞 두 칸"이 아니라는 것을 보이기 위함이다.
    for (const [seatIndex, userId] of [[0, 'p3'], [4, 'p4']] as const) {
      const participation = await h.prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: h.tournamentId, userId } },
      });
      await h.entry.enterSeat(h.tournamentId, {
        otp: participation.playerOtp, tableId: table2Id, seatIndex,
      });
    }

    await checkInvariants(h, '0. 분할 직후 A', TABLE_CHIPS);
    await checkInvariants(h, '0. 분할 직후 B', TABLE_CHIPS, table2Id);

    // A는 한 핸드, B는 세 핸드 — 핸드 수가 다르므로 버튼 진행과 정산 결과가
    // 갈린다. 재구성이 실제 마지막 상태를 읽는지(0이나 초기값으로 뭉개지
    // 않는지)를 이 차이가 증명한다.
    //
    // 세 핸드인 이유: 좌석이 {0, 4} 둘뿐인 헤즈업이라 버튼은 핸드마다
    // 0 → 4 → 0으로 교대한다. 두 핸드로 멈추면 마지막 버튼이 0인데, 그건
    // 착석 직후 초기값(`emptyTableState`의 `buttonUser: 0`)과 같은 값이라
    // "체크포인트를 실제로 읽었다"와 "초기값이 우연히 남았다"를 이 테스트가
    // 구별하지 못한다. 세 핸드로 4에서 멈추면 그 우연이 없다.
    await finishHandAt(h.tableId);
    await finishHandAt(table2Id);
    await finishHandAt(table2Id);
    await finishHandAt(table2Id);

    expect(`0. 핸드 후 총 칩 ${await totalChips()}`).toBe(`0. 핸드 후 총 칩 ${TOTAL_CHIPS}`);

    const bTable = await h.prisma.table.findUniqueOrThrow({ where: { id: table2Id } });
    // B가 핸드를 끝낸 적이 있으므로 버튼은 non-null이어야 한다 — null이면
    // 아래서 비교할 "마지막 체크포인트 값"이 의미를 잃는다(재구성이 null일
    // 때는 무작위로 새로 뽑기 때문이다). 0도 아니어야 한다 — 위 주석 참고.
    expect(bTable.buttonUser).not.toBeNull();
    expect(bTable.buttonUser).not.toBe(0);
    buttonBAtLastCheckpoint = bTable.buttonUser!;

    rawABefore = (await rawSnapshot(h.tableId))!;
    expect(rawABefore).not.toBeNull();
  });

  it('1. 테이블 B의 스냅샷만 지운다 — 부분 유실', async () => {
    await h.redis.del(`table:state:${table2Id}`);

    expect(await rawSnapshot(h.tableId)).not.toBeNull();
    expect(await rawSnapshot(table2Id)).toBeNull();
  });

  it('2. 하트비트가 과거로 찍혀 있고, 그동안 블라인드 시계도 흘렀다', async () => {
    // 실제 장애라면 서버가 죽어 있는 동안에도 벽시계는 흐른다. 하트비트
    // 간격(다운타임)과 블라인드 기준점이 둘 다 "실제로 시간이 지났다"는
    // 같은 사실을 표현해야 하므로 함께 되돌린다.
    const blind = (await h.redisService.getTournamentBlind(h.tournamentId))!;
    blindStartedAtBeforeRecovery = Date.now() - ADVANCED_ELAPSED_MS;
    await h.redisService.setTournamentBlind(h.tournamentId, {
      ...blind,
      startedAt: blindStartedAtBeforeRecovery,
      // 과거로 둔다 — `checkAndSyncBlindLevel`은 `now < nextLevelAt`이면
      // 재계산 없이 캐시된 값을 그대로 돌려주는 최적화가 있다. 미래로 두면
      // 그 분기에 걸려 재계산 경로를 타지 않는다(Task 2 보고서가 이미
      // 확인한 함정).
      nextLevelAt: Date.now() - 1_000,
    });

    // 실제로 Redis를 다시 읽어 확인한다(가짜 초록 방지) — 단, 확인 수단이
    // `checkAndSyncBlindLevel`이면 안 된다. 그 함수는 재계산할 때 지금
    // `startedAt`(아직 정지 시간 보정 전) 기준으로 `nextLevelAt`을 **미래**로
    // 다시 써 버린다. 이 시나리오는 실제 벽시계를 흘려보내지 않고 하트비트
    // 타임스탬프만으로 다운타임을 흉내 내므로, 그 미래 `nextLevelAt`이 4단계의
    // "진짜" 재계산까지 캐시 최적화에 걸려 막아 버린다(순수 계산으로 다시
    // 확인한 결과 이 실패를 실제로 봤다). 그래서 부작용 없는 순수 함수로
    // "지금 이 기준점이면 레벨이 얼마인가"만 확인한다.
    const preRecoveryLevel = getCurrentBlindLevel(STRUCTURE, blindStartedAtBeforeRecovery);
    expect(`2. 복구 전(보정 없이) 레벨 ${preRecoveryLevel.currentIndex}`)
      .toBe('2. 복구 전(보정 없이) 레벨 1');

    await setHeartbeatAgo(DOWNTIME_MS);
  });

  it('3. recoverAll을 돌리면 부분 유실이 복구된다', async () => {
    await h.recovery.recoverAll();

    // 칩 총량 보존 (참가 행 currentStack 합).
    expect(`3. 복구 후 총 칩 ${await totalChips()}`).toBe(`3. 복구 후 총 칩 ${TOTAL_CHIPS}`);

    // A의 스냅샷은 바이트 단위로 그대로 — 손대지 않았다.
    expect(await rawSnapshot(h.tableId)).toBe(rawABefore);

    // B의 buttonUser == 마지막 체크포인트 값.
    const bState = await h.redisService.getSnapShot(table2Id);
    expect(bState).not.toBeNull();
    expect(`3. B 버튼 ${bState!.buttonUser}`).toBe(`3. B 버튼 ${buttonBAtLastCheckpoint}`);

    // 좌석 비트맵 == 스냅샷 점유 좌석 (B). 리터럴로 고정한다 — 비트맵과
    // 스냅샷이 둘 다 같은 `seatPosition`에서 파생되면 같은 off-by-one을
    // 공유해 서로를 가릴 수 있다(recovery.service.int-spec.ts와 같은 이유).
    const bitmapB = await h.redis.hget(`tournament:${h.tournamentId}:seat`, `table:${table2Id}`);
    expect(bitmapB).toBe('100010000'); // 좌석 0, 4

    // 하네스가 값싸게 제공하는 나머지 불변식(칩 보존, 사이드팟 합, 폴드
    // 자격, 쇼다운 차례, 좌석 비트맵 개수)도 두 테이블 각각에서 확인한다.
    await checkInvariants(h, '3. 복구 후 A', TABLE_CHIPS);
    await checkInvariants(h, '3. 복구 후 B', TABLE_CHIPS, table2Id);
  });

  it('4. 블라인드 레벨이 정지 시간만큼 되돌아오고, 밀린 양은 테이블 수와 무관하다', async () => {
    // 90초 경과 - 40초 다운타임 보정 = 50초. 60초(레벨 0 duration) 미만이므로
    // 레벨이 0으로 되돌아가야 한다.
    const synced = await h.redisService.checkAndSyncBlindLevel(h.tournamentId);
    expect(`4. 복구 후 레벨 ${synced!.currentBlindLv}`).toBe('4. 복구 후 레벨 0');

    const after = (await h.redisService.getTournamentBlind(h.tournamentId))!.startedAt;
    const shifted = after - blindStartedAtBeforeRecovery;

    // 밀린 양은 다운타임(40000ms) 근처여야 한다. 테이블이 둘인데 테이블
    // 루프 안에서 밀리는 회귀가 생기면 2배(≈80000ms)가 되어 이 상한을
    // 넘는다 — 그 회귀를 잡는 것이 이 경계값의 목적이다.
    expect(shifted).toBeGreaterThan(35_000);
    expect(shifted).toBeLessThan(50_000);
  });

  it('5. 이어서 B에서 핸드를 하나 더 돌리면 정상 진행된다', async () => {
    await finishHandAt(table2Id);

    await checkInvariants(h, '5. 추가 핸드 후 B', TABLE_CHIPS, table2Id);
    expect(`5. 복구 후 총 칩 ${await totalChips()}`).toBe(`5. 복구 후 총 칩 ${TOTAL_CHIPS}`);
  });
});
