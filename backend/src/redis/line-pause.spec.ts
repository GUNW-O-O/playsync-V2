import { LinePause } from './line-pause';

describe('LinePause (T121)', () => {
  it('끊기면 그 대회의 세대가 오르고 isDown이 선다', () => {
    const line = new LinePause();
    expect(`${line.generationOf('a')} ${line.isDown('a')}`).toBe('0 false');

    line.markDown('a');

    expect(`${line.generationOf('a')} ${line.isDown('a')}`).toBe('1 true');
  });

  it('다른 대회는 건드리지 않는다', () => {
    const line = new LinePause();
    const other = jest.fn();
    line.onceDown('b', other);

    line.markDown('a');

    expect(`${line.generationOf('b')} ${line.isDown('b')} ${other.mock.calls.length}`).toBe('0 false 0');
  });

  it('대기자는 한 번만 부른다', () => {
    const line = new LinePause();
    const waiter = jest.fn();
    line.onceDown('a', waiter);

    line.markDown('a');
    line.markDown('a');

    expect(waiter).toHaveBeenCalledTimes(1);
  });

  it('구독을 풀면 부르지 않는다', () => {
    const line = new LinePause();
    const waiter = jest.fn();
    line.onceDown('a', waiter)();

    line.markDown('a');

    expect(waiter).not.toHaveBeenCalled();
  });

  it('대기자 하나가 던져도 나머지를 부른다', () => {
    const line = new LinePause();
    const second = jest.fn();
    line.onceDown('a', () => { throw new Error('x'); });
    line.onceDown('a', second);

    line.markDown('a');

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clear는 원인만 지운다 — 세대는 내려가지 않는다', () => {
    const line = new LinePause();
    line.markDown('a');

    line.clear('a');

    expect(`${line.generationOf('a')} ${line.isDown('a')}`).toBe('1 false');
  });

  it('clearAll은 모든 대회의 원인을 지운다', () => {
    const line = new LinePause();
    line.markDown('a');
    line.markDown('b');

    line.clearAll();

    expect(`${line.isDown('a')} ${line.isDown('b')}`).toBe('false false');
  });
});
