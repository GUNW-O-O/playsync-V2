# 전체 리뷰 발견 목록 (리뷰어 보고 요약, 검증 전)

상태: [ ] 미처리 / [x] 고침 / [T] 티켓으로 올림 / [-] 기각

## F 프론트 (frontend/src)
- [ ] F1 bug SeatGameClient: 리바인 마감 지나면 팝업에 갇힘 (`!rebuyDataRef.current` 가드, 좌석 null이어도 덮개 안 뜸) — 검사 추가함, 수정 중
- [ ] F2 bug SeatGameClient: sawRebuyPromptRef가 안 풀려 리바인 수락 뒤 좌석 해제가 "탈락"으로 뜸 — 검사 추가함
- [ ] F3 bug ConsoleClient: `useState(preview)`의 live가 router.refresh 뒤에도 옛 값 (종료 버튼 꺼진 채)
- [ ] F4 bug SeatGameClient minRaise = currentBet + sb*2 (SeatActionPanel은 lastRaiseSize ?? BB). 단일 출처는 패널
- [ ] F5 bug DealerGameClient sendDealerAction: 소켓 닫혀 있으면 console.error만, submitWinners/confirmKick은 오버레이를 무조건 닫음
- [ ] F6 bug DealerGameClient: renderGame마다 setActionError(null) — 남의 액션으로 거절 모달이 지워짐
- [ ] F7 bug RebuyOverlay: ActionTimer에 serverNow 없음 (gameState.serverTime 넘기면 됨)
- [ ] F8 bug 휴식: DisplayClient 휴식 화면이 "등록 마감" 무조건 표기 / 참가자 블라인드표가 lv 99를 "레벨 99"로 그림 / 다음 레벨이 휴식이면 sb를 다음 블라인드로(미확인)
- [ ] F9 bug WaitingClient · DealerWaitingClient selectTournament: 실패 시 앞 대회 테이블 남고 같은 대회 재시도 안 됨
- [ ] F10 comment Seat/DealerGameClient: "서버가 소켓을 끊지 않으므로"(closeTable이 1000으로 닫음), "받는 이벤트는 둘뿐/renderGame뿐", 좌석 머리 주석끼리 모순, 배너 "서로 다른 자리라 가리지 않는다"(둘 다 absolute top-0 z-50)
- [ ] F11 comment reconnect-policy retryAfterMs "시도는 8회뿐"(MAX_ATTEMPTS 10) / DisplayClient requestIdRef "3초 간격"(POLL_MS 1000), 머리 주석이 redis.service.ts:282,285 줄번호 / OtpReveal "FINISHED일 때만 null"(FINISHED 또는 CANCELLED) / auth/action.ts handleLogin "res.ok를 먼저 본다"(json 먼저)
- [ ] F12 comment 콘솔: "조작 다섯"·"다섯 액션"·"네 번 조회"(실제 액션 11, 조회 6) / abortTournament "대회 목록으로 떠나고"(그 자리 refresh) / "run을 거치지 않는 유일한 조작"(위치 어긋남, openConfirm도 안 거침) / page.tsx RawTable "관리용 컬럼까지"(select id,tableOrder) / dealer/page.tsx "입장 OTP"(딜러 OTP)
- [ ] F13 dup 딜러·좌석 page 로더(getInitialGameData, getTableContext, json()), Waiting 클라 selectTournament·OTP 입력. 딜러 쪽은 행을 안 좁히고 넘김
- [ ] F14 dup EliminatedOverlay / TournamentClosedOverlay: COUNTDOWN_SECONDS 7 두 벌, 카운트다운 effect·블록 동일
- [ ] F15 dup failureMessage 여섯 벌(+auth 변형) / RebuyPrompt 타입이 contract에 없음(as 캐스팅) / OTP_LENGTH 8·6 사본 / STATUS_LABEL 두 벌 / PHASE_LABEL 두 벌(Record<number>) / 백엔드 응답 손 타입 여럿

