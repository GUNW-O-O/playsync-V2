import type { TournamentStatus } from '@playsync/contract';

/**
 * 화면에 적는 이름표. 같은 표를 화면마다 들고 있다가 한쪽만 고쳐지는 날을 막는다.
 *
 * **`Record<TournamentStatus, string>`이라 키가 빠지면 컴파일이 안 된다.** `if` 분기로
 * 적으면 새 상태(`SYNCING`이 그랬다)가 폴백으로 새어 원래 문자열 그대로 화면에 뜬다.
 */
export const STATUS_LABEL: Record<TournamentStatus, string> = {
  PENDING: '시작 전',
  ONGOING: '진행 중',
  SYNCING: '복구 중',
  FINISHED: '종료',
  CANCELLED: '취소',
};

/** 페이즈 이름. 키는 `GamePhase`의 숫자다(계약의 `TableState.phase`). */
export const PHASE_LABEL: Record<number, string> = {
  0: '대기',
  1: '프리플랍',
  2: '플랍',
  3: '턴',
  4: '리버',
  5: '쇼다운',
  6: '핸드 종료',
};
