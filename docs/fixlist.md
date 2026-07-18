# Playsync 수정 목록 (fixlist) — 검증판

각 항목은 **문제 → 위치 → 수정 방법** 순서로 작성됨.
위에서부터 순서대로 고칠 것. P0 = 즉시(보안/돈), P1 = 게임 멈춤, P2 = 정합성, P3 = 품질.

> **2026-07-12 코드 대조 검증 완료.**
> - 15개 항목 중 13개 위치/원인/수정 정확.
> - **[P1-2] 문제 서술 정정** (증상 재분석, 심각도 P1→P2 하향) — 수정 코드는 유효.
> - **[P1-3] 제안 수정에 역효과 버그 발견** — 순서 재조정판으로 교체.
> - **[P3-2] 제안 수정 무효** (WsAdapter는 cors 옵션 무시) — 수동 origin 검증으로 교체.
> - 신규 발견 9건 [N-1]~[N-9] 추가.

모든 수정 후 검증: `cd backend && npx tsc --noEmit` 으로 컴파일 에러 없는지 확인.
(현재 베이스라인: `test/app.e2e-spec.ts`의 supertest 타입 에러 1건 존재 — 소스와 무관, 별도 수정.)

---

## [P0-1] 음수 레이즈로 칩 무한 생성 가능 ✅ 검증됨

- [ ] 완료

**문제**: `raiseAmount`에 음수를 넣으면 `executeBet`에 음수가 전달되어 `stack -= 음수` = 스택 증가, `pot += 음수` = 팟 감소. 클라이언트가 WebSocket으로 임의 숫자를 보낼 수 있으므로 실제로 악용 가능. 또한 현재 베팅보다 낮은 금액 레이즈도 막지 않음. (`!raiseAmount`는 0/undefined만 거름 — 음수 통과 확인.)

**위치**: `backend/src/game-engine/table-engine.ts`
- 48~53행 (`act` 메서드의 `RAISE` case)
- 184~196행 (`handleRaise` 메서드)

**수정 1** — `act`의 RAISE case:

```ts
        case ActionType.RAISE:
          if (
            raiseAmount === undefined ||
            typeof raiseAmount !== "number" ||
            !Number.isFinite(raiseAmount) ||
            !Number.isInteger(raiseAmount) ||
            raiseAmount <= 0
          ) {
            throw new Error("룰에 맞추어 레이즈해주세요.");
          }
          this.handleRaise(player, raiseAmount);
          break;
```

**수정 2** — `handleRaise` (검증 2줄 추가):

```ts
  private handleRaise(player: TablePlayer, betAmount: number) {
    const previousBet = this.state.currentBet;
    if (betAmount <= previousBet) {
      throw new Error("레이즈 금액은 현재 베팅보다 커야 합니다.");
    }
    const needed = betAmount - player.bet;
    if (needed <= 0) {
      throw new Error("잘못된 레이즈 금액입니다.");
    }
    const actualAdded = Math.min(needed, player.stack);

    this.executeBet(player, actualAdded);
```

(선택 개선 — 필수 아님: 정식 홀덤 최소 레이즈 규칙은 "직전 레이즈 증가분 이상". 구현하려면 `TableState`에 `lastRaiseSize: number` 필드를 추가하고 `betAmount >= previousBet + lastRaiseSize` 검증. 지금은 위 수정만으로 칩 생성 버그는 막힘.)

---

## [P0-2] WebSocket 액션 화이트리스트 없음 ✅ 검증됨

- [ ] 완료

**문제**: `handlePlayerAction`이 `data.action`을 검증 없이 엔진에 전달. `ActionType`은 숫자 enum이므로 유저가 `{ action: 6 }`(DEALER_FOLD), `{ action: 4 }`(TIME_OUT), `{ action: 5 }`(DEALER_KICK)을 직접 보낼 수 있음. HTTP의 `ValidationPipe`는 WebSocket 게이트웨이에 적용되지 않음.
(참고: 타임아웃 프로세서는 서비스 메서드를 직접 호출하므로 이 화이트리스트에 영향받지 않음 — 확인됨.)

**위치**: `backend/src/ws/ws.gateway.ts` 144~156행

**수정**:

```ts
  @SubscribeMessage('PLAYER_ACTION')
  async handlePlayerAction(@ConnectedSocket() client: any, @MessageBody() data: any) {
    const { tableId, userId, role } = client;

    // 유저가 보낼 수 있는 액션만 허용 (TIME_OUT, DEALER_FOLD, DEALER_KICK 차단)
    const ALLOWED_ACTIONS = [ActionType.CHECK, ActionType.CALL, ActionType.FOLD, ActionType.RAISE];
    if (!ALLOWED_ACTIONS.includes(data?.action)) {
      return { event: 'error', data: '허용되지 않은 액션입니다.' };
    }
    if (
      data.amount !== undefined &&
      (typeof data.amount !== 'number' || !Number.isFinite(data.amount) || data.amount <= 0)
    ) {
      return { event: 'error', data: '잘못된 금액입니다.' };
    }

    try {
      const updatedState = await this.playsync.handleAction(userId, tableId, { action: data.action, amount: data.amount });
```

파일 상단 import에 추가:

```ts
import { ActionType } from 'src/game-engine/types';
```

---

