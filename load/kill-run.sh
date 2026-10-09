#!/usr/bin/env bash
# 백엔드를 죽였다 살리는 재접속 측정(T116 · T119).
#
# 램프 B(대회 하나)로 N테이블을 앉히고, 판이 도는 중에 `docker kill` → 8초 뒤
# `docker start` 한다. `SYNCING`이 풀릴 때까지의 시간과 커널의 접속 대기열 넘침을
# 찍고, 백엔드 로그(`[stage]` 구간 계측 포함)를 `load/results/`에 남긴다.
#
#   bash load/kill-run.sh <테이블 수> <태그> [build]
#
# 환경변수: RATE(초당 착석 인원, 기본 8) · LOAD_LISTEN_SOCKETS · LOAD_PG_POOL_MAX ·
# LOAD_CPU_PROFILE_S(부팅 뒤 이 초만큼 CPU 프로파일) · K6_ENV(봇에 넘길 `-e 이름=값`).
# 설명은 load/README.md.
set -u
N=$1; TAG=$2; BUILD=${3:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/load/results/kill-$TAG
cd "$ROOT"
export MSYS_NO_PATHCONV=1 BCRYPT_ROUNDS=4
C="docker compose -f backend/docker-compose.test.yml"
BE=playsync-backend-load
sql() { docker exec playsync-db-test psql -U test -d playsync_test -tAc "$1" 2>/dev/null; }
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT.log"; }
: > "$OUT.log"
# 컨테이너를 다시 짓지 않으면 `docker logs`에 앞 실행이 쌓여 있다 — 이번 것만 남긴다.
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

say "정리"
docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
if [ -n "$BUILD" ]; then
  say "빌드"
  $C --profile load up -d --build >>"$OUT.log" 2>&1
else
  $C --profile load up -d >>"$OUT.log" 2>&1
fi

say "마이그레이션 + 시드 ($N 테이블)"
export DATABASE_URL="postgresql://test:test@127.0.0.1:5433/playsync_test" REDIS_HOST=127.0.0.1 REDIS_PORT=6380 REDIS_PASSWORD=test
(cd backend && npx prisma migrate deploy) >>"$OUT.log" 2>&1
LOAD_STORES=1 LOAD_MAX_TABLES=$N npm run seed:load >>"$OUT.log" 2>&1 || { say "시드 실패"; exit 1; }

say "백엔드 재시작 (6코어로 착석)"
docker restart $BE >/dev/null
docker update --cpus 6 $BE >/dev/null
until curl -sf http://127.0.0.1:3001/internal/metrics >/dev/null; do sleep 1; done

GROW=$(( N * 9 / ${RATE:-8} + 30 ))
say "k6 시작 (증설 ${GROW}초)"
$C --profile load --profile k6 run --rm \
  -e LOAD_START_TABLES=$N -e LOAD_STEP_TABLES=$N -e LOAD_MAX_TABLES=$N \
  -e LOAD_START_GROW_S=$GROW -e LOAD_GROW_S=$GROW -e LOAD_STEADY_S=2400 \
  -e LOAD_BREACH_STREAK=100000 -e LOAD_RAMP_NAME=kill-$TAG ${K6_ENV:-} \
  k6 run /load/scenarios/ramp.js >"$OUT-console.txt" 2>&1 &
K6=$!

WANT=$(( N * 9 - 10 ))
DEADLINE=$(( $(date +%s) + GROW + 600 ))
while :; do
  SEATED=$(sql "SELECT count(*) FROM \"TournamentParticipation\" WHERE status='PLAYING'")
  [ "${SEATED:-0}" -ge "$WANT" ] && break
  [ "$(date +%s)" -gt "$DEADLINE" ] && { say "착석 시간초과 (${SEATED:-0}/$((N*9)))"; break; }
  kill -0 $K6 2>/dev/null || { say "k6가 먼저 끝났다"; tail -5 "$OUT-console.txt" | tee -a "$OUT.log"; exit 1; }
  sleep 5
done
say "착석 ${SEATED:-0}/$((N*9))"
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | tee -a "$OUT.log"

docker update --cpus 2 $BE >/dev/null; sleep 30
docker update --cpus 1 $BE >/dev/null
say "1코어. 판을 150초 돌린다"
sleep 150
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | tee -a "$OUT.log"
say "kill 전 대회 상태 $(sql 'SELECT status, "activePlayers" FROM "Tournament"')"

KILL=$(date +%s)
say "KILL"
docker kill $BE >/dev/null
sleep 8
docker start $BE >/dev/null
say "START"
( sleep 45; say "부팅 직후 TCP 대기열 $(docker exec $BE sh -c "awk '/^TcpExt/{if(!h){split(\$0,k);h=1}else{for(i=2;i<=NF;i++)if(k[i]~/ListenOverflows|ListenDrops|TCPReqQFull|SyncookiesSent|TCPBacklogDrop/)printf \"%s=%s \",k[i],\$i}}' /proc/net/netstat")" ) &

CLEARED=
# 부팅이 SYNCING을 세울 때까지 먼저 기다린다 — 그 전의 ONGOING은 kill 전 값이다.
for i in $(seq 1 60); do
  [ "$(sql 'SELECT status FROM "Tournament" LIMIT 1')" = "SYNCING" ] && break
  sleep 1
done
say "SYNCING 확인 — kill 후 $(( $(date +%s) - KILL ))초"
for i in $(seq 1 300); do
  sleep 2
  ST=$(sql 'SELECT status FROM "Tournament" LIMIT 1')
  if [ "$ST" = "ONGOING" ]; then
    CLEARED=$(( $(date +%s) - KILL ))
    say "SYNCING 해제 — kill 후 ${CLEARED}초"
    break
  fi
done
[ -z "$CLEARED" ] && say "10분 안에 SYNCING이 안 풀렸다 (상태 $ST)"

say "TCP 대기열 $(docker exec $BE sh -c "awk '/^TcpExt/{if(!h){split(\$0,k);h=1}else{for(i=2;i<=NF;i++)if(k[i]~/ListenOverflows|ListenDrops|TCPReqQFull|SyncookiesSent|TCPBacklogDrop/)printf \"%s=%s \",k[i],\$i}}' /proc/net/netstat")"
say "해제 뒤 90초 더 본다"
sleep 90
say "끝난 뒤 참가자 $(sql "SELECT status, count(*) FROM \"TournamentParticipation\" GROUP BY status" | tr '\n' ' ')"
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | tee -a "$OUT.log"
docker logs --since "$SINCE" $BE >"$OUT-backend.log" 2>&1
docker cp $BE:/tmp/boot.cpuprofile "$(cygpath -w "$OUT.cpuprofile")" >/dev/null 2>&1
docker rm -f $(docker ps -aq --filter name=k6) >/dev/null 2>&1
wait $K6 2>/dev/null
say "완료. KILL=$KILL"
