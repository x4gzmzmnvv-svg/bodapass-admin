import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { WorkCloseHeader } from '../components/WorkCloseHeader';
import { Modal } from '../components/Modal';
import { siteApi } from '../api/site';
import { wageApi } from '../api/wage';
import { attendanceApi } from '../api/attendance';
import type { CloseStage, MonthClose } from '../api/attendance.types';
import type { Site } from '../api/site.types';
import type {
  PayoutDispatchResponse,
  SeveranceMonthSummary,
  WageMonthSummary,
  WageRow,
} from '../api/wage.types';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { computeWorkCloseProgress } from '../utils/workCloseProgress';
import { openPrintWindow } from '../utils/printDoc';
import { buildBulkPayslipHtml, buildLaborReportHtml } from '../utils/payrollDocs';
import { appendDispatchLog } from '../utils/messageTemplates';
import {
  buildLedgerFromWage,
  downloadLedgerXlsx,
  appendToArchive,
} from '../utils/wageLedger';
import type { LedgerDoc } from '../utils/wageLedger';
import './WagePage.css';

import { MacSelect } from '../components/MacSelect';
import { ElectronicCardCompare } from '../components/ElectronicCardCompare';
import {
  classifyForSeverance,
  loadFundDaily,
  mutualAidAccrued,
  legalSeverance,
} from '../utils/severance';
type Tab = 'wage' | 'severance';

/**
 * 노임비 / 퇴직금 관리 — 와이어프레임 030, 031, 033, 034.png
 *
 * 상단: 현장 선택 + 년월 선택 + Tab(노임비/퇴직금)
 * 본문: 요약 카드 행 + 그리드(테이블)
 * 우측 상단: 출력 / Excel / 카카오톡 발송
 */
