# 좌석·딜러 토큰 폐기와 소켓 종료 설계 (T110)

**항목**: [`docs/tickets-audit.md`](../../tickets-audit.md)의 T110. 결정은 같은 문서
「착수 전에 사람이 정한 것」의 「탈취를 무엇으로 끊나」(2026-10-07).

---

## 왜

참가 OTP 하나를 맞히면 좌석을 계속 쥘 수 있다.

1. **조용한 탈취.** 앉아 있는 사람의 좌석에 같은 OTP로 다시 들어오면
   (`EntryService.enterSeat`의 `sameSeat` 경로) 새 좌석 토큰이 나온다. 원래 기기는
   끊기지 않아서, 두 기기가 같은 명의로 `PLAYER_ACTION`·`REBUY_RESPONSE`를 보낸다.
   좌석 현황에는 아무 흔적도 남지 않는다.
2. **해제해도 돌아온다.** 상점이 좌석을 해제(`SessionService.releaseSeats`)해도
   공격자의 소켓은 열려 있다. 토큰(12시간)은 `/ws/ticket`이 대조하지 않는다
   (`assertTableAccess`는 「그 테이블에 앉았나」만 본다). 그래서 피해자가 다시 앉는
   순간 공격자도 같이 돌아온다.
3. **딜러도 같다.** 내보내기(`revokeDealerSession`)는 갱신과 새 티켓만 막는다.
   열린 소켓은 그대로 남고, `handleDealerAction`이 메시지마다 세션을 확인하지
   않으므로 `RESOLVE_WINNERS`가 계속 통한다.

`token-ttl.ts`에는 「좌석 해제 즉시 옛 토큰의 권한이 0」이라고 적혀 있다. 해제된
사람이 다시 앉으면 이 말은 틀린다.

## 결정

### 좌석 토큰에 세대를 단다

- `TournamentParticipation.seatTokenVersion Int @default(0)`.
- 좌석 토큰 페이로드에 `ver`를 싣는다(`SeatTokenPayload`). `JwtStrategy`의 좌석
  분기가 이 값을 내보낸다.
- **입장이 성공할 때마다 +1 하고 그 값으로 서명한다**(`enterSeat`, `claimSeat`
  성공 뒤). 새로 앉든 `sameSeat`로 다시 들어오든 같다 — **마지막 입장이 이긴다.**
  - 처음 앉는 사람에게는 옛 토큰이 없으므로 아무 일도 일어나지 않는다.
  - `sameSeat` 재입장은 옛 기기를 끊는다. 태블릿 재부팅이나 교체라면 옛 기기는
    이미 꺼졌거나 바꿀 기기라 상관없다. 탈취라면 피해자 태블릿이 끊기므로
    현장에서 바로 드러난다.
  - 올리는 시점을 `claimSeat` 앞에 두지 않는다. 앞에 두면 OTP를 아는 사람이 틀린
    좌석으로 입장을 시도하는 것만으로 남의 세션을 끊을 수 있다.
- **좌석 해제도 +1 한다**(`releaseSeats`, `RELEASED`로 바꾸는 같은 `updateMany`에서).
- 배포 전에 나간 토큰에는 `ver`가 없다. 없으면 무효로 친다. 배포 뒤 한 번 OTP를
  다시 넣으면 된다.

### 세대를 두 군데서 대조한다

1. **`POST /ws/ticket`**(`WsTicketController.issue`): 좌석 토큰이면 참가 행
   `(tournamentId, userId)`의 `seatTokenVersion`과 대조한다. 다르면 403
   `만료된 좌석입니다. OTP를 다시 입력해 주세요.`. 통과하면 티켓에
   `tournamentId`와 `ver`를 싣는다.
2. **`handleConnection`**: 좌석 티켓이면 같은 대조를 한 번 더 한다. 티켓 수명
   30초 동안 해제가 끼면, 발급 때는 맞던 세대가 접속 때는 틀릴 수 있다. 딜러
   티켓에도 `tokenVersion`을 싣고 `DealerService.assertDealerSessionValid`로 다시
   본다.

**메시지마다 대조하지는 않는다.** 세대를 올리는 쪽이 열린 소켓을 닫기 때문이다
(아래). 남는 틈은 「대조를 통과한 접속」과 「닫기」 사이뿐인데, 닫기가 세대를 올린
**뒤에** 돌기 때문에 그 사이에 붙은 소켓은 2번 대조에서 이미 걸린다.

### 세대를 올리면 열린 소켓을 닫는다

- 이벤트 두 개를 둔다. `SEAT_TOKENS_REVOKED { tournamentId, userIds, reason }`,
  `DEALER_SESSION_REVOKED { tournamentId }`.
