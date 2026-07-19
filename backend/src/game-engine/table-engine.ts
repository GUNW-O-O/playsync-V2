// table-engine.ts
import { TableState, TablePlayer, ActionType, GamePhase } from "./types";

export class TableEngine {
  constructor(public state: TableState) { }

  // 플레이어 액션 처리
  public async act(playerIndex: number, action: ActionType, raiseAmount?: number) {
    const player = this.state.players[playerIndex];
    if (!player) {
      throw new Error("유효하지 않은 플레이어");
    }
    // 베팅 라운드가 아니면 어떤 액션도 유효하지 않다. WAITING은 아직 딜이
    // 시작되지 않았고, HAND_END는 정산이 끝나 리바인 응답을 기다리는 중이며,
    // SHOWDOWN은 딜러의 승자 입력만 남은 상태다.
    const bettingPhases = [GamePhase.PRE_FLOP, GamePhase.FLOP, GamePhase.TURN, GamePhase.RIVER];
    if (!bettingPhases.includes(this.state.phase)) {
      throw new Error('액션할 수 있는 상태가 아닙니다.');
    }

    const isDealerAction =
      action === ActionType.DEALER_FOLD || action === ActionType.DEALER_KICK;
    const isPlayerTurn = this.state.currentTurnSeatIndex === playerIndex;

    // 딜러 액션은 턴과 무관하다. 자리를 비운 사람을 건너뛰라고 만든 기능이니
    // 오히려 그 사람 차례일 때 쓰인다. 예전에는 "턴이 아닌 사람" 분기 안에만
    // 케이스가 있어서, 정작 대상이 현재 턴이면 아래 switch로 떨어졌고 거기엔
    // 케이스가 없어 아무 일도 일어나지 않았다 — 턴만 넘어가 성공처럼 보였다.
    if (isDealerAction) {
      player.hasFolded = true;
    } else if (!isPlayerTurn) {
      return this.state;
    } else if (!player.hasFolded) {
      switch (action) {
        case ActionType.FOLD:
          player.hasFolded = true;
          break;

        case ActionType.TIME_OUT:
          // 순서가 중요하다.
          // 1) 올인은 더 낼 칩이 없어 bet < currentBet이지만, 이미 낸 칩에 대한
          //    쇼다운 권리가 있다. 폴드 판정보다 먼저 빠져나가야 한다.
          // 2) 콜 금액이 부족하면 폴드.
          // 3) 낼 게 없으면 체크. 이걸 빠뜨리면 hasChecked가 false로 남아
          //    shouldGoToNextPhase가 영영 참이 되지 않는다(라운드 데드락).
          if (player.isAllIn) break;
          if (player.bet < this.state.currentBet) {
            player.hasFolded = true;
          } else {
            player.hasChecked = true;
          }
          break;

        case ActionType.CHECK:
          if (player.bet < this.state.currentBet) throw new Error("콜이 필요합니다.");
          player.hasChecked = true;
          break;

        case ActionType.CALL:
          this.handleCall(player);
          break;

        case ActionType.RAISE:
          // 정수 양수만 허용. Number.isInteger가 NaN/Infinity/소수를 모두 거른다.
          if (raiseAmount === undefined || !Number.isInteger(raiseAmount) || raiseAmount <= 0) {
            throw new Error("룰에 맞추어 레이즈해주세요.");
          }
          this.handleRaise(player, raiseAmount);
          break;
      }
    }
    if (this.shouldGoToShowdown()) {
      this.calculateSidePots();
      this.state.phase = GamePhase.SHOWDOWN;
      this.state.currentTurnSeatIndex = -1;
      return this.state;
    }

    // 턴이 아닌 사람을 딜러가 접은 경우 턴은 그대로 둔다. 지금 액션을 기다리는
    // 사람에게서 차례를 빼앗으면 그가 영영 행동하지 못한다.
    const nextTurn = isPlayerTurn ? this.getNextTurnSeatIndex() : this.state.currentTurnSeatIndex;

    if (this.shouldGoToNextPhase(nextTurn)) {
      this.nextPhase();
      return this.state;
    }

    this.state.currentTurnSeatIndex = nextTurn;
    return this.state;
  }

  private shouldGoToNextPhase(nextTurn: number) {
    const activePlayers = this.state.players.filter(p => p && !p.hasFolded);
    const isAllMatched = activePlayers.every(p => p!.bet === this.state.currentBet || p!.isAllIn);
    const nonAllInActivePlayers = activePlayers.filter(p => !p!.isAllIn);
    const hasEveryoneActed = nonAllInActivePlayers.every(p => p!.hasChecked);
    if (isAllMatched && hasEveryoneActed) {
      return true;
    }

    if (nextTurn === -1 && isAllMatched) {
      return true;
    }

    return false;
  }

