# Playsync V2

오프라인 홀덤 토너먼트 운영 시스템. 기존 MVP 리포지토리를 복사해 온 뒤,
코드 리뷰에서 발견한 문제를 고쳐나가는 것이 이 리포지토리의 목적이다.

**작업 전에 [`docs/domain.md`](./docs/domain.md)를 읽는다.** 이 도메인은
"카드는 물리, 칩은 디지털"이고, 그 전제를 모르면 **없는 기능을 누락으로 착각해
만들게 된다**(셔플·핸드 랭킹·승자 판정·자동 밸런싱은 전부 의도적으로 없다).

## 문서 지도

| 문서 | 무엇 |
|---|---|
| **`CLAUDE.md`** (이 파일) | 작업 규칙 · 명령어 · 기준선. 매 세션 |
| [`docs/domain.md`](./docs/domain.md) | 도메인 규칙과 **코드 좌표**. 어기면 뭐가 깨지나 |
| [`docs/backlog.md`](./docs/backlog.md) | **지금 단계의 할 일** |
| [`docs/tickets-next.md`](./docs/tickets-next.md) | 작업 기록. 판단 근거를 여기 쓴다 |
| [`docs/review-budget.md`](./docs/review-budget.md) | 서브에이전트로 티켓 돌릴 때만 |
| [`load/README.md`](./load/README.md) | 부하 무대 · 봇. 부하 작업할 때만 |
| [`docs/threat-model.md`](./docs/threat-model.md) | 신뢰 경계 |
| [`README.md`](./README.md) | 프로젝트 설명. 왜 이렇게 만들었나 |
| `docs/fixlist.md` · `docs/tickets.md` | 1단계 기록. **닫힌 문서** |

같은 내용을 두 곳에 쓰지 않는다. 두 벌이 되면 어긋난다.

## 구조

npm workspaces 모노레포.

| 워크스페이스 | 역할 |
|---|---|
| `backend` | NestJS. 게임 로직, WebSocket 게이트웨이, DB/Redis |
| `frontend` | Next.js |
| `packages/contract` | 백엔드/프론트가 공유하는 zod 스키마. **경계를 넘는 것만** 정의한다 |

### contract 패키지 규칙

- 비밀 값은 공개형을 contract에 정의하고, 백엔드가 `.extend()`로 내부형을 만든다.
  전체 스키마를 contract에 두고 `.omit()`으로 빼지 않는다 — 프론트가 import할 수
  있게 되는 순간 규칙이 문서로만 남는다.
- 인바운드(클라 → 서버)는 `.strict()`. 모르는 키가 오면 에러.
- 아웃바운드(서버 → 클라)는 zod 기본 스트립. 스키마에 없는 키는 조용히 제거되므로
  백엔드에 필드를 추가해도 자동으로 새지 않는다.
- Prisma 모델과 백엔드 내부 함수 인자는 contract에 넣지 않는다.

## 명령어

루트에서 실행한다.

```bash
npm run typecheck      # contract 빌드 후 backend/frontend 타입 체크
npm run build          # contract → backend → frontend
npm run dev:backend    # NestJS watch
npm run dev:frontend   # Next dev
npm run test           # 단위 테스트 (인프라 없음, 1분)
npm run test:int       # 통합 테스트 (컨테이너 기동부터 자동)
npm run test:e2e       # 화면 회귀 (Playwright, 시드 필요)
npm run seed           # 개발 시드 (= npm run seed -w backend)
npm run demo           # 데모 촬영 (시드 → 프론트 빌드 → 장면 다섯)
npm run assets         # 촬영본을 자르고 합쳐 img/ 로 (ffmpeg-static)
```

부하 명령(`load:up` · `load:ramp-a/b` · `load:metrics` · `load:logs` ·
`seed:load` · `load:down`)과 그 무대 설명은 [`load/README.md`](./load/README.md).

개발용 인프라는 `cd backend && docker compose up -d`. PostgreSQL + Redis를 띄우고
`seed` 서비스가 마이그레이션과 데모 시드를 한 번 돌리고 끝난다.

**시드는 지우고 다시 만든다.** 데모가 매번 같은 화면에서 시작해야 해서고, 그래서
개발 DB의 기존 데이터가 사라진다. 통합 테스트는 별도 컨테이너(5433/6380)라 무관하다.

## 베이스라인

타입 에러 0건, 테스트 전부 통과가 정상이다. CI(`.github/workflows/ci.yml`)가
타입 체크 · 테스트 · 빌드를 돌린다.

현재 기준선 (T50 완료 시점):

```
contract       62  (4 suites)
백엔드 단위   198  (19 suites)
프론트 단위   100  (24 files)
통합          394  (28 suites)
e2e            13  (4 files, regression 프로젝트)
타입 에러       0
```

`tsc`가 이미 지운 파일의 에러를 계속 보고하면 `.tsbuildinfo`가 낡은 것이다.
`incremental: true`라서 생기는 일이니 `backend/dist`를 지우고 다시 돌린다.

## 테스트

| | 파일 | 인프라 | 잡는 것 |
|---|---|---|---|
| 단위 | `*.spec.ts` | 없음 | 엔진처럼 순수한 로직. 빨라야 TDD 루프가 돈다 |
| 통합 | `*.int-spec.ts` | Redis + PostgreSQL | 락, 트랜잭션처럼 진짜 인프라라야 의미 있는 것 |
| 시나리오 | `src/scenario/*.int-spec.ts` | 위와 같음 | **이음매**. 부품이 각각 옳은데 조립이 틀린 경우 |
| 화면 회귀 | `frontend/e2e/` | 시드 + 백엔드 | 봉투 모양 · 키 이름 · 상태 전이. 색·간격은 단언하지 않는다 |

