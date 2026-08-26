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
 * 그래서 **한 판에 여럿이 한꺼번에 올인한다.** 딜러가 하나를 지명하면
 * 나머지가 그 자리에서 탈락한다 — 진짜 올인이고 진짜 지명이라 규칙을
 * 어기지 않으면서 서른한 번의 탈락이 세 판으로 접힌다.
 *
 * 인원은 판마다 다르다. 둘째 판부터는 `ALL_IN_COUNT`(여섯)이고, **첫 판만
 * 테이블마다 다르다** — 그 이유는 `FIRST_HAND_ALL_IN`에 있다(첫 버튼이
 * 무작위라 실행마다 승자 스택이 300 흔들리고, 인원이 같으면 그 300이
 * 둘째 판의 승자를 뒤집는다).
 *
 * ── 카메라가 열이고 테이블이 넷이다
 *
 * 면은 열을 연다(좌석 둘 · 딜러 넷 · 폰 둘 · 전광판 · 콘솔). 딜러 넷은
 * **붙어만 있고 누르지 않는다** — 셋은 여전히 소켓이 판을 돌린다. 좌석은
 * 화면 둘만 사람이 누르고, 나머지 서른셋은 **화면 없이 진짜 소켓으로**
 * 돈다(`fixtures/wire.ts`) — 서른다섯을 다 브라우저로 여는 것은 **그릴 값이
 * 없는 것을 그리는** 일이고, 그렇다고 안 돌리면 필드가 줄어든 것이 가짜가
 * 된다. 몇 개까지 버티는지는 기계마다 다르니 그때 재서 판단한다.
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

/**
 * 닫힌 뒤의 스틸. **마무리마다 번호가 다르다.**
 *
 * 이름이 곧 README의 등장 순서라(`img/`의 규칙) 접미사 하나로 못 만든다.
 * 셋을 나란히 놓는 것이 이 스틸들의 요점이므로 번호도 연달아 준다.
 */
const CLOSED_SHOT = {
  complete: '22-closed-complete',
  chop: '23-closed-chop',
  abort: '24-closed-abort',
} as const;

/**
 * 갈림목의 표시. **셋이 같은 이름을 쓴다.**
 *
 * 자르는 쪽이 「누르는 순간부터 끝까지」를 창으로 잡는데(`프레임 ③`·`abort`),
 * 그 창의 이름이 실행마다 다르면 **한 장면이 두 실행을 좌우로 못 놓는다** —
 * `markAt`은 이름으로 찾고, `chop`의 타임라인에 `마무리 — 최후 1인`은 없다.
 *
 * 무엇을 눌렀는지는 이름이 아니라 **화면과 파일 이름**이 말한다. 앞 촬영본은
 * 창을 `마무리 — 셋이 한 화면에 있다`부터 잡을 수밖에 없었고, 그래서 확인
 * 대화가 앞쪽에서 이미 닫힌 뒤 20~30초가 정지 화면으로 남았다.
 *
 * 지금 프레임 ③의 **좌열만** 그 앞 마크에서 시작한다
 * (`make-demo-assets.mjs`의 `windowsByTake`). 둘 다 그렇게 잡던 때와 다른
 * 것은, 그것이 짧은 쪽 실행의 길이를 긴 쪽에 **가깝게** 만드는 조정이라는
 * 점이다 — 정지를 만드는 것이 아니라 줄인다.
 */
const BRANCH_MARK = '마무리 — 그 문을 누른다';

/** 카메라가 보는 테이블. 병합의 종착지이자 파이널 테이블이 된다. */
const FILMED_TABLE = 1;

/**
 * 촬영 테이블과 **나란히 프레임 ①에 드는** 테이블. 여기도 딜러가 화면으로
 * 조작한다 — 그 프레임의 주장이 「딜러가 지명하니 사람이 사라진다」인데,
 * 한 타일에서만 모달이 뜨면 나머지는 펠트가 저절로 바뀌는 그림이 된다.
 */
const MODAL_TABLE = 2;

/**
 * 화면으로 앉는 둘. **서로 다른 테이블이다.**
 *
 * 둘 다 촬영 테이블에 두면 병합 장면에서 **아무도 걸어오지 않는다** — 이
 * 촬영이 보여주려는 것이 「사람이 칩을 들고 걸어간다」인데 그 걸음이
 * 화면 밖에서 일어난다.
 *
 * 리바인하는 사람을 **C(3번)에 둔다.** 그 수락이 엔트리를 36으로 만들고
 * 전광판의 상금 목록이 늘어나는데, **원인(딜러 타일의 스택 부활)과
 * 결과(전광판)가 한 프레임에 있어야** 인과가 읽힌다.
 *
 * 다른 하나는 **D(4번)**다. 병합①이 `C→A`, `D→B`라 **둘이 서로 다른
 * 테이블로 흩어진다** — 하나면 「이 사람이 옮겼다」이고, 둘이면 「테이블이
 * 합쳐지는 중이다」가 된다.
 *
 * **둘의 운명이 반대다.** 리바인하는 사람은 첫 판에 **나가야** 하고, 옮기는
 * 사람은 **남아야** 한다 — 좌석에 없는 사람은 옮길 수가 없다. 그것을 정하는
 * 것은 닉네임이 아니라 좌석 번호다(`planHand`가 `slice(-ALL_IN_COUNT)`로
 * 올인을 고른다).
 *
 * - `C5`는 9석 테이블의 좌석 4다. 올인 범위(`3`~`8`) 안이라 나간다.
 * - `D1`은 좌석 0이다. 4번 테이블은 **8석**이라 올인이 `2`~`7`이고, 폴더는
 *   `0`·`1` 둘뿐이다.
 *
 * 처음에 이름을 맞춰 `D5`로 뒀다가 촬영이 병합②에서 「D5이 4번 테이블에
 * 없다」로 죽었다. 8석에서 좌석 4는 올인이다. **폴더를 고르면 생존이 규칙으로
 * 보장되고**, 스택이 시작값 그대로라 이후 판의 승자 판정에 새 변수도 안 든다.
 */
