import { apiClient } from './client';
import type { AdminUser, LoginRequest, LoginResponse } from './types';

/** 관리자 인증 API */
export const authApi = {
  login: async (req: LoginRequest): Promise<LoginResponse> => {
    const { data } = await apiClient.post<LoginResponse>('/auth/login', req);
    return data;
  },
  logout: async (): Promise<void> => {
    await apiClient.post('/auth/logout');
  },
  me: async (): Promise<AdminUser> => {
    const { data } = await apiClient.get<AdminUser>('/auth/me');
    return data;
  },
};