## W 접속 · 복구 · Redis
- [ ] W1 bug 좌석 비트맵 유실 시 required=[] → 0/0 done → SYNCING이 스스로 풀림 (measureSync/recount, recoverTournament 끝). domain.md가 부분 유실은 열어 둠 → "유실인데 자동 해제"만
- [ ] W2 bug 회선 정지 직후 「지금 진행」이 다음 probe 틱에 되돌려지고 정지 시간 이중 계상 (lastDealerSeenAt=T0 그대로, pausedAt이 마지막 재개보다 앞설 수 없다는 가드 없음)
- [ ] W3 bug 회선 정지 뒤 Redis 장애 겹치면 resumePending.reason이 lineDown으로 남음 (overwrite:false) — 문구만
- [ ] W4 bug+comment handleTournamentClosed가 지운 lastDealerSeenAt/graceTimers를 closeTable발 handleDisconnect가 되살림 (맵 누수, 0행 update)
- [ ] W5 bug(미검증) 핸드셰이크 중 닫힌 소켓이 addToMap으로 방에 남음, sweep 로그 10초마다
- [ ] W6 bug+dup HEARTBEAT_INTERVAL_MS 검증 없음(빈 문자열→0) / env 정수 파서 두 모양(sync-queue 둘 동일, keepalive 둘)
- [ ] W7 comment recovery.module.ts "복구가 턴 타이머를 다시 걸어야"(큐 주입 안 함, 등록만 세 번째)
- [ ] W8 comment recoverAll "하트비트 주기(30초)"(5초)
- [ ] W9 comment metrics.controller "전역 가드가 없어서"(DeviceThrottlerGuard 전역)
- [ ] W10 comment RecoveryService: boot/outageFromBoot 주석이 onApplicationBootstrap을 가리킴(bootOnce) / completeSync "딜러 태블릿이 전부"(좌석도, forceSync도) / freezeTournament "부팅과 Redis 복귀가 같이"(회선도) / pauseForLineOutage @param "10~20초"(약 6초)
- [ ] W11 comment keepalive probeMisses "`probe`만 쓴다"(onPong이 직접 0으로)
- [ ] W12 comment rebuildSeatBitmap 주석이 setUserContext를 :seat 키 사용자로 듦(:user 키)
- [ ] W13 dup Redis 접속 설정 두 벌(redis.module 기본값 있음 / app.module BullModule 기본값 없음 → NaN)
- [ ] W14 dup ONGOING→SYNCING 조건부 update 세 벌 / "답하는 딜러" 판정 세 벌(probeDealers wasTableDealer, hasDealer role+tournamentId, tablePresence role)
- [ ] W15 dup 이벤트루프·CPU 계측 두 벌(MetricsService, stage-timer) / LOAD_METRICS 판정 세 곳 / 허용 출처 두 벌(main.ts enableCors 하드코딩 vs WS_ALLOWED_ORIGINS) / redis 키 문자열·TTL 86400 반복 / outageOf·linePauseOf

## G 게임 진행 (engine · playsync · dealer · shared)
- [ ] G1 bug 베팅한 사람을 딜러 폴드/킥하면 팟 증발 (shouldGoToShowdown이 bet===currentBet 요구 → 남은 한 명도 폴드 → 자격자 0, sidePots [] → pot=0). 주석 "자격자가 없는 팟은 만들어질 수 없다" 거짓
- [ ] G2 bug 상금권에서 킥하면 그 등수 상금이 안 나가 completeSession 안 열림 (테이블 2개 이상 상금권)
- [ ] G3 bug 미달 올인 뒤 이미 액션한 사람의 재레이즈를 안 막음 (handleRaise, docblock은 막는다고 함)
- [ ] G4 bug+comment KICK의 DB 트랜잭션·setUserContext가 mutateSnapshot 콜백 안 (주석은 금지라고 적음); scheduleTurnTimeout 던지면 불일치
- [ ] G5 bug(미검증) 체크포인트 재시도 고리와 retryCheckpoint 경합 — 락 밖 읽기, 페이즈 미확인
- [ ] G6 bug(미검증) askRebuyRound Promise.all: 한 명 throw 시 나머지 열린 창이 버려짐
- [ ] G7 bug+comment 킥된 사람에게도 리바인을 물음 (stack<=0만 봄)
- [ ] G8 bug/comment 리바인 마감이 하나가 아님 (markRebuyPending 한 번, waitForRebuyResponse가 각자 다시 계산)
- [ ] G9 bug(낮음) 멈춘 테이블에 딜러 FOLD/KICK이 마감·타임아웃 잡을 새로 검 (resumePending 검사 없음)
- [ ] G10 comment prize.ts: 머리말 "기본값을 두지 않는"(DEFAULT_PAYOUT_TABLE 있음) / 떠 있는 prizeFor docblock, itmCount / awardPrize "돈이 나가는 유일한 지점"(환불·상점 몫은 따로)
- [ ] G11 comment dealer.service: SNAPSHOT_MISSING "여섯 곳"(10곳, 두 곳은 다른 문구) / handleTournamentClosed "stillBroke로 나간다"(closedTables break) / resolveWinners "세 구간"(다섯) / RebuyOutcome docblock 둘 연달아
- [ ] G12 comment createEmptyTableState "TableEngine.startPreFlop이 덮어쓴다"(DealerService.startPreFlop) / nextPhase "딜러 폴드가 이 상태에서도" / handleAction 낡은 TIME_OUT "읽은 상태를 돌려준다"(null) / executeRebuyTransaction 순서 / payout-table 머리말 "마감 뒤 totalBuyinAmount 불변"
- [ ] G13 dup 파산자 필터 4번(정본 eliminateBusted) / ['ELIMINATED','AWARDED'] 리터럴 세 곳(정본 player-status.ts FINISHED_PLAYER_STATUSES)
- [ ] G14 dup turnOwner vs scheduleTurnTimeout의 nextPlayer / DB_SYNC_RETRY_* 파싱 두 벌
- [ ] G15 dup 좌석 수 9 다섯 곳 / 상금 구성식 두 번 + RedisService 재구현(getFullTournamentInfo, recalculateAvgStack의 totalBuyin/entryFee)

