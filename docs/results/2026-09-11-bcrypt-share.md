# 문의 비용 중 bcrypt의 몫 — 2026-09-11

**질문**: 1코어 512MB가 입장 부하를 정말 받는가. 그리고 그 부하 중 얼마가
bcrypt인가.

**답**: 테이블 하나를 세우는 비용의 **71%가 bcrypt다.** 그리고 594석 규모에서는
1코어가 그것을 받아낸다 — 착석 동안 코어가 꽉 차지만 붕괴하지 않고, 고원에서는
CPU 6%로 떨어진다.

`BCRYPT_ROUNDS` 노브(#109)가 처음 쓰인 실행이다.

## 무대

| | |
|---|---|
| 서버 | `cpus: 1` · `mem_limit: 512m` · `--max-old-space-size=340` |
| 규모 | 66테이블 594석 (계정 풀 594, 실행 중 가입 10%) |
| 모양 | 계단 없이 **고원 직행** — 60초에 66테이블을 세우고 7분 유지 |
| 상한 | `THROTTLE_*` 100000 (문을 재는 실행이 아니다) |
| 재접속 | 시작 +270초에 전원 동시 재접속 |

계단을 안 밟은 이유는 이 실행이 재려는 것이 **문의 비용**이라서다. 계단으로
올리면 착석이 단계마다 흩어져 한 번에 몰리는 모양이 안 나온다.

## 잰 값

`table_setup_ms` — VU 하나가 자기 테이블을 열고 좌석 아홉을 채우는 데 걸린 시간.
테이블마다 한 번씩, 66개.

| | 코스트 4 | 코스트 10 | 차이 |
|---|---|---|---|
| p50 | 214ms | 737ms | **+523ms** |
| p95 | 321ms | 859ms | +538ms |
| 최대 | 356ms | 933ms | +577ms |

**523ms가 bcrypt다.** 코스트 10 비용 737ms의 71%다.

산수가 맞는다. 테이블 하나에 로그인이 열 번쯤 돈다 — 상점 관리자 하나와 좌석
아홉이다. `523 ÷ 10 ≈ 52ms`이고, 2026-08-21이 잰 코스트 10의 58ms와 같은 자리다.
코스트 4는 지수로 64분의 1이라 사실상 0이다.

## 실행 요약

| | 코스트 4 | 코스트 10 |
|---|---|---|
| 핸드 | 155 | 77 |
| 내 액션 p95 | 10ms | 15ms |
| 남의 액션 p95 | 11ms | 15ms |
| 서버 lag 중앙 / 최대 | 0.4 / 8.4ms | 0.57 / 6.99ms |
| 고원 CPU | 6.2% | 5.7% |
| rss | 209MB | 213MB |
| 가입 / 기대 | 57 / 59 | 60 / 59 |
| 로그인 / 기대 | 594 / 594 | 594 / 594 |
| 소켓 오류 | 0 | 1 |
| 결과 | 완주 | **중단** |

착석 구간 CPU는 양쪽 다 80~100%였다. 착석이 끝나는 순간 한 자리 수로 떨어진다.

**축이 둘로 갈린다는 2026-08-21의 결론이 이 규모에서도 그대로다** — 문은 비싸고
방은 싸다. 594명이 핸드를 돌리는 고원이 1코어의 6%다.

## 코스트 10 실행이 중단된 것

```
test aborted: 내 액션 p95가 1000ms를 2번 연속 넘었다
(테이블 66개, 최근 30건 p95 2270ms)
```

시각이 **동기화된 재접속 시점과 겹친다.** 코스트 4 실행은 같은 재접속을
통과했다(내 액션 최대 2150ms로 한 번은 튀었지만 연속 두 번이 아니었다).

**이것을 bcrypt 탓으로 적지 않는다.** 조건마다 실행이 하나씩이라 코스트 차이인지
실행 편차인지 가를 수 없고, 재접속은 WS 티켓 경로라 bcrypt를 타지도 않는다.
확정하려면 같은 조건을 여러 번 돌려야 한다. **여기 적는 것은 "한 번 관측됐다"까지다.**

재접속 폭발 자체는 T93이 들고 있는 문제다.

## 이 실행이 답하지 않는 것

- **12,000명 재실측이 아니다.** 규모가 20배 작다(594 대 12,420). 그쪽의 질문은
  「1,061ms가 T76이 걷어낸 측정 결함만으로 설명되는가」이고 여기 안 닿는다.
- **`UV_THREADPOOL_SIZE`를 안 건드렸다.** bcrypt가 문의 71%라는 것이 확정됐으니
  `backlog.md`의 B11(4 → 8로 올리면 착석 창이 줄어드는가)은 **살아 있다.**
  다음 실행에서 같은 자리를 잰다.
- **조건마다 한 번씩이다.** `table_setup_ms`는 테이블 66개의 분포라 표본이
  충분하지만, 중단 같은 실행 수준의 사건은 n=1이다.

## 측정 도구가 두 번 거짓말할 뻔했다

유효한 값을 얻기 전에 실행 둘을 버렸다. 둘 다 **무대가 스스로 어긋난 것**이고,
둘 다 하네스의 요약 줄이 잡아 줬다.

**하나 — 기동 경합.** `--force-recreate` 직후에 k6를 걸었다. 컨테이너는
「Started」였지만 Node가 아직 안 떠서 `connection refused`가 쏟아졌고, k6가 6초
동안 반복을 2만 번 태웠다. `poolBase`가 반복 순번에서 나오는 값이라 그 2만 번이
순번을 풀 크기 너머로 밀었고, 실제 착석은 전부 「풀 부족 → 가입」으로 갔다.
요약 줄의 `가입 594/기대 59 풀부족 594 ⚠`가 그것이다. 같은 이유로 대회 시작
로직(`localIdx === 0`)도 어긋나 **핸드가 0이었다.**

**둘 — 셸마다 env가 필요하다.** k6를 돌리는 `docker compose run`이 compose 파일을
다시 읽는다. 그 셸에 `BCRYPT_ROUNDS`가 없으면 `${BCRYPT_ROUNDS:-10}`이 기본값으로
풀리고, **compose가 백엔드를 그 값으로 다시 만든다.** 시드는 4인데 백엔드는 10인
상태가 됐고, 그 재생성이 곧 위의 기동 경합이었다.

무대에 걸 것 둘이 여기서 나온다.

- `backend-load`에 **헬스체크가 없다.** k6의 `depends_on`이 DB와 Redis만 기다린다.
- `load/README.md`가 `export BCRYPT_ROUNDS=4`를 한 번 적는데, **그 값이
  `docker compose`를 부르는 모든 셸에 있어야 한다**는 말이 없다.

## 다시 돌리는 법

```bash
export BCRYPT_ROUNDS=4        # 또는 10
docker compose -f backend/docker-compose.test.yml --profile load \
  up -d --force-recreate backend-load
# 백엔드가 응답할 때까지 기다린다 — 헬스체크가 없어서 사람이 한다
until curl -sf http://127.0.0.1:3001/internal/metrics >/dev/null; do sleep 2; done

DATABASE_URL="postgresql://test:test@127.0.0.1:5433/playsync_test" \
REDIS_HOST=127.0.0.1 REDIS_PORT=6380 REDIS_PASSWORD=test npm run seed:load

docker compose -f backend/docker-compose.test.yml --profile load --profile k6 \
  run --rm k6 run --out json=/load/results/ramp-a-bcrypt04-raw.json \
  -e LOAD_TABLES_PER_STORE=6 -e LOAD_RECONNECT_AT_TABLES=30 \
  -e LOAD_START_TABLES=66 -e LOAD_MAX_TABLES=66 \
  -e LOAD_START_GROW_S=60 -e LOAD_STEADY_S=420 /load/scenarios/ramp.js
```

시드와 백엔드가 같은 값이어야 한다. `compare` 비용은 **저장된 해시**가 정하므로
한쪽만 바꾸면 로그인 90%가 옛 코스트 그대로다(`backend/src/auth/bcrypt-cost.ts`).

확인하는 법은 하나다.

```bash
docker exec playsync-db-test psql -U test -d playsync_test -t \
  -c 'select left(password,7), count(*) from "User" group by 1;'
docker inspect playsync-backend-load \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep BCRYPT
```

둘이 같은 숫자를 가리켜야 한다.
