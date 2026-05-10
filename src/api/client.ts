import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { setupMockBackend } from './mockBackend';

/**
 * 관리자 웹 API 클라이언트
 * - 앱과 동일한 패턴: 토큰 자동 첨부 + 401 시 1회 재발급
 * - 토큰 키는 앱과 별도 네임스페이스(`ilgampack_admin:*`)로 충돌 방지
 * - VITE_USE_MOCK=true(기본)이면 src/api/mockBackend.ts 가 응답
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? 'true') !== 'false';

const TOKEN_STORAGE_KEY = 'ilgampack_admin:access_token';
const REFRESH_STORAGE_KEY = 'ilgampack_admin:refresh_token';

export const tokenStore = {
  getAccess: () => localStorage.getItem(TOKEN_STORAGE_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_STORAGE_KEY),
  set: (access: string, refresh: string) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, access);
    localStorage.setItem(REFRESH_STORAGE_KEY, refresh);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(REFRESH_STORAGE_KEY);
  },
};

export const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

// Mock 백엔드 셋업 — apiClient 인스턴스에 어댑터로 붙여 네트워크에 나가지 않게 한다
if (USE_MOCK && typeof window !== 'undefined') {
  setupMockBackend(apiClient);
}

// 요청 — Access Token 자동 첨부
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.getAccess();
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 응답 — 401 시 1회 재발급
let isRefreshing = false;
let pendingQueue: Array<(token: string) => void> = [];

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const originalReq = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    if (error.response?.status === 401 && !originalReq._retry) {
      originalReq._retry = true;

      if (isRefreshing) {
        return new Promise((resolve) => {
          pendingQueue.push((newToken) => {
            if (originalReq.headers) {
              originalReq.headers.Authorization = `Bearer ${newToken}`;
            }
            resolve(apiClient(originalReq));
          });
        });
      }

      isRefreshing = true;
      try {
        const refreshToken = tokenStore.getRefresh();
        if (!refreshToken) throw error;

        const { data } = await axios.post<{ accessToken: string; refreshToken: string }>(
          `${BASE_URL}/auth/refresh`,
          { refreshToken },
        );
        tokenStore.set(data.accessToken, data.refreshToken);
        pendingQueue.forEach((cb) => cb(data.accessToken));
        pendingQueue = [];

        if (originalReq.headers) {
          originalReq.headers.Authorization = `Bearer ${data.accessToken}`;
        }
        return apiClient(originalReq);
      } catch (refreshError) {
        tokenStore.clear();
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export function getErrorMessage(err: unknown, fallback = '오류가 발생했습니다.'): string {
  // axios 정식 에러
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { message?: string } | undefined;
    return data?.message ?? err.message ?? fallback;
  }
  // mock 어댑터가 reject 하는 plain object — { response: { data: { message } }, message }
  if (err && typeof err === 'object') {
    const e = err as { response?: { data?: { message?: string } }; message?: string };
    const m = e.response?.data?.message ?? e.message;
    if (m) return m;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
