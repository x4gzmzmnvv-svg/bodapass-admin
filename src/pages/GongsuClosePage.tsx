import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { WorkCloseHeader } from '../components/WorkCloseHeader';
import { Modal } from '../components/Modal';
import { MacSelect } from '../components/MacSelect';
import { siteApi } from '../api/site';
import { wageApi } from '../api/wage';
import { attendanceApi } from '../api/attendance';
import { teamApi } from '../api/team';
import type { Site } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import type { AttendanceMonth, MonthClose } from '../api/attendance.types';
import type { WageMonthSummary } from '../api/wage.types';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { flashCompletion } from '../utils/completionToast';
import { computeWorkCloseProgress } from '../utils/workCloseProgress';
import './GongsuClosePage.css';

import { MacDatePicker } from '../components/MacDatePicker';
/**
 * 공수마감 페이지 — 정산관리 그룹의 첫 단계
 *
 *  데이터 흐름:
 *    인증관리 → 일일 출역(공수확정) → [공수마감] → 노무비 → 퇴직금
 *
 *  핵심 질문:
 *   "이번 달 노무비로 넘겨도 되는가?"
 *
 *  화면 구성:
 *    상단:  월 / 현장 필터 + KPI 6장 (총 인원·총 공수·미확정·마감가능·확인필요·월 노무비)
 *    중단:  현장×근로자 마감 대상자 표
 *           컬럼: 근로자 / 직종 / 반장 / 출역일수 / 총공수 / 수동보정 / 미확정 / 계약·동의·얼굴·보험 / 월 지급액 / 공제 / 실지급 / 상태 / 조치
 *    하단:  「월 마감」 / 「마감 취소」 / 「노무비로 넘기기」 액션
 */

interface RowState {
  /** member 행 + 그 달의 출역 / 임금 정보 */
  member: TeamMember;
  workDays: number;
  totalGongsu: number;
  manualCount: number;
  unconfirmedDays: number;
  contractOk: boolean;
  privacyOk: boolean;
  faceOk: boolean;
  insuranceOk: boolean;
  totalPay: number;
  deduction: number;
  netPay: number;
  status: 'CLOSEABLE' | 'NEED_CHECK' | 'CLOSED';
}

