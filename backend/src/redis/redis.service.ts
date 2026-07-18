import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { PayMentDto } from "shared/dto/payment.dto";
import { BlindField, Dashboard, FullTournamentInfo } from "shared/types/tournamentMeta";
import { UserInfo } from "shared/types/userInfo";
import { getCurrentBlindLevel } from "shared/util/util";
import { TableState } from "src/game-engine/types";

@Injectable()
export class RedisService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

  private getInfoKey(id: string) {
    return `tournament:${id}:info`;
  }

  /**
   * 테이블 상태를 수정하는 구간은 반드시 이 락으로 감쌀 것.
   *
   * 스냅샷은 JSON 통째로 덮어쓰므로, getSnapShot → 수정 → saveSnapShot 이
   * 겹치면 나중에 쓴 쪽이 앞선 쓰기를 통째로 지운다. 진 쪽이 이미 실행한
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
  // 좌석 선점 시도
  async acquireSeatLock(dto: PayMentDto, userId: string): Promise<boolean> {
    const lockKey = `lock:seat:${dto.tableId}:${dto.seatIndex}`;
    const expireTime = 10;

    // NX: 키가 없을 때만 세팅, EX: 만료 시간 설정
    const result = await this.redis.set(lockKey, userId, 'EX', expireTime, 'NX');

    return result === 'OK'; // 성공하면 true, 이미 누가 점유 중이면 false
  }

  // 락 해제 (결제 완료 후 또는 취소 시)
  async releaseSeatLock(dto: PayMentDto) {
    const lockKey = `lock:seat:${dto.tableId}:${dto.seatIndex}`;
    await this.redis.del(lockKey);
  }

  // 테이블 초기생성
  async setSeatBitmap(tournamentId: string, tableId: string) {
    const key = `tournament:${tournamentId}:seat`;
    const field = `table:${tableId}`;

    let bitmap = '000000000'

    await this.redis.hset(key, field, bitmap);
    await this.redis.expire(key, 86400);
  }

  async updateSeatBitmap(tournamentId: string, tableId: string, seatIndex: number, isOccupied: boolean) {
    const key = `tournament:${tournamentId}:seat`;
    const field = `table:${tableId}`;

    // 자리가 비었으면 0
    let bitmap = await this.redis.hget(key, field) || "000000000";
    const bitmapArray = bitmap.split("");
    bitmapArray[seatIndex] = isOccupied ? "1" : "0";

    await this.redis.hset(key, field, bitmapArray.join(""));
    await this.redis.expire(key, 86400);
    return bitmapArray.join("");
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

    return {
      dashboard: {
        isRegistrationOpen: raw.isRegistrationOpen === '1',
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

  async setTournamentDashboard(id: string, dashboard: Dashboard) {
    await this.redis.hset(`tournament:${id}:info`, 'dashboard', JSON.stringify(dashboard));
  }

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
    await this.redis.hset(`tournament:${id}:info`, 'blindField', JSON.stringify(blindField));
  }

  /**
 * 토너먼트의 현재 블라인드 상태를 확인하고, 시간이 경과했다면 자동으로 업데이트합니다.
 * @returns 최신 블라인드 정보 (업데이트된 경우 반영됨)
 */
  async checkAndSyncBlindLevel(tournamentId: string): Promise<BlindField | null> {
    const blind = await this.getTournamentBlind(tournamentId);
    if (!blind) return null;

    const now = Date.now();
    // 최적화: 아직 다음 레벨 시간이 되지 않았다면 현재 상태 그대로 반환
    // (이미 휴식 중이라면 blind.isBreak가 true인 상태로 반환됨)
    if (blind.nextLevelAt && now < blind.nextLevelAt) {
      return { ...blind, serverTime: now };
    }
    // 시간 경과 시에만 상세 계산 수행
    const calculated = getCurrentBlindLevel(blind.blindStructure, blind.startedAt);
    // 레벨 인덱스가 바뀌었거나, 휴식 상태(isBreak)가 변경되었을 때만 업데이트
    if (calculated.currentIndex !== blind.currentBlindLv || calculated.isBreak !== blind.isBreak) {
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
      if (regiCloseAt && curLv === parseInt(regiCloseAt)) {
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

    await pipeline.exec();
    // const results = 
    // 에러 핸들링 (선택 사항)
    // results?.forEach(([err, response], index) => {
    //   if (err) console.error(`Table ${tableStates[index].tableId} save failed:`, err);
    // });
  }

  // Table 상태 저장
  async saveSnapShot(tableId: string, table: TableState) {
    await this.redis.set(`table:state:${tableId}`, JSON.stringify(table));
    this.redis.expire(`table:state:${tableId}`, 86400);
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