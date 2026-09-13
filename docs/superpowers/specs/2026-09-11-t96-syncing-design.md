# T96 — 소켓이 없는 화면은 정지를 모른다

**티켓**: `tickets-recovery.md`의 T96. **의존**: T93(재접속) · T94(턴 시계 정지) · T95(딜러 재개).

T95가 정지를 **테이블**에 올렸다(`TableState.resumePending`). 그 사실은 소켓으로만
흐르므로, REST로 읽는 화면 — 참가자 폰(`/me`, 대회 상세)과 전광판 — 은 멈춘 대회를
정상 진행처럼 보여준다. 그리고 블라인드 시계는 부팅 순간부터 흐르므로, 태블릿들이
돌아오는 동안의 시간이 **게임 시간으로 들어간다.**

## 결정

**대회에 `SYNCING` 상태를 되살린다.** 부팅이 켜고, **그 대회의 딜러 태블릿이 전부
돌아오면(n/n) 자동으로 끈다.** 그 사이 블라인드 시계는 멈춘다.

```
부팅 → 진행 중이던 대회 전부 SYNCING · 블라인드 정지 (pausedAt = 마지막 하트비트)
     → 좌석 태블릿이 먼저, 딜러 태블릿이 나중에 붙는다 (T93)
     → 딜러 k/n … n/n 이 되는 순간 자동으로 ONGOING
          · 블라인드 기준점을 (n/n 시각 − pausedAt)만큼 한 번 민다
     → 딜러가 테이블마다 「이어서 진행」 (T95 그대로)
```

### 기각한 것

| 안 | 왜 버렸나 |
|---|---|
| 상점이 콘솔에서 `SYNCING`을 푼다 | **인프라 복구는 상점의 몫이 아니다**(`domain.md`의 「상점도 손님이다」). 누를 때를 손님이 알아야 하고, 안 눌러서 생긴 결과도 손님이 진다 |
| 마지막 `resumePending` 테이블이 재개되면 끈다 | 정지 표시는 **차례가 있던 테이블에만** 붙는다(`planPause`). 대기 중이던 테이블은 표시가 없는데도 태블릿은 전부 끊겼다 — 거기서 딜러가 깜깜한 좌석을 넣고 판을 시작하면 30초 뒤 자동 폴드다 |
| 부팅에서 다운타임만큼 **일괄로** 민다(지금 코드) | 정지의 끝은 부팅이 아니라 **그 대회의 태블릿이 돌아온 순간**이고, 그 순간은 대회마다 다르다. 일괄로 밀면 늦게 돌아온 대회일수록 복귀 대기가 게임 시간으로 샌다 |
| n분 뒤 자동 해제 | 그 n을 감으로 정해야 한다 — T95가 버린 「시계로 때운 값」이다. 딜러 기기가 죽은 경우의 탈출구는 **딜러 OTP 재발급**이다(아래) |

### 소켓 수를 판정에 써도 되는 이유

T95는 소켓 수로 자동 판정하지 않았다 — **게이트웨이에 하트비트가 없어** 반만 닫힌
TCP가 살아 있는 것처럼 보이고, 좀비 하나가 테이블을 영영 묶기 때문이다. 이 스펙의
1부가 그 전제를 없앤다. 그리고 여기서 좀비가 끼어도 결과는 n/n이 **일찍** 풀리는
것뿐이고, 그 뒤에도 테이블마다 딜러가 누르는 재개(`resumeTable`)가 남는다 — 판이
저절로 돌지 않는다.

### 딜러 기기가 죽으면

대회 전체가 `SYNCING`에 남는다. **탈출구는 딜러 OTP로 다른 기기를 붙이는 것**이고,
OTP를 모르면 상점이 재발급한다(상점 콘솔에 이미 있는 도메인 조작). 딜러 로그인은
닫힌 대회만 거절하므로(`DealerService`의 딜러 로그인 — `isClosedTournament`)
`SYNCING` 중에도 붙는다. 블라인드가 멈춰 있으니 기다리는 동안 손해 보는 사람이 없다.