export function GongsuClosePage() {
  const { viewMode, assignedSiteId } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const querySiteId = searchParams.get('siteId') ?? null;

  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string>(
    viewMode === 'SITE' && assignedSiteId
      ? assignedSiteId
      : querySiteId ?? 'ALL',
  );
  const [yearMonth, setYearMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [wage, setWage] = useState<WageMonthSummary | null>(null);
  const [attMonth, setAttMonth] = useState<AttendanceMonth | null>(null);
  const [monthClose, setMonthClose] = useState<MonthClose | null>(null);
  const [closedDates, setClosedDates] = useState<Set<string>>(new Set());
  // 표 정렬
  type SortKey = 'name' | 'role' | 'workDays' | 'totalGongsu' | 'manualCount' | 'unconfirmedDays' | 'contractOk' | 'privacyOk' | 'faceOk' | 'insuranceOk' | 'totalPay' | 'deduction' | 'netPay' | 'status';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };
  // 월간 내역 화면에서 「확정」 처리한 record key → entry 맵 (localStorage 공유)
  // recordKey 형식: `${recordId}:${siteId}` — entry: { action: 'done'|'hold'|'excluded', gongsu? }
  const dailyHandled = useMemo<Record<string, { action: string; gongsu?: number }>>(() => {
    try {
      const raw = localStorage.getItem('bodapass.daily.handled');
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch { return {}; }
    // 페이지 진입 시점의 스냅샷이면 충분 — siteId/yearMonth 변경 시 재로딩
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, yearMonth]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | 'CLOSE' | 'REOPEN' | 'PASS'>(null);

  // querySiteId 정리 — 적용 후 URL 깨끗하게
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

  // 사이트 목록 — 「시공중」 현장만 노출 (완공 현장은 더 이상 공수마감 대상 아님)
  useEffect(() => {
    siteApi.listSites().then((s) => {
      // 1단계: 완공 현장 제외 (다른 페이지와 동일한 정책 — !== 'COMPLETED')
      const inProgress = (s.sites ?? []).filter((x) => x.status !== 'COMPLETED');
      // 2단계: 권한별 필터 — SITE 모드(현장 사용자) 는 본인 배정 현장만
      const visible =
        viewMode === 'SITE' && assignedSiteId
          ? inProgress.filter((x) => x.id === assignedSiteId)
          : inProgress;
      setSites(visible);
      if (siteId === 'ALL' && viewMode !== 'HQ' && visible.length > 0) {
        setSiteId(visible[0].id);
      }
    }).catch(() => { /* */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async () => {
    if (!siteId || siteId === 'ALL') {
      // ALL 모드에선 임시로 첫 사이트 사용
      setMembers([]); setWage(null); setAttMonth(null); setMonthClose(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [m, w, am, cs] = await Promise.all([
        teamApi.list({ status: 'ALL' }),
        wageApi.monthSummary({ siteId, yearMonth }).catch(() => null),
        attendanceApi.month({ siteId, yearMonth }).catch(() => null),
        attendanceApi.closeStatus(siteId, yearMonth).catch(() => null),
      ]);
      setMembers(m.members.filter((x) => x.siteId === siteId));
      setWage(w);
      setAttMonth(am);
      setMonthClose(cs?.monthClose ?? null);
      setClosedDates(new Set((cs?.dayCloses ?? []).filter((d) => d.status === 'CLOSED').map((d) => d.date)));
    } catch (err) {
      setError(getErrorMessage(err, '공수마감 데이터 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [siteId, yearMonth]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 행 데이터 derive — 출역 0일 인원은 마감 대상에서 제외 (정산 대상 아님)
  const rows: RowState[] = useMemo(() => {
    return members
      .filter((m) => {
        const wageRow = wage?.rows?.find((r) => r.memberId === m.id);
        const monthRow = attMonth?.rows?.find((r) => r.memberId === m.id);
        // 결근/노쇼는 제외 — 실제 출역(checkInAt 존재)만 카운트
        const validRec = monthRow
          ? Object.values(monthRow.daily).filter((r) => !!r && r.status !== 'ABSENT' && !!r.checkInAt)
          : [];
        const workDays = wageRow?.workDays ?? validRec.length;
        return workDays > 0;
      })
      .map((m) => {
      const wageRow = wage?.rows?.find((r) => r.memberId === m.id);
      const monthRow = attMonth?.rows?.find((r) => r.memberId === m.id);
      const dailyEntriesAll = monthRow ? Object.entries(monthRow.daily) : [];
      // 「유효한 출역」만 카운트 — AttendancePage 와 동일 기준:
      //   record 존재 + status !== 'ABSENT' + checkInAt 있음
      // 결근(ABSENT)/노쇼(checkInAt=null) 는 출역이 아니므로 미확정 일수에서 제외해야 함
      const validEntries = dailyEntriesAll.filter(
        ([, r]) => !!r && r.status !== 'ABSENT' && !!r.checkInAt,
      ) as Array<[string, NonNullable<typeof dailyEntriesAll[number][1]>]>;
      const validRecords = validEntries.map(([, r]) => r);

      const workDays = wageRow?.workDays ?? validRecords.length;
      // dailyHandled 매칭 — record.id 우선, 없으면 memberId 폴백 (AttendancePage 의 키 생성과 일치)
      const lookupHandled = (rid: string | undefined) => {
        if (rid && dailyHandled[`${rid}:${siteId}`]) return dailyHandled[`${rid}:${siteId}`];
        return dailyHandled[`${m.id}:${siteId}`];
      };
      // 총공수: handled.gongsu 가 있으면 그 값, 없으면 record.gongsu
      const totalGongsu = validRecords.reduce((s, r) => {
        const handled = lookupHandled(r.id);
        const g = (handled && typeof handled.gongsu === 'number') ? handled.gongsu : (r.gongsu || 0);
        return s + g;
      }, 0);
      const manualCount = validRecords.filter((r) => r.checkInMethod === 'MANUAL').length;
      // 미확정 = 출역(checkInAt 있음)했는데 (gongsu 0/undefined) AND (일일확정 X) AND (개별 확정 X)
      // 한 번 더 가드: validEntries 가 이미 status !== ABSENT && checkInAt 필터링됐으므로
      // 여기 들어오는 건 「출역은 했는데 공수가 정해지지 않은 일자」
      const unconfirmedDays = validEntries.filter(([d, r]) => {
        const g = (r.gongsu === 0 || (r.gongsu === undefined as unknown));
        const handled = lookupHandled(r.id);
        const isDone = handled?.action === 'done';
        // handled.gongsu 가 양수면 공수 입력 완료된 것으로 간주
        const handledHasGongsu = !!handled && typeof handled.gongsu === 'number' && handled.gongsu > 0;
        return g && !closedDates.has(d) && !isDone && !handledHasGongsu;
      }).length;

      const contractOk = !!m.contractSigned;
      // 동의 = 얼굴인증 / 개인정보동의 — TeamMember 에 별도 플래그 없으므로 faceVerified !== false 로 추정
      const privacyOk = m.faceVerified !== false;
      const faceOk = m.faceVerified !== false;
      const insuranceOk = !!(m.insurance && (m.insurance.pension || m.insurance.health || m.insurance.employment || m.insurance.accident));

      const totalPay = wageRow?.baseAmount ?? 0;
      const deduction = wageRow?.deductionTotal ?? 0;
      const netPay = wageRow?.netAmount ?? 0;

      // 「마감 완료」 = 출역 단계가 HQ_CONFIRMED 일 때만 (SITE_CLOSED 는 중간 단계 → 마감 가능 상태로 표시)
      // 기존 monthClose.status 는 OPEN/CLOSED 두 값만 — SITE_CLOSED 도 CLOSED 로 잡혀 마감 취소 후에도 잠겨 보였음
      const isMonthClosed = monthClose?.attStage === 'HQ_CONFIRMED';
      const status: RowState['status'] = isMonthClosed ? 'CLOSED' : 'CLOSEABLE';

      return {
        member: m, workDays, totalGongsu, manualCount, unconfirmedDays,
        contractOk, privacyOk, faceOk, insuranceOk,
        totalPay, deduction, netPay, status,
      };
    }).sort((a, b) => {
      // 확인필요 → 마감가능 → 마감완료 순
      const order = { NEED_CHECK: 0, CLOSEABLE: 1, CLOSED: 2 };
      return order[a.status] - order[b.status];
    });
  }, [members, wage, attMonth, monthClose, closedDates, dailyHandled, siteId]);

  // KPI
  const kpi = useMemo(() => {
    const totalMembers = rows.length;
    const totalGongsu = rows.reduce((s, r) => s + r.totalGongsu, 0);
    const unconfirmed = rows.reduce((s, r) => s + r.unconfirmedDays, 0);
    const closeable = rows.filter((r) => r.status === 'CLOSEABLE').length;
    const needCheck = rows.filter((r) => r.status === 'NEED_CHECK').length;
    const totalPay = wage?.totalBase ?? rows.reduce((s, r) => s + r.totalPay, 0);
    return { totalMembers, totalGongsu, unconfirmed, closeable, needCheck, totalPay };
  }, [rows, wage]);

  // 동일 기준으로 페이지 단위 isMonthClosed — attStage HQ_CONFIRMED 만 「마감 완료」
  const isMonthClosed = monthClose?.attStage === 'HQ_CONFIRMED';
  // 마감 가드: 마감되지 않았고, 미확정 일자가 없으며, 표에 인원이 있으면 가능
  const canClose = !isMonthClosed && kpi.unconfirmed === 0 && rows.length > 0;
  const siteName = sites.find((s) => s.id === siteId)?.name ?? '—';

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  async function handleClose() {
    if (!siteId || siteId === 'ALL') return;
    setBusy(true);
    try {
      // 정책: 현장 사용자도 한 번의 「월 공수마감」 클릭으로 SITE_CLOSE → HQ_CONFIRM 까지 진행 가능
      // (이전 정책은 SITE/HQ 분리였으나, 운영 편의를 위해 통합)
      const attStage = monthClose?.attStage ?? 'OPEN';
      if (attStage === 'OPEN') {
        await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_SITE_CLOSE' });
      }
      await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_HQ_CONFIRM' });
      flash(`${siteName} ${yearMonth} 공수마감 완료. 노무비 페이지에서 정산을 진행할 수 있습니다.`);
      flashCompletion(`${yearMonth} 공수마감 완료`);
      await loadAll();
    } catch (err) {
      window.alert('마감 실패: ' + getErrorMessage(err, '서버 오류'));
    } finally {
      setBusy(false);
      setConfirmAction(null);
    }
  }
  async function handleReopen() {
    if (!siteId || siteId === 'ALL') return;
    setBusy(true);
    try {
      await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_REVERT_CONFIRM', reason: '관리자 마감 취소' });
      flash(`${siteName} ${yearMonth} 공수마감을 취소했습니다.`);
      flashCompletion('공수마감 취소', { tone: 'danger' });
      await loadAll();
    } catch (err) {
      window.alert('마감 취소 실패: ' + getErrorMessage(err, '서버 오류'));
    } finally {
      setBusy(false);
      setConfirmAction(null);
    }
  }

  function k(n: number): string {
    if (!Number.isFinite(n) || n === 0) return '0';
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
    return n.toLocaleString();
  }

  return (
    <div className="gc-page">
      <PageHeader
        title="월 공수마감"
        subtitle="일일출역확정 데이터를 모아 월 단위로 공수와 출역일수를 확정해 노무비로 넘깁니다. 마감 후 수정은 마감취소가 필요합니다."
        actions={<WorkCloseHeader active="gongsu" siteId={siteId} progress={computeWorkCloseProgress({ today: null, monthClose })} />}
      />

      {error && <p className="gc-error">{error}</p>}
      {toast && <p className="gc-toast">{toast}</p>}

      {/* KPI 5장 — 인증관리 히어로 톤 (att-daily-kpi--notif) — 최상단 배치 */}
      <div className="att-daily-kpi att-daily-kpi--notif">
        {([
          { key: 'attend',    label: '총 출역인원', raw: <><b>{kpi.totalMembers}</b>명</>,                tone: 'plain'  },
          { key: 'gongsu',    label: '총 공수',     raw: <><b>{kpi.totalGongsu.toFixed(1)}</b>공수</>,    tone: 'plain'  },
          { key: 'pending',   label: '미확정 일수', raw: <><b>{kpi.unconfirmed}</b>일</>,                 tone: 'danger' },
          { key: 'closeable', label: '마감가능',    raw: <><b>{kpi.closeable}</b>명</>,                   tone: 'ok'     },
          { key: 'pay',       label: '월 노무비',   raw: <><b>{k(kpi.totalPay)}</b>원</>,                 tone: 'info'   },
        ] as const).map((s, i) => (
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

      {/* 필터 — 히어로 아래로 이동, 외곽 타일 제거 (flat 표시) */}
      <section className="gc-filter gc-filter--flat">
        <div className="gc-filter__cell">
          <label>현장</label>
          <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              options={[
                ...(viewMode === 'HQ' ? [{ value: 'ALL', label: '— 현장 선택 —' }] : []),
                ...sites.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
        </div>
        <div className="gc-filter__cell">
          <label>해당월</label>
          <MacDatePicker
              value={yearMonth}
              onChange={(v) => setYearMonth(v)}
              type="month"
            />
        </div>
        <div className="gc-filter__status">
          {isMonthClosed ? (
            <span className="gc-status gc-status--closed">✓ 마감완료</span>
          ) : (
            <span className="gc-status gc-status--open">진행중</span>
          )}
        </div>
        <div className="gc-filter__actions">
          {isMonthClosed ? (
            <>
              {/* 마감 취소 (코랄 레드 pill) — 마감완료 칩 바로 옆 */}
              <button
                type="button"
                className="gc-btn gc-btn--cancel"
                onClick={() => setConfirmAction('REOPEN')}
                disabled={busy}
              >
                마감 취소
              </button>
              {/* 노무비 확정 — 확정 팝업 후 노무비 마감 화면으로 이동 (선택 현장 자동 전달) */}
              <button
                type="button"
                className="gc-btn gc-btn--ghost"
                onClick={() => {
                  if (siteId === 'ALL') return;
                  if (!window.confirm('확정하시겠습니까?\n\n노무비 마감 화면으로 이동합니다.')) return;
                  navigate('/wage?siteId=' + encodeURIComponent(siteId));
                }}
                disabled={siteId === 'ALL'}
              >
                노무비 확정 →
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="gc-btn gc-btn--ghost"
                onClick={() => {
                  if (siteId === 'ALL') return;
                  if (!window.confirm('확정하시겠습니까?\n\n노무비 마감 화면으로 이동합니다.')) return;
                  navigate('/wage?siteId=' + encodeURIComponent(siteId));
                }}
                disabled={siteId === 'ALL'}
              >
                노무비 확정 →
              </button>
              <button
                type="button"
                className="gc-btn gc-btn--primary"
                onClick={() => setConfirmAction('CLOSE')}
                disabled={!canClose || busy}
                title={!canClose ? (kpi.unconfirmed > 0 ? `미확정 ${kpi.unconfirmed}일을 먼저 확정해주세요.` : '마감 가능 인원이 없습니다.') : ''}
              >
                {busy ? '처리 중…' : '월 공수마감'}
              </button>
            </>
          )}
        </div>
      </section>

      {/* 표 */}
      {siteId === 'ALL' ? (
        <div className="gc-empty">현장을 선택하면 마감 대상자 명단을 보여드립니다.</div>
      ) : loading ? (
        <p className="gc-loading">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <div className="gc-empty">이번 달 출역 기록이 없습니다.</div>
      ) : (
        <div className="gc-table-wrap">
          <table className="gc-table gc-table--sortable">
            <thead>
              <tr>
                <th className="gc-th-no">#</th>
                <SortableTh label="근로자"   k="name"            sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="직종"     k="role"            sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="출역일수" k="workDays"        sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="총공수"   k="totalGongsu"     sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="수동보정" k="manualCount"     sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="미확정"   k="unconfirmedDays" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="계약"     k="contractOk"      sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="동의"     k="privacyOk"       sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="얼굴"     k="faceOk"          sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="보험"     k="insuranceOk"     sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="월 지급액" k="totalPay"       sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="공제"     k="deduction"       sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="실지급"   k="netPay"          sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <SortableTh label="상태"     k="status"          sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <th className="gc-th-actions">조치</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => {
                const dir = sortDir === 'asc' ? 1 : -1;
                const av: any = sortKey === 'name' ? a.member.name
                              : sortKey === 'role' ? (a.member.role || '')
                              : sortKey === 'status' ? a.status
                              : (a as any)[sortKey];
                const bv: any = sortKey === 'name' ? b.member.name
                              : sortKey === 'role' ? (b.member.role || '')
                              : sortKey === 'status' ? b.status
                              : (b as any)[sortKey];
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                if (typeof av === 'boolean' && typeof bv === 'boolean') return ((av === bv) ? 0 : av ? 1 : -1) * dir;
                return String(av ?? '').localeCompare(String(bv ?? ''), 'ko') * dir;
              }).map((r, idx) => (
                <tr key={r.member.id} className={'gc-row gc-row--' + r.status.toLowerCase()}>
                  <td className="gc-td-center gc-td-no">{idx + 1}</td>
                  <td className="gc-td-name">
                    <strong>{r.member.name}</strong>
                    <span className="gc-td-sub">{r.member.phone}</span>
                  </td>
                  <td className="gc-td-center">{r.member.role}</td>
                  <td className="gc-td-center"><strong>{r.workDays}</strong></td>
                  <td className="gc-td-center"><strong>{r.totalGongsu.toFixed(1)}</strong></td>
                  <td className={'gc-td-center' + (r.manualCount > 0 ? ' gc-td--warn' : '')}>{r.manualCount}</td>
                  <td className={'gc-td-center' + (r.unconfirmedDays > 0 ? ' gc-td--danger' : '')}>{r.unconfirmedDays}</td>
                  <td className="gc-td-center"><Pill on={r.contractOk} /></td>
                  <td className="gc-td-center"><Pill on={r.privacyOk} /></td>
                  <td className="gc-td-center"><Pill on={r.faceOk} /></td>
                  <td className="gc-td-center"><Pill on={r.insuranceOk} /></td>
                  <td className="gc-td-center"><strong>{k(r.totalPay)}</strong></td>
                  <td className="gc-td-center">{k(r.deduction)}</td>
                  <td className="gc-td-center"><strong>{k(r.netPay)}</strong></td>
                  <td className="gc-td-center"><StatusChip status={r.status} /></td>
                  <td className="gc-td-center gc-td-actions">
                    <button
                      type="button"
                      className="gc-row-btn"
                      onClick={() => navigate('/attendance?siteId=' + encodeURIComponent(siteId))}
                      title="출역관리에서 상세 확인"
                    >
                      상세
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 마감 / 취소 확인 모달 */}
      {confirmAction === 'CLOSE' && (
        <Modal
          open
          onClose={() => setConfirmAction(null)}
          title="월 공수마감"
          subtitle={`${siteName} · ${yearMonth}`}
          width={460}
        >
          <div className="gc-confirm">
            <p>이번 달 공수를 잠그고 노무비로 넘깁니다.</p>
            <ul>
              <li>총 출역인원 <strong>{kpi.totalMembers}명</strong></li>
              <li>총 공수 <strong>{kpi.totalGongsu.toFixed(1)}</strong></li>
              <li>월 노무비 <strong>{k(kpi.totalPay)}원</strong></li>
            </ul>
            <p className="gc-confirm__hint">마감 후 수정은 「마감 취소」 권한이 있는 관리자만 가능합니다.</p>
            <div className="gc-confirm__actions">
              <button type="button" className="gc-btn gc-btn--ghost" onClick={() => setConfirmAction(null)} disabled={busy}>취소</button>
              <button type="button" className="gc-btn gc-btn--primary" onClick={handleClose} disabled={busy}>
                {busy ? '처리 중…' : '월 공수마감'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmAction === 'REOPEN' && (
        <Modal
          open
          onClose={() => setConfirmAction(null)}
          title="마감 취소"
          subtitle={`${siteName} · ${yearMonth}`}
          width={460}
        >
          <div className="gc-confirm">
            <p>이미 마감된 월의 공수 잠금을 해제합니다.</p>
            <p className="gc-confirm__hint">노무비 페이지가 「마감 전」 상태로 돌아가며, 명세서 발행 등 후속 작업은 다시 마감 후에 가능합니다.</p>
            <div className="gc-confirm__actions">
              <button type="button" className="gc-btn gc-btn--ghost" onClick={() => setConfirmAction(null)} disabled={busy}>닫기</button>
              <button type="button" className="gc-btn gc-btn--dark" onClick={handleReopen} disabled={busy}>
                {busy ? '처리 중…' : '마감 취소'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: 'CLOSEABLE' | 'NEED_CHECK' | 'CLOSED' }) {
  const map = {
    CLOSEABLE:  { label: '마감 가능', cls: 'closeable' },
    NEED_CHECK: { label: '확인 필요', cls: 'check' },
    CLOSED:     { label: '마감 완료', cls: 'closed' },
  } as const;
  const m = map[status];
  return <span className={`gc-status gc-status--${m.cls}`}>{m.label}</span>;
}

function Pill({ on }: { on: boolean }) {
  return (
    <span className={'gc-pill' + (on ? ' gc-pill--on' : ' gc-pill--off')} aria-hidden>
      {on ? '✓' : '✕'}
    </span>
  );
}

function SortableTh<K extends string>({
  label, k, sortKey, sortDir, onClick,
}: {
  label: string;
  k: K;
  sortKey: K;
  sortDir: 'asc' | 'desc';
  onClick: (k: K) => void;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '△';
  return (
    <th
      className={'gc-th-sortable' + (active ? ' is-active' : '')}
      onClick={() => onClick(k)}
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'center' }}
      title={active ? (sortDir === 'asc' ? '오름차순' : '내림차순') : '정렬'}
    >
      <span>{label}</span> <span className="gc-th-arrow">{arrow}</span>
    </th>
  );
}