## [P0-3] 딜러 토큰의 tableId와 접속 tableId 불일치 검증 없음 ✅ 검증됨

- [ ] 완료

**문제**: 딜러 JWT에는 `tableId`가 들어있지만(`dealer.service.ts:59~64`), WS 연결 시 URL 쿼리의 `tableId`를 그대로 신뢰함. 딜러가 URL만 바꾸면 다른 테이블에 `DEALER_ACTION` 실행 가능.

**위치**: `backend/src/ws/ws.gateway.ts` 63~72행 (`handleConnection`의 테이블 진입 분기)

**수정**:

```ts
      // 2. 테이블 진입 시 (게임 시작 후)
      if (tableId) {
        // 딜러는 토큰에 박힌 tableId로만 접속 가능
        if (payload.role === 'DEALER' && payload.tableId !== tableId) {
          throw new Error('딜러 토큰의 테이블과 접속 테이블이 다릅니다.');
        }
        (client as any).tableId = tableId;
        this.addToMap(this.tableSessions, tableId, client);
```

---

## [P0-4] 게임 상태 동시성 제어 없음 — lost update ✅ 검증됨

- [ ] 완료

**문제**: `getSnapShot → 메모리에서 수정 → saveSnapShot` 패턴이 락 없이 4곳(플레이어 액션 `handleAction`, 딜러 `startPreFlop`/`handleDealerAction`/`resolveWinners`)에서 동시에 실행될 수 있음. 유저 액션 직후 30초 타임아웃 잡이 발동하면 낡은 상태가 유저 액션 결과를 덮어씀(lost update).

**수정 방법**: Redis `SET NX` 기반 테이블 락 헬퍼를 만들고, 상태를 수정하는 모든 메서드를 감싼다.

**수정 1** — `backend/src/redis/redis.service.ts`의 `RedisService` 클래스 안에 메서드 추가:

```ts
  /**
   * 테이블 상태 수정 시 반드시 이 락으로 감쌀 것.
   * getSnapShot → 수정 → saveSnapShot 구간의 lost update 방지.
   */
  async withTableLock<T>(tableId: string, fn: () => Promise<T>, ttlMs = 5000): Promise<T> {
    const lockKey = `lock:table:state:${tableId}`;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const maxRetries = 50; // 최대 약 5초 대기

    for (let i = 0; i < maxRetries; i++) {
      const ok = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (ok === 'OK') {
        try {
          return await fn();
        } finally {
          // 내 토큰일 때만 해제 (TTL 만료 후 다른 요청의 락을 지우는 것 방지)
          const releaseScript =
            'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
          await this.redis.eval(releaseScript, 1, lockKey, token);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`테이블 ${tableId} 락 획득 실패`);
  }
```

**수정 2** — `backend/src/playsync/playsync.service.ts`의 `handleAction`(61행) 본문 전체를 락으로 감싼다 ([P1-3] 수정판과 함께 적용):

```ts
  async handleAction(userId: string, tableId: string, dto: PlayerActionDto) {
    return this.redis.withTableLock(tableId, async () => {
      // ... [P1-3] 수정판 본문 ...
    });
  }
```

**수정 3** — `backend/src/dealer/dealer.service.ts`의 `startPreFlop`(71행)과 `handleDealerAction`(113행)도 동일하게 본문 전체를 `return this.redis.withTableLock(tableId, async () => { ... });`로 감싼다.

**수정 4** — `dealer.service.ts`의 `resolveWinners`(162행)는 내부에서 리바인 응답을 최대 15초 기다리므로 TTL을 길게 준다 (리바인 대기는 `Promise.all` 병렬이므로 최대 ~15초 + DB 트랜잭션):

```ts
  async resolveWinners(tableId: string, tournamentId: string, winnerUserIds: string[]) {
    return this.redis.withTableLock(tableId, async () => {
      // ... 기존 본문 전체 ...
    }, 30000); // 리바인 대기(15초) 포함하므로 TTL 30초
  }
```

**트레이드오프 (인지하고 갈 것)**: `resolveWinners`가 락을 15초+ 쥐는 동안 도착하는 유저 액션/타임아웃 잡은 5초 재시도 후 실패함. 핸드가 이미 끝난 시점(HAND_END/WAITING)이라 게임 정합성엔 문제없지만, 타임아웃 잡이 실패 처리되는 로그가 남을 수 있음.

---

## [P1-1] 타임아웃된 유저 때문에 베팅 라운드가 영원히 안 끝남 ✅ 검증됨

- [ ] 완료

**문제**: `TIME_OUT` 액션에서 `bet === currentBet`인 경우(콜 필요 없음) 아무 상태도 바꾸지 않음. `hasChecked`가 false로 남아 `shouldGoToNextPhase`의 "전원 hasChecked" 조건이 영영 충족되지 않음. AFK 유저 1명이 있으면 턴만 무한히 돌고 다음 페이즈로 못 감.

**위치**: `backend/src/game-engine/table-engine.ts` 35~37행

**수정**:

```ts
        case ActionType.TIME_OUT:
          if (player.bet < this.state.currentBet) {
            player.hasFolded = true; // 콜 금액이 부족하면 폴드 처리
          } else {
            player.hasChecked = true; // 체크로 처리해야 라운드가 정상 종료됨
          }
          break;
```