---

## 1부 — 좀비 소켓 (PR 1)

### 무엇이 좀비를 만드나

서버가 연결의 끝을 아는 길은 둘뿐이다 — 상대가 FIN/RST를 보내거나, 서버가 보낸
데이터의 재전송이 끝내 실패하거나(리눅스 기본 15~30분). **말없이 사라지는** 경로
(와이파이 이탈 · 전원 차단 · 절전 · 공유기 재부팅 · 망 전환)에서는 앞의 것이 안
오고, 보낼 것이 없으면 뒤의 것도 시작되지 않는다. `SYNCING` 동안은 멈춘 테이블에
브로드캐스트가 없으므로 정확히 그 상태다.

지금 게이트웨이(`WsAdapter`, 네이티브 `ws`)는 ping/pong이 없고,
`WsGateway.handleDisconnect`는 `close` 이벤트에서만 불리며, `broadcast`는
`readyState`만 본다 — 좀비는 `OPEN`이다.

### 반대 방향도 있다

서버가 좀비를 치워도 **태블릿은 자기가 끊긴 줄 모른다.** 브라우저 JS는 프로토콜
ping을 볼 수 없고, 태블릿은 사람이 누를 때만 보낸다. `onclose`가 안 뜨면 T93의
재접속이 영영 시작되지 않고, 그게 딜러 태블릿이면 **n/n이 영영 안 찬다.**

### 무엇을 하나

| 쪽 | 무엇 | 자리 |
|---|---|---|
| 서버 | `SOCKET_PING_MS`(10초)마다 모든 소켓에 `ws.ping()`. 직전 틱 뒤로 pong이 없던 소켓은 `terminate()` | `WsGateway` (`OnModuleInit`/`OnModuleDestroy`로 타이머 소유) |
| 서버 | 같은 틱에 앱 레벨 `keepalive` 이벤트를 보낸다 | 같은 자리 |
| 태블릿 | 마지막 수신 뒤 `SOCKET_SILENCE_MS`(25초)가 지나면 스스로 `close()` → T93 재접속 경로 | `use-table-socket.ts` |
| contract | 이벤트 이름 `KEEPALIVE_EVENT` 한 곳에 둔다 | `packages/contract` |

- **브라우저는 ping에 pong을 자동으로 답한다.** 서버 쪽 판정에 프론트 변경이 없다.
- **25초 = 10초 틱 두 번 + 여유.** 틱 하나를 놓쳐도(GC · 망 흔들림) 끊지 않는다.
- **서버의 판정 폭은 10~20초다.** 딜러는 부팅 뒤 40~50초에 붙기 시작하므로
  (`DEALER_OFFSET_MS` · `DEALER_SPREAD_MS`) 그 전에 붙었다 사라진 좀비가 n/n 판정
  시점에 남지 않는다.
- 테스트가 주기를 줄일 수 있게 `WS_PING_INTERVAL_MS` 환경 변수로 덮는다
  (`HEARTBEAT_INTERVAL_MS`와 같은 모양).
- **부하 하네스는 영향 없다.** `load/lib/table.js`는 `renderGame`만 짝짓고 나머지
  이벤트를 버린다. k6의 ws 클라이언트가 ping에 자동으로 pong하는지는 PR 1에서
  스모크로 확인한다 — 안 하면 봇 소켓이 20초마다 잘린다.

### 테스트

- **통합**(`ws.gateway.int-spec.ts`): pong을 안 하는 클라이언트(`ws`의
  `autoPong: false`)가 두 틱 안에 끊긴다. **반대 입력**: 정상 클라이언트는 같은
  시간 동안 살아 있고 `keepalive`를 받는다 — 이것이 없으면 "전부 끊는다"도 통과한다.
