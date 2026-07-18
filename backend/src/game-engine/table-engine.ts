// table-engine.ts
import { TableState, TablePlayer, ActionType, GamePhase } from "./types";

type RebuyCallback = (playerId: string) => Promise<number>; // 금액 반환 (0이면 리바이 불가)

export class TableEngine {
  constructor(
    public state: TableState,
    public rebuyCallback?: RebuyCallback
  ) { }

  // 플레이어 액션 처리
  public async act(playerIndex: number, action: ActionType, raiseAmount?: number) {
    const player = this.state.players[playerIndex];
    if (!player) {
      throw new Error("유효하지 않은 플레이어");
    }
    if (this.state.currentTurnSeatIndex !== playerIndex) {
      switch (action) {
        case ActionType.DEALER_FOLD:
        case ActionType.DEALER_KICK:
          player.hasFolded = true;
      }
      if (this.shouldGoToShowdown()) {
        this.state.phase = GamePhase.SHOWDOWN;
      }
      return this.state;
    }
    if (!player.hasFolded && this.state.currentTurnSeatIndex === playerIndex) {
      switch (action) {
        case ActionType.FOLD:
          player.hasFolded = true;
          break;

        case ActionType.TIME_OUT:
          (player.bet < this.state.currentBet) ? player.hasFolded = true : false;
          break;

        case ActionType.CHECK:
          if (player.bet < this.state.currentBet) throw new Error("콜이 필요합니다.");
          player.hasChecked = true;
          break;

        case ActionType.CALL:
          this.handleCall(player);
          break;

        case ActionType.RAISE:
          if (!raiseAmount) {
            throw new Error("룰에 맞추어 레이즈해주세요.");
          }
          this.handleRaise(player, raiseAmount);
          break;
      }
    }
    const nextTurn = this.getNextTurnSeatIndex();
    if (this.shouldGoToShowdown()) {
      this.calculateSidePots();
      this.state.phase = GamePhase.SHOWDOWN;
      this.state.currentTurnSeatIndex = -1;
      return this.state;
    }

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

    await this.handleHandEnd();
  }

  private handleCall(player: TablePlayer) {
    const needed = this.state.currentBet - player.bet;
    const amount = Math.min(needed, player.stack);
    this.executeBet(player, amount);
    player.hasChecked = true;
  }

  private handleRaise(player: TablePlayer, betAmount: number) {
    const previousBet = this.state.currentBet;
    const needed = betAmount - player.bet;
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
   * 핸드 종료 처리 → WAITING phase
   */
  private async handleHandEnd() {
    this.state.phase = GamePhase.HAND_END;
    const callback = this.rebuyCallback;
    this.resetStatus();

    if (callback) {
      const brokePlayers = this.state.players.filter((p): p is TablePlayer => p != null && p.stack <= 0);
      if (brokePlayers.length > 0) {
        await Promise.all(
          brokePlayers.map(async (p) => {
            const rebuyAmount = await callback(p.id);
            if (rebuyAmount > 0) {
              p.stack += rebuyAmount;
              p.bet = 0;
              p.hasFolded = false;
              p.isAllIn = false;
            }
          })
        )
      }
    }
    // WAITING phase로 전환
    this.state.phase = GamePhase.WAITING;
    return true;
  }

  /**
   * 딜러 준비 완료 후 PRE_FLOP 진입
   */
  public startPreFlop() {
    // 1. BTN, SB, BB 유저를 순차적으로 찾음 (null 제외)
    const btnIdx = this.findNextActiveSeat((this.state.buttonUser + 1) % this.state.players.length);
    const sbIdx = this.findNextActiveSeat((btnIdx + 1) % this.state.players.length);
    const bbIdx = this.findNextActiveSeat((sbIdx + 1) % this.state.players.length);

    this.state.buttonUser = btnIdx;

    // 2. 앤티 징수 (블라인드보다 먼저 징수)
    if (this.state.ante === true) {
      this.payAnte(this.state.smallBlind / 5);
    }

    // 3. 블라인드 지불
    this.payBlind(sbIdx, bbIdx, this.state.smallBlind);

    // 4. 상태 설정
    this.state.currentBet = this.state.smallBlind * 2;

    // 첫 순서는 BB 다음 사람
    this.state.currentTurnSeatIndex = this.findNextActiveSeat((bbIdx + 1) % this.state.players.length);

    // 만약 BB 다음 사람이 아무도 없다면 (예: 2인 헤즈업) BB가 아닌 사람이 액션
    if (this.state.currentTurnSeatIndex === -1) {
      this.state.currentTurnSeatIndex = sbIdx;
    }

    this.state.phase = GamePhase.PRE_FLOP;
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