---

## [P1-2 → P2급 하향] 리바인 이벤트 리스너 누수 ⚠️ 문제 서술 정정

- [ ] 완료

**정정된 문제**: `processRebuy`에서 `eventEmitter.once`로 응답 리스너를 등록하는데, 15초 타임아웃으로 resolve된 경우 리스너를 제거하지 않음.

~~"stale 리스너가 다음 리바인 응답을 먼저 소비해서 응답이 씹힘"~~ ← **이 서술은 틀림.** EventEmitter의 `emit`은 등록된 리스너를 **전부** 호출한다 (`once`는 "각 리스너가 최대 1회 실행"이지 "첫 리스너가 이벤트를 독점"이 아님). stale 리스너는 자기 클로저의 `isResolved=true`로 무시하고, 새 리스너는 정상 동작함. 즉 **두 번째 리바인도 동작한다.**

**실제 문제 (여전히 고쳐야 함)**:
1. 타임아웃마다 stale 리스너가 영구 누적 — 메모리 누수 + 리스너 10개 초과 시 maxListeners 경고. 토너먼트가 길어질수록 쌓임.
2. `new Promise(async (resolve) => ...)` 안티패턴 — executor 안 동기 예외가 삼켜져 Promise가 영영 pending 될 수 있음.

**위치**: `backend/src/playsync/playsync.service.ts` 202~246행

**수정** — `processRebuy`의 `return new Promise(...)` 블록 전체를 아래로 교체 (원안 그대로 유효):

```ts
    return new Promise<number>((resolve) => {
      let isResolved = false;
      const timeoutMs = 15000;
      const eventName = `rebuy_res_${userId}`;

      const handler = async (accept: boolean) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timer);

        if (accept) {
          try {
            const resultStack = await this.executeRebuyTransaction(tournamentId, tableId, userId, entryFee, startStack, tournamentName);
            if (resultStack > 0) {
              this.eventEmitter.emit('game.state.updated', { tableId, state: sharedState });
            }
            resolve(resultStack);
          } catch (error) {
            console.error('리바인 트랜잭션 실패:', error.message);
            resolve(0);
          }
        } else {
          resolve(0);
        }
      };

      // [타이머] 15초 내 응답 없으면 리스너 제거 후 자동 취소
      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this.eventEmitter.removeListener(eventName, handler); // 핵심: stale 리스너 제거
          console.log(`[TIMEOUT] 유저 ${userId} 리바인 시간초과`);
          resolve(0);
        }
      }, timeoutMs);

      // 리스너를 먼저 등록한 뒤 팝업 요청 전송
      this.eventEmitter.once(eventName, handler);

      // [웹소켓] 유저에게 리바인 확인 팝업 요청 전송
      this.eventEmitter.emit('rebuy.request.sent', {
        userId,
        tableId,
        deadline: Date.now() + timeoutMs,
        userPoints,
        entryFee,
        tournamentName,
      });
    });
```

(관련 신규 발견: 브로드캐스트 시점 문제 → [N-5] 참고.)

---

## [P1-3] handleAction: 본인 턴 재검증 없음 + KICKED 이중 act ⚠️ 수정안 교체 (원안에 역효과 버그)

- [ ] 완료

**문제 A**: 타임아웃 프로세서는 "지금도 그 유저 턴인지"를 락 **밖**에서 검사함(`timeout.processor.ts:25`). 락 도입([P0-4]) 후에도 락 안 재검증이 없으면 레이스 남음.
**문제 B**: KICKED 유저면 `engine.act(playerIdx, FOLD)` 호출 후 원래 `dto.action`으로 `engine.act`를 한 번 더 호출함. (검증 결과: 두 번째 호출은 턴이 넘어간 뒤라 대부분 no-op으로 흡수되지만, 의도 불명확한 이중 호출 패턴이므로 제거가 맞음.)
**문제 C**: `userState?.status.endsWith('KICKED')` — 동등 비교면 충분.

**⚠️ 원안의 결함**: 원안은 턴 재검증을 `handleAction` 본문 중간(스냅샷 로드 후)에 넣었는데, `handleAction`은 **첫머리에서 `timeoutQueue`의 잡(jobId=tableId)을 먼저 제거**함. stale TIME_OUT이 들어온 시점에 그 잡은 **다음 플레이어의 타이머**임. 원안대로 "잡 제거 → 검증 → 조기 return" 순서면 다음 플레이어의 타이머가 유실되어 그 유저가 AFK일 때 라운드 데드락이 재발함 (P1-1을 다른 경로로 되살리는 꼴). **잡 제거 전에 검증해야 함.**

**위치**: `backend/src/playsync/playsync.service.ts` 61~81행

**수정판** — `handleAction` 본문 순서 재구성 ([P0-4] 락과 함께):

