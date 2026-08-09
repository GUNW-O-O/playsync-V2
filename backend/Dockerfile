# 부하테스트용 백엔드 이미지.
#
# **배포 이미지가 아니다.** 이 리포는 실배포를 하지 않는다. 이건 CPU 예산을
# 묶어 두고 계측하기 위한 대상이고, 그래서 크기보다 "손이 덜 가는 것"이
# 기준이다.
#
# 그 기준이 두 가지를 정했다.
#
# **alpine을 쓰지 않는다.** `bcrypt`가 네이티브 모듈이라 musl에서는 prebuild가
# 맞지 않아 `python3 make g++`를 깔아 컴파일해야 한다. 이미지 150MB를 아끼자고
# 컴파일 삽질을 하는 셈인데, 로컬 계측 대상이라 크기가 아무것도 바꾸지 않는다.
# 개발용 compose의 `seed` 서비스가 같은 이유로 `node:22`를 쓴다.
#
# **멀티스테이지로 나누지 않는다.** 런타임이 빌더 산출물을 거의 다 필요로 한다 —
# 컨테이너가 뜰 때 `prisma migrate deploy`를 돌리므로 prisma CLI(devDependency)가
# 있어야 한다. 나눠도 버릴 것이 없으면 단계만 늘어난다.
FROM node:22

WORKDIR /app

# 의존성 설치를 소스 복사보다 앞에 둔다. 소스만 바뀌면 이 레이어가 캐시된다.
# 워크스페이스 루트의 lock 하나로 전부 설치되므로 package.json을 먼저 모은다.
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci

# 프론트는 이 이미지에 들어가지 않는다. 부하는 REST와 WS를 직접 친다
# (설계 문서의 "범위 밖" 참고). 다만 워크스페이스 lock이 하나라 위
# `npm ci`가 프론트 의존성까지 설치한다 — 그 대가는 이미지 크기뿐이다.
COPY packages/contract packages/contract
COPY backend backend

# contract가 먼저다. 백엔드가 그 dist를 import한다.
RUN npm run build:contract

# **`prisma generate`가 빌드보다 앞이다.** `npm ci`는 클라이언트를 만들어 주지
# 않고(postinstall이 없다), 없으면 `@prisma/client`가 타입을 하나도 내보내지
# 않아 `nest build`가 TS2305로 죽는다 — 개발용 compose의 `seed` 서비스가 같은
# 함정을 겪었고 그 주석이 같은 말을 한다.
#
# 생성 시점에는 DB에 붙지 않지만 `prisma.config.ts`가 `process.env.DATABASE_URL`을
# 읽으므로 자리 채움을 준다. 런타임 값은 compose가 넣는다.
WORKDIR /app/backend
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate

# `nest build`는 tsconfig의 baseUrl을 보고 `src/...` 절대경로를 상대경로로
# 바꿔 준다. 그래서 런타임에 경로 매퍼가 필요 없다.
WORKDIR /app
RUN npm run build -w backend

WORKDIR /app/backend

# 진입점이 `dist/main`이 아니라 `dist/src/main`이다. `shared/`가 `src/` 밖에
# 있어 rootDir이 backend/로 잡히기 때문이다. package.json의 `start:prod`는
# `node dist/main`이라 실제로는 뜨지 않는다 — 호출자가 없어 드러나지 않았다.
#
# 마이그레이션을 여기서 돌린다. 부하용 인프라는 tmpfs라 컨테이너가 죽으면
# 스키마도 사라지므로, 기동 때마다 다시 세우는 것이 맞다. `migrate deploy`는
# 이미 적용된 것을 건너뛰므로 반복 실행이 안전하다.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
