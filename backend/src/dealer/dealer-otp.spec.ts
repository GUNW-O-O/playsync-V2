import { OTP_LENGTH, generateDealerOtp, hashDealerOtp, verifyDealerOtp } from './dealer-otp';

describe('딜러 OTP', () => {
  it('항상 6자리이고 앞자리 0을 잃지 않는다', () => {
    // 숫자로 다루면 앞자리 0이 사라져 후보 공간이 10^6보다 작아진다.
    // 문자열로 뽑는 이유가 그것이므로 길이로 고정한다.
    for (let i = 0; i < 500; i++) {
      const otp = generateDealerOtp();
      expect(otp).toMatch(/^[0-9]{6}$/);
      expect(otp.length).toBe(OTP_LENGTH);
    }
  });

  it('같은 값을 두 번 뽑아도 해시가 다르다', async () => {
    const a = await hashDealerOtp('012345');
    const b = await hashDealerOtp('012345');
    expect(a).not.toBe(b);
  });

  it('해시에서 원본을 읽을 수 없다', async () => {
    const hash = await hashDealerOtp('012345');
    expect(hash).not.toContain('012345');
  });

  it('맞는 OTP만 통과한다', async () => {
    const hash = await hashDealerOtp('012345');
    await expect(verifyDealerOtp('012345', hash)).resolves.toBe(true);
    await expect(verifyDealerOtp('012346', hash)).resolves.toBe(false);
    await expect(verifyDealerOtp('12345', hash)).resolves.toBe(false);
  });
});