```ts
  async handleAction(userId: string, tableId: string, dto: PlayerActionDto) {
    return this.redis.withTableLock(tableId, async () => {
      // 1. 상태 먼저 로드
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error(`Table ${tableId} not found`);

      const playerIdx = state.players.findIndex(p => p?.id === userId);
      if (playerIdx === -1) throw new Error('테이블에 없는 유저입니다.');

      // 2. 턴 재검증 — 반드시 타임아웃 잡 제거보다 먼저!
      //    stale TIME_OUT 시점의 큐 잡은 "다음 플레이어"의 타이머이므로,
      //    먼저 제거하면 그 유저의 타이머가 유실되어 데드락 재발.
      if (dto.action === ActionType.TIME_OUT && state.currentTurnSeatIndex !== playerIdx) {
        return state; // 이미 처리된 턴 — 큐도 상태도 건드리지 않음
      }

      // 3. 이제 안전하게 기존 타이머 제거
      try {
        const oldJob = await this.timeoutQueue.getJob(tableId);
        if (oldJob) await oldJob.remove();
      } catch (e) {
        console.log('타임아웃 제거 실패');
      }

      const userState = await this.redis.getUserContext(state.tournamentId, userId);
      const engine = new TableEngine(state);

      // 4. KICKED 유저는 어떤 액션을 보내든 폴드로 처리 (act는 한 번만 호출)
      const effectiveAction = userState?.status === 'KICKED' ? ActionType.FOLD : dto.action;
      await engine.act(playerIdx, effectiveAction, dto.amount);

      // ... 이하 기존 본문 (타이머 재등록, saveSnapShot, emit) 그대로 ...
    });
  }
```

---

## [P1-4] 헤즈업(2인) 블라인드 배치 오류 + 좌석 못 찾으면 서버 크래시 ✅ 검증됨

- [ ] 완료

**문제 A**: 홀덤 헤즈업 규칙은 **버튼 = SB**. 현재 코드는 버튼 다음 사람을 SB로 잡아서 2인일 때 버튼이 BB가 되어버림(규칙 반대). — 코드 추적으로 확인.
**문제 B**: `findNextActiveSeat`가 -1을 반환할 수 있는데 `payBlind`에서 `players[-1]!` → `undefined.stack -= ...`으로 **TypeError, 프로세스 크래시.**
**추가 확인**: 활성 플레이어가 1명뿐이면 `findNextActiveSeat`가 순환 탐색으로 같은 좌석을 반환해 **한 명이 BTN=SB=BB로 블라인드 3중 지불**하는 경로도 있음 — 아래 `activeCount < 2` 가드가 함께 막아줌.

**위치**: `backend/src/game-engine/table-engine.ts` 274~302행 (`startPreFlop`)

**수정**:

```ts
  public startPreFlop() {
    // 1. BTN, SB, BB 유저를 순차적으로 찾음 (null 제외)
    const activeCount = this.state.players.filter(p => p && !p.hasFolded && p.stack > 0).length;
    if (activeCount < 2) {
      throw new Error("게임을 시작하기에 충분한 플레이어가 없습니다.");
    }

    const btnIdx = this.findNextActiveSeat((this.state.buttonUser + 1) % this.state.players.length);
    if (btnIdx === -1) throw new Error("버튼을 배정할 수 없습니다.");

    let sbIdx: number;
    let bbIdx: number;
    if (activeCount === 2) {
      // 헤즈업 규칙: 버튼이 SB, 상대가 BB
      sbIdx = btnIdx;
      bbIdx = this.findNextActiveSeat((btnIdx + 1) % this.state.players.length);
    } else {
      sbIdx = this.findNextActiveSeat((btnIdx + 1) % this.state.players.length);
      bbIdx = this.findNextActiveSeat((sbIdx + 1) % this.state.players.length);
    }
    if (sbIdx === -1 || bbIdx === -1) throw new Error("블라인드를 배정할 수 없습니다.");

    this.state.buttonUser = btnIdx;
```

(이후 로직 — 앤티 징수, `payBlind(sbIdx, bbIdx, ...)`, 첫 턴 계산 — 은 그대로. 헤즈업이면 `bbIdx + 1`부터 탐색 시 자연히 SB(버튼)가 첫 액션이 되어 규칙에 맞음 — 검증 완료.)

---

## [P2-1] DB 트랜잭션 안에서 Redis 쓰기 — 롤백 시 유령 착석 ✅ 검증됨

- [ ] 완료

**문제**: `joinSessionWithSeat`의 `$transaction` 내부에서 `saveSnapShot`(Redis)을 실행. 트랜잭션 뒷부분에서 실패해 DB가 롤백돼도 Redis 스냅샷엔 유저가 앉아있게 됨.

**위치**: `backend/src/payment/payment.service.ts` 84~154행

**수정 방법**: Redis 관련 코드를 트랜잭션 밖(성공 후)으로 이동.

1. `$transaction` 콜백에서 아래 블록을 **삭제**:

```ts
        let updatedState = await this.redisService.getSnapShot(dto.tableId);

        const newPlayer: TablePlayer = { ... };

        if (!updatedState) {
          updatedState = { ... };
        }
        updatedState.players[dto.seatIndex] = newPlayer;
        await this.redisService.saveSnapShot(dto.tableId, updatedState);
        return { success: true, updatedState };
```

2. 트랜잭션 콜백의 마지막 return을 `return { success: true };`로 변경.

3. `if (result.success) {` 블록 **맨 앞**에 삭제한 Redis 로직을 그대로 붙여넣기 (트랜잭션 커밋 후 실행되도록):