- 쏘는 자리:
  - `enterSeat`: 세대를 올린 직후, 새 토큰을 내기 전. 이유는 `SEAT_REVOKED_REASON`.
  - `releaseSeats`: 커밋 뒤, **`game.state.updated`(좌석이 빈 스냅샷)를 보낸 뒤에**.
    이유는 `SEAT_RELEASED_REASON`(`상점이 이 좌석을 해제했습니다.`).
    순서가 요건이다. 닫기가 먼저 나가면 소켓이 CLOSING으로 넘어가
    `broadcastRenderGame`이 그 소켓을 건너뛴다. 그러면 해제된 태블릿이 「내 좌석이
    비었다」는 스냅샷을 못 받는다. 그 스냅샷이 대기 화면으로 돌아가는 기존 경로(T29)다.
  - `revokeDealerSession`: 버전을 올린 뒤.
- `handleConnection`은 방에 넣은(`addToMap`) **뒤에** 세대를 한 번 더 본다. 대조와
  방 넣기 사이에 이벤트가 끼면, 그 소켓은 아직 어느 방에도 없어서 닫기를 피한다.
- 게이트웨이가 받아서 맞는 소켓을 닫는다.
  - 좌석: 그 대회 · 그 `userId` · 좌석 역할. 테이블 방과 대회 방 모두.
  - 딜러: 그 대회의 딜러 역할.
- 닫을 때는 `SESSION_REVOKED_CLOSE_CODE = 4001`(contract)과 짧은 이유를 쓴다.
  - 좌석, 재입장: `다른 기기에서 이 좌석에 다시 들어왔습니다.`
  - 좌석, 해제: `상점이 이 좌석을 해제했습니다.`
  - 딜러: `상점이 딜러 연결을 해제했습니다.`
  - WS 이유는 123바이트까지라 한글 40자 안쪽으로 둔다.
- 대조에 쓰려고 소켓에 `tournamentId`를 남긴다. 좌석 티켓이 이제 그 값을 들고 온다.

### 단말은 4001이면 다시 붙지 않는다

- `useTableSocket`: 코드 4001이면 재시도를 예약하지 않는다. `revoked` 상태를 켜고
  이유를 돌려준다. 다시 붙어 봐야 티켓이 403이기 때문이다.
- 좌석 화면과 딜러 화면은 `revoked`이면 덮개를 그린다. 이유 문장과 대기 화면
  (`/table?store=` · `/dealer?store=`)으로 가는 링크를 담는다. 「내 자리라면 OTP를
  다시 넣으세요」.

### 탈취 의심 해제는 OTP도 바꾼다

- `ReleaseSeatsDto.rotateOtp?: boolean`(기본 `false`). 참이면 같은 트랜잭션에서
  해제하는 사람마다 `generatePlayerOtp`로 새 OTP를 넣는다.
- 대회 안 유일 제약(`@@unique([tournamentId, playerOtp])`)에 걸리면 트랜잭션 전체가
  409로 끝나고 상점이 다시 누른다. 10^8 공간에 참가자가 수백 명이라 사실상
  일어나지 않는다(`ponytail:` 주석).
- 상점 콘솔의 좌석 해제에 체크박스 「탈취 의심 — 참가 OTP도 새로 발급」을 둔다.
  참가자는 마이페이지에서 새 OTP를 본다. 기존 화면이 매번 DB에서 읽는다.
- **일반 해제는 OTP를 바꾸지 않는다.** 쉬는 시간의 테이블 합치기마다 OTP를 바꾸면
  자리를 옮기는 사람 전원이 폰을 다시 봐야 한다.

## 범위 밖

- `GET /playsync/:id`(HTTP 스냅샷 읽기)는 대조하지 않는다. 읽기 전용이고, 화면에
  떠 있는 공개 정보다.
- 딜러 OTP 재발급(`reissueDealerOtp`)은 그대로 아무도 끊지 않는다. 끊는 일은
  내보내기가 한다. 탈취를 의심하면 상점은 둘 다 누른다.
- 탈취 감지(실패 카운트·알림) — 대장 「잔여 목록」.

## 테스트

| 무엇 | 계층 |
|---|---|
| 입장마다 세대가 오르고 토큰 `ver`가 그 값이다. 틀린 좌석으로 시도한 실패는 세대를 안 올린다 | 통합(`entry.service.int-spec`) |
| 해제가 세대를 올린다. `rotateOtp`면 해제한 사람의 OTP만 바뀌고 옛 OTP로는 입장이 401 | 통합(`session.service.int-spec`) |
| 낡은 세대의 좌석 토큰은 `/ws/ticket` 403. `ver` 없는 옛 토큰도 403 | 통합 |
| `handleConnection`이 낡은 세대의 좌석 티켓과 낡은 딜러 티켓을 거절한다 | 통합(`ws.gateway.int-spec`) |
| 이벤트가 맞는 소켓만 4001로 닫는다. 다른 사람·다른 대회·다른 역할은 그대로다 | 통합(`ws.gateway.int-spec`) |
| **이음매**: 피해자 착석 → 같은 OTP로 재입장 → 피해자 소켓 4001 → 상점이 `rotateOtp`로 해제 → 공격자의 옛 토큰은 티켓 403, 옛 OTP는 401 → 피해자가 새 OTP로 입장 | 시나리오 |
| 4001이면 재시도하지 않고 `revoked`를 켠다. 다른 코드는 기존대로 | vitest(`use-table-socket`) |
