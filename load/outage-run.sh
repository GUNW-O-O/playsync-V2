#!/usr/bin/env bash
# 대회 하나의 회선만 끊는 측정(T121).
#
# 첫 대회에 N테이블, 그 뒤 대회들에 대조군을 세운다 — 기본은 30테이블을 10테이블씩 셋
# (`CONTROL` · `CONTROL_PER_STORE`로 바꾼다. 예: 556 + 444를 6씩이면 전체 1,000). 첫 대회의 봇만
# 맡은 k6 컨테이너를 `docker pause`로 얼렸다 푼다. 프로세스만 얼어 종료 신호 없이 응답만
# 사라지므로, 서버가 보는 모습이 회선이 말없이 끊긴 것과 같다. 봇이 소켓을 직접 닫으면
# 서버가 그 자리에서 알아채 감지 지연을 못 잰다.
#
#   bash load/outage-run.sh <끊는 대회의 테이블 수> "<끊는 초들>" <태그> [build]
#
# 끊는 초를 여럿 주면(예: "20 90") 한 번 앉힌 무대에서 차례로 끊는다 — 착석을 다시 하지 않는다.
#
# KILL=1이면 끊기 전에 같은 무대에서 백엔드를 죽였다 살린다(kill-run.sh와 같은 순서). 착석을
# 한 번만 하려는 것이다 — 재접속은 좌석 토큰으로 티켓만 받아 착석의 bcrypt와 무관하다. 끊김은
# `SYNCING`이 다 풀리고 나서, 아래 「직전 같은 길이」 창이 kill 복구에 걸치지 않을 만큼
# 지난 뒤에 시작한다.
#
# 결과는 `load/results/outage-<태그>*`. 표는 `outage-report.mjs`가 백엔드 로그의
# `[event]` 줄로 만든다. 환경변수 RATE(초당 착석 인원, 기본 8)는 kill-run.sh와 같다.
set -u
N=$1; DOWNS=$2; TAG=$3; BUILD=${4:-}
CONTROL=${CONTROL:-30}
CONTROL_PER_STORE=${CONTROL_PER_STORE:-10}
STORES=$(( 1 + (CONTROL + CONTROL_PER_STORE - 1) / CONTROL_PER_STORE ))
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/load/results/outage-$TAG
cd "$ROOT"
export MSYS_NO_PATHCONV=1 BCRYPT_ROUNDS=4
C="docker compose -f backend/docker-compose.test.yml"
BE=playsync-backend-load
VICTIM=playsync-k6-victim
sql() { docker exec playsync-db-test psql -U test -d playsync_test -tAc "$1" 2>/dev/null; }
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT.log"; }
ms() { date +%s%3N; }
: > "$OUT.log"
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 중간에 끝나도(Ctrl+C, 아래의 exit) 무대를 되돌린다(T128). 안 그러면 백엔드가 착석용
# 6코어로 남아 다음 램프가 「1코어」라고 믿는 무대가 달라지고, k6 컨테이너가 계속 돈다.
cleanup() {
  docker update --cpus 1 $BE >/dev/null 2>&1
  docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
}
trap cleanup EXIT

# 결과가 어느 코드의 것인지 남긴다. 무대 탓 실패(VM · 측정기)는 다시 돌리면 되므로 적지 않는다.
say "커밋 $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- backend packages load || echo ' (커밋 안 된 수정 있음)')"
say "정리"
docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
if [ -n "$BUILD" ]; then
  say "빌드"
  $C --profile load up -d --build >>"$OUT.log" 2>&1 || { say "무대 기동 실패"; exit 1; }
else
  $C --profile load up -d >>"$OUT.log" 2>&1 || { say "무대 기동 실패"; exit 1; }
fi

TOTAL=$(( N + CONTROL ))
say "마이그레이션 + 시드 (대회 $STORES, $TOTAL 테이블)"
export DATABASE_URL="postgresql://test:test@127.0.0.1:5433/playsync_test" REDIS_HOST=127.0.0.1 REDIS_PORT=6380 REDIS_PASSWORD=test
(cd backend && npx prisma migrate deploy) >>"$OUT.log" 2>&1
LOAD_STORES=$STORES LOAD_MAX_TABLES=$TOTAL npm run seed:load >>"$OUT.log" 2>&1 || { say "시드 실패"; exit 1; }

