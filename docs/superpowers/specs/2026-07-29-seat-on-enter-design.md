# T28 — 좌석 확정을 입장 시점으로

**2026-07-29.** 참가 OTP(T27)가 발급까지 됐다. 이 티켓은 그 OTP를 **쓰는 곳**을
만든다: 참가비 결제에서 좌석을 떼어내고, 태블릿에서 OTP를 넣는 순간 좌석이
확정되게 한다.

## 왜

지금은 결제 한 번이 두 가지를 한다 — 돈을 내는 것과 의자를 정하는 것.

```ts
// payment.service.ts  joinSessionWithSeat(dto, userId)
//   dto = { tournamentId, tableId, seatIndex }
```

오프라인에서 이 둘은 같은 순간이 아니다. 돈은 미리 낸다. 의자는 현장에서 앉을 때
정해진다. 붙여 두면 두 가지가 어긋난다.

- **사람이 자리를 옮기면 좌석 기록이 따라가지 않는다.** 쉬는 시간에 테이블을
  합치면 사람은 걸어가는데 결제 시점에 박힌 `TablePlayer`는 그대로다.
- **좌석 예매가 필요해진다.** 결제 화면에서 의자를 고르게 하려면 남은 자리를
  보여주고 선택 중인 자리를 잠가야 한다. `acquireSeatLock`이 그래서 있다.
- **앉지도 않은 자리가 점유된다.** 결제만 하고 안 온 사람의 의자가 비어 있는 채로
  막혀 있다.

좌석 확정을 입장 시점으로 옮기면 셋이 한꺼번에 없어진다. 앉는 순간에 정하므로
예매할 것이 없고, 예매가 없으니 잠글 것도 없다.

## 무엇을

```
[집·상점] 폰으로 참가비 결제 → 참가 확정, OTP 발급 (T27)
[현장]     빈 자리에 앉는다 → 폰에서 OTP 확인 → 그 자리 태블릿에 입력
          → 그 의자가 내 자리가 된다
```

## 지금 구조

| | |
|---|---|
| 플레이어 신원 | 태블릿의 `accessToken` 쿠키. 그 태블릿에서 로그인한 사람 |
| WS 신원 | `POST /ws/ticket`이 `sub = userId`로 티켓 발급, 게이트웨이가 소비 |
| 좌석 대조 | `ws.gateway.ts:87` — `state.players.some(p => p.id === payload.sub)` |
| 좌석의 진실 | 테이블 스냅샷(Redis). `TablePlayer`는 DB 기록 |
| 좌석 유일성 | `@@unique([tableId, seatPosition])` |

딜러는 반대다. OTP를 넣으면 `tableId`가 박힌 토큰이 나오고 그게 곧 신원이다
(`dealer.service.ts:42` `loginDealer`). 로그인 계정이 없다.

**참가 OTP를 딜러 쪽으로 놓는다.** 태블릿은 공용 하드웨어다. 거기에 개인 계정
세션이 남지 않는 편이 낫고, 무엇보다 OTP는 **사람이 들고 다니는 값이라 자리를
옮겨도 따라간다.**

## 결정 1 — 결제와 입장의 경계

### 결제 `POST /tournaments/payment`

**받는 것.** `PayMentDto`에서 `tableId`와 `seatIndex`를 뺀다. `{ tournamentId }`만
남는다.

**하는 일.** 포인트 차감 → `TournamentParticipation` 생성(OTP 발급과 충돌 재시도
루프는 T27 그대로) → `totalPlayers` · `activePlayers` · `totalBuyinAmount` 증가.

**없어지는 것.**

- `acquireSeatLock` / `releaseSeatLock` 호출
- `TablePlayer` 생성과 그 앞의 좌석 중복 검사
- 스냅샷 쓰기(`withTableLock` 블록 전체)
- `updateSeatBitmap` · `setUserContext` · `SEAT_LIST_UPDATED` 발행

`joinPlayer`는 **결제에 남는다.** 이름은 착석처럼 들리지만 하는 일은
`tournament:{id}:info`의 `totalPlayer`·`activePlayer`·`totalBuyinAmount`를 올리는
것이고(`redis.service.ts:297`), 그건 방금 결제가 DB에 올린 세 필드의 Redis
미러다. 좌석과 무관하다.

**반환.** `TableState`가 아니라 참가 확정 정보. 결제 시점에는 테이블이 없다.

**`activePlayers`는 결제에 남긴다.** 탈락 시 감소하는 값이라 "앉아 있는 인원"이
아니라 "탈락하지 않은 참가 인원"이고, 좌석과 무관하다.