```ts
      if (result.success) {
        const isOngoing = session.status === TournamentStatus.ONGOING;
        let updatedState = await this.redisService.getSnapShot(dto.tableId);

        const newPlayer: TablePlayer = {
          id: userId,
          tableId: dto.tableId,
          nickname: user.nickname!,
          seatIndex: dto.seatIndex,
          stack: session.startStack,
          bet: 0,
          hasFolded: isOngoing,
          isAllIn: false,
          hasChecked: false,
          totalContributed: 0,
        };

        if (!updatedState) {
          updatedState = {
            phase: GamePhase.WAITING,
            players: Array(9).fill(null),
            pot: 0,
            currentBet: 0,
            buttonUser: 0,
            currentTurnSeatIndex: -1,
            sidePots: [],
            ante: false,
            tournamentId: session.id,
            smallBlind: 100,
          };
        }
        updatedState.players[dto.seatIndex] = newPlayer;
        await this.redisService.saveSnapShot(dto.tableId, updatedState);

        // ... 기존 if (result.success) 내용 (setUserContext, joinPlayer, updateSeatBitmap 등) ...
      }
      return updatedState; // 함수 마지막 return도 이 변수로 변경
```

4. `return result.updatedState;`를 위에서 만든 `updatedState` 반환으로 교체. (`updatedState` 변수를 `if` 블록 밖에 `let updatedState;`로 선언해야 컴파일됨. `isOngoing`이 트랜잭션 안에서도 쓰이면 함수 상단으로 올려 한 번만 선언.)

---

## [P2-2] JWT secret 기본값 'super-secret' ✅ 검증됨

- [ ] 완료

**위치**:
- `backend/src/auth/auth.module.ts:15` — `secret: process.env.JWT_SECRET || 'super-secret',`
- `backend/src/auth/strategies/jwt.strategy.ts:12` — `secretOrKey: process.env.JWT_SECRET || 'super-secret',`

**수정 방법**: fallback 제거, 없으면 부팅 실패하게. 두 파일 모두 파일 상단(임포트 아래)에 추가:

```ts
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
}
```

그리고 각각 `secret: JWT_SECRET,` / `secretOrKey: JWT_SECRET,`으로 교체.
(`main.ts` 1행에서 `import 'dotenv/config'`가 모듈 로드보다 먼저 실행되므로 모듈 스코프에서 환경변수 읽기 안전 — 확인됨.)
`.env.example` 파일이 없으면 `backend/.env.example`을 만들어 `JWT_SECRET=change-me` 한 줄 추가.

---

## [P2-3] createSession: 블라인드 없이 생성 시 FK 깨진 문자열 "blind" 저장 ✅ 검증됨

- [ ] 완료

**문제**: `dto.blindId`도 없고 `blindStructure`도 없으면 `blindId = "blind"` 문자열이 그대로 FK로 들어가 외래키 에러 또는 이후 `initializeGame`에서 `game.blindStructure.structure` 접근 시 크래시.

**위치**: `backend/src/store/session/session.service.ts` 69~80행

**수정**:

```ts
  async createSession(dto: CreateTournamentDto, blindStructure?: CreateBlindStructureDto) {
    if (!dto.blindId && !blindStructure) {
      throw new Error('블라인드 구조 정보가 필요합니다.');
    }
    let blindId = "";
    if ((dto.blindId === undefined || dto.blindId === null) && blindStructure) {
```

---

## [P2-4] rebuyUntil 레벨을 건너뛰면 등록이 영영 안 닫힘 ✅ 검증됨

- [ ] 완료

**문제**: `curLv === parseInt(regiCloseAt)` 정확 일치만 처리. 서버 재시작 등으로 블라인드 레벨이 한 번에 2개 이상 점프하면 등록 마감이 스킵됨.

**위치**: `backend/src/redis/redis.service.ts` 202행

**수정**:

```ts
      if (regiCloseAt && curLv >= parseInt(regiCloseAt)) {
```

---

## [P2-5] broadcastToTable: 닫힌 소켓에 send ✅ 검증됨

- [ ] 완료

**위치**: `backend/src/ws/ws.gateway.ts` 107~113행

**수정** (`broadcastToTournament`와 동일한 패턴):

```ts
  private broadcastToTable(tableId: string, event: string, data: any) {
    const sessions = this.tableSessions.get(tableId);
    if (sessions) {
      const message = JSON.stringify({ event, data });
      sessions.forEach(s => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(message);
        } else {
          sessions.delete(s);
        }
      });
    }
  }
```

---

## [P2-6] 전원 올인 시 게임 진행 수단 없음 (딜러 강제 페이즈 진행 추가) ✅ 검증됨 (경로 보완)

- [ ] 완료

**문제**: 페이즈 전환이 `act()` 안에서만 일어나는데, 액션 가능한 플레이어가 0명인 상태(블라인드/앤티 징수만으로 전원 올인 등)에서는 아무도 `act`를 못 해 게임이 멈출 수 있음.
**검증 보완**: 타임아웃 잡이 폴백으로 상태를 밀어주는 경로가 일부 있으나, 그 경로는 올인 플레이어를 잘못 폴드시키는 부작용이 있고([N-8] 참고) `currentTurnSeatIndex === -1`이면 타이머 자체가 안 걸려 완전 정지함. 딜러 수동 탈출구는 여전히 필요.

**수정 1** — `backend/src/dealer/dealer.service.ts`에 메서드 추가:

