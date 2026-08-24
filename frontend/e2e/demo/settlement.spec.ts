import { Page } from '@playwright/test';
import {
  chipsOnTable,
  dashboard,
  login,
  seat,
  tableState,
  type DemoTableState,
} from '../fixtures/backstage';
import {
  PHASE,
  clickAction,
  enterDealer,
  linger,
  openWithToken,
  press,
  resolveWinnersOnScreen,
  shoot,
  sitDown,
  startHandOnScreen,
} from '../fixtures/screen';
import { expect, test } from '../fixtures/surfaces';
import { dealerToken, openWire, type Wire } from '../fixtures/wire';

/**
 * 정산 촬영. **35명짜리 대회 하나를 파이널 테이블까지 몰고 가서 닫는다.**
 *
 * 장면 1~5(`tournament.spec.ts`)와 무대를 나눈 이유는 규모다. 마무리 셋
 * ─ 종료 · ICM · 중단 ─ 은 **파이널 테이블에 도달해야** 문이 열리는데,
 * 일곱 명짜리 무대에서는 첫 핸드가 곧 파이널 테이블이라 「필드가 줄어든다」가
 * 사라진다. 시드는 하나이고 무대가 둘이다(`backend/prisma/seed.ts`).
 *
 * ── 증명하는 것
 *
 * **끝나는 길이 여럿인데 보존 등식은 하나다.**
 *
 * ```
 * 걷은 참가비 == 나간 상금 + 환불 + 상점 몫
 * ```
 *
 * 그래서 이 스펙은 **같은 시드에서 여러 번 돈다.** `DEMO_ENDING`이 마지막
 * 갈림목만 바꾸고 앞은 전부 같다 — 같은 풀에서 출발해 다른 문으로 나가고,
 * 합이 같다. 짝이 되는 시나리오 테스트는 각각
 * `backend/src/scenario/`의 `full-tournament` · `icm-chop` ·
 * `abort-settlement`이고, 여기서 보는 것은 그 성질이 **화면에 도달하는가**다.
 *
 * ── 필드를 줄이는 방법
 *
 * **스택을 손으로 벌리지 않는다**(장면 1~5와 같은 규칙). 서른한 번의 탈락을
 * 한 번에 하나씩 만들면 서른한 판이라 촬영이 불가능한데, 그렇다고 참가 행을
 * `ELIMINATED`로 바꾸면 화면에 뜨는 등수와 상금이 촬영이 지어낸 값이 된다.
 *
 * 그래서 **한 판에 여섯이 올인한다.** 딜러가 하나를 지명하면 다섯이 그
 * 자리에서 탈락한다 — 진짜 올인이고 진짜 지명이라 규칙을 어기지 않으면서
 * 서른한 번의 탈락이 세 판으로 접힌다.
 *
 * ── 카메라가 넷인데 테이블이 넷이다
 *
 * 면은 다섯을 연다(좌석 둘 · 딜러 하나 · 전광판 · 콘솔). 나머지 세 테이블은
 * **화면 없이 진짜 소켓으로** 돈다(`fixtures/wire.ts`) — 브라우저 컨텍스트로
 * 서른다섯을 열면 기계가 먼저 죽고, 그렇다고 안 돌리면 필드가 줄어든 것이
 * 가짜가 된다.
 *
 * 촬영 테이블(1번)이 **병합의 종착지**다. 카메라가 클라이맥스에 딴 테이블을
 * 보고 있으면 안 되므로, 합칠 때는 언제나 이쪽으로 걸어온다.
 */

/** 마지막 갈림목. 앞은 전부 같다. */
type Ending = 'complete' | 'chop' | 'abort';
const ENDING = (process.env.DEMO_ENDING ?? 'chop') as Ending;

/**
 * 테스트 제목이 곧 **촬영 폴더 이름**이다(`surfaces.ts`의 `slug`).
 *
 * 그래서 제목에 **무엇을 찍은 촬영인지**를 적는다. `정산-chop` 같은 이름은
 * 폴더를 열어 봐야 무엇인지 알 수 있고, `자르는 쪽`(`make-demo-assets.mjs`)이
 * 그 폴더를 상수로 가리키므로 이름이 곧 계약이다.
 */
const TAKE_TITLE: Record<Ending, string> = {
  complete: '마무리 — 최후 1인으로 닫는다',
  chop: '마무리 — ICM으로 닫는다',
  abort: '마무리 — 중단하고 환불한다',
};

/** 카메라가 보는 테이블. 병합의 종착지이자 파이널 테이블이 된다. */
const FILMED_TABLE = 1;

