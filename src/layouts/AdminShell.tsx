import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import './AdminShell.css';

/**
 * 관리자 메인 레이아웃 — 좌측 사이드바 + 상단 헤더 + 메인 컨텐츠
 * 인증되지 않은 사용자는 /login 으로 리다이렉트.
 */
export function AdminShell() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <div className="admin-shell" style={{ display: 'flex', minHeight: '100vh', minWidth: 1280 }}>
      <Sidebar />
      <div className="admin-shell__main">
        <TopBar />
        <main className="admin-shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
