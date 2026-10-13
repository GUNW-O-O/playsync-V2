#!/usr/bin/env bash
# 표준 무대 — 서버 kill과 회선 끊김을 늘 같은 조건으로 잰다.
#
#   bash load/standard-run.sh <태그> [build]      (= npm run load:standard -- <태그>)
#
# 전체 1,000테이블(9,000명 · 기기 10,000대)을 한 번 앉힌다. 첫 대회가 WSOP급 556테이블
# (5,004명)이고 나머지 444테이블은 6테이블짜리 대회 74개다. 그 무대에서
#   1. 백엔드를 kill → 8초 뒤 start, 대회 75개의 `SYNCING`이 다 풀릴 때까지
#   2. 첫 대회의 회선만 20초 끊고, 간격 뒤 90초 끊는다(나머지 74개가 대조군)
# 착석은 bcrypt 4 · 초당 8명 · 6코어로 빠르게 하고 측정은 1코어로 한다(outage-run.sh).
#
# 값을 바꾸지 않는다 — 바꾸면 지난 실행과 비교가 안 된다. 다른 모양은 outage-run.sh ·
# kill-run.sh를 직접 부른다. 표는 `load/results/outage-<태그>-report-{kill,20,90}.txt`.
set -u
export KILL=1 CONTROL=444 CONTROL_PER_STORE=6 RATE=8
exec bash "$(dirname "$0")/outage-run.sh" 556 "20 90" "${1:?태그를 준다}" "${2:-}"
