/**
 * 실행 결과를 파일로 남긴다.
 *
 * **stdout만으로는 T41이 곡선을 못 그린다.** 램프는 단계를 여러 번 도는데,
 * 어느 단계에서 꺾였는지는 단계별 수치를 나란히 놓아야 보인다. 터미널
 * 스크롤백은 그 자리가 아니다.
 *
 * k6가 `handleSummary`의 반환값을 파일로 써 준다. 외부 라이브러리
 * (`jslib.k6.io`의 `textSummary`)를 쓰지 않는 이유는 k6 컨테이너가 실행 중에
 * 그것을 받아 와야 하기 때문이다 — 부하 실행이 인터넷에 의존하면 안 되고,
 * 어차피 우리가 보는 지표는 몇 개뿐이라 직접 뽑는 편이 짧다.
 */

/** 지표 하나에서 우리가 보는 값만 뽑는다. 없으면 `null`. */
function trend(data, name) {
  const m = data.metrics[name];
  if (!m || !m.values) return null;
  return {
    avg: round(m.values.avg),
    med: round(m.values.med),
    p90: round(m.values['p(90)']),
    p95: round(m.values['p(95)']),
    max: round(m.values.max),
    count: m.values.count,
  };
}

function counter(data, name) {
  const m = data.metrics[name];
  return m && m.values ? m.values.count : 0;
}

function gauge(data, name) {
  const m = data.metrics[name];
  return m && m.values ? round(m.values.value) : null;
}

/**
 * 서버 내부 지표는 **k6 지표에서 읽는다.**
 *
 * `teardown`에서 읽어 모듈 변수에 담아 두고 `handleSummary`에서 꺼내려 했는데
 * 비어 있었다 — k6는 그 둘 사이에 모듈 상태를 이어 주지 않는다. 모니터가
 * 어차피 `sample()`에서 Trend·Gauge로 기록하므로 그쪽을 읽는다. 덤으로 값이
 * 하나가 아니라 시계열이 되어, 요약에도 최댓값이 남는다.
 */
function server(data) {
  const lag = trend(data, 'server_lag_p95_ms');
  if (!lag) return null;
  return {
    // 바닥값은 `sample()`이 이미 뺐다. 여기 숫자는 실제 지연이다.
    lagMs: lag,
    cpuPercent: gauge(data, 'server_cpu_percent'),
    rssMb: gauge(data, 'server_rss_mb'),
    warnings: counter(data, 'lag_warnings'),
    breaches: counter(data, 'lag_breaches'),
  };
}

function round(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : null;
}

/**
 * 가입·로그인을 **기대치와 나란히** 찍는다.
 *
 * `가입 12600/로그인 14092`는 그 자체로는 아무 말도 하지 않는다. 무대의
 * 전제는 "가입은 좌석의 10%"인데, 그 전제가 깨진 실행 셋을 사람이 그냥
 * 지나쳤다(2026-08-21). 어긋났다는 사실이 **줄에 보여야** 한다.
 *
 * 기대치의 분모는 앉힌 좌석 수(`seats_taken`)다. 풀이 모자라 가입으로 넘어간
 * 좌석은 따로 세므로(`pool_misses`), 어긋남의 원인까지 줄에 남는다.
 */
function signupLine(summary) {
  const seats = summary.seatsTaken;
  if (!seats) return `가입 ${summary.signups}/로그인 ${summary.logins}`;

  const expected = Math.round(seats * summary.newUserRatio);
  // 표본이 작으면 비율은 원래 흔들린다. 두 배까지는 무대가 깨진 것이 아니다.
  const off = summary.signups > Math.max(expected * 2, expected + 5);
  const mark = off ? ' ⚠' : '';
  const why = summary.poolMisses ? ` 풀부족 ${summary.poolMisses}` : '';

  return (
    `가입 ${summary.signups}/기대 ${expected}${why}${mark}` +
    ` · 로그인 ${summary.logins}/기대 ${seats}`
  );
}

