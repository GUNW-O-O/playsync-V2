import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';

export const OTP_LENGTH = 6;

const SALT_ROUNDS = 10;

/**
 * OTP를 문자열로 다루는 이유.
 *
 * 이전 구현은 `Math.floor(1000 + Math.random() * 9000)`이었다. 두 가지가
 * 문제였다 — `Math.random()`은 암호학적 난수가 아니라 시드를 알면 예측되고,
 * `Int` 컬럼에 담느라 앞자리 0을 쓰지 못해 후보가 9000개뿐이었다.
 *
 * 문자열 + `randomInt`로 바꾸면 후보가 10^6이 되고 예측이 불가능해진다.
 */
export function generateDealerOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

export function hashDealerOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, SALT_ROUNDS);
}

export function verifyDealerOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}