```ts
  // 전원 올인 런아웃 등 액션 가능 플레이어가 없을 때 딜러가 강제로 다음 페이즈 진행
  async forceNextPhase(tableId: string) {
    return this.redis.withTableLock(tableId, async () => {
      const state = await this.redis.getSnapShot(tableId);
      if (!state) throw new Error('테이블 정보가 없습니다.');

      const actionable = state.players.filter(p => p && !p.hasFolded && !p.isAllIn);
      if (actionable.length > 1) {
        throw new Error('아직 액션 가능한 플레이어가 있습니다.');
      }

      const engine = new TableEngine(state);
      engine.nextPhase();
      await this.redis.saveSnapShot(tableId, state);
      return state;
    });
  }
```

**수정 2** — `backend/src/ws/ws.gateway.ts`의 `handleDealerAction` switch(165~178행)에 case 추가:

```ts
      case 'NEXT_PHASE':
        updatedState = await this.dealer.forceNextPhase(tableId);
        break;
```

(프론트 딜러 콘솔에 NEXT_PHASE 버튼 추가는 별도 작업 — `frontend/src/app/dealer/[id]/page.tsx` 참고.)

---

## [P3-1] console.log 정리 — NestJS Logger로 교체 ✅ 검증됨

- [ ] 완료

**문제**: 디버그용 출력 다수 (`dealer.service.ts:78~79`의 `!!!!!!!!!!!!!!` 포함, `playsync.service.ts:27`, `ws.gateway.ts` 여러 곳).

**수정 방법**: 각 서비스 클래스에 `private readonly logger = new Logger(클래스명.name);` 추가 (`import { Logger } from '@nestjs/common';`). 디버그성 출력은 삭제, 의미 있는 것만 `this.logger.log(...)` / `this.logger.error(...)`로 교체. 최소한 `dealer.service.ts:78~79`의 두 줄은 삭제할 것.

---

## [P3-2] WebSocket Origin 검증 없음 ⚠️ 수정안 교체 (원안 무효)

- [ ] 완료

**문제**: WS 게이트웨이가 접속 origin을 검증하지 않음.

**⚠️ 원안의 결함**: `@WebSocketGateway({ cors: { origin: [...] } })` 설정은 **socket.io 어댑터용 옵션**임. 이 프로젝트는 `main.ts:14`에서 `WsAdapter`(`@nestjs/platform-ws`, 네이티브 ws)를 쓰므로 `cors` 옵션이 **무시됨** — 현재의 `cors: true`도, 원안의 `cors: { origin: [...] }`도 둘 다 no-op. 네이티브 ws에서는 핸드셰이크의 `Origin` 헤더를 직접 검사해야 함.

**수정판** — `handleConnection` 첫머리(토큰 검증 전)에 추가:

```ts
      // WsAdapter(네이티브 ws)는 cors 옵션을 지원하지 않으므로 Origin을 직접 검증
      const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',');
      const origin = request.headers['origin'];
      if (origin && !allowedOrigins.includes(origin)) {
        throw new Error('허용되지 않은 Origin입니다.');
      }
```

(주의: 브라우저 외 클라이언트는 Origin 헤더를 안 보내거나 위조할 수 있으므로 이 검증은 CSRF성 브라우저 접근 차단용이지 인증 대체가 아님 — 인증은 JWT가 담당. `@WebSocketGateway`의 `cors: true`는 오해 소지만 있으니 삭제.)

---

## [P3-3] throw new Error → Nest HTTP 예외로 교체 ✅ 검증됨

- [ ] 완료

**문제**: 서비스 전반에서 `throw new Error(...)` 사용. HTTP 컨트롤러 경유 시 전부 500으로 응답됨. 클라이언트가 원인 구분 불가.

**수정 방법**: HTTP 요청 경로에서 던지는 에러는 상황에 맞는 Nest 예외로 교체:
- 리소스 없음: `NotFoundException`
- 잘못된 입력: `BadRequestException`
- 상태 충돌(자리 점유, 종료된 세션 등): `ConflictException`

대상 파일: `session.service.ts`, `playsync.service.ts` (HTTP 경유 메서드만). 게임 엔진(`table-engine.ts`) 내부 에러는 WS에서 처리되므로 그대로 둬도 됨.

---

## [P3-4] 게임 엔진 단위 테스트 작성 ✅ 검증됨 (케이스 추가)

- [ ] 완료

**이유**: `table-engine.ts`는 순수 로직이라 테스트가 가장 쉽고 가치가 큼. 위 P0/P1 수정의 회귀 방지.

**방법**: `backend/src/game-engine/table-engine.spec.ts` 생성. 최소 케이스:

1. 음수 raiseAmount → throw (P0-1 회귀)
2. currentBet 이하 raiseAmount → throw
3. TIME_OUT: bet === currentBet이면 hasChecked = true (P1-1 회귀)
4. TIME_OUT: bet < currentBet이면 hasFolded = true
5. 헤즈업 startPreFlop: 버튼 = SB (P1-4 회귀)
6. 활성 1명 이하 startPreFlop → throw (P1-4 회귀)
7. 사이드팟: 3명이 각각 100/200/300 기여 → 팟 3개 [300, 200, 100], 자격자 [3명, 2명, 1명]
8. refundUncalledBets: 혼자 오버베팅한 금액 반환
9. (신규) 올인 플레이어가 currentTurn일 때 TIME_OUT → 폴드되지 않아야 함 ([N-8] 회귀)

