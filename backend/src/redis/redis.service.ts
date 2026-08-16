import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { BlindField, Dashboard, FullTournamentInfo } from "shared/types/tournamentMeta";
import { calculatePrizes, PrizePayout } from "src/playsync/prize";
import { UserInfo } from "shared/types/userInfo";
import { getCurrentBlindLevel } from "shared/util/util";
import { TableState } from "src/game-engine/types";
import { isRegistrationOpenAtLevel } from "src/store/session/registration";

@Injectable()
export class RedisService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

  private getInfoKey(id: string) {
    return `tournament:${id}:info`;
  }

  /**
   * 테이블 락. **스냅샷을 고치는 데는 직접 쓰지 않는다** — 그건
   * `mutateSnapshot`의 일이다(T42). 스냅샷 밖의 것을 테이블 단위로
   * 직렬화해야 할 때만 이 락을 직접 잡는다.
   *
   * 스냅샷은 JSON 통째로 덮어쓰므로, 읽기 → 수정 → 쓰기가 겹치면 나중에 쓴
   * 쪽이 앞선 쓰기를 통째로 지운다. 진 쪽이 이미 실행한
   * 큐 조작·DB 쓰기·WS 브로드캐스트는 되돌아가지 않으므로, Redis 상태만
   * 과거로 돌아가고 나머지 세계는 그대로 남는다.
   *
   * 락은 테이블 단위다. 다른 테이블끼리는 그대로 병렬로 돈다.
   */
  async withTableLock<T>(
    tableId: string,
    fn: () => Promise<T>,
    ttlMs = 5000,
    maxWaitMs = 5000,
  ): Promise<T> {
    const lockKey = `lock:table:state:${tableId}`;
    // 해제할 때 "내가 잡은 락인지" 확인하려면 소유자를 구분할 값이 필요하다.
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const retryIntervalMs = 50;
    const deadline = Date.now() + maxWaitMs;

    do {
      const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') {
        try {
          return await fn();
        } finally {
          await this.releaseTableLock(lockKey, token);
        }
      }
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    } while (Date.now() < deadline);

    throw new Error(`테이블 ${tableId} 락 획득 실패`);
  }

  /**
   * 내 토큰일 때만 해제한다.
   *
   * 그냥 del을 부르면, TTL이 먼저 만료돼 다른 요청이 잡은 락을 지우게 된다.
   * 그 순간 두 요청이 임계 구역에 동시에 들어가고 아무도 눈치채지 못한다.
   * 확인과 삭제가 한 번에 일어나야 하므로 Lua로 보낸다.
   */
  private async releaseTableLock(lockKey: string, token: string) {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await this.redis.eval(script, 1, lockKey, token);
  }
  /** 한 테이블의 좌석 수. 비트맵 길이가 곧 이 값이다. */
  private static readonly SEAT_COUNT = 9;

  /**
   * 좌석 한 칸만 원자적으로 바꾸고 바뀐 비트맵을 돌려준다.
   *
   * 게임 상태와 달리 좌석 비트는 서로 독립적이다. 필드 간 일관성을 지킬 게
   * 없으므로 락(`withTableLock`)이 아니라 원자 연산이 맞다. 다만 비트맵이
   * 해시 **필드**라 `SETRANGE`를 쓸 수 없어서(Redis에 `HSETRANGE`는 없다)
   * 같은 일을 Lua로 한다. 키를 테이블별로 쪼개면 `SETRANGE`를 쓸 수 있지만,
   * 그러면 좌석 현황 조회의 `hgetall` 한 번이 여러 번으로 늘어난다.
   *
   * **필드가 없으면 아무것도 하지 않는다.** 만드는 것은 `setSeatBitmap`의
   * 일이다. 예전에는 없으면 9칸짜리 빈 비트맵을 만들어 놓고 비트를 세웠는데,
   * 그 한 줄이 지워진 테이블을 되살렸다 — 마지막 참가자가 탈락해 커밋된 뒤
   * 상점이 그 테이블을 닫으면, `eliminatePlayer`가 커밋 **이후에** 부르는
   * 비트 내리기가 방금 지운 필드를 전부 0인 채로 다시 써 넣는다. 좌석 목록에는
   * DB에 없는 9칸짜리 빈 테이블이 24시간 떠 있고, 그 자리를 고른 참가자는
   * `tablePlayer.create`의 외래키 실패로 이유 없는 500을 본다.
   *
   * Redis가 통째로 비었을 때의 복구도 이 자리가 아니다. 빈 비트맵을 만들고
   * 한 칸만 세우면 이미 앉아 있던 사람들이 화면에서 사라진다 — 설계 문서가
   * "반쪽 복구가 더 위험하다"고 적고 B2로 미룬 그것이다.
   */
  private static readonly UPDATE_SEAT_BIT = `
    local bitmap = redis.call('hget', KEYS[1], ARGV[1])
    if not bitmap then return false end
    local idx = tonumber(ARGV[2])
    if idx < 0 or idx >= #bitmap then
      return redis.error_reply('seat index out of range')
    end
    local updated = string.sub(bitmap, 1, idx) .. ARGV[3] .. string.sub(bitmap, idx + 2)
    redis.call('hset', KEYS[1], ARGV[1], updated)
    redis.call('expire', KEYS[1], 86400)
    return updated
  `;

  /**
   * 좌석 여러 칸을 한 번에 원자적으로 바꾼다.
   *
   * 한 테이블의 좌석 비트는 전부 같은 해시 필드(`tournament:{id}:seat`의
   * `table:{tableId}`)에 들어 있다. `releaseSeats`처럼 한 요청이 좌석
   * 여러 개를 동시에 내리는 경우, `UPDATE_SEAT_BIT`를 좌석 수만큼 반복
   * 호출하면 그 사이 Redis 장애가 끼어들 때 일부만 성공한다 — 좌석 3·5를
   * 같이 해제했는데 3의 비트만 내려가고 5는 영원히 1로 남으면, DB에서는
   * `TablePlayer` 행이 이미 사라졌는데 좌석 목록은 5번을 계속 "찬 자리"로
   * 보여준다. 아무도 그 자리에 못 앉고 24시간 TTL까지 기다려야 한다 —
   * "전부 되거나 전부 안 된다"를 어기는 부분 성공이다. 이 스크립트는 여러
   * 인덱스를 한 Lua 실행 안에서 고쳐 그 창을 없앤다.
   *
   * `UPDATE_SEAT_BIT`와 같은 이유로 **필드가 없으면 아무것도 하지 않고
   * `false`를 돌려준다** — 만드는 것은 `setSeatBitmap`의 일이다. 여기서
   * 없는 필드에 뭔가 쓰면 지워진 테이블을 되살리는 것과 같은 사고가 난다
   * (`UPDATE_SEAT_BIT` 주석 참고). 범위 검사와 TTL 갱신(`expire`)도 그대로
   * 가져온다.
   */
  private static readonly UPDATE_SEAT_BITS_MANY = `
    local bitmap = redis.call('hget', KEYS[1], ARGV[1])
    if not bitmap then return false end
    local value = ARGV[#ARGV]
    for i = 2, #ARGV - 1 do
      local idx = tonumber(ARGV[i])
      if idx < 0 or idx >= #bitmap then
        return redis.error_reply('seat index out of range')
      end
      bitmap = string.sub(bitmap, 1, idx) .. value .. string.sub(bitmap, idx + 2)
    end
    redis.call('hset', KEYS[1], ARGV[1], bitmap)
    redis.call('expire', KEYS[1], 86400)
    return bitmap
  `;

  // 테이블 초기생성
  async setSeatBitmap(tournamentId: string, tableId: string) {
    const key = `tournament:${tournamentId}:seat`;
    const field = `table:${tableId}`;

    const bitmap = '0'.repeat(RedisService.SEAT_COUNT);

    await this.redis.hset(key, field, bitmap);
    await this.redis.expire(key, 86400);
  }

  /**
   * 좌석 비트맵에서 테이블 하나를 지운다.
   *
   * 대회 종료는 `tournament:*:seat` 키를 통째로 지우지만, 테이블 삭제는
   * 필드 하나만 없애야 한다.
   */
  async removeSeatBitmap(tournamentId: string, tableId: string) {
    const key = `tournament:${tournamentId}:seat`;
    await this.redis.hdel(key, `table:${tableId}`);
  }

  /**
   * 테이블 하나의 게임 상태 스냅샷을 지운다.
   *
   * 대회 종료는 `deleteTournament`가 테이블 목록을 받아 한꺼번에 지우지만,
   * 테이블 하나만 닫는 경로에는 대응하는 것이 없었다. 남겨두면 24시간짜리
   * 스냅샷이 떠 있고, `completeSession`이 지울 목록에는 이미 그 테이블이
   * 없으므로 아무도 치우지 않는다.
   */
  async deleteTableState(tableId: string) {
    await this.redis.del(`table:state:${tableId}`);
  }

  /** 비트맵이 없으면 `null`. 없는 테이블을 만들어 주지는 않는다(위 주석 참고). */
  async updateSeatBitmap(
    tournamentId: string,
    tableId: string,
    seatIndex: number,
    isOccupied: boolean,
  ): Promise<string | null> {
    const key = `tournament:${tournamentId}:seat`;
    const field = `table:${tableId}`;

    return (await this.redis.eval(
      RedisService.UPDATE_SEAT_BIT,
      1,
      key,
      field,
      seatIndex,
      isOccupied ? '1' : '0',
    )) as string | null;
  }

  /**
   * 좌석 여러 칸을 한 번에 같은 값으로 바꾼다. 위 `UPDATE_SEAT_BITS_MANY`
   * 참고 — 반복 호출 대신 이 메서드를 쓰면 중간에 장애가 껴도 부분 성공이
   * 나지 않는다. 비트맵이 없으면(테이블이 이미 지워졌으면) `null`.
   */
  async updateSeatBitmapMany(
    tournamentId: string,
    tableId: string,
    seatIndexes: number[],
    isOccupied: boolean,
  ): Promise<string | null> {
    const key = `tournament:${tournamentId}:seat`;
    const field = `table:${tableId}`;

    return (await this.redis.eval(
      RedisService.UPDATE_SEAT_BITS_MANY,
      1,
      key,
      field,
      ...seatIndexes.map(String),
      isOccupied ? '1' : '0',
    )) as string | null;
  }

  /**
   * 좌석 비트맵을 통째로 새로 쓴다. **재구성 전용이다.**
   *
   * `updateSeatBitmapMany`를 쓸 수 없다 — 그쪽 Lua는 필드가 없으면 아무것도
   * 만들지 않고 null을 돌려준다. 지워진 테이블을 되살리지 않기 위한 규칙이고,
   * 예전에 그것이 없어서 설명되지 않는 500이 났다. 재구성은 정확히 그 반대
   * 방향(없는 필드를 만드는 것)이라 경로를 가른다.
   */
  async rebuildSeatBitmap(tournamentId: string, tableId: string, seatIndexes: number[]) {
    const key = `tournament:${tournamentId}:seat`;
    const bitmap = Array(RedisService.SEAT_COUNT).fill('0');
    for (const i of seatIndexes) bitmap[i] = '1';
    await this.redis.hset(key, `table:${tableId}`, bitmap.join(''));
    // 이 키를 쓰는 나머지 전부(setSeatBitmap, UPDATE_SEAT_BIT,
    // UPDATE_SEAT_BITS_MANY, setUserContext)가 24시간 TTL을 유지한다. 여기서
    // 빠뜨리면 Redis를 통째로 잃은 뒤 재구성이 만드는 키만 영구 키가 되고,
    // 유령 테이블을 청소하는 그 장치(UPDATE_SEAT_BIT 주석 참고)에서 이
    // 필드만 빠진다.
    await this.redis.expire(key, 86400);
  }

  async getTournamentTables(tournamentId: string) {
    const key = `tournament:${tournamentId}:seat`;
    const raw = await this.redis.hgetall(key);
    // 필드에서 table: 제외후 테이블아이디와 비트맵 boolean배열만들어 리턴
    return Object.entries(raw).map(([field, bitmap]) => {
      const tableId = field.replace('table:', '');
      const seatStatus = bitmap.split('').map((bit) => bit === '1');
      return { tableId, seatStatus };
    });
  }

  async getTableSeatStatus(tournamentId: string, tableId: string) {
    const key = `tournament:${tournamentId}:seat`;
    const bitmap = await this.redis.hget(key, `table:${tableId}`);
    return bitmap ? bitmap.split('').map((bit) => bit === '1') : [];
  }
  // 초기 생성 대회정보
  async setTournamentMeta(id: string, dashboard: Dashboard, blindField: BlindField) {
    const key = this.getInfoKey(id);
    await this.redis.hset(
      key,
      // Dashboard 필드 평탄화
      'tournamentName', dashboard.tournamentName,
      'entryFee', dashboard.entryFee,
      'startStack', dashboard.startStack,
      'isRegistrationOpen', dashboard.isRegistrationOpen ? 1 : 0,
      'totalPlayer', dashboard.totalPlayer,
      'activePlayer', dashboard.activePlayer,
      'totalBuyinAmount', dashboard.totalBuyinAmount,
      'rebuyUntil', dashboard.rebuyUntil,
      'avgStack', dashboard.avgStack,
      'itmCount', dashboard.itmCount,
      // 비율만 저장한다. 금액은 totalBuyinAmount에서 매번 파생시킨다 — 금액을
      // 저장하면 리바인마다 두 값을 같이 갱신해야 하고, 하나만 갱신되는 순간
      // 전광판이 틀어진다.
      'prizePayouts', JSON.stringify(
        dashboard.prizes.map(({ place, percent }) => ({ place, percent })),
      ),
      // BlindField는 객체로 유지
      'blindField', JSON.stringify(blindField)
    );
    await this.redis.expire(key, 86400); // 24시간 TTL
  }

  // 두 필드를 한 번에 요청
  async getFullTournamentInfo(id: string): Promise<FullTournamentInfo | null> {
    const key = this.getInfoKey(id);
    const raw = await this.redis.hgetall(key);
    const blindField = await this.checkAndSyncBlindLevel(id);

    if (!raw || Object.keys(raw).length === 0) return null;
    if (!blindField) return null;

    const pool = parseInt(raw.totalBuyinAmount || '0');
    const payouts: PrizePayout[] = raw.prizePayouts ? JSON.parse(raw.prizePayouts) : [];
    const amounts = payouts.length > 0
      ? calculatePrizes(pool, payouts)
      : new Map<number, number>();

    // **해시 필드를 그대로 믿지 않는다.** 위 `hgetall`은 `checkAndSyncBlindLevel`
    // **앞**에서 찍은 사진이라, 레벨이 막 넘어간 그 호출에서는 동기화가 방금
    // 내린 마감을 담고 있지 않다. 결제와 리바인이 이 값을 보므로 그 한 박자에
    // 정확히 한 명이 더 통과한다. 동기화된 레벨로 판정을 다시 세운다 — 규칙
    // 자체는 `registration.ts` 하나뿐이다.
    //
    // 첫 인자로 해시 값을 그대로 넣는 것이 맞다. 그 값은 이미 "상점이 연
    // 상태 && 그때까지의 레벨"이 합쳐진 것이고, 마감은 단조라 한 번 '0'이면
    // 다시 열리지 않는다.
    const curLv =
      blindField.blindStructure[blindField.currentBlindLv]?.lv ?? 0;
    const rebuyUntil = parseInt(raw.rebuyUntil || '0');

    return {
      dashboard: {
        prizePool: pool,
        prizes: payouts.map(p => ({ ...p, amount: amounts.get(p.place) ?? 0 })),
        isRegistrationOpen: isRegistrationOpenAtLevel(
          raw.isRegistrationOpen === '1',
          curLv,
          rebuyUntil,
        ),
        totalPlayer: parseInt(raw.totalPlayer || '0'),
        activePlayer: parseInt(raw.activePlayer || '0'),
        totalBuyinAmount: parseInt(raw.totalBuyinAmount || '0'),
        rebuyUntil: parseInt(raw.rebuyUntil || '0'),
        avgStack: parseInt(raw.avgStack || '0'),
        tournamentName: raw.tournamentName || '',
        entryFee: parseInt(raw.entryFee || '0'),
        startStack: parseInt(raw.startStack || '0'),
        itmCount: parseInt(raw.itmCount || '0'),
      },
      blindField: blindField,
    };
  }

  private async recalculateAvgStack(tournamentId: string, startStack: number, entryFee: number) {
    const key = this.getInfoKey(tournamentId);
    const [totalBuyin, active] = await this.redis.hmget(key, 'totalBuyinAmount', 'activePlayer');

    const totalChips = (parseInt(totalBuyin || '0') / entryFee) * startStack;
    const activeNum = parseInt(active || '1');

    const newAvg = activeNum > 0 ? Math.floor(totalChips / activeNum) : 0;
    await this.redis.hset(key, 'avgStack', newAvg);
  }

  async getTournamentDashboard(id: string): Promise<Dashboard | null> {
    const info = await this.getFullTournamentInfo(id);
    return info ? info.dashboard : null;
  }

  // 대시보드는 해시에 평탄화해서 저장한다(setTournamentMeta). 개별 필드를
  // hincrby로 원자적으로 증감할 수 있고, 읽을 때는 hgetall 한 번으로 끝난다.
  // JSON 한 덩어리로 두면 증감마다 읽고-고치고-쓰기가 되어 레이스가 생긴다.
  //
  // setTournamentDashboard는 이 규약을 어기는 유일한 세터였다 — 'dashboard'
  // 필드에 JSON을 통째로 넣어서 hincrby도 못 하고 getFullTournamentInfo도
  // 읽지 못했다. 프로덕션 호출자는 없었고 테스트만 쓰고 있었으므로 제거했다.

  async eliminatedPlayer(tournamentId: string, startStack: number, entryFee: number, playerCount: number) {
    const key = this.getInfoKey(tournamentId);
    const activePlayer = await this.redis.hincrby(key, 'activePlayer', -playerCount);
    await this.recalculateAvgStack(tournamentId, startStack, entryFee);
    return activePlayer;
  }

  async rebuyPlayer(tournamentId: string, entryFee: number, startStack: number) {
    const key = this.getInfoKey(tournamentId);
    await this.redis.hincrby(key, 'totalBuyinAmount', entryFee);

    await this.recalculateAvgStack(tournamentId, startStack, entryFee);
  }

  async joinPlayer(tournamentId: string, entryFee: number) {
    const key = this.getInfoKey(tournamentId);
    await this.redis.pipeline()
      .hincrby(key, 'totalPlayer', 1)
      .hincrby(key, 'activePlayer', 1)
      .hincrby(key, 'totalBuyinAmount', entryFee)
      .exec();
  }

  async getTournamentBlind(id: string): Promise<BlindField | null> {
    const data = await this.redis.hget(`tournament:${id}:info`, 'blindField');
    return data ? JSON.parse(data) : null;
  }

  async setTournamentBlind(id: string, blindField: BlindField) {
    const key = `tournament:${id}:info`;
    await this.redis.hset(key, 'blindField', JSON.stringify(blindField));
    // 같은 키(`tournament:{id}:info`)의 `setTournamentMeta`(`:278`)는
    // `expire`를 부르는데 이쪽엔 없었다. `hset`은 기존 TTL을 리셋하지
    // 않으므로, 빠뜨리면 이 키는 대회 시작 후 정확히 24시간에 죽는다 —
    // `RecoveryService`의 기준점 밀기가 이 세터의 새 호출자다.
    await this.redis.expire(key, 86400);
  }

  /**
 * 토너먼트의 현재 블라인드 상태를 확인하고, 시간이 경과했다면 자동으로 업데이트합니다.
 * @returns 최신 블라인드 정보 (업데이트된 경우 반영됨)
 *
 * `force`는 **기준점(`startedAt`)이 밖에서 바뀐 뒤** 쓴다(부팅 복구). 아래
 * 두 게이트가 모두 "기준점은 그대로"를 전제로 하고 있어서, 기준점이 움직인
 * 직후에는 둘 다 잘못된 답을 낸다.
 *
 * 1. 캐시 조기 반환은 `nextLevelAt`을 믿는데, 그 값이 낡은 기준점에서 나온
 *    것이면 아직 미래여도 의미가 없다.
 * 2. 쓰기 게이트는 레벨과 `isBreak`만 본다. 기준점이 밀렸는데 레벨이 그대로면
 *    `nextLevelAt`이 낡은 채로 남아 전광판 카운트다운만 어긋난다.
 *
 * 파생값(`currentBlindLv`·`nextLevelAt`·`isBreak`)을 다시 만드는 식과 등록
 * 마감 판정을 **이 함수 하나에만** 두려고 인자로 뚫었다. 복구가 같은 계산을
 * 복제하면 마감 내리기가 거기서 빠진다.
 */
  async checkAndSyncBlindLevel(
    tournamentId: string,
    options?: { force?: boolean },
  ): Promise<BlindField | null> {
    const blind = await this.getTournamentBlind(tournamentId);
    if (!blind) return null;

    const force = options?.force ?? false;
    const now = Date.now();
    // 최적화: 아직 다음 레벨 시간이 되지 않았다면 현재 상태 그대로 반환
    // (이미 휴식 중이라면 blind.isBreak가 true인 상태로 반환됨)
    if (!force && blind.nextLevelAt && now < blind.nextLevelAt) {
      return { ...blind, serverTime: now };
    }
    // 시간 경과 시에만 상세 계산 수행
    const calculated = getCurrentBlindLevel(blind.blindStructure, blind.startedAt);
    // 레벨 인덱스가 바뀌었거나, 휴식 상태(isBreak)가 변경되었을 때만 업데이트
    if (
      force ||
      calculated.currentIndex !== blind.currentBlindLv ||
      calculated.isBreak !== blind.isBreak
    ) {
      const updatedBlind = {
        ...blind,
        currentBlindLv: calculated.currentIndex,
        nextLevelAt: calculated.nextLevelAt,
        isBreak: calculated.isBreak, // lv 99,
        serverTime: now,
      };
      await this.setTournamentBlind(tournamentId, updatedBlind);
      const curLv = updatedBlind.blindStructure[updatedBlind.currentBlindLv].lv;
      const regiCloseAt = await this.redis.hget(`tournament:${tournamentId}:info`, 'rebuyUntil');
      // 레벨은 startedAt과 현재 시각으로 매번 다시 계산되므로 한 번에 여러 칸
      // 뛸 수 있다(서버 재기동, 폴링 지연). 정확 일치로 보면 마감 레벨을 밟지
      // 못하고 지나간 토너먼트는 등록이 영영 열린 채로 남는다.
      if (regiCloseAt && curLv >= parseInt(regiCloseAt)) {
        await this.redis.hset(`tournament:${tournamentId}:info`, 'isRegistrationOpen', '0');
      }
      return updatedBlind;
    }
    return blind;
  }

  // 초기 생성 파이프라인
  async saveInitialTableSnapshots(tableStates: { tableId: string; state: TableState }[]) {
    const pipeline = this.redis.pipeline();

    tableStates.forEach(({ tableId, state }) => {
      const key = `table:state:${tableId}`;
      pipeline.set(key, JSON.stringify(state));
    });

    // `exec()`은 명령이 실패해도 던지지 않는다. 실패는 결과 배열의 각 원소
    // `[err, response]`에 담겨 돌아오므로, 결과를 안 보면 모든 실패가 성공처럼
    // 보인다 — T9의 `$transaction` 삼항과 같은 유형이다. 예전에는 이 처리가
    // "선택 사항"이라는 주석과 함께 통째로 주석 처리돼 있었다.
    //
    // 여기는 토너먼트 시작 경로다. 조용히 넘어가면 그 테이블은 스냅샷 없이
    // 시작하고, 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를 이유도
    // 모른 채 본다. 시작이 실패한 것은 시작한 사람이 그 자리에서 알아야 한다.
    const results = await pipeline.exec();
    const failed = (results ?? [])
      .map(([err], index) => (err ? tableStates[index].tableId : null))
      .filter((tableId): tableId is string => tableId !== null);

    if (failed.length > 0) {
      throw new Error(`테이블 상태 저장에 실패했습니다: ${failed.join(', ')}`);
    }
  }

  /**
   * 스냅샷을 고치는 **유일한** 길.
   *
   * 락·읽기·쓰기를 이 메서드가 소유한다. 예전에는 열네 곳이 각자
   * `withTableLock` → `getSnapShot` → 고치기 → `saveSnapShot`을 손으로
   * 반복했고, 그래서 정합성이 **구조가 아니라 관행** 위에 서 있었다 — 어느
   * 한 곳이 락 밖에서 읽은 값으로 쓰면 나중에 쓴 쪽이 앞선 쓰기를 통째로
   * 지운다(진 쪽이 이미 실행한 큐 조작·DB 쓰기·브로드캐스트는 되돌아가지
   * 않으므로 Redis만 과거로 돌아간다). T37이 그 관행의 대가를 실측했다:
   * `enterSeat`의 락 안 재읽기를 지워도 빨개지는 테스트가 하나도 없었다.
   *
   * 여기로 옮기면 호출자에게 **지울 수 있는 줄 자체가 없다.** 낡은 스냅으로
   * 쓰려면 `fn`의 인자를 무시하고 바깥 변수를 끌어와야 하고, 그건 리뷰에서
   * 보인다.
   *
   * 규약 셋.
   * - `fn`은 스냅샷이 없으면 `null`을 받는다. 만들어 돌려주면 그것이 저장된다
   *   (착석이 유실 뒤 새로 세우는 경로).
   * - `fn`이 `null`을 돌려주면 **쓰지 않는다.** 낡은 `TIME_OUT`처럼 상태를
   *   건드리지 않고 나가는 자리가 있고, 그 옵트아웃을 반환 타입으로 강제한다
   *   — `return`을 빠뜨리면 컴파일이 막힌다.
   * - 반환값은 **저장한 상태**, 쓰지 않았으면 **읽은 상태**다. 쓰지 않고
   *   나가는 호출자도 브로드캐스트할 상태는 받아야 한다.
   *
   * 상태가 아닌 값(예: 파산자 id 목록)이 필요한 호출자는 반환된 상태에서
   * 락 **밖에서** 파생시킨다. 다시 읽는 것이 아니라 방금 저장한 그 객체를
   * 순회하는 순수 계산이라 새 레이스가 아니다.
   */
  // 오버로드 둘. `fn`이 **항상** 상태를 돌려주는 자리(스냅샷이 없으면 던지거나
  // 새로 만드는 경로)는 반환도 절대 null이 아니므로, 호출부마다 `!`를 붙이지
  // 않아도 되게 타입으로 가른다. 옵트아웃(null 반환)을 쓰는 자리만
  // `TableState | null`을 받는다.
  async mutateSnapshot(
    tableId: string,
    fn: (state: TableState | null) => Promise<TableState>,
  ): Promise<TableState>;
  async mutateSnapshot(
    tableId: string,
    fn: (state: TableState | null) => Promise<TableState | null>,
  ): Promise<TableState | null>;
  async mutateSnapshot(
    tableId: string,
    fn: (state: TableState | null) => Promise<TableState | null>,
  ): Promise<TableState | null> {
    return this.withTableLock(tableId, async () => {
      const state = await this.getSnapShot(tableId);
      const next = await fn(state);
      if (!next) return state;
      await this.writeSnapshot(tableId, next);
      return next;
    });
  }

  /**
   * 락 없이 쓰는 **예외**. 이름과 `reason`이 그 사실을 자백한다.
   *
   * `reason`이 문자열이 아니라 열거형인 것이 핵심이다 — 새 예외를 만들려면
   * 이 유니온을 고쳐야 하고, 그 diff가 리뷰에 보인다. 근거 없이 락을 건너뛰는
   * 자리가 조용히 하나 더 생기는 것을 막는다.
   *
   * - `boot-recovery`: `RecoveryService`는 `app.listen()` 이전에 돈다.
   *   경합할 상대가 아직 존재하지 않는다.
   * - `table-created`: 방금 INSERT한 테이블에 빈 스냅샷을 세운다. 그 테이블을
   *   아는 경로가 아직 없다(브로드캐스트보다 먼저 쓰는 이유도 같다).
   *
   * 근거가 깨지면 예외도 깨진다. 다른 호출자가 생기는 날 이 목록을 다시 본다.
   */
  async saveSnapshotUnlocked(
    tableId: string,
    table: TableState,
    reason: 'boot-recovery' | 'table-created',
  ) {
    void reason; // 신호는 호출부에 남는다. 값 자체를 여기서 쓰지는 않는다.
    await this.writeSnapshot(tableId, table);
  }

  /**
   * 실제 쓰기. `mutateSnapshot`(락 안)과 `saveSnapshotUnlocked`(명시된 예외)
   * 둘만 부른다 — 밖에서 부를 수 없어야 "스냅샷을 쓰는 길은 둘뿐"이 문서가
   * 아니라 타입으로 선다.
   */
  private async writeSnapshot(tableId: string, table: TableState) {
    await this.redis.set(`table:state:${tableId}`, JSON.stringify(table));
    await this.redis.expire(`table:state:${tableId}`, 86400);
  }

  // Table 가져오기
  async getSnapShot(tableId: string): Promise<TableState | null> {
    const rawState = await this.redis.get(`table:state:${tableId}`);
    if (!rawState) return null;
    return JSON.parse(rawState);
  }

  // 유저의 위치,정보 저장
  async setUserContext(tournamentId: string, userId: string, tableId: string, seatIndex: number, status: string) {
    const key = `tournament:${tournamentId}:user`;
    await this.redis.hset(key, userId, JSON.stringify({ tableId: tableId, seatIndex: seatIndex, status: status }));
    await this.redis.expire(key, 86400);
  }

  // 유저 위치 정보 가져오기
  async getUserContext(tournamentId: string, userId: string): Promise<UserInfo | null> {
    const key = `tournament:${tournamentId}:user`;
    const raw = await this.redis.hget(key, userId);
    return raw ? JSON.parse(raw) : null;
  }

  // 유저 정보 삭제
  async deleteUserContext(tournamentId: string, userId: string) {
    const key = `tournament:${tournamentId}:user`;
    await this.redis.hdel(key, userId);
  }

  /**
   * 유저 정보 여러 명을 한 번에 삭제한다. `hdel`은 필드를 여러 개 받으므로
   * 한 번의 호출로 끝난다 — `deleteUserContext`를 유저 수만큼 반복하면
   * 그 사이 장애가 껴서 일부만 지워지는 창이 생긴다(위 `updateSeatBitmapMany`와
   * 같은 이유).
   */
  async deleteUserContexts(tournamentId: string, userIds: string[]) {
    if (userIds.length === 0) return;
    const key = `tournament:${tournamentId}:user`;
    await this.redis.hdel(key, ...userIds);
  }

  // 대회 종료시 redis 정리
  async deleteTournament(tournamentId: string, tables: string[]) {
    const pipe = this.redis.pipeline();
    pipe.del(`tournament:${tournamentId}:info`)
    pipe.del(`tournament:${tournamentId}:user`)
    pipe.del(`tournament:${tournamentId}:seat`);
    tables.forEach(t => {
      pipe.del(`table:state:${t}`);
    })
    await pipe.exec();
  }

}