**참가 상태는 항상 `WAITING`으로 만든다.** 지금은 `isOngoing ? PLAYING : WAITING`을
쓰고, 딜러 로그인이 뒤늦게 `WAITING → PLAYING`을 메운다
(`dealer.service.ts:93`). 착석 시점이 하나로 모이면 그 보정이 필요 없다.

`PlayerStatus` enum이 이미 이 세계를 서술하고 있다.

```prisma
WAITING     // 바이인 완료 후 대기
PLAYING     // 테이블 착석 중
ELIMINATED  // 탈락
AWARDED     // 상금권 진입 후 종료
```

### 입장 `POST /tournaments/:id/enter`

새 모듈 `src/entry/`에 둔다. 결제 서비스에 넣지 않는 이유는 책임이 다르기
때문이다 — 결제는 돈이고 입장은 인증과 좌석이다. `payment.service.ts`는 이미
223줄이고, 여기에 JWT 서명까지 들어가면 한 파일이 돈·인증·좌석을 전부 진다.

```ts
// backend/shared/dto/entry.dto.ts
export class EnterTournamentDto {
  // 길이만 재면 "abcdefgh"가 통과해 조회까지 내려간다. 형식으로 막는다.
  @Matches(/^\d{8}$/) otp: string;
  @IsString() tableId: string;
  @IsInt() @Min(0) @Max(8) seatIndex: number;
}
```

응답은 `{ accessToken }` 하나다. 딜러 로그인과 같은 모양이다
(`dealer.service.ts:109`). 태블릿은 이 토큰으로 WS 티켓을 받고, 테이블 상태는
연결 뒤 브로드캐스트로 온다 — 여기서 스냅샷을 같이 실어 보낼 이유가 없다.

절차.

1. 대회 조회. 없거나 OTP가 맞는 참가가 없으면 **같은 401**. 가르면 존재하는
   대회 id를 훑을 수 있다 — 딜러 로그인과 같은 이유(`dealer.service.ts:53`).
2. `FINISHED`면 403.
3. 참가 상태가 `ELIMINATED`·`AWARDED`면 409. 끝난 사람은 다시 앉지 않는다.
4. 이미 `TablePlayer`가 있으면
   - 다른 자리면 409. 좌석 이동은 T29다.
   - 같은 `(tableId, seatPosition)`이면 재발급 경로다. 아래 5번의 락에 들어가되
     **스냅샷의 그 좌석이 비어 있거나 다른 사람일 때만** 채워 넣는다. 이미 이
     사람이 앉아 있으면 손대지 않는다 — 진행 중인 핸드의 `bet`·`hasFolded`·
     `totalContributed`가 날아간다.

   비어 있는 경우를 살리는 이유는 5번이 DB를 먼저 쓰고 스냅샷을 나중에 쓰기
   때문이다. 그 사이에 프로세스가 죽으면 DB에는 있고 스냅샷에는 없는 사람이
   남는다. 재입장이 유일한 복구 경로인데 여기서 아무것도 하지 않으면 그 사람은
   영영 앉지 못한다(자기 `TablePlayer` 때문에 신규 착석 경로로도 못 간다).
   이때 스택은 `TablePlayer.currentStack`에서 읽는다 — 스냅샷이 없으니 그것이
   유일한 출처다.
5. `withTableLock(tableId)` 안에서: 테이블이 이 대회 소속인지 확인 →
   `TablePlayer` 생성 → 스냅샷에 좌석 채우기 → 비트맵·`setUserContext` 갱신 →
   `SEAT_LIST_UPDATED` 발행 → 참가 상태를 `PLAYING`으로.
6. 좌석 토큰 발급.

**시도 제한은 걸지 않는다.** T27에서 정한 그대로다 — 잠금 단위를 참가자로
내릴 수 없고(OTP 전에는 신원이 없다), 대회 단위로 걸면 자리를 옮긴 사람 전원이
못 들어오는 DoS 원시함수가 된다. 막는 것은 8자리 길이다.

**OTP 조회는 복합 unique 단건이다.**

```ts
prisma.tournamentParticipation.findUnique({
  where: { tournamentId_playerOtp: { tournamentId, playerOtp: dto.otp } },
})
```

경로의 `tournamentId`가 범위를 강제하므로 다른 대회의 OTP는 애초에 맞지 않는다.

**`omit: { playerOtp: false }`는 여기에 쓰지 않는다.** 클라이언트 수준 `omit`은
출력만 가린다 — `where`에는 그대로 쓸 수 있다. 입장은 OTP로 **찾을** 뿐 돌려받을
일이 없으므로, "참가 OTP를 읽는 유일한 곳은 마이페이지"라는 T27의 문장이 그대로
유지된다.

## 결정 2 — 좌석 토큰

```ts
{ sub: userId, tournamentId, tableId, seatIndex, role: 'PLAYER' }   // 1h
```

