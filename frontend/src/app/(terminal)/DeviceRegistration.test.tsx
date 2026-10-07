import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeviceRegistration from './DeviceRegistration';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe('DeviceRegistration', () => {
  it('등록 호출이 던지면 연결 실패 안내를 보이고 버튼이 다시 열린다', async () => {
    const register = vi.fn(async () => {
      throw new Error('network');
    });
    render(<DeviceRegistration storeId="store-1" register={register} />);

    await userEvent.type(screen.getByLabelText('점주 아이디'), 'owner');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '이 기기 등록' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
    expect(screen.getByRole('button', { name: '이 기기 등록' })).toBeEnabled();
  });
});
