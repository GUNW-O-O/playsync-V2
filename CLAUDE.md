# Playsync V2

오프라인 홀덤 토너먼트 운영 시스템. 기존 MVP 리포지토리를 복사해 온 뒤,
코드 리뷰에서 발견한 문제를 고쳐나가는 것이 이 리포지토리의 목적이다.
발견된 문제 목록은 `docs/fixlist.md`에 있다.

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
