# 도메인 — 신뢰 경계 · 입력 검증

[`domain.md`](../domain.md)의 한 장이다. 전제와 다른 장의 지도는 거기 있다.

## 신뢰 경계

플레이어 단말은 좌석에 고정 비치된 태블릿이고 버튼과 슬라이더만 있다. 다만
그것은 **UI의 제약이지 서버의 제약이 아니다.** 망이 행사장 WiFi라 같은 망의 아무
단말이나 WS 엔드포인트를 직접 열 수 있다.

**권한은 화면이 아니라 게이트웨이에서 본다.** 자세히는
[`threat-model.md`](../threat-model.md).

좌석 토큰의 권한 판정은 **스냅샷**이다 — `ws.gateway.ts`의
`assertTableAccess`가 `state.players`에 그 `sub`가 있는지 보고,
`PlaysyncService.handleAction`이 없으면 던진다. 그런데 스냅샷만으로는 폐기가
안 된다. **해제된 사람이 다시 앉으면 옛 토큰이 되살아나기 때문이다.** 그래서
좌석 토큰도 세대(`seatTokenVersion`)를 갖는다(T110).

- **마지막 입장이 이긴다.** 입장이 성공할 때마다, 그리고 좌석을 해제할 때 세대가
  오른다. 같은 OTP로 앉은 자리에 다시 들어오면 원래 기기가 끊긴다 — 재부팅이면
  상관없고, 탈취면 피해자 태블릿이 끊겨 현장에서 드러난다.
- 세대는 `/ws/ticket`과 `handleConnection`(방에 넣기 전과 후) 세 번 본다.
  세대를 올리는 쪽이 열린 소켓을 4001로 닫으므로 메시지마다 보지는 않는다 —
  닫히는 중인 소켓의 수신만 버린다.
- 딜러는 기존 `tokenVersion`에 같은 「접속 시 재대조 + 내보내기 시 소켓 닫기」를
  얹었다. 딜러 OTP 재발급은 아무도 끊지 않는다. 탈취를 의심하면 상점은
  재발급과 내보내기를 둘 다 누른다.
- 탈취를 의심한 해제(`rotateOtp`)만 참가 OTP를 바꾼다. 쉬는 시간의 테이블
  합치기마다 바꾸면 옮기는 사람 전원이 폰을 다시 봐야 한다.

### 입장과 딜러 인증은 등록된 매장 태블릿만 한다

OTP를 넣는 곳은 매장 태블릿뿐이다. 그래서 `/enter`와 `/dealer/auth` 앞에
**기기 문**(`DeviceGuard`)을 세웠다. 점주가 태블릿 대기 화면에서 한 번 등록하면
기기 토큰(`deviceToken` 쿠키)이 심기고, 문은 그 토큰의 상점이 요청한 대회의 상점과
같은지, 세대(`Store.deviceTokenVersion`)가 맞는지 본다(T112).

- **문이 OTP보다 먼저다.** 남의 상점 기기는 OTP가 맞는지 떠볼 수 없고, 딜러 잠금
  슬롯(`OtpAttempts.reserveAttempt`)에도 닿지 못한다.
- **요청율 상한은 기기를 센다**(`DeviceThrottlerGuard`). 브라우저 요청은 전부 Next
  주소 하나로 오므로, IP만 세면 아무나 그 버킷을 채워 매장 태블릿 전체를 막는다.
  **서명이 검증된** 토큰만 따로 센다 — 문자열로 가르면 위조할 때마다 새 버킷이다.
- **폐기는 상점 단위다.** 태블릿을 잃어버리면 콘솔의 「전체 등록 해제」로 세대를
  올리고 남은 태블릿을 다시 등록한다. 기기별 목록은 없다.
- **등록은 점주 세션을 남기지 않는다.** 손님 앞 태블릿이 점주로 로그인된 채
  놓이면 안 된다.

## 대회 입력의 경계

`CreateTournamentDto`·`UpdateTournamentDto`(`shared/dto/tournament.dto.ts`)와
`CreateBlindStructureDto`(`shared/dto/blind-structure.dto.ts`)가 입구에서 막는
규칙들이다. 여기서 안 막으면 400이 아니라, 대회가 이미 진행되는 도중에 조용히
깨진다 — 그래서 경계가 여기 있는 이유를 함께 적는다.

- **시작한 대회의 판 규칙은 바꿀 수 없다**(`SessionService.updateSession`, T125). 마감 레벨 ·
  블라인드 구조 · 구간표는 시작할 때 Redis 메타에 실려 돈다. 수정이 DB만 고치면 결제 · 전광판과
  복구가 서로 다른 값을 보고, 구간표는 이미 나간 상금과 어긋난다. 참가비 · 시작 스택 · 상점
  몫은 그보다 앞에서, 걷은 돈이 생기는 순간 잠긴다.
- **구간표를 블라인드 구조보다 먼저 검증한다**(`createSession`). 구조를 먼저 만들면 표가 틀린
  요청이 구조만 남기고 400으로 끝나, 고쳐서 다시 보낸 요청이 이름 유니크에 걸린다.
- **참가비는 1 이상이다.** 0을 허용하면 `recalculateAvgStack`이
  `totalBuyinAmount / entryFee`를 0으로 나눠 NaN이 되고, `DashboardSchema.avgStack`이
  `safeParse`에서 거부해 전광판이 "대기 중"에 영구히 머문다. 상한(`ENTRY_FEE_MAX`)은
  `entryFee` 단발 값이 아니라 **그 값이 쌓이는 `Tournament.totalBuyinAmount`**
  (postgres `integer`, 2,147,483,647)에서 역산한다 — 참가자 규모를 만 명으로 잡으면
  `200_000 × 10_000 < 2^31`이다(T57이 594테이블·5,346명을 실측한 리포).
- **블라인드 구조는 비어 있을 수 없다.** 빈 배열을 통과시키면
  `getCurrentBlindLevel`이 모든 레벨을 지난 경우에 읽는
  `structure[structure.length - 1]`이 `structure[-1]`이 되어 `undefined.lv`로
  죽는다. 그 자리가 대회 시작이라, 참가자가 다 앉은 뒤에야 500이 난다.
- **이미 걷은 돈이 있으면 참가비·시작 스택을 잠근다.** 문지기는 `status`가
  아니라 **`Tournament.totalBuyinAmount > 0`**이다(`SessionService.updateSession`).
  돈은 대회가 시작하기 전, `PENDING`에서 이미 걷힌다(`PaymentService.joinSession`은
  `isClosedTournament`와 등록 마감만 보고 시작 여부는 묻지 않는다). 걷은 뒤에
  분모(`entryFee`)나 `startStack`을 바꾸면 `recalculateAvgStack`의 역산과
  `cancelSession`의 `참가자 수 × entryFee == totalBuyinAmount`가 영영 어긋나, 그
  대회는 취소도 종료도 못 하는 상태로 굳는다(`money.md`의 「상금」 절의 취소 게이트).
- **상점·블라인드 구조 이름의 유니크는 소유자·상점 스코프다**
  (`Store.@@unique([ownerId, name])` · `BlindStructure.@@unique([storeId, name])`).
  전역 유니크였을 때는 남이 먼저 쓴 이름을 못 쓰는 실패 자체가, 다른 테넌트가
  그 이름을 이미 쓰고 있다는 것을 알려주는 통로였다.