/**
 * 사람이 읽을 한 줄. 램프에서는 단계마다 이 줄이 하나씩 쌓인다.
 *
 * **`resolutionMs`를 빼서 보여주지 않는다.** 원값을 그대로 두고 바닥값을 같이
 * 적는다 — 변환을 지어내는 것보다 읽는 쪽이 알게 하는 편이 정직하다.
 */
export function oneLine(label, summary) {
  const my = summary.myAction;
  const others = summary.othersAction;
  return [
    label,
    `핸드 ${summary.hands}`,
    `내 액션 p95 ${my ? my.p95 : '-'}ms`,
    `남의 액션 p95 ${others ? others.p95 : '-'}ms`,
    `소켓오류 ${summary.socketErrors}`,
    `자리비움 ${summary.absentActions}`,
    `지각 ${summary.lateActions}`,
    `무응답창 ${summary.staleWindows}`,
    signupLine(summary),
    `레이즈 ${summary.raises}/폴드 ${summary.folds}/리바인 ${summary.rebuysAccepted}`,
    `테이블409 ${summary.tableCreateConflicts}`,
    summary.server
      ? `lag 중앙 ${summary.server.lagMs.med}ms 최대 ${summary.server.lagMs.max}ms` +
        ` · CPU ${summary.server.cpuPercent}% · rss ${summary.server.rssMb}MB` +
        ` · 경고 ${summary.server.warnings} 붕괴 ${summary.server.breaches}`
      : 'server -',
  ].join(' · ');
}

/**
 * k6의 `handleSummary`가 돌려줄 것을 만든다.
 *
 * @param name 결과 파일 이름의 앞부분 (`smoke`, `ramp-a` 등)
 */
export function buildSummary(data, name) {
  const summary = {
    name,
    at: new Date().toISOString(),
    hands: counter(data, 'hands_played'),
    socketErrors: counter(data, 'socket_errors'),
    absentActions: counter(data, 'absent_actions'),
    lateActions: counter(data, 'late_actions'),
    staleWindows: counter(data, 'stale_windows'),
    signups: counter(data, 'signups'),
    logins: counter(data, 'logins'),
    seatsTaken: counter(data, 'seats_taken'),
    poolMisses: counter(data, 'pool_misses'),
    // 기대치를 만든 값도 함께 남긴다 — 결과 파일만 보고도 무대의 전제를
    // 다시 세울 수 있어야 한다.
    newUserRatio: Number(__ENV.LOAD_NEW_USER_RATIO || 0.1),
    raises: counter(data, 'raises'),
    folds: counter(data, 'folds'),
    rebuysAccepted: counter(data, 'rebuys_accepted'),
    tableCreateConflicts: counter(data, 'table_create_conflicts'),
    tableSetupMs: trend(data, 'table_setup_ms'),
    reconnects: counter(data, 'reconnects'),
    reconnectMs: trend(data, 'reconnect_ms'),
    myAction: trend(data, 'my_action_ms'),
    othersAction: trend(data, 'others_action_ms'),
    http: trend(data, 'http_req_duration'),
    server: server(data),
    thresholds: {},
  };

  // 합격선이 깨졌는지도 파일에 남긴다. 나중에 곡선을 볼 때 "여기서 넘었다"가
  // 수치 옆에 있어야 한다.
  Object.keys(data.metrics).forEach((metric) => {
    const th = data.metrics[metric].thresholds;
    if (!th) return;
    Object.keys(th).forEach((expr) => {
      summary.thresholds[`${metric}:${expr}`] = th[expr].ok === false ? 'FAIL' : 'PASS';
    });
  });

  const stamp = summary.at.replace(/[:.]/g, '-');
  return {
    stdout: `\n${oneLine(name, summary)}\n\n`,
    [`/load/results/${name}-${stamp}.json`]: JSON.stringify(summary, null, 2),
    // 마지막 실행을 고정 이름으로도 남긴다 — 사람이 열어 볼 때 타임스탬프를
    // 찾아 들어가지 않아도 된다.
    [`/load/results/${name}-latest.json`]: JSON.stringify(summary, null, 2),
  };
}
