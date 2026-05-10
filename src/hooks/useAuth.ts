import { useCallback, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/auth';
import { tokenStore } from '../api/client';
import type { AdminUser, LoginRequest } from '../api/types';

const USER_KEY = 'ilgampack_admin:user';

/**
 * 사용자의 화면 모드.
 *  - 'HQ'   : 본사 사용자 (OWNER 또는 assignedSiteId='ALL')
 *  - 'SITE' : 현장담당자 (assignedSiteId 가 특정 site id)
 */
export type ViewMode = 'HQ' | 'SITE';

export function getViewMode(user: AdminUser | null): ViewMode {
  if (!user) return 'HQ'; // 로그인 전 상태는 일단 HQ 로 간주 (라우터가 /login 으로 보냄)
  if (user.role === 'OWNER') return 'HQ';
  if (!user.assignedSiteId || user.assignedSiteId === 'ALL') return 'HQ';
  return 'SITE';
}

/**
 * 관리자 인증 훅
 *  - localStorage에 user 캐시 저장 → 새로고침해도 유지
 *  - 토큰만 남고 user가 비었을 때 /auth/me 로 회복
 */
export function useAuth() {
  const [user, setUser] = useState<AdminUser | null>(() => {
    const cached = localStorage.getItem(USER_KEY);
    return cached ? (JSON.parse(cached) as AdminUser) : null;
  });

  useEffect(() => {
    if (!user && tokenStore.getAccess()) {
      authApi
        .me()
        .then(setUser)
        .catch(() => {
          /* 무시 — 401이면 인터셉터가 /login으로 떨궈줌 */
        });
    } else if (
      user &&
      tokenStore.getAccess() &&
      user.assignedSiteId === undefined &&
      user.role !== 'OWNER'
    ) {
      // 옛 캐시 — assignedSiteId 누락된 매니저/스태프 사용자 → 서버 재조회
      authApi
        .me()
        .then(setUser)
        .catch(() => {
          /* 무시 */
        });
    }
  }, [user]);

  useEffect(() => {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  }, [user]);

  const login = useCallback(async (req: LoginRequest) => {
    const res = await authApi.login(req);
    tokenStore.set(res.accessToken, res.refreshToken);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      tokenStore.clear();
      localStorage.removeItem(USER_KEY);
      setUser(null);
    }
  }, []);

  const viewMode = useMemo<ViewMode>(() => getViewMode(user), [user]);
  /** 현장담당자일 때 자기에게 배정된 현장 id (HQ 면 null) */
  const assignedSiteId = useMemo<string | null>(() => {
    if (!user || user.assignedSiteId === undefined || user.assignedSiteId === 'ALL') return null;
    return user.assignedSiteId;
  }, [user]);

  return { user, login, logout, isAuthenticated: !!user, viewMode, assignedSiteId };
}
