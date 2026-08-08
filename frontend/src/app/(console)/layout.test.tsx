import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConsoleLayout from './layout';

describe('콘솔 레이아웃', () => {
  it('본문을 감싸고 면 표찰을 둔다', () => {
    render(<ConsoleLayout>{<p>본문</p>}</ConsoleLayout>);

    expect(screen.getByText('본문')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('상점 콘솔')).toBeInTheDocument();
  });

  /**
   * 예전에는 `/stores`와 `/admin` 링크가 있었고 **둘 다 404였다.** 라우트를
   * 만들 계획이 없으므로 링크를 지웠다 — 없는 곳으로 가는 링크는 눌러 본
   * 사람이 고장으로 읽는다.
   *
   * 이 검사가 지키는 것은 "링크가 없다"가 아니라 **"라우트 없는 링크가 다시
   * 생기지 않는다"**이다. 링크를 추가하려면 라우트를 먼저 만들고 이 검사를
   * 그때 고친다.
   */
  it('라우트 없는 링크를 두지 않는다', () => {
    render(<ConsoleLayout>{<p>본문</p>}</ConsoleLayout>);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