테스트 헬퍼 예시:

```ts
function makePlayer(id: string, stack: number, seatIndex: number): TablePlayer {
  return { id, tableId: 't1', nickname: id, seatIndex, stack, bet: 0, hasFolded: false, hasChecked: false, isAllIn: false, totalContributed: 0 };
}

function makeState(players: (TablePlayer | null)[]): TableState {
  return { phase: GamePhase.PRE_FLOP, players, buttonUser: 0, currentTurnSeatIndex: 0, pot: 0, sidePots: [], currentBet: 0, smallBlind: 100, ante: false, tournamentId: 'tour1' };
}
```

실행: `cd backend && npx jest table-engine`

---
---

# 2차 검증에서 추가 발견된 항목 [N-1] ~ [N-9]

## [N-1] (P2) 딜러 액션 게이트웨이 무방어 — undefined 브로드캐스트 / 에러 무응답

- [ ] 완료

**문제**: `handleDealerAction`(게이트웨이)에 `handlePlayerAction`과 달리 try/catch가 없고 switch에 default도 없음. (1) 알 수 없는 action이면 `updatedState = undefined`인 채 `renderGame`으로 브로드캐스트 → 모든 클라이언트의 게임 상태가 undefined로 덮임. (2) 딜러 서비스가 throw하면 딜러에게 에러 응답이 안 감.

**위치**: `backend/src/ws/ws.gateway.ts` 158~181행

**수정 방법**: `handlePlayerAction`과 동일하게 try/catch로 감싸 `{ event: 'error', data: e.message }` 반환. switch에 `default: return { event: 'error', data: '알 수 없는 딜러 액션' };` 추가. 브로드캐스트 전 `if (!updatedState) return;` 가드 추가.

## [N-2] (P2) startPreFlop이 WAITING 아닐 때 undefined 반환 → undefined 브로드캐스트

- [ ] 완료

**문제**: `dealer.service.ts:86~88` — `if (!state || state.phase !== GamePhase.WAITING) return;`이 undefined를 반환하고, 게이트웨이는 그대로 `renderGame`으로 브로드캐스트. 딜러가 진행 중 실수로 START_PRE_FLOP을 누르면 전 클라이언트 화면 상태가 날아감.

**위치**: `backend/src/dealer/dealer.service.ts` 86~88행 (+ [N-1] 게이트웨이 가드와 세트)

**수정 방법**: `return;` 대신 `throw new Error('대기 상태가 아닙니다.');` — [N-1]의 try/catch가 딜러에게 에러로 전달.

## [N-3] (P2) 좌석 비트맵 read-modify-write 레이스

- [ ] 완료

**문제**: `updateSeatBitmap`이 `hget → 문자열 수정 → hset` 패턴. 두 유저가 같은 테이블의 **다른 좌석**에 동시에 앉으면(좌석 락은 좌석별이라 서로 안 막음) 둘 다 같은 비트맵을 읽고 자기 비트만 세팅해 저장 → 한쪽 비트 유실. 실착석은 DB unique 제약이 지키므로 돈 문제는 없지만, 예매 화면에 점유 좌석이 빈자리로 표시됨.

**위치**: `backend/src/redis/redis.service.ts` 44~56행

**수정 방법**: Redis `SETBIT`/`GETBIT`(비트 단위 원자 연산)로 교체하거나, 문자열 유지 시 `SETRANGE key seatIndex '1'` 사용. 둘 다 read-modify-write 자체를 제거함.

## [N-4] (P2) eliminatePlayer의 Promise.all이 아무것도 기다리지 않음

- [ ] 완료

**문제**: `players.map(player => { this.redis.updateSeatBitmap(...); this.redis.deleteUserContext(...); })` — 블록 화살표 함수에 `return`이 없어 `Promise.all([undefined, ...])`이 즉시 resolve. Redis 정리 작업이 fire-and-forget이 되고, 실패해도 감지 불가(unhandled rejection).

**위치**: `backend/src/playsync/playsync.service.ts` 156~162행

**수정**:

```ts
      await Promise.all(
        players.map(player => Promise.all([
          this.redis.updateSeatBitmap(tournamentId, tableId, player.seatIndex, false),
          this.redis.deleteUserContext(tournamentId, player.id),
        ]))
      );
```

## [N-5] (P3) 리바인 성공 브로드캐스트가 스택 반영 전에 나감

- [ ] 완료

**문제**: `processRebuy`의 응답 핸들러가 `executeRebuyTransaction` 성공 시 `game.state.updated`를 emit하는데, 엔진의 `p.stack += rebuyAmount`는 Promise가 resolve된 **뒤에**(`handleHandEnd`의 콜백 반환 후) 실행됨. 즉 브로드캐스트 시점의 직렬화된 상태에는 리바인 스택이 아직 0. README의 "즉시 상태 전파" 서사와 실제 동작이 불일치.

**위치**: `backend/src/playsync/playsync.service.ts` 232~236행 + `table-engine.ts` `handleHandEnd` 253~263행