## 내가 찾은 것
- [x] 없는 이름 참조 12곳, resumeTable 주석, money.md 정지 서술 (7ed4ad1)
- [ ] DealerService: 체크포인트 후 finishHand/실패 반환 두 번 (resolveWinners 끝, retryCheckpoint)

## 아직 안 온 보고
- 대회·결제·착석·인증·contract
- 부하·스크립트·테스트 도구 + 문서 대조

## M 대회 · 결제 · 착석 · 인증 · contract
- [ ] M1 bug 포인트 음수: joinSession 잔액 검사가 트랜잭션 밖, UserService.paymentPoint가 무조건 decrement, CHECK 제약 없음 (서로 다른 대회 둘에 동시 결제)
- [ ] M2 bug cancelSession/abortSession/completeSession이 문지기 updateMany보다 먼저 읽음 → 그 사이 들어온 참가비가 환불 없이 닫힘. 주석은 막았다고 적음. 방향: 문지기 먼저(잠금) 뒤에 읽기
- [ ] M3 bug cancelSession이 startSession에 지면(updateMany 0행) return 뒤에도 finishClose(CANCELLED)가 무조건 실행 → 살아 있는 대회의 Redis 삭제 + 닫힘 방송, 응답 ok
- [ ] M4 bug 우승 상금이 나간 뒤에도 joinSession이 참가비를 받음 (tournamentFinished가 status·등록을 안 바꿈) → 종료 409, 중단하면 늦은 참가자 돈이 나뉨
- [ ] M5 bug+dup buildTournamentMeta가 휴식 lv 99를 그대로 비교 (currentRegistrationLevel 미사용) → 휴식 중 메타 재건 시 등록 영구 닫힘
- [ ] M6 bug chopBlocker가 HAND_END 허용 — 체크포인트 전이라 currentStack 낡음 (체크포인트 실패로 HAND_END에 멈춘 상태에서 딜)
- [ ] M7 bug createSession이 블라인드 구조를 구간표 검증 전·트랜잭션 밖에서 생성 → 400 뒤 재시도가 P2002 409 반복, 고아 구조
- [ ] M8 bug(그럴듯) updateSession이 시작 뒤 rebuyUntil·blindId·payoutTable 변경을 DB에만 씀 (Redis 옛 값)
- [ ] M9 comment registration.ts isRegistrationOpenNow "그 뒤로 바뀌지 않는다" / tournament-meta "DB 컬럼은 생성 시에만" (closeRegistration이 내림)
- [ ] M10 comment schema.prisma DealerSession.tokenVersion "최대 1시간"(12시간, 즉시 종료), "로컬스토리지" / CANCELLED "시작 전 전액 환불"(abort도 씀)
- [ ] M11 comment entry.service: enterSeat "폐기 수단을 붙이지 않는"(seatTokenVersion 올림) / shouldBlockEmptySnapshot "createTable 새 테이블은 스냅샷 없는 것이 정상"(반드시 만듦), "!== FINISHED"(isClosedTournament), RecoveryService 건너뜀(미확인) / claimSeat "payment가 트랜잭션을 락 밖에"(결제는 락 안 씀)
- [ ] M12 comment 묶음: isFinishedParticipant 주석 반대("끝나지 않은"), 쓰는 곳 settlement뿐 / groupAbortRefunds "상금권은 PLAYING인 채"(AWARDED) / getMyParticipations "FINISHED만 제외" / joinSession "세 필드"(둘) / contract tournament-closed "넷 중 둘"(다섯) / seed.ts REBUY_UNTIL·BLIND_STRUCTURE 휴식 서술 / session.service JSDoc 세 겹이 getFinishPreview 위에 떠 있음, 찹 블록 끊김 / payment "참가비 결제" 주석이 chargePoint 위 / auth signupInitialPoints "충전 경로도 없어서"(MOCK_PAYMENT)
- [ ] M13 dup 상점 소유권 판정 세 벌 (assertStoreOwnership, DeviceService.ownedStore, StoreService.getStoreDetail이 404/403을 가름 → id 열거)
- [ ] M14 dup P2002 필드 추출 두 벌(claimSeat, joinSession) / enterSeat `ELIMINATED || AWARDED`(isFinishedParticipant) / cancelSession notIn 리터럴(NOT_CLOSED_TOURNAMENT_FILTER) / SessionService.createBlind 호출 0건 / RolesGuard가 ROLES_KEY 대신 'roles'
- [ ] M15 dup backend/shared/types/tournamentMeta.ts가 contract dashboard.ts 사본 / settlement AbortGroup vs contract / GamePhase 미러 / shared/types/jwt.ts JwtPayLoad·DealerToken import 0건