export function WagePage({ defaultTab = 'wage' }: { defaultTab?: Tab } = {}) {
  const { viewMode, assignedSiteId } = useAuth();
  const [tab, setTab] = useState<Tab>(defaultTab);
  // defaultTab 변경 시 sync (라우트 전환 시)
  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);
  // URL ?siteId=… 로 진입한 경우 해당 현장을 자동 선택. 대시보드 「정산」 버튼 등에서 사용.
  const location = useLocation();
  const isWageCloseRoute = location.pathname === '/wage-close';
  const [searchParams, setSearchParams] = useSearchParams();
  const querySiteId = searchParams.get('siteId') ?? null;
  const [sites, setSites] = useState<Site[]>([]);
  /** 'ALL' = 전체 현장 합계 / 그 외 = 특정 사이트 ID */
  const [siteId, setSiteId] = useState<string>(
    viewMode === 'SITE' && assignedSiteId
      ? assignedSiteId
      : querySiteId
        ? querySiteId
        : 'ALL',
  );
  // 사이트 목록 로드 후 querySiteId 동기화 + URL 정리
  useEffect(() => {
    if (!querySiteId) return;
    if (siteId === querySiteId) return;
    setSiteId(querySiteId);
    setSearchParams((sp: URLSearchParams) => {
      const next = new URLSearchParams(sp);
      next.delete('siteId');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySiteId]);
  const [yearMonth, setYearMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );

  const [wage, setWage] = useState<WageMonthSummary | null>(null);
  const [sev, setSev] = useState<SeveranceMonthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 월마감 상태 — 단일 site 일 때만 의미 있음. 임금 발행은 마감 후에만 가능 */
  const [monthClose, setMonthClose] = useState<MonthClose | null>(null);
  const isMonthClosed = monthClose?.status === 'CLOSED';
  /** ALL 모드 — 현장별 요약 (근무일/지급액/공제합계/공제별 내역/마감여부) */
  const [perSiteSummary, setPerSiteSummary] = useState<Array<{
    site: Site;
    memberCount: number;
    workDays: number;
    totalPay: number;
    deductionTotal: number;
    /** 공제 항목별 합계 — 「상세」 모달이 deductionTotal 과 합이 같도록 */
    dedPension: number;     // 국민연금
    dedHealth: number;      // 건강보험
    dedEmployment: number;  // 고용보험
    dedAccident: number;    // 산재보험
    dedIncomeTax: number;   // 소득세
    dedLocalTax: number;    // 지방소득세
    monthClose: MonthClose | null;
  }>>([]);
  /** ALL 모드에서 사용자가 클릭한 단일 현장 — 하단 직종합계/멤버표만 그 site로 필터, 화면 전환 안함 */
  const [focusedSiteId, setFocusedSiteId] = useState<string | null>(null);
  /** 직종 필터 — 사이드바 직종별 합계에서 토글 */
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  /** site별 wage 원본 — focusedSiteId 따라 하나만 골라 WageTab 에 전달 */
  const [wagePerSite, setWagePerSite] = useState<Record<string, WageMonthSummary>>({});

  // 사이트 목록 1회 로드
  useEffect(() => {
    siteApi.listSites().then((s) => {
      const visible =
        viewMode === 'SITE' && assignedSiteId
          ? s.sites.filter((x) => x.id === assignedSiteId)
          : s.sites;
      setSites(visible);
    });
  }, [viewMode, assignedSiteId]);

  const load = useCallback(async () => {
    if (!siteId) return;
    if (siteId !== 'ALL' && sites.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const targetIds = siteId === 'ALL' ? sites.map((s) => s.id) : [siteId];
      if (targetIds.length === 0) {
        setWage(null);
        setSev(null);
        return;
      }
      if (tab === 'wage') {
        const all = await Promise.all(
          targetIds.map((sid) => wageApi.monthSummary({ siteId: sid, yearMonth })),
        );
        setWage(mergeWage(all));
        // site → wage 맵 저장 (focusedSiteId 필터링용)
        const wpsMap: Record<string, WageMonthSummary> = {};
        for (let i = 0; i < targetIds.length; i++) wpsMap[targetIds[i]] = all[i];
        setWagePerSite(wpsMap);
        // ALL 모드 — 현장별 요약 + 마감 상태 동시 fetch
        if (siteId === 'ALL') {
          const closeAll = await Promise.all(
            targetIds.map((sid) =>
              attendanceApi.closeStatus(sid, yearMonth).catch(() => null),
            ),
          );
          const summary: typeof perSiteSummary = [];
          for (let i = 0; i < targetIds.length; i++) {
            const s = sites.find((x) => x.id === targetIds[i]);
            if (!s) continue;
            const w = all[i];
            const cs = closeAll[i];
            const workDays = w.rows.reduce((sum, r) => sum + r.workDays, 0);
            const totalPay = w.rows.reduce((sum, r) => sum + r.netAmount, 0);
            const deductionTotal = w.rows.reduce((sum, r) => sum + r.deductionTotal, 0);
            // 공제 항목별 합계 — 모달이 합이 deductionTotal 과 정확히 일치
            const dedPension    = w.rows.reduce((s, r) => s + (r.deductionPension    ?? 0), 0);
            const dedHealth     = w.rows.reduce((s, r) => s + (r.deductionHealth     ?? 0), 0);
            const dedEmployment = w.rows.reduce((s, r) => s + (r.deductionEmployment ?? 0), 0);
            const dedAccident   = w.rows.reduce((s, r) => s + (r.deductionAccident   ?? 0), 0);
            const dedIncomeTax  = w.rows.reduce((s, r) => s + (r.deductionIncomeTax  ?? 0), 0);
            const dedLocalTax   = w.rows.reduce((s, r) => s + (r.deductionLocalTax   ?? 0), 0);
            summary.push({
              site: s,
              memberCount: w.rows.length,
              workDays,
              totalPay,
              deductionTotal,
              dedPension, dedHealth, dedEmployment, dedAccident, dedIncomeTax, dedLocalTax,
              monthClose: cs?.monthClose ?? null,
            });
          }
          setPerSiteSummary(summary);
        } else {
          setPerSiteSummary([]);
        }
      } else {
        const all = await Promise.all(
          targetIds.map((sid) => wageApi.severance({ siteId: sid, yearMonth })),
        );
        setSev(mergeSeverance(all));
        setPerSiteSummary([]);
      }
      // 월마감 상태 — 단일 site 만 의미 있음 (전체 MonthClose 객체 보관)
      if (siteId !== 'ALL') {
        try {
          const cs = await attendanceApi.closeStatus(siteId, yearMonth);
          setMonthClose(cs.monthClose);
        } catch { setMonthClose(null); }
      } else {
        setMonthClose(null);
      }
    } catch (err) {
      setError(getErrorMessage(err, '데이터 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [tab, siteId, yearMonth, sites]);

  useEffect(() => {
    load();
  }, [load]);

  // 사이트/월 변경 시 focused 자동 해제
  useEffect(() => {
    setFocusedSiteId(null);
  }, [siteId, yearMonth, tab]);

  const currentSite = useMemo(
    () => (siteId === 'ALL' ? null : sites.find((s) => s.id === siteId)),
    [sites, siteId],
  );

  /* ───────── 액션 ───────── */
  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  async function handleExportExcel() {
    if (!siteId) return;
    try {
      const r: PayoutDispatchResponse = await wageApi.exportExcel({
        siteId,
        yearMonth,
      });
      flash(`Excel 내보내기 완료 (${new Date(r.exportedAt).toLocaleTimeString()})`);
    } catch (err) {
      setError(getErrorMessage(err, 'Excel 내보내기 실패'));
    }
  }

  async function handleDispatch(channel: 'KAKAO' | 'SMS') {
    if (!siteId) return;
    try {
      await wageApi.dispatch({ siteId, yearMonth, channel });
      flash(
        channel === 'KAKAO'
          ? '카카오톡 명세서가 발송되었습니다.'
          : 'SMS 명세서가 발송되었습니다.',
      );
    } catch (err) {
      setError(getErrorMessage(err, '발송 실패'));
    }
  }

  return (
    <div className="wage">
      <PageHeader
        title={isWageCloseRoute ? '노무비 마감' : tab === 'wage' ? '노무비' : '퇴직금'}
        subtitle={isWageCloseRoute
          ? '월 공수마감 데이터로 지급액·공제·실지급을 확정합니다. 마감 후 노무비 지급으로 넘어갑니다.'
          : tab === 'wage' ? '현장별 월별 임금·4대보험·퇴직공제부금 정산' : '월별 퇴직금 적립 현황'}
        actions={isWageCloseRoute ? <WorkCloseHeader active="wage" siteId={siteId} progress={computeWorkCloseProgress({ today: null, monthClose })} /> : undefined}
      />

      {!isWageCloseRoute && tab !== 'severance' && (
        <div className="wage__actions wage__actions--bar">
            <MonthPicker value={yearMonth} onChange={setYearMonth} />
          </div>
      )}

            {error && <div className="wage__error">{error}</div>}
      {toast && <div className="wage__toast">{toast}</div>}

      {/* ─── 노무정산 신규 레이아웃 (wage 탭 전용) ─── */}
      {tab === 'wage' && (
        <WageOverviewHeader
          yearMonth={yearMonth}
          wage={
            focusedSiteId && wagePerSite[focusedSiteId]
              ? wagePerSite[focusedSiteId]
              : wage
          }
          perSiteSummary={perSiteSummary}
          monthClose={monthClose}
          isAllMode={siteId === 'ALL'}
        />
      )}

      {(() => {
        // focusedSiteId 가 있으면 해당 site 의 wage 만, 없으면 전체 합계
        const effectiveWage = focusedSiteId && wagePerSite[focusedSiteId]
          ? wagePerSite[focusedSiteId]
          : wage;
        const effectiveMonthClose = focusedSiteId
          ? (perSiteSummary.find((r) => r.site.id === focusedSiteId)?.monthClose ?? null)
          : monthClose;
        const siteRow = currentSite ? (
          <div className="wage__site-row">
            <p className="wage__site-line">
              <strong>{currentSite.name}</strong>
              <span className="wage__sep">·</span>
              담당자 {currentSite.manager} · {currentSite.managerPhone}
              <span className="wage__sep">·</span>
              기간 {currentSite.startDate} ~ {currentSite.endDate}
            </p>
            {siteId !== 'ALL' && monthClose && (
              <span
                className={'wage__close-bar ' + (isMonthClosed ? 'is-closed' : 'is-open')}
                title={
                  isMonthClosed
                    ? `${yearMonth} 월마감 — ${monthClose.closedByName ?? ''}${monthClose.closedAt ? ' · ' + monthClose.closedAt.slice(0, 16).replace('T', ' ') : ''}`
                    : `${yearMonth} 미마감 — 출퇴근 현황에서 월마감 후 진행`
                }
              >
                {isMonthClosed ? (
                  <>
                    🔒 <strong>{yearMonth}</strong> 월마감 완료
                    {monthClose.closedByName && <> · {monthClose.closedByName}</>}
                    {' · 발행 가능'}
                  </>
                ) : (
                  <>
                    🔓 <strong>{yearMonth}</strong> 미마감 — 월마감 후 발행
                  </>
                )}
              </span>
            )}
          </div>
        ) : null;
        const perSiteTable = siteId === 'ALL' && sites.length > 0 && tab === 'wage' && perSiteSummary.length > 0 ? (
          <PerSiteSummaryTable
            rows={perSiteSummary}
            focusedSiteId={focusedSiteId}
            onFocus={(sid) => setFocusedSiteId(sid === focusedSiteId ? null : sid)}
            yearMonth={yearMonth}
            authViewMode={viewMode}
            onReload={() => load()}
          />
        ) : null;

        if (loading) {
          return <p className="wage__loading">불러오는 중…</p>;
        }
        if (tab === 'severance') {
          const compareSiteId = focusedSiteId ?? (siteId === 'ALL' ? null : siteId);
          return (
            <>
              <SeveranceHero data={sev} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 220, maxWidth: 360 }}>
                  <MacSelect
                    value={siteId}
                    onChange={(v) => setSiteId(String(v))}
                    options={[
                      { value: 'ALL', label: <>전체 현장</> },
                      ...sites.map((s) => ({ value: s.id, label: <>{s.name}</> })),
                    ]}
                  />
                </div>
                <MonthPicker value={yearMonth} onChange={setYearMonth} />
                {siteId !== 'ALL' && monthClose && (
                  <span
                    className={'wage__close-bar ' + (isMonthClosed ? 'is-closed' : 'is-open')}
                    style={{ marginLeft: 'auto' }}
                    title={
                      isMonthClosed
                        ? `${yearMonth} 월마감 — ${monthClose.closedByName ?? ''}${monthClose.closedAt ? ' · ' + monthClose.closedAt.slice(0, 16).replace('T', ' ') : ''}`
                        : `${yearMonth} 미마감 — 출퇴근 현황에서 월마감 후 진행`
                    }
                  >
                    {isMonthClosed ? (
                      <>
                        🔒 <strong>{yearMonth}</strong> 월마감 완료
                        {monthClose.closedByName && <> · {monthClose.closedByName}</>}
                        {' · 발행 가능'}
                      </>
                    ) : (
                      <>
                        🔓 <strong>{yearMonth}</strong> 미마감 — 월마감 후 발행
                      </>
                    )}
                  </span>
                )}
              </div>
              <SeveranceTab data={sev} />
              <ElectronicCardCompare
                siteId={compareSiteId}
                yearMonth={yearMonth}
                sites={sites}
              />
            </>
          );
        }
        // wage 탭 — 1단 레이아웃. 현장 클릭(focusedSiteId) 또는 단일 현장 모드에서만 직종별 타일 노출
        return (
          <>
            {siteRow}
            {perSiteTable}
            <WageTab
              data={effectiveWage}
              yearMonth={yearMonth}
              sites={sites}
              siteId={focusedSiteId ?? siteId}
              monthClose={effectiveMonthClose}
              authViewMode={viewMode}
              onReload={() => load()}
              roleFilter={roleFilter}
              setRoleFilter={setRoleFilter}
              isWageCloseRoute={isWageCloseRoute}
            />
          </>
        );
      })()}
    </div>
  );
}

/* ────────────────── 직종별 합계 사이드바 (오른쪽 고정) ────────────────── */
function WageRoleTilesAside({
  data,
  roleFilter,
  setRoleFilter,
  isAllMode,
}: {
  data: WageMonthSummary | null;
  roleFilter: string | null;
  setRoleFilter: (r: string | null) => void;
  isAllMode: boolean;
}) {
  if (!data) return null;
  return (
    <section className="wage__by-role wage__by-role--side card">
      <header className="wage__by-role-head">
        <h3>직종별 합계 ({data.byRole.length}개 직종)</h3>
        <p>{isAllMode ? '전체 합계' : '선택 현장'} · 총 <strong>{krwShort(data.totalNet)}</strong></p>
      </header>
      <div className="role-tiles role-tiles--vertical role-tiles--scroll">
        {data.byRole.map((r) => (
          <button
            key={r.role}
            type="button"
            className={'role-tile' + (roleFilter === r.role ? ' is-active' : '')}
            onClick={() => setRoleFilter(roleFilter === r.role ? null : r.role)}
          >
            <span className="role-tile__name">{r.role}</span>
            <span className="role-tile__row">
              <span className="role-tile__meta">{r.count}명·{r.days}일</span>
              <span className="role-tile__amount">{krwShort(r.net)}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ────────────────── ① 정산 요약 헤더 (6 KPI) ────────────────── */
/**
 *  「2026년 5월 노무정산」
 *   ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
 *   │ 총 지급액 │ 공제액   │ 실지급액 │ 대상근로자│ 마감현장 │ 검토필요 │
 *   └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
 */
function WageOverviewHeader({
  yearMonth,
  wage,
  perSiteSummary,
  monthClose,
  isAllMode,
}: {
  yearMonth: string;
  wage: WageMonthSummary | null;
  perSiteSummary: Array<{
    site: Site;
    workDays: number;
    totalPay: number;
    deductionTotal: number;
    monthClose: MonthClose | null;
  }>;
  monthClose: MonthClose | null;
  isAllMode: boolean;
}) {
  const [y, m] = yearMonth.split('-').map(Number);
  /** 검토 필요 세부 모달 */
  const [reviewOpen, setReviewOpen] = useState(false);
  // 합계 계산
  const totalGross = wage?.rows.reduce((s, r) => s + r.baseAmount, 0) ?? 0;
  const totalDed = wage?.rows.reduce((s, r) => s + r.deductionTotal, 0) ?? 0;
  const totalNet = wage?.rows.reduce((s, r) => s + r.netAmount, 0) ?? 0;
  const memberCount = wage?.rows.length ?? 0;
  // 마감현장 = perSiteSummary 중 wageStage==='HQ_CONFIRMED' 이상
  const closedSiteCount = isAllMode
    ? perSiteSummary.filter((r) => {
        const ws = r.monthClose?.wageStage;
        return ws === 'HQ_CONFIRMED' || ws === 'PAID' || ws === 'SETTLED';
      }).length
    : monthClose &&
      (monthClose.wageStage === 'HQ_CONFIRMED' ||
        monthClose.wageStage === 'PAID' ||
        monthClose.wageStage === 'SETTLED')
      ? 1 : 0;
  const totalSiteCount = isAllMode ? perSiteSummary.length : 1;

  // 검토필요 세부 카운트 (mock 산출 — 실 운영 시 별도 API)
  const total = wage?.rows.length ?? 0;
  const reviewCategories: Array<{
    key: string; label: string; reason: string; action: string;
    count: number;
  }> = [
    { key: 'manual',      label: '수동보정',     reason: '얼굴인식 없이 수동 처리',         action: '승인',         count: Math.max(0, Math.round(total * 0.05)) },
    { key: 'no-contract', label: '계약미체결',   reason: '근로계약서 미서명',                action: '계약서 재발송', count: Math.max(0, Math.round(total * 0.04)) },
    { key: 'no-consent',  label: '동의미완료',   reason: '개인정보·얼굴인증 동의 미완',      action: '동의서 재발송', count: Math.max(0, Math.round(total * 0.03)) },
    { key: 'no-ins',      label: '보험정보누락', reason: '4대보험 자격취득 정보 누락',       action: '정보 입력',     count: Math.max(0, Math.round(total * 0.06)) },
    { key: 'no-out',      label: '퇴근누락',     reason: '퇴근 시각 미기록',                 action: '퇴근 보정',     count: Math.max(0, Math.round(total * 0.02)) },
  ];
  // 표 데이터 — 실제 wage rows 에서 N명씩 뽑아 mock 행 생성
  type ReviewItem = {
    catKey: string; catLabel: string; reason: string; action: string;
    memberId: string; memberName: string; role: string;
  };
  const reviewItems: ReviewItem[] = [];
  let cursor = 0;
  for (const c of reviewCategories) {
    for (let i = 0; i < c.count; i++) {
      const r = wage?.rows[(cursor + i) % Math.max(1, total)];
      if (!r) continue;
      reviewItems.push({
        catKey: c.key, catLabel: c.label, reason: c.reason, action: c.action,
        memberId: r.memberId, memberName: r.memberName, role: r.role,
      });
    }
    cursor += c.count;
  }
  const reviewNeeded = reviewCategories.reduce((s, t) => s + t.count, 0);

  function handleReviewAction(item: ReviewItem) {
    if (!window.confirm(`「${item.memberName}」 — ${item.action} 처리하시겠습니까?\n\n사유: ${item.reason}`)) return;
    window.alert(`✓ 「${item.memberName}」 ${item.action} 완료 (mock).`);
  }

  const tiles: Array<{
    key: string; label: string; value: string;
    accent: string;
    clickable?: boolean;
  }> = [
    { key: 'gross', label: '총 지급액', value: krw(totalGross), accent: '' },
    { key: 'ded',   label: '공제액', value: krw(totalDed), accent: 'is-ded' },
    { key: 'net',   label: '실지급액', value: krw(totalNet), accent: 'is-net' },
    { key: 'mem',   label: '대상 근로자', value: `${memberCount}명`, accent: '' },
    { key: 'site',  label: '마감 현장', value: `${closedSiteCount}/${totalSiteCount}`, accent: '' },
    { key: 'rev',   label: '검토 필요', value: `${reviewNeeded}건`, accent: reviewNeeded > 0 ? 'is-warn' : 'is-clean', clickable: true },
  ];

  // ─── 예정금액 / 확정금액 라벨 ───
  // perSiteSummary 의 wageStage 가 모두 SETTLED 면 「확정금액」, 그 외엔 「예정금액」
  // (단일 사이트 모드에선 그 사이트의 monthClose 만 본다)
  const allSettled = isAllMode
    ? perSiteSummary.length > 0 && perSiteSummary.every((r) => r.monthClose?.wageStage === 'SETTLED')
    : monthClose?.wageStage === 'SETTLED';
  const today = new Date();
  const todayLabel =
    `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;
  const estimateTag = allSettled
    ? `${todayLabel} 확정금액`
    : `${todayLabel} 기준 예정금액`;

  return (
    <section className="wage-overview">
      <div className="att-daily-kpi att-daily-kpi--notif att-daily-kpi--notif--6">
        {([
          { key: 'gross', label: '총 지급액',   raw: <b>{krw(totalGross)}</b>,                tone: 'plain' as const,  clickable: false },
          { key: 'ded',   label: '공제액',       raw: <b>{krw(totalDed)}</b>,                  tone: 'info' as const,   clickable: false },
          { key: 'net',   label: '실지급액',     raw: <b>{krw(totalNet)}</b>,                  tone: 'ok' as const,     clickable: false },
          { key: 'mem',   label: '대상 근로자',  raw: <><b>{memberCount}</b>명</>,             tone: 'plain' as const,  clickable: false },
          { key: 'site',  label: '마감 현장',    raw: <><b>{closedSiteCount}</b>/{totalSiteCount}</>, tone: 'plain' as const, clickable: false },
          { key: 'rev',   label: '검토 필요',    raw: <><b>{reviewNeeded}</b>건</>,            tone: (reviewNeeded > 0 ? 'danger' : 'ok') as 'danger' | 'ok', clickable: true },
        ]).map((s, i) => (
          <button
            key={i}
            type="button"
            className={'att-hero__tile att-hero__tile--' + s.tone}
            onClick={s.clickable ? () => setReviewOpen(true) : undefined}
            title={s.clickable ? '클릭 — 세부 항목 보기' : undefined}
          >
            <span className="att-hero__icon" aria-hidden>
              <svg viewBox="0 0 36 36" width="36" height="36">
                <rect x="0.5" y="0.5" width="35" height="35" rx="8" fill="#FAFAFA" stroke="#E5E7EB" />
                <g stroke="#D1D5DB" strokeWidth="0.5">
                  <line x1="0" y1="9"  x2="36" y2="9" />
                  <line x1="0" y1="18" x2="36" y2="18" />
                  <line x1="0" y1="27" x2="36" y2="27" />
                  <line x1="9"  y1="0" x2="9"  y2="36" />
                  <line x1="18" y1="0" x2="18" y2="36" />
                  <line x1="27" y1="0" x2="27" y2="36" />
                </g>
                <circle cx="18" cy="18" r="6" fill="none" stroke="#9CA3AF" strokeWidth="0.6" />
                <circle cx="18" cy="18" r="1.2" fill="#9CA3AF" />
              </svg>
            </span>
            <span className="att-hero__body">
              <strong className="att-hero__title">{s.label}</strong>
              <span className="att-hero__sub">{s.raw}</span>
            </span>
            <span className="att-hero__time">월</span>
          </button>
        ))}
      </div>

      {/* 제목 라인 — 히어로 아래에 배치 */}
      <header className="wage-overview__head wage-overview__head--below">
        <h3 className="wage-overview__title">
          {y}년 {m}월 노무정산
          <span className={'wage-overview__tag' + (allSettled ? ' is-final' : ' is-estimate')}>
            {estimateTag}
          </span>
        </h3>
        <span className="wage-overview__sub">
          {isAllMode ? '전체 현장 합계' : '선택 현장 기준'}
        </span>
      </header>

      {reviewOpen && (
        <Modal
          open={true}
          onClose={() => setReviewOpen(false)}
          title="검토 필요 세부 항목"
          subtitle={`정산 전에 확인이 필요한 항목 ${reviewNeeded}건 — 우측 「조치」 버튼으로 처리`}
          width={880}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="wage__per-site-detail"
                onClick={() => {
                  if (reviewItems.length === 0) return;
                  if (!window.confirm(`전체 ${reviewItems.length}건 일괄 처리하시겠습니까?`)) return;
                  window.alert(`✓ ${reviewItems.length}건 일괄 처리 완료 (mock).`);
                  setReviewOpen(false);
                }}
                disabled={reviewItems.length === 0}
              >
                전체 일괄 처리
              </button>
              <button
                type="button"
                className="wage__per-site-detail"
                onClick={() => setReviewOpen(false)}
              >
                닫기
              </button>
            </div>
          }
        >
          {/* 카테고리별 카운트 요약 */}
          <div className="wage-review-modal__summary">
            {reviewCategories.map((c) => (
              <span
                key={c.key}
                className={'wage-review-modal__chip' + (c.count > 0 ? ' has-value' : '')}
              >
                <em>{c.label}</em>
                <strong>{c.count}</strong>
              </span>
            ))}
          </div>

          {/* 상세 표 — Excel 스타일 */}
          {reviewItems.length === 0 ? (
            <div className="wage-review-modal__empty">
              ✓ 검토가 필요한 항목이 없습니다.
            </div>
          ) : (
            <div className="wage-review-modal__scroll">
              <table className="wage-review-modal__table">
                <colgroup>
                  <col style={{ width: 32 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 70 }} />
                  <col />
                  <col style={{ width: 110 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>구분</th>
                    <th>성명</th>
                    <th>직종</th>
                    <th>사유</th>
                    <th>조치</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewItems.map((it, i) => (
                    <tr key={`${it.catKey}-${it.memberId}-${i}`}>
                      <td className="wage-review-modal__num">{i + 1}</td>
                      <td>
                        <span className={'wage-review-modal__cat wage-review-modal__cat--' + it.catKey}>
                          {it.catLabel}
                        </span>
                      </td>
                      <td className="wage-review-modal__name">{it.memberName}</td>
                      <td>{it.role}</td>
                      <td className="wage-review-modal__reason">{it.reason}</td>
                      <td>
                        <button
                          type="button"
                          className="wage-review-modal__btn"
                          onClick={() => handleReviewAction(it)}
                          title={`${it.action} 처리`}
                        >
                          {it.action}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

/* ────────────────── ② 정산 진행 stepper (5단계) ────────────────── */
/**
 *  출역확정(월) → 노무비 확정 → 지급 → 명세서발행 → 마감
 *
 *  스테이지 매핑:
 *   ① 출역확정(월)   = attStage HQ_CONFIRMED  (출역+공수 확정 통합)
 *   ② 노무비 확정    = wageStage HQ_CONFIRMED (계산+공제확인 통합)
 *   ③ 지급           = wageStage PAID
 *   ④ 명세서발행     = wageStage PAID  (지급과 함께 발행)
 *   ⑤ 마감           = wageStage SETTLED
 */
function WageStepper({
  monthClose,
  isAllMode,
}: {
  monthClose: MonthClose | null;
  isAllMode: boolean;
}) {
  const att = monthClose?.attStage ?? 'OPEN';
  const wage = monthClose?.wageStage ?? 'OPEN';

  const steps: Array<{ label: string; done: boolean; current?: boolean }> = [
    { label: '출역확정(월)', done: att === 'HQ_CONFIRMED' },
    { label: '노무비 확정',  done: wage === 'HQ_CONFIRMED' || wage === 'PAID' || wage === 'SETTLED' },
    { label: '지급',          done: wage === 'PAID' || wage === 'SETTLED' },
    { label: '명세서발행',    done: wage === 'PAID' || wage === 'SETTLED' },
    { label: '마감',          done: wage === 'SETTLED' },
  ];

  // 현재 단계 = 가장 마지막 done의 다음 항목
  const currentIdx = steps.findIndex((s) => !s.done);
  if (currentIdx >= 0) steps[currentIdx].current = true;

  return (
    <section className="wage-stepper">
      <header className="wage-stepper__head">
        <h3 className="wage-stepper__title">정산 진행</h3>
        {isAllMode && (
          <span className="wage-stepper__hint">전체 모드 — 단일 현장 선택 시 진행도 표시</span>
        )}
      </header>
      <ol className={'wage-stepper__list' + (isAllMode ? ' is-disabled' : '')}>
        {steps.map((s, i) => (
          <li
            key={s.label}
            className={
              'wage-stepper__step' +
              (s.done ? ' is-done' : '') +
              (s.current ? ' is-current' : '')
            }
          >
            <span className="wage-stepper__num">{s.done ? '✓' : i + 1}</span>
            <span className="wage-stepper__label">{s.label}</span>
            {i < steps.length - 1 && <span className="wage-stepper__line" aria-hidden />}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ────────────────── ③ 검토 필요 (5타일) ────────────────── */
/**
 *  수동보정 / 계약미체결 / 동의미완료 / 보험정보누락 / 퇴근누락
 *
 *  실 운영 시 출역·계약·보험 데이터에서 산출. 현재는 wage rows 기반 mock 카운트.
 */
function WageReviewRow({ wage }: { wage: WageMonthSummary | null }) {
  // mock 카운트 — 실 운영 시 별도 API 호출
  const total = wage?.rows.length ?? 0;
  const tiles = [
    { key: 'manual',      label: '수동보정',     value: Math.max(0, Math.round(total * 0.05)) },
    { key: 'no-contract', label: '계약미체결',   value: Math.max(0, Math.round(total * 0.04)) },
    { key: 'no-consent',  label: '동의미완료',   value: Math.max(0, Math.round(total * 0.03)) },
    { key: 'no-ins',      label: '보험정보누락', value: Math.max(0, Math.round(total * 0.06)) },
    { key: 'no-out',      label: '퇴근누락',     value: Math.max(0, Math.round(total * 0.02)) },
  ];

  return (
    <section className="wage-review">
      <header className="wage-review__head">
        <h3 className="wage-review__title">검토 필요</h3>
        <p className="wage-review__sub">정산 전에 확인이 필요한 항목입니다. 클릭 시 대상자 목록.</p>
      </header>
      <div className="wage-review__tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'wage-review__tile' + (t.value > 0 ? ' has-value' : ' is-clean')}
            onClick={() =>
              window.alert(`「${t.label}」 ${t.value}건 — 대상자 목록 (mock).`)
            }
            title={`${t.label} 대상자 보기`}
          >
            <span className="wage-review__tile-label">{t.label}</span>
            <strong className="wage-review__tile-value">{t.value}</strong>
            <span className="wage-review__tile-unit">건</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ────────────────── 현장별 요약 테이블 (전체 모드) ────────────────── */

function PerSiteSummaryTable({
  rows,
  focusedSiteId,
  onFocus,
  yearMonth,
  authViewMode,
  onReload,
}: {
  rows: Array<{
    site: Site;
    memberCount: number;
    workDays: number;
    totalPay: number;
    deductionTotal: number;
    dedPension: number;
    dedHealth: number;
    dedEmployment: number;
    dedAccident: number;
    dedIncomeTax: number;
    dedLocalTax: number;
    monthClose: MonthClose | null;
  }>;
  focusedSiteId: string | null;
  onFocus: (siteId: string) => void;
  yearMonth: string;
  authViewMode: 'HQ' | 'SITE';
  onReload: () => void;
}) {
  /** 보기 모드 — 'PROGRESS': 시공중만 (기본), 'COMPLETED': 준공만 */
  const [viewMode, setViewMode] = useState<'PROGRESS' | 'COMPLETED'>('PROGRESS');
  /** 상세 보기 모달 — 행의 deductionTotal 과 합이 정확히 일치하는 항목별 내역 */
  const [detailFor, setDetailFor] = useState<{
    siteName: string;
    pension: number;
    health: number;
    employ: number;
    accident: number;
    incomeTax: number;
    localTax: number;
    total: number;
  } | null>(null);
  /** 정산상태 stepper 모달 — 클릭한 현장의 진행 단계 */
  const [stepperFor, setStepperFor] = useState<{
    siteName: string;
    monthClose: MonthClose | null;
  } | null>(null);
  /**
   * 「정산완료」 판정 — 노임비/사회보험 마감(monthClose) 단계가 SETTLED 까지 도달했는지.
   * 사이트가 status='COMPLETED' 라 해도 정산이 안 끝났으면 시공중 분류로 본다.
   *  · stage === 'SETTLED' → 정산완료 (= 「준공」 분류)
   *  · 그 외 (OPEN/SITE_CLOSED/HQ_CONFIRMED/PAID) → 정산 진행 중 (= 「시공중」 분류)
   */
  function isFullySettled(r: { monthClose: MonthClose | null }): boolean {
    return r.monthClose?.stage === 'SETTLED';
  }
  // 시공중/준공 카운트 (헤더 표시용)
  const inProgressCount = rows.filter((r) => !isFullySettled(r)).length;
  const completedCount  = rows.filter((r) =>  isFullySettled(r)).length;
  // 모드에 맞는 rows 만 추리기 (포커스 필터 전 단계)
  const modeFilteredRows = rows.filter((r) =>
    viewMode === 'COMPLETED' ? isFullySettled(r) : !isFullySettled(r),
  );
  /**
   * 시연용 예산/집행 계산:
   *  - 인건비 예산   = 도급금액의 35% (건설업 표준 대략)
   *  - 인건비 집행   = 인건비 예산 × 공정률
   *  - 집행율(%)     = 인건비 집행 / 인건비 예산
   *  - 4대보험 집행 (사용자 부담분 추정):
   *      국민연금 4.5% / 건강보험 3.545% / 고용보험 0.9% / 산재보험 0.93%
   *  - 퇴직공제부금  = 인건비 집행 × 0.5% (건설근로자공제회 적립)
   * 실 운영 시엔 회계 시스템에서 가져온 정확한 값을 표시.
   */
  const enriched = modeFilteredRows.map((r) => {
    const laborBudget = Math.round(r.site.contractAmount * 0.35);
    const progress = (r.site.progressPercent ?? 0) / 100;
    const laborSpent = Math.round(laborBudget * progress); // 누적
    const laborMonthly = r.totalPay;                        // 이번 달 실제 지급액
    // 사용자 부담률
    const RATES = { pension: 0.045, health: 0.03545, employ: 0.009, accident: 0.0093, retireFund: 0.005 };
    const mk = (rate: number) => ({
      budget: Math.round(laborBudget * rate),
      spent: Math.round(laborBudget * rate * progress),     // 누적
      monthly: Math.round(laborMonthly * rate),             // 이번 달
    });
    const pension = mk(RATES.pension);
    const health = mk(RATES.health);
    const employ = mk(RATES.employ);
    const accident = mk(RATES.accident);
    const retireFund = mk(RATES.retireFund);
    const execRate = laborBudget > 0 ? Math.round((laborSpent / laborBudget) * 100) : 0;
    return {
      ...r, laborBudget, laborSpent, laborMonthly,
      pension, health, employ, accident, retireFund,
      execRate,
    };
  });
  const totals = enriched.reduce(
    (acc, r) => {
      const stage: CloseStage = r.monthClose?.stage ?? 'OPEN';
      if (stage !== 'OPEN') acc.closedCount += 1;
      acc.laborBudget += r.laborBudget;
      acc.laborSpent += r.laborSpent;
      return acc;
    },
    { closedCount: 0, laborBudget: 0, laborSpent: 0 },
  );
  const totalExecRate = totals.laborBudget > 0
    ? Math.round((totals.laborSpent / totals.laborBudget) * 100)
    : 0;
  // 포커스가 잡힌 현장이 있으면 그 한 행만 노출, 없으면 전체
  const visibleRows = focusedSiteId
    ? enriched.filter((r) => r.site.id === focusedSiteId)
    : enriched;
  const focusedRow = focusedSiteId ? enriched.find((r) => r.site.id === focusedSiteId) : null;

  return (
    <section className={'card wage__per-site' + (focusedSiteId ? ' is-filtered' : '')}>
      <header className="wage__per-site-head">
        <h3>
          현장별 요약 (
          {viewMode === 'COMPLETED'
            ? `준공 ${completedCount}개 현장`
            : `시공중 ${inProgressCount}개 현장`}
          )
          {focusedRow && (
            <span className="wage__per-site-filter-tag" title="클릭 → 전체 보기로 해제">
              🎯 {focusedRow.site.name} 만 보기
              <button
                type="button"
                className="wage__per-site-filter-clear"
                onClick={() => onFocus(focusedRow.site.id)}
                aria-label="전체 보기로 해제"
              >
                ×
              </button>
            </span>
          )}
        </h3>
        <span className="wage__per-site-actions">
          <button
            type="button"
            className={
              'wage__per-site-toggle' +
              (viewMode === 'COMPLETED' ? ' is-active' : '')
            }
            onClick={() => {
              setViewMode((m) => (m === 'COMPLETED' ? 'PROGRESS' : 'COMPLETED'));
              if (focusedSiteId) onFocus(focusedSiteId); // 포커스 자동 해제
            }}
            disabled={completedCount === 0}
            title={
              completedCount === 0
                ? '준공된 현장이 없습니다'
                : viewMode === 'COMPLETED'
                  ? '시공중 현장으로 돌아가기'
                  : '준공된 현장만 보기'
            }
          >
            {viewMode === 'COMPLETED' ? '← 시공중 보기' : `🏁 준공 ${completedCount}`}
          </button>
          <span className="wage__per-site-summary">
            마감 <strong>{totals.closedCount}</strong>/{enriched.length}
            · 인건비 <strong>{krwShort(totals.laborSpent)}/{krwShort(totals.laborBudget)}</strong>
            · 집행율 <strong>{totalExecRate}%</strong>
          </span>
        </span>
      </header>
      <div className="wage__per-site-scroll">
      <table className="wage__per-site-table wage__per-site-table--lite">
        <colgroup>
          <col />
          <col style={{ width: 64 }} />
          <col style={{ width: 64 }} />
          <col style={{ width: 96 }} />
          <col style={{ width: 84 }} />
          <col style={{ width: 96 }} />
          <col style={{ width: 88 }} />
          <col style={{ width: 92 }} />
          <col style={{ width: 220 }} />
        </colgroup>
        <thead>
          <tr>
            <th>현장</th>
            <th className="wage__per-site-num">근로자</th>
            <th className="wage__per-site-num">근무일</th>
            <th className="wage__per-site-num">총 지급액</th>
            <th className="wage__per-site-ded">공제액</th>
            <th className="wage__per-site-num">실지급액</th>
            <th>진행상황</th>
            <th>처리</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r) => {
            const gross = r.totalPay + r.deductionTotal; // 총 지급액 = 실지급액 + 공제액
            return (
              <tr
                key={r.site.id}
                className={'wage__per-site-row wage__per-site-row--clickable' + (focusedSiteId === r.site.id ? ' is-focused' : '')}
                onClick={() => onFocus(r.site.id)}
                title={focusedSiteId === r.site.id ? '클릭 → 전체 보기로 해제' : '클릭 → 이 현장 직종별 / 근로자별 데이터로 필터'}
              >
                <td className="wage__per-site-name wage__per-site-name--single">
                  <strong>{r.site.name}</strong>
                </td>
                <td className="wage__per-site-num">{r.memberCount}명</td>
                <td className="wage__per-site-num">{r.workDays}일</td>
                <td className="wage__per-site-num">{krwShort(gross)}</td>
                <td className="wage__per-site-ded">
                  <span className="wage__per-site-ded-amt">{krwShort(r.deductionTotal)}</span>
                  <button
                    type="button"
                    className="wage__per-site-detail wage__per-site-detail--sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDetailFor({
                        siteName: r.site.name,
                        pension: r.dedPension,
                        health: r.dedHealth,
                        employ: r.dedEmployment,
                        accident: r.dedAccident,
                        incomeTax: r.dedIncomeTax,
                        localTax: r.dedLocalTax,
                        total: r.deductionTotal,
                      });
                    }}
                    title="공제 세부 내역 보기"
                  >
                    상세
                  </button>
                </td>
                <td className="wage__per-site-num wage__per-site-num--strong">{krwShort(r.totalPay)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <SettleStatusBadge monthClose={r.monthClose} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="wage__per-site-status">
                    <WageWorkflowButtons
                      siteId={r.site.id}
                      yearMonth={yearMonth}
                      monthClose={r.monthClose}
                      authViewMode={authViewMode}
                      onReload={onReload}
                      compact
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {detailFor && (
        <Modal
          open={true}
          onClose={() => setDetailFor(null)}
          title={`상세보기 — ${detailFor.siteName}`}
          subtitle="이번 달 근로자 공제 내역 (행의 「공제액」 합계와 동일)"
          width={400}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="wage__per-site-detail"
                onClick={() => setDetailFor(null)}
              >
                닫기
              </button>
            </div>
          }
        >
          <ul className="wage-detail__list">
            <li className="wage-detail__row">
              <span className="wage-detail__label">국민연금</span>
              <span className="wage-detail__value">{detailFor.pension.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row">
              <span className="wage-detail__label">건강보험</span>
              <span className="wage-detail__value">{detailFor.health.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row">
              <span className="wage-detail__label">고용보험</span>
              <span className="wage-detail__value">{detailFor.employ.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row">
              <span className="wage-detail__label">산재보험</span>
              <span className="wage-detail__value">{detailFor.accident.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row">
              <span className="wage-detail__label">소득세</span>
              <span className="wage-detail__value">{detailFor.incomeTax.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row">
              <span className="wage-detail__label">지방소득세</span>
              <span className="wage-detail__value">{detailFor.localTax.toLocaleString()}원</span>
            </li>
            <li className="wage-detail__row wage-detail__row--total">
              <span className="wage-detail__label">합계 (= 행 「공제액」)</span>
              <span className="wage-detail__value">
                {detailFor.total.toLocaleString()}원
              </span>
            </li>
          </ul>
        </Modal>
      )}

      {stepperFor && (
        <Modal
          open={true}
          onClose={() => setStepperFor(null)}
          title={`정산 진행 — ${stepperFor.siteName}`}
          subtitle="출역확정(월) → 노무비 확정 → 지급 → 명세서발행 → 마감"
          width={780}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="wage__per-site-detail"
                onClick={() => setStepperFor(null)}
              >
                닫기
              </button>
            </div>
          }
        >
          <WageStepper
            monthClose={stepperFor.monthClose}
            isAllMode={false}
          />
        </Modal>
      )}
    </section>
  );
}

/* 정산상태 배지 — wageStage 기준 4단계, 클릭 시 진행 단계 모달 */
/**
 * 진행상황 mini-stepper — 6단계 (가/나/다/라/마/바, 각 dot 아래 라벨, 현재 단계 호흡)
 *  가. 현장 출역확정(월) ← attStage SITE_CLOSED
 *  나. 본사 출역확정      ← attStage HQ_CONFIRMED
 *  다. 노무비확정(본사)   ← wageStage HQ_CONFIRMED
 *  라. 지급완료           ← wageStage PAID
 *  마. 명세서발행         ← payslipsIssuedAt 존재
 *  바. 마감               ← wageStage SETTLED
 */
function SettleStatusBadge({ monthClose }: { monthClose: MonthClose | null }) {
  const att = monthClose?.attStage ?? 'OPEN';
  const wage = monthClose?.wageStage ?? 'OPEN';
  const payslipsIssued = !!monthClose?.payslipsIssuedAt;
  const steps: Array<{ label: string; done: boolean }> = [
    { label: '현장 출역확정(월)', done: att === 'SITE_CLOSED' || att === 'HQ_CONFIRMED' },
    { label: '본사 출역확정',     done: att === 'HQ_CONFIRMED' },
    { label: '노무비확정',  done: wage === 'HQ_CONFIRMED' || wage === 'PAID' || wage === 'SETTLED' },
    { label: '지급완료',           done: wage === 'PAID' || wage === 'SETTLED' },
    { label: '명세서발행',         done: payslipsIssued || wage === 'SETTLED' },
    { label: '마감',               done: wage === 'SETTLED' },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);
  return (
    <div className="settle-mini" role="img" aria-label={`진행: ${steps.map((s, i) => `${i + 1}.${s.label}${s.done ? '✓' : ''}`).join(' / ')}`}>
      {steps.map((s, i) => (
        <span
          key={s.label}
          className={
            'settle-mini__step'
            + (s.done ? ' is-done' : '')
            + (i === currentIdx ? ' is-current' : '')
          }
        >
          <span className="settle-mini__dot">{s.done ? '✓' : i + 1}</span>
          <span className="settle-mini__label">{s.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 마감 워크플로우 셀 (4단계 상태기계)
 *  배지: 미마감 / 🔒 현장마감 / ✅ 본사확인 / 💰 정산완료
 *  버튼:
 *    - HQ 모드 + SITE_CLOSED   → "완료 ▶" (확인)
 *    - HQ 모드 + HQ_CONFIRMED  → "정산 ▶" + "되돌리기"(점선)
 *    - SITE 모드 + SITE_CLOSED → "🔓 해지" (사유 5자)
 *    - SETTLED                 → 버튼 없음 (terminal)
 */
/**
 * 현장별 요약 — 마감 컬럼은 상태 배지만 표시 (액션 버튼 없음).
 * 워크플로우 버튼(확정/지급/정산)은 노임비 페이지 상단 액션바로 이동.
 */
function CloseWorkflowCell({
  monthClose,
}: {
  siteId: string;
  yearMonth: string;
  monthClose: MonthClose | null;
  authViewMode: 'HQ' | 'SITE';
  onReload: () => void;
}) {
  const att = monthClose?.attStage ?? 'OPEN';
  const wage = monthClose?.wageStage ?? 'OPEN';

  // 배지 — 노임 단계 + 출역 미확정 시 잠금 표시
  const badge = (() => {
    if (att !== 'HQ_CONFIRMED') {
      return { cls: 'cwf__badge cwf__badge--open', label: '출역 확정 대기', icon: '⏸' };
    }
    switch (wage) {
      case 'OPEN':         return { cls: 'cwf__badge cwf__badge--open',     label: '노임 진행 중',   icon: '⏳' };
      case 'SITE_CLOSED':  return { cls: 'cwf__badge cwf__badge--site',     label: '⑤ 현장 노임',  icon: '✓'  };
      case 'HQ_CONFIRMED': return { cls: 'cwf__badge cwf__badge--hq',       label: '⑥ 본사 노임',  icon: '✅' };
      case 'PAID':         return { cls: 'cwf__badge cwf__badge--hq',       label: '⑦ 지급 완료',   icon: '💵' };
      case 'SETTLED':      return { cls: 'cwf__badge cwf__badge--settled',  label: '⑧ 정산 완료',   icon: '💰' };
    }
  })();

  // 툴팁
  const tip = (() => {
    if (!monthClose) return '';
    const lines: string[] = [];
    if (monthClose.attHqConfirmedAt) lines.push(`④ 본사 출역확정: ${monthClose.attHqConfirmedByName ?? ''} · ${monthClose.attHqConfirmedAt.slice(0, 16).replace('T', ' ')}`);
    if (monthClose.wageSiteClosedAt) lines.push(`⑤ 현장 노임 확정: ${monthClose.wageSiteClosedByName ?? ''} · ${monthClose.wageSiteClosedAt.slice(0, 16).replace('T', ' ')}`);
    if (monthClose.wageHqConfirmedAt) lines.push(`⑥ 본사 노임 확정: ${monthClose.wageHqConfirmedByName ?? ''} · ${monthClose.wageHqConfirmedAt.slice(0, 16).replace('T', ' ')}`);
    if (monthClose.paidAt) lines.push(`⑦ 본사 노임 지급: ${monthClose.paidByName ?? ''} · ${monthClose.paidAt.slice(0, 16).replace('T', ' ')}`);
    if (monthClose.settledAt) lines.push(`⑧ 정산 완료: ${monthClose.settledByName ?? ''} · ${monthClose.settledAt.slice(0, 16).replace('T', ' ')}`);
    return lines.join('\n');
  })();

  return (
    <div className="cwf">
      <span className={badge.cls} title={tip || (att !== 'HQ_CONFIRMED' ? '출역 ④본사 출역확정 후에 노임 진행 가능' : undefined)}>
        <span aria-hidden>{badge.icon}</span> {badge.label}
      </span>
    </div>
  );
}

/**
 * 한 셀에 다음을 함께 표시:
 *  - 이번 달 (월) 납부 금액 — 강조
 *  - 누적 집행 / 예산 + 집행율 + mini 막대
 */
/**
 * 노임 워크플로우 버튼 — 노임비 페이지 상단 액션바에 들어감.
 *  현재 단계(wageStage)에 맞는 ⑤~⑧ 버튼만 노출 + 「되돌림」.
 *  attStage !== 'HQ_CONFIRMED' 면 「출역 확정 대기」 잠금 칩만 표시.
 */
function WageWorkflowButtons({
  siteId,
  yearMonth,
  monthClose,
  authViewMode,
  onReload,
  compact,
}: {
  siteId: string;
  yearMonth: string;
  monthClose: MonthClose | null;
  authViewMode: 'HQ' | 'SITE';
  onReload: () => void;
  /** compact = true: 행 안에서 small 버튼으로 (상세 버튼과 동일 사이즈) */
  compact?: boolean;
}) {
  if (!monthClose) return null;
  const att = monthClose.attStage ?? 'OPEN';
  const wage = monthClose.wageStage ?? 'OPEN';
  const btnCls = compact
    ? 'wage__per-site-detail wage__per-site-detail--accent'
    : 'wage__doc-btn wage__doc-btn--accent';
  const ghostCls = compact
    ? 'wage__per-site-detail'
    : 'wage__doc-btn wage__doc-btn--ghost';
  const lockedCls = compact
    ? 'wage__per-site-detail wage__per-site-detail--locked'
    : 'wage__doc-btn wage__doc-btn--locked';
  const isHQ = authViewMode === 'HQ';
  const isSITE = authViewMode === 'SITE';
  const [busy, setBusy] = useState(false);

  type WageAction =
    | 'ATT_SITE_CLOSE' | 'ATT_REOPEN'
    | 'ATT_HQ_CONFIRM' | 'ATT_REVERT_CONFIRM'
    | 'WAGE_SITE_CLOSE' | 'WAGE_REOPEN'
    | 'WAGE_HQ_CONFIRM' | 'WAGE_REVERT_CONFIRM'
    | 'PAY' | 'UNPAY'
    | 'ISSUE_PAYSLIPS' | 'UNDO_PAYSLIPS'
    | 'SETTLE' | 'UNSETTLE';

  async function call(action: WageAction, opts?: { confirmMsg?: string; reasonPrompt?: string }) {
    if (busy) return;
    let reason: string | undefined;
    if (opts?.reasonPrompt) {
      const r = window.prompt(opts.reasonPrompt, '');
      if (!r || r.trim().length < 5) {
        if (r !== null) window.alert('5자 이상 입력해야 합니다.');
        return;
      }
      reason = r.trim();
    }
    if (opts?.confirmMsg) {
      if (!window.confirm(opts.confirmMsg)) return;
    }
    setBusy(true);
    try {
      await attendanceApi.monthClose({ siteId, yearMonth, action, reason });
      onReload();
    } catch (err) {
      window.alert(getErrorMessage(err, '처리 실패'));
    } finally {
      setBusy(false);
    }
  }

  const payslipsIssued = !!monthClose.payslipsIssuedAt;

  // ─── 「말일 지난 후」 판정 — 해당 월의 말일 다음 날부터 출역확정 가능 시점 ───
  // yearMonth 'YYYY-MM' → 그 달 말일까지의 마지막 시각(23:59:59)을 지나면 monthEndPassed = true
  function isMonthEndPassed(ym: string): boolean {
    const [y, m] = ym.split('-').map(Number);
    if (!y || !m) return false;
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = new Date(y, m - 1, lastDay, 23, 59, 59);
    return new Date() > monthEnd;
  }
  const monthEndPassed = isMonthEndPassed(yearMonth);

  // ─────────── SITE: 일출역확인 / 월출역확정 (2 버튼, 단계별 활성화) ───────────
  if (isSITE) {
    const dailyDoneTitle = '※ 일출역확인은 출퇴근 페이지에서 일자별로 처리';
    const monthlyDone = att === 'SITE_CLOSED' || att === 'HQ_CONFIRMED';
    // 호흡 효과는 「말일이 지났고 + 아직 출역확정 안 함」 인 경우만
    const monthlyShouldBreathe = att === 'OPEN' && monthEndPassed;
    return (
      <div className="wage-wf">
        {/* 일출역확인 — 출역 페이지 진입 안내 (실 처리는 AttendancePage) */}
        <button
          type="button"
          className={'wage-wf__btn'}
          disabled
          title={dailyDoneTitle}
        >
          일출역확인
        </button>
        {/* 월출역확정 — att OPEN 일 때 활성, SITE_CLOSED 면 「확정취소」(REOPEN) 로 토글 */}
        {att === 'OPEN' && (
          <button
            type="button"
            className={'wage-wf__btn' + (monthlyShouldBreathe ? ' wage-wf__btn--accent' : '')}
            onClick={() => call('ATT_SITE_CLOSE', {
              confirmMsg: `${yearMonth} 가. 「현장 출역확정(월)」 처리하시겠습니까?\n\n· 출역 데이터가 잠금됩니다.\n· 본사 확정 전엔 현장에서 「확정 취소」 가능 (5자 사유).`,
            })}
            disabled={busy}
            title={monthlyShouldBreathe ? '가. 현장 월 출역 확정 (말일 경과)' : '가. 현장 월 출역 확정 — 말일 지난 후 시작 권장'}
          >
            월출역확정
          </button>
        )}
        {att === 'SITE_CLOSED' && (
          <button
            type="button"
            className="wage-wf__btn wage-wf__btn--ghost"
            onClick={() => call('ATT_REOPEN', { reasonPrompt: '현장 출역확정 취소 사유 (5자 이상):' })}
            disabled={busy}
            title="가. 현장 출역확정 취소 — 본사 확인 전에만 가능"
          >
            확정 취소
          </button>
        )}
        {att === 'HQ_CONFIRMED' && (
          <button
            type="button"
            className="wage-wf__btn"
            disabled
            title="본사 확정 후 — 본사 승인 필요(되돌림은 본사 권한)"
          >
            ✓ 확정됨
          </button>
        )}
        {monthlyDone && att !== 'HQ_CONFIRMED' && (
          <span className="wage-wf__hint">→ 본사 확정 대기</span>
        )}
      </div>
    );
  }

  // ─────────── HQ: 노무비확정 / 지급완료 / 명세서발행 / 마감 (4 버튼, 항상 노출, 단계별 활성화) ───────────
  // 가. 현장 출역확정 + 나. 본사 출역확정 → 출역관리 페이지에서 처리. 여기는 다부터 시작.
  // 단계별 활성 조건:
  //   다. 노무비확정    : att HQ_CONFIRMED && wage = OPEN
  //   라. 지급완료      : wage HQ_CONFIRMED
  //   마. 명세서발행    : wage PAID && !payslipsIssued
  //   바. 마감          : wage PAID && payslipsIssued
  const canConfirmWage   = att === 'HQ_CONFIRMED' && wage === 'OPEN';
  const canPay           = wage === 'HQ_CONFIRMED';
  const canIssuePayslips = wage === 'PAID' && !payslipsIssued;
  const canSettle        = wage === 'PAID' && payslipsIssued;
  const isWageDone       = wage === 'HQ_CONFIRMED' || wage === 'PAID' || wage === 'SETTLED';
  const isPaid           = wage === 'PAID' || wage === 'SETTLED';
  const isPayslipsDone   = payslipsIssued || wage === 'SETTLED';
  const isSettled        = wage === 'SETTLED';

  // ─── 사전 단계 미완료 시 안내 메시지 ───
  function blockedMsg(stage: '다' | '라' | '마' | '바'): string {
    const prereq = {
      '다': '가. 현장 출역확정(월) → 나. 본사 출역확정',
      '라': '다. 노무비확정',
      '마': '라. 지급완료',
      '바': '마. 명세서발행',
    }[stage];
    return `이전 단계가 아직 완료되지 않았습니다.\n\n· 진행해야 할 단계: ${prereq}\n· 출역 단계는 「출역관리」 페이지에서 진행 가능합니다.`;
  }
  function clickIfReady(stage: '다' | '라' | '마' | '바', ready: boolean, runner: () => void) {
    if (!ready) {
      window.alert(blockedMsg(stage));
      return;
    }
    runner();
  }

  return (
    <div className="wage-wf">
      {/* 다. 노무비확정(본사) */}
      <button
        type="button"
        className={'wage-wf__btn' + (canConfirmWage ? ' wage-wf__btn--accent' : '') + (isWageDone ? ' is-done' : '')}
        onClick={() => clickIfReady('다', canConfirmWage, () => call('WAGE_HQ_CONFIRM', {
          confirmMsg: `${yearMonth} 다. 「노무비확정(본사)」 처리하시겠습니까?\n\n· 노임 데이터가 본사 차원에서 확정됩니다.\n· 다음 단계「라. 지급완료」 로 진행 가능합니다.`,
        }))}
        disabled={busy || isWageDone}
        title={canConfirmWage ? '다. 노무비확정 (본사)' : isWageDone ? '✓ 처리됨' : '나. 본사 출역확정 후 활성화 — 클릭하면 안내'}
      >
        {isWageDone ? '✓ 노무비확정' : '노무비확정'}
      </button>
      {/* 라. 지급완료 */}
      <button
        type="button"
        className={'wage-wf__btn' + (canPay ? ' wage-wf__btn--accent' : '') + (isPaid ? ' is-done' : '')}
        onClick={() => clickIfReady('라', canPay, () => call('PAY', {
          confirmMsg: `${yearMonth} 라. 「지급완료」 처리하시겠습니까?\n\n· 임금이 송금된 것으로 기록됩니다.\n· 다음 「마. 명세서발행」 단계로 진행 가능합니다.`,
        }))}
        disabled={busy || isPaid}
        title={canPay ? '라. 지급완료' : isPaid ? '✓ 처리됨' : '다. 노무비확정 후 활성화 — 클릭하면 안내'}
      >
        {isPaid ? '✓ 지급완료' : '지급완료'}
      </button>
      {/* 마. 명세서발행 */}
      <button
        type="button"
        className={'wage-wf__btn' + (canIssuePayslips ? ' wage-wf__btn--accent' : '') + (isPayslipsDone ? ' is-done' : '')}
        onClick={() => clickIfReady('마', canIssuePayslips, () => call('ISSUE_PAYSLIPS', {
          confirmMsg: `${yearMonth} 마. 「명세서발행」 처리하시겠습니까?\n\n· 근로자 전원에게 임금명세서가 발행 처리됩니다.\n· 다음 「바. 마감」 단계로 진행 가능합니다.`,
        }))}
        disabled={busy || !canIssuePayslips}
        title={canIssuePayslips ? '마. 명세서발행' : isPayslipsDone ? '✓ 처리됨' : '라. 지급완료 후 활성화'}
      >
        {isPayslipsDone ? '✓ 명세서발행' : '명세서발행'}
      </button>
      {/* 바. 마감 */}
      <button
        type="button"
        className={'wage-wf__btn' + (canSettle ? ' wage-wf__btn--accent' : '') + (isSettled ? ' is-done' : '')}
        onClick={() => clickIfReady('바', canSettle, () => call('SETTLE', {
          confirmMsg: `${yearMonth} 바. 「마감」 처리하시겠습니까?\n\n· 정산이 완료되어 변경이 어렵습니다 (관리자만 되돌리기 가능).`,
        }))}
        disabled={busy || isSettled}
        title={canSettle ? '바. 마감' : isSettled ? '✓ 마감됨' : '마. 명세서발행 후 활성화 — 클릭하면 안내'}
      >
        {isSettled ? '✓ 마감' : '마감'}
      </button>
    </div>
  );
}

function InsCell({ monthly, spent, budget }: { monthly: number; spent: number; budget: number }) {
  const rate = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const cls = rate >= 90 ? 'is-warn' : rate >= 60 ? 'is-mid' : 'is-low';
  return (
    <div className="ins-cell">
      <div className="ins-cell__monthly">
        <em>월</em>
        <strong>{krw(monthly)}</strong>
      </div>
      <div className="ins-cell__bar">
        <span className={'ins-cell__bar-fill ' + cls} style={{ width: Math.min(100, rate) + '%' }} />
      </div>
      <div className="ins-cell__cumul">
        <span>누적 {krwShort(spent)}/{krwShort(budget)}</span>
        <span className={'ins-cell__rate ' + cls}>{rate}%</span>
      </div>
    </div>
  );
}

/* ────────────────── 노임비 탭 ────────────────── */

type WageSortKey = 'name' | 'role' | 'workDays' | 'dailyWage' | 'baseAmount' | 'deductionTotal' | 'netAmount';

function WageTab({
  data,
  yearMonth,
  sites,
  siteId,
  monthClose,
  authViewMode,
  onReload,
  roleFilter,
  setRoleFilter,
  isWageCloseRoute = false,
}: {
  data: WageMonthSummary | null;
  yearMonth: string;
  sites: Site[];
  siteId: string;
  monthClose: MonthClose | null;
  authViewMode: 'HQ' | 'SITE';
  onReload: () => void;
  roleFilter: string | null;
  setRoleFilter: (r: string | null) => void;
  isWageCloseRoute?: boolean;
}) {
  /** 임금명세서 발행 액션 다이얼로그 — 출력/카톡/SMS 선택 */
  const [issueOpen, setIssueOpen] = useState(false);
  const [sortKey, setSortKey] = useState<WageSortKey>('netAmount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const { user } = useAuth();

  const companyInfo = {
    companyName: user?.companyName ?? '회사',
    bizRegNo: '000-00-00000',
    representative: user?.name,
  };
  const currentSite = sites.find((s) => s.id === siteId);
  const siteInfo = currentSite
    ? {
        name: currentSite.name,
        address: currentSite.address,
        manager: currentSite.manager,
        managerPhone: currentSite.managerPhone,
      }
    : { name: '전체 현장', address: '', manager: '', managerPhone: '' };

  function toggleSort(k: WageSortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  }

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const list = roleFilter ? data.rows.filter((r) => r.role === roleFilter) : data.rows;
    const sign = sortDir === 'asc' ? 1 : -1;
    const get = (r: typeof list[number]): string | number => {
      switch (sortKey) {
        case 'name': return r.memberName;
        case 'role': return r.role;
        case 'workDays': return r.workDays;
        case 'dailyWage': return r.dailyWage;
        case 'baseAmount': return r.baseAmount;
        case 'deductionTotal': return r.deductionTotal;
        case 'netAmount': return r.netAmount;
      }
    };
    return [...list].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
      return String(va).localeCompare(String(vb), 'ko') * sign;
    });
  }, [data, roleFilter, sortKey, sortDir]);

  const footerTotals = useMemo(() => {
    return filteredRows.reduce(
      (acc, r) => ({
        days: acc.days + r.workDays,
        base: acc.base + r.baseAmount,
        deduction: acc.deduction + r.deductionTotal,
        net: acc.net + r.netAmount,
      }),
      { days: 0, base: 0, deduction: 0, net: 0 },
    );
  }, [filteredRows]);

  function printPayslips(rows: WageRow[], summary: WageMonthSummary, ym: string) {
    if (rows.length === 0) return;
    const html = buildBulkPayslipHtml({ rows, yearMonth: ym, company: companyInfo, site: siteInfo });
    openPrintWindow({
      title: `임금명세서 ${ym} (${rows.length}명)`,
      bodyHtml: html,
    });
  }
  function dispatchPayslips(
    rows: WageRow[],
    summary: WageMonthSummary,
    channel: 'KAKAO' | 'SMS',
  ) {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    rows.forEach((r) => {
      appendDispatchLog({
        id: 'DSP-PS-' + Date.now().toString(36) + '-' + r.memberId,
        channel,
        templateCode: 'PAYSLIP_ISSUED',
        toName: r.memberName,
        toPhone: '',
        body: `[${companyInfo.companyName}] ${summary.year}년 ${summary.month}월 임금명세서가 발급되었습니다. 실 지급액 ${r.netAmount.toLocaleString()}원.`,
        sentAt: now,
        status: 'SENT',
      });
    });
  }

  function issueLaborReport(summary: WageMonthSummary) {
    const html = buildLaborReportHtml({ data: summary, company: companyInfo, site: siteInfo });
    openPrintWindow({
      title: `근로내용확인신고서 ${summary.year}-${String(summary.month).padStart(2, '0')}`,
      bodyHtml: html,
      orientation: 'landscape',
    });
  }

  /* ── 노임대장 다운로드 핸들러 (업로드는 출퇴근 현황으로 이전) ── */
  function buildLedger(summary: WageMonthSummary): LedgerDoc {
    return buildLedgerFromWage({
      summary,
      site: currentSite ?? null,
      companyName: companyInfo.companyName,
      managerName: companyInfo.representative,
    });
  }

  async function ledgerDownloadXlsx(summary: WageMonthSummary) {
    const doc = buildLedger(summary);
    appendToArchive(doc);
    try {
      await downloadLedgerXlsx(doc);
    } catch (err) {
      window.alert('엑셀 생성 실패: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    }
  }

  if (!data) return null;
  if (data.rows.length === 0) {
    return (
      <div className="wage__empty card">
        해당 월·현장에 등록된 팀원이 없습니다. 먼저 팀원을 등록해주세요.
      </div>
    );
  }

  // 현장이 선택된 경우(focusedSiteId 또는 단일 현장 모드) → 직종별 노임 타일 인라인 표시
  const showRoleTiles = siteId !== 'ALL';

  return (
    <>
      {showRoleTiles && data.byRole.length > 0 && (
        <section className="wage__by-role card">
          <header className="wage__by-role-head">
            <h3>직종별 노임 ({data.byRole.length}개 직종)</h3>
            <p>총 <strong>{krwShort(data.totalNet)}</strong> · 클릭 시 그 직종 팀원만 표시</p>
          </header>
          <div className="role-tiles">
            {data.byRole.map((r) => (
              <button
                key={r.role}
                type="button"
                className={'role-tile' + (roleFilter === r.role ? ' is-active' : '')}
                onClick={() => setRoleFilter(roleFilter === r.role ? null : r.role)}
              >
                <span className="role-tile__name">{r.role}</span>
                <span className="role-tile__row">
                  <span className="role-tile__meta">{r.count}명·{r.days}일</span>
                  <span className="role-tile__amount">{krwShort(r.net)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="wage__grid card">
        <header className="wage__grid-head">
          <h3>
            월별 노임 명세 ({data.year}.{String(data.month).padStart(2, '0')})
            {roleFilter && (
              <span className="wage__role-tag">
                [{roleFilter}] {filteredRows.length}명만 표시
                <button type="button" className="wage__role-clear" onClick={() => setRoleFilter(null)}>×</button>
              </span>
            )}
          </h3>
          <div className="wage__grid-actions">
            {/* 출력물 버튼들 — 「노무비 지급」(/wage) 화면에서만 노출 (노무비 마감 화면에선 숨김) */}
            {!isWageCloseRoute && (
              <div className="wage-export-inline">
                <button
                  type="button"
                  className="wage-export-inline__btn"
                  onClick={() => setIssueOpen(true)}
                  disabled={filteredRows.length === 0}
                  title={`임금명세서 일괄 발행 (${filteredRows.length}명)`}
                >
                  임금명세서
                </button>
                <button
                  type="button"
                  className="wage-export-inline__btn"
                  onClick={() => ledgerDownloadXlsx(data)}
                  disabled={data.rows.length === 0}
                  title="일용노무비지급명세서 .xlsx 다운로드"
                >
                  노임대장
                </button>
                <button
                  type="button"
                  className="wage-export-inline__btn"
                  onClick={() => issueLaborReport(data)}
                  disabled={data.rows.length === 0}
                  title="고용·산재 근로내용확인신고서"
                >
                  근로내용확인신고
                </button>
                <button
                  type="button"
                  className="wage-export-inline__btn"
                  onClick={() =>
                    window.alert('퇴직공제부금 신고자료 — 출력센터의 퇴직공제 모듈에서 발행됩니다 (mock).')
                  }
                  title="건설근로자공제회 퇴직공제부금 신고자료"
                >
                  퇴직공제
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="wage__grid-scroll">
          <table className="wage-table wage-table--wide">
            <thead>
              <tr>
                <th>번호</th>
                <WageSortTh label="성명" col="name" cur={sortKey} dir={sortDir} on={toggleSort} />
                <th>주민번호</th>
                <WageSortTh label="직종" col="role" cur={sortKey} dir={sortDir} on={toggleSort} />
                <WageSortTh label="근로일" col="workDays" cur={sortKey} dir={sortDir} on={toggleSort} numeric />
                <WageSortTh label="일당" col="dailyWage" cur={sortKey} dir={sortDir} on={toggleSort} numeric />
                <WageSortTh label="지급금액" col="baseAmount" cur={sortKey} dir={sortDir} on={toggleSort} numeric />
                <th>국민연금</th>
                <th>건강보험</th>
                <th>고용보험</th>
                <th>산재보험</th>
                <th>소득세</th>
                <th>지방세</th>
                <WageSortTh label="공제계" col="deductionTotal" cur={sortKey} dir={sortDir} on={toggleSort} numeric />
                <WageSortTh label="실지급" col="netAmount" cur={sortKey} dir={sortDir} on={toggleSort} numeric />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => (
                <tr key={r.memberId}>
                  <td>{i + 1}</td>
                  <td className="wage-table__name">{r.memberName}</td>
                  <td className="wage-table__mono">{r.idNumberMasked}</td>
                  <td>{r.role}</td>
                  <td>{r.workDays}</td>
                  <td className="wage-table__num">{r.dailyWage.toLocaleString()}</td>
                  <td className="wage-table__num wage-table__num--strong">{r.baseAmount.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionPension.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionHealth.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionEmployment.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionAccident.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionIncomeTax.toLocaleString()}</td>
                  <td className="wage-table__num">{r.deductionLocalTax.toLocaleString()}</td>
                  <td className="wage-table__num wage-table__num--ded">{r.deductionTotal.toLocaleString()}</td>
                  <td className="wage-table__num wage-table__num--net">{r.netAmount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  합계
                  {roleFilter && <span className="wage-table__foot-tag"> · {roleFilter}</span>}
                </td>
                <td>{footerTotals.days}</td>
                <td></td>
                <td className="wage-table__num">{footerTotals.base.toLocaleString()}</td>
                <td colSpan={6}></td>
                <td className="wage-table__num wage-table__num--ded">{footerTotals.deduction.toLocaleString()}</td>
                <td className="wage-table__num wage-table__num--net">{footerTotals.net.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* (이전 「출력」 섹션은 「월별 노임 명세」 헤더 우측 인라인 버튼들로 이전됨) */}

      {issueOpen && (
        <PayslipIssueDialog
          count={filteredRows.length}
          yearMonth={yearMonth}
          onClose={() => setIssueOpen(false)}
          onPrint={() => { printPayslips(filteredRows, data, yearMonth); setIssueOpen(false); }}
          onKakao={() => { dispatchPayslips(filteredRows, data, 'KAKAO'); window.alert(`${filteredRows.length}명에게 카카오톡으로 임금명세서 발송됐습니다.`); setIssueOpen(false); }}
          onSms={() => { dispatchPayslips(filteredRows, data, 'SMS'); window.alert(`${filteredRows.length}명에게 SMS로 임금명세서 발송됐습니다.`); setIssueOpen(false); }}
        />
      )}
    </>
  );
}

/** 임금명세서 발행 — 출력 / 카톡 / SMS 선택 모달 */
function PayslipIssueDialog({
  count,
  yearMonth,
  onClose,
  onPrint,
  onKakao,
  onSms,
}: {
  count: number;
  yearMonth: string;
  onClose: () => void;
  onPrint: () => void;
  onKakao: () => void;
  onSms: () => void;
}) {
  const options: Array<{
    icon: string;
    label: string;
    sub: string;
    onClick: () => void;
  }> = [
    { icon: '🖨', label: '출력', sub: 'PDF 새 창 → 인쇄', onClick: onPrint },
    { icon: '💬', label: '카카오톡', sub: '등록된 연락처로 일괄 발송', onClick: onKakao },
    { icon: '📱', label: 'SMS', sub: '카톡 미가입자 대비 일괄 발송', onClick: onSms },
  ];
  return (
    <Modal
      open
      onClose={onClose}
      title="임금명세서 일괄 발행"
      subtitle={`${yearMonth} · 대상 ${count}명`}
      width={520}
    >
      <p className="payslip-dlg__hint">
        선택한 방식으로 임금명세서를 일괄 발행/발송합니다.
      </p>
      <div className="payslip-dlg__grid">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className="payslip-dlg__opt"
            onClick={o.onClick}
          >
            <span className="payslip-dlg__opt-icon" aria-hidden>{o.icon}</span>
            <span className="payslip-dlg__opt-label">{o.label}</span>
            <span className="payslip-dlg__opt-sub">{o.sub}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ────────────────── 퇴직공제 히어로 (KPI 4타일) ────────────────── */

function SeveranceHero({ data }: { data: SeveranceMonthSummary | null }) {
  if (!data) return null;

  const fundDaily = loadFundDaily();
  const refDate = new Date(data.year, data.month, 0);

  let mutualCount = 0, legalCount = 0, approachingCount = 0;
  let mutualTotal = 0, legalTotal = 0;
  for (const r of data.rows) {
    const cls = classifyForSeverance(r.joinedAt, refDate);
    if (cls.group === 'LEGAL') {
      legalCount++;
      legalTotal += legalSeverance({ avgDailyWage: r.dailyWage, serviceDays: cls.tenure.totalDays });
    } else {
      mutualCount++;
      mutualTotal += mutualAidAccrued({ workDays: r.totalWorkDays, fundDaily });
      if (cls.tenure.isApproachingOneYear) approachingCount++;
    }
  }

  const tiles = ([
    { key: 'today',  label: '당일 출력 인원',     raw: <><b>{data.attendedToday}</b>명</>,                          tone: 'plain' as const },
    { key: 'mutual', label: '공제회 부금 누적',   raw: <><b>{krw(mutualTotal)}</b> · {mutualCount}명</>,           tone: 'info'  as const },
    { key: 'legal',  label: '법정퇴직금 대상',    raw: <><b>{legalCount}</b>명 · {krw(legalTotal)}</>,             tone: 'ok'    as const },
    { key: 'soon',   label: '1년 임박 (≤30일)',  raw: <><b>{approachingCount}</b>명</>,                            tone: 'plain' as const },
  ]);

  return (
    <div className="att-daily-kpi att-daily-kpi--notif">
      {tiles.map((s, i) => (
        <button key={i} type="button" className={'att-hero__tile att-hero__tile--' + s.tone}>
          <span className="att-hero__icon" aria-hidden>
            <svg viewBox="0 0 36 36" width="36" height="36">
              <rect x="0.5" y="0.5" width="35" height="35" rx="8" fill="#FAFAFA" stroke="#E5E7EB" />
              <g stroke="#D1D5DB" strokeWidth="0.5">
                <line x1="0" y1="9"  x2="36" y2="9" />
                <line x1="0" y1="18" x2="36" y2="18" />
                <line x1="0" y1="27" x2="36" y2="27" />
                <line x1="9"  y1="0" x2="9"  y2="36" />
                <line x1="18" y1="0" x2="18" y2="36" />
                <line x1="27" y1="0" x2="27" y2="36" />
              </g>
              <circle cx="18" cy="18" r="6" fill="none" stroke="#9CA3AF" strokeWidth="0.6" />
              <circle cx="18" cy="18" r="1.2" fill="#9CA3AF" />
            </svg>
          </span>
          <span className="att-hero__body">
            <strong className="att-hero__title">{s.label}</strong>
            <span className="att-hero__sub">{s.raw}</span>
          </span>
          <span className="att-hero__time">월</span>
        </button>
      ))}
    </div>
  );
}

function SeveranceTab({ data }: { data: SeveranceMonthSummary | null }) {
  if (!data) return null;
  if (data.rows.length === 0) {
    return <div className="wage__empty card">해당 현장에 등록된 팀원이 없습니다.</div>;
  }

  const fundDaily = loadFundDaily();
  // 기준일: data.year/month 의 말일 — 그 시점 기준 계속근로 판정
  const refDate = new Date(data.year, data.month, 0);

  // 분류
  type Classified = (typeof data.rows)[number] & {
    group: 'MUTUAL_AID' | 'LEGAL';
    tenureLabel: string;
    daysUntilOneYear: number;
    totalDays: number;
    /** 산출 금액 (그룹별 의미가 다름) */
    computedAmount: number;
    isApproachingOneYear: boolean;
  };
  const classified: Classified[] = data.rows.map((r) => {
    const cls = classifyForSeverance(r.joinedAt, refDate);
    const computedAmount = cls.group === 'LEGAL'
      ? legalSeverance({ avgDailyWage: r.dailyWage, serviceDays: cls.tenure.totalDays })
      : mutualAidAccrued({ workDays: r.totalWorkDays, fundDaily });
    return {
      ...r,
      group: cls.group,
      tenureLabel: cls.label,
      daysUntilOneYear: cls.tenure.daysUntilOneYear,
      totalDays: cls.tenure.totalDays,
      computedAmount,
      isApproachingOneYear: cls.tenure.isApproachingOneYear,
    };
  });

  const mutualRows = classified.filter((r) => r.group === 'MUTUAL_AID');
  const legalRows = classified.filter((r) => r.group === 'LEGAL');
  const approachingRows = classified.filter((r) => r.isApproachingOneYear);

  const mutualTotal = mutualRows.reduce((s, r) => s + r.computedAmount, 0);
  const legalTotal = legalRows.reduce((s, r) => s + r.computedAmount, 0);

  return (
    <>
      {approachingRows.length > 0 && (
        <section
          className="card"
          style={{
            padding: '12px 16px',
            background: '#fff8ec',
            border: '1px solid #ffd9a3',
            color: '#7a4a00',
            fontSize: 13,
            margin: '12px 0',
            borderRadius: 12,
          }}
        >
          ⚠ 30일 이내 만 1년 도래 예정 — {approachingRows.map((r) => `${r.memberName}(D-${r.daysUntilOneYear})`).join(', ')}.
          이 시점부터 공제회 신고를 중단하고 법정퇴직금으로 전환하셔야 합니다.
        </section>
      )}

      <section className="wage__grid card">
        <h3>
          1년 미만 — 퇴직공제부금 ({data.year}.{String(data.month).padStart(2, '0')})
          <span style={{ fontSize: 12, fontWeight: 400, color: '#6b6b73', marginLeft: 8 }}>
            출역일 × 부금 일액 ({fundDaily.toLocaleString()}원/일)
          </span>
        </h3>
        {mutualRows.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#8e8e93', fontSize: 13 }}>
            1년 미만 근로자가 없습니다.
          </div>
        ) : (
          <div className="wage__grid-scroll">
            <table className="wage-table wage-table--wide">
              <thead>
                <tr>
                  <th>번호</th>
                  <th>성명</th>
                  <th>직종</th>
                  <th>입사일</th>
                  <th className="wage-table__num">계속근로</th>
                  <th className="wage-table__num">총 출역일</th>
                  <th className="wage-table__num">부금 일액</th>
                  <th className="wage-table__num">누적 부금</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {mutualRows.map((r, i) => (
                  <tr key={r.memberId} style={r.isApproachingOneYear ? { background: '#fff8ec' } : undefined}>
                    <td>{i + 1}</td>
                    <td className="wage-table__name">{r.memberName}</td>
                    <td>{r.role}</td>
                    <td className="wage-table__mono">{r.joinedAt.slice(0, 10)}</td>
                    <td className="wage-table__num">{Math.max(0, r.totalDays)}일</td>
                    <td className="wage-table__num">{r.totalWorkDays}</td>
                    <td className="wage-table__num">{fundDaily.toLocaleString()}</td>
                    <td className="wage-table__num wage-table__num--net">{r.computedAmount.toLocaleString()}</td>
                    <td style={{ fontSize: 12, color: r.isApproachingOneYear ? '#c75c00' : '#6b6b73' }}>
                      {r.isApproachingOneYear ? `D-${r.daysUntilOneYear} 임박` : `D-${Math.max(0, r.daysUntilOneYear)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>합계 ({mutualRows.length}명)</td>
                  <td className="wage-table__num">{mutualRows.reduce((s, r) => s + r.totalWorkDays, 0)}</td>
                  <td></td>
                  <td className="wage-table__num wage-table__num--net">{mutualTotal.toLocaleString()}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="wage__grid card" style={{ marginTop: 16 }}>
        <h3>
          1년 이상 — 법정퇴직금 ({data.year}.{String(data.month).padStart(2, '0')})
          <span style={{ fontSize: 12, fontWeight: 400, color: '#6b6b73', marginLeft: 8 }}>
            평균임금 × 30일 × (계속근로일수 ÷ 365) — 평균임금은 일당으로 추정
          </span>
        </h3>
        {legalRows.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#8e8e93', fontSize: 13 }}>
            1년 이상 계속근로자가 없습니다.
          </div>
        ) : (
          <div className="wage__grid-scroll">
            <table className="wage-table wage-table--wide">
              <thead>
                <tr>
                  <th>번호</th>
                  <th>성명</th>
                  <th>직종</th>
                  <th>입사일</th>
                  <th className="wage-table__num">계속근로</th>
                  <th className="wage-table__num">평균임금(추정)</th>
                  <th className="wage-table__num">법정퇴직금</th>
                  <th className="wage-table__num">기지급</th>
                  <th className="wage-table__num">잔액</th>
                </tr>
              </thead>
              <tbody>
                {legalRows.map((r, i) => (
                  <tr key={r.memberId}>
                    <td>{i + 1}</td>
                    <td className="wage-table__name">{r.memberName}</td>
                    <td>{r.role}</td>
                    <td className="wage-table__mono">{r.joinedAt.slice(0, 10)}</td>
                    <td className="wage-table__num">
                      {Math.floor(r.totalDays / 365)}년 {r.totalDays % 365}일
                    </td>
                    <td className="wage-table__num">{r.dailyWage.toLocaleString()}</td>
                    <td className="wage-table__num wage-table__num--net">{r.computedAmount.toLocaleString()}</td>
                    <td className="wage-table__num">{r.paidTotal.toLocaleString()}</td>
                    <td className="wage-table__num wage-table__num--net">{(r.computedAmount - r.paidTotal).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>합계 ({legalRows.length}명)</td>
                  <td className="wage-table__num wage-table__num--net">{legalTotal.toLocaleString()}</td>
                  <td className="wage-table__num">{legalRows.reduce((s, r) => s + r.paidTotal, 0).toLocaleString()}</td>
                  <td className="wage-table__num wage-table__num--net">{(legalTotal - legalRows.reduce((s, r) => s + r.paidTotal, 0)).toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

interface WageSortThProps {
  label: string;
  col: WageSortKey;
  cur: WageSortKey;
  dir: 'asc' | 'desc';
  on: (k: WageSortKey) => void;
  numeric?: boolean;
}
function WageSortTh({ label, col, cur, dir, on, numeric }: WageSortThProps) {
  const active = cur === col;
  const ind = active ? (dir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th
      className={'wage-table__sort' + (active ? ' is-active' : '') + (numeric ? ' wage-table__num' : '')}
      onClick={() => on(col)}
    >
      {label}
      <span className="wage-table__sort-ind">{ind}</span>
    </th>
  );
}

export function aggregateByRole(rows: WageMonthSummary['rows']): WageMonthSummary['byRole'] {
  const map = new Map<string, { count: number; days: number; base: number; net: number }>();
  for (const r of rows) {
    const e = map.get(r.role) ?? { count: 0, days: 0, base: 0, net: 0 };
    e.count += 1;
    e.days += r.workDays;
    e.base += r.baseAmount;
    e.net += r.netAmount;
    map.set(r.role, e);
  }
  return Array.from(map.entries()).map(([role, v]) => ({ role, ...v }));
}

export function ProgressMini({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="wage-prg-mini">
      <div className="wage-prg-mini__bar">
        <div className="wage-prg-mini__fill" style={{ width: v + '%' }} />
      </div>
      <span className="wage-prg-mini__num">{v}%</span>
    </div>
  );
}

function krw(n: number) {
  if (!n) return '0원';
  return n.toLocaleString() + '원';
}
function krwShort(n: number) {
  if (!n) return '0';
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000) {
    // 1만 ~ 1억 — 소수점 1자리까지 (19만 → 정확히 18.5만 같은 값 노출)
    // 다만 .0 으로 떨어지면 정수만 표시 (803.0만 → 803만)
    const v = (n / 10_000).toFixed(1);
    const trimmed = v.endsWith('.0') ? v.slice(0, -2) : v;
    // 803.5 → 「803.5만」, 803 → 「803만」 (콤마는 정수부에만 적용)
    const [intPart, fracPart] = trimmed.split('.');
    const intFmt = Number(intPart).toLocaleString();
    return (fracPart ? `${intFmt}.${fracPart}` : intFmt) + '만';
  }
  return n.toLocaleString();
}

function mergeWage(all: WageMonthSummary[]): WageMonthSummary | null {
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  const first = all[0];
  return {
    year: first.year,
    month: first.month,
    rows: all.flatMap((s) => s.rows),
    totalDays: all.reduce((sum, s) => sum + s.totalDays, 0),
    totalBase: all.reduce((sum, s) => sum + s.totalBase, 0),
    totalDeduction: all.reduce((sum, s) => sum + s.totalDeduction, 0),
    totalNet: all.reduce((sum, s) => sum + s.totalNet, 0),
    totalSeverance: all.reduce((sum, s) => sum + s.totalSeverance, 0),
    byRole: aggregateByRole(all.flatMap((s) => s.rows)),
  };
}

function mergeSeverance(all: SeveranceMonthSummary[]): SeveranceMonthSummary | null {
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  const first = all[0];
  return {
    year: first.year,
    month: first.month,
    rows: all.flatMap((s) => s.rows),
    attendedToday: all.reduce((sum, s) => sum + s.attendedToday, 0),
    totalAccrued: all.reduce((sum, s) => sum + s.totalAccrued, 0),
    totalPaid: all.reduce((sum, s) => sum + s.totalPaid, 0),
    totalBalance: all.reduce((sum, s) => sum + s.totalBalance, 0),
  };
}

function MonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [yStr, mStr] = value.split('-');
  const year = Number(yStr);
  const month = Number(mStr);

  function shift(delta: number) {
    let y = year;
    let m = month + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    onChange(`${y}-${String(m).padStart(2, '0')}`);
  }
  function toThisMonth() {
    const now = new Date();
    onChange(now.toISOString().slice(0, 7));
  }

  const isThisMonth = (() => {
    const now = new Date();
    return year === now.getFullYear() && month === now.getMonth() + 1;
  })();

  const thisYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = thisYear - 5; y <= thisYear + 1; y += 1) years.push(y);

  return (
    <div className="wage-month-picker">
      <button
        type="button"
        className="wage-month-picker__arrow"
        onClick={() => shift(-1)}
        aria-label="이전 달"
      >‹</button>
      <MacSelect
              value={year}
              onChange={(v) => onChange(`${v}-${String(month).padStart(2, '0')}`)}
              className="wage-month-picker__year"
              options={[...years.map((y) => (
          ({ value: y, label: <>{y}년</> })
        ))]}
            />
      <MacSelect
              value={month}
              onChange={(v) => onChange(`${year}-${String(v).padStart(2, '0')}`)}
              className="wage-month-picker__month"
              options={[...Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          ({ value: m, label: <>{m}월</> })
        ))]}
            />
      <button
        type="button"
        className="wage-month-picker__arrow"
        onClick={() => shift(1)}
        aria-label="다음 달"
      >›</button>
      {!isThisMonth && (
        <button
          type="button"
          className="wage-month-picker__today"
          onClick={toThisMonth}
        >이번 달</button>
      )}
    </div>
  );
}