say "백엔드 재시작 (6코어로 착석)"
docker restart $BE >/dev/null
docker update --cpus 6 $BE >/dev/null
for i in $(seq 1 120); do
  curl -sf http://127.0.0.1:3001/internal/metrics >/dev/null && break
  [ "$i" = 120 ] && { say "백엔드가 2분 안에 안 떴다"; exit 1; }
  sleep 1
done

# 둘이 같은 창에 앉는다 — 합친 도착률이 RATE가 되게 전체 인원으로 잡는다.
GROW=$(( TOTAL * 9 / ${RATE:-8} + 30 ))
# 자리 비움과 지각을 끈다 — 켜 두면 평소의 시간 초과 폴드가 끊김이 만든 것과 섞인다.
# KILL이면 kill 복구(최대 10분)와 그 뒤의 간격이 얹혀 고원이 더 길어야 한다.
COMMON="-e LOAD_STEADY_S=$([ -n "${KILL:-}" ] && echo 3600 || echo 2400) -e LOAD_BREACH_STREAK=100000 -e LOAD_ABSENT_RATIO=0 -e LOAD_LATE_RATIO=0"
say "k6 둘 시작 (증설 ${GROW}초)"
$C --profile load --profile k6 run --rm --name $VICTIM $COMMON \
  -e LOAD_START_TABLES=$N -e LOAD_STEP_TABLES=$N -e LOAD_MAX_TABLES=$N \
  -e LOAD_START_GROW_S=$GROW -e LOAD_GROW_S=$GROW -e LOAD_RAMP_NAME=outage-$TAG-victim \
  k6 run /load/scenarios/ramp.js >"$OUT-victim.txt" 2>&1 &
K6V=$!
$C --profile load --profile k6 run --rm --name playsync-k6-control $COMMON \
  -e LOAD_START_TABLES=$CONTROL -e LOAD_STEP_TABLES=$CONTROL -e LOAD_MAX_TABLES=$CONTROL \
  -e LOAD_TABLES_PER_STORE=$CONTROL_PER_STORE -e LOAD_STORE_OFFSET=1 -e LOAD_TABLE_OFFSET=$N \
  -e LOAD_START_GROW_S=$GROW -e LOAD_GROW_S=$GROW -e LOAD_RAMP_NAME=outage-$TAG-control \
  k6 run /load/scenarios/ramp.js >"$OUT-control.txt" 2>&1 &
K6C=$!

WANT=$(( TOTAL * 9 - 10 ))
DEADLINE=$(( $(date +%s) + GROW + 600 ))
while :; do
  SEATED=$(sql "SELECT count(*) FROM \"TournamentParticipation\" WHERE status='PLAYING'")
  [ "${SEATED:-0}" -ge "$WANT" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && { say "착석 시간초과 (${SEATED:-0}/$((TOTAL*9)))"; break; }
  kill -0 $K6V 2>/dev/null || { say "끊는 쪽 k6가 먼저 끝났다"; tail -5 "$OUT-victim.txt" | tee -a "$OUT.log"; exit 1; }
  kill -0 $K6C 2>/dev/null || { say "대조군 k6가 먼저 끝났다"; tail -5 "$OUT-control.txt" | tee -a "$OUT.log"; exit 1; }
  sleep 5
done
say "착석 ${SEATED:-0}/$((TOTAL*9))"

docker update --cpus 2 $BE >/dev/null; sleep 30
docker update --cpus 1 $BE >/dev/null
say "1코어. 150초 돌린다"
sleep 150
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | tee -a "$OUT.log"

# 끊는 대회는 시드의 첫 대회다(끊는 쪽 k6가 `LOAD_STORE_OFFSET` 없이 붙는 곳).
VID=$(node -e "console.log(require('./load/.load-seed.json').tournaments[0].id)")
REPORTS=
LAST_T1=
if [ -n "${KILL:-}" ]; then
  syncing() { sql "SELECT count(*) FROM \"Tournament\" WHERE status='SYNCING'"; }
  KILLED=$(date +%s); KILLED_MS=$(ms)
  say "KILL"
  docker kill $BE >/dev/null || { say "docker kill 실패"; exit 1; }
  sleep 8
  docker start $BE >/dev/null || { say "docker start 실패"; exit 1; }
  say "START"
  # 재접속 몰림 중에 k6가 자기 상한(10코어)에 붙었는지 본다 — 붙었으면 수치는 측정기의 것이다.
  ( sleep 30; docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | sed 's/^/START+30 /' | tee -a "$OUT.log" ) &
  # 부팅이 SYNCING을 세울 때까지 먼저 기다린다 — 그 전의 ONGOING은 kill 전 값이다(T128).
  SAW=
  for i in $(seq 1 60); do [ "$(syncing)" -gt 0 ] 2>/dev/null && { SAW=1; break; }; sleep 1; done
  [ -z "$SAW" ] && { say "60초 안에 SYNCING을 못 봤다 — 부팅 복구가 안 돌았다"; docker logs --since "$SINCE" $BE >"$OUT-backend.log" 2>&1; exit 1; }
  PREV=
  for i in $(seq 1 300); do
    S=$(syncing)
    [ "$S" != "$PREV" ] && say "SYNCING ${S}개 — kill 후 $(( $(date +%s) - KILLED ))초"
    PREV=$S
    [ "$S" = 0 ] && break
    sleep 2
  done
  [ "$S" != 0 ] && { say "10분 안에 SYNCING이 안 풀렸다 — 끊김은 재지 않는다"; docker logs --since "$SINCE" $BE >"$OUT-backend.log" 2>&1; exit 1; }
  say "kill 뒤 참가자 $(sql "SELECT status, count(*) FROM \"TournamentParticipation\" GROUP BY status" | tr '\n' ' ')"
  LAST_T1=$(ms)