  public nextPhase() {
    const phases = [GamePhase.PRE_FLOP, GamePhase.FLOP, GamePhase.TURN, GamePhase.RIVER, GamePhase.SHOWDOWN];
    const currentIndex = phases.indexOf(this.state.phase);
    // WAITING/HAND_END은 베팅 라운드가 아니라 indexOf가 -1이다. 그대로 두면
    // -1 < 4가 참이라 phases[0]인 PRE_FLOP이 배정된다 — 블라인드도 안 걷고
    // 핸드가 시작된 것처럼 보인다. 딜러 폴드가 이 상태에서도 불릴 수 있다.
    if (currentIndex === -1) return;
    this.calculateSidePots();
    if (currentIndex < phases.length - 1) {
      this.state.phase = phases[currentIndex + 1];
      this.state.players.forEach(p => {
        if (p) {
          p.bet = 0;
          p.hasChecked = false;
        }
      });
      this.state.currentBet = 0;
      // 첫 액션 유저는 버튼 다음 사람 (SB 위치부터 탐색)
      this.state.currentTurnSeatIndex = this.findNextActiveSeat((this.state.buttonUser + 1) % this.state.players.length);
    }
  }

  // --- 사이드 팟 계산 로직 ---
  private calculateSidePots() {
    this.state.sidePots = [];
    const participants = this.state.players
      .filter((p): p is TablePlayer => p !== null && p.totalContributed > 0)
      .sort((a, b) => a.totalContributed - b.totalContributed);

    let lastLevel = 0;
    for (const p of participants) {
      const contribution = p.totalContributed;
      if (contribution > lastLevel) {
        const amountPerPlayer = contribution - lastLevel;
        const eligiblePlayers = participants.filter(pl => pl.totalContributed >= contribution);

        this.state.sidePots.push({
          amount: amountPerPlayer * eligiblePlayers.length,
          relevantPlayerIds: eligiblePlayers.map(pl => pl.id)
        });
        lastLevel = contribution;
      }
    }
  }
  private refundUncalledBets() {
    const activePlayers = this.state.players.filter((p): p is TablePlayer => p !== null && p.totalContributed > 0);
    if (activePlayers.length === 0) return;

    // 1. 모든 플레이어의 기여도 중 두 번째로 높은 금액을 찾습니다.
    // (만약 한 명만 월등히 많이 냈다면, 그 차액은 아무도 콜하지 않은 돈입니다.)
    const contributions = activePlayers.map(p => p.totalContributed).sort((a, b) => b - a);

    if (contributions.length >= 1) {
      const highest = contributions[0];
      const secondHighest = contributions[1] || 0; // 혼자 남은 경우 0

      if (highest > secondHighest) {
        const overachiever = activePlayers.find(p => p.totalContributed === highest);
        if (overachiever) {
          const refundAmount = highest - secondHighest;
          overachiever.stack += refundAmount;
          overachiever.totalContributed -= refundAmount;
          this.state.pot -= refundAmount;
          console.log(`[환급] ${overachiever.nickname}에게 콜되지 않은 금액 ${refundAmount} 반환`);
        }
      }
    }
  }

  public async resolveWinner(winnerIds: string[]) {
    // 페이즈 게이팅이 딜러 콘솔 UI에만 있었다. UI의 제약은 서버의 제약이 아니다 —
    // 같은 망의 단말이 WS를 직접 열면 플랍에서도 승자를 확정할 수 있었다.
    //
    // 우회가 아니어도 터진다. 정산은 totalContributed로 사이드팟을 다시 만드는데
    // 그 값은 initTable 전까지 남아 있다. 딜러가 두 번 누르면 같은 팟이 두 번
    // 지급됐다(1000 -> 2000). HAND_END로 넘어간 뒤에는 이 가드가 막는다.
    if (this.state.phase !== GamePhase.SHOWDOWN) {
      throw new Error('쇼다운 상태가 아닙니다.');
    }
    this.refundUncalledBets();
    this.calculateSidePots();
    for (const pot of this.state.sidePots) {
      // winnerIds는 클릭 순서대로임 (0번 인덱스가 1등)
      // 이 사이드팟에 지분이 있는 사람들 중 가장 높은 순위의 사람 한 명을 찾음
      const potWinnerId = winnerIds.find(id => pot.relevantPlayerIds.includes(id));

      if (potWinnerId) {
        const share = pot.amount;
        const p = this.state.players.find(pl => pl?.id === potWinnerId);
        if (p) {
          p.stack += share;
          console.log(`사이드팟 ${share}을(를) 유저 ${p.id}에게 지급`);
        }
      }
    }
    this.state.pot = 0;
    this.state.sidePots = [];

    // HAND_END에서 멈춘다. 다음은 리바인 응답 대기 구간이고, 그건 사람을
    // 기다리는 일이라 테이블 락 밖에서 일어나야 한다. 이 페이즈가 그동안
    // `startPreFlop`(WAITING만 허용)을 막아주는 문지기 역할을 한다.
    // 스택 반영은 `applyRebuy`, WAITING 복귀는 `initTable`이 맡는다.
    this.state.phase = GamePhase.HAND_END;
    this.resetStatus();
  }