const ON_SCREEN = { rebuyer: 'C5', mover: 'D1' } as const;

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
 * 첫 판만 테이블마다 인원을 다르게 준다. **결정성 때문이다.**
 *
 * 첫 버튼은 앉은 사람 중 **무작위**다(`RecoveryService.drawFirstButton`의
 * 주석이 가리키는 `initializeGame`). 도메인으로 옳다 — 실제 토너먼트도 그렇게
 * 뽑는다. 그런데 그 위치가 SB·BB를 **폴더 구역에 떨어뜨리느냐**를 정하고,
 * 폴더가 낸 300이 팟을 거쳐 승자 스택에 남는다. 그래서 첫 판 승자는 실행마다
 * 30000이거나 30300이다.
 *
 * 인원이 다 같으면 둘째 판에서 **첫 판 승자 둘이 그 300으로 다툰다.**
 * `planHand`가 스택 최대를 이기게 하므로 승자가 뒤집히고, 파이널 테이블에
 * 앉는 사람이 갈린다. 실측으로 `complete`·`abort`는 C4가, `chop`은 A4가
 * 이겼다 — 같은 시드인데 남은 셋이 달라져 **프레임 ③의 「같은 사람의 다른
 * 결말」이 거짓이 된다.**
 *
 * 인원을 벌리면 스택이 5000씩 벌어진다. 300은 그 사이를 못 넘는다.
 *
 * | 테이블 | 올인 | 승자 스택 | 생존 |
 * |---|---|---|---|
 * | 1 (9석) | 6 | 30000 | 4 |
 * | 2 (9석) | 6 | 30000 | 4 |
 * | 3 (9석) | 7 | 35000 | 3 |
 * | 4 (8석) | 5 | 25000 | 4 |
 *
 * 병합 뒤 둘째 판이 `C3(35000) vs A4(30000)`과 `B4(30000) vs D4(25000)`가
 * 되어 양쪽 다 갈리지 않는다.
 *
 * 배역도 유지된다 — rebuyer(`C5`, 좌석 4)는 3번의 올인 범위(`2`~`8`) 안이라
 * 나가고, mover(`D1`, 좌석 0)는 4번의 폴더(`0`~`2`)라 남는다.
 */
const FIRST_HAND_ALL_IN: Record<number, number> = { 1: 6, 2: 6, 3: 7, 4: 5 };

/**
 * 둘째 판도 테이블마다 다르다. **파이널 셋의 스택 비율을 여기서 정한다.**
 *
 * 찹은 남은 상금을 **칩 비율로** 나눈다(`domain.md`의 「딜(ICM 찹)」). 그래서
 * 파이널 셋의 스택 분포가 곧 **딜이 성립하는가**를 정한다 — 칩 비율이 상금
 * 비율보다 고르면 숏스택이 이득이고, 한쪽으로 쏠리면 아무도 동의하지 않을
 * 딜이 된다.
 *
 * 상금 비율은 `615,600 : 372,600 : 243,000` ≒ **50 : 30 : 20**이다. 칩을
 * `4 : 3 : 2`(44 : 33 : 22)로 만들면 칩 리더만 양보하고 미들과 숏이 이득을
 * 본다 — 실제 딜에서 벌어지는 협상 그대로다.
 *
 * | 테이블 | 인원 | 올인 | 승자 | 생존 |
 * |---|---|---|---|---|
 * | 1 | 8 | 5 (`A4·C1·C2·C3·C5`) | `C3` 35k+45k = **80k** | `A1·A2·A3`(5k) + `C3` |
 * | 2 | 8 | 4 (`D1·D2·D3·D4`) | `D4` 25k+15k = **40k** | `B1·B2·B3`(5k) + `B4`(30k) + `D4` |
 *
 * 합이 **아홉**이라 파이널 테이블(9석)이 정확히 찬다. 열이면 앉을 자리가
 * 없고, 여덟이면 숏들의 칩이 모자라 `FINAL_WATCHERS`가 만드는 셋째가 너무
 * 작아진다.
 */
const SECOND_HAND_ALL_IN: Record<number, number> = { 1: 5, 2: 4 };

/**
 * 파이널 마지막 판에서 **지켜보는 인원.** 스택이 큰 둘이다.
 *
 * 나머지 일곱(숏 여섯과 미들 하나)이 올인하고, 그 칩이 미들에게 모여
 * `30k → 60k`가 된다. 큰 둘은 손대지 않으므로 `80k`와 `40k`가 그대로 남는다.
 *
 * ```
 * 파이널 9명   A1 A2 A3 B1 B2 B3(5k) · B4 30k · D4 40k · C3 80k
 * 셋만 판      C3·D4가 지켜본다 → 일곱이 올인 → 승자 B4 = 30k + 30k = 60k
 * 남는 셋      C3 80k · B4 60k · D4 40k        (4 : 3 : 2)
 * ```
 *
 * 이 판만 `planHand`의 좌석 규칙(`slice`)을 안 쓴다. 지켜볼 사람을 좌석으로
 * 고르면 병합이 앉히는 자리에 따라 달라지는데, **여기서 정해야 하는 것은
 * 자리가 아니라 스택**이다.
 */
