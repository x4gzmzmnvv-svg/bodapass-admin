import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminShell } from '../layouts/AdminShell';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';
import { SignupRouter } from '../pages/signup/SignupRouter';
import { SiteListPage } from '../pages/SiteListPage';
import { TeamListPage } from '../pages/TeamListPage';
import { ForemanPage } from '../pages/ForemanPage';
import { WagePage } from '../pages/WagePage';
import { GongsuClosePage } from '../pages/GongsuClosePage';
import { WagePayPage } from '../pages/WagePayPage';
import { TaxManagementPage } from '../pages/TaxManagementPage';
import { AttendancePage } from '../pages/AttendancePage';
import { PrivacyPolicyPage } from '../pages/PrivacyPolicyPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ReportsPage } from '../pages/ReportsPage';
import { SafetyPage } from '../pages/SafetyPage';
import { OutputCenterPage } from '../pages/OutputCenterPage';
import { useAuth } from '../hooks/useAuth';

/** 본사 사용자만 접근 가능한 라우트 가드 */
function HQOnly({ children }: { children: ReactElement }) {
  const { viewMode } = useAuth();
  if (viewMode === 'SITE') return <Navigate to="/" replace />;
  return children;
}

export function AppRouter() {
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        {/* 비인증 화면 */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupRouter />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />

        {/* 메인 셸 */}
        <Route element={<AdminShell />}>
          <Route index element={<DashboardPage />} />

          <Route path="/team" element={<TeamListPage />} />
          <Route path="/foremen" element={<ForemanPage />} />

          <Route
            path="/site"
            element={
              <HQOnly>
                <SiteListPage />
              </HQOnly>
            }
          />

          {/* 출역 — 단일 페이지 + URL 별 탭 자동 선택 */}
          <Route path="/attendance"     element={<AttendancePage />} />
          <Route path="/auth-mgmt"      element={<AttendancePage forceTab="auth" />} />
          <Route path="/daily-confirm"  element={<AttendancePage forceTab="daily" />} />

          <Route path="/safety" element={<SafetyPage />} />

          {/* 출역·노무마감 그룹 */}
          <Route path="/gongsu-close" element={<GongsuClosePage />} />
          <Route path="/wage-close"   element={<WagePage defaultTab="wage" />} />

          {/* 지급·신고관리 그룹 */}
          <Route path="/wage-pay"     element={<WagePayPage />} />
          <Route path="/tax"          element={<TaxManagementPage />} />

          {/* 호환 — 기존 /wage 는 「노무비 마감」으로 매핑 */}
          <Route path="/wage" element={<WagePage defaultTab="wage" />} />

          <Route path="/severance" element={<WagePage defaultTab="severance" />} />
          {/* 4대보험 — 출력센터의 INSURANCE 탭으로 매핑 (전용 신고 모듈) */}
          <Route path="/insurance" element={<OutputCenterPage defaultTab="INSURANCE" />} />

          <Route path="/output" element={<OutputCenterPage />} />

          <Route
            path="/reports"
            element={
              <HQOnly>
                <ReportsPage />
              </HQOnly>
            }
          />

          <Route
            path="/settings"
            element={
              <HQOnly>
                <SettingsPage />
              </HQOnly>
            }
          />
        </Route>

        {/* 알 수 없는 경로 → 대시보드 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