- **프론트 단위**: 침묵 25초에 `close()`. **반대 입력**: 10초마다 뭐라도 받으면
  안 끊는다. 가짜 타이머로 잰다.

---

## 2부 — `SYNCING` (PR 2)

### 상태와 데이터

| | 무엇 |
|---|---|
| `TournamentStatus.SYNCING` | 되살린다(마이그레이션). T71이 「아무도 대입하지 않는다」로 지운 값이고, 이제 대입하는 자리가 둘 생긴다 |
| `Tournament.pausedAt DateTime?` | **정지가 시작된 시각.** 정지가 아니면 null. 이미 있는 `pausedMs`(누적 정지)와 스톱워치 한 쌍이다 |
| Redis `BlindField.pausedAt?` | 위 값의 사본. 레벨 계산과 전광판이 읽는다 |

**`status === SYNCING` ⇔ `pausedAt !== null`.** 두 필드를 쓰는 자리는 둘뿐이고 둘
다 **같은 update 한 문장**으로 둘을 함께 쓴다. 하나로 합치지 않는 이유: 상태는
REST 화면과 조회 필터가 이미 읽는 축이고, 시각은 블라인드 보정의 재료다.

### 켜는 자리 — 부팅 (`RecoveryService.recoverAll`)

- 대상은 `ONGOING` **과 `SYNCING`** 이다. 복구 중에 다시 죽으면 이미 `SYNCING`인
  대회가 복구에서 빠지면 안 된다.
- `pausedAt`은 **마지막 하트비트 시각**이다(`downtimeMs`가 읽는 `beatAt`, 소비 표시로
  덮기 **전의** 값). 하트비트 행이 없으면(최초 부팅) 지금.
- **이미 `SYNCING`인 대회는 `pausedAt`을 건드리지 않는다.** 그러면 첫 정지 · 복구 중
  구간 · 두 번째 정지가 전부 한 번의 보정에 들어간다.
- **부팅에서 다운타임만큼 미는 일(`pausedMs` 증가 · Redis 기준점 이동)을 없앤다.**
  보정은 끄는 자리 한 곳에서만 한다.
- **Redis 블라인드 기준점은 부팅마다 DB에서 대입한다** — `startedAt + pausedMs`,
  `pausedAt`도 DB 값 그대로. 지금은 증분(`+ downtime`)이라 한 번 어긋나면 영영
  어긋난다. 인원수(`syncActivePlayer`)가 증감이 아니라 대입인 것과 같은 이유이고,
  아래 「끄는 자리」의 Redis 실패를 다음 부팅이 고친다.

### 끄는 자리 — n/n (`RecoveryService.completeSync`)

게이트웨이가 n/n을 본 순간 부른다.

1. DB: `updateMany({ where: { id, status: SYNCING, pausedAt: 읽은 값 }, data: { status: ONGOING, pausedAt: null, pausedMs: { increment: Δ } } })`.
   Δ = 지금 − `pausedAt`. **조건부라 동시에 두 딜러가 n/n을 봐도 한 번만 민다.**
2. `count === 1`인 호출만: Redis 기준점 += Δ, `BlindField.pausedAt` 삭제,
   `checkAndSyncBlindLevel(force)`. **DB 뒤에 한다** — Redis는 되돌아가지 않는다
   (`domain.md`의 「Redis 쓰기는 트랜잭션 뒤로」). Redis가 실패하면 시계가 멈춘 채
   남고, 다음 부팅의 대입이 고친다. 로그를 남긴다.
3. 그 대회의 딜러들에게 `tournamentSyncing { syncing: false, … }`.

`completeSync`는 스냅샷을 쓰지 않는다 — `saveSnapshotUnlocked('boot-recovery')`의
근거(「호출자가 부팅 하나뿐」)를 건드리지 않는다.

### 블라인드 시계를 멈춘다