fi
for DOWN in $DOWNS; do
  # 표의 「직전 같은 길이」 창은 끊기 전 (DOWN + 180)초다(`outage-report.mjs`). 그 창이 앞
  # 끊김과 그 뒤 180초(앞 끊김의 표가 읽는 구간)에 걸치면 복구 중의 폴드를 「평소」로
  # 센다(T128). 앞 끊김을 이은 뒤 그만큼 지날 때까지 기다린다.
  if [ -n "$LAST_T1" ]; then
    until [ $(( ($(ms) - LAST_T1) / 1000 )) -ge $(( 360 + DOWN )) ]; do sleep 5; done
  fi
  T0=$(ms)
  docker pause $VICTIM >/dev/null
  say "끊음 (대회 $VID, ${DOWN}초)"
  sleep "$DOWN"
  T1=$(ms)
  docker unpause $VICTIM >/dev/null
  say "이음"

  # 수정 전에는 대회가 멈추지 않으므로 상태로는 끝을 알 수 없다. 재접속(딜러 최대 50초 +
  # 재시도 걸음)이 끝날 만큼 기다린 뒤, 멈춰 있으면 풀릴 때까지 더 기다린다. 표가 읽는
  # 구간(이은 뒤 180초)이 다음 끊김과 겹치지 않게 그보다 길게 둔다.
  sleep 120
  for i in $(seq 1 150); do
    [ "$(sql "SELECT status FROM \"Tournament\" WHERE id='$VID'")" = "ONGOING" ] && break
    sleep 2
  done
  say "이은 뒤 $(( ($(ms) - T1) / 1000 ))초, 대회 상태 $(sql "SELECT status FROM \"Tournament\" WHERE id='$VID'")"
  sleep 70
  REPORTS="$REPORTS $DOWN:$T0:$T1"
  LAST_T1=$T1
done

say "대회별 $(sql 'SELECT t.id, t.status, t."pausedMs", (SELECT count(*) FROM "Table" x WHERE x."tournamentId"=t.id) FROM "Tournament" t' | tr '\n' ' ')"
say "참가자 $(sql "SELECT \"tournamentId\", status, count(*) FROM \"TournamentParticipation\" GROUP BY 1,2 ORDER BY 1,2" | tr '\n' ' ')"
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | tee -a "$OUT.log"
docker logs --since "$SINCE" $BE >"$OUT-backend.log" 2>&1
docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
wait $K6V $K6C 2>/dev/null
for R in $REPORTS; do
  IFS=: read -r DOWN T0 T1 <<<"$R"
  node load/outage-report.mjs "load/results/outage-$TAG-backend.log" "$VID" "$T0" "$T1" | tee "$OUT-report-$DOWN.txt"
done
[ -n "${KILL:-}" ] && node load/kill-report.mjs "load/results/outage-$TAG-backend.log" "$KILLED_MS" | tee "$OUT-report-kill.txt"
say "완료. VID=$VID 끊김$REPORTS"