  /**
   * 리바인 성공분을 테이블에 반영한다.
   *
   * 정산과 분리된 이유: 리바인 응답은 최대 15초를 기다리는 사람의 입력이고,
   * 그 대기를 락 안에 두면 그동안 테이블 전체가 멎는다. 대기는 락 밖에서 하고,
   * 응답이 온 순간에만 짧게 락을 잡아 이 함수를 부른다.
   */
  public applyRebuy(playerId: string, amount: number) {
    if (amount <= 0) return;
    const player = this.state.players.find(p => p?.id === playerId);
    if (!player) return;
    player.stack += amount;
    player.bet = 0;
    player.hasFolded = false;
    player.isAllIn = false;
  }

  private handleCall(player: TablePlayer) {
    const needed = this.state.currentBet - player.bet;
    const amount = Math.min(needed, player.stack);
    this.executeBet(player, amount);
    player.hasChecked = true;
  }

  private handleRaise(player: TablePlayer, betAmount: number) {
    const previousBet = this.state.currentBet;
    // 엔진은 호출자를 신뢰하지 않는다. WS 경계뿐 아니라 타임아웃 프로세서와
    // 딜러 경로에서도 호출되므로, 칩 총량 불변식은 여기서 지킨다.
    if (betAmount <= previousBet) {
      throw new Error("레이즈 금액은 현재 베팅보다 커야 합니다.");
    }
    const needed = betAmount - player.bet;
    if (needed <= 0) {
      throw new Error("잘못된 레이즈 금액입니다.");
    }
    const actualAdded = Math.min(needed, player.stack);

    this.executeBet(player, actualAdded);

    if (player.bet > previousBet) {
      this.resetChecked();
      this.state.currentBet = player.bet;
    }
    player.hasChecked = true;
  }

  // 레이즈시 모든 플레이어 checked 해제
  private resetChecked() {
    this.state.players.filter(p => p && !p.hasFolded && !p.isAllIn).forEach(p => {
      p!.hasChecked = false;
    })
  }

  // 상태만 초기화
  private resetStatus() {
    this.state.players.filter(p => p !== null).forEach(p => {
      p.hasFolded = false;
      p.hasChecked = false;
      p.isAllIn = false;
    })
  }

  // 공통 베팅 처리 (bet, totalContributed 동시 업데이트)
  private executeBet(player: TablePlayer, amount: number) {
    player.stack -= amount;
    player.bet += amount;
    player.totalContributed += amount;
    this.state.pot += amount;

    if (player.stack === 0) {
      player.isAllIn = true;
    }
  }


  private findNextActiveSeat(startIndex: number): number {
    const total = this.state.players.length;
    let curr = startIndex;
    for (let i = 0; i < total; i++) {
      const p = this.state.players[curr];
      if (p && !p.hasFolded && !p.isAllIn && p.stack > 0) return curr;
      curr = (curr + 1) % total;
    }
    return -1;
  }

  private getNextTurnSeatIndex(): number {
    return this.findNextActiveSeat((this.state.currentTurnSeatIndex + 1) % this.state.players.length);
  }