**`SYNCING` 동안 레벨이 오르면 등록 마감이 닫히고, 마감은 단조라 되돌아오지
않는다.** 그래서 보정만으로는 부족하고 계산 자체가 멈춰야 한다.

| 자리 | 바뀌는 것 |
|---|---|
| `getCurrentBlindLevel` (`shared/util/util.ts`) | `now`를 인자로 받는다(기본 `Date.now()`) |
| `RedisService.checkAndSyncBlindLevel` | `now = blind.pausedAt ?? Date.now()`. 빠른 경로(`now < nextLevelAt`)도 같은 값. `serverTime`은 실제 시각 그대로 |
| `buildTournamentMeta` | `pausedAt`을 받아 `BlindField`에 싣고, 레벨을 그 시각으로 잰다 |
| `registration-gate.ts`의 DB 경로 | 메타 유실 시 DB로 계산하는 자리. 같은 멈춘 시각을 쓴다 |

### n/n 판정 (게이트웨이)

- **n** = 좌석 비트맵에 한 명이라도 앉은 테이블 수(`getTournamentTables`). 빈 테이블은
  딜러가 없을 수 있어 뺀다. 비트맵을 쓰는 이유: DB 좌석 행에는 참가가 끝난 잔재가
  남는다(T29) — 불변식은 「좌석 비트맵 == 스냅샷」이다.
- **k** = 그 테이블 중 딜러 소켓(`role === DEALER`)이 하나라도 붙은 수.
- 판정은 순수 함수로 뺀다 — `syncProgress(requiredTableIds, dealerTableIds)`.
- 딜러가 붙을 때(`handleConnection`)와 떨어질 때(`handleDisconnect`), 그 대회가
  `SYNCING`이면 다시 세고 그 대회 딜러들에게 `tournamentSyncing { syncing, present, required }`를
  보낸다. 붙은 딜러 본인에게는 접속 즉시 한 번.
- n/n이면 `completeSync`.
- **n이 0이면 부팅에서 바로 끈다.** 앉은 테이블이 하나도 없는 진행 중 대회(전원이
  좌석 해제된 이동 중)는 붙을 딜러가 없어, 접속 이벤트로 판정하면 영영 안 풀린다.
  `recoverAll`이 켠 직후 한 번 세고 0이면 `completeSync`를 부른다.
- 프로세스가 하나라(`backlog.md` B9) 메모리 안에서 세도 일관된다.

`tournamentSyncing`은 **스냅샷 필드가 아니라 별도 이벤트다** — 대회 단위 정보라서다
(`tournamentClosed`와 같은 판단). contract에 공개형을 둔다.

### 게이트

- **`WsGateway.runDealerAction`**: 대회가 `SYNCING`이면 딜러 명령을 **전부** 거절한다.
  재개 · 핸드 시작 · 승자 입력 · 킥 · 폴드. 승자 입력까지 막는 이유는 리바인 창
  (15초)이 깜깜한 태블릿으로 가기 때문이다. 문구는 「딜러가 모두 돌아올 때까지
  기다려 주세요」.
- 좌석 액션은 새로 막을 것이 없다 — 차례가 있던 테이블은 `resumePending`이 막고,
  나머지는 차례가 없다.

### `ONGOING`과 직접 비교하던 자리

`SYNCING`이 조용히 새는 자리들이다(T71 주석이 경고한 모양).

| 자리 | 새면 |
|---|---|
| `RecoveryService.recoverAll`의 조회 | 복구 중 재시작한 대회가 복구되지 않는다 |
| `ConsoleClient`의 마무리 영역 조건 | 상점이 `SYNCING` 대회를 중단할 수 없다 |
| `me/page`의 `statusLabel` | 참가자 폰에 「종료」가 뜬다(폴백) |
| `DealerService` 딜러 로그인의 승격 | 옛 데이터 보정이 건너뛰어진다 |

