import { getCurrentBlindLevel, parseBlindStructure } from './util';

describe('parseBlindStructure', () => {
  it('배열이 아니면 거부한다', () => {
    expect(() => parseBlindStructure({ lv: 1 })).toThrow('Invalid blind structure');
  });

  it('빈 배열을 거부한다', () => {
    // 통과시키면 `getCurrentBlindLevel`이 마지막 레벨을 읽는 대목에서
    // `structure[-1]`이 되어 `undefined.lv`로 죽는다. 그 자리가 **대회
    // 시작**이라 참가자가 다 앉은 뒤에 500이 난다.
    expect(() => parseBlindStructure([])).toThrow('Invalid blind structure');
  });

  it('레벨 모양이 어긋나면 거부한다', () => {
    expect(() => parseBlindStructure([{ lv: 1, sb: 100, ante: 'yes', duration: 10 }]))
      .toThrow('Invalid blind level format');
  });

  it('정상 구조는 그대로 돌려준다', () => {
    const 구조 = [{ lv: 1, sb: 100, ante: false, duration: 3 }];
    expect(parseBlindStructure(구조)).toEqual(구조);
  });
});

describe('getCurrentBlindLevel — 빈 구조가 도달할 수 없음을 확인한다', () => {
  it('마지막 레벨을 지난 뒤에도 마지막 원소를 읽는다', () => {
    // 방어를 여기 두지 않는 근거다. 입구(DTO)와 `parseBlindStructure`가
    // 빈 배열을 막으므로, 이 함수는 **비어 있지 않은 구조만** 받는다.
    const 구조 = [{ lv: 1, sb: 100, ante: false, duration: 1 }];
    const 결과 = getCurrentBlindLevel(구조, Date.now() - 10 * 60 * 1000);
    expect(결과.currentIndex).toBe(0);
    expect(결과.isBreak).toBe(false);
  });
});
