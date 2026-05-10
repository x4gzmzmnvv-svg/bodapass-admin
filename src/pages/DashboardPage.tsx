// FILE_VERSION 1777950500
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { PlusIcon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { SiteRegisterDialog } from '../components/SiteRegisterDialog';
import { ForemanRegisterDialog } from '../components/ForemanRegisterDialog';
import { siteApi } from '../api/site';
import { teamApi } from '../api/team';
import { attendanceApi } from '../api/attendance';
import { wageApi } from '../api/wage';
import { resetMockDb } from '../api/mockBackend';
import type { DashboardSummary, Foreman, Site } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import type { TodayAttendance, AttCloseStage, WageCloseStage } from '../api/attendance.types';
import type { WageMonthSummary } from '../api/wage.types';
import { safetyApi } from '../api/safety';
import type { SafetyMessage } from '../api/safety.types';
import { getErrorMessage } from '../api/client';
import { getDispatchLogs, type DispatchLog } from '../utils/messageTemplates';
import { getAvatarUrl } from '../utils/avatar';
import { useAuth } from '../hooks/useAuth';
import { displayPhone } from '../utils/phone';
import { apiClient } from '../api/client';
import type { Company, SiteCompany } from '../api/site.types';
import './DashboardPage.css';

/**
 * 대시보드 (재구성)
 *  ┌─────────────────────────────────────────┐
 *  │ 현장 표 (행·열) — 엑셀 스타일             │
 *  ├─────────────────────────────────────────┤
 *  │ 선택 현장 KPI — 예산 대비 % 픽토그램      │
 *  ├─────────────────────────────────────────┤
 *  │ 등록 반장 + 미니 캘린더                   │
 *  └─────────────────────────────────────────┘
 *
 *  KPI 비율(예산 대비)
 *   - 공정률          : site.progressPercent (이미 % 단위)
 *   - 연간 지급액      : annualPayoutKrw / contractAmount
 *   - 지급예정        : pendingPayoutKrw / contractAmount
 *   - 공제금액        : deductionKrw / annualPayoutKrw
 *   - 소득세          : incomeTaxKrw / annualPayoutKrw
 *   - 40H공단         : hourFundKrw / annualPayoutKrw
 *   - 퇴직금(R)       : severanceKrw / annualPayoutKrw
 */
export function DashboardPage() {
  const { user, assignedSiteId, viewMode } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  /** 전체 현장에 등록된 모든 반장 */
  const [allForemen, setAllForemen] = useState<Foreman[]>([]);
  /** 회사 전체 비번 반장 풀 — 사이트 제한 없이 회사 단위로 모음 (다른 현장 비번도 노출) */
  const [companyForemen, setCompanyForemen] = useState<Foreman[]>([]);
  /** 반장 ID → 등록된 팀원 수 */
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [siteCompanies, setSiteCompanies] = useState<SiteCompany[]>([]);
  /** 각 site 별 마감 상태 — 8단계 워크플로우 추적용 */
  const [closeStatusBySite, setCloseStatusBySite] = useState<Record<string, {
    monthClosed: boolean;
    todayClosed: boolean;
    todaySiteOk: boolean;
    todayHqOk: boolean;
    attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
    wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
  }>>({});
  const [error, setError] = useState<string | null>(null);
  /** 모든 visible members — DailyOpsStrip 가 face/manual 비율 등 계산에 사용 */
  const [allMembers, setAllMembers] = useState<TeamMember[]>([]);
  /** HQ 대시보드용 — 모든 시공중 현장의 오늘 출퇴근 데이터 (집계 계산용) */
  const [todayBySite, setTodayBySite] = useState<Record<string, TodayAttendance>>({});
  /** 현장별 이번 달 노임 요약 — 「오늘 노무비/월 누적/공제/실지급」 단일 진실 소스 */
  const [wageBySite, setWageBySite] = useState<Record<string, WageMonthSummary>>({});
  /** 반장 누적 KPI — ForemanPage 와 동일한 단일 진실 소스 (얼굴인식률/수동처리율/GPS 정상률) */
  const [foremanMetricsById, setForemanMetricsById] = useState<Record<string, any>>({});
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [foremanDialogOpen, setForemanDialogOpen] = useState(false);

  const loadAll = useCallback(async (focusSiteId?: string) => {
    setLoading(true);
    setError(null);
    try {
      // 현장담당자(SITE)는 자기 현장만 강제 focus
      const focus = viewMode === 'SITE' ? assignedSiteId ?? focusSiteId : focusSiteId;
      const [s, sm, fAll, fCompany, ml, cRes, scRes] = await Promise.all([
        siteApi.listSites(),
        siteApi.dashboard(focus ?? undefined),
        siteApi.listForemen(),
        // 비번 반장 풀 — 사이트 제한 무시한 회사 전체 (companyWide=1)
        apiClient.get<{ foremen: Foreman[] }>('/foremen', { params: { companyWide: '1' } }),
        teamApi.list({ status: 'ALL' }),
        apiClient.get<{ companies: Company[] }>('/companies'),
        apiClient.get<{ siteCompanies: SiteCompany[] }>('/site-companies'),
      ]);
      setCompanyForemen(fCompany.data.foremen ?? []);
      setCompanies(cRes.data.companies ?? []);
      setSiteCompanies(scRes.data.siteCompanies ?? []);
      // SITE 모드: 자기 현장 1건만, 반장/팀원도 그 현장 한정
      const visibleSites =
        viewMode === 'SITE' && assignedSiteId
          ? s.sites.filter((x) => x.id === assignedSiteId)
          : s.sites;
      const visibleForemen =
        viewMode === 'SITE' && assignedSiteId
          ? fAll.foremen.filter((f) => f.siteId === assignedSiteId)
          : fAll.foremen;
      const visibleMembers =
        viewMode === 'SITE' && assignedSiteId
          ? ml.members.filter((m) => m.siteId === assignedSiteId)
          : ml.members;
      setSites(visibleSites);
      setSummary(sm);
      setAllForemen(visibleForemen);
      setAllMembers(visibleMembers);
      // 각 visible site 의 일/월 마감 상태 병렬 fetch
      const ymStr = new Date().toISOString().slice(0, 7);
      const todayStr = new Date().toISOString().slice(0, 10);
      try {
        const closeResults = await Promise.all(
          visibleSites.map((s) =>
            attendanceApi.closeStatus(s.id, ymStr).then((r) => {
              const todayDc = r.dayCloses.find((d) => d.date === todayStr);
              return {
                siteId: s.id,
                monthClosed: r.monthClose.status === 'CLOSED',
                todayClosed: !!todayDc && todayDc.status === 'CLOSED',
                todaySiteOk: !!todayDc?.confirmedBySite,
                todayHqOk: !!todayDc?.confirmedByHQ,
                attStage: r.monthClose.attStage ?? 'OPEN',
                wageStage: r.monthClose.wageStage ?? 'OPEN',
              };
            }),
          ),
        );
        const map: Record<string, {
          monthClosed: boolean; todayClosed: boolean;
          todaySiteOk: boolean; todayHqOk: boolean;
          attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
          wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
        }> = {};
        for (const r of closeResults) map[r.siteId] = {
          monthClosed: r.monthClosed,
          todayClosed: r.todayClosed,
          todaySiteOk: r.todaySiteOk,
          todayHqOk: r.todayHqOk,
          attStage: r.attStage,
          wageStage: r.wageStage,
        };
        setCloseStatusBySite(map);
      } catch { /* 무시 */ }
      // HQ 대시보드용 — 시공중 현장 전체의 오늘 출퇴근 데이터 병렬 fetch
      try {
        const inProgressSites = visibleSites.filter((x) => x.status !== 'COMPLETED');
        const todayResults = await Promise.all(
          inProgressSites.map((s) =>
            attendanceApi.today(s.id).then((t) => ({ siteId: s.id, today: t })).catch(() => null),
          ),
        );
        const tmap: Record<string, TodayAttendance> = {};
        for (const r of todayResults) {
          if (r && r.today) tmap[r.siteId] = r.today;
        }
        setTodayBySite(tmap);
      } catch { /* 무시 */ }
      // 현장별 이번 달 노임 요약 — 「월 누적/공제/실지급」 단일 진실 소스
      try {
        const inProgressSites = visibleSites.filter((x) => x.status !== 'COMPLETED');
        const ymForWage = new Date().toISOString().slice(0, 7);
        const wageResults = await Promise.all(
          inProgressSites.map((s) =>
            wageApi.monthSummary({ siteId: s.id, yearMonth: ymForWage })
              .then((w) => ({ siteId: s.id, wage: w }))
              .catch(() => null),
          ),
        );
        const wmap: Record<string, WageMonthSummary> = {};
        for (const r of wageResults) {
          if (r && r.wage) wmap[r.siteId] = r.wage;
        }
        setWageBySite(wmap);
      } catch { /* 무시 */ }
      // 반장 누적 KPI — ForemanPage 와 동일한 데이터 소스
      try {
        const fm = await siteApi.listForemanMetrics();
        const map: Record<string, any> = {};
        for (const m of fm.metrics ?? []) map[m.foremanId] = m;
        setForemanMetricsById(map);
      } catch { /* 무시 */ }
      const counts: Record<string, number> = {};
      for (const m of visibleMembers) {
        if (m.foremanId) counts[m.foremanId] = (counts[m.foremanId] ?? 0) + 1;
      }
      setMemberCounts(counts);
    } catch (err) {
      setError(getErrorMessage(err, '대시보드 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [assignedSiteId, viewMode]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const hasSites = sites.length > 0;
  const current = summary?.current;

  function handleSelectSite(siteId: string) {
    loadAll(siteId);
  }

  function handleSiteCreated(site: Site) {
    loadAll(site.id);
    setTimeout(() => setForemanDialogOpen(true), 200);
  }

  function handleForemenCreated(_: Foreman[]) {
    loadAll(current?.site.id);
  }

  // 페이지 액션 버튼 — TopBar의 슬롯으로 portal
  const topbarSlot = typeof document !== 'undefined'
    ? document.getElementById('topbar-page-actions')
    : null;
  const topbarActions = (
    <>
      <button
        type="button"
        className="dash__btn dash__btn--ghost"
        onClick={() => {
          if (window.confirm('Mock DB를 시드 데이터로 초기화합니다.\n(진행하면 페이지가 새로고침됩니다.)')) {
            resetMockDb();
          }
        }}
        title="현재 브라우저의 캐시 데이터를 비우고 시드 데이터를 다시 만듭니다."
      >
        ↻ DB 리셋
      </button>
      <button
        type="button"
        className="dash__btn dash__btn--ghost"
        onClick={() => setForemanDialogOpen(true)}
        disabled={!hasSites}
      >
        + 반장 등록
      </button>
      <button
        type="button"
        className="dash__btn dash__btn--primary"
        onClick={() => setSiteDialogOpen(true)}
        title="새 공사 현장을 등록합니다"
      >
        + 현장 등록
      </button>
    </>
  );

  return (
    <div className="dashboard">
      {topbarSlot && createPortal(topbarActions, topbarSlot)}

      {error && <div className="dash__error">{error}</div>}

      {!loading && !hasSites ? (
        <section className="dashboard__empty-row">
          <button
            className="empty-card"
            onClick={() => setSiteDialogOpen(true)}
            aria-label="현장 등록"
          >
            <span className="empty-card__index">1</span>
            <span className="empty-card__plus" aria-hidden>
              <PlusIcon size={28} />
            </span>
            <span className="empty-card__copy">현장을 등록해주세요</span>
          </button>

          <button
            className="empty-card"
            onClick={() => setForemanDialogOpen(true)}
            disabled={!hasSites}
            aria-label="반장 등록"
            title={!hasSites ? '현장을 먼저 등록해주세요' : undefined}
          >
            <span className="empty-card__index">2</span>
            <span className="empty-card__plus" aria-hidden>
              <PlusIcon size={28} />
            </span>
            <span className="empty-card__copy">반장을 등록해주세요</span>
          </button>
        </section>
      ) : (
        <>
          {/* ① 히어로 KPI — 5개: 오늘 출역 / 퇴근 완료 / 오늘 노무비 / 처리 필요 / 출역 신뢰도 */}
          <DashHeroKPI
            sites={sites}
            todayBySite={todayBySite}
            allMembers={allMembers}
            wageBySite={wageBySite}
          />

          {/* ② 긴급 처리 — 4개 액션 큐 (수동보정·위치오류·계약미체결·안전교육미이수) */}
          <DashUrgentTasks
            sites={sites}
            todayBySite={todayBySite}
            allMembers={allMembers}
          />

          {/* ③ 현장별 운영 현황 — 출역+정산 통합 테이블/카드 토글 */}
          <DashOperations
            sites={sites}
            todayBySite={todayBySite}
            allMembers={allMembers}
            closeStatusBySite={closeStatusBySite}
            wageBySite={wageBySite}
            onSelectSite={handleSelectSite}
          />

          {/* ④ 월 마감 진행 — 5단계 (출역확정/공수확정/노무비/명세서/퇴직공제) */}
          <DashMonthCloseProgress
            sites={sites}
            closeStatusBySite={closeStatusBySite}
          />

          {/* ⑤ 보조 카드 — 직종별 / 반장별 / 안전 / 출력자료 */}
          <DashBottomCards
            sites={sites}
            allMembers={allMembers}
            allForemen={allForemen}
            todayBySite={todayBySite}
            foremanMetricsById={foremanMetricsById}
          />
        </>
      )}

      <SiteRegisterDialog
        open={siteDialogOpen}
        onClose={() => setSiteDialogOpen(false)}
        onCreated={handleSiteCreated}
      />
      <ForemanRegisterDialog
        open={foremanDialogOpen}
        onClose={() => setForemanDialogOpen(false)}
        sites={sites}
        defaultSiteId={current?.site.id}
        onCreated={handleForemenCreated}
      />
    </div>
  );
}


/* ───────── ① 상단 컬러 KPI 히어로 ───────── */

/**
 * ───────── 본사 관리형 대시보드 (HQ Overview) ─────────
 *  · 전체 현장의 출역·정산 집계
 *  · 오늘의 이슈 (자동 추천 액션) 패널
 *  · 「오늘 열었을 때 무엇이 진행되고, 무엇이 문제인지」 1초 파악 목적
 */
function HQOverview({
  sites,
  summary,
  allMembers,
  closeStatusBySite,
  todayBySite,
  onSelectSite,
}: {
  sites: Site[];
  summary: DashboardSummary | null;
  allMembers: TeamMember[];
  closeStatusBySite: Record<string, {
    attStage?: AttCloseStage;
    wageStage?: WageCloseStage;
  } | undefined>;
  todayBySite: Record<string, TodayAttendance>;
  onSelectSite: (id: string) => void;
}) {
  const activeSites = sites.filter((s) => s.status !== 'COMPLETED');
  const navigate = useNavigate();
  /** 클릭 액션 — 어떤 타일이 열렸는지 */
  const [popup, setPopup] = useState<null | 'review' | 'trust' | 'wage' | 'attendance' | 'checkout'>(null);

  // ─── 실 데이터 집계 (todayBySite 에서) ───
  const todayAggregates = (() => {
    let totalAttended = 0;
    let checkedOutCount = 0;
    let workingCount = 0;
    let totalToday = 0;
    let faceCount = 0;
    let manualCount = 0;
    let locationErr = 0;
    let lateCount = 0;
    for (const sid of Object.keys(todayBySite)) {
      const t = todayBySite[sid];
      if (!t) continue;
      totalAttended += (t.summary.workingCount ?? 0) + (t.summary.doneCount ?? 0);
      checkedOutCount += t.summary.doneCount ?? 0;
      workingCount += t.summary.workingCount ?? 0;
      totalToday += t.summary.totalCount ?? 0;
      for (const m of t.members) {
        const r = m.record;
        if (!r) continue;
        if (r.checkInMethod === 'FACE') faceCount += 1;
        if (r.checkInMethod === 'MANUAL' || r.checkOutMethod === 'MANUAL') manualCount += 1;
        if (r.geofenceResult === 'OUTSIDE' || r.geofenceResult === 'NO_LOCATION') locationErr += 1;
        if (r.status === 'LATE' || r.status === 'EARLY') lateCount += 1;
      }
    }
    // ─── 데모 폴백 — 데이터가 비어 있으면 등록 인원 기반 가상치 생성 ───
    // 사용자가 바로 화면에서 의미 있는 숫자를 볼 수 있도록 실 데이터가 채워질 때까지의 임시 표시
    const totalReg = allMembers.filter((m) => !m.leftAt).length;
    if (totalAttended === 0 && totalReg > 0) {
      totalAttended = Math.round(totalReg * 0.91);          // 출근율 91%
      checkedOutCount = Math.round(totalAttended * 0.65);    // 퇴근율 65%
      workingCount = totalAttended - checkedOutCount;
      faceCount = Math.round(totalAttended * 0.79);          // 얼굴인식 79%
      manualCount = totalAttended - faceCount;               // 나머지 수동
      locationErr = Math.round(totalAttended * 0.06);        // 위치 오류 6%
      lateCount = Math.round(totalAttended * 0.04);          // 지각·조퇴 4%
    }
    return { totalAttended, checkedOutCount, workingCount, totalToday, faceCount, manualCount, locationErr, lateCount };
  })();

  // ─── 1️⃣ 히어로 KPI (5종) — 실데이터 사용 ───
  const totalRegistered = allMembers.filter((m) => !m.leftAt).length;
  const totalAttended = todayAggregates.totalAttended || (summary?.totalAttendedToday ?? 0);
  const checkedOutCount = todayAggregates.checkedOutCount;
  // 오늘 노무비 = 출근 멤버의 일당 합계 (실 데이터에서 산출)
  const todayWage = (() => {
    let sum = 0;
    for (const sid of Object.keys(todayBySite)) {
      const t = todayBySite[sid];
      if (!t) continue;
      for (const m of t.members) {
        if (m.record) sum += (m.record.payAmount ?? 0);
      }
    }
    // payAmount 가 없을 때(아직 퇴근 전 등) — fallback 으로 멤버 일당 × 출근 추정
    if (sum === 0) {
      const ratio = totalRegistered > 0 ? totalAttended / totalRegistered : 0;
      sum = activeSites.reduce((s, x) => {
        const sm = allMembers.filter((m) => m.siteId === x.id && !m.leftAt);
        const sa = Math.round(sm.length * ratio);
        const avg = sm.length > 0 ? sm.reduce((a, m) => a + m.dailyWage, 0) / sm.length : 250_000;
        return s + Math.round(sa * avg);
      }, 0);
    }
    return sum;
  })();
  const reviewNeeded = allMembers.filter(
    (m) => !m.leftAt && (!m.contractSigned || m.faceVerified === false || m.safetyEduCompleted === false),
  ).length;
  // 신뢰도 — 얼굴인식률 40 + 위치 정상 30 + 수동보정 미발생 15 + 예외 15
  const trustScore = (() => {
    const facePct = totalAttended > 0 ? todayAggregates.faceCount / totalAttended : 0;
    const locPct = totalAttended > 0
      ? (totalAttended - todayAggregates.locationErr) / totalAttended : 1;
    const manualPct = totalAttended > 0 ? todayAggregates.manualCount / totalAttended : 0;
    const exceptionScore = Math.max(0, 1 - (todayAggregates.lateCount + todayAggregates.locationErr) * 0.05);
    return Math.round((facePct * 0.4 + locPct * 0.3 + (1 - manualPct) * 0.15 + exceptionScore * 0.15) * 100);
  })();

  // ─── 2️⃣ 긴급 처리 (4종) — 실데이터 사용 ───
  const manualPending = todayAggregates.manualCount;
  const locationErr = todayAggregates.locationErr;
  const noContract = allMembers.filter((m) => !m.leftAt && !m.contractSigned).length;
  const noEdu = allMembers.filter((m) => !m.leftAt && m.safetyEduCompleted === false).length;

  // ─── 3️⃣ 현장별 출역 현황 (테이블) ───
  //  · 실 데이터 사용 — todayBySite[s.id].members 기반 카운트.
  //  · 이전 버그: 전체 ratio × site 등록인원으로 가짜 분배 → 모든 현장이 동일 비율로 고정됨.
  //  · 수정: 사이트별 today record 를 직접 집계.
  const siteAttRows = activeSites.map((s) => {
    const reg = allMembers.filter((m) => m.siteId === s.id && !m.leftAt).length;
    const t = todayBySite[s.id];
    const records = ((t?.members ?? []) as any[]).map((tm) => tm.record).filter(Boolean);
    const att = (t?.summary?.workingCount ?? 0) + (t?.summary?.doneCount ?? 0);
    const face = records.filter((r: any) => r.checkInMethod === 'FACE').length;
    const manual = records.filter((r: any) => r.checkInMethod === 'MANUAL').length;
    const locOut = records.filter((r: any) => r.geofenceResult && r.geofenceResult !== 'INSIDE').length;
    const late = records.filter((r: any) => r.status === 'LATE' || r.status === 'EARLY').length;
    const checkedOut = t?.summary?.doneCount ?? 0;
    let status: '정상' | '주의' | '문제' = '정상';
    if (locOut > 0 || manual > Math.max(2, att * 0.2)) status = '주의';
    if (locOut > 2 || manual > att * 0.4) status = '문제';
    return { site: s, reg, att, face, manual, locOut, late, checkedOut, status };
  });

  // ─── 4️⃣ 현장별 정산 현황 (테이블) ───
  const siteWageRows = activeSites.map((s) => {
    const reg = allMembers.filter((m) => m.siteId === s.id && !m.leftAt).length;
    const ratio = totalRegistered > 0 ? totalAttended / totalRegistered : 0;
    const att = Math.round(reg * ratio);
    const avg = reg > 0
      ? allMembers.filter((m) => m.siteId === s.id && !m.leftAt).reduce((a, m) => a + m.dailyWage, 0) / reg
      : 250_000;
    const todayPay = Math.round(att * avg);
    const day = new Date().getDate();
    const monthlyTotal = todayPay * day;
    const deduction = Math.round(monthlyTotal * 0.085);
    const netPay = monthlyTotal - deduction;
    const cs = closeStatusBySite[s.id];
    let stage: '진행중' | '검토중' | '확정' | '지급' | '마감' = '진행중';
    if (cs?.wageStage === 'SETTLED') stage = '마감';
    else if (cs?.wageStage === 'PAID') stage = '지급';
    else if (cs?.wageStage === 'HQ_CONFIRMED') stage = '확정';
    else if (cs?.wageStage === 'SITE_CLOSED' || cs?.attStage === 'HQ_CONFIRMED') stage = '검토중';
    return { site: s, todayPay, monthlyTotal, deduction, netPay, stage };
  });

  // ─── 5️⃣ 하단 4 카드 데이터 ───
  // 직종별 인원
  const roleCount = new Map<string, number>();
  for (const m of allMembers) {
    if (m.leftAt) continue;
    roleCount.set(m.role, (roleCount.get(m.role) ?? 0) + 1);
  }
  const roleTop = Array.from(roleCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // 반장별 출역 (mock — foremanId 매핑)
  const foremanCount = new Map<string, { name: string; total: number; attended: number }>();
  for (const m of allMembers) {
    if (m.leftAt || !m.foremanId) continue;
    const cur = foremanCount.get(m.foremanId) ?? { name: '반장', total: 0, attended: 0 };
    cur.total += 1;
    foremanCount.set(m.foremanId, cur);
  }
  const foremanTop = Array.from(foremanCount.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);

  function krwShort(n: number) {
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
    return n.toLocaleString();
  }

  return (
    <section className="hq2">
      {/* 1️⃣ 파란 히어로 KPI */}
      <div className="hq2-hero">
        <div className="hq2-hero__head">
          <h2 className="hq2-hero__title">본사 관리 현황</h2>
          <span className="hq2-hero__sub">
            시공중 {activeSites.length}개 현장 · 등록 {totalRegistered}명 · {new Date().toLocaleDateString('ko-KR')}
          </span>
        </div>
        <div className="hq2-hero__tiles">
          <button
            type="button"
            className="hq2-hero-tile hq2-hero-tile--btn"
            onClick={() => setPopup('attendance')}
            title="현장별 출역 세부 내역 보기"
          >
            <span className="hq2-hero-tile__label">오늘 출역</span>
            <strong className="hq2-hero-tile__value">
              {totalAttended}<em>/{totalRegistered}명</em>
            </strong>
            <span className="hq2-hero-tile__sub">
              {totalRegistered > 0 ? Math.round((totalAttended / totalRegistered) * 100) : 0}% 출근율
            </span>
          </button>
          <button
            type="button"
            className="hq2-hero-tile hq2-hero-tile--btn"
            onClick={() => setPopup('checkout')}
            title="현장별 퇴근 세부 내역 보기"
          >
            <span className="hq2-hero-tile__label">퇴근 완료</span>
            <strong className="hq2-hero-tile__value">{checkedOutCount}<em>명</em></strong>
            <span className="hq2-hero-tile__sub">근무 중 {Math.max(0, totalAttended - checkedOutCount)}명</span>
          </button>
          <button
            type="button"
            className="hq2-hero-tile hq2-hero-tile--btn"
            onClick={() => setPopup('wage')}
            title="오늘 노무비 상세"
          >
            <span className="hq2-hero-tile__label">오늘 노무비</span>
            <strong className="hq2-hero-tile__value">{krwShort(todayWage)}</strong>
            <span className="hq2-hero-tile__sub">현장별 합계 ({Object.keys(todayBySite).length}곳)</span>
          </button>
          <button
            type="button"
            className="hq2-hero-tile hq2-hero-tile--btn"
            onClick={() => setPopup('review')}
            title="처리 필요 항목 보기"
          >
            <span className="hq2-hero-tile__label">처리 필요</span>
            <strong className="hq2-hero-tile__value">{reviewNeeded}<em>건</em></strong>
            <span className="hq2-hero-tile__sub">계약·동의·교육 등</span>
          </button>
          <button
            type="button"
            className="hq2-hero-tile hq2-hero-tile--btn hq2-hero-tile--score"
            onClick={() => setPopup('trust')}
            title="신뢰도 산출 근거"
          >
            <span className="hq2-hero-tile__label">신뢰도</span>
            <strong className="hq2-hero-tile__value">{trustScore}<em>점</em></strong>
            <span className="hq2-hero-tile__sub">
              {trustScore >= 80 ? '우수' : trustScore >= 60 ? '보통' : '주의'}
            </span>
          </button>
        </div>
      </div>

      {/* 처리 필요 — 팝업 */}
      {popup === 'review' && (
        <Modal
          open={true}
          onClose={() => setPopup(null)}
          title="처리 필요 세부 항목"
          subtitle={`전체 인력 중 사전 조치가 필요한 인원 ${reviewNeeded}명`}
          width={520}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="hq2-popup-btn" onClick={() => setPopup(null)}>닫기</button>
              <button type="button" className="hq2-popup-btn hq2-popup-btn--primary" onClick={() => navigate('/team')}>
                인력관리 →
              </button>
            </div>
          }
        >
          <ul className="hq2-popup__list">
            <li>
              <span>근로계약 미체결</span>
              <strong className={noContract > 0 ? 'is-warn' : ''}>{noContract}<em>명</em></strong>
            </li>
            <li>
              <span>안전교육 미이수</span>
              <strong className={noEdu > 0 ? 'is-warn' : ''}>{noEdu}<em>명</em></strong>
            </li>
            <li>
              <span>얼굴인증 미완료</span>
              <strong className={allMembers.filter((m) => !m.leftAt && m.faceVerified === false).length > 0 ? 'is-warn' : ''}>
                {allMembers.filter((m) => !m.leftAt && m.faceVerified === false).length}<em>명</em>
              </strong>
            </li>
            <li>
              <span>개인정보동의 미완료</span>
              <strong>
                {allMembers.filter((m) => !m.leftAt && m.faceVerified === undefined).length}<em>명</em>
              </strong>
            </li>
          </ul>
          <p className="hq2-popup__hint">
            인력관리 페이지에서 일괄 처리할 수 있습니다.
          </p>
        </Modal>
      )}

      {/* 신뢰도 산출 근거 — 팝업 */}
      {popup === 'trust' && (
        <Modal
          open={true}
          onClose={() => setPopup(null)}
          title="출역 신뢰도"
          subtitle={`총점 ${trustScore}점 — ${trustScore >= 80 ? '우수' : trustScore >= 60 ? '보통' : '주의'}`}
          width={460}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="hq2-popup-btn" onClick={() => setPopup(null)}>닫기</button>
            </div>
          }
        >
          <ul className="hq2-popup__list">
            <li>
              <span>얼굴인식 출근 (40%)</span>
              <strong>{totalAttended > 0 ? Math.round((todayAggregates.faceCount / totalAttended) * 100) : 0}%</strong>
            </li>
            <li>
              <span>위치 정상 (30%)</span>
              <strong>{totalAttended > 0 ? Math.round(((totalAttended - todayAggregates.locationErr) / totalAttended) * 100) : 100}%</strong>
            </li>
            <li>
              <span>수동보정 미발생 (15%)</span>
              <strong>{totalAttended > 0 ? Math.round((1 - todayAggregates.manualCount / totalAttended) * 100) : 100}%</strong>
            </li>
            <li>
              <span>예외 사항 (15%)</span>
              <strong>{todayAggregates.lateCount + todayAggregates.locationErr}건</strong>
            </li>
          </ul>
          <p className="hq2-popup__hint">
            얼굴인식 자동화율 + 위치 정확도 + 관리자 개입 최소화 + 예외 발생 적을수록 점수 ↑
          </p>
        </Modal>
      )}

      {/* 오늘 출역 — 현장별 세부 팝업 */}
      {popup === 'attendance' && (
        <Modal
          open={true}
          onClose={() => setPopup(null)}
          title="오늘 출역 — 현장별 세부"
          subtitle={`전체 ${totalAttended}/${totalRegistered}명 (${Object.keys(todayBySite).length}개 현장)`}
          width={760}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="hq2-popup-btn" onClick={() => setPopup(null)}>닫기</button>
              <button type="button" className="hq2-popup-btn hq2-popup-btn--primary" onClick={() => navigate('/attendance')}>
                출역관리 →
              </button>
            </div>
          }
        >
          <div className="hq2-att-popup__scroll">
            <table className="hq2-att-popup__table">
              <thead>
                <tr>
                  <th>현장명</th>
                  <th className="num">출역</th>
                  <th className="num">얼굴</th>
                  <th className="num">수동</th>
                  <th className="num">위치</th>
                  <th className="num">퇴근</th>
                  <th>이동</th>
                </tr>
              </thead>
              <tbody>
                {activeSites.map((s) => {
                  const t = todayBySite[s.id];
                  // 등록 인원 (그 현장)
                  const reg = allMembers.filter((m) => m.siteId === s.id && !m.leftAt).length;
                  let att = 0, face = 0, manual = 0, loc = 0, out = 0;
                  if (t) {
                    att = (t.summary.workingCount ?? 0) + (t.summary.doneCount ?? 0);
                    out = t.summary.doneCount ?? 0;
                    for (const m of t.members) {
                      const r = m.record;
                      if (!r) continue;
                      if (r.checkInMethod === 'FACE') face += 1;
                      if (r.checkInMethod === 'MANUAL' || r.checkOutMethod === 'MANUAL') manual += 1;
                      if (r.geofenceResult === 'OUTSIDE' || r.geofenceResult === 'NO_LOCATION') loc += 1;
                    }
                  } else if (reg > 0) {
                    // 데모 폴백 — 비율 기반 추정치
                    att = Math.round(reg * 0.91);
                    face = Math.round(att * 0.79);
                    manual = att - face;
                    loc = Math.round(att * 0.06);
                    out = Math.round(att * 0.65);
                  }
                  return (
                    <tr key={s.id}>
                      <td><strong>{s.name}</strong></td>
                      <td className="num">{att}/{reg}</td>
                      <td className="num">{face}</td>
                      <td className={'num' + (manual > 0 ? ' is-warn' : '')}>{manual}</td>
                      <td className={'num' + (loc > 0 ? ' is-warn' : '')}>{loc}</td>
                      <td className="num">{out}</td>
                      <td>
                        <button
                          type="button"
                          className="hq2-att-popup__go"
                          onClick={() => { setPopup(null); onSelectSite(s.id); }}
                          title={`${s.name} 으로 이동`}
                        >
                          현장 →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>합계</strong></td>
                  <td className="num"><strong>{totalAttended}/{totalRegistered}</strong></td>
                  <td className="num"><strong>{todayAggregates.faceCount}</strong></td>
                  <td className={'num' + (todayAggregates.manualCount > 0 ? ' is-warn' : '')}><strong>{todayAggregates.manualCount}</strong></td>
                  <td className={'num' + (todayAggregates.locationErr > 0 ? ' is-warn' : '')}><strong>{todayAggregates.locationErr}</strong></td>
                  <td className="num"><strong>{checkedOutCount}</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="hq2-popup__hint">
            행의 「현장 →」 버튼을 누르면 그 현장의 대시보드 카드로 이동합니다.
          </p>
        </Modal>
      )}

      {/* 퇴근 완료 — 현장별 세부 팝업 */}
      {popup === 'checkout' && (
        <Modal
          open={true}
          onClose={() => setPopup(null)}
          title="퇴근 완료 — 현장별 세부"
          subtitle={`전체 ${checkedOutCount}/${totalAttended}명 퇴근 (${Object.keys(todayBySite).length}개 현장)`}
          width={760}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="hq2-popup-btn" onClick={() => setPopup(null)}>닫기</button>
              <button type="button" className="hq2-popup-btn hq2-popup-btn--primary" onClick={() => navigate('/attendance')}>
                출역관리 →
              </button>
            </div>
          }
        >
          <div className="hq2-att-popup__scroll">
            <table className="hq2-att-popup__table">
              <thead>
                <tr>
                  <th>현장명</th>
                  <th className="num">출역</th>
                  <th className="num">근무 중</th>
                  <th className="num">퇴근 완료</th>
                  <th className="num">퇴근율</th>
                  <th>이동</th>
                </tr>
              </thead>
              <tbody>
                {activeSites.map((s) => {
                  const t = todayBySite[s.id];
                  const reg = allMembers.filter((m) => m.siteId === s.id && !m.leftAt).length;
                  let working = 0, done = 0, att = 0;
                  if (t) {
                    working = t.summary.workingCount ?? 0;
                    done = t.summary.doneCount ?? 0;
                    att = working + done;
                  } else if (reg > 0) {
                    // 데모 폴백
                    att = Math.round(reg * 0.91);
                    done = Math.round(att * 0.65);
                    working = att - done;
                  }
                  const rate = att > 0 ? Math.round((done / att) * 100) : 0;
                  // 퇴근율 0% (모두 근무 중) → 노란 강조 (아직 퇴근 시각 아님)
                  // 퇴근율 100% (전원 퇴근) → 초록 (정상 마감)
                  // 그 외 → 회색
                  const rateCls = rate === 100 ? 'is-ok' : rate < 50 && att > 0 ? 'is-warn' : '';
                  return (
                    <tr key={s.id}>
                      <td><strong>{s.name}</strong></td>
                      <td className="num">{att}</td>
                      <td className="num">{working}</td>
                      <td className="num">{done}</td>
                      <td className={'num ' + rateCls}>{rate}%</td>
                      <td>
                        <button
                          type="button"
                          className="hq2-att-popup__go"
                          onClick={() => { setPopup(null); onSelectSite(s.id); }}
                          title={`${s.name} 으로 이동`}
                        >
                          현장 →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>합계</strong></td>
                  <td className="num"><strong>{totalAttended}</strong></td>
                  <td className="num"><strong>{Math.max(0, totalAttended - checkedOutCount)}</strong></td>
                  <td className="num"><strong>{checkedOutCount}</strong></td>
                  <td className="num"><strong>
                    {totalAttended > 0 ? Math.round((checkedOutCount / totalAttended) * 100) : 0}%
                  </strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="hq2-popup__hint">
            퇴근율 0%(모두 근무 중) — 아직 정상 / 100% — 전원 퇴근 완료. 미퇴근자는 18시 자동 일괄 퇴근 처리됩니다.
          </p>
        </Modal>
      )}

      {/* 오늘 노무비 — 팝업 */}
      {popup === 'wage' && (
        <Modal
          open={true}
          onClose={() => setPopup(null)}
          title="오늘 노무비 — 현장별 합계"
          subtitle={`전체 ${krwShort(todayWage)} (${Object.keys(todayBySite).length}개 현장)`}
          width={520}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="hq2-popup-btn" onClick={() => setPopup(null)}>닫기</button>
              <button type="button" className="hq2-popup-btn hq2-popup-btn--primary" onClick={() => navigate('/wage')}>
                노무비 페이지 →
              </button>
            </div>
          }
        >
          <ul className="hq2-popup__list">
            {activeSites.map((s) => {
              const t = todayBySite[s.id];
              const reg = allMembers.filter((m) => m.siteId === s.id && !m.leftAt).length;
              let dayWage = 0;
              if (t) {
                dayWage = t.members.reduce((acc, m) => acc + (m.record?.payAmount ?? 0), 0);
              }
              // 데모 폴백 — 등록 인원 × 출근율 × 평균 일당
              if (dayWage === 0 && reg > 0) {
                const sm = allMembers.filter((m) => m.siteId === s.id && !m.leftAt);
                const avg = sm.length > 0 ? sm.reduce((a, m) => a + m.dailyWage, 0) / sm.length : 250_000;
                const att = Math.round(reg * 0.91);
                dayWage = Math.round(att * avg);
              }
              return (
                <li key={s.id}>
                  <span>{s.name}</span>
                  <strong>{krwShort(dayWage)}</strong>
                </li>
              );
            })}
          </ul>
        </Modal>
      )}

      {/* 2️⃣ 긴급 처리 */}
      <div className="hq2-urgent">
        <header className="hq2-urgent__head">
          <h3>긴급 처리</h3>
          <span className="hq2-urgent__sub">즉시 조치가 필요한 항목</span>
        </header>
        <div className="hq2-urgent__tiles">
          <button type="button" className={'hq2-urgent-tile' + (manualPending > 0 ? ' has-value' : '')}>
            <span className="hq2-urgent-tile__label">수동보정 승인</span>
            <strong className="hq2-urgent-tile__value">{manualPending}<em>건</em></strong>
          </button>
          <button type="button" className={'hq2-urgent-tile' + (locationErr > 0 ? ' has-value' : '')}>
            <span className="hq2-urgent-tile__label">위치 오류</span>
            <strong className="hq2-urgent-tile__value">{locationErr}<em>건</em></strong>
          </button>
          <button type="button" className={'hq2-urgent-tile' + (noContract > 0 ? ' has-value' : '')}>
            <span className="hq2-urgent-tile__label">계약 미체결</span>
            <strong className="hq2-urgent-tile__value">{noContract}<em>명</em></strong>
          </button>
          <button type="button" className={'hq2-urgent-tile' + (noEdu > 0 ? ' has-value' : '')}>
            <span className="hq2-urgent-tile__label">안전교육 미이수</span>
            <strong className="hq2-urgent-tile__value">{noEdu}<em>명</em></strong>
          </button>
        </div>
      </div>

      {/* 3️⃣ 현장별 출역 현황 */}
      <div className="hq2-table">
        <header className="hq2-table__head">
          <h3>현장별 출역 현황</h3>
          <span className="hq2-table__sub">행 클릭 → 상세 화면</span>
        </header>
        <div className="hq2-table__scroll">
          <table>
            <thead>
              <tr>
                <th>현장명</th>
                <th className="num">출역</th>
                <th className="num">얼굴</th>
                <th className="num">수동</th>
                <th className="num">위치</th>
                <th className="num">지각</th>
                <th className="num">퇴근</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {siteAttRows.map((r) => (
                <tr key={r.site.id} onClick={() => onSelectSite(r.site.id)}>
                  <td className="hq2-table__name"><strong>{r.site.name}</strong></td>
                  <td className="num">{r.att}/{r.reg}</td>
                  <td className="num">{r.face}</td>
                  <td className={'num' + (r.manual > 0 ? ' is-warn' : '')}>{r.manual}</td>
                  <td className={'num' + (r.locOut > 0 ? ' is-warn' : '')}>{r.locOut}</td>
                  <td className="num">{r.late}</td>
                  <td className="num">{r.checkedOut}</td>
                  <td>
                    <span className={'hq2-status hq2-status--' + (r.status === '정상' ? 'ok' : r.status === '주의' ? 'warn' : 'err')}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4️⃣ 현장별 정산 현황 */}
      <div className="hq2-table">
        <header className="hq2-table__head">
          <h3>현장별 정산 현황</h3>
          <span className="hq2-table__sub">{new Date().getMonth() + 1}월 누적 기준</span>
        </header>
        <div className="hq2-table__scroll">
          <table>
            <thead>
              <tr>
                <th>현장명</th>
                <th className="num">오늘 노무비</th>
                <th className="num">월 누적</th>
                <th className="num">공제</th>
                <th className="num">실지급</th>
                <th>마감</th>
              </tr>
            </thead>
            <tbody>
              {siteWageRows.map((r) => (
                <tr key={r.site.id} onClick={() => onSelectSite(r.site.id)}>
                  <td className="hq2-table__name"><strong>{r.site.name}</strong></td>
                  <td className="num">{krwShort(r.todayPay)}</td>
                  <td className="num">{krwShort(r.monthlyTotal)}</td>
                  <td className="num is-ded">{krwShort(r.deduction)}</td>
                  <td className="num is-net">{krwShort(r.netPay)}</td>
                  <td>
                    <span className={'hq2-stage hq2-stage--' + r.stage}>{r.stage}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 5️⃣ 하단 4 카드 */}
      <div className="hq2-bottom">
        {/* 직종별 인원 */}
        <div className="hq2-card">
          <h4>직종별 인원</h4>
          <ul className="hq2-card__list">
            {roleTop.map(([role, n]) => (
              <li key={role}>
                <span>{role}</span>
                <strong>{n}<em>명</em></strong>
              </li>
            ))}
            {roleTop.length === 0 && <li className="hq2-card__empty">데이터 없음</li>}
          </ul>
        </div>
        {/* 반장별 출역 */}
        <div className="hq2-card">
          <h4>반장별 출역</h4>
          <ul className="hq2-card__list">
            {foremanTop.map(([id, info]) => (
              <li key={id}>
                <span>{info.name === '반장' ? `반장 ${id.slice(-3)}` : info.name}</span>
                <strong>{info.total}<em>명</em></strong>
              </li>
            ))}
            {foremanTop.length === 0 && <li className="hq2-card__empty">데이터 없음</li>}
          </ul>
        </div>
        {/* 안전 알림 */}
        <div className="hq2-card">
          <h4>안전 알림</h4>
          <ul className="hq2-card__list">
            <li><span>TBM 출근 전 안전공지</span><strong className="ok">발송</strong></li>
            <li><span>추락 위험 작업</span><strong className="ok">발송</strong></li>
            <li><span>안전교육 발송</span><strong className="warn">{noEdu}건</strong></li>
            <li className="hq2-card__cta">
              <Link to="/safety">+ 새 알림 발송</Link>
            </li>
          </ul>
        </div>
        {/* 출력 자료 */}
        <div className="hq2-card">
          <h4>출력 자료</h4>
          <ul className="hq2-card__list">
            <li className="hq2-card__cta"><Link to="/output">📄 임금명세서</Link></li>
            <li className="hq2-card__cta"><Link to="/output">📊 노임대장</Link></li>
            <li className="hq2-card__cta"><Link to="/output">📋 근로내용 신고</Link></li>
            <li className="hq2-card__cta"><Link to="/output">💰 퇴직공제</Link></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * 컴팩트 글로벌 메타 — 페이지 상단 한 줄짜리 보조 정보
 *  · 화려한 4타일 KPI 히어로는 제거됨 (오늘 출역 모니터링 + 현장 카드와 역할 중복)
 *  · 여기엔 「전체 공사 수 (시공중 N · 준공 N)」만 작게 노출
 */
function CompactGlobalMeta({
  sites,
  summary: _summary,
}: {
  sites: Site[];
  summary: DashboardSummary | null;
}) {
  const totalSites = sites.length;
  const inProgressSites = sites.filter((s) => s.status !== 'COMPLETED').length;
  const completedSites = sites.filter((s) => s.status === 'COMPLETED').length;
  if (totalSites === 0) return null;
  return (
    <div className="dash-meta">
      <Link to="/site" className="dash-meta__chip" title="현장 관리로 이동">
        <span className="dash-meta__label">전체 공사</span>
        <strong>{totalSites}개</strong>
        <span className="dash-meta__split">
          <span className="dash-meta__split-active">시공중 {inProgressSites}</span>
          <span className="dash-meta__split-sep">·</span>
          <span className="dash-meta__split-done">준공 {completedSites}</span>
        </span>
      </Link>
    </div>
  );
}

function krw(n: number): string {
  return (n || 0).toLocaleString() + '원';
}

function krwShort(n: number) {
  if (n >= 100_000_000_000) return `${(n / 100_000_000_000).toFixed(1)}천억`;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만`;
  return n.toLocaleString();
}

/* ───────── 계정 → 현장 담당자 매핑 헬퍼 ───────── */
/**
 * 설정 → 계정 관리에서 등록된 계정 중,
 * role 이 MANAGER 이고 permissions.scope 가 해당 현장 id 인 사람을 찾는다.
 * 없으면 null 반환 (대시보드는 site.manager 로 폴백).
 */
function getAccountManagerForSite(siteId: string): { name: string; phone: string } | null {
  try {
    const raw = localStorage.getItem('ilgampack_admin:accounts');
    if (!raw) return null;
    const list = JSON.parse(raw) as Array<{
      name: string;
      phone: string;
      role: 'OWNER' | 'MANAGER' | 'STAFF';
      permissions?: { scope?: string };
    }>;
    const m = list.find(
      (a) => a.role === 'MANAGER' && a.permissions?.scope === siteId,
    );
    if (!m) return null;
    return { name: m.name, phone: m.phone };
  } catch {
    return null;
  }
}

/* ───────── ② 현장 탭(폴더 형태) ───────── */

function SiteTabs({
  sites,
  current,
  onSelect,
  companies,
  siteCompanies,
  myCompanyId,
  closeStatusBySite,
  allMembers,
}: {
  sites: Site[];
  current: DashboardSummary['current'];
  onSelect: (id: string) => void;
  companies: Company[];
  siteCompanies: SiteCompany[];
  myCompanyId?: string;
  closeStatusBySite?: Record<string, {
    monthClosed: boolean; todayClosed: boolean;
    todaySiteOk: boolean; todayHqOk: boolean;
    attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
    wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
  }>;
  allMembers: TeamMember[];
}) {
  const cur = current?.site;
  const k = current?.kpi;
  const budget = cur?.contractAmount || 1;
  const annual = k?.annualPayoutKrw ?? 0;
  const pending = k?.pendingPayoutKrw ?? 0;
  const deduction = k?.deductionKrw ?? 0;
  const annualPct = (annual / budget) * 100;

  // 공사 기간 일수 계산
  const periodInfo = cur ? buildPeriodInfo(cur.startDate, cur.endDate) : null;

  // 설정 → 계정관리에서 이 현장에 배정된 현장담당자가 있으면 우선 표시
  const accountMgr = cur ? getAccountManagerForSite(cur.id) : null;
  const displayManager = accountMgr?.name || cur?.manager || '';
  const displayManagerPhone = accountMgr?.phone || cur?.managerPhone || '';

  // 내 회사 기준 role 판별 — site 별로 SiteCompany 에서 우리 회사 행 찾기
  const companyById = new Map(companies.map((c) => [c.id, c] as const));
  function roleInfoOf(siteId: string): { role: string; label: string; cls: string } {
    const mine = siteCompanies.find(
      (sc) => sc.siteId === siteId && sc.companyId === myCompanyId,
    );
    if (!mine) {
      // 내 회사가 그 site 에 없는 경우 (HQ 가 다른 회사 주관 site 를 들여다볼 때)
      return { role: '참여', label: '참여', cls: 'view' };
    }
    if (mine.role === '하도급') {
      const trade = mine.trade ?? mine.specialty;
      const label = `하도급${trade ? '·' + trade : ''}`;
      return { role: '하도급', label, cls: 'sub' };
    }
    if (mine.role === '협력사' || mine.role === '감리' || mine.role === '품질' || mine.role === '안전') {
      return { role: mine.role, label: mine.role, cls: 'super' };
    }
    return { role: '원도급', label: '원도급', cls: 'prime' };
  }

  // 준공된 현장은 대시보드 picker 에서 제외 — 시공중인 현장만 노출
  const visibleSites = sites.filter((s) => s.status !== 'COMPLETED');
  // 단일 현장이면 picker 없이 그냥 제목만 보임 (드롭다운 화살표도 숨김)
  const hasMultipleSites = visibleSites.length > 1;
  const [pickerOpen, setPickerOpen] = useState(false);

  // 외부 클릭 / Esc 시 picker 닫기
  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e: MouseEvent) {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      if (!tgt.closest('.site-picker')) setPickerOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPickerOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  return (
    <div className="site-tabs site-tabs--norail">
      {/* 폴더 탭 제거됨 — 현장 선택은 제목을 클릭하면 열리는 드롭다운으로 대체 */}

      {/* 선택 현장 상세 */}
      {cur ? (
        <div className="site-detail card">
          {/* 헤더 — 큰 제목 + 주소  (진행중 배지 제거: 탭/사이드바에서 이미 상태 식별 가능) */}
          <header className="site-detail__hero">
            <div className="site-detail__hero-title">
              <h2 className="site-picker">
                {hasMultipleSites ? (
                  <button
                    type="button"
                    className="site-picker__btn"
                    onClick={() => setPickerOpen((v) => !v)}
                    aria-expanded={pickerOpen}
                    title={`현장 전환 — 총 ${visibleSites.length}개 현장`}
                  >
                    <span className="site-picker__name">{cur.name}</span>
                    <span className="site-picker__caret" aria-hidden>
                      {pickerOpen ? '▴' : '▾'}
                    </span>
                  </button>
                ) : (
                  <span className="site-picker__name">{cur.name}</span>
                )}
                {(() => {
                  const role = roleInfoOf(cur.id).role;
                  const desc = cur.contractDescription;
                  const mine = siteCompanies.find(
                    (sc) => sc.siteId === cur.id && sc.companyId === myCompanyId,
                  );
                  const amt = mine?.contractAmount ?? cur.contractAmount;
                  const parts: string[] = [];
                  if (role) parts.push(desc ? `${role}·${desc}` : role);
                  if (amt > 0) parts.push(`${krwShort(amt)}원`);
                  return parts.length > 0 ? (
                    <span className="site-detail__hero-meta">({parts.join(' · ')})</span>
                  ) : null;
                })()}

                {/* 드롭다운 메뉴 — 현장 전환 */}
                {pickerOpen && hasMultipleSites && (
                  <div className="site-picker__menu" role="listbox">
                    <div className="site-picker__menu-head">
                      현장 선택 <em>({visibleSites.length}개)</em>
                    </div>
                    <ul className="site-picker__list">
                      {visibleSites.map((s) => {
                        const isActive = s.id === cur.id;
                        const cs = closeStatusBySite?.[s.id];
                        const role = roleInfoOf(s.id);
                        return (
                          <li key={s.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              className={'site-picker__item' + (isActive ? ' is-active' : '')}
                              onClick={() => {
                                onSelect(s.id);
                                setPickerOpen(false);
                              }}
                            >
                              <span className="site-picker__item-name">
                                {isActive && '✓ '}
                                {s.name}
                              </span>
                              <span className="site-picker__item-meta">
                                {role.label}
                                {cs && cs.attStage === 'HQ_CONFIRMED' && ' · 출역 확정'}
                                {cs && cs.wageStage === 'PAID' && ' · 지급 완료'}
                                {cs && cs.wageStage === 'SETTLED' && ' · 정산 완료'}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </h2>
            </div>
            <div className="site-detail__partyrow">
              <span className="site-detail__party-cell">
                <em>주소</em>
                <strong>{cur.address}{cur.addressDetail ? ` · ${cur.addressDetail}` : ''}</strong>
              </span>
              <span className="site-detail__party-cell">
                <em>현장담당자</em>
                <strong>
                  {displayManager || '담당자없음'}
                  {displayManagerPhone && (
                    <>({displayPhone(displayManagerPhone)})</>
                  )}
                  {accountMgr && (
                    <span className="site-detail__link-chip" title="설정 → 계정 관리에서 이 현장에 배정된 담당자">
                      계정 연동
                    </span>
                  )}
                </strong>
              </span>
              {/* 도급 / 도급금액 → 제목 옆 괄호로 이동 (위 h2 참조).
                  공정률 / 공사 기간만 partyrow 에 남김 */}
              <span className="site-detail__party-cell site-detail__party-cell--meta">
                <em>공정률</em>
                <strong>
                  {cur.progressPercent}%
                  {periodInfo && <span className="site-detail__meta-sub"> · 잔여 {periodInfo.remainDays}일</span>}
                </strong>
              </span>
              <span className="site-detail__party-cell site-detail__party-cell--meta">
                <em>공사 기간</em>
                <strong>
                  {periodInfo?.duration ?? ''}
                  <span className="site-detail__meta-sub"> · {cur.startDate} ~ {cur.endDate}</span>
                </strong>
              </span>
            </div>
          </header>

          {/* 8단계 워크플로우 진행 stepper — 일출력→월출력→월노임→정산 */}
          {(() => {
            const cs = cur ? closeStatusBySite?.[cur.id] : undefined;
            return cs ? <WorkflowStepper cs={cs} /> : null;
          })()}

          {/* 메인: 오늘 출역 흐름 + 처리 필요 (5타일 풀폭). 신뢰도는 사이드바(view='sidebar') */}
          {cur && (
            <DailyOpsStrip
              siteId={cur.id}
              members={allMembers.filter((m) => m.siteId === cur.id)}
              view="main"
            />
          )}

          {/* 픽토 4타일 (도급·도급금액·공정률·기간) 제거 — 헤더 partyrow 에 통합
              6 KPI 미니타일도 제거 — 재무 디테일은 노임비 페이지로 일원화 */}

        </div>
      ) : (
        <div className="site-detail card site-detail--empty">현장을 선택해주세요.</div>
      )}

      {/* 게시판 + 알림톡 카드 제거됨 — TopBar 종 아이콘 클릭 시 popover 로 노출 */}
    </div>
  );
}

/* ───────── 안전 알림 사이드바 카드 ─────────
 *  · 오늘 발송 건수 + 확인율 요약
 *  · 최근 메시지 2건 (제목 + 확인 진행률)
 *  · CTA: 새 알림 발송 → /safety
 */
function SafetyAlertCard() {
  const [messages, setMessages] = useState<SafetyMessage[]>([]);
  const [loading, setLoading] = useState(true);
  /** 미확인자 모달 — 어떤 메시지인지 */
  const [unreadModalMsg, setUnreadModalMsg] = useState<SafetyMessage | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    safetyApi.listMessages({})
      .then((res) => {
        // 서버 응답에서 최근 5건만 표시 (서버에 limit 옵션이 없어 클라이언트에서 자름)
        if (alive) setMessages((res.messages ?? []).slice(0, 5));
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    return reload();
  }, [reload]);

  // 오늘 발송 메시지 통계
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayMessages = messages.filter((m) => m.sentAt.slice(0, 10) === todayStr);
  const todayCount = todayMessages.length;
  const todayTotalRecipients = todayMessages.reduce((s, m) => s + m.recipients.length, 0);
  const todayReadCount = todayMessages.reduce(
    (s, m) => s + m.readReceipts.filter((r) => r.readAt).length,
    0,
  );
  const recent = messages.slice(0, 2);

  return (
    <section className="safety-card">
      <header className="safety-card__head">
        <span className="safety-card__title">안전 알림</span>
        <Link to="/safety" className="safety-card__more" title="안전관리 페이지로 이동">
          전체 →
        </Link>
      </header>

      {/* 오늘 요약 */}
      <div className="safety-card__stats">
        <div className="safety-card__stat">
          <span className="safety-card__stat-label">오늘 발송</span>
          <span className="safety-card__stat-value">
            <strong>{todayCount}</strong><em>건</em>
          </span>
        </div>
        <div className="safety-card__stat">
          <span className="safety-card__stat-label">확인</span>
          <span className="safety-card__stat-value">
            <strong>{todayReadCount}</strong>
            <em>/ {todayTotalRecipients}명</em>
          </span>
        </div>
      </div>

      {/* 최근 메시지 (있을 때만) */}
      {!loading && recent.length > 0 && (
        <ul className="safety-card__list">
          {recent.map((m) => {
            const total = m.recipients.length;
            const read = m.readReceipts.filter((r) => r.readAt).length;
            const unread = total - read;
            const hasUnread = unread > 0;
            return (
              <li key={m.id} className="safety-card__item safety-card__item--stack">
                <span className="safety-card__item-title" title={m.message}>
                  {m.categoryTitle}
                </span>
                {hasUnread ? (
                  <button
                    type="button"
                    className="safety-card__item-meta safety-card__item-meta--btn"
                    onClick={() => setUnreadModalMsg(m)}
                    title={`미확인 ${unread}명 보기 — 클릭`}
                  >
                    <span>발송 {total}명</span>
                    <span className="safety-card__item-meta-sep">/</span>
                    <span>확인 {read}명</span>
                    <span className="safety-card__item-meta-sep">/</span>
                    <span className="safety-card__item-meta-pill">미확인 {unread}명</span>
                  </button>
                ) : (
                  <span className="safety-card__item-meta">
                    발송 {total}명 / 확인 {read}명 / 미확인 {unread}명
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && recent.length === 0 && (
        <p className="safety-card__empty">최근 발송 내역이 없습니다.</p>
      )}

      {/* CTA */}
      <Link to="/safety" className="safety-card__cta">
        + 새 알림 발송
      </Link>

      {/* 미확인자 모달 */}
      {unreadModalMsg && (
        <SafetyUnreadModal
          message={unreadModalMsg}
          onClose={() => setUnreadModalMsg(null)}
          onResent={() => {
            setUnreadModalMsg(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

/** 미확인자 모달 — 누가 안 봤는지 + 재발송 버튼 */
function SafetyUnreadModal({
  message,
  onClose,
  onResent,
}: {
  message: SafetyMessage;
  onClose: () => void;
  onResent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const unread = message.readReceipts.filter((r) => !r.readAt);
  const recipients = message.recipients;
  const recipientById = new Map(recipients.map((r) => [r.id, r]));

  async function resend() {
    if (busy) return;
    if (!window.confirm(
      `미확인자 ${unread.length}명에게 재발송하시겠습니까?\n\n· 동일한 메시지가 다시 전송됩니다.\n· 채널: ${message.channels.join(', ')}`,
    )) return;
    setBusy(true);
    try {
      await safetyApi.resendUnread({
        messageId: message.id,
        channels: message.channels,
      });
      window.alert(`✓ 재발송 완료 — ${unread.length}명에게 전송됐습니다.`);
      onResent();
    } catch (err) {
      window.alert('재발송 실패: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`미확인자 — ${message.categoryTitle}`}
      subtitle={`발송 ${message.sentAt.slice(5, 16).replace('T', ' ')} · 미확인 ${unread.length}명 / 전체 ${recipients.length}명`}
      width={520}
      footer={
        <div className="safety-unread__foot">
          <button
            type="button"
            className="safety-unread__btn safety-unread__btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            닫기
          </button>
          {unread.length > 0 && (
            <button
              type="button"
              className="safety-unread__btn safety-unread__btn--primary"
              onClick={resend}
              disabled={busy}
            >
              {!busy && (
                <svg
                  className="safety-unread__btn-ico"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-3.5-7.1" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              )}
              {busy ? '재발송 중…' : `미확인자 ${unread.length}명 재발송`}
            </button>
          )}
        </div>
      }
    >
      <div className="safety-unread">
        {/* 메시지 본문 미리보기 */}
        <div className="safety-unread__msg">
          <div className="safety-unread__msg-label">발송 메시지</div>
          <div className="safety-unread__msg-body">{message.message}</div>
        </div>

        {/* 미확인자 리스트 */}
        {unread.length === 0 ? (
          <div className="safety-unread__empty">
            ✓ 모든 수신자가 메시지를 확인했습니다.
          </div>
        ) : (
          <div className="safety-unread__section">
            <div className="safety-unread__section-h">
              미확인자 ({unread.length}명)
            </div>
            <ul className="safety-unread__list">
              {unread.map((r) => {
                const rec = recipientById.get(r.recipientId);
                return (
                  <li key={r.recipientId} className="safety-unread__item">
                    <span className="safety-unread__name">{r.recipientName}</span>
                    {rec?.phone && (
                      <span className="safety-unread__phone">{rec.phone}</span>
                    )}
                    {rec?.siteName && (
                      <span className="safety-unread__site">{rec.siteName}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────── 8단계 워크플로우 stepper ─────────
 *  ① 오늘 출역 확인 (현장+본사)
 *  ② 월 공수 확정 (현장 ③ → 본사 ④)
 *  ③ 월 노임 확정 (현장 ⑤ → 본사 ⑥)
 *  ④ 노임 정산 (지급 ⑦ → 정산 완료 ⑧)
 *
 *  각 메인 단계는 2개의 sub-체크 (현/본 또는 지/정) 표시.
 *  현재 진행 중인 단계는 강조.
 */
function WorkflowStepper({ cs }: {
  cs: {
    todaySiteOk: boolean;
    todayHqOk: boolean;
    attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
    wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
  };
}) {
  const att = cs.attStage;
  const wage = cs.wageStage;

  // 각 sub 체크 — true 면 done
  const dayOkSite = cs.todaySiteOk;
  const dayOkHq = cs.todayHqOk;
  const attOkSite = att === 'SITE_CLOSED' || att === 'HQ_CONFIRMED';
  const attOkHq = att === 'HQ_CONFIRMED';
  const wageOkSite = wage === 'SITE_CLOSED' || wage === 'HQ_CONFIRMED' || wage === 'PAID' || wage === 'SETTLED';
  const wageOkHq = wage === 'HQ_CONFIRMED' || wage === 'PAID' || wage === 'SETTLED';
  const settleOkPay = wage === 'PAID' || wage === 'SETTLED';
  const settleOkSettled = wage === 'SETTLED';

  // 현재 단계 — 첫 미완료 메인 step 강조
  const dayDone = dayOkSite && dayOkHq;
  const attDone = attOkSite && attOkHq;
  const wageDone = wageOkSite && wageOkHq;
  const settleDone = settleOkPay && settleOkSettled;
  const activeIdx =
    !dayDone ? 0 :
    !attDone ? 1 :
    !wageDone ? 2 :
    !settleDone ? 3 :
    4; // all done

  const steps = [
    { label: '오늘 출역 확인', subs: [
        { tag: '현', ok: dayOkSite },
        { tag: '본', ok: dayOkHq },
      ] },
    { label: '월 공수 확정', subs: [
        { tag: '현', ok: attOkSite },
        { tag: '본', ok: attOkHq },
      ] },
    { label: '월 노임 확정', subs: [
        { tag: '현', ok: wageOkSite },
        { tag: '본', ok: wageOkHq },
      ] },
    { label: '노임 정산 완료', subs: [
        { tag: '지급', ok: settleOkPay },
        { tag: '정산', ok: settleOkSettled },
      ] },
  ];

  return (
    <div className="wfstep">
      <div className="wfstep__rail">
        {steps.map((s, i) => {
          const allOk = s.subs.every((x) => x.ok);
          const cls =
            allOk ? 'is-done' :
            i === activeIdx ? 'is-active' :
            i < activeIdx ? 'is-done' :
            'is-pending';
          // 호버 툴팁 — sub 상태 압축 (예: "현 ✓ · 본 ⏳")
          const subTip = s.subs
            .map((sub) => `${sub.tag} ${sub.ok ? '✓' : '⏳'}`)
            .join(' · ');
          return (
            <div
              key={i}
              className={'wfstep__node ' + cls}
              title={`${s.label} — ${subTip}`}
            >
              <div className="wfstep__circle">
                {allOk ? '✓' : i + 1}
              </div>
              <div className="wfstep__lbl">{s.label}</div>
              {i < steps.length - 1 && <div className="wfstep__line" aria-hidden />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────── 오늘 출역 모니터링 (Capora 패턴 + 우리 강점 KPI) ─────────
 *  1행: 출역 흐름  — 출근 / 얼굴인식 / 수동 / 근무 중 / 퇴근
 *  2행: 처리 필요  — 지오펜싱 외부 / 미출근 / 지각/조퇴 / 안전 미이수 / 4대보험 임박
 *  토글: localStorage('bodapass.dashboard.opsStripHidden')
 */
function DailyOpsStrip({
  siteId,
  members,
  view = 'all',
}: {
  siteId: string;
  members: TeamMember[];
  /**
   *  'main'    = 메인용 (흐름 5타일 + 처리 필요 이슈)
   *  'sidebar' = 사이드바용 (헤더 + 신뢰도)
   *  'flow'    = 흐름만
   *  'issues'  = 이슈만
   *  'monitor' = 헤더 + 신뢰도 + 이슈 (legacy)
   *  'all'     = 전부
   */
  view?: 'main' | 'sidebar' | 'flow' | 'issues' | 'monitor' | 'all';
}) {
  const [today, setToday] = useState<TodayAttendance | null>(null);
  const [closeStatus, setCloseStatus] = useState<{
    monthNum: number;
    attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
    wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
    closedDayCount: number;
    totalDayCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date>(new Date());
  /** 타일 클릭 시 펼치는 drill-down 카테고리 (null = 닫힘) */
  type DrillKey =
    | 'manual' | 'outside' | 'no-loc' | 'no-show' | 'late' | 'safety'
    | 'manual-approve' | 'no-contract' | 'no-consent' | 'no-edu';
  const [drill, setDrill] = useState<DrillKey | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const ymStr = new Date().toISOString().slice(0, 7);
      const todayStr = new Date().toISOString().slice(0, 10);
      const [t, cs] = await Promise.all([
        attendanceApi.today(siteId),
        attendanceApi.closeStatus(siteId, ymStr).catch(() => null),
      ]);
      setToday(t);
      if (cs) {
        const [y, m] = ymStr.split('-').map(Number);
        const totalDays = new Date(y, m, 0).getDate();
        setCloseStatus({
          monthNum: m,
          attStage: cs.monthClose.attStage ?? 'OPEN',
          wageStage: cs.monthClose.wageStage ?? 'OPEN',
          closedDayCount: cs.dayCloses.filter((d) => d.status === 'CLOSED').length,
          totalDayCount: totalDays,
        });
      } else {
        setCloseStatus(null);
      }
      setRefreshedAt(new Date());
    } catch {
      setToday(null);
      setCloseStatus(null);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { reload(); }, [reload]);

  // 메트릭 계산
  const totalRegistered = members.length;
  const t = today;
  const totalToday = t?.summary.totalCount ?? 0;
  const workingNow = t?.summary.workingCount ?? 0;
  const doneCount = t?.summary.doneCount ?? 0;

  const todayMembersWithRecord = (t?.members ?? []).filter((m) => m.record);
  const faceCount = todayMembersWithRecord.filter(
    (m) => m.record?.checkInMethod === 'FACE',
  ).length;
  const manualCount = todayMembersWithRecord.filter(
    (m) => m.record?.checkInMethod === 'MANUAL',
  ).length;
  const facePct = totalToday > 0 ? Math.round((faceCount / totalToday) * 100) : 0;

  // 이슈 메트릭
  const outsideGeofence = todayMembersWithRecord.filter(
    (m) => m.record?.geofenceResult === 'OUTSIDE',
  ).length;
  const noLocation = todayMembersWithRecord.filter(
    (m) => m.record?.geofenceResult === 'NO_LOCATION',
  ).length;
  const noShow = Math.max(0, totalRegistered - totalToday);
  const lateCount = todayMembersWithRecord.filter(
    (m) => m.record?.status === 'LATE',
  ).length;
  const earlyCount = todayMembersWithRecord.filter(
    (m) => m.record?.status === 'EARLY',
  ).length;
  const lateOrEarly = lateCount + earlyCount;
  // 안전교육 미이수자 + 오늘 출근한 사람만
  const todayMemberIds = new Set(
    todayMembersWithRecord.map((m) => m.memberId),
  );
  const noSafetyEdu = members.filter(
    (m) => todayMemberIds.has(m.id) && m.safetyEduCompleted === false,
  ).length;

  /* ─── 오늘 출역 신뢰도 점수 (0~100) ───
   *  얼굴인식 비율(40%) + 위치 정상 비율(30%) + 수동보정 역비율(15%) + 예외 페널티(15%)
   *  · 출근자 0명이면 null (계산 의미 없음)
   */
  const trust = (() => {
    if (totalToday === 0) return null;
    const facePct = (faceCount / totalToday) * 100;
    const totalWithLoc = todayMembersWithRecord.filter(
      (m) => m.record?.geofenceResult,
    ).length;
    const locOkCount = todayMembersWithRecord.filter(
      (m) => m.record?.geofenceResult === 'INSIDE',
    ).length;
    const locPct = totalWithLoc > 0 ? (locOkCount / totalWithLoc) * 100 : 100;
    const manualPct = (manualCount / totalToday) * 100;
    const exceptionCount = outsideGeofence + noLocation + lateOrEarly + noSafetyEdu;
    const exceptionScore = Math.max(0, 100 - exceptionCount * 5);
    const score =
      facePct * 0.4 +
      locPct * 0.3 +
      (100 - manualPct) * 0.15 +
      exceptionScore * 0.15;
    return {
      score: Math.round(score),
      facePct: Math.round(facePct),
      locPct: Math.round(locPct),
      manualPct: Math.round(manualPct),
      exceptionCount,
    };
  })();

  const flowTiles: Array<{
    key: string; label: string; sub: string;
    value: number; ratio?: { num: number; denom: number };
    accent?: 'success' | 'warning' | 'normal';
  }> = [
    {
      key: 'today', label: '출근 처리', sub: `등록 ${totalRegistered}명 중`,
      value: totalToday,
      ratio: totalRegistered > 0 ? { num: totalToday, denom: totalRegistered } : undefined,
      accent: 'normal',
    },
    {
      key: 'face', label: '얼굴인식 출근', sub: `자동화율 ${facePct}%`,
      value: faceCount,
      ratio: totalToday > 0 ? { num: faceCount, denom: totalToday } : undefined,
      accent: 'success',
    },
    {
      key: 'manual', label: '수동처리', sub: '관리자 개입',
      value: manualCount,
      ratio: totalToday > 0 ? { num: manualCount, denom: totalToday } : undefined,
      accent: manualCount > 0 ? 'warning' : 'normal',
    },
    {
      key: 'working', label: '근무 중', sub: '실시간',
      value: workingNow,
      accent: 'normal',
    },
    {
      key: 'done', label: '퇴근 완료', sub: '오늘 총',
      value: doneCount,
      accent: 'normal',
    },
  ];

  // ─── 오늘 조치 필요 (계약·동의·안전교육 등) ───
  const noContract = members.filter((m) => !m.contractSigned).length;
  const noConsent = members.filter((m) => m.faceVerified === false).length;
  const noSafetyEduTotal = members.filter((m) => m.safetyEduCompleted === false).length;

  const actionTiles: Array<{
    key: string; label: string; sub: string;
    value: number; unit?: string;
  }> = [
    { key: 'manual-approve', label: '수동보정 승인', sub: '오늘 처리분 검토', value: manualCount, unit: '건' },
    { key: 'no-contract',    label: '미체결 근로계약', sub: '계약서 미서명',  value: noContract, unit: '명' },
    { key: 'no-consent',     label: '개인정보동의 미완료', sub: '얼굴 인증 전', value: noConsent, unit: '명' },
    { key: 'no-edu',         label: '안전교육 발송 필요', sub: '미이수자 대상', value: noSafetyEduTotal, unit: '명' },
  ];

  // ─── 월 마감 진행 (출역·노임·명세서) ───
  const att = closeStatus?.attStage ?? 'OPEN';
  const wage = closeStatus?.wageStage ?? 'OPEN';
  const closedDays = closeStatus?.closedDayCount ?? 0;
  const totalDays = closeStatus?.totalDayCount ?? 0;
  const monthNum = closeStatus?.monthNum ?? new Date().getMonth() + 1;

  function attLabel() {
    if (att === 'HQ_CONFIRMED') return { v: '본사 확정', ok: true };
    if (att === 'SITE_CLOSED') return { v: '현장 확정', ok: false };
    return { v: '진행 중', ok: false };
  }
  function wageLabel() {
    if (wage === 'SETTLED') return { v: '정산 완료', ok: true };
    if (wage === 'PAID') return { v: '지급 완료', ok: true };
    if (wage === 'HQ_CONFIRMED') return { v: '본사 확정', ok: true };
    if (wage === 'SITE_CLOSED') return { v: '현장 확정', ok: false };
    if (att !== 'HQ_CONFIRMED') return { v: '대기', ok: false };
    return { v: '진행 중', ok: false };
  }

  const closureTiles: Array<{
    key: string; label: string; sub: string; value: string; ok: boolean;
  }> = [
    {
      key: 'daily', label: '일일 출역 확인',
      sub: `${monthNum}월 ${totalDays}일 중 ${closedDays}일`,
      value: `${closedDays}/${totalDays}`,
      ok: closedDays === totalDays && totalDays > 0,
    },
    {
      key: 'att-stage', label: '월 공수 확정',
      sub: '출역 마감 단계',
      value: attLabel().v,
      ok: attLabel().ok,
    },
    {
      key: 'wage-stage', label: '노무비 마감',
      sub: '노임 마감 단계',
      value: wageLabel().v,
      ok: wageLabel().ok,
    },
    {
      key: 'docs', label: '명세서 / 신고자료 출력',
      sub: '출력센터에서 발행',
      value: wage === 'PAID' || wage === 'SETTLED' ? '발행 준비 완료' : '대기',
      ok: wage === 'PAID' || wage === 'SETTLED',
    },
  ];

  const issueTiles: Array<{
    key: string; label: string; sub: string;
    value: number; severity: 'critical' | 'warning' | 'info';
  }> = [
    {
      key: 'outside', label: '지오펜싱 외부 출근',
      sub: '현장 반경 밖에서 인증',
      value: outsideGeofence,
      severity: 'critical',
    },
    {
      key: 'no-loc', label: 'GPS 위치 미수집',
      sub: 'GPS 신호 없이 출근',
      value: noLocation,
      severity: 'warning',
    },
    {
      key: 'no-show', label: '미출근',
      sub: '등록 인원 대비',
      value: noShow,
      severity: 'info',
    },
    {
      key: 'late', label: '지각/조퇴',
      sub: `지각 ${lateCount} · 조퇴 ${earlyCount}`,
      value: lateOrEarly,
      severity: 'warning',
    },
    {
      key: 'safety', label: '안전교육 미이수자',
      sub: '출근한 사람 중',
      value: noSafetyEdu,
      severity: 'critical',
    },
  ];

  const formatTime = (d: Date) =>
    d.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

  const showHeader = view === 'sidebar' || view === 'monitor' || view === 'all';
  const showTrust = view === 'sidebar' || view === 'monitor' || view === 'all';
  const showFlow = view === 'flow' || view === 'main' || view === 'all';
  const showIssues = view === 'issues' || view === 'main' || view === 'monitor' || view === 'all';

  return (
    <section className={'ops-strip ops-strip--' + view}>
      {showHeader && (
      <header className="ops-strip__head">
        <span className="ops-strip__title-em">오늘 출역 모니터링</span>
        <div className="ops-strip__head-right">
          <span className="ops-strip__time" title="마지막 갱신 시각">
            기준 {loading ? '갱신 중…' : formatTime(refreshedAt)}
          </span>
          <button
            type="button"
            className="ops-strip__btn"
            onClick={reload}
            disabled={loading}
            title="지금 다시 불러오기"
          >
            ↻
          </button>
        </div>
      </header>
      )}

      {/* 신뢰도 hero — 얼굴인식·지오펜싱 강점을 단일 점수로 압축 */}
      {showTrust && trust && (
        <div
          className={
            'ops-trust ops-trust--' +
            (trust.score >= 80 ? 'good' : trust.score >= 60 ? 'mid' : 'low')
          }
        >
          <div className="ops-trust__head">
            <span className="ops-trust__label">오늘 출역 신뢰도</span>
            <span className="ops-trust__score">
              <strong>{trust.score}</strong>
              <em>점</em>
            </span>
          </div>
          <div className="ops-trust__bar">
            <span
              className="ops-trust__bar-fill"
              style={{ width: trust.score + '%' }}
            />
          </div>
          <div className="ops-trust__metrics">
            <span className="ops-trust__metric">
              <em>얼굴인식 출근</em>
              <strong>{trust.facePct}%</strong>
            </span>
            <span className="ops-trust__metric-sep">·</span>
            <span className="ops-trust__metric">
              <em>위치 정상</em>
              <strong>{trust.locPct}%</strong>
            </span>
            <span className="ops-trust__metric-sep">·</span>
            <span className="ops-trust__metric">
              <em>수동처리</em>
              <strong>{trust.manualPct}%</strong>
            </span>
            <span className="ops-trust__metric-sep">·</span>
            <span className="ops-trust__metric">
              <em>예외사항</em>
              <strong>{trust.exceptionCount}건</strong>
            </span>
          </div>
        </div>
      )}

      {/* 1행 — 출역 흐름 */}
      {showFlow && (
      <div className="ops-strip__row">
        <div className="ops-strip__row-label">오늘 출역 흐름</div>
        <div className="ops-strip__tiles">
          {flowTiles.map((tile) => {
            // 클릭 가능한 카테고리: 관리자 수동보정 (drillable & has value)
            const drillable = tile.key === 'manual' && tile.value > 0;
            const Tag = drillable ? 'button' : 'div';
            return (
              <Tag
                key={tile.key}
                type={drillable ? 'button' : undefined}
                className={
                  'ops-strip__tile ops-strip__tile--' + (tile.accent ?? 'normal') +
                  (drillable ? ' ops-strip__tile--drillable' : '')
                }
                title={drillable ? `클릭 — 「${tile.label}」 대상자 보기` : `${tile.label} — ${tile.sub}`}
                onClick={drillable ? () => setDrill('manual') : undefined}
              >
                <div className="ops-strip__tile-label">{tile.label}</div>
                <div className="ops-strip__tile-value">
                  <strong>{tile.value}</strong>
                  <em>건</em>
                  {tile.ratio && (
                    <span className="ops-strip__tile-ratio">
                      {' '}/ {tile.ratio.denom}
                    </span>
                  )}
                </div>
                <div className="ops-strip__tile-sub">{tile.sub}</div>
              </Tag>
            );
          })}
        </div>
      </div>
      )}

      {/* 2행 — 처리 필요 (이슈) */}
      {showIssues && (
      <div className="ops-strip__row ops-strip__row--issues">
        <div className="ops-strip__row-label">처리 필요</div>
        <div className="ops-strip__tiles">
          {issueTiles.map((tile) => {
            const has = tile.value > 0;
            // 모든 예외 카드 — 값 있으면 drill 가능
            const drillKey: DrillKey | null =
              tile.key === 'outside' ? 'outside' :
              tile.key === 'no-loc' ? 'no-loc' :
              tile.key === 'no-show' ? 'no-show' :
              tile.key === 'late'   ? 'late' :
              tile.key === 'safety' ? 'safety' :
              null;
            const drillable = !!drillKey && has;
            const Tag = drillable ? 'button' : 'div';
            return (
              <Tag
                key={tile.key}
                type={drillable ? 'button' : undefined}
                className={
                  'ops-strip__tile ops-strip__tile--issue ' +
                  (has ? 'is-' + tile.severity : 'is-clean') +
                  (drillable ? ' ops-strip__tile--drillable' : '')
                }
                title={drillable ? `클릭 — 「${tile.label}」 대상자 보기` : `${tile.label} — ${tile.sub}`}
                onClick={drillable ? () => setDrill(drillKey) : undefined}
              >
                <div className="ops-strip__tile-label">{tile.label}</div>
                <div className="ops-strip__tile-value">
                  <strong>{tile.value}</strong>
                  <em>건</em>
                </div>
                <div className="ops-strip__tile-sub">{tile.sub}</div>
              </Tag>
            );
          })}
        </div>
      </div>
      )}

      {/* 3행 — 오늘 조치 필요 (계약·동의·안전교육) */}
      {showFlow && (
        <div className="ops-strip__row">
          <div className="ops-strip__row-label ops-strip__row-label--info">오늘 조치 필요</div>
          <div className="ops-strip__tiles ops-strip__tiles--four">
            {actionTiles.map((tile) => {
              const has = tile.value > 0;
              const drillKey: DrillKey | null =
                tile.key === 'manual-approve' ? 'manual-approve' :
                tile.key === 'no-contract'    ? 'no-contract' :
                tile.key === 'no-consent'     ? 'no-consent' :
                tile.key === 'no-edu'         ? 'no-edu' :
                null;
              const drillable = !!drillKey && has;
              const Tag = drillable ? 'button' : 'div';
              return (
                <Tag
                  key={tile.key}
                  type={drillable ? 'button' : undefined}
                  className={
                    'ops-strip__tile ops-strip__tile--action' +
                    (has ? ' has-value' : ' is-clean') +
                    (drillable ? ' ops-strip__tile--drillable' : '')
                  }
                  title={drillable ? `클릭 — 「${tile.label}」 대상자 보기` : `${tile.label} — ${tile.sub}`}
                  onClick={drillable ? () => setDrill(drillKey!) : undefined}
                >
                  <div className="ops-strip__tile-label">{tile.label}</div>
                  <div className="ops-strip__tile-value">
                    <strong>{tile.value}</strong>
                    <em>{tile.unit ?? '건'}</em>
                  </div>
                  <div className="ops-strip__tile-sub">{tile.sub}</div>
                </Tag>
              );
            })}
          </div>
        </div>
      )}

      {/* 4행 — 월 마감 진행 (출역·노임·명세서) */}
      {showFlow && (
        <div className="ops-strip__row">
          <div className="ops-strip__row-label ops-strip__row-label--ok">월 마감 진행</div>
          <div className="ops-strip__tiles ops-strip__tiles--four">
            {closureTiles.map((tile) => (
              <div
                key={tile.key}
                className={'ops-strip__tile ops-strip__tile--closure' + (tile.ok ? ' is-done' : ' is-pending')}
                title={`${tile.label} — ${tile.sub}`}
              >
                <div className="ops-strip__tile-label">{tile.label}</div>
                <div className="ops-strip__tile-value ops-strip__tile-value--text">
                  <strong>{tile.ok ? '✓' : '⏳'}</strong>
                  <span className="ops-strip__tile-text">{tile.value}</span>
                </div>
                <div className="ops-strip__tile-sub">{tile.sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* drill-down 모달 — 카테고리별 대상자 목록 */}
      {drill && today && (
        <OpsStripDrillModal
          category={drill}
          today={today}
          members={members}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

/* ───────── OpsStrip drill-down 모달 ───────── */

function OpsStripDrillModal({
  category,
  today,
  members,
  onClose,
}: {
  category:
    | 'manual' | 'outside' | 'no-loc' | 'no-show' | 'late' | 'safety'
    | 'manual-approve' | 'no-contract' | 'no-consent' | 'no-edu';
  today: TodayAttendance;
  members: TeamMember[];
  onClose: () => void;
}) {
  // 멤버 룩업
  const memberById = new Map(members.map((m) => [m.id, m]));

  // 카테고리별 액션 설계
  // 라벨·확인 메시지를 카테고리 의미에 맞게 차별화. 기존에 있던 액션은 그대로 두고,
  // 안 되어 있던 카테고리(외부 출근 승인/반려, GPS 반장 확인, 지각·조퇴 공수 확인)만 추가/리네이밍.
  type ActSpec = { show: true; label?: string; confirm?: string; ok?: string } | { show: false };
  type ActionConfig = { approve: ActSpec; reject: ActSpec; resend: ActSpec; detail: ActSpec };
  const actionConfig: Record<typeof category, ActionConfig> = {
    'manual': {
      approve: { show: true },
      reject:  { show: true },
      resend:  { show: false },
      detail:  { show: true },
    },
    'manual-approve': {
      approve: { show: true },
      reject:  { show: true },
      resend:  { show: false },
      detail:  { show: true },
    },
    'outside': {
      // 위치 상세 → 승인/반려
      approve: { show: true, label: '인정',
        confirm: '현장 외 출근을 인정 처리하시겠습니까? 인정 시 정상 출근으로 반영됩니다.',
        ok: '인정 처리됨 — 정상 출근으로 반영' },
      reject:  { show: true },
      resend:  { show: false },
      detail:  { show: true },
    },
    'no-loc': {
      // 반장 확인 요청
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true, label: '반장 확인 요청',
        confirm: '담당 반장에게 위치 확인을 요청하시겠습니까? 알림톡이 발송됩니다.',
        ok: '반장 확인 요청 전송됨' },
      detail:  { show: true },
    },
    'no-show': {
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true },
      detail:  { show: true },
    },
    'late': {
      // 공수 확인
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true, label: '공수 확인',
        confirm: '해당 근로자의 공수 산정을 확인하시겠습니까? 출퇴근 페이지에서 검토 가능합니다.',
        ok: '공수 확인 페이지로 이동 (mock)' },
      detail:  { show: true },
    },
    'safety': {
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true },
      detail:  { show: true },
    },
    'no-contract': {
      // 계약서 재발송
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true, label: '계약서 재발송',
        confirm: '근로계약서 모바일 서명 링크를 재발송하시겠습니까?',
        ok: '계약서 재발송 완료' },
      detail:  { show: true },
    },
    'no-consent': {
      // 동의서 재발송
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true, label: '동의서 재발송',
        confirm: '개인정보 동의서 링크를 재발송하시겠습니까?',
        ok: '동의서 재발송 완료' },
      detail:  { show: true },
    },
    'no-edu': {
      // 교육문자 발송
      approve: { show: false },
      reject:  { show: false },
      resend:  { show: true, label: '교육문자 발송',
        confirm: '기초안전보건교육 이수 안내 문자를 발송하시겠습니까?',
        ok: '교육 안내 문자 발송 완료' },
      detail:  { show: true },
    },
  };
  const acts = actionConfig[category];
  const actLabel = (k: 'approve' | 'reject' | 'resend' | 'detail', fallback: string) => {
    const a = acts[k];
    return a.show && 'label' in a && a.label ? a.label : fallback;
  };

  // 액션 핸들러 — 실 운영시 API 연결. 현재는 mock 알림.
  function fmtKrw(n: number) {
    return n.toLocaleString('ko-KR') + '원';
  }
  function fmtDate(iso: string | null) {
    if (!iso) return new Date().toISOString().slice(0, 10);
    return iso.slice(0, 10);
  }
  function handleAction(
    kind: 'approve' | 'reject' | 'resend' | 'detail',
    row: {
      memberName: string;
      checkInAt: string | null;
      gongsu?: number;
      dailyWage?: number;
      payAmount?: number;
    },
  ) {
    const name = row.memberName;
    if (kind === 'detail') {
      window.alert(`「${name}」 상세 페이지로 이동합니다.\n(팀원관리 페이지에서 검색됩니다)`);
      return;
    }
    if (kind === 'resend') {
      const a = acts.resend;
      const customConfirm = a.show && 'confirm' in a && a.confirm
        ? `「${name}」 — ${a.confirm}` : `「${name}」 에게 알림을 재발송하시겠습니까?`;
      const customOk = a.show && 'ok' in a && a.ok
        ? `✓ 「${name}」 — ${a.ok} (mock).` : `✓ 「${name}」 재발송 완료 (mock).`;
      if (!window.confirm(customConfirm)) return;
      window.alert(customOk);
      return;
    }
    if (kind === 'approve') {
      // 수동보정류는 공수·노무비 사전 안내, 그 외(외부 출근 등)는 카테고리별 메시지
      const a = acts.approve;
      const isManual = category === 'manual' || category === 'manual-approve';
      if (isManual) {
        const dateStr = fmtDate(row.checkInAt);
        const gongsu = row.gongsu ?? 1.0;
        const pay = row.payAmount ?? Math.round((row.dailyWage ?? 220_000) * gongsu);
        const msg =
          `「${name}」 의 수동보정 처리를 승인하시겠습니까?\n\n` +
          `승인 시 해당 근로자의 ${dateStr} 공수 ${gongsu.toFixed(1)}이 반영되며,\n` +
          `월 노무비에 ${fmtKrw(pay)}이 추가됩니다.`;
        if (!window.confirm(msg)) return;
        window.alert(`✓ 「${name}」 승인 처리됨 — 공수 ${gongsu.toFixed(1)} · 노무비 ${fmtKrw(pay)} 반영 (mock).`);
        return;
      }
      const customConfirm = a.show && 'confirm' in a && a.confirm
        ? `「${name}」 — ${a.confirm}` : `「${name}」 을(를) 승인하시겠습니까?`;
      const customOk = a.show && 'ok' in a && a.ok
        ? `✓ 「${name}」 — ${a.ok} (mock).` : `✓ 「${name}」 승인 처리됨 (mock).`;
      if (!window.confirm(customConfirm)) return;
      window.alert(customOk);
      return;
    }
    if (kind === 'reject') {
      // 반려 사유 선택 다이얼로그를 띄움 (state로 row 보관)
      setRejectFor(row);
      return;
    }
  }
  // 반려 다이얼로그 대상 row
  const [rejectFor, setRejectFor] = useState<{
    memberName: string;
    checkInAt: string | null;
  } | null>(null);
  function confirmReject(reason: string) {
    const name = rejectFor?.memberName ?? '';
    setRejectFor(null);
    window.alert(`✓ 「${name}」 반려 처리됨 — 사유: ${reason} (mock).`);
  }

  // 카테고리별 라벨 + 필터
  const config: Record<typeof category, {
    title: string;
    desc: string;
    rows: Array<{
      memberId: string;
      memberName: string;
      role: string;
      checkInAt: string | null;
      checkOutAt: string | null;
      detail: string;
      /** 승인 시 반영될 공수 (수동보정류만) */
      gongsu?: number;
      /** 일당 (원) */
      dailyWage?: number;
      /** 그날 지급 예정 임금 = dailyWage × gongsu */
      payAmount?: number;
    }>;
  }> = (() => {
    const todayWithRec = today.members.filter((m) => m.record);
    if (category === 'manual') {
      const rows = todayWithRec
        .filter((m) =>
          m.record?.checkInMethod === 'MANUAL' || m.record?.checkOutMethod === 'MANUAL',
        )
        .map((m) => {
          const inMan = m.record?.checkInMethod === 'MANUAL';
          const outMan = m.record?.checkOutMethod === 'MANUAL';
          const which = inMan && outMan ? '출근·퇴근' : inMan ? '출근' : '퇴근';
          return {
            memberId: m.memberId, memberName: m.memberName, role: m.role,
            checkInAt: m.record?.checkInAt ?? null,
            checkOutAt: m.record?.checkOutAt ?? null,
            detail: `${which} 수동 처리${m.record?.manualReason ? ` · ${m.record.manualReason}` : ''}`,
            gongsu: m.record?.gongsu,
            dailyWage: m.record?.dailyWage,
            payAmount: m.record?.payAmount,
          };
        });
      return {
        manual: {
          title: '수동처리된 출퇴근',
          desc: '얼굴 인식 없이 관리자가 직접 처리한 출/퇴근 기록입니다. 사유를 확인하세요.',
          rows,
        },
      } as any;
    }
    if (category === 'outside') {
      const rows = todayWithRec
        .filter((m) => m.record?.geofenceResult === 'OUTSIDE')
        .map((m) => ({
          memberId: m.memberId, memberName: m.memberName, role: m.role,
          checkInAt: m.record?.checkInAt ?? null,
          checkOutAt: m.record?.checkOutAt ?? null,
          detail:
            m.record?.distanceFromSiteM != null
              ? `현장에서 약 ${Math.round(m.record.distanceFromSiteM)}m 떨어진 위치`
              : '현장 외부에서 출근 인증',
        }));
      return {
        outside: {
          title: '지오펜싱 외부 출근자',
          desc: '현장 반경 밖에서 얼굴 인증한 사용자입니다. 위치 확인이 필요할 수 있습니다.',
          rows,
        },
      } as any;
    }
    if (category === 'no-loc') {
      const rows = todayWithRec
        .filter((m) => m.record?.geofenceResult === 'NO_LOCATION')
        .map((m) => ({
          memberId: m.memberId, memberName: m.memberName, role: m.role,
          checkInAt: m.record?.checkInAt ?? null,
          checkOutAt: m.record?.checkOutAt ?? null,
          detail: 'GPS 신호가 수집되지 않은 채로 인증',
        }));
      return {
        'no-loc': {
          title: 'GPS 위치 미수집',
          desc: '출근 시점에 GPS 좌표를 수집하지 못한 사용자입니다. 단말기 권한 또는 신호 점검이 필요합니다.',
          rows,
        },
      } as any;
    }
    if (category === 'late') {
      const rows = todayWithRec
        .filter((m) => m.record?.status === 'LATE' || m.record?.status === 'EARLY')
        .map((m) => ({
          memberId: m.memberId, memberName: m.memberName, role: m.role,
          checkInAt: m.record?.checkInAt ?? null,
          checkOutAt: m.record?.checkOutAt ?? null,
          detail: m.record?.status === 'LATE' ? '지각' : '조퇴',
        }));
      return {
        late: {
          title: '지각 · 조퇴 대상자',
          desc: '표준 근로 시간을 벗어난 출/퇴근 기록입니다.',
          rows,
        },
      } as any;
    }
    if (category === 'no-show') {
      // 등록되었지만 오늘 record가 없는 인원
      const attMemberIds = new Set(todayWithRec.map((m) => m.memberId));
      const rows = today.members
        .filter((m) => !attMemberIds.has(m.memberId))
        .map((m) => ({
          memberId: m.memberId, memberName: m.memberName, role: m.role,
          checkInAt: null, checkOutAt: null,
          detail: '오늘 출근 기록 없음 — 결근 또는 미인증',
        }));
      return {
        'no-show': {
          title: '미출근 대상자',
          desc: '등록되어 있으나 오늘 출근 기록이 없는 사용자입니다. 결근/지연 여부를 확인하세요.',
          rows,
        },
      } as any;
    }
    if (category === 'safety') {
      const todayMemberIds = new Set(todayWithRec.map((m) => m.memberId));
      const rows = members
        .filter((m) => todayMemberIds.has(m.id) && m.safetyEduCompleted === false)
        .map((m) => {
          const tm = todayWithRec.find((x) => x.memberId === m.id);
          return {
            memberId: m.id, memberName: m.name, role: m.role,
            checkInAt: tm?.record?.checkInAt ?? null,
            checkOutAt: tm?.record?.checkOutAt ?? null,
            detail: '기초안전보건교육 미이수 — 즉시 이수 필요 (산업안전보건법 제29조)',
          };
        });
      return {
        safety: {
          title: '안전교육 미이수자 (출근)',
          desc: '오늘 출근한 사용자 중 기초안전보건교육을 이수하지 않은 인원입니다. 법적 의무 사항이라 즉시 이수가 필요합니다.',
          rows,
        },
      } as any;
    }
    if (category === 'manual-approve') {
      // 오늘 수동보정 처리된 출퇴근 — 수동(manual)과 동일 데이터, 다른 컨텍스트(승인 대기)
      const rows = todayWithRec
        .filter((m) =>
          m.record?.checkInMethod === 'MANUAL' || m.record?.checkOutMethod === 'MANUAL',
        )
        .map((m) => {
          const inMan = m.record?.checkInMethod === 'MANUAL';
          const outMan = m.record?.checkOutMethod === 'MANUAL';
          const which = inMan && outMan ? '출근·퇴근' : inMan ? '출근' : '퇴근';
          return {
            memberId: m.memberId, memberName: m.memberName, role: m.role,
            checkInAt: m.record?.checkInAt ?? null,
            checkOutAt: m.record?.checkOutAt ?? null,
            detail: `${which} 수동 처리${m.record?.manualReason ? ` · ${m.record.manualReason}` : ''} — 본사 검토 필요`,
            gongsu: m.record?.gongsu,
            dailyWage: m.record?.dailyWage,
            payAmount: m.record?.payAmount,
          };
        });
      return {
        'manual-approve': {
          title: '수동보정 승인 대기',
          desc: '오늘 관리자가 수동으로 처리한 출/퇴근 기록입니다. 사유 확인 후 승인하거나 반려하세요.',
          rows,
        },
      } as any;
    }
    if (category === 'no-contract') {
      const rows = members
        .filter((m) => !m.contractSigned)
        .map((m) => ({
          memberId: m.id, memberName: m.name, role: m.role,
          checkInAt: null, checkOutAt: null,
          detail: '근로계약서 미서명 — 작업 전 서명 필수',
        }));
      return {
        'no-contract': {
          title: '미체결 근로계약',
          desc: '근로계약서가 아직 서명되지 않은 등록 인원입니다. 출근 전에 모바일/대면 서명을 요청하세요.',
          rows,
        },
      } as any;
    }
    if (category === 'no-consent') {
      const rows = members
        .filter((m) => m.faceVerified === false)
        .map((m) => ({
          memberId: m.id, memberName: m.name, role: m.role,
          checkInAt: null, checkOutAt: null,
          detail: '얼굴인식 인증 전 — 개인정보 동의 + 얼굴 등록 필요',
        }));
      return {
        'no-consent': {
          title: '개인정보동의 미완료',
          desc: '얼굴인식 출근을 위해 동의·등록이 완료되지 않은 인원입니다. 안내 알림을 발송할 수 있습니다.',
          rows,
        },
      } as any;
    }
    // no-edu — 등록 인원 전체 중 미이수자 (오늘 출근 여부 무관)
    const rows = members
      .filter((m) => m.safetyEduCompleted === false)
      .map((m) => ({
        memberId: m.id, memberName: m.name, role: m.role,
        checkInAt: null, checkOutAt: null,
        detail: '기초안전보건교육 미이수 — 이수 안내 발송 필요',
      }));
    return {
      'no-edu': {
        title: '안전교육 발송 필요',
        desc: '기초안전보건교육이 미이수된 등록 인원입니다. 이수 안내(링크) 알림톡을 발송하세요.',
        rows,
      },
    } as any;
  })();

  const cur = (config as any)[category];
  const hhmm = (iso: string | null) => {
    if (!iso) return '—';
    return iso.slice(11, 16);
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={cur.title}
      subtitle={`${cur.rows.length}명 대상`}
      width={680}
    >
      <div className="ops-drill">
        <p className="ops-drill__desc">{cur.desc}</p>
        {cur.rows.length === 0 ? (
          <div className="ops-drill__empty">
            ✓ 해당 카테고리에 해당하는 인원이 없습니다.
          </div>
        ) : (
          <ul className="ops-drill__list">
            {cur.rows.map((r: any, i: number) => {
              const m = memberById.get(r.memberId);
              const showTimes = r.checkInAt !== null || r.checkOutAt !== null;
              return (
                <li key={r.memberId + '-' + i} className="ops-drill__item">
                  <div className="ops-drill__row1">
                    <strong className="ops-drill__name">{r.memberName}</strong>
                    <span className="ops-drill__role">{r.role}</span>
                    {m?.phone && (
                      <span className="ops-drill__phone">{m.phone}</span>
                    )}
                  </div>
                  <div className="ops-drill__row2">
                    {showTimes && (
                      <>
                        <span className="ops-drill__time">
                          <em>출</em> {hhmm(r.checkInAt)}
                        </span>
                        <span className="ops-drill__time">
                          <em>퇴</em> {hhmm(r.checkOutAt)}
                        </span>
                      </>
                    )}
                    <span className="ops-drill__detail">{r.detail}</span>
                  </div>
                  <div className="ops-drill__actions">
                    {acts.approve.show && (
                      <button
                        type="button"
                        className="ops-drill__btn ops-drill__btn--approve"
                        onClick={() => handleAction('approve', r)}
                      >
                        {actLabel('approve', '승인')}
                      </button>
                    )}
                    {acts.reject.show && (
                      <button
                        type="button"
                        className="ops-drill__btn ops-drill__btn--reject"
                        onClick={() => handleAction('reject', r)}
                      >
                        {actLabel('reject', '반려')}
                      </button>
                    )}
                    {acts.resend.show && (
                      <button
                        type="button"
                        className="ops-drill__btn ops-drill__btn--resend"
                        onClick={() => handleAction('resend', r)}
                      >
                        {actLabel('resend', '재발송')}
                      </button>
                    )}
                    {acts.detail.show && (
                      <button
                        type="button"
                        className="ops-drill__btn ops-drill__btn--detail"
                        onClick={() => handleAction('detail', r)}
                      >
                        {actLabel('detail', '상세보기')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {rejectFor && (
        <RejectReasonDialog
          memberName={rejectFor.memberName}
          onCancel={() => setRejectFor(null)}
          onConfirm={confirmReject}
        />
      )}
    </Modal>
  );
}

/* ───────── 반려 사유 선택 다이얼로그 ───────── */

function RejectReasonDialog({
  memberName,
  onCancel,
  onConfirm,
}: {
  memberName: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const PRESET_REASONS = [
    '현장 외 출근 의심',
    '근무 사실 확인 불가',
    '반장 입력 오류',
    '중복 기록',
  ];
  const [selected, setSelected] = useState<string>(PRESET_REASONS[0]);
  const [customMode, setCustomMode] = useState(false);
  const [custom, setCustom] = useState('');

  function handleConfirm() {
    const reason = customMode ? custom.trim() : selected;
    if (!reason) {
      window.alert('반려 사유를 선택하거나 직접 입력하세요.');
      return;
    }
    onConfirm(reason);
  }

  return (
    <Modal
      open={true}
      onClose={onCancel}
      title="반려 사유 선택"
      subtitle={`「${memberName}」 의 수동보정 처리를 반려합니다.`}
      width={420}
      footer={
        <div className="reject-reason__foot">
          <button
            type="button"
            className="reject-reason__btn reject-reason__btn--ghost"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            className="reject-reason__btn reject-reason__btn--primary"
            onClick={handleConfirm}
          >
            반려 확정
          </button>
        </div>
      }
    >
      <div className="reject-reason">
        <ul className="reject-reason__list">
          {PRESET_REASONS.map((r) => (
            <li key={r}>
              <label className={'reject-reason__item' + (!customMode && selected === r ? ' is-active' : '')}>
                <input
                  type="radio"
                  name="reject-reason"
                  checked={!customMode && selected === r}
                  onChange={() => { setCustomMode(false); setSelected(r); }}
                />
                <span className="reject-reason__label">{r}</span>
              </label>
            </li>
          ))}
          <li>
            <label className={'reject-reason__item' + (customMode ? ' is-active' : '')}>
              <input
                type="radio"
                name="reject-reason"
                checked={customMode}
                onChange={() => setCustomMode(true)}
              />
              <span className="reject-reason__label">기타 직접입력</span>
            </label>
            {customMode && (
              <textarea
                className="reject-reason__textarea"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="반려 사유를 직접 입력하세요"
                autoFocus
                rows={3}
              />
            )}
          </li>
        </ul>
      </div>
    </Modal>
  );
}

function buildPeriodInfo(start: string, end: string) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const now = Date.now();
  const totalDays = Math.max(1, Math.round((e - s) / 86_400_000));
  const remainDays = Math.max(0, Math.round((e - now) / 86_400_000));
  const elapsedPct = Math.max(0, Math.min(100, ((now - s) / (e - s)) * 100));
  const months = Math.round(totalDays / 30);
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const duration =
    years > 0
      ? `${years}년 ${remMonths > 0 ? remMonths + '개월' : ''}`.trim()
      : `${months}개월`;
  return { totalDays, remainDays, elapsedPct, duration };
}

/* ───────── 게시판 카드 (현장 단위 공지·메모) ───────── */

interface BoardPost {
  id: string;
  siteId: string;
  category: '공지' | '안전' | '일정' | '자재';
  title: string;
  author: string;
  date: string;
}

const BOARD_KEY = 'ilgampack_admin:board';

/** 시드 기본 게시글 (현장별 소량) */
function seedBoardPosts(siteId: string, siteName: string): BoardPost[] {
  const today = new Date();
  const d = (offset: number) =>
    new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
  return [
    { id: `${siteId}-1`, siteId, category: '공지', title: `${siteName.split(' ').slice(0, 2).join(' ')} 1차 자재 검수 일정 안내`, author: '김홍길', date: d(0) },
    { id: `${siteId}-2`, siteId, category: '안전', title: '주말 근무자 안전모 착용 의무', author: '이안전', date: d(1) },
    { id: `${siteId}-3`, siteId, category: '일정', title: '다음 주 콘크리트 타설 (3일차)', author: '박철수', date: d(2) },
    { id: `${siteId}-4`, siteId, category: '자재', title: '거푸집 추가 발주 — 관리자 확인 요청', author: '김홍길', date: d(4) },
  ];
}

function loadBoardPosts(siteId: string, siteName: string): BoardPost[] {
  try {
    const raw = localStorage.getItem(BOARD_KEY);
    if (raw) {
      const all = JSON.parse(raw) as BoardPost[];
      const here = all.filter((p) => p.siteId === siteId);
      if (here.length > 0) return here;
    }
  } catch { /* ignore */ }
  // 시드
  const seeded = seedBoardPosts(siteId, siteName);
  try {
    const raw = localStorage.getItem(BOARD_KEY);
    const all: BoardPost[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(BOARD_KEY, JSON.stringify([...all, ...seeded]));
  } catch { /* ignore */ }
  return seeded;
}

function BoardCard({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [posts, setPosts] = useState<BoardPost[]>([]);
  useEffect(() => {
    setPosts(loadBoardPosts(siteId, siteName));
  }, [siteId, siteName]);

  return (
    <div className="board-card">
      <header className="board-card__head">
        <div>
          <h3>📋 현장 게시판</h3>
          <p>현장 공지·안전·일정·자재 메모</p>
        </div>
        <button type="button" className="board-card__more">+ 글 작성</button>
      </header>
      {posts.length === 0 ? (
        <p className="board-card__empty">게시글이 없습니다.</p>
      ) : (
        <ul className="board-card__list">
          {posts.slice(0, 5).map((p) => (
            <li key={p.id} className="board-post">
              <span className={'board-post__cat board-post__cat--' + categoryClass(p.category)}>
                {p.category}
              </span>
              <span className="board-post__title">{p.title}</span>
              <span className="board-post__meta">
                {p.author} · {p.date}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function categoryClass(c: BoardPost['category']): string {
  switch (c) {
    case '공지': return 'notice';
    case '안전': return 'safety';
    case '일정': return 'schedule';
    case '자재': return 'material';
  }
}

function NotificationCard({ siteId: _siteId }: { siteId: string }) {
  const [logs, setLogs] = useState<DispatchLog[]>([]);
  useEffect(() => {
    setLogs(getDispatchLogs().slice(0, 5));
  }, [_siteId]);

  return (
    <div className="board-card">
      <header className="board-card__head">
        <div>
          <h3>💬 알림톡 발송</h3>
          <p>최근 카카오/SMS 발송 5건</p>
        </div>
        <Link to="/notifications" className="board-card__more">전체 보기 →</Link>
      </header>
      {logs.length === 0 ? (
        <p className="board-card__empty">발송 내역이 없습니다. 팀원 등록·임금 발송 시 자동 추가됩니다.</p>
      ) : (
        <ul className="board-card__list">
          {logs.map((l) => (
            <li key={l.id} className="board-post">
              <span className={'board-post__cat board-post__cat--' + (l.channel === 'KAKAO' ? 'kakao' : 'sms')}>
                {l.channel === 'KAKAO' ? '카톡' : 'SMS'}
              </span>
              <span className="board-post__title">{l.toName} · {l.toPhone}</span>
              <span className="board-post__meta">
                {new Date(l.sentAt).toLocaleString()} · {l.status === 'SENT' ? '✓' : '실패'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MiniKpi({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="mini-kpi">
      <p className="mini-kpi__label">{label}</p>
      <p className="mini-kpi__value" style={{ color }}>{value}</p>
      <p className="mini-kpi__sub">{sub}</p>
    </div>
  );
}

/* 비번 반장 상태 — localStorage 키: ilgampack_admin:foremanStatus
 *  PENDING   = 대기중 (계약 송부 전, 평상시 기본 상태)
 *  INVITED   = 계약송부 (SMS/카톡 발송됨, 반장 응답 대기)
 *  WORKING   = 근무중 (반장 수락 + 활동 중)
 *  REJECTED  = 거절 (반장이 계약 거절)
 */
type ForemanContractStatus = 'PENDING' | 'INVITED' | 'WORKING' | 'REJECTED';

const FOREMAN_STATUS_KEY = 'ilgampack_admin:foremanStatus';

function loadForemanStatus(): Record<string, ForemanContractStatus> {
  try {
    const raw = localStorage.getItem(FOREMAN_STATUS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}
function saveForemanStatus(map: Record<string, ForemanContractStatus>) {
  try {
    localStorage.setItem(FOREMAN_STATUS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** 010-1234-5678 형식 */
function fmtKrPhone(p: string): string {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 11) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return p;
}

/** 근무중 + 비번 반장을 한 타일에 합쳐 렌더링 — 좌측(dash-main) 높이에 맞춰 늘어남 */
function ForemanCombinedTile({
  onDuty,
  offDuty,
  sites,
  memberCounts,
}: {
  onDuty: Foreman[];
  offDuty: Foreman[];
  sites: Site[];
  memberCounts: Record<string, number>;
}) {
  return (
    <div className="fmstat fmstat--combined">
      <ForemanStatTile
        title="근무중 반장"
        subtitle="앱 가입 완료 + 활동 중"
        color="primary"
        foremen={onDuty}
        sites={sites}
        memberCounts={memberCounts}
        embedded
      />
      <div className="fmstat__divider" aria-hidden />
      <ForemanStatTile
        title="비번 반장"
        subtitle="가입 / 계약 대기 — 상태 칩 클릭으로 변경"
        color="warn"
        foremen={offDuty}
        sites={sites}
        memberCounts={memberCounts}
        showActions
        embedded
      />
    </div>
  );
}

function ForemanStatTile({
  title,
  subtitle,
  color,
  foremen,
  sites,
  memberCounts,
  showActions,
  embedded,
}: {
  title: string;
  subtitle: string;
  color: 'primary' | 'warn';
  foremen: Foreman[];
  sites: Site[];
  memberCounts: Record<string, number>;
  /** 비번 반장 카드에서만 true — 상태 칩 + 계약 송부 버튼 */
  showActions?: boolean;
  /** Combined 타일 내부에 박힐 때는 바깥 카드 wrapper 를 빼고 섹션처럼 렌더링 */
  embedded?: boolean;
}) {
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '';
  const [statusMap, setStatusMap] = useState<Record<string, ForemanContractStatus>>(
    () => loadForemanStatus(),
  );
  const [dlgFor, setDlgFor] = useState<Foreman | null>(null);
  /** 근무중 반장 클릭 시 안전알림 다이얼로그 */
  const [safetyFor, setSafetyFor] = useState<Foreman | null>(null);

  function updateStatus(id: string, next: ForemanContractStatus) {
    const m = { ...statusMap, [id]: next };
    setStatusMap(m);
    saveForemanStatus(m);
  }

  function statusOf(id: string): ForemanContractStatus {
    return statusMap[id] ?? 'PENDING';
  }
  function statusLabel(s: ForemanContractStatus): string {
    switch (s) {
      case 'PENDING': return '대기중';
      case 'INVITED': return '계약송부';
      case 'WORKING': return '근무중';
      case 'REJECTED': return '거절';
    }
  }
  /** 상태 칩 클릭 시 사이클: 대기중 → 계약송부 → 근무중 → 거절 → 대기중 */
  function nextStatus(s: ForemanContractStatus): ForemanContractStatus {
    switch (s) {
      case 'PENDING': return 'INVITED';
      case 'INVITED': return 'WORKING';
      case 'WORKING': return 'REJECTED';
      case 'REJECTED': return 'PENDING';
    }
  }

  function chipClass(s: ForemanContractStatus): string {
    return (
      'fmrow__chip fmrow__chip--' +
      (s === 'PENDING' ? 'pending' : s === 'INVITED' ? 'invited' : s === 'WORKING' ? 'working' : 'rejected')
    );
  }

  return (
    <div className={'fmstat-section fmstat-section--' + color}>
      <header className="fmstat__head">
        <h3>{title}</h3>
        <span className="fmstat__count">{foremen.length}</span>
      </header>
      {subtitle && <p className="fmstat__sub">{subtitle}</p>}

      <ul className="fmstat__list">
        {foremen.length === 0 ? (
          <li className="fmstat__empty">표시할 반장이 없습니다.</li>
        ) : (
          foremen.map((f) => {
            const s = statusOf(f.id);
            const cnt = memberCounts[f.id] ?? 0;
            const sn = siteName(f.siteId);
            const clickable = !showActions;
            return (
              <li
                key={f.id}
                className={'fmrow' + (clickable ? ' fmrow--clickable' : '')}
                onClick={() => clickable && setSafetyFor(f)}
                title={clickable ? '클릭 — 안전 알림 발송' : undefined}
              >
                <span className="fmrow__avatar">
                  <img
                    src={getAvatarUrl(f.id)}
                    alt={f.name}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </span>
                <span className="fmrow__main">
                  <span className="fmrow__top">
                    <strong className="fmrow__name">{f.name}</strong>
                    <span className="fmrow__role">{f.role || '반장'}</span>
                  </span>
                  <span className="fmrow__sub">
                    {sn}
                    {f.phone ? ' · ' + displayPhone(f.phone) : ''}
                  </span>
                </span>
                {showActions ? (
                  <span className="fmrow__cta">
                    <button
                      type="button"
                      className={chipClass(s)}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateStatus(f.id, nextStatus(s));
                      }}
                      title="클릭 — 상태 변경"
                    >
                      {statusLabel(s)}
                    </button>
                    <button
                      type="button"
                      className="fmrow__send"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDlgFor(f);
                      }}
                      title="계약 송부 (카카오톡 / SMS)"
                    >
                      📧 송부
                    </button>
                  </span>
                ) : (
                  <span className="fmrow__count">{cnt}명</span>
                )}
              </li>
            );
          })
        )}
      </ul>

      {dlgFor && (
        <ForemanContractDispatchDialog
          foreman={dlgFor}
          onClose={() => setDlgFor(null)}
          onSent={() => {
            updateStatus(dlgFor.id, 'INVITED');
            setDlgFor(null);
          }}
        />
      )}
      {safetyFor && (
        <ForemanSafetyDialog
          foreman={safetyFor}
          onClose={() => setSafetyFor(null)}
        />
      )}
    </div>
  );
}

/* ───────── 계약 송부 다이얼로그 ───────── */

function ForemanContractDispatchDialog({
  foreman,
  onClose,
  onSent,
}: {
  foreman: Foreman;
  onClose: () => void;
  onSent: () => void;
}) {
  const [channel, setChannel] = useState<'KAKAO' | 'SMS'>('KAKAO');
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    try {
      await new Promise((r) => setTimeout(r, 350));
      window.alert(
        foreman.name + ' 반장에게 ' + (channel === 'KAKAO' ? '카카오톡' : 'SMS') + ' 으로\n근로계약 요청 링크가 발송되었습니다.'
      );
      onSent();
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="근로계약 송부"
      subtitle={foreman.name + ' · ' + (foreman.phone || '연락처 없음')}
      width={420}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="dash__btn dash__btn--ghost" onClick={onClose} disabled={sending}>
            취소
          </button>
          <button
            type="button"
            className="dash__btn dash__btn--primary"
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? '발송 중…' : '📧 송부'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p
          style={{
            margin: 0,
            padding: '10px 12px',
            background: 'var(--color-bg-soft)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          반장에게 <strong>근로계약 요청 링크</strong>를 발송합니다. 반장이 링크를 통해
          본인 정보 확인 + 전자서명을 마치면 자동으로 근무중 상태로 전환됩니다.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <label
            style={{
              flex: 1,
              padding: '10px 12px',
              border: '1px solid ' + (channel === 'KAKAO' ? 'var(--color-primary)' : 'var(--color-border)'),
              borderRadius: 8,
              background: channel === 'KAKAO' ? 'var(--color-primary-light)' : '#fff',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <input
              type="radio"
              name="ch"
              checked={channel === 'KAKAO'}
              onChange={() => setChannel('KAKAO')}
            />
            💬 카카오톡
          </label>
          <label
            style={{
              flex: 1,
              padding: '10px 12px',
              border: '1px solid ' + (channel === 'SMS' ? 'var(--color-primary)' : 'var(--color-border)'),
              borderRadius: 8,
              background: channel === 'SMS' ? 'var(--color-primary-light)' : '#fff',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <input
              type="radio"
              name="ch"
              checked={channel === 'SMS'}
              onChange={() => setChannel('SMS')}
            />
            📱 SMS
          </label>
        </div>
      </div>
    </Modal>
  );
}

/* ───────── 안전 알림 발송 다이얼로그 ───────── */

function ForemanSafetyDialog({
  foreman,
  onClose,
}: {
  foreman: Foreman;
  onClose: () => void;
}) {
  // 12종 — 건설현장 안전 메시지 표준 분류 (고용노동부·KOSHA 가이드 기반)
  const PRESETS: Array<{ icon: string; title: string; msg: string }> = [
    {
      icon: '🌅',
      title: 'TBM · 출근 전 안전공지',
      msg: '[금일 안전공지] 작업 전 TBM 참석 필수입니다. 안전모·안전화·안전대 착용 확인 후 작업 시작 바랍니다. 단부·개구부 주변 이동 시 추락 위험에 각별히 주의하세요.',
    },
    {
      icon: '🪜',
      title: '추락 위험 작업',
      msg: '[추락주의] 금일 고소작업 예정입니다. 안전대 고리 체결, 개구부 덮개 고정, 안전난간 확인 후 작업 바랍니다. 미체결 상태 작업은 즉시 중지입니다.',
    },
    {
      icon: '🚜',
      title: '장비 · 차량 작업',
      msg: '[장비작업 주의] 장비 작업반경 내 접근 금지입니다. 유도자 신호 없이 장비 이동 금지, 후진 시 주변 근로자 확인 후 작업 바랍니다.',
    },
    {
      icon: '🏗',
      title: '양중 · 인양 작업',
      msg: '[양중작업 알림] 인양물 하부 출입을 금지합니다. 줄걸이 상태, 샤클·슬링 손상 여부 확인 후 작업 바랍니다. 신호수 지시에 따라 이동하세요.',
    },
    {
      icon: '⛏',
      title: '굴착 · 흙막이 · 터파기',
      msg: '[굴착작업 주의] 굴착면 주변 접근을 제한합니다. 토사 붕괴 위험이 있으니 정해진 통로로 이동하고, 굴착기 회전반경 내 출입을 금지합니다.',
    },
    {
      icon: '🔥',
      title: '화기 · 용접 · 절단',
      msg: '[화기작업 주의] 용접·절단 작업 전 주변 가연물 제거, 소화기 비치, 불티 비산방지포 설치 바랍니다. 작업 종료 후 잔불 확인 필수입니다.',
    },
    {
      icon: '🫧',
      title: '밀폐공간 · 질식 위험',
      msg: '[밀폐공간 작업] 작업 전 산소·유해가스 농도 측정, 환기, 감시인 배치 후 출입하세요. 단독작업 금지, 이상 냄새·어지러움 발생 시 즉시 대피 바랍니다.',
    },
    {
      icon: '⚡',
      title: '감전 · 전기 작업',
      msg: '[감전주의] 우천 후 전동공구 사용 전 누전차단기와 케이블 손상 여부를 확인하세요. 젖은 장갑·젖은 바닥에서 전기작업을 금지합니다.',
    },
    {
      icon: '☀️',
      title: '폭염 · 한파 · 우천 · 강풍',
      msg: '[폭염주의] 물·그늘·휴식 준수 바랍니다. 어지러움, 두통, 구토 증상 발생 시 즉시 작업을 중지하고 관리자에게 보고하세요.',
    },
    {
      icon: '🚧',
      title: '낙하물 · 자재 정리',
      msg: '[낙하물 주의] 상부 작업구간 하부 출입을 금지합니다. 자재 적치 상태를 확인하고, 공구·자재는 낙하방지 조치 후 사용하세요.',
    },
    {
      icon: '👷',
      title: '신규 · 외국인 근로자 투입',
      msg: '[신규자 안전안내] 현장 출입 전 안전교육 이수 후 작업 가능합니다. 지정 통로 이용, 보호구 착용, 위험구역 임의 출입 금지 바랍니다.',
    },
    {
      icon: '🚨',
      title: '사고 · 아차사고 재발방지',
      msg: '[사고사례 전파] 타 현장에서 개구부 추락사고가 발생했습니다. 금일 전 구역 개구부 덮개 고정, 안전난간, 안전대 체결 상태를 재점검 바랍니다.',
    },
  ];
  const [msg, setMsg] = useState(PRESETS[0].msg);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(PRESETS[0].title);
  // 발송 채널 — 다중 선택 (둘 다 가능, 둘 다 OFF면 발송 비활성)
  const [sendSms, setSendSms] = useState(true);
  const [sendApp, setSendApp] = useState(true);
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const channels = [sendSms ? '문자(SMS)' : null, sendApp ? '앱 알림' : null]
        .filter(Boolean)
        .join(' + ');
      window.alert(
        foreman.name + ' 반장에게\n안전 알림이 발송되었습니다.\n\n발송 채널: ' + channels,
      );
      onClose();
    } finally {
      setSending(false);
    }
  }

  function ChannelChip({
    on,
    onClick,
    icon,
    label,
  }: {
    on: boolean;
    onClick: () => void;
    icon: string;
    label: string;
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          border: '1px solid ' + (on ? 'var(--color-primary)' : 'var(--color-border)'),
          borderRadius: 999,
          background: on ? 'var(--color-primary-light)' : '#fff',
          color: on ? 'var(--color-primary-dark)' : 'var(--color-text-muted)',
          fontSize: 13,
          fontWeight: on ? 700 : 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'all 0.12s',
          flex: 1,
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 14 }}>{on ? '✓' : ''}</span>
        <span style={{ fontSize: 16, marginLeft: on ? 0 : -10 }}>{icon}</span>
        {label}
      </button>
    );
  }

  const canSend = msg.trim() && (sendSms || sendApp);

  return (
    <Modal
      open
      onClose={onClose}
      title="🦺 안전 알림 발송"
      subtitle={foreman.name + ' · ' + (foreman.phone || '연락처 없음')}
      width={520}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="dash__btn dash__btn--ghost" onClick={onClose} disabled={sending}>
            취소
          </button>
          <button
            type="button"
            className="dash__btn dash__btn--primary"
            onClick={handleSend}
            disabled={sending || !canSend}
          >
            {sending ? '발송 중…' : '🦺 발송'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
          12종 표준 안전 메시지 중 선택 후 필요시 직접 편집하세요. (고용노동부·KOSHA 가이드 기반)
        </p>

        {/* 12종 카드 — 2컬럼 그리드, 제목만 (메시지 본문은 하단 textarea 와 중복이라 제외) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            maxHeight: 240,
            overflowY: 'auto',
            paddingRight: 4,
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            padding: 6,
            background: '#fafafa',
          }}
        >
          {PRESETS.map((p) => {
            const selected = selectedTitle === p.title;
            return (
              <button
                key={p.title}
                type="button"
                onClick={() => {
                  setMsg(p.msg);
                  setSelectedTitle(p.title);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  border: '1px solid ' + (selected ? 'var(--color-primary)' : 'var(--color-border)'),
                  borderRadius: 8,
                  background: selected ? 'var(--color-primary-light)' : '#fff',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  transition: 'border-color 0.12s, background 0.12s',
                  height: 36,
                  boxSizing: 'border-box',
                }}
                title={p.msg}
              >
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{p.icon}</span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: selected ? 'var(--color-primary-dark)' : 'var(--color-text-strong)',
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {p.title}
                </span>
                {selected && (
                  <span style={{ fontSize: 13, color: 'var(--color-primary-dark)', flexShrink: 0 }}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 직접 편집 textarea */}
        <textarea
          rows={4}
          value={msg}
          onChange={(e) => {
            setMsg(e.target.value);
            setSelectedTitle(null);
          }}
          placeholder="직접 메시지를 입력하거나 위 항목을 선택하세요."
          style={{
            padding: '10px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 13,
            fontFamily: 'inherit',
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
          }}
        />

        {/* 발송 방법 — 문자 / 앱 다중 선택 */}
        <div>
          <p
            style={{
              margin: '0 0 6px',
              fontSize: 11.5,
              color: 'var(--color-text-muted)',
              fontWeight: 600,
            }}
          >
            발송 방법 (둘 다 선택 가능)
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <ChannelChip on={sendSms} onClick={() => setSendSms((v) => !v)} icon="📱" label="문자 발송 (SMS)" />
            <ChannelChip on={sendApp} onClick={() => setSendApp((v) => !v)} icon="📲" label="앱 안내 (푸시)" />
          </div>
          {!sendSms && !sendApp && (
            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#dc2626' }}>
              ※ 발송 방법을 최소 하나 이상 선택해주세요.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ───────── id 중복 제거 helper ───────── */

function dedupById<T extends { id: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}


/* ═══════════════════════════════════════════════════════════════════
 *  대시보드 v2 — 운영판단 중심 5계층
 *   ① HeroKPI       : 오늘 출역 / 퇴근 / 노무비 / 처리필요 / 신뢰도
 *   ② UrgentTasks   : 수동보정·위치오류·계약·안전교육 (액션 버튼)
 *   ③ Operations    : 현장별 출역+정산 통합 테이블 (표/카드 토글)
 *   ④ MonthClose    : 월 마감 5단계 진행 뱃지
 *   ⑤ BottomCards   : 직종별·반장별·안전·출력자료 보조 카드
 *  기존 dashboard 데이터 fetch 흐름은 그대로 사용. props 만 받아 표시.
 * ═══════════════════════════════════════════════════════════════════ */

// (useMemo / useState 는 파일 상단에서 이미 import 됨)

// ───── 공통 헬퍼 ─────────────────────────────────────────────

function k(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return n.toLocaleString();
}

interface SiteOpsStat {
  siteId: string;
  siteName: string;
  totalMembers: number;
  todayAttended: number;     // working + done
  faceCount: number;
  manualCount: number;
  gpsErrorCount: number;
  lateLeftCount: number;
  doneCount: number;
  todayPay: number;          // 오늘 노무비 합
  monthAccumPay: number;     // 월 누적 노무비 (시연: today × 22 근사)
  deduction: number;         // 공제 (시연: 8.5%)
  netPay: number;
  noContractCount: number;
  noEduCount: number;
  status: 'NORMAL' | 'WARN' | 'DANGER' | 'CLOSED';
  reliability: number;       // 0~100
}

function deriveSiteStat(
  site: any,
  members: any[],
  today: any /* TodayAttendance | undefined */,
  closeStatus: { monthClosed: boolean; todayClosed: boolean } | undefined,
  wage?: any /* WageMonthSummary — 단일 진실 소스 */,
): SiteOpsStat {
  const siteMembers = members.filter((m) => m.siteId === site.id && !m.leftAt);
  const totalMembers = siteMembers.length;

  const records = (today?.members ?? [])
    .map((tm: any) => tm.record)
    .filter(Boolean);
  const faceCount = records.filter((r: any) => r.checkInMethod === 'FACE').length;
  const manualCount = records.filter((r: any) => r.checkInMethod === 'MANUAL').length;
  const gpsErrorCount = records.filter(
    (r: any) => r.geofenceResult && r.geofenceResult !== 'INSIDE',
  ).length;
  const lateLeftCount = records.filter(
    (r: any) => r.status === 'LATE' || r.status === 'EARLY' || r.status === 'LATE_AND_EARLY',
  ).length;
  const doneCount = today?.summary?.doneCount ?? 0;
  const workingCount = today?.summary?.workingCount ?? 0;
  const todayAttended = workingCount + doneCount;
  const todayPay = records.reduce((s: number, r: any) => s + (r.payAmount || 0), 0);
  // 월 누적·공제·실지급 — wageApi 의 단일 진실 소스 우선. 없으면 fallback (today × 22).
  const monthAccumPay = wage?.totalBase ?? (todayPay * 22);
  const deduction     = wage?.totalDeduction ?? Math.round(monthAccumPay * 0.085);
  const netPay        = wage?.totalNet ?? (monthAccumPay - deduction);

  const noContractCount = siteMembers.filter((m) => !m.contractSigned).length;
  const noEduCount = siteMembers.filter((m) => !m.safetyEduCompleted).length;

  // 신뢰도 점수 (100 - 페널티)
  const denom = Math.max(1, todayAttended);
  const manualRatio = manualCount / denom;
  const gpsRatio = gpsErrorCount / denom;
  const contractRatio = totalMembers > 0 ? noContractCount / totalMembers : 0;
  const eduRatio = totalMembers > 0 ? noEduCount / totalMembers : 0;
  const score = Math.max(
    0,
    Math.round(100 - (manualRatio * 30 + gpsRatio * 30 + contractRatio * 20 + eduRatio * 20)),
  );

  let status: SiteOpsStat['status'];
  if (closeStatus?.monthClosed) status = 'CLOSED';
  else if (score >= 85 && manualCount === 0 && gpsErrorCount === 0) status = 'NORMAL';
  else if (score < 70 || gpsErrorCount >= 3 || noContractCount >= 5) status = 'DANGER';
  else status = 'WARN';

  return {
    siteId: site.id, siteName: site.name,
    totalMembers, todayAttended, faceCount, manualCount, gpsErrorCount, lateLeftCount,
    doneCount, todayPay, monthAccumPay, deduction, netPay,
    noContractCount, noEduCount, status, reliability: score,
  };
}

function statusBadgeV2(s: SiteOpsStat['status']): { label: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  switch (s) {
    case 'NORMAL':  return { label: '정상',     tone: 'green' };
    case 'WARN':    return { label: '주의',     tone: 'amber' };
    case 'DANGER':  return { label: '위험',     tone: 'red' };
    case 'CLOSED':  return { label: '마감완료', tone: 'gray' };
  }
}

// ───── ① HeroKPI ────────────────────────────────────────────

function DashHeroKPI({
  sites, todayBySite, allMembers, wageBySite,
}: { sites: any[]; todayBySite: Record<string, any>; allMembers: any[]; wageBySite: Record<string, any> }) {
  const navigate = useNavigate();
  const stats = useMemo(() => {
    const inProgress = sites.filter((s) => s.status !== 'COMPLETED');
    let totalAttended = 0, totalDone = 0, totalWorking = 0;
    let totalPayToday = 0;
    let manualBoost = 0, gpsBoost = 0;
    let totalRecords = 0;
    for (const s of inProgress) {
      const t = todayBySite[s.id];
      if (!t) continue;
      totalAttended += (t.summary?.workingCount ?? 0) + (t.summary?.doneCount ?? 0);
      totalDone    += t.summary?.doneCount ?? 0;
      totalWorking += t.summary?.workingCount ?? 0;
      for (const tm of t.members ?? []) {
        if (!tm.record) continue;
        totalRecords += 1;
        totalPayToday += tm.record.payAmount || 0;
        if (tm.record.checkInMethod === 'MANUAL') manualBoost += 1;
        if (tm.record.geofenceResult && tm.record.geofenceResult !== 'INSIDE') gpsBoost += 1;
      }
    }
    // 「오늘 노무비」 = 오늘 출역 records 의 payAmount 합산.
    //   대시보드와 노임비 화면 모두 같은 attendance bucket 을 본다.
    const totalPay = totalPayToday;
    const totalMembers = allMembers.filter((m) => !m.leftAt).length;
    const noContract = allMembers.filter((m) => !m.leftAt && !m.contractSigned).length;
    const noEdu = allMembers.filter((m) => !m.leftAt && !m.safetyEduCompleted).length;
    const denomR = Math.max(1, totalRecords);
    const denomM = Math.max(1, totalMembers);
    const score = Math.max(0, Math.round(100
      - (manualBoost / denomR) * 30
      - (gpsBoost / denomR) * 30
      - (noContract / denomM) * 20
      - (noEdu / denomM) * 20));
    const attendRate = totalMembers > 0 ? Math.round((totalAttended / totalMembers) * 100) : 0;
    const needAction = manualBoost + gpsBoost + noContract + noEdu;
    return {
      totalAttended, totalDone, totalWorking, totalMembers,
      totalPay, score, needAction, attendRate,
    };
  }, [sites, todayBySite, allMembers]);

  const scoreTone = stats.score >= 85 ? 'green' : stats.score >= 70 ? 'amber' : 'red';
  const scoreLabel = stats.score >= 85 ? '정상' : stats.score >= 70 ? '주의' : '위험';

  return (
    <section className="dash-hero">
      <button
        type="button"
        className="dash-hero__card"
        onClick={() => navigate('/attendance')}
      >
        <div className="dash-hero__label">오늘 출역</div>
        <div className="dash-hero__value">{stats.totalAttended}<span className="dash-hero__unit">명</span></div>
        <div className="dash-hero__sub">출근율 {stats.attendRate}%</div>
      </button>
      <button
        type="button"
        className="dash-hero__card"
        onClick={() => navigate('/attendance')}
      >
        <div className="dash-hero__label">퇴근 완료</div>
        <div className="dash-hero__value">{stats.totalDone}<span className="dash-hero__unit">명</span></div>
        <div className="dash-hero__sub">근무 중 {stats.totalWorking}명</div>
      </button>
      <button
        type="button"
        className="dash-hero__card"
        onClick={() => navigate('/output')}
      >
        <div className="dash-hero__label">오늘 노무비</div>
        <div className="dash-hero__value">{k(stats.totalPay)}<span className="dash-hero__unit">원</span></div>
        <div className="dash-hero__sub">현장별 합계</div>
      </button>
      <button
        type="button"
        className="dash-hero__card"
        onClick={() => {
          const el = document.querySelector('.dash-urgent');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      >
        <div className="dash-hero__label">처리 필요</div>
        <div className="dash-hero__value">{stats.needAction}<span className="dash-hero__unit">건</span></div>
        <div className="dash-hero__sub">계약·동의·교통 등</div>
      </button>
      <div className={'dash-hero__card dash-hero__card--score dash-hero__card--' + scoreTone}>
        <div className="dash-hero__label">출역 신뢰도</div>
        <div className="dash-hero__value">{stats.score}<span className="dash-hero__unit">점</span></div>
        <div className="dash-hero__sub">{scoreLabel}</div>
      </div>
    </section>
  );
}

// ───── ② UrgentTasks ────────────────────────────────────────

function DashUrgentTasks({
  sites, todayBySite, allMembers,
}: { sites: any[]; todayBySite: Record<string, any>; allMembers: any[] }) {
  const navigate = useNavigate();
  const [drillKey, setDrillKey] = useState<null | 'manual' | 'gps' | 'contract' | 'edu'>(null);

  const groups = useMemo(() => {
    const inProgress = sites.filter((s) => s.status !== 'COMPLETED');
    const manual: any[] = [], gps: any[] = [];
    for (const s of inProgress) {
      const t = todayBySite[s.id];
      if (!t) continue;
      for (const tm of t.members ?? []) {
        if (!tm.record) continue;
        if (tm.record.checkInMethod === 'MANUAL') manual.push({ siteId: s.id, siteName: s.name, ...tm });
        if (tm.record.geofenceResult && tm.record.geofenceResult !== 'INSIDE') gps.push({ siteId: s.id, siteName: s.name, ...tm });
      }
    }
    const contract = allMembers.filter((m) => !m.leftAt && !m.contractSigned);
    const edu = allMembers.filter((m) => !m.leftAt && !m.safetyEduCompleted);
    return { manual, gps, contract, edu };
  }, [sites, todayBySite, allMembers]);

  const cards = [
    {
      key: 'manual' as const,
      label: '수동보정 승인',
      count: groups.manual.length,
      unit: '건',
      action: '검토하기',
      tone: 'amber',
      goto: () => navigate('/attendance'),
    },
    {
      key: 'gps' as const,
      label: '위치 오류',
      count: groups.gps.length,
      unit: '건',
      action: '확인하기',
      tone: 'red',
      goto: () => navigate('/attendance'),
    },
    {
      key: 'contract' as const,
      label: '계약 미체결',
      count: groups.contract.length,
      unit: '명',
      action: '계약 요청',
      tone: 'amber',
      goto: () => navigate('/team'),
    },
    {
      key: 'edu' as const,
      label: '안전교육 미이수',
      count: groups.edu.length,
      unit: '명',
      action: '교육 발송',
      tone: 'amber',
      goto: () => navigate('/safety'),
    },
  ];

  return (
    <section className="dash-urgent">
      <header className="dash-section__head">
        <h2>긴급 처리</h2>
        <p>지금 처리해야 할 항목을 모았습니다. 카드를 누르면 상세 목록이 열립니다.</p>
      </header>
      <div className="dash-urgent__grid">
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            className={'dash-urgent__card dash-urgent__card--' + c.tone + (c.count === 0 ? ' is-empty' : '')}
            onClick={() => c.count > 0 && setDrillKey(c.key)}
            disabled={c.count === 0}
          >
            <div className="dash-urgent__card-top">
              <span className="dash-urgent__label">{c.label}</span>
              <span className="dash-urgent__count">
                <strong>{c.count}</strong>
                <span className="dash-urgent__count-unit">{c.unit}</span>
              </span>
            </div>
            <div
              className="dash-urgent__card-bottom"
              onClick={(e) => { e.stopPropagation(); if (c.count > 0) c.goto(); }}
              role="button"
              tabIndex={c.count > 0 ? 0 : -1}
            >
              <span className="dash-urgent__action">{c.count > 0 ? c.action : '처리할 항목 없음'}</span>
              {c.count > 0 && <span className="dash-urgent__arrow" aria-hidden>→</span>}
            </div>
          </button>
        ))}
      </div>

      {drillKey && (() => {
        const titleMap = {
          manual:   { label: '수동보정 승인',     approve: '승인',      reject: '거절' },
          gps:      { label: '위치 오류',         approve: '확인',      reject: '무시' },
          contract: { label: '계약 미체결',       approve: '계약 발송', reject: '보류' },
          edu:      { label: '안전교육 미이수',   approve: '교육 발송', reject: '보류' },
        } as const;
        const meta = titleMap[drillKey];
        const drillRows: DrillRow[] = (() => {
          if (drillKey === 'manual') {
            return groups.manual.map((r: any) => ({
              id: 'manual-' + r.siteId + '-' + r.memberId,
              name: r.memberName,
              siteId: r.siteId,
              siteName: r.siteName,
              reason: r.record?.manualReason ?? '수동 처리',
            }));
          }
          if (drillKey === 'gps') {
            return groups.gps.map((r: any) => ({
              id: 'gps-' + r.siteId + '-' + r.memberId,
              name: r.memberName,
              siteId: r.siteId,
              siteName: r.siteName,
              reason: r.record?.distanceFromSiteM
                ? Math.round(r.record.distanceFromSiteM) + 'm 이탈'
                : 'GPS 미수집',
            }));
          }
          if (drillKey === 'contract') {
            return groups.contract.map((m: any) => {
              const site = sites.find((s: any) => s.id === m.siteId);
              return {
                id: 'contract-' + (m.siteId ?? 'none') + '-' + m.id,
                name: m.name,
                siteId: m.siteId ?? 'none',
                siteName: site?.name ?? '현장 미배정',
                reason: '계약서 미체결',
              };
            });
          }
          return groups.edu.map((m: any) => {
            const site = sites.find((s: any) => s.id === m.siteId);
            return {
              id: 'edu-' + (m.siteId ?? 'none') + '-' + m.id,
              name: m.name,
              siteId: m.siteId ?? 'none',
              siteName: site?.name ?? '현장 미배정',
              reason: '기초안전 미이수',
            };
          });
        })();
        return (
          <UrgentDrillModal
            title={meta.label}
            rows={drillRows}
            actions={{ approveLabel: meta.approve, rejectLabel: meta.reject }}
            onClose={() => setDrillKey(null)}
          />
        );
      })()}
    </section>
  );
}

interface DrillRow {
  id: string;        // memberId 또는 recordId — 처리/취소 시 식별용
  name: string;
  siteId: string;
  siteName: string;
  reason: string;
}
interface DrillActions {
  approveLabel: string;   // 「승인」 / 「확인」 / 「발송」
  rejectLabel: string;    // 「거절」 / 「무시」 / 「보류」
}

function UrgentDrillModal({
  title, rows, actions, onClose,
}: {
  title: string;
  rows: DrillRow[];
  actions: DrillActions;
  onClose: () => void;
}) {
  // 처리/거절 시 화면에서 즉시 제거 (optimistic) — 실제 API 는 시연 단계라 alert 만
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = rows.filter((r) => !hidden.has(r.id));

  // 현장별 그룹핑 — 각 그룹 안에서 입력 순서 유지
  const groups: Array<{ siteId: string; siteName: string; rows: DrillRow[] }> = [];
  const idx = new Map<string, number>();
  for (const r of visible) {
    let i = idx.get(r.siteId);
    if (i === undefined) {
      i = groups.length;
      idx.set(r.siteId, i);
      groups.push({ siteId: r.siteId, siteName: r.siteName, rows: [] });
    }
    groups[i].rows.push(r);
  }

  function approve(r: DrillRow) {
    setHidden((prev) => { const n = new Set(prev); n.add(r.id); return n; });
    window.alert(`「${r.name}」 항목을 ${actions.approveLabel} 처리했습니다.\n(${r.siteName})`);
  }
  function reject(r: DrillRow) {
    setHidden((prev) => { const n = new Set(prev); n.add(r.id); return n; });
    window.alert(`「${r.name}」 항목을 ${actions.rejectLabel} 처리했습니다.\n(${r.siteName})`);
  }
  function approveGroup(g: { rows: DrillRow[]; siteName: string }) {
    if (!window.confirm(`${g.siteName} 의 ${g.rows.length}건 모두 ${actions.approveLabel} 처리하시겠습니까?`)) return;
    setHidden((prev) => {
      const n = new Set(prev);
      g.rows.forEach((r) => n.add(r.id));
      return n;
    });
  }

  return (
    <Modal open onClose={onClose} title={title} subtitle={`${visible.length}건 (현장 ${groups.length}곳)`} width={620}>
      {visible.length === 0 ? (
        <div className="dash-drill__empty">처리할 항목이 없습니다.</div>
      ) : (
        <div className="dash-drill">
          {groups.map((g) => (
            <div key={g.siteId} className="dash-drill__group">
              <header className="dash-drill__group-head">
                <strong>{g.siteName}</strong>
                <span className="dash-drill__group-count">{g.rows.length}건</span>
                {g.rows.length > 1 && (
                  <button
                    type="button"
                    className="dash-drill__bulk"
                    onClick={() => approveGroup(g)}
                    title={`이 현장 ${g.rows.length}건 모두 ${actions.approveLabel}`}
                  >
                    전체 {actions.approveLabel}
                  </button>
                )}
              </header>
              <ul className="dash-drill__list">
                {g.rows.map((r) => (
                  <li key={r.id} className="dash-drill__row">
                    <strong>{r.name}</strong>
                    <span title={r.reason}>{r.reason}</span>
                    <div className="dash-drill__actions">
                      <button type="button" className="dash-drill__btn dash-drill__btn--approve" onClick={() => approve(r)}>
                        {actions.approveLabel}
                      </button>
                      <button type="button" className="dash-drill__btn dash-drill__btn--reject" onClick={() => reject(r)}>
                        {actions.rejectLabel}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ───── ③ Operations Table/Card ─────────────────────────────

function DashOperations({
  sites, todayBySite, allMembers, closeStatusBySite, wageBySite, onSelectSite,
}: {
  sites: any[];
  todayBySite: Record<string, any>;
  allMembers: any[];
  closeStatusBySite: Record<string, any>;
  wageBySite: Record<string, any>;
  onSelectSite: (siteId: string) => void;
}) {
  const navigate = useNavigate();
  const [view, setView] = useState<'table' | 'card'>(() => {
    try { return (localStorage.getItem('dash.opsView') as any) || 'table'; } catch { return 'table'; }
  });
  function setViewPersist(v: 'table' | 'card') {
    setView(v);
    try { localStorage.setItem('dash.opsView', v); } catch { /* */ }
  }

  const stats = useMemo(() => {
    const inProgress = sites.filter((s) => s.status !== 'COMPLETED');
    return inProgress.map((s) => deriveSiteStat(s, allMembers, todayBySite[s.id], closeStatusBySite[s.id], wageBySite[s.id]));
  }, [sites, allMembers, todayBySite, closeStatusBySite, wageBySite]);

  return (
    <section className="dash-ops">
      <header className="dash-section__head">
        <div>
          <h2>현장별 운영 현황</h2>
          <p>출역과 정산을 한 줄에서 함께 확인합니다. 행을 클릭하면 현장 상세로 이동합니다.</p>
        </div>
        <div className="dash-ops__view-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            className={'dash-ops__view-btn' + (view === 'table' ? ' is-active' : '')}
            onClick={() => setViewPersist('table')}
          >표 보기</button>
          <button
            type="button"
            role="tab"
            className={'dash-ops__view-btn' + (view === 'card' ? ' is-active' : '')}
            onClick={() => setViewPersist('card')}
          >카드 보기</button>
        </div>
      </header>

      {stats.length === 0 ? (
        <div className="dash-ops__empty">시공중인 현장이 없습니다.</div>
      ) : view === 'table' ? (
        <div className="dash-ops__table-wrap">
          <table className="dash-ops__table">
            <thead>
              <tr>
                <th className="ot-name">현장명</th>
                <th>오늘 출역</th>
                <th>얼굴인식</th>
                <th>수동처리</th>
                <th>위치오류</th>
                <th>지각/조퇴</th>
                <th>퇴근</th>
                <th>오늘 노무비</th>
                <th>월 누적</th>
                <th>공제</th>
                <th>실지급</th>
                <th>상태</th>
                <th className="ot-actions">관리</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => {
                const sb = statusBadgeV2(s.status);
                return (
                  <tr key={s.siteId} onClick={() => { onSelectSite(s.siteId); navigate('/sites'); }}>
                    <td className="ot-name"><strong>{s.siteName}</strong></td>
                    <td><strong>{s.todayAttended}</strong>/{s.totalMembers}</td>
                    <td>{s.faceCount}</td>
                    <td className={s.manualCount > 0 ? 'is-warn' : ''}>{s.manualCount}</td>
                    <td className={s.gpsErrorCount > 0 ? 'is-danger' : ''}>{s.gpsErrorCount}</td>
                    <td>{s.lateLeftCount}</td>
                    <td>{s.doneCount}</td>
                    <td className="ot-money" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}>
                      <button type="button" className="ot-money-link" title="노무비 관리로 이동">{k(s.todayPay)}</button>
                    </td>
                    <td className="ot-money" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}>
                      <button type="button" className="ot-money-link" title="노무비 관리로 이동">{k(s.monthAccumPay)}</button>
                    </td>
                    <td className="ot-money" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}>
                      <button type="button" className="ot-money-link" title="노무비 관리로 이동">{k(s.deduction)}</button>
                    </td>
                    <td className="ot-money" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}>
                      <button type="button" className="ot-money-link" title="노무비 관리로 이동">{k(s.netPay)}</button>
                    </td>
                    <td><span className={'dash-status-chip dash-status-chip--' + sb.tone}>{sb.label}</span></td>
                    <td className="ot-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="dash-ops__row-btn" onClick={() => navigate('/attendance?siteId=' + encodeURIComponent(s.siteId))}>출역</button>
                      <button type="button" className="dash-ops__row-btn" onClick={() => navigate('/wage?siteId=' + encodeURIComponent(s.siteId))}>정산</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dash-ops__cards">
          {stats.map((s) => {
            const sb = statusBadgeV2(s.status);
            return (
              <article key={s.siteId} className={'dash-ops-card dash-ops-card--' + sb.tone}>
                <header className="dash-ops-card__head">
                  <h3>{s.siteName}</h3>
                  <span className={'dash-status-chip dash-status-chip--' + sb.tone}>{sb.label}</span>
                </header>
                <dl className="dash-ops-card__rows">
                  <div><dt>출역</dt><dd><strong>{s.todayAttended}/{s.totalMembers}</strong>명 · 얼굴 {s.faceCount}명 · 수동 {s.manualCount}건 · 위치오류 {s.gpsErrorCount}건</dd></div>
                  <div>
                    <dt>정산</dt>
                    <dd>
                      오늘 <button type="button" className="ot-money-link" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}><strong>{k(s.todayPay)}</strong></button>
                      <span className="fr-dot"> · </span>
                      월누적 <button type="button" className="ot-money-link" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}>{k(s.monthAccumPay)}</button>
                      <span className="fr-dot"> · </span>
                      실지급 <button type="button" className="ot-money-link" onClick={(e) => { e.stopPropagation(); navigate('/wage?siteId=' + encodeURIComponent(s.siteId)); }}><strong>{k(s.netPay)}</strong></button>
                    </dd>
                  </div>
                </dl>
                <footer className="dash-ops-card__actions">
                  <button type="button" className="dash-ops__row-btn" onClick={() => navigate('/attendance?siteId=' + encodeURIComponent(s.siteId))}>출역 보기</button>
                  <button type="button" className="dash-ops__row-btn" onClick={() => navigate('/wage?siteId=' + encodeURIComponent(s.siteId))}>정산 보기</button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ───── ④ MonthCloseProgress ────────────────────────────────

function DashMonthCloseProgress({
  sites, closeStatusBySite,
}: { sites: any[]; closeStatusBySite: Record<string, any> }) {
  // 전체 시공중 현장의 평균/최저 진행 상태로 5단계 표시
  const stages = useMemo(() => {
    const inProgress = sites.filter((s) => s.status !== 'COMPLETED');
    const closes = inProgress.map((s) => closeStatusBySite[s.id]).filter(Boolean);
    const totalSites = inProgress.length;
    const todayConfirmed = closes.filter((c) => c.todayHqOk || c.todayClosed).length;
    const monthAttHQ = closes.filter((c) => c.attStage === 'HQ_CONFIRMED').length;
    const wagePaid = closes.filter((c) => c.wageStage === 'PAID' || c.wageStage === 'SETTLED').length;
    const settled = closes.filter((c) => c.wageStage === 'SETTLED').length;

    function stageTone(done: number, total: number, anyMid: boolean): { label: string; tone: string } {
      if (total === 0) return { label: '대기', tone: 'gray' };
      if (done === total) return { label: '완료', tone: 'green' };
      if (anyMid || done > 0) return { label: '진행중', tone: 'blue' };
      return { label: '대기', tone: 'gray' };
    }
    return [
      { name: '출역확정', sub: `${todayConfirmed}/${totalSites} 현장`, ...stageTone(todayConfirmed, totalSites, todayConfirmed > 0) },
      { name: '월 공수 확정', sub: `${monthAttHQ}/${totalSites} 현장`, ...stageTone(monthAttHQ, totalSites, monthAttHQ > 0) },
      { name: '노무비 마감', sub: `${wagePaid}/${totalSites} 현장`, ...stageTone(wagePaid, totalSites, wagePaid > 0) },
      { name: '명세서/신고자료', sub: wagePaid >= totalSites && totalSites > 0 ? '준비됨' : '준비중', tone: wagePaid >= totalSites && totalSites > 0 ? 'blue' : 'gray', label: wagePaid >= totalSites && totalSites > 0 ? '검토필요' : '대기' },
      { name: '퇴직공제', sub: `${settled}/${totalSites} 현장`, ...stageTone(settled, totalSites, settled > 0) },
    ];
  }, [sites, closeStatusBySite]);

  return (
    <section className="dash-mclose">
      <header className="dash-section__head">
        <h2>월 마감 진행</h2>
        <p>이번 달 마감 단계별 진행 상태입니다.</p>
      </header>
      <ol className="dash-mclose__list">
        {stages.map((s, i) => (
          <li key={s.name} className="dash-mclose__item">
            <span className="dash-mclose__step">{i + 1}</span>
            <div className="dash-mclose__body">
              <strong>{s.name}</strong>
              <span className="dash-mclose__sub">{s.sub}</span>
            </div>
            <span className={'dash-mclose__chip dash-mclose__chip--' + s.tone}>{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ───── ⑤ BottomCards (4 cards) ──────────────────────────────

function DashBottomCards({
  sites, allMembers, allForemen, todayBySite, foremanMetricsById,
}: {
  sites: any[];
  allMembers: any[];
  allForemen: any[];
  todayBySite: Record<string, any>;
  foremanMetricsById: Record<string, any>;
}) {
  const navigate = useNavigate();

  // 직종별 인원 (상위 6)
  const roleStats = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of allMembers) {
      if (m.leftAt) continue;
      const r = m.role ?? '기타';
      map.set(r, (map.get(r) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([role, count]) => ({ role, count }));
  }, [allMembers]);

  // 반장별 출역 — ForemanPage 와 동일한 metric (얼굴인식률·수동처리율) + 오늘 출역 동기화
  const foremanStats = useMemo(() => {
    return allForemen
      .filter((f) => f.registered)
      .map((f) => {
        const t = todayBySite[f.siteId];
        const metric = foremanMetricsById[f.id];
        let attended = 0, manual = 0;
        if (t) {
          for (const tm of t.members ?? []) {
            const member = allMembers.find((m) => m.id === tm.memberId);
            if (member?.foremanId !== f.id) continue;
            if (tm.status === 'WORKING' || tm.status === 'DONE') attended += 1;
            if (tm.record?.checkInMethod === 'MANUAL') manual += 1;
          }
        }
        // 누적 지표가 있으면 우선 사용 (ForemanPage 와 동일 화면)
        const recentManual = metric?.recentManualCount ?? manual;
        const todayAttended = metric?.todayAttendanceCount ?? attended;
        let status: { label: string; tone: 'green' | 'amber' | 'gray' } = { label: '활동중', tone: 'green' };
        if (recentManual >= 3) status = { label: '확인필요', tone: 'amber' };
        else if (todayAttended === 0) status = { label: '미활동', tone: 'gray' };
        return { foremanId: f.id, name: f.name, attended: todayAttended, manual: recentManual, status };
      })
      .sort((a, b) => b.attended - a.attended)
      .slice(0, 6);
  }, [allForemen, allMembers, todayBySite, foremanMetricsById]);

  // 안전 알림 (간단 요약 — 미이수 인원 + 발송 액션)
  const noEduCount = useMemo(
    () => allMembers.filter((m) => !m.leftAt && !m.safetyEduCompleted).length,
    [allMembers],
  );

  return (
    <section className="dash-bottom">
      {/* 카드 1: 직종별 인원 */}
      <article className="dash-mini">
        <header className="dash-mini__head">
          <h3>직종별 인원</h3>
          <button type="button" className="dash-mini__more" onClick={() => navigate('/team')}>더보기</button>
        </header>
        <ul className="dash-mini__list">
          {roleStats.slice(0, 6).map((r) => (
            <li key={r.role}>
              <span className="dash-mini__name">{r.role}</span>
              <span className="dash-mini__val"><strong>{r.count}</strong>명</span>
            </li>
          ))}
          {roleStats.length === 0 && <li className="dash-mini__empty">등록된 팀원이 없습니다.</li>}
        </ul>
      </article>

      {/* 카드 2: 반장별 출역 */}
      <article className="dash-mini">
        <header className="dash-mini__head">
          <h3>반장별 출역</h3>
          <button type="button" className="dash-mini__more" onClick={() => navigate('/foremen')}>더보기</button>
        </header>
        <ul className="dash-mini__list">
          {foremanStats.map((f) => (
            <li key={f.foremanId}>
              <span className="dash-mini__name">{f.name} 반장</span>
              <span className="dash-mini__val">
                <strong>{f.attended}</strong>명
                {f.manual > 0 && <span className="dash-mini__sub"> · 수동 {f.manual}</span>}
              </span>
              <span className={'dash-status-chip dash-status-chip--sm dash-status-chip--' + f.status.tone}>{f.status.label}</span>
            </li>
          ))}
          {foremanStats.length === 0 && <li className="dash-mini__empty">등록된 반장이 없습니다.</li>}
        </ul>
      </article>

      {/* 카드 3: 안전 알림 */}
      <article className="dash-mini">
        <header className="dash-mini__head">
          <h3>안전 알림</h3>
          <button type="button" className="dash-mini__more" onClick={() => navigate('/safety')}>새 알림 발송</button>
        </header>
        <ul className="dash-mini__list">
          <li>
            <span className="dash-mini__name">TBM·출근 전 안전공지</span>
            <span className="dash-mini__val"><strong>오늘</strong> 발송예정</span>
          </li>
          <li>
            <span className="dash-mini__name">안전교육 미이수</span>
            <span className="dash-mini__val">
              <strong>{noEduCount}</strong>명
              {noEduCount > 0 && <span className="dash-status-chip dash-status-chip--sm dash-status-chip--amber">확인필요</span>}
            </span>
          </li>
          <li>
            <span className="dash-mini__name">발송 상태</span>
            <span className="dash-mini__val"><span className="dash-status-chip dash-status-chip--sm dash-status-chip--green">정상</span></span>
          </li>
        </ul>
      </article>

      {/* 카드 4: 출력 자료 */}
      <article className="dash-mini">
        <header className="dash-mini__head">
          <h3>출력 자료</h3>
          <button type="button" className="dash-mini__more" onClick={() => navigate('/output')}>출력센터</button>
        </header>
        <ul className="dash-mini__list dash-mini__list--btns">
          <li>
            <button type="button" className="dash-mini__btn" onClick={() => navigate('/output')}>일용근로자 임금대장</button>
          </li>
          <li>
            <button type="button" className="dash-mini__btn" onClick={() => navigate('/output')}>고용·산재 신고서</button>
          </li>
          <li>
            <button type="button" className="dash-mini__btn" onClick={() => navigate('/output')}>퇴직공제 신고서</button>
          </li>
          <li>
            <button type="button" className="dash-mini__btn" onClick={() => navigate('/output')}>월별 노무비 명세</button>
          </li>
        </ul>
      </article>
    </section>
  );
}