**여집합으로 잡는다.** `tournament-status.ts`에 `LIVE_TOURNAMENT_STATUSES`
(`ONGOING` · `SYNCING`)를 두고, 스펙 하나가 **Prisma enum = `PENDING` ∪ LIVE ∪ CLOSED**
(서로소)를 대조한다 — 다음 상태가 어느 쪽에도 안 들어가면 빨개진다.

**contract에 `TournamentStatusSchema`를 둔다.** 프론트 라벨을
`Record<TournamentStatus, string>`으로 바꾸면 상태가 늘 때 폴백 대신 **컴파일
에러**가 난다(`CLOSED_STATUS_LABEL`이 이미 그 방식이다). 백엔드 스펙이 contract
enum과 Prisma enum을 대조한다.

### 화면

| 화면 | `SYNCING`일 때 |
|---|---|
| 전광판 | 「서버 복구 중」 전용 화면. 시계는 `pausedAt`에서 멈춘 남은 시간 |
| 참가자 폰 `/me` · 대회 상세 | 「복구 중」 라벨 |
| 딜러 | 「딜러 7/9 복귀」. 재개 버튼은 `syncing: false`를 받기 전까지 비활성 |
| 상점 콘솔 | 「복구 중」 라벨. k/n은 싣지 않는다 — 멈춘 테이블의 딜러가 현장에서 안다 |
| 좌석 | T95 배너 그대로 |

### 테스트

**시나리오**(`src/scenario/syncing.int-spec.ts`, 스텁 없음). 단계마다 칩 총량 불변식.

1. 판이 돈다 → 재시작 → 대회 `SYNCING`, `pausedAt` = 마지막 하트비트
2. `SYNCING` 동안 딜러 명령 거절, **레벨이 안 오르고 등록이 안 닫힌다**
   (마감 레벨 경계를 정지 구간 안에 두는 입력으로)
3. 딜러 k/n → 아직 `SYNCING`
4. n/n → `ONGOING`, `pausedMs`와 Redis 기준점이 **같은 Δ**만큼
5. **복구 중 재시작** → `pausedAt`이 원래 값 그대로, 대회가 복구 대상에 든다
6. 재개 → 액션이 다시 들어간다

**반대 입력**

- 빈 테이블은 n에서 빠진다 — 없으면 "모든 테이블을 센다"도 3·4를 통과한다.
- 앉은 테이블이 없는 대회는 부팅 직후 `ONGOING`이다.
- 좌석 소켓만 붙은 테이블은 k에 안 든다.
- 이미 `ONGOING`인 대회에 `completeSync`가 오면 0행이고 아무것도 밀지 않는다.
- 두 딜러가 동시에 n/n을 본다 → Δ가 한 번만 더해진다.

**실패를 먼저 본다.** 레벨 동결은 `checkAndSyncBlindLevel`의 `now`를 되돌려 2를
빨갛게, 부팅 대상은 조회를 `ONGOING`으로 되돌려 5를 빨갛게 만들어 확인한다.

---

## 범위 밖

- **콘솔의 테이블별 접속 수.** 판정이 아니라 표시라 딜러의 눈으로 충분하다. 쓰는
  사람이 생기면 그때 붙인다.
- **재시작과 무관하게 딜러가 깜깜한 좌석을 게임에 넣는 일반 경우**(T95 절의 「같은
  결함의 더 큰 판」). 여기서는 재시작 경로만 닫는다.

## PR

1. **좀비 소켓**(1부). 독립적이고, n/n을 믿을 근거다.
2. **`SYNCING`**(2부). 마지막 PR이라 SSOT 커밋이 여기 붙는다 — `tickets-audit.md`의
   T96 상태, 잔여 목록의 「12,000명 재실측」을 닫는 줄(측정 결함은 T76이 원인과
   수정을 확정했다), `domain.md`의 「서버가 죽어도 대회는 계속된다」 표(시간 보정의
   시점이 부팅에서 n/n으로 옮겨감)와 「중단은 정지가 아니다」, `CLAUDE.md` 기준선.