  /**
   * 딜러 준비 완료 후 PRE_FLOP 진입
   */
  public startPreFlop() {
    // 1. BTN, SB, BB 유저를 순차적으로 찾음 (null 제외)
    //
    // 활성자 수를 먼저 센다. findNextActiveSeat은 순환 탐색이라 활성자가 1명이면
    // 같은 좌석을 세 번 돌려주고, 그 한 명이 BTN=SB=BB로 블라인드를 삼중 지불한다.
    // 0명이면 -1이 나와 payBlind의 players[-1]!에서 프로세스가 죽는다.
    const activeCount = this.state.players.filter(p => p && !p.hasFolded && p.stack > 0).length;
    if (activeCount < 2) {
      throw new Error("게임을 시작하기에 충분한 플레이어가 없습니다.");
    }

    const btnIdx = this.findNextActiveSeat((this.state.buttonUser + 1) % this.state.players.length);
    if (btnIdx === -1) throw new Error("버튼을 배정할 수 없습니다.");

    let sbIdx: number;
    let bbIdx: number;
    if (activeCount === 2) {
      // 헤즈업 규칙: 버튼이 SB, 상대가 BB. 프리플롭 첫 액션도 버튼이다.
      sbIdx = btnIdx;
      bbIdx = this.findNextActiveSeat((btnIdx + 1) % this.state.players.length);
    } else {
      sbIdx = this.findNextActiveSeat((btnIdx + 1) % this.state.players.length);
      bbIdx = this.findNextActiveSeat((sbIdx + 1) % this.state.players.length);
    }
    if (sbIdx === -1 || bbIdx === -1) throw new Error("블라인드를 배정할 수 없습니다.");

    this.state.buttonUser = btnIdx;

    // 2. 앤티 징수 (블라인드보다 먼저 징수)
    if (this.state.ante === true) {
      this.payAnte(this.state.smallBlind / 5);
    }

    // 3. 블라인드 지불
    this.payBlind(sbIdx, bbIdx, this.state.smallBlind);

    // 4. 상태 설정
    this.state.currentBet = this.state.smallBlind * 2;

    // 첫 순서는 BB 다음 사람. 헤즈업이면 BB 다음이 곧 SB(버튼)라 규칙과 맞는다.
    //
    // -1이 나오면 그대로 둔다. 예전에는 sbIdx로 폴백했는데, 블라인드로 전원이
    // 올인된 경우 액션할 수 없는 사람에게 턴을 주는 것이었고, 곧이어 도착하는
    // 타임아웃이 그를 폴드시켰다. 액션 가능자가 없으면 없다고 두고 딜러의
    // 강제 진행에 맡긴다.
    this.state.currentTurnSeatIndex = this.findNextActiveSeat((bbIdx + 1) % this.state.players.length);

    this.state.phase = GamePhase.PRE_FLOP;

    // 블라인드만으로 승부가 결정난 경우 여기서 바로 쇼다운으로 넘긴다.
    //
    // 진행 판정은 act() 안에만 있었다. 그런데 블라인드로 전원이 올인되면
    // 액션할 수 있는 사람이 없어 act()가 불릴 일이 없다 — 페이즈를 넘길
    // 트리거가 영영 오지 않고 PRE_FLOP에 멈춘다.
    if (this.shouldGoToShowdown()) {
      this.calculateSidePots();
      this.state.phase = GamePhase.SHOWDOWN;
      this.state.currentTurnSeatIndex = -1;
    }
  }

  private payBlind(sbIdx: number, bbIdx: number, amount: number) {
    this.executeBet(this.state.players[sbIdx]!, amount);
    this.executeBet(this.state.players[bbIdx]!, amount * 2);
  }

  private payAnte(ante: number) {
    this.state.players.forEach(p => {
      if (p && !p.hasFolded) {
        const amount = Math.min(p.stack, ante);
        p.stack -= amount;
        this.state.pot += amount;
        if (p.stack === 0) p.isAllIn = true;
      }
    });
  }

  public async initTable() {
    this.state.players = this.state.players.map(p => {
      if (p && p.stack > 0) {
        p = {
          ...p,
          bet: 0,
          totalContributed: 0,
          hasFolded: false,
          isAllIn: false,
          hasChecked: false,
        }
        return p;
      }
      return null; // 스택이 0인 플레이어는 다음 핸드 시작 시점에 명확히 제거
    });
    this.state.pot = 0;
    this.state.currentBet = 0;
    this.state.sidePots = [];
    this.state.actionDeadline = undefined;
    // 리바인 대기가 끝났다는 뜻이다. 여기서만 딜러가 다음 핸드를 시작할 수 있다.
    this.state.phase = GamePhase.WAITING;
  }

  private shouldGoToShowdown(): boolean {
    const activePlayers = this.state.players.filter(p => p && !p.hasFolded);
    const activeNotAllIn = activePlayers.filter(p => !p!.isAllIn);
    if (activeNotAllIn.length <= 1) {
      const lastPlayer = activeNotAllIn[0];
      if (!lastPlayer || lastPlayer.bet === this.state.currentBet) {
        return true;
      }
    }
    return false;
  }
}