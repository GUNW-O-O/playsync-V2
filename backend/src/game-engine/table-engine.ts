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