## L 부하 · 스크립트 · 테스트 도구
- [ ] L1 bug 봇 딜러: RESOLVE_WINNERS도 thinkMs()를 타 3%(ABSENT_RATIO)로 null → 승자 입력 안 보냄, 쇼다운엔 타이머 없어 테이블 멈춤. handsPlayed.add(1)이 send 앞 (load/lib/table.js send/step)
- [ ] L2 bug outage-report.mjs 기준선 창 [T0-(DOWN+180), T0)이 앞 끊김과 겹침 (outage-run.sh 루프는 190초만 쉼; "20 90"이면 270초)
- [ ] L3 bug kill-run.sh: SYNCING 못 봐도 "SYNCING 확인" 찍음 → 다음 루프가 kill 전 ONGOING을 읽어 가짜 해제 시각; set -u뿐이라 up/migrate/kill/start 실패 미확인; 착석 시간초과도 break로 진행; until curl 상한 없음. outage-run.sh 앞부분 동일
- [ ] L4 bug kill-run/outage-run: trap 없음 → 중간 종료 시 backend-load가 6코어로 남고 k6 컨테이너 남음
- [ ] L5 bug frontend/package.json "test:e2e:headed"에 --project 없음(세 프로젝트 연달아), "demo" 스크립트는 시드·DEMO_PROD 없이 개발 서버로 찍음
- [ ] L6 bug harness.ts checkInvariants 6번이 비트맵 개수만 비교(자리 아님), 비트맵 없어도 착석 0이면 통과. CLAUDE.md는 "좌석 비트맵 == 스냅샷"이라 적음. 1번은 chipsOnTable 재구현
- [ ] L7 bug(낮음) ramp.js 예약 재접속 시각이 START_GROW_S 무시
- [ ] L8 comment 부하 쪽 줄 번호 참조 아홉 개가 전부 다른 코드: table.js(playsync.service.ts:86, table-engine.ts:31·55·333, ws.gateway.ts:316, dealer.service.ts:309), api.js(jwt.strategy.ts:27, session.service.ts:195-197), ramp.js·smoke.js(auth.module.ts:25, dealer.service.ts:193). load/README.md도 셋
- [ ] L9 comment ramp.js "JWT가 1시간"(상점·딜러·좌석 12h, token-ttl.ts)
- [ ] L10 comment 묶음: table.js "SeatGameClient에 자동 재접속이 없어" / door.js ARRIVAL_SETTLE_S "60초"(BLOCK_MS 30초) / docker-compose.test.yml k6 "T40이 스크립트를 붙인다. 지금은 봇이 없다", 머리말 "개발 DB에 연결할 수단 자체가 없다"(name 없어 같은 프로젝트·네트워크, 미실행) / seed.ts "비밀은 stdout으로만"(.demo-seed.json에 딜러 OTP), writeManifest JSDoc이 resetAll 설명 / seed-load.ts "대회 하나"(LOAD_STORES개), "충전 경로도 없다" / make-demo-assets.mjs "장면 다섯", "0.15초 자홍색"(400ms), "좌우로 놓는다", "검게 채워질 뿐 실패하지 않는다"(던짐) / surfaces.ts Mark 주석·tournament.spec.ts 머리말·테스트 제목 "장면 1~5"(장면 6 있음) / playwright.config.ts "대회는 하나뿐"(둘) / harness.ts setupTournament @param opts.blindDuration(없음, blindStructure) / reconnect-backoff.js "api.js의 wsTicket"(wsTicketAttempt) / outage global-teardown "KEEP_OUTAGE_CONTAINERS=1로 기동을 건너뛰고"(down만 건너뜀)
- [ ] L11 risk seed-load.ts main: Redis 포트 기본 6379(개발), DATABASE_URL 5433 가드 없음 → 개발 env면 개발 DB TRUNCATE+flushdb / kill-run `docker rm -f $(docker ps -aq --filter name=k6)` 이름에 k6 든 것 전부 / outage stopBackend 낡은 pid kill
- [ ] L12 dup .env.test 파서 둘(global-setup loadTestEnv vs helpers/test-env applyTestEnv, CI 동작 다름) / TRUNCATE SQL 둘(truncateAll, resetAll) / demo.mjs·demo-settlement.mjs run·ROOT·빌드 / kill-run·outage-run 앞 50줄 / seed.ts 참가 트랜잭션·테이블 루프 두 번 / load/lib/monitor.js watch 호출 0건(ramp.js가 재작성) / threshold 수집 루프 둘 / UNNUMBERED vs STILLS / console.spec signInAsOwner vs openWithToken / settlement.spec이 localhost:3001 세 번(BACKEND_URL 있음)

