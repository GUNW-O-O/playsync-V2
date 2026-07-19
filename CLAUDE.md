# Playsync V2

오프라인 홀덤 토너먼트 운영 시스템. 기존 MVP 리포지토리를 복사해 온 뒤,
코드 리뷰에서 발견한 문제를 고쳐나가는 것이 이 리포지토리의 목적이다.
1단계(MVP 정합성 복구)는 끝났다. 발견 대장은 `docs/fixlist.md`, 판단 근거는
`docs/tickets.md`(T1~T21)에 남아 있고 둘 다 닫힌 문서다.

지금 단계의 할 일은 `docs/backlog.md`, 작업 기록은 `docs/tickets-next.md`에 쓴다.
도메인 전제와 구조는 `docs/README.md`가 최신이다.

## 도메인

**카드는 물리, 칩은 디지털이다.**

플레이어는 오프라인 테이블에 모여 앉고, 카드는 사람 딜러가 실물로 딜링한다.
시스템이 관리하는 것은 카드를 제외한 나머지 — 칩 스택, 팟, 베팅 순서,
블라인드 레벨, 좌석 배치, 탈락과 리바인이다.

이 경계가 코드 곳곳의 설계를 설명한다.

- `TableState`에 덱도, 홀카드도, 커뮤니티 카드도 없다. 셔플·핸드 랭킹·승자 판정
  로직이 없는 것은 누락이 아니다. 그건 테이블 위에서 일어난다.
- 승자는 계산되지 않고 **입력된다**. 딜러가 실물 카드를 보고 `resolveWinners`에
  승자를 순서대로 넘긴다. 그래서 이 경로는 "검증"할 수 있는 정답이 없고,
  딜러 입력을 신뢰할 수밖에 없다 — 대신 **부기(칩 총량, 사이드팟 분배)는
  시스템이 책임진다**.
- 딜러가 게임 진행의 트리거다. `startPreFlop`, `handleDealerAction`,
  `resolveWinners`가 사람의 클릭에서 출발한다. 즉 **딜러 경로와 플레이어 경로가
  동시에 같은 상태를 건드린다**. 동시성이 이론이 아니라 기본 시나리오인 이유.
- 플레이어 단말은 좌석에 고정 비치된 태블릿이고, 조작할 수 있는 것은 버튼과
  슬라이더뿐이다. 다만 이는 **UI의 제약이지 서버의 제약이 아니다** — 망이
  행사장 WiFi라 같은 망의 단말이 WS 엔드포인트를 직접 열 수 있다.
  신뢰 경계는 `docs/threat-model.md`에 명시한다(B1 이전에 작성).

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
npm run test           # 단위 테스트 (인프라 없음, 2초)
npm run test:int       # 통합 테스트 (컨테이너 기동부터 자동)
```

개발용 인프라는 `cd backend && docker-compose up -d` (PostgreSQL + Redis).

### 베이스라인

타입 에러 0건, 테스트 전부 통과가 정상이다. CI(`.github/workflows/ci.yml`)가
타입 체크 · 테스트 · 빌드를 돌린다.

`tsc`가 이미 지운 파일의 에러를 계속 보고하면 `.tsbuildinfo`가 낡은 것이다.
`incremental: true`라서 생기는 일이니 `backend/dist`를 지우고 다시 돌린다.

### 테스트

`nest g`가 생성하는 스캐폴드 스펙 18개와 스캐폴드 e2e를 제거했다. 전부
`expect(x).toBeDefined()` 뿐이라 회귀를 잡지 못하는데, jest가 `src/...` 절대경로를
해석하지 못해 import 단계에서 죽고 있었다. 초록인지 빨간지가 아무것도 의미하지
않는 상태였다.

지금은 `table-engine.spec.ts` 하나로 시작해 티켓마다 실제 회귀 테스트를 쌓는다.
버그 수정은 실패하는 테스트로 문제를 재현한 뒤 고친다.

`src/...`와 `shared/...` 절대경로는 jest `moduleNameMapper`로 해석한다.

#### 두 계층

| | 파일 | 인프라 | 용도 |
|---|---|---|---|
| 단위 | `*.spec.ts` | 없음 | 엔진처럼 순수한 로직. 빨라야 TDD 루프가 돈다 |
| 통합 | `*.int-spec.ts` | Redis + PostgreSQL | 락, 트랜잭션처럼 진짜 인프라라야 의미 있는 것 |

락을 mock으로 테스트하면 검증 대상인 원자성 자체가 사라진다. 그래서 통합 테스트는
`docker-compose.test.yml`이 띄우는 **별도 컨테이너**를 쓴다 — 개발용과 이미지는 같지만
포트(5433 / 6380)와 저장소가 분리돼 있다. tmpfs와 영속성 해제라 데이터가 남지 않는다.

DB 이름이나 Redis 인덱스로 나누지 않은 이유는, 테스트가 데이터를 지우는 코드라
설정 실수 하나로 개발 DB를 날릴 수 있기 때문이다. 방어 코드보다 구조로 막는다.

`npm run test:int`가 컨테이너 기동 → 마이그레이션 → 테스트 → 정리까지 한다.
반복 실행할 때는 `KEEP_TEST_CONTAINERS=1`로 기동을 건너뛸 수 있고,
`npm run test:int:down -w backend`로 내린다.

Prisma는 드라이버 어댑터 구성이라 `$disconnect()`가 pg Pool을 닫지 않는다.
테스트에서는 반드시 `closeTestPrisma()`를 쓴다. 아니면 jest가 종료되지 않는다.

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
- 버그 수정은 실패하는 테스트를 먼저 만들어 문제를 재현한 뒤 고친다.