**`sub`가 `userId`인 이유**: 게이트웨이가 `state.players.some(p => p.id ===
payload.sub)`로 좌석을 대조한다(`ws.gateway.ts:87`). 스냅샷의 플레이어 id가
`userId`라 다른 값을 넣으면 좌석 대조가 조용히 실패한다.

**`role: 'PLAYER'`는 Prisma `Role` enum에 없는 값이다.** 마이그레이션이 필요 없고,
`Role`은 `User` 행의 속성이라 "이 사람은 플레이어다"가 아니라 "이 토큰은 좌석
토큰이다"를 거기에 적는 것도 맞지 않는다.

이 선택이 권한 범위를 **화이트리스트가 아니라 기존 가드 배치의 귀결로** 만든다.
`RolesGuard`는 `requiredRoles.includes(user.role)`이므로(`roles.guard.ts:21`),
`'PLAYER'`는 어떤 `@Roles(...)` 목록과도 맞지 않아 전부 거부된다.

| 경로 | 가드 | 좌석 토큰 |
|---|---|---|
| `POST /tournaments/payment` | `@Roles(USER)` | 거부 |
| `GET /user/me/participations` | `@Roles(USER)` | 거부 |
| `/store/*` · 대회 운영 | `@Roles(STORE_ADMIN, PLATFORM_ADMIN)` | 거부 |
| `/playsync/*` (내 테이블 · 액션) | `JwtAuthGuard`만 | **통과** |
| `POST /ws/ticket` | `JwtAuthGuard`만 | **통과** |

즉 좌석 토큰이 할 수 있는 일은 **그 좌석으로 게임에 참여하는 것뿐**이다. 돈을
쓰지도, 남의 OTP를 보지도, 대회를 만들지도 못한다.

`JwtStrategy.validate`는 이 역할에 대해 세 번째 분기를 갖는다.

```ts
if (payload.role === SEAT_ROLE) {
  return {
    userId: payload.sub,
    tournamentId: payload.tournamentId,
    tableId: payload.tableId,
    seatIndex: payload.seatIndex,
    role: SEAT_ROLE,
  };
}
```

`userId` 키를 그대로 두는 이유: `/playsync/*`가 `req.user.userId`로 플레이어를
찾는다. 딜러처럼 `id`로 바꾸면 게임 경로가 전부 `undefined`를 받는다.

**갱신 엔드포인트는 만들지 않는다.** 1시간이 지나면 같은 자리에서 OTP를 다시
넣으면 되고, 그건 절차 4번에서 이미 정한 규칙이다. 딜러의 `/dealer/refresh`는
`tokenVersion`으로 강제 폐기를 표현해야 해서 존재하지만, 좌석 토큰에는 폐기할
세션 개념이 없다.

## 결정 3 — 핸드 도중 착석을 허용한다

홀덤은 먼저 앉은 사람과 마감 전에 늦게 들어오는 사람이 섞인다. 늦은 참가는 대회가
`ONGOING`이고 테이블이 **핸드 도중**일 때 들어온다.

폐기한 좌석 재배치 설계에서 "`GamePhase.WAITING`일 때만 좌석이 움직인다"를 살려
두었는데, **그건 이미 앉아 있는 사람을 옮길 때의 조건이다.** 그 사람은 팟에 칩이
들어가 있고 차례가 걸려 있다.

신규 착석은 얽힘이 없다.

- `totalContributed = 0` → 사이드팟 계산에서 빠진다(`table-engine.ts:189`)
- `hasFolded = true` → `isAllMatched`와 차례 회전에서 빠진다(`table-engine.ts:93`)
- 핸드가 끝나면 `resetStatus()`가 모든 좌석의 `hasFolded`를 지운다
  (`table-engine.ts:281`) → 다음 핸드부터 정상 참여

그래서 **T28에는 `phase` 가드가 없다.** 가드는 T29(이동)로 넘긴다.

| | T28 신규 착석 | T29 이동 |
|---|---|---|
| 핸드 도중 | 허용 | 거부 |
| `hasFolded` 초기값 | `state.phase !== GamePhase.WAITING` | 해당 없음 |

`isOngoing`(대회 상태) 대신 스냅샷 `phase`를 보는 이유: 늦은 참가가 핸드 사이나
휴식 중에 들어오면 대회는 `ONGOING`이어도 바로 다음 핸드에 들어가는 것이 맞다.
대회 상태로는 그 차이를 알 수 없다.

같은 좌석 재입장(태블릿 재부팅·재접속)은 스냅샷을 건드리지 않으므로 핸드 도중에도
허용된다. 핸드 중에 단말이 죽은 사람이 못 돌아오면 그 테이블이 멎는다.

