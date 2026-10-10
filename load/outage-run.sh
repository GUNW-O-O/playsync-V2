#!/usr/bin/env bash
# 대회 하나의 회선만 끊는 측정(T121).
#
# 대회 넷을 세운다 — 첫 대회에 N테이블, 나머지 셋에 10테이블씩(대조군). 첫 대회의 봇만
# 맡은 k6 컨테이너를 `docker pause`로 얼렸다 푼다. 프로세스만 얼어 종료 신호 없이 응답만
# 사라지므로, 서버가 보는 모습이 회선이 말없이 끊긴 것과 같다. 봇이 소켓을 직접 닫으면
# 서버가 그 자리에서 알아채 감지 지연을 못 잰다.
#
#   bash load/outage-run.sh <끊는 대회의 테이블 수> "<끊는 초들>" <태그> [build]
#
# 끊는 초를 여럿 주면(예: "20 90") 한 번 앉힌 무대에서 차례로 끊는다 — 착석을 다시 하지 않는다.
#
# 결과는 `load/results/outage-<태그>*`. 표는 `outage-report.mjs`가 백엔드 로그의
# `[event]` 줄로 만든다. 환경변수 RATE(초당 착석 인원, 기본 8)는 kill-run.sh와 같다.
set -u
N=$1; DOWNS=$2; TAG=$3; BUILD=${4:-}
CONTROL=30
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

say "정리"
docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
if [ -n "$BUILD" ]; then
  say "빌드"
  $C --profile load up -d --build >>"$OUT.log" 2>&1
else
  $C --profile load up -d >>"$OUT.log" 2>&1
fi

TOTAL=$(( N + CONTROL ))
say "마이그레이션 + 시드 (대회 4, $TOTAL 테이블)"
export DATABASE_URL="postgresql://test:test@127.0.0.1:5433/playsync_test" REDIS_HOST=127.0.0.1 REDIS_PORT=6380 REDIS_PASSWORD=test
(cd backend && npx prisma migrate deploy) >>"$OUT.log" 2>&1
LOAD_STORES=4 LOAD_MAX_TABLES=$TOTAL npm run seed:load >>"$OUT.log" 2>&1 || { say "시드 실패"; exit 1; }

say "백엔드 재시작 (6코어로 착석)"
docker restart $BE >/dev/null
docker update --cpus 6 $BE >/dev/null
until curl -sf http://127.0.0.1:3001/internal/metrics >/dev/null; do sleep 1; done

GROW=$(( N * 9 / ${RATE:-8} + 30 ))
# 자리 비움과 지각을 끈다 — 켜 두면 평소의 시간 초과 폴드가 끊김이 만든 것과 섞인다.
COMMON="-e LOAD_STEADY_S=2400 -e LOAD_BREACH_STREAK=100000 -e LOAD_ABSENT_RATIO=0 -e LOAD_LATE_RATIO=0"
say "k6 둘 시작 (증설 ${GROW}초)"
$C --profile load --profile k6 run --rm --name $VICTIM $COMMON \
  -e LOAD_START_TABLES=$N -e LOAD_STEP_TABLES=$N -e LOAD_MAX_TABLES=$N \
  -e LOAD_START_GROW_S=$GROW -e LOAD_GROW_S=$GROW -e LOAD_RAMP_NAME=outage-$TAG-victim \
  k6 run /load/scenarios/ramp.js >"$OUT-victim.txt" 2>&1 &
K6V=$!
$C --profile load --profile k6 run --rm --name playsync-k6-control $COMMON \
  -e LOAD_START_TABLES=$CONTROL -e LOAD_STEP_TABLES=$CONTROL -e LOAD_MAX_TABLES=$CONTROL \
  -e LOAD_TABLES_PER_STORE=10 -e LOAD_STORE_OFFSET=1 -e LOAD_TABLE_OFFSET=$N \
  -e LOAD_START_GROW_S=60 -e LOAD_GROW_S=60 -e LOAD_RAMP_NAME=outage-$TAG-control \
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
for DOWN in $DOWNS; do
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
say "완료. VID=$VID 끊김$REPORTS"