`src/...`와 `shared/...` 절대경로는 jest `moduleNameMapper`로 해석한다.

**시나리오 계층에는 스텁을 두지 않는다** — 목적이 "부품이 아니라 조립을 본다"라서다.
공용 배선은 `src/scenario/harness.ts`. 단계마다 도메인 불변식을 검사한다(칩 총량
보존, 사이드팟 합 == 팟, 폴드한 사람은 자격 없음, 쇼다운에는 차례 없음, 좌석
비트맵 == 스냅샷). 마지막에 한 번만 보면 "어딘가에서 칩이 사라졌다"까지만 알 수
있어서 **틀어진 첫 순간**을 잡게 만들었다. 실패 메시지에 단계 이름이 남도록
**값을 문자열로 감싼다.**

**e2e에서 조작의 성공 조건은 "눌렀다"가 아니라 "상태가 바뀌었다"다.** 딜러
화면은 SSR 스냅샷으로 펠트를 먼저 그리므로 버튼이 보인다고 소켓이 붙은 게
아니고, 소켓이 안 열린 채 누른 것은 `console.error` 하나만 남기고 사라진다.

**락을 mock으로 테스트하면 검증 대상인 원자성 자체가 사라진다.** 그래서 통합
테스트는 `docker-compose.test.yml`이 띄우는 별도 컨테이너(5433 / 6380)를 쓴다.
DB 이름이나 Redis 인덱스로 나누지 않은 이유는, 테스트가 데이터를 지우는 코드라
설정 실수 하나로 개발 DB를 날릴 수 있기 때문이다. **방어 코드보다 구조로 막는다.**

반복 실행은 `KEEP_TEST_CONTAINERS=1`로 기동을 건너뛰고
`npm run test:int:down -w backend`로 내린다. e2e는 시드가 먼저다
(`npm run seed -w backend && npm run test:e2e`).

Prisma는 드라이버 어댑터 구성이라 `$disconnect()`가 pg Pool을 닫지 않는다.
테스트에서는 반드시 `closeTestPrisma()`를 쓴다. 아니면 jest가 종료되지 않는다.

### 통과한 테스트를 믿지 않는다

**새 테스트가 처음부터 통과하면 의심한다.** 실제로 네 번 데였다.

- 기존 상수와 결과가 같은 입력을 골라서, 수정 전에도 통과했다
- 다른 계층이 이미 막고 있어서 검증 대상에 닿지도 못했다
- 참가자 테이블만 봐서, 상금이 포인트로 안 나가는데도 초록이었다
- 두 검사가 서로를 가렸다(T29). **둘이 일치하는 입력만** 먹여서 검사 하나를
  통째로 지워도 38건이 전부 초록이었다 — 검사가 둘이면 **둘이 어긋나는 입력**이
  있어야 각각이 증명된다

그래서 **실패를 먼저 본다.** 사후에 추가한 검사는 제품 코드를 일부러 되돌려
빨간불을 확인한다(`git stash push <파일>` 또는 임시 편집 후 복원).

## 작업 규칙

### 언어

- PR 제목과 본문은 **한국어**로 작성한다.
- 커밋 메시지, 코드 주석, 문서는 기존 파일의 언어를 따른다.

### 브랜치

- `main`에서 직접 작업하지 않는다. 티켓 단위로 브랜치를 딴다.
- PR 머지 시 원격 브랜치는 삭제된다. 머지 후 `git fetch --prune`과
  로컬 브랜치 삭제까지 해서 정리한다.

### 검증

- 완료를 주장하기 전에 실제로 명령을 실행하고 출력을 확인한다.
- 버그 수정은 **실패하는 테스트를 먼저 만들어** 문제를 재현한 뒤 고친다.

### 코드를 가리킬 때는 줄 번호가 아니라 이름으로

문서와 주석이 코드를 가리킬 때 **함수 · 메서드 이름**을 쓴다. 이름이 없는
자리는 식별자(`UPDATE_SEAT_BIT` 같은 상수)로 잡고, 함수 안의 특정 대목은
**그 대목이 하는 일**로 적는다 — "`deleteTable`의 Redis 정리".

줄 번호는 문서가 위치의 사본을 드는 것이라 코드를 고칠 때마다 두 곳을 맞춰야
하는데, **어긋난 것을 잡아 주는 장치가 없다** — 타입 체커도 CI도 안 본다.
이름은 바뀌면 `grep`이 0건을 내므로 리팩터링 자체가 문서를 밀어낸다.

예외는 `docs/tickets-next.md`·`docs/tickets.md`·`docs/fixlist.md`다. **기록물이라
갱신하지 않는다** — 그때의 좌표를 지금 것으로 고치면 "그때 무엇을 봤는가"가
거짓이 된다. 다만 **새로 쓰는 절은 이름으로 적는다.**

### 셸

Bash 툴의 작업 디렉터리는 **호출 사이에 유지된다.** `cd backend/src` 한 번이
다음 호출까지 남아 루트 기준 경로가 조용히 빗나간다. **절대경로를 쓰거나 같은
호출 안에서 `cd`한다.**

### 서브에이전트

티켓을 서브에이전트에 분배할 때만 [`docs/review-budget.md`](./docs/review-budget.md)를
읽는다. 요점: **태스크를 덜 쪼개고, 태스크 리뷰는 동시성에 닿는 제품 코드만
받고, 최종 전체 리뷰는 opus로 자르지 않는다.**