const FINAL_WATCHERS = 2;

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
function planHand(
  occupiedSeats: number[],
  count: number,
  state: DemoTableState,
  /**
   * 스택이 큰 이 인원은 **지켜본다.** 주면 나머지 전원이 올인한다(`count`는
   * 무시된다).
   *
   * 파이널 테이블의 마지막 판이 이것을 쓴다. 그냥 두면 큰 스택이 작은 것들을
   * 다 먹어 `85,000 : 4,900 : 4,700` 같은 분포가 되는데, **그 분포에서는
   * 찹이 성립하지 않는다** — 칩 비율로 나누면 숏스택이 4,900칩으로 34,200원을
   * 받고, 딜을 안 하면 3위 상금 243,000원을 받는다. 아무도 동의하지 않을
   * 딜을 화면에 띄우면 그 기능이 거짓말이 된다.
   *
   * 큰 둘을 빼고 숏들끼리 붙이면 그 칩이 한 사람에게 모여 **셋의 스택이
   * 고르게** 남는다. 실제 토너먼트에서도 먼저 부딪치는 것은 숏스택이다.
   */
  foldTop = 0,
) {
  if (foldTop > 0) {
    const byStack = [...occupiedSeats].sort(
      (a, b) => state.players[b]!.stack - state.players[a]!.stack,
    );
    const folders = byStack.slice(0, foldTop);
    const allIn = occupiedSeats.filter((i) => !folders.includes(i));
    const winner = allIn.reduce(
      (best, i) => (state.players[i]!.stack > state.players[best]!.stack ? i : best),
      allIn[0],
    );
    return { folders: occupiedSeats.filter((i) => folders.includes(i)), allIn, winner };
  }
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
    // 태블릿 넷은 뒤(「딜러 넷」)에서 한꺼번에 열고, 여기서는 좌석 둘만 연다.
    // 각각 리바인하는 사람과 다른 테이블로 옮겨가는 사람이다.
    const console_ = await stage('console', 'console');
    const board = await stage('scoreboard', 'scoreboard');
    const moverTablet = await stage('tablet', 'seat-mover');
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
      if (p.nickname === ON_SCREEN.mover || p.nickname === ON_SCREEN.rebuyer) continue;
      await seat(request, tournamentId, {
        tableId: tableOf(p.tableOrder).id,
        seatIndex: p.seatIndex,
        otp: p.otp,
      });
    }

    const mover = playerOf(ON_SCREEN.mover);
    const rebuyer = playerOf(ON_SCREEN.rebuyer);
    await sitDown(
      moverTablet,
      storeId,
      tableOf(mover.tableOrder).id,
      mover.seatIndex,
      mover.otp,
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
    await shoot(console_, '16-four-tables-rake-10');

    // ── 대회 시작 ───────────────────────────────────────────────────
    mark('무대 — 대회가 열린다');
    await press(console_, console_.getByRole('button', { name: '대회 시작' }));
    await linger(console_, 1_500);
    await linger(board, 2_000);

    // ── 딜러 넷 ─────────────────────────────────────────────────────
    //
    // **넷 다 화면을 연다. 그런데 누르는 것은 셋이 여전히 소켓이다.**
    //
    // 게이트웨이가 테이블 접속자 **전원**에게 `renderGame`을 뿌리므로
    // (`WsGateway`), 태블릿은 붙어 있기만 해도 판이 도는 것을 그린다. 조작을
    // 화면으로 옮기면 `slowMo`가 클릭마다 붙어 촬영이 몇 배로 늘어나는데,
    // 프레임 ①이 보여주려는 것은 「세 테이블에서 동시에 사람이 사라진다」라
    // 누르는 손이 아니라 **줄어드는 펠트**다.
    //
    // 비용은 컨텍스트 셋이다. 1280×720이고 녹화가 붙지만, 이 셋이 없으면
    // 규모가 화면에 나타날 자리가 전광판의 숫자뿐이다.
    //
    // **같은 OTP로 넷이 붙는데 토큰은 넷이 다르다**(`loginDealer`가 `tableId`를
    // 서명해 넣는다). A테이블 딜러가 B테이블을 못 만지는 근거가 그것이다(T66).
    mark('무대 — 딜러 넷이 각자의 테이블에 붙는다');
    const dealerTablets = new Map<number, Page>();
    for (const { tableOrder, id } of settlement.tables) {
      const page = await stage('tablet', `dealer-t${tableOrder}`);
      await enterDealer(page, storeId, id, settlement.dealerOtp);
      dealerTablets.set(tableOrder, page);
    }
    const dealerTablet = dealerTablets.get(FILMED_TABLE)!;

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
      /*
        **화면으로 조작하는 딜러가 둘이다.**

        넷 다 브라우저로 붙어 있는데(`dealerTablets`) 조작은 촬영 테이블만
        화면이었고 나머지는 소켓이었다. 그래서 프레임 ①의 4분할에서 **딜러가
        승자를 찍는 모달이 한 타일에만 떴다** — 나머지는 펠트가 저절로 바뀌는
        그림이라 「딜러가 지명하니 사람이 사라진다」의 인과가 반만 읽혔다.

        T2를 화면으로 돌리는 데 드는 것은 없다. 컨텍스트는 이미 열려 있고
        (녹화도 되고 있다) 바뀌는 것은 그 페이지로 누르느냐 소켓으로 쏘느냐뿐이다.

        T4는 소켓으로 둔다 — 프레임에 안 들어가는 타일이라 화면으로 눌러도
        아무 데도 안 나오고, 조작마다 붙는 대기만큼 촬영이 길어진다.
      */
      if (tableOrder === FILMED_TABLE || tableOrder === MODAL_TABLE) {
        dealer = { kind: 'screen', page: dealerTablets.get(tableOrder)! };
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
      if (p.nickname === ON_SCREEN.mover) {
        target.seats.set(p.seatIndex, { kind: 'screen', page: moverTablet });
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
    const playHand = async (
      s: Stage,
      step: string,
      allInCount = ALL_IN_COUNT,
      foldTop = 0,
    ) => {
      const before = await stateOf(s);
      const chips = chipsOnTable(before);
      const occupied = before.players
        .map((p, i) => (p ? i : -1))
        .filter((i) => i >= 0);
      const plan = planHand(occupied, allInCount, before, foldTop);

      // **판마다 좌석·스택·승자를 남긴다.** 세 실행이 갈림목 전까지 같아야
      // 프레임 ③이 「같은 사람의 다른 결말」을 주장할 수 있는데, 마지막에
      // 최종 순위만 보면 「어딘가에서 갈렸다」까지만 안다. 승자는 스택
      // 최대이고(`planHand`) 첫 판 승자 둘의 스택은 사실상 동률이라,
      // **틀어진 첫 판**을 잡으려면 그 자리의 값이 로그에 있어야 한다.
      console.log(
        `[판] ${step} · ${s.tableOrder}번 · ` +
          occupied
            .map((i) => `${i}:${before.players[i]!.nickname}=${before.players[i]!.stack}`)
            .join(' ') +
          ` → 승자 ${plan.winner}:${before.players[plan.winner]!.nickname}`,
      );

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

      // 딜러가 승자를 찍는다. **층마다 임자가 생길 때까지만 찍는다.**
      //
      // 지명되지 않은 팟이 하나라도 남으면 서버가 한 칩도 움직이기 전에
      // 거부하므로(T15) 예전에는 올인한 전원을 순위로 채웠다. 그런데 그 판단이
      // **층 수를 안 봤다** — 첫 판은 전원이 같은 스택에서 올인해 층이 하나이고,
      // 거기서 여섯 명을 줄 세우면 딜러가 등수를 여섯 번 누르는 그림이 나온다.
      // 홀덤이 매 판 순위를 매기는 것처럼 읽히는데 그렇지 않다.
      //
      // 서버가 보는 것은 「상위 몇 명」이 아니라 **모든 층이 덮였는가**다
      // (`TableEngine.resolveWinner`의 `claims`). 그래서 같은 것을 여기서 센다.
      // 쇼다운 스냅샷에 층이 이미 있다 — `nextPhase`가 진입할 때
      // `calculateSidePots`를 부른다.
      const showdown = await stateOf(s);
      const ranked = [plan.winner, ...plan.allIn.filter((i) => i !== plan.winner)];
      const groups: string[][] = [];
      const allPotsClaimed = () =>
        showdown.sidePots.every((pot) =>
          groups.some((tier) => tier.some((id) => pot.relevantPlayerIds.includes(id))),
        );
      for (const seatIndex of ranked) {
        const player = showdown.players[seatIndex];
        if (!player || player.hasFolded) continue;
        // 한 명은 반드시 찍는다. 비면 서버가 「유효한 승자가 없습니다」로 막는다.
        if (groups.length > 0 && allPotsClaimed()) break;
        groups.push([player.id]);
      }

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
     * 응답하지 않아도 15초 뒤 자동 거절이지만, 판마다 그것을 기다리면 촬영이
     * 그만큼 멈춘다. **거절도 사람이 하는 대답이라** 소켓으로 보낸다 —
     * 참가 행을 손으로 고치면 등수와 상금이 촬영이 지어낸 값이 된다.
     *
     * **묻기를 기다렸다가 대답한다.** 전에는 좌석이 빈 소켓에만 보냈는데,
     * 리바인을 묻는 대상은 「스택이 0인데 **아직 좌석에 있는** 사람」이라
     * 조건이 정확히 반대였다. 거절이 아무에게도 안 가서 판마다 15초를
     * 그대로 태웠다 — 실측으로 첫 판 구간 112초 중 **84초**가 그 대기였고,
     * 그것이 통째로 움짤에 들어갔다.
     *
     * 등록이 마감된 뒤에는 묻지도 않으므로 `REBUY_PROMPT`가 안 오고, 그냥
     * 지나간다.
     */
    const declineRebuys = async (s: Stage) => {
      await Promise.all(
        [...s.seats.values()].map(async (actor) => {
          // **화면에 앉은 사람은 화면에서 거절한다.** 좌석 태블릿에 리바인
          // 오버레이가 뜨고(`RebuyOverlay`), 그것을 아무도 닫지 않으면 소켓
          // 쪽만 대답해도 그 한 사람 때문에 15초가 그대로 흐른다 — 둘째 판의
          // 탈락자에 화면 배역 둘이 들어 있어 실측으로 30초가 남아 있었다.
          //
          // 오버레이가 안 떴으면 파산하지 않은 것이라 누를 것도 없다.
          if (actor.kind === 'screen') {
            const decline = actor.page.getByRole('button', { name: '거절', exact: true });
            // 소켓 쪽과 같은 이유로 **기다렸다가** 누른다. 오버레이는 서버가
            // 묻는 순간 뜨는데, 그보다 먼저 보면 없다.
            const shown = await decline
              .waitFor({ state: 'visible', timeout: 3_000 })
              .then(() => true)
              .catch(() => false);
            if (shown) await press(actor.page, decline);
            return;
          }
          // **물어본 소켓에만 대답한다.** 게이트웨이가 파산자에게만
          // `REBUY_PROMPT`를 보내므로(`ws.gateway.ts`), 그것이 도착했다는
          // 사실이 곧 「이 사람에게 묻고 있다」이다. 안 오면 파산하지 않은
          // 것이라 대답할 것도 없다.
          //
          // `waitFor`는 **이미 지나간 것도 잡는다**(`wire.ts`) — 서버는 묻고
          // 나서 세기 시작하므로, 여기서 기다리기 시작한 때에는 이미 와
          // 있을 수 있다.
          const asked = await actor.wire
            .waitFor('REBUY_PROMPT', 3_000)
            .then(() => true)
            .catch(() => false);
          if (!asked) return;
          actor.wire.send('REBUY_RESPONSE', { accept: false });
        }),
      );
    };

    /** 다음 판을 열 수 있는 상태까지 기다린다. 좌석 해제도 이 상태를 요구한다(T29). */
    const settleToWaiting = async (s: Stage, step: string) => {
      await expect
        .poll(async () => (await stateOf(s)).phase, { timeout: 90_000 })
        .toBe(PHASE.WAITING);
      expect(`${step} ${s.tableOrder}번 정리됨`).toBe(`${step} ${s.tableOrder}번 정리됨`);
    };

    // ── 첫 판 — 전부 돌고, rebuyer의 테이블을 마지막에 ───────────────
    //
    // **네 테이블이 다 첫 판을 돈 뒤에 리바인을 기다린다.** 프레임 ①이
    // 「세 테이블에서 다섯씩 사라진다 → 전광판 인원 35→15 → 그 다음
    // 엔트리가 36이 된다」를 한 컷으로 보여준다. 전광판이 15로 떨어진
    // **뒤에** 엔트리가 올라야 그 인과가 읽힌다 — 촬영 테이블만 먼저 돌면
    // 나머지 셋이 아직 안 줄어든 채로 리바인이 먼저 온다.
    //
    // **rebuyer의 테이블을 맨 마지막에 돈다.** 리바인 물음은 영원히 떠
    // 있지 않다 — `DealerService.resolveWinners`가
    // `PlaysyncService.waitForRebuyResponse`로 최대 15초를 기다리고
    // 지나간다. rebuyer의 테이블을 먼저 돌리고 다른 셋을 도는 동안 그
    // 창이 닫힌다.
    //
    // 비용은 리바인이 늦어지는 것뿐이다 — 실측 +2분 10초에서 +3분 30초쯤
    // 으로 늦어지는데, 등록 마감이 +10분이라 여유가 크다.
    //
    // rebuyer의 테이블 번호를 박아 넣지 않는다. 시드(`SETTLEMENT_PLAYERS`)가
    // 정하는 값이라 `playerOf(ON_SCREEN.rebuyer).tableOrder`로 뽑는다 —
    // 배역을 다시 옮겨도 코드가 따라온다.
    mark('첫 판 — 한 판에 스물이 나간다');
    const rebuyerTableOrder = playerOf(ON_SCREEN.rebuyer).tableOrder;

    /*
      **넷을 한꺼번에 돌린다.** 프레임 ①이 주장하는 것이 「여러 테이블에서
      동시에 사람이 사라진다」인데, 하나씩 돌리면 화면에는 같은 일이 차례로
      일어나는 그림이 남는다 — 실측으로 그 구간이 57초였고 대기가 아니라
      순서 때문이었다.

      **rebuyer의 테이블만 빼지 않는다.** 전에는 그 하나를 맨 뒤로 돌렸다.
      리바인 물음이 영원히 떠 있지 않아서고(`waitForRebuyResponse`가 최대
      15초), 그 테이블을 먼저 돌리면 나머지를 도는 동안 창이 닫힌다는
      판단이었다.

      그런데 그 판단이 **넷을 차례로 돈다**를 전제한다. 동시에 돌면 넷이
      같이 끝나므로 리바인을 누르기까지 남이 도는 시간이 아예 없다 — 창을
      덜 쓴다. 그리고 늦게 도는 쪽의 대가는 화면에 그대로 남았다: 프레임
      ①의 4분할에서 T3만 앞 절반을 멈춰 있었다.

      테이블마다 락이 따로이고(`table:{id}`) 운영에서도 넷이 동시에 돈다.
      화면은 촬영 테이블 하나뿐이라 클릭이 엉킬 자리도 없다.

      rebuyer의 테이블은 **판만 돌리고 정리하지 않는다** — 그 사람의 탈락과
      리바인 오버레이가 뜨는 순간이 바로 다음 블록이라, 여기서 거절해
      버리면 리바인을 물어볼 사람이 없어진다.
    */
    await Promise.all(
      [...stages.values()].map(async (s) => {
        await playHand(s, '첫 판', FIRST_HAND_ALL_IN[s.tableOrder]);
        if (s.tableOrder === rebuyerTableOrder) return;
        await declineRebuys(s);
        await settleToWaiting(s, '첫 판');
      }),
    );
    const rebuyerStage = stages.get(rebuyerTableOrder)!;

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
    await shoot(rebuyerTablet, '12-rebuy-accept-raises-entry');
    await press(rebuyerTablet, rebuyButton);
    chipsInPlay += settlement.tournament.startStack;
    // 거절도 rebuyer의 테이블에 준다 — 촬영 테이블(filmed)은 이미 정리가
    // 끝났고, 리바인을 물어볼 파산자는 rebuyer의 테이블에 있다.
    await declineRebuys(rebuyerStage);

    await expect
      .poll(async () => Number(await board.getByTestId('entry-count').innerText()), {
        timeout: 60_000,
      })
      .toBe(beforeRebuy + 1);
    await linger(board, 2_500);
    await shoot(board, '13-entry-36-players-35');
    await settleToWaiting(rebuyerStage, '첫 판');

    // ── 병합 1 — 넷에서 둘로 ────────────────────────────────────────
    //
    // 온라인이면 서버가 좌석을 재배치하고 끝이지만 여기서는 **사람이 칩을
    // 들고 걸어간다.** 상점이 좌석을 풀고, 사람이 참가 OTP를 다시 넣고,
    // 상점이 빈 테이블을 닫는다 — 셋이 각각 다른 조작이다.
    //
    // **걸어오는 방향이 촬영 테이블 쪽이다.** 파이널 테이블이 카메라 앞에
    // 서야 한다.
    // ── 폰 둘 ───────────────────────────────────────────────────────
    //
    // **병합 장면의 절반이 폰에 있다.** 좌석을 잃은 사람이 새 자리에 앉으려면
    // 참가 OTP가 필요한데, 그것을 다시 보는 자리가 폰의 `/me`다 — 처음 앉을
    // 때 쓴 것과 **같은 번호**라는 것이 이 흐름의 요점이고, 그 사실은 폰이
    // 화면에 있어야 보인다.
    //
    // 둘을 여는 이유는 둘이 다른 테이블로 흩어지기 때문이다(`ON_SCREEN`).
    //
    // **마크보다 먼저 연다.** 면을 열면 슬레이트가 화면을 자홍색으로 덮는데
    // (`surfaces.ts`), 마크 뒤에 열면 그 마커가 **자르는 창 안**으로 들어온다.
    // 앞 촬영본의 프레임 ②에 폰 둘의 자홍색이 그대로 남았다. 자르는 쪽도
    // 그것을 건너뛰지만(`firstFrameAt`), 애초에 창에 안 들어오는 것이 맞다.
    const rebuyerPhone = await stage('phone', 'phone-rebuyer');
    const moverPhone = await stage('phone', 'phone-mover');
    await openWithToken(
      rebuyerPhone,
      await login(request, ON_SCREEN.rebuyer, manifest.password),
      '/me',
    );
    await openWithToken(
      moverPhone,
      await login(request, ON_SCREEN.mover, manifest.password),
      '/me',
    );

    /*
      **콘솔을 다시 읽고 마크를 찍는다.**

      콘솔에는 폴링이 없다. SSR로 한 번 그리고, 그 뒤로는 조작이 성공할 때
      `router.refresh()`로만 다시 그린다(`ConsoleClient`의 `run`). 탭을
      옮기는 것은 `setActiveTableId`라는 클라 state라 서버를 다시 읽지 않는다.

      그래서 이 자리의 콘솔은 **대회가 시작하던 순간의 값**이다 — 첫 판에서
      스물이 나가고 리바인으로 엔트리가 36이 됐는데도 35 · 35 · 1,575,000을
      그린다. 앞 촬영본의 프레임 ②가 첫 19초 동안 그 낡은 숫자를 보여줬고,
      그것이 이 프레임에서 「병합이 사람을 잃었나」를 읽을 수 없게 만들었다.

      **잘라 내는 것으로는 못 고친다.** 그 19초 동안 다른 타일은 일하고
      있다 — 폰 둘이 참가 OTP를 여는 구간이 정확히 거기다. 낡은 것은 시간이
      아니라 콘솔 한 장이라 여기서 한 번 다시 읽는다.
    */
    await console_.reload();
    await linger(console_, 1_500);

    mark('병합 — 네 테이블이 둘이 된다');

    /*
      **여기서 미리 열지 않는다.**

      「자리를 잃기 전의 번호가 프레임에 한 번 남아야 같은 번호로 읽힌다」는
      이유로 창이 열리자마자 폰 둘이 OTP를 열었다. 각각 2.5초라 **창의 첫
      5초를 폰만 움직이고 상점 콘솔은 서 있었다** — 순서가 거꾸로다. 이
      프레임의 이야기는 「상점이 자리를 풀면 사람이 폰을 본다」이고, 폰이
      먼저 열려 있으면 그 인과가 뒤집힌다.

      그리고 그 한 번은 **불필요하다.** 좌석이 풀리면 그 사람의 폰은 어차피
      참가 OTP 화면으로 돌아온다. 옮겨 앉을 때 여는 번호와 대조할 「앞의
      번호」는 프레임 ②가 아니라 장면 1의 `01-join-phone-to-console`이 든다.
    */

    /**
     * 폰에서 참가 OTP를 **열어 보인다.**
     *
     * `/me`는 번호를 닫아 두고 「참가 OTP 조회」를 눌러야 연다(`OtpReveal`) —
     * 홀은 사람이 붙어 앉는 곳이라 6자리가 내내 떠 있으면 옆에서 읽힌다.
     * 그것이 화면의 설계이므로 촬영도 그 한 번을 눌러야 한다.
     *
     * **새로고침이 그 상태를 지운다.** `useState`가 초기값으로 돌아가므로,
     * 다시 열지 않으면 프레임 ②에 「참가 OTP 조회」 버튼만 남는다 — 그
     * 프레임이 주장하는 것이 「처음과 **같은 번호**를 다시 넣는다」인데
     * 정작 번호가 화면에 없게 된다. 앞 촬영본이 그랬다.
     */
    async function revealOtp(page: Page) {
      await press(page, page.getByRole('button', { name: '참가 OTP 조회' }));
      // **누른 자리에 그 값이 나타난다.** 버튼이 있던 곳이 곧 번호 칸이라,
      // 커서를 두고 찍으면 점 28px이 **한 자리를 통째로 덮는다** — 앞
      // 촬영본의 프레임 ②에 `7 2 8 ● 1 2`로 남았다. 여섯 자리 중 하나가
      // 없으면 「같은 번호」를 대조할 수가 없다.
      //
      // 스틸은 `shoot()`이 커서를 숨겨 해결하지만 여기는 움짤이다. 커서를
      // 지우면 조작이 사라지므로 **비켜 놓는다** — 카드 아래 흰 여백이다.
      const viewport = page.viewportSize();
      if (viewport) {
        await page.mouse.move(viewport.width / 2, viewport.height * 0.8);
      }
      await linger(page, 2_500);
    }

    /**
     * 상점이 콘솔에서 좌석 하나를 뗀다.
     *
     * REST 한 번이면 될 일을 화면으로 하는 이유는 **그 조작이 사람의 일이라는
     * 것이 이 장면의 내용**이기 때문이다. 온라인이면 서버가 좌석을 재배치하고
     * 끝이지만, 여기서는 상점이 자리를 풀고 사람이 칩을 들고 걸어간다.
     *
     * **두 단계인 것이 화면의 설계다.** 자리를 고르는 것과 푸는 것이 갈려 있어야
     * 여럿을 한 번에 풀 수 있고, 되돌릴 수 있는 중간 상태가 생긴다
     * (`ConsoleClient`의 `toggleSeat`과 「고른 자리 해제」).
     */
    async function releaseSeatOnScreen(
      page: Page,
      tableId: string,
      seatIndex: number,
      nickname: string,
    ) {
      await press(page, page.getByTestId(`console-pick-table-${tableId}`));
      const seat = page.getByTestId(`console-seat-${seatIndex}`);
      // 그 자리에 그 사람이 있는 것을 먼저 본다. 도식이 아직 낡았으면 엉뚱한
      // 자리를 고른다.
      await expect(seat).toContainText(nickname, { timeout: 15_000 });
      await press(page, seat);
      await press(page, page.getByRole('button', { name: '고른 자리 해제' }));
      // **성공 조건은 「눌렀다」가 아니라 「그 자리에서 이름이 사라졌다」다.**
      await expect(seat).not.toContainText(nickname, { timeout: 15_000 });
    }

    /**
     * 화면 배역 하나의 자리를 **상점이 푼다.**
     *
     * 옮기는 일은 셋으로 갈라져 있다 — 상점이 자리를 풀고, 사람이 폰에서
     * 번호를 다시 보고, 새 자리 태블릿에 넣는다. 그 셋을 한 함수에 묶으면
     * **한 사람이 다 끝난 뒤에야 다음 사람이 시작한다.**
     *
     * 프레임 ②가 주장하는 것은 「이 사람이 옮겼다」가 아니라 **「테이블이
     * 합쳐지는 중이다」**이고, 그러려면 둘이 같은 박자로 움직여야 한다.
     * 그래서 푸는 것과 앉는 것을 갈라 두 사람 몫을 교차로 돌린다.
     *
     * @returns 그 사람이 있던 자리. 부르는 쪽이 `seatOnScreen`에 넘긴다.
     */
    const releaseOnScreen = async (from: Stage, nickname: string) => {
      const state = await stateOf(from);
      const seatIndex = state.players.findIndex((p) => p?.nickname === nickname);
      if (seatIndex < 0) {
        throw new Error(`${nickname}이 ${from.tableOrder}번 테이블에 없다.`);
      }
      const actor = from.seats.get(seatIndex);
      if (actor?.kind === 'wire') await actor.wire.close();
      from.seats.delete(seatIndex);

      await console_.bringToFront();
      await releaseSeatOnScreen(console_, from.tableId, seatIndex, nickname);
      return { seatIndex, nickname };
    };

    /**
     * 화면 배역 하나가 **새 자리에 앉는다.**
     *
     * 폰에서 참가 OTP를 다시 열고 그 번호를 태블릿에 넣는다. 처음 앉을 때 쓴
     * 것과 **같은 번호**라는 것이 이 흐름의 요점이고, 그 사실은 폰이 화면에
     * 있어야 보인다.
     */
    const seatOnScreen = async (
      into: Stage,
      tablet: Page,
      phone: Page,
      nickname: string,
    ) => {
      const taken = new Set((await stateOf(into)).players.map((p, i) => (p ? i : -1)));
      const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((i) => !taken.has(i));
      if (free === undefined) throw new Error(`${into.tableOrder}번 테이블에 빈 자리가 없다.`);

      await phone.bringToFront();
      await phone.reload();
      await revealOtp(phone);
      await sitDown(tablet, storeId, into.tableId, free, playerOf(nickname).otp);
      into.seats.set(free, { kind: 'screen', page: tablet });
    };

    /**
     * 테이블에 남은 사람들을 **한꺼번에** 옮기고 그 테이블을 닫는다.
     *
     * 좌석을 풀면 그 사람의 소켓은 자리를 잃는다(`assertTableAccess`가
     * 스냅샷에서 좌석을 찾는다). 그래서 **닫고 다시 연다** — 재착석은 같은
     * 참가 OTP다.
     *
     * 여기는 **배경**이다. 열넷을 키패드로 태우면 촬영이 그만큼 늘어나고
     * 보이는 것은 같은 조작의 반복이다. 화면에 남아야 하는 둘은 이 함수가
     * 불리기 전에 `releaseOnScreen`·`seatOnScreen`이 이미 옮겼다.
     */
    const mergeInto = async (from: Stage, into: Stage) => {
      // 좌석 해제는 `GamePhase.WAITING`을 요구한다(T29) — 판이 도는 중에
      // 자리를 빼면 그 사람의 칩이 팟에 남는다.
      await settleToWaiting(from, '병합');
      const source = await stateOf(from);
      const moving = source.players
        .map((p, i) => (p ? { seatIndex: i, id: p.id, nickname: p.nickname } : null))
        .filter((v): v is { seatIndex: number; id: string; nickname: string } => v !== null);

      if (moving.length > 0) {
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
      }

      for (const m of moving) {
        const actor = from.seats.get(m.seatIndex);
        if (actor?.kind === 'wire') await actor.wire.close();
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

    // **둘을 나란히 옮긴다.** 상점이 두 자리를 연달아 풀고, 둘이 각자 폰을
    // 보고, 각자의 태블릿에서 서로 다른 테이블에 앉는다. 한 사람씩 끝까지
    // 처리하면 같은 조작이 두 번 반복되는 그림이고, 이 프레임이 보여주려는
    // 것은 **테이블이 합쳐지는 중**이라는 사실이다.
    const t3 = stages.get(3)!;
    const t4 = stages.get(4)!;
    await settleToWaiting(t3, '병합');
    await settleToWaiting(t4, '병합');
    /*
      **둘이 같은 박자로 움직인다.** 예전에는 단계 순서만 나란히 두고
      (해제 둘 → 착석 둘) 각 단계 **안은 `await`로 순차**였다 — 그래서
      태블릿 하나가 끝나야 다음 하나가 움직였고, 화면에는 여전히 같은 조작이
      두 번 차례로 일어나는 그림이 남았다.

      면마다 `BrowserContext`가 따로라(`surfaces.ts`) 두 태블릿을 동시에
      굴려도 클릭이 엉키지 않는다. 상점 콘솔은 한 화면이므로 해제는 여전히
      한 번에 하나씩이지만, **착석 둘은 서로 다른 손의 일**이라 겹쳐야 한다.
    */
    await releaseOnScreen(t3, ON_SCREEN.rebuyer);
    await releaseOnScreen(t4, ON_SCREEN.mover);
    await Promise.all([
      seatOnScreen(stages.get(FILMED_TABLE)!, rebuyerTablet, rebuyerPhone, ON_SCREEN.rebuyer),
      seatOnScreen(stages.get(2)!, moverTablet, moverPhone, ON_SCREEN.mover),
    ]);

    // 남은 배경은 REST로. 빈 테이블을 닫는 것까지 여기서 한다.
    await mergeInto(t3, stages.get(FILMED_TABLE)!);
    await mergeInto(t4, stages.get(2)!);
    await console_.reload();
    await linger(console_, 2_000);

    // ── 둘째 판 — 열이 더 나간다 ────────────────────────────────────
    //
    // 순서를 바꾸면서 이 판이 마감 **앞**으로 왔다 — 그래서 리바인을 묻는다.
    // 거절도 사람이 하는 대답이라 소켓으로 보낸다(참가 행을 손으로 고치면
    // 등수와 상금이 촬영이 지어낸 값이 된다, `declineRebuys` 참고). **이 판의
    // 탈락자는 리바인하지 않아야 한다** — 여기서 되살아나면 파이널 테이블이
    // 여섯이 아니게 되고 바로 다음 `병합 2` 뒤의 `expect`가 깨진다.
    //
    // `declineRebuys`는 등록이 마감된 뒤에는 그냥 지나가므로, 촬영이 느려져
    // 이 판이 마감 뒤로 밀려도 안전하다.
    mark('둘째 판 — 두 테이블에서 열이 나간다');
    // 첫 판과 같은 이유로 **둘을 한꺼번에** 돌린다. 마크 이름이 「두
    // 테이블에서 열이 나간다」인데 차례로 돌면 열이 아니라 다섯씩 두 번이다.
    await Promise.all(
      [FILMED_TABLE, 2].map(async (order) => {
        const s = stages.get(order)!;
        await playHand(s, '둘째 판', SECOND_HAND_ALL_IN[order]);
        await declineRebuys(s);
        await settleToWaiting(s, '둘째 판');
      }),
    );

    // ── 병합 2 — 파이널 테이블 ──────────────────────────────────────
    mark('파이널 테이블 — 아홉이 한 테이블에 앉는다');
    await mergeInto(stages.get(2)!, stages.get(FILMED_TABLE)!);
    const final = stages.get(FILMED_TABLE)!;
    await console_.reload();
    await linger(console_, 2_000);
    await shoot(console_, '17-final-table-origins');

    const atFinal = await stateOf(final);
    const seatedCount = atFinal.players.filter((p) => p).length;
    expect(`파이널 테이블 인원 ${seatedCount}`).toBe('파이널 테이블 인원 9');
    expect(`파이널 테이블 칩 ${chipsOnTable(atFinal)}`).toBe(`파이널 테이블 칩 ${chipsInPlay}`);

    // ── 등록 마감을 기다린다 ────────────────────────────────────────
    //
    // **병합보다 뒤다.** 병합 자체는 등록이 열려 있어도 된다 —
    // `SessionService.releaseSeats`가 요구하는 것은 `GamePhase.WAITING`뿐이고
    // 등록 상태를 안 본다. 마감을 요구하는 것은 파이널 테이블 판정
    // 하나이고(`isFinalTable`), 그것이 여는 문은 ICM뿐이다.
    //
    // 앞에 두면 **리바인과 좌석 이동 사이에 8분이 통째로 낀다.** 둘은 한
    // 흐름이라(탈락자가 돌아와서 다른 테이블로 걸어간다) 그 사이가 끊기면
    // 프레임 하나로 못 붙는다. 뒤로 밀면 버릴 구간이 한 덩어리가 된다.
    //
    // 총 시간은 안 변한다. 마감은 대회 시작 후 10분에 오는 벽이고
    // (`SETTLEMENT_BLIND_STRUCTURE`의 레벨 1), 순서는 그 10분을 무엇으로
    // 채우느냐만 정한다.
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
    await shoot(board, '04-prize-table-locked');

    // ── 셋만 남긴다 ─────────────────────────────────────────────────
    //
    // **여섯 중 넷이 올인해 셋이 나간다.** 6·5·4위 상금이 여기서 나가고
    // 셋이 남는다.
    //
    // 셋인 이유가 둘이다. **마무리 프레임의 폰 셋이 「남은 전원」이 된다** —
    // 다섯이 남으면 그중 셋을 고르는 임의성이 생기고 그 선택을 설명할
    // 근거가 없다. 그리고 **이미 나간 상금이 셋이 되어** 마무리 확인 대화의
    // 「남은 상금」이 걷은 돈과 확연히 갈린다. 그 차이가 그 화면이 말하려는
    // 전부다.
    //
    // 둘(헤즈업)로 줄이지 않는다. ICM은 「칩 비율대로 **나눈다**」인데 둘이면
    // 비율이 하나뿐이라 나눈 티가 안 난다.
    //
    // **큰 둘은 지켜본다**(`FINAL_WATCHERS`). 전원 올인시키면 한 사람만 남아
    // 마무리를 고를 자리 자체가 사라지고, 좌석 규칙으로 고르면 큰 스택이
    // 작은 것들을 다 먹어 찹이 성립하지 않는 분포가 된다.
    mark('셋만 남는다 — 상금이 세 번 나간다');
    await playHand(final, '셋만', 0, FINAL_WATCHERS);
    await settleToWaiting(final, '셋만');

    // ── 남은 셋의 폰 ────────────────────────────────────────────────
    //
    // **여기서 연다. 앞에서는 누가 남을지 모른다.**
    //
    // 남는 셋은 결정적이지만(`planHand`가 스택 최대를 이기게 한다) 그 값은
    // 판을 돌려 봐야 나온다. `stage()`는 테스트 도중 언제든 부를 수 있고,
    // 늦게 연 면의 앞부분은 자르는 쪽이 검게 채운다
    // (`make-demo-assets.mjs`의 `tpad`).
    //
    // **폰이 마무리 프레임의 절반이다.** 콘솔의 장부는 상점이 보는 숫자이고,
    // 그 돈이 실제로 사람에게 갔는지는 폰이 말한다 — `/me`의 지난 참가에
    // 등수와 상금이 그 사람 몫으로 찍힌다.
    const survivors = (await stateOf(final)).players
      .map((p, seatIndex) => (p ? { seatIndex, nickname: p.nickname } : null))
      .filter((p): p is { seatIndex: number; nickname: string } => p !== null);
    expect(`남은 인원 ${survivors.length}`).toBe('남은 인원 3');

    const finalPhones: Page[] = [];
    for (const [i, who] of survivors.entries()) {
      const page = await stage('phone', `phone-final-${i + 1}`);
      await openWithToken(page, await login(request, who.nickname, manifest.password), '/me');
      finalPhones.push(page);
    }

    // ── 마무리 미리보기 ─────────────────────────────────────────────
    //
    // **셋을 한 화면에 그린다.** 못 누르는 것은 숨기지 않고 왜 못 누르는지를
    // 그 자리에 적는다(`FINISH_BLOCKERS`) — 사라진 버튼은 "이 대회는 원래
    // 종료가 없다"로 읽힌다.
    //
    // **다시 읽고 마크를 찍는다.** 콘솔은 조작 성공 때만 갱신되므로
    // (`ConsoleClient`의 `run`) 셋만 남은 것이 아직 화면에 없다 — 마크를
    // 먼저 찍으면 창의 앞부분이 아홉 명짜리 낡은 도식으로 시작한다.
    // 프레임 ③의 **좌열이 여기서 열린다**(`windowsByTake`).
    //
    // 마크 앞의 대기는 최소로 둔다. 이 마크가 좌열 창의 시작이라, 여기서
    // 기다린 만큼 좌열이 짧아지고 그만큼 우열과의 차이가 벌어진다.
    await console_.reload();
    await linger(console_, 500);

    mark('마무리 — 셋이 한 화면에 있다');
    await linger(console_, 1_500);
    const finishCard = console_.getByText('대회 마무리 — 되돌릴 수 없습니다');
    await expect(finishCard).toBeVisible();
    // **그 카드로 굴리고 찍는다.** 콘솔은 720px보다 길어서 마무리 카드가
    // 화면 밖에 있고, `toBeVisible()`은 스크롤 밖도 통과한다 — 앞 촬영본의
    // `18-finish-blocked-reasons.png`에 정작 막힌 이유가 없었다.
    await shoot(console_, '18-finish-blocked-reasons', finishCard);
    // 마무리 카드 셋을 보여주는 시간. **`BRANCH_MARK` 앞이라** 프레임 ④의
    // 창 길이에는 영향이 없다 — 창의 시작도 `끝`도 같이 앞당겨진다.
    await linger(console_, 1_500);

    // ── 갈림목 ──────────────────────────────────────────────────────
    if (ENDING === 'chop') {
      mark(BRANCH_MARK);
      await press(console_, console_.getByRole('button', { name: 'ICM 마무리' }));
      const dialog = console_.getByLabel('ICM으로 마무리할까요?');
      await expect(dialog).toBeVisible();
      // **합이 걷은 돈과 같다.** 확인 대화의 마지막 줄이 그것이고, 이
      // 화면의 핵심이 그 한 줄을 눈으로 확인하는 것이다.
      //
      // **이 표를 읽는 것은 스틸의 일이다.** 바로 아래에서 찍는
      // `19-chop-ledger-sums.png`가 네 줄과 합계를 정지된 채로 들고 있고,
      // 움짤이 보여줄 것은 「문을 누르니 정산된다」의 흐름이다. 여기서 오래
      // 머물면 그만큼이 그대로 정지 화면이 된다.
      //
      // 14.5초였다가 7초였다. 앞의 값은 프레임 ③이 이 화면을 `complete`의
      // 딜러 타일과 **좌우로** 놓던 시절의 것이고 — 그쪽이 최후 판을 치느라
      // 더 오래 걸려서 좌열이 기다리는 것을 늦추려던 값이다. 둘을 시간축에
      // 세운 뒤로(`make-demo-assets.mjs`의 `parts`) 그 근거가 사라졌다.
      await linger(console_, 1_500);
      await shoot(console_, '19-chop-ledger-sums');
      await press(console_, dialog.getByRole('button', { name: 'ICM 마무리' }));
    } else if (ENDING === 'abort') {
      mark(BRANCH_MARK);
      await press(console_, console_.getByRole('button', { name: '중단' }));
      const dialog = console_.getByLabel('대회를 중단할까요?');
      await expect(dialog).toBeVisible();
      // 환불은 사람마다가 아니라 **무리로** 접힌다 — 진행 중 · 탈락 · 이미
      // 상금을 받은 사람. 셋의 규칙이 다르다는 것이 표에 그대로 있다.
      await linger(console_, 2_500);
      await shoot(console_, '21-abort-ledger-groups');
      await press(console_, dialog.getByRole('button', { name: '중단' }));
    } else {
      // 최후 1인까지 친다. **셋이 남아 있으므로 한 판이면 된다** — 전원
      // 올인하고 딜러가 **순위를 끝까지 찍는다.** 층이 남으면 서버가 한 칩도
      // 움직이기 전에 거부하는데, 여기서는 그 층이 곧 2·3위 상금이다.
      mark(BRANCH_MARK);
      await playHand(final, '최후', 3);
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

    /*
      **폰은 여기서 읽는다. 콘솔을 기다리지 않는다.**

      전에는 콘솔 조작(재읽기 · 스틸 · 전광판 머무르기)이 다 끝난 뒤에야
      폰 셋을 갱신했다. 그래서 정산이 확정된 뒤로도 폰 타일 셋이 「진행 중」인
      채 **8초 넘게 멍하니 서 있었고**, 프레임 ③의 `chop` 조각은 그 갱신
      **전에** 끝나 「ICM으로 나눴는데 아무도 못 받은」 그림이 됐다.

      기다릴 이유가 없다. 위의 `expect`가 대회가 닫힌 것을 이미 확인했고,
      `/me`의 등수·상금은 그 순간 `awardPrize`가 박아 둔 값이다. 폰과 콘솔은
      서로 다른 손이라 겹쳐 돌아야 한다.

      `await`하지 않고 프라미스만 잡아 둔다 — 아래 콘솔 조작이 도는 동안
      폰이 각자 갱신되고, `끝` 마크 앞에서 한 번만 만난다.
    */
    const phonesSettled = Promise.all(finalPhones.map((page) => page.reload()));

    await console_.reload();
    await linger(console_, 1_500);
    await expect(console_.getByText('대회 마무리 — 되돌릴 수 없습니다')).toBeHidden({
      timeout: 30_000,
    });
    await linger(console_, 2_500);
    await shoot(console_, CLOSED_SHOT[ENDING]);
    await linger(board, 2_500);

    // 위에서 걸어 둔 폰 갱신이 이쯤이면 끝나 있다. **셋이 한꺼번에 바뀐다** —
    // 하나씩 돌면 차례로 값을 받는 그림이 되는데, 실제로는 대회가 닫히는 한
    // 순간에 세 사람의 상금이 동시에 정해진다.
    await phonesSettled;

    // **값이 뜬 것을 보고 넘어간다.** 「지난 참가」가 그 증거다 — 대회가
    // 열려 있는 동안은 「진행 중」이고, 닫혀서 등수와 상금이 박힌 뒤에야
    // 이 제목으로 바뀐다.
    //
    // 시간으로만 재면 **마지막 폰이 빈 채로 남는다.** 앞 촬영본의 프레임
    // ③에서 `complete` 쪽 1위 폰이 끝까지 「진행 중」이었고, 그 자리가
    // 비면 「ICM은 우승자에게 몰아주고 분배표는 나눈다」의 대비가 반쪽이
    // 된다 — 좌우로 견주는 그림에서 가장 큰 금액이 없는 것이다.
    //
    // **중단은 예외다.** `/me`가 참가를 가르는 기준이 「이 사람의 참가가
    // 끝났는가」인데(`FINISHED` · `ELIMINATED` · `AWARDED`), 중단은 대회를
    // `CANCELLED`로 만들고 남은 사람의 참가 상태를 그 셋 중 어디에도
    // 넣지 않는다. 그래서 환불을 받고도 「진행 중」에 남는다 — 여기서
    // 기다리면 30초를 버리고 죽는다.
    //
    // 그 자체가 제품의 사실이고 이 촬영이 고칠 것은 아니다. abort 프레임은
    // 콘솔 하나뿐이라(`20-abort-refunds-all`) 폰이 그림에 쓰이지도 않는다.
    if (ENDING !== 'abort') {
      await Promise.all(
        finalPhones.map((page) =>
          expect(page.getByText('지난 참가')).toBeVisible({ timeout: 30_000 }),
        ),
      );
    }
    // 셋이 같이 갱신됐으므로 머무는 시간도 한 번이다. 폰마다 2초씩 세면
    // 그림은 그대로인데 6초가 흐른다 — 그 6초가 곧 정지 화면이다.
    await linger(finalPhones[0], 2_500);

    mark('끝');

    for (const wire of wires) await wire.close();
  });
});
