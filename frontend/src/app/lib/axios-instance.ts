import axios from 'axios';
import { getCookie } from 'cookies-next';

export const gameApi = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// 인터셉터를 통해 쿠키에 담긴 유저 정보를 헤더에 포함
gameApi.interceptors.request.use((config) => {
  const userId = getCookie('auth_id');
  if (userId) {
    config.headers['x-temp-user-id'] = userId;
  }
  return config;
});