## 결정 4 — 락을 제약으로 바꾼다

`acquireSeatLock`은 좌석 예매를 위한 것이었다. 예매가 없어지면 근거가 없다.

두 사람이 같은 의자에 동시에 OTP를 넣으면 `@@unique([tableId, seatPosition])`이
한쪽을 P2002로 떨어뜨린다. 락은 만료 시간이 있고 제약은 없다 — T25가
`tableOrder` 재시도 코드를 제약으로 바꾼 것과 같은 자리다.

`withTableLock`은 남는다. 좌석 락과 다른 것을 지킨다 — 스냅샷은 JSON 통째로
덮어쓰므로, 다른 의자에 앉는 두 사람이 겹치면 나중에 쓴 쪽이 앞선 착석을 지운다.

**검사는 락 안에서 다시 한다.** 락 밖 검사만 믿으면 T25의 `deleteTable`이 걸렸던
check-then-act가 재현된다.

`RedisService`에서 `acquireSeatLock` · `releaseSeatLock`을 삭제한다. 남겨 두면
다음 사람이 "좌석은 락으로 지킨다"고 읽는다.

## 에러

| 상황 | 응답 |
|---|---|
| 대회 없음 / OTP 불일치 | 401 `인증 정보가 올바르지 않습니다.` (구분하지 않는다) |
| 종료된 대회 | 403 `종료된 대회입니다.` |
| 탈락·상금 종료된 참가 | 409 |
| 다른 자리에 이미 앉아 있음 | 409 |
| 그 대회 소속이 아닌 테이블 | 403 |
| 좌석 선점(P2002) | 409 `이미 다른 참가자가 앉은 좌석입니다.` |

## 테스트

무게중심이 여기 있다. 좌석이 결제에서 빠지면 **셋업이 두 단계가 된다** —
`joinSessionWithSeat` 호출부가 하네스 포함 6개 파일이다.

**하네스.** `src/scenario/harness.ts`에 `seatPlayer(tournamentId, tableId, seat,
userId)`를 만든다. 결제 → OTP 조회(`omit: { playerOtp: false }`) → 입장 순서로
묶고, 기존 루프(`harness.ts:155`)를 이것으로 바꾼다.

**입장 통합 테스트** (`entry.service.int-spec.ts`)

- OTP 불일치 401 · 다른 대회의 OTP 401 · `FINISHED` 403
- `ELIMINATED` 참가 409
- 다른 자리에 앉아 있는 참가자 409
- 같은 좌석 재입장 → 토큰 재발급, `TablePlayer` 행이 하나 그대로인지
- 같은 좌석 재입장인데 **스냅샷 좌석이 비어 있으면** 다시 채워 넣는지(중간에
  죽은 경우의 복구), 반대로 **이미 앉아 있으면** `bet`·`hasFolded`를 건드리지
  않는지
- 같은 좌석에 동시 두 요청 → 하나만 성공. **락이 아니라 P2002로 갈리는지**
- 핸드 도중 착석 → `hasFolded: true`로 앉고, 핸드가 끝난 뒤 살아나는지
- 좌석 토큰의 `sub`가 `userId`라 게이트웨이 좌석 대조를 통과하는지

**가드 회귀 테스트.** 좌석 토큰으로 `POST /tournaments/payment`와
`GET /user/me/participations`가 거부되는지. `'PLAYER'`를 enum 밖에 둔 근거가
여기서만 증명된다.

**결제 통합 테스트 수정.** 좌석·스냅샷·비트맵을 더는 만들지 않는지.

RED는 리포 규칙대로 먼저 본다. 사후에 추가하는 검사는 제품 코드를 되돌려
빨간불을 확인한다.

## 범위 밖

- **좌석 해제와 이동**(T29). 상점이 앉은 사람을 좌석에서 떼는 것, `currentStack`을
  `TournamentParticipation`으로 옮기는 것, `WAITING` 가드.
- **입장 화면.** 태블릿이 자기 `tableId`·`seatIndex`를 어떻게 아는지(직원 설정
  대 화면에서 선택)는 프론트 문제다. 서버가 보는 요청은 어느 쪽이든 같다. B7.
- **비트맵 유실 복구가 `tables[0]`만 되살리는 것**(`payment.service.ts:62`).
  결제가 좌석을 만들지 않게 되면 `totalPlayers > 0`인데 좌석이 하나도 없는 상태가
  정상이 되므로 저 조건은 더 자주 빗나간다. 스냅샷 재구성과 함께 B2에서 본다.
- **`GET /user/add`.** 가드가 없어 모든 요청이 `TypeError`로 죽는 죽은 코드다.
  삭제가 답이지만 이 티켓의 일이 아니다.
