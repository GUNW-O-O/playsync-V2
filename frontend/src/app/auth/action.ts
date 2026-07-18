'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001.com';

// [회원가입 Action]
export async function handleRegister(formData: FormData) {
  const password = formData.get('password');
  const nickname = formData.get('nickname');

  const res = await fetch(`${BACKEND_URL}/auth/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });

  if (!res.ok) {
    const error = await res.json();
    return { error: error.message || '회원가입에 실패했습니다.' };
  }

  redirect('/login');
}

// [로그인 Action]
export async function handleLogin(formData: FormData) {
  const nickname = formData.get('nickname');
  const password = formData.get('password');
  const cookie = await cookies();

  const res = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });

  const data = await res.json();

  if (!res.ok) {
    return { error: data.message || '아이디 또는 비밀번호가 틀렸습니다.' };
  }

  // 데이터 구조가 { accessToken: '...' } 라고 가정
  const token = data.accessToken;

  // [핵심] 쿠키에 JWT 저장
  cookie.set('accessToken', token, {
    httpOnly: true, // 자바스크립트로 접근 불가 (보안)
    secure: process.env.NODE_ENV === 'production', // HTTPS에서만 전송
    sameSite: 'lax', // CSRF 방어
    path: '/', // 모든 경로에서 쿠키 유효
    maxAge: 60 * 60 * 24, // 1일 (NestJS JWT 만료시간과 맞추는 것 권장)
  });

  redirect('/'); // 로그인 성공 시 대시보드로 이동
}