**수정 방법**: emit을 엔진 쪽 스택 반영 이후로 옮기거나(콜백 시그니처에 후처리 훅 추가), 간단하게는 핸들러에서 `sharedState`의 해당 플레이어 스택을 직접 반영한 뒤 emit. (엔진과 서비스의 책임 경계를 유지하려면 전자 권장 — v2 리팩토링 포인트.)

## [N-6] (P3) syncTableInventoryToDb 항상 true 반환 — 죽은 에러 분기

- [ ] 완료

**문제**: `await this.prisma.$transaction(updates) ? true : false` — `$transaction`은 성공 시 배열을 반환(빈 배열 포함 truthy)하고 실패 시 throw함. 따라서 이 식은 항상 true고, `resolveWinners`의 `else { throw new Error('DB 동기화 실패'); }` 분기는 도달 불가한 죽은 코드.

**위치**: `backend/src/playsync/playsync.service.ts` 112~121행, `dealer.service.ts` 190~197행

**수정 방법**: `syncTableInventoryToDb`가 그냥 `await this.prisma.$transaction(updates);`만 하고 반환값 없애기. 실패는 예외로 전파되므로 `resolveWinners`의 if/else 제거.

## [N-7] (P3) DEALER_KICK 반복 실행 시 activePlayers 이중 차감 + DB/Redis 비대칭

- [ ] 완료

**문제**: `handleDealerAction`의 KICK 분기가 (1) 대상의 현재 상태를 확인하지 않아 같은 유저를 두 번 킥하면 `tournament.activePlayers`가 두 번 감소하고, (2) DB의 activePlayers만 줄이고 Redis의 `activePlayer` 카운터는 안 줄임(탈락 확정은 나중에 `eliminatePlayer`가 Redis를 줄임 — 그 시점에 DB는 또 줄어듦). 우승 판정(`activePlayerCount <= 1`)은 Redis 기준이라 게임은 안 죽지만 DB 통계가 어긋남.

**위치**: `backend/src/dealer/dealer.service.ts` 129~139행

**수정 방법**: KICK 시 `tournamentParticipation.status`가 이미 ELIMINATED면 skip. DB `activePlayers` 감소는 KICK 시점이 아니라 `eliminatePlayer`(탈락 확정) 한 곳에서만 수행하도록 일원화.

## [N-8] (P3) 올인 플레이어가 턴을 받으면 TIME_OUT이 폴드시킴

- [ ] 완료

**문제**: `startPreFlop`의 첫 턴 폴백(`table-engine.ts:296~299`)은 활성 좌석이 없으면 `sbIdx`를 그대로 턴으로 지정하는데, 그 좌석이 블라인드로 올인된 상태일 수 있음. 이후 타임아웃이 오면 `act`의 TIME_OUT 분기가 `bet < currentBet`이므로 그를 **폴드** 처리 — 올인 플레이어는 쇼다운 권리가 있는데 박탈됨(이미 낸 칩은 팟에 남고 승리 자격만 상실).

**위치**: `backend/src/game-engine/table-engine.ts` 35~37행 + 296~299행

**수정 방법**: TIME_OUT 분기에 올인 가드 추가 — `if (player.isAllIn) break;` 를 폴드 판정보다 먼저. 아울러 첫 턴 폴백도 액션 가능자가 진짜 없으면 `-1`을 유지하고 [P2-6] 딜러 진행에 맡기는 쪽이 일관적.

## [N-9] (P3/보안 노트) 토큰·OTP·관전 관련

- [ ] 완료 (v2에서 정책 결정)

1. **WS 토큰이 URL 쿼리스트링으로 전달** — 서버/프록시 액세스 로그에 토큰이 남음. 첫 메시지로 토큰을 보내는 auth 핸드셰이크 방식 또는 Sec-WebSocket-Protocol 헤더 전달 검토.
2. **딜러 OTP 4자리 + 시도 횟수 제한 없음** — 무차별 대입 1만 회로 딜러 권한 획득 가능. 시도 횟수 제한(Redis 카운터) 또는 OTP 자릿수 확대.
3. **인증된 유저는 아무 테이블 WS에나 접속해 상태 수신 가능** — 홀카드가 시스템에 없는 구조(실물 카드)라 정보 유출 실익은 낮지만, 테이블 소속 검증(`getUserContext`의 tableId 대조)을 접속 시점에 추가하는 게 맞음.

---

## 최종 검증 체크리스트

- [ ] `cd backend && npx tsc --noEmit` — 컴파일 에러 0 (기존 e2e supertest 타입 에러 1건은 별도)
- [ ] `cd backend && npx jest table-engine` — 엔진 테스트 통과 (P3-4 작성 시)
- [ ] 수동: 유저가 WS로 `{ action: 4 }`(TIME_OUT) 전송 → `허용되지 않은 액션입니다` 에러 응답
- [ ] 수동: RAISE에 음수 amount → 에러 응답, 스택 변화 없음
- [ ] 수동: 2인 게임 시작 → 버튼인 플레이어가 SB 지불하는지 확인
- [ ] 수동: 유저 액션 직후 타임아웃 발동 시나리오 → 다음 유저 타이머가 살아있는지 확인 (P1-3 순서 회귀)
- [ ] 수동: 딜러가 진행 중 START_PRE_FLOP 재클릭 → 화면 상태 유지 + 에러 표시 (N-1/N-2)