/**
 * 화면으로 앉는 둘.
 *
 * 하나는 **살아남고**(A1 — 첫 판에 폴드한다) 하나는 **탈락했다 돌아온다**
 * (A5 — 올인해서 지고 리바인을 수락한다). 둘을 고른 것은 리바인이 이
 * 촬영에서 두 몫을 하기 때문이다 — 오버레이가 뜨는 장면이면서, **엔트리를
 * 36으로 올려 상금권 인원을 늘리는** 사건이다.
 */
const ON_SCREEN = { survivor: 'A1', rebuyer: 'A5' } as const;

/**
 * 필드를 줄이는 판의 기본 인원. **여섯이 올인하면 다섯이 나간다.**
 *
 * 아홉 자리면 셋이 폴드하고 넷이 남는다. 그 넷이 다음 병합의 재료다.
 *
 * 파이널 테이블에서는 이 값을 낮춘다 — 여섯이 남은 자리에서 여섯이 올인하면
 * 그 판에 최후 1인이 나와 **마무리를 고를 자리 자체가 사라진다.**
 */
const ALL_IN_COUNT = 6;

/**
 * 어느 좌석이 올인하고 어느 좌석이 폴드하나. 규칙 하나로 모든 판을 정한다.
 *
 * **승자는 올인한 사람 중 스택이 가장 큰 사람이다.** 처음에는 좌석 번호가
 * 가장 작은 사람으로 잡았는데, 그러면 **여섯이 올인해도 다섯이 나가지 않는다.**
 *
 * 미콜 환급 때문이다(`refundUncalledBets`). 스택이 제각각인 판에서 제일 큰
 * 스택이 올인하면 아무도 그 전부를 받아 주지 못하고, 남는 몫이 그 사람에게
 * 돌아간다 — 지고도 칩을 들고 살아남는다. 실측으로 파이널 테이블에 여섯 대신
 * **여덟**이 앉았다(테이블마다 하나씩).
 *
 * 제일 큰 스택이 이기면 나머지는 전부 그 사람에게 덮이므로 예외 없이 0이 된다.
 * 도메인으로도 이쪽이 자연스럽다 — 실제 토너먼트에서 나가는 것은 숏스택이다.
 *
 * 스택이 같으면 **좌석 번호가 작은 쪽**이다. 첫 판은 전원 같은 스택이라
 * 그 규칙이 정한다. 어느 쪽이든 **재현된다** — 촬영마다 다른 사람을 고르면
 * 같은 시드로 두 번 돌려도 스택 분포가 갈리고, ICM은 칩 비율로 나누는 것이라
 * 금액까지 갈린다.
 */
function planHand(occupiedSeats: number[], count: number, state: DemoTableState) {
  const allIn = occupiedSeats.slice(-count);
  const winner = allIn.reduce((best, seatIndex) => {
    const a = state.players[seatIndex]!.stack;
    const b = state.players[best]!.stack;
    return a > b ? seatIndex : best;
  }, allIn[0]);
  return { folders: occupiedSeats.slice(0, -count), allIn, winner };
}

/** 한 자리에 앉은 사람. 화면이거나 소켓이다. */
type Actor =
  | { kind: 'screen'; page: Page }
  | { kind: 'wire'; wire: Wire };

/** 촬영이 도는 테이블 하나. */
type Stage = {
  tableOrder: number;
  tableId: string;
  /** `GET /playsync/:tableId`에 쓴다. 딜러 토큰은 테이블마다 다르다(T66). */
  token: string;
  /** 이 테이블의 딜러. 촬영 테이블만 화면이다. */
  dealer: Actor;
  /** 좌석 번호 → 그 자리의 손. */
  seats: Map<number, Actor>;
};

/** 소켓으로 액션 하나를 보낸다. 화면의 `clickAction`과 같은 자리다. */
function wireAction(wire: Wire, state: DemoTableState, seatIndex: number, allIn: boolean) {
  if (!allIn) {
    wire.send('PLAYER_ACTION', { action: 'FOLD' });
    return;
  }
  const me = state.players[seatIndex]!;
  const maxTotal = me.stack + me.bet;
  // `amount`는 **총 베팅액**이다(`handleRaise`). 콜만으로 스택이 다 들어가는
  // 자리에서 레이즈를 보내면 최소 레이즈 규칙에 걸리므로, 그때는 콜이 곧
  // 올인이다 — 좌석 화면이 「올인 콜」 하나만 그리는 것과 같은 판단이다.
  if (state.currentBet >= maxTotal) {
    wire.send('PLAYER_ACTION', { action: 'CALL' });
    return;
  }
  wire.send('PLAYER_ACTION', { action: 'RAISE', amount: maxTotal });
}