## D 문서 대 코드
- [ ] D1 frontend/e2e/README.md "장면 다섯"·"장면 1~5"·절 제목·표 (실제 여섯, CLAUDE.md는 여섯)
- [ ] D2 e2e README 「레벨 1의 길이가 유일한 창이다」 "정산 무대는 12분"(seed.ts SETTLEMENT_BLIND_STRUCTURE lv1 duration 5)
- [ ] D3 load/README 「액션 믹스」 "최소 레이즈 규칙이 없다"(lastRaiseSize로 강제)
- [ ] D4 load/README 「실측이 잡은 것 셋」 JWT 1시간·auth.module.ts:25·"좌석 토큰도 같은 수명"(12h). 제목 "셋"인데 열둘쯤
- [ ] D5 load/README "BlindStructure.name이 전역 유니크"(@@unique([storeId, name])) — 스키마 직접 확인 필요
- [ ] D6 load/README 머리: "유일한 자동 검증은 창 큐의 단위 테스트"(스펙 넷), 파일 지도에 reconnect-backoff.js·reconnect-burst.js·kill-run.sh·outage-run.sh·outage-report.mjs 없음, 맨몸 `npm run seed:load`는 env 없이 죽음
- [ ] D7 load/README 「bcrypt 둘」 "충전 경로도 없어서" ↔ 같은 문서 MOCK_PAYMENT
- [ ] D8 e2e README 「카메라 밖의 손」 "넷이다"(backstage export 더 많음), assets "장면 1~5 촬영본"
- [ ] D9 threat-model.md 관찰 표 4번 "레이트 리밋 … 딜러 OTP만 닫힘 (T23)"(T53 요청율 상한 있음), "플레이어 6자리 OTP는 아직 스키마에 없다"(playerOtp 있음), 9번 "JWT 만료 1시간" — 기록 형식일 수 있음, 확인 필요
- [x] D10 CLAUDE.md 기준선 통합 807/51 → 이미 808/52로 고침 (#144)
- [ ] D11 CLAUDE.md 명령어에 없는 스크립트: check:images(CI도 안 부름), test:outage:down, load:smoke
- [ ] D12 CLAUDE.md 「테스트」 "KEEP_TEST_CONTAINERS=1로 기동을 건너뛰고"(global-setup은 안 읽음, down만 건너뜀)
- [ ] D13 recovery.md 끝 문단 "recoverAll()의 호출자가 OnApplicationBootstrap 하나뿐"(bootOnce, TimeoutProcessor도) / backlog.md B2 "(T93~T109 · T113~T114)"
- [ ] D14 같은 사실 두 곳: 「줄 번호가 아니라 이름으로」(domain.md 머리 + CLAUDE.md → CLAUDE.md) / e2e 규칙(CLAUDE.md 베이스라인·테스트 + e2e README → e2e README) / T76 235배(CLAUDE.md + load/README 두 번 → load/README) / 재접속 정책 숫자(recovery.md + load/README → recovery.md) / load/README 「무대」가 compose 주석 반복
- [ ] D15 tickets-recovery.md 완료 행 T113·T116~T122가 한 줄+PR 번호가 아니라 규칙·실측을 듦(대장 규칙 위반)