test.describe('데모 — 정산', () => {
  /**
   * 한 대회를 끝까지 몰고 가서 `DEMO_ENDING`이 가리키는 문으로 닫는다.
   *
   * 테스트가 하나인 이유는 장면 1~5와 같다 — 좌석이 컨텍스트에 매여 있고
   * (앉은 자리는 그 태블릿의 쿠키다), 대회 하나가 시작부터 마감까지 한
   * 방향으로 흘러간다.
   */
  test(TAKE_TITLE[ENDING], async ({
    stage,
    mark,
    manifest,
    request,
  }) => {
    const { settlement } = manifest;
    const storeId = manifest.store.id;
    const tournamentId = settlement.tournament.id;
    const tableOf = (order: number) => {
      const found = settlement.tables.find((t) => t.tableOrder === order);
      if (!found) throw new Error(`${order}번 테이블이 정산 무대에 없다.`);
      return found;
    };
    const playerOf = (nickname: string) => {
      const found = settlement.players.find((p) => p.nickname === nickname);
      if (!found) throw new Error(`${nickname}이 정산 무대에 없다.`);
      return found;
    };

    const ownerToken = await login(request, 'owner', manifest.password);

    /** 대회가 들고 있는 칩의 총량. 착석이 끝나면 고정이고, 리바인만 늘린다. */
    let chipsInPlay = settlement.tournament.startStack * settlement.players.length;

    // ── 면을 연다 ───────────────────────────────────────────────────
    //
    // **두 번째 인자가 그대로 영상 파일 이름이다.** 면 이름만 적으면 태블릿
    // 둘이 구분되지 않으므로 **그 면이 무엇을 보여주는가**를 적는다 — 딜러
    // 태블릿은 병합의 종착지(=파이널 테이블이 되는 테이블)이고, 좌석 둘은
    // 각각 살아남는 사람과 탈락했다 돌아오는 사람이다.
    const console_ = await stage('console', 'console');
    const board = await stage('scoreboard', 'scoreboard');
    const dealerTablet = await stage('tablet', 'dealer-final-table');
    const survivorTablet = await stage('tablet', 'seat-survivor');
    const rebuyerTablet = await stage('tablet', 'seat-rebuyer');

    const consoleUrl = `/stores/${storeId}/tournaments/${tournamentId}`;
    await openWithToken(console_, ownerToken, consoleUrl);
    // 전광판도 **상점 경로**다. `/tournaments/:id/display`는 미들웨어가 USER
    // 전용으로 막아 로그인으로 튕긴다(`middleware.ts`) — 참가자 화면과 상점
    // 화면이 같은 이름을 쓰기 때문이고, 전광판은 상점이 트는 물건이다.
    await openWithToken(board, ownerToken, `${consoleUrl}/display`);

    // ── 착석 ────────────────────────────────────────────────────────
    //
    // 서른다섯 중 **둘만 화면으로 앉는다.** 나머지는 배경이고, 태블릿 서른셋을
    // 띄우는 것은 영상에 아무것도 더하지 않으면서 기계를 죽인다
    // (`backstage.ts`의 `seat`).
    mark('무대 — 서른다섯이 자리에 앉는다');
    for (const p of settlement.players) {
      if (p.nickname === ON_SCREEN.survivor || p.nickname === ON_SCREEN.rebuyer) continue;
      await seat(request, tournamentId, {
        tableId: tableOf(p.tableOrder).id,
        seatIndex: p.seatIndex,
        otp: p.otp,
      });
    }

    const survivor = playerOf(ON_SCREEN.survivor);
    const rebuyer = playerOf(ON_SCREEN.rebuyer);
    await sitDown(
      survivorTablet,
      storeId,
      tableOf(survivor.tableOrder).id,
      survivor.seatIndex,
      survivor.otp,
    );
    await sitDown(
      rebuyerTablet,
      storeId,
      tableOf(rebuyer.tableOrder).id,
      rebuyer.seatIndex,
      rebuyer.otp,
    );

    // 콘솔의 좌석 도식이 테이블 넷을 다 그린다. 규모가 화면에 드러나는
    // 유일한 자리라 여기서 스틸을 찍는다.
    await console_.reload();
    await linger(console_, 1_500);
    await shoot(console_, 'console-four-tables');

    // ── 대회 시작 ───────────────────────────────────────────────────
    mark('무대 — 대회가 열린다');
    await press(console_, console_.getByRole('button', { name: '대회 시작' }));
    await linger(console_, 1_500);
    await linger(board, 2_000);

    // ── 딜러 넷 ─────────────────────────────────────────────────────
    //
    // **같은 OTP로 넷이 붙는데 토큰은 넷이 다르다**(`loginDealer`가 `tableId`를
    // 서명해 넣는다). A테이블 딜러가 B테이블을 못 만지는 근거가 그것이다(T66).
    mark('무대 — 딜러 넷이 각자의 테이블에 붙는다');
    await enterDealer(
      dealerTablet,
      storeId,
      tableOf(FILMED_TABLE).id,
      settlement.dealerOtp,
    );

    /** 열어 둔 소켓 전부. 뒷정리에서 닫는다. */
    const wires: Wire[] = [];
    const openSeatWire = async (nickname: string, tableId: string) => {
      const token = await login(request, nickname, manifest.password);
      const wire = await openWire(request, { accessToken: token, tableId, label: nickname });
      wires.push(wire);
      return wire;
    };

    const stages = new Map<number, Stage>();
    for (const { tableOrder, id } of settlement.tables) {
      const token = await dealerToken(request, {
        tournamentId,
        tableId: id,
        otp: settlement.dealerOtp,
      });
      let dealer: Actor;
      if (tableOrder === FILMED_TABLE) {
        dealer = { kind: 'screen', page: dealerTablet };
      } else {
        const wire = await openWire(request, {
          accessToken: token,
          tableId: id,
          label: `딜러${tableOrder}`,
        });
        wires.push(wire);
        dealer = { kind: 'wire', wire };
      }
      stages.set(tableOrder, { tableOrder, tableId: id, token, dealer, seats: new Map() });
    }

    for (const p of settlement.players) {
      const target = stages.get(p.tableOrder)!;
      if (p.nickname === ON_SCREEN.survivor) {
        target.seats.set(p.seatIndex, { kind: 'screen', page: survivorTablet });
        continue;
      }
      if (p.nickname === ON_SCREEN.rebuyer) {
        target.seats.set(p.seatIndex, { kind: 'screen', page: rebuyerTablet });
        continue;
      }
      target.seats.set(p.seatIndex, {
        kind: 'wire',
        wire: await openSeatWire(p.nickname, target.tableId),
      });
    }

    // ── 판을 도는 공용 손 ───────────────────────────────────────────

    const stateOf = (s: Stage) => tableState(request, s.tableId, s.token);

    /**
     * 칩 총량을 본다. **어긋나면 그 자리에서 멈춘다.**
     *
     * 네 테이블을 도는 촬영이라 마지막에 한 번만 보면 어느 테이블에서
     * 틀어졌는지도 모른다. 테이블 이름을 문자열에 남긴다.
     */
    const expectTableChips = async (s: Stage, step: string, expected: number) => {
      const now = chipsOnTable(await stateOf(s));
      expect(`${s.tableOrder}번 ${step} 칩 ${now}`).toBe(`${s.tableOrder}번 ${step} 칩 ${expected}`);
    };

    /**
     * 한 판을 돈다. 여섯이 올인하고 나머지가 폴드한 뒤 딜러가 지명한다.
     *
     * 차례를 **화면에서 긁지 않는다** — 스냅샷의 `currentTurnSeatIndex`가
     * 진실이고, 그것이 가리키는 자리의 손이 누른다. 차례가 하나뿐이라는
     * 사실 자체가 이 루프의 전제다.
     *
     * 성공 조건은 「눌렀다」가 아니라 **「차례가 넘어갔다」**다. 소켓이 붙기
     * 전이나 끊긴 뒤에 누른 것은 아무 일도 일으키지 않고 사라진다.
     */
    const playHand = async (s: Stage, step: string, allInCount = ALL_IN_COUNT) => {
      const before = await stateOf(s);
      const chips = chipsOnTable(before);
      const occupied = before.players
        .map((p, i) => (p ? i : -1))
        .filter((i) => i >= 0);
      const plan = planHand(occupied, allInCount, before);

      if (s.dealer.kind === 'screen') {
        await startHandOnScreen(s.dealer.page, () => stateOf(s));
      } else {
        s.dealer.wire.send('DEALER_ACTION', { action: 'START_PRE_FLOP' });
      }
      await expect
        .poll(async () => (await stateOf(s)).phase, { timeout: 30_000 })
        .not.toBe(PHASE.WAITING);

      for (let guard = 0; guard < 60; guard++) {
        const now = await stateOf(s);
        if (now.phase === PHASE.SHOWDOWN || now.phase === PHASE.WAITING) break;
        const seatIndex = now.currentTurnSeatIndex;
        // 전원이 올인하면 남은 스트리트에 차례가 없다. 서버가 지름길로
        // 쇼다운에 가는 중이라 여기서 누를 것이 없다.
        if (seatIndex < 0) {
          await expect
            .poll(async () => (await stateOf(s)).phase, { timeout: 30_000 })
            .toBe(PHASE.SHOWDOWN);
          break;
        }

        const actor = s.seats.get(seatIndex);
        if (!actor) throw new Error(`${step}: ${seatIndex}번 자리의 손이 없다. 차례가 멈춘다.`);
        const allIn = plan.allIn.includes(seatIndex);

        let moved = false;
        for (let attempt = 0; attempt < 3 && !moved; attempt++) {
          if (actor.kind === 'screen') {
            await clickAction(actor.page, allIn ? { kind: 'allin' } : { kind: 'fold' });
          } else {
            wireAction(actor.wire, now, seatIndex, allIn);
          }
          for (let waited = 0; waited < 16; waited++) {
            await new Promise((done) => setTimeout(done, 500));
            const next = await stateOf(s);
            if (next.currentTurnSeatIndex !== seatIndex || next.phase === PHASE.WAITING) {
              moved = true;
              break;
            }
          }
        }
        if (!moved) throw new Error(`${step}: ${seatIndex}번 자리에서 누른 것이 먹지 않는다.`);

        await expectTableChips(s, `${step} ${seatIndex}번 액션 후`, chips);
      }

      // 딜러가 승자를 찍는다. **순위를 끝까지 채운다** — 지명되지 않은 팟이
      // 하나라도 남으면 서버가 한 칩도 움직이기 전에 거부한다(T15).
      const showdown = await stateOf(s);
      const ranked = [plan.winner, ...plan.allIn.filter((i) => i !== plan.winner)];
      const groups = ranked
        .filter((i) => showdown.players[i] && !showdown.players[i]!.hasFolded)
        .map((i) => [showdown.players[i]!.id]);

      if (s.dealer.kind === 'screen') {
        await resolveWinnersOnScreen(s.dealer.page, groups, () => stateOf(s));
      } else {
        s.dealer.wire.send('DEALER_ACTION', {
          action: 'RESOLVE_WINNERS',
          winnerGroups: groups,
        });
      }
      await expect
        .poll(async () => (await stateOf(s)).phase, { timeout: 60_000 })
        .not.toBe(PHASE.SHOWDOWN);

      await expectTableChips(s, `${step} 배분 후`, chips);
      return plan;
    };

    /**
     * 탈락한 사람들의 리바인을 거절한다.
     *
     * 응답하지 않아도 15초 뒤 자동 거절이지만, 스무 명분을 기다리면 촬영이
     * 그만큼 멈춘다. **거절도 사람이 하는 대답이라** 소켓으로 보낸다 —
     * 참가 행을 손으로 고치면 등수와 상금이 촬영이 지어낸 값이 된다.
     *
     * 등록이 마감된 뒤에는 묻지도 않으므로 그냥 지나간다.
     */
    const declineRebuys = async (s: Stage) => {
      const now = await stateOf(s);
      for (const [seatIndex, actor] of s.seats) {
        if (actor.kind !== 'wire') continue;
        if (now.players[seatIndex]) continue;
        actor.wire.send('REBUY_RESPONSE', { accept: false });
      }
    };

    /** 다음 판을 열 수 있는 상태까지 기다린다. 좌석 해제도 이 상태를 요구한다(T29). */
    const settleToWaiting = async (s: Stage, step: string) => {
      await expect
        .poll(async () => (await stateOf(s)).phase, { timeout: 90_000 })
        .toBe(PHASE.WAITING);
      expect(`${step} ${s.tableOrder}번 정리됨`).toBe(`${step} ${s.tableOrder}번 정리됨`);
    };

    // ── 첫 판 — 촬영 테이블부터 ─────────────────────────────────────
    //
    // **촬영 테이블을 먼저 돈다.** 그래야 리바인이 최대한 빨리 일어난다 —
    // 리바인은 **등록이 열려 있는 동안에만** 물어보고(`rebuyUntil`), 그것이
    // 이 촬영의 ITM 장면이다. 나머지 세 테이블은 그 뒤에 조용히 따라오며
    // 마감까지 남은 시간을 채운다.
    mark('첫 판 — 한 판에 여섯이 올인한다');
    const filmed = stages.get(FILMED_TABLE)!;
    await playHand(filmed, '첫 판');

    // ── 리바인 — 엔트리가 36이 되고 상금권이 하나 는다 ──────────────
    //
    // **사람 수는 35 그대로인데 엔트리만 36이 된다.** 기본 분배표의 구간
    // 경계가 거기라(`DEFAULT_PAYOUT_TABLE`) 전광판의 상금 목록이 다섯 줄에서
    // 여섯 줄로 그 자리에서 늘어난다. 분모가 사람 수였으면 아무 일도
    // 일어나지 않는다 — 그것이 `itm-scaling.int-spec.ts`가 값으로 보는
    // 성질이고, 여기서는 화면이 같은 것을 본다.
    mark('리바인 — 엔트리가 늘면 상금권도 는다');
    const beforeRebuy = Number(await board.getByTestId('entry-count').innerText());

    const rebuyButton = rebuyerTablet.getByRole('button', { name: '리바인', exact: true });
    await expect(rebuyButton).toBeVisible({ timeout: 30_000 });
    await shoot(rebuyerTablet, 'seat-rebuy-raises-entry');
    await press(rebuyerTablet, rebuyButton);
    chipsInPlay += settlement.tournament.startStack;
    await declineRebuys(filmed);

    await expect
      .poll(async () => Number(await board.getByTestId('entry-count').innerText()), {
        timeout: 60_000,
      })
      .toBe(beforeRebuy + 1);
    await linger(board, 2_500);
    await shoot(board, 'scoreboard-entry-not-player');
    await settleToWaiting(filmed, '첫 판');

    // 나머지 세 테이블도 같은 판을 돈다. 화면이 없을 뿐 같은 소켓 · 같은
    // 스키마 · 같은 딜러 명령이다.
    for (const s of stages.values()) {
      if (s.tableOrder === FILMED_TABLE) continue;
      await playHand(s, '첫 판');
      await declineRebuys(s);
      await settleToWaiting(s, '첫 판');
    }

    // ── 등록 마감을 기다린다 ────────────────────────────────────────
    //
    // **파이널 테이블 판정이 마감을 요구한다** — `isFinalTable`이
    // `!isRegistrationOpen && tableCount === 1`이다(T77). 마감 전에는 테이블을
    // 하나로 합쳐도 ICM의 문이 열리지 않는다.
    //
    // 마감에 발화하는 스케줄러는 없다. 레벨이 시각에서 파생되고
    // (`getCurrentBlindLevel`), 누군가 그 대회를 읽을 때 게으르게 닫힌다 —
    // 전광판이 계속 폴링하므로 그 일을 전광판이 한다.
    //
    // **기다리는 동안이 영상에서 잘려 나간다.** 장면 경계를 `mark()`가 남기고
    // 자르는 것은 ffmpeg다(`fixtures/surfaces.ts`).
    //
    // **화면으로 판정하지 않는다.** 「마감 전 · 예상」이 사라졌는지를
    // `toBeHidden`으로 보면 **없는 요소에도 통과한다** — 전광판은 주기적으로
    // 다시 그리므로 그 틈이 실제로 열린다. 12분짜리 레벨이 3분 25초 만에
    // 「마감됐다」로 통과한 적이 있다. 게이트가 읽는 값을 그대로 본다.
    //
    // **표시를 둘로 나눈다.** 자르는 쪽은 표시 N부터 N+1까지를 한 장면으로
    // 삼으므로(`make-demo-assets.mjs`), 기다림에 표시를 안 주면 그 몇 분이
    // 앞 장면의 꼬리로 붙는다. 「대기」와 「마감」 사이가 통째로 버려질 구간이다.
    mark('마감 대기 — 여기부터 버린다');
    await expect
      .poll(async () => (await dashboard(request, tournamentId)).isRegistrationOpen, {
        timeout: 900_000,
        intervals: [5_000],
      })
      .toBe(false);
    mark('마감 — 상금이 예상에서 확정으로 바뀐다');
    // 값이 닫힌 **뒤에** 화면을 본다. 이 순서라야 `toBeHidden`이 「아직 안
    // 그려졌다」가 아니라 「없어졌다」를 뜻한다.
    await expect(board.getByText('마감 전 · 예상')).toBeHidden({ timeout: 60_000 });
    await linger(board, 2_500);
    await shoot(board, 'scoreboard-prize-final');

    // ── 병합 1 — 넷에서 둘로 ────────────────────────────────────────
    //
    // 온라인이면 서버가 좌석을 재배치하고 끝이지만 여기서는 **사람이 칩을
    // 들고 걸어간다.** 상점이 좌석을 풀고, 사람이 참가 OTP를 다시 넣고,
    // 상점이 빈 테이블을 닫는다 — 셋이 각각 다른 조작이다.
    //
    // **걸어오는 방향이 촬영 테이블 쪽이다.** 파이널 테이블이 카메라 앞에
    // 서야 한다.
    mark('병합 — 네 테이블이 둘이 된다');

    /**
     * 테이블 하나를 통째로 옮긴다.
     *
     * 좌석을 풀면 그 사람의 소켓은 자리를 잃는다(`assertTableAccess`가
     * 스냅샷에서 좌석을 찾는다). 그래서 **닫고 다시 연다** — 재착석은 같은
     * 참가 OTP다. 처음 앉을 때 쓴 것과 같은 번호라는 것이 이 흐름의 요점이다.
     */
    const mergeInto = async (from: Stage, into: Stage) => {
      // 좌석 해제는 `GamePhase.WAITING`을 요구한다(T29) — 판이 도는 중에
      // 자리를 빼면 그 사람의 칩이 팟에 남는다.
      await settleToWaiting(from, '병합');
      const source = await stateOf(from);
      const moving = source.players
        .map((p, i) => (p ? { seatIndex: i, id: p.id, nickname: p.nickname } : null))
        .filter((v): v is { seatIndex: number; id: string; nickname: string } => v !== null);

      const res = await request.post(
        `http://localhost:3001/store/sessions/${tournamentId}/tables/${from.tableId}/seats/release`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          // `userId`를 같이 보낸다. 좌석 번호만 보내면, 그 사이 그 자리 사람이
          // 바뀌었을 때 엉뚱한 사람을 뗀다(`ReleaseSeatItem`).
          data: { seats: moving.map((m) => ({ seatIndex: m.seatIndex, userId: m.id })) },
        },
      );
      if (!res.ok()) {
        throw new Error(`좌석 해제 실패 (${from.tableOrder}번): ${res.status()} ${await res.text()}`);
      }

      for (const m of moving) {
        const actor = from.seats.get(m.seatIndex)!;
        if (actor.kind === 'wire') await actor.wire.close();
        from.seats.delete(m.seatIndex);

        const taken = new Set((await stateOf(into)).players.map((p, i) => (p ? i : -1)));
        const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((i) => !taken.has(i));
        if (free === undefined) throw new Error(`${into.tableOrder}번 테이블에 빈 자리가 없다.`);

        await seat(request, tournamentId, {
          tableId: into.tableId,
          seatIndex: free,
          otp: playerOf(m.nickname).otp,
        });
        into.seats.set(free, {
          kind: 'wire',
          wire: await openSeatWire(m.nickname, into.tableId),
        });
      }

      // 빈 테이블을 닫는 것도 상점의 조작이다. 촬영 테이블이 아니면 콘솔을
      // 거치지 않고 같은 라우트를 친다 — 화면이 보여줄 것은 도식이 줄어드는
      // 쪽이지 클릭 자체가 아니다.
      const closed = await request.delete(
        `http://localhost:3001/store/sessions/${tournamentId}/tables/${from.tableId}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      if (!closed.ok()) {
        throw new Error(`테이블 닫기 실패 (${from.tableOrder}번): ${closed.status()}`);
      }
      stages.delete(from.tableOrder);
      if (from.dealer.kind === 'wire') await from.dealer.wire.close();
    };

    await mergeInto(stages.get(3)!, stages.get(FILMED_TABLE)!);
    await mergeInto(stages.get(4)!, stages.get(2)!);
    await console_.reload();
    await linger(console_, 2_000);

    // ── 둘째 판 — 열이 더 나간다 ────────────────────────────────────
    //
    // 등록은 이미 마감이라 리바인을 묻지 않는다 — 여기서 나가는 사람은
    // 그대로 등수를 받는다.
    mark('둘째 판 — 두 테이블에서 열이 나간다');
    await playHand(stages.get(FILMED_TABLE)!, '둘째 판');
    await settleToWaiting(stages.get(FILMED_TABLE)!, '둘째 판');
    await playHand(stages.get(2)!, '둘째 판');
    await settleToWaiting(stages.get(2)!, '둘째 판');

    // ── 병합 2 — 파이널 테이블 ──────────────────────────────────────
    mark('파이널 테이블 — 여섯이 한 테이블에 앉는다');
    await mergeInto(stages.get(2)!, stages.get(FILMED_TABLE)!);
    const final = stages.get(FILMED_TABLE)!;
    await console_.reload();
    await linger(console_, 2_000);
    await shoot(console_, 'console-final-table');

    const atFinal = await stateOf(final);
    const seatedCount = atFinal.players.filter((p) => p).length;
    expect(`파이널 테이블 인원 ${seatedCount}`).toBe('파이널 테이블 인원 6');
    expect(`파이널 테이블 칩 ${chipsOnTable(atFinal)}`).toBe(`파이널 테이블 칩 ${chipsInPlay}`);

    // ── 여섯째가 상금을 받고 나간다 ─────────────────────────────────
    //
    // **여기가 마무리 화면을 의미 있게 만드는 자리다.** 이미 나간 상금이
    // 있어야 확인 대화의 「남은 상금」이 걷은 돈과 다른 값이 되고, 그
    // 차이가 이 화면이 말하려는 전부다.
    //
    // **둘만 올인한다.** 여섯이 남은 자리에서 여섯이 올인하면 그 판에 최후
    // 1인이 나와 마무리를 고를 자리 자체가 사라진다.
    mark('여섯째 — 상금이 처음 나간다');
    await playHand(final, '여섯째', 2);
    await settleToWaiting(final, '여섯째');

    // ── 마무리 미리보기 ─────────────────────────────────────────────
    //
    // **셋을 한 화면에 그린다.** 못 누르는 것은 숨기지 않고 왜 못 누르는지를
    // 그 자리에 적는다(`FINISH_BLOCKERS`) — 사라진 버튼은 "이 대회는 원래
    // 종료가 없다"로 읽힌다.
    mark('마무리 — 셋이 한 화면에 있다');
    await console_.reload();
    await linger(console_, 2_000);
    await expect(console_.getByText('대회 마무리 — 되돌릴 수 없습니다')).toBeVisible();
    await shoot(console_, 'console-finish-blocked');
    await linger(console_, 3_000);

    // ── 갈림목 ──────────────────────────────────────────────────────
    if (ENDING === 'chop') {
      mark('마무리 — ICM으로 닫는다');
      await press(console_, console_.getByRole('button', { name: 'ICM 마무리' }));
      const dialog = console_.getByLabel('ICM으로 마무리할까요?');
      await expect(dialog).toBeVisible();
      // **합이 걷은 돈과 같다.** 확인 대화의 마지막 줄이 그것이고, 이
      // 화면의 핵심이 그 한 줄을 눈으로 확인하는 것이다.
      await linger(console_, 2_500);
      await shoot(console_, 'console-chop-ledger');
      await press(console_, dialog.getByRole('button', { name: 'ICM 마무리' }));
    } else if (ENDING === 'abort') {
      mark('마무리 — 중단하고 환불한다');
      await press(console_, console_.getByRole('button', { name: '중단' }));
      const dialog = console_.getByLabel('대회를 중단할까요?');
      await expect(dialog).toBeVisible();
      // 환불은 사람마다가 아니라 **무리로** 접힌다 — 진행 중 · 탈락 · 이미
      // 상금을 받은 사람. 셋의 규칙이 다르다는 것이 표에 그대로 있다.
      await linger(console_, 2_500);
      await shoot(console_, 'console-abort-ledger');
      await press(console_, dialog.getByRole('button', { name: '중단' }));
    } else {
      // 최후 1인까지 친다. 다섯이 남아 있으므로 한 판이면 된다 — 전원
      // 올인하고 딜러가 **순위를 끝까지 찍는다.** 층이 남으면 서버가 한 칩도
      // 움직이기 전에 거부하는데, 여기서는 그 층이 곧 2~5위 상금이다.
      mark('마무리 — 최후 1인');
      await playHand(final, '최후', 5);
      await settleToWaiting(final, '최후');
      await console_.reload();
      await linger(console_, 2_000);
      await press(console_, console_.getByRole('button', { name: '종료' }));
    }

    // 셋 다 대회를 닫는다. **닫혔다는 것을 상태로 본다** — 마무리 영역이
    // 사라지는 것만 보면 `toBeHidden`이 「아직 안 그려졌다」에도 통과한다.
    // 종료·ICM은 `FINISHED`(「종료」), 중단은 `CANCELLED`(「취소」)다.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `http://localhost:3001/tournaments/${tournamentId}`,
          );
          const body = (await res.json()) as { tournament?: { status?: string } };
          return body.tournament?.status;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(ENDING === 'abort' ? 'CANCELLED' : 'FINISHED');
    await console_.reload();
    await linger(console_, 1_500);
    await expect(console_.getByText('대회 마무리 — 되돌릴 수 없습니다')).toBeHidden({
      timeout: 30_000,
    });
    await linger(console_, 2_500);
    await shoot(console_, `console-closed-${ENDING}`);
    await linger(board, 2_500);

    mark('끝');

    for (const wire of wires) await wire.close();
  });
});
