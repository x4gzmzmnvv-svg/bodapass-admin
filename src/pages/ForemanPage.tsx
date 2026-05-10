import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Tooltip } from '../components/Tooltip';
import { ForemanRegisterDialog } from '../components/ForemanRegisterDialog';
import { NumberStepper } from '../components/NumberStepper';
import { siteApi } from '../api/site';
import { teamApi } from '../api/team';
import type {
  Foreman,
  ForemanMetrics,
  ForemanSite,
  ForemanSiteRole,
  ForemanPermissionPreset,
  ForemanPermissions,
  ForemanStatus,
  Site,
} from '../api/site.types';
import type { InsuranceFlags, TeamMember } from '../api/team.types';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { getAvatarUrl } from '../utils/avatar';
import { localDateStr } from '../utils/dateLocal';
import { decideTrustTier, tierLabel } from '../utils/workerCode';
import './ForemanPage.css';
import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
import './SiteListPage.css'; // sl-btn / sl-actions 공유 (PageHeader actions 통일)
import './TeamListPage.css'; // team-list__filters / team-list__filter 공유 (필터 행 통일)

/**
 * 반장관리 — 운영상태 중심 화면 (PHASE 2 재설계)
 *
 *   상단:    PageHeader + KPI 5장 (전체 / 활성 / 대기 / 오늘활동 / 조치필요)
 *   필터:    현장 / 검색 / [CSV·반장 등록]
 *   섹션 1:  조치 필요 반장 (있을 때만 — 최우선 노출, 좌측 빨강 막대 + 사유 칩)
 *   섹션 2:  활성 반장 (등록완료/현장배정/활동중/비활성)
 *   섹션 3:  대기 명단 (초대발송/가입대기 — 초대일·경과일·재발송/취소)
 *
 *   행 클릭 → 우측 사이드패널 (5탭: 기본정보·현장배정·팀원·출역지표·권한)
 *
 *   UX 원칙:
 *    1) 「조치 필요」가 가장 먼저 눈에 들어오도록 최상단 + 빨강 강조
 *    2) 정보밀도 낮추기 — 행 1줄에 필수 4-5개, 보조정보는 작은 두 번째 줄
 *    3) 삭제는 우측 절대 위치 아이콘으로 비주얼 가중 ↓
 *    4) 기존 톤·색상 (—color-primary / 회색 #f3f4f6 계열) 유지
 */

// ─────────────────────────────────────────────────────────────────────
// 유틸 — 상태/배지/사유 계산
// ─────────────────────────────────────────────────────────────────────

/**
 * 반장 상태 도출 — Foreman.status 가 있으면 그대로 사용,
 * 없는 옛 시드는 registered + lastActiveAt 으로 fallback 추론.
 */
function deriveStatus(f: Foreman, hasAssignment: boolean): ForemanStatus {
  if (f.status) return f.status;
  if (!f.registered) return 'INVITED';
  if (!hasAssignment) return 'REGISTERED';
  if (f.lastActiveAt) {
    const days = Math.floor((Date.now() - new Date(f.lastActiveAt).getTime()) / 86_400_000);
    if (days >= 30) return 'INACTIVE';
    if (days <= 7) return 'ACTIVE';
  }
  return 'ASSIGNED';
}

/** 상태 → 한글 라벨 + CSS 톤 */
function statusBadge(s: ForemanStatus): { label: string; tone: string } {
  switch (s) {
    case 'INVITED':              return { label: '초대발송',  tone: 'amber' };
    case 'PENDING_REGISTRATION': return { label: '가입대기',  tone: 'amber' };
    case 'REGISTERED':           return { label: '등록완료',  tone: 'teal'  };
    case 'ASSIGNED':             return { label: '현장배정',  tone: 'blue'  };
    case 'ACTIVE':               return { label: '활동중',    tone: 'green' };
    case 'INACTIVE':             return { label: '비활성',    tone: 'gray'  };
    case 'SUSPENDED':            return { label: '정지',      tone: 'red'   };
  }
}

/** 「조치 필요」 사유 — 하나라도 해당하면 조치 필요 섹션으로 분류 */
function computeNeedActionReasons(
  f: Foreman,
  status: ForemanStatus,
  assignments: ForemanSite[],
  teamCount: number,
  metric: ForemanMetrics | undefined,
): string[] {
  const reasons: string[] = [];
  // 1) 초대 후 미가입 (3일 이상)
  if (status === 'INVITED' || status === 'PENDING_REGISTRATION') {
    const days = Math.floor((Date.now() - new Date(f.invitedAt).getTime()) / 86_400_000);
    if (days >= 3) reasons.push(`초대 후 ${days}일 미가입`);
  }
  // 2) 현장 미배정 — 가입 완료인데 배정 0
  if (
    (status === 'REGISTERED' || (f.registered && assignments.length === 0)) &&
    f.status !== 'SUSPENDED'
  ) {
    reasons.push('현장 미배정');
  }
  // 3) 팀원 0명 (배정은 됐는데)
  if (assignments.length > 0 && teamCount === 0) {
    reasons.push('팀원 0명');
  }
  // 4) 수동처리 다수 — 최근 7일 3건 이상
  if (metric && metric.recentManualCount >= 3) {
    reasons.push(`수동처리 ${metric.recentManualCount}건`);
  }
  // 5) GPS 미수집 다수 — 최근 7일 2건 이상
  if (metric && metric.recentGpsMissingCount >= 2) {
    reasons.push(`GPS 오류 ${metric.recentGpsMissingCount}건`);
  }
  // 6) 최근 7일 이상 활동 없음 (활성으로 추정되는 경우만)
  if (status === 'INACTIVE') {
    reasons.push('7일 이상 활동 없음');
  }
  return reasons;
}

function formatKDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}
function daysSince(iso?: string): number {
  if (!iso) return 0;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}
function pct(v?: number): string {
  if (v === undefined || isNaN(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

const CANCELLED_FOREMEN_KEY = 'bodapass.foremen.cancelled.v1';
function loadCancelledForemen(): Set<string> {
  try {
    const raw = localStorage.getItem(CANCELLED_FOREMEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveCancelledForemen(s: Set<string>) {
  try { localStorage.setItem(CANCELLED_FOREMEN_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────────────────────────────

export function ForemanPage() {
  const { viewMode, assignedSiteId } = useAuth();
  const [foremen, setForemen] = useState<Foreman[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [assignments, setAssignments] = useState<ForemanSite[]>([]);
  const [metrics, setMetrics] = useState<ForemanMetrics[]>([]);
  const [siteFilter, setSiteFilter] = useState<string>('ALL');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'PENDING' | 'NEED'>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [foremanRegOpen, setForemanRegOpen] = useState(false);
  const [openForeman, setOpenForeman] = useState<Foreman | null>(null);
  const [openTab, setOpenTab] = useState<DetailTab>('basic');
  const [assignTarget, setAssignTarget] = useState<Foreman | null>(null);
  const [editingAssignment, setEditingAssignment] = useState<ForemanSite | null>(null);
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(() => loadCancelledForemen());

  function setCancelled(id: string, cancelled: boolean) {
    setCancelledIds((prev) => {
      const next = new Set(prev);
      if (cancelled) next.add(id);
      else next.delete(id);
      saveCancelledForemen(next);
      return next;
    });
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, f, m, fs, mt] = await Promise.all([
        siteApi.listSites(),
        siteApi.listForemen(),
        teamApi.list({}),
        siteApi.listForemanSites().catch(() => ({ foremanSites: [] as ForemanSite[] })),
        siteApi.listForemanMetrics().catch(() => ({ metrics: [] as ForemanMetrics[] })),
      ]);
      const visibleSites =
        viewMode === 'SITE' && assignedSiteId
          ? s.sites.filter((x) => x.id === assignedSiteId)
          : s.sites;
      const visibleForemen =
        viewMode === 'SITE' && assignedSiteId
          ? f.foremen.filter((x) => x.siteId === assignedSiteId)
          : f.foremen;
      setSites(visibleSites);
      setForemen(visibleForemen);
      setMembers(m.members);
      setAssignments(fs.foremanSites ?? []);
      setMetrics(mt.metrics ?? []);
    } catch (err) {
      setError(getErrorMessage(err, '반장 목록 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [viewMode, assignedSiteId]);

  useEffect(() => { load(); }, [load]);

  // 색인 — foremanId → 데이터
  const teamCountByForeman = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) {
      if (!m.foremanId) continue;
      map.set(m.foremanId, (map.get(m.foremanId) ?? 0) + 1);
    }
    return map;
  }, [members]);

  const assignmentsByForeman = useMemo(() => {
    const map = new Map<string, ForemanSite[]>();
    for (const a of assignments) {
      const arr = map.get(a.foremanId) ?? [];
      arr.push(a);
      map.set(a.foremanId, arr);
    }
    return map;
  }, [assignments]);

  const metricsByForeman = useMemo(() => {
    const map = new Map<string, ForemanMetrics>();
    for (const m of metrics) map.set(m.foremanId, m);
    return map;
  }, [metrics]);

  const lastActivityByForeman = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      if (!m.foremanId) continue;
      const cur = map.get(m.foremanId);
      if (!cur || m.joinedAt > cur) map.set(m.foremanId, m.joinedAt);
    }
    return map;
  }, [members]);

  // 필터 적용
  const filteredForemen = useMemo(() => {
    const q = search.trim().toLowerCase();
    return foremen.filter((f) => {
      if (siteFilter !== 'ALL') {
        const fas = assignmentsByForeman.get(f.id) ?? [];
        const matchPrimary = f.siteId === siteFilter;
        const matchAssign = fas.some((a) => a.siteId === siteFilter);
        if (!matchPrimary && !matchAssign) return false;
      }
      if (roleFilter !== 'ALL' && (f.role ?? '') !== roleFilter) return false;
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'ACTIVE'  && !f.registered) return false;
        if (statusFilter === 'PENDING' && f.registered)  return false;
      }
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.phone.includes(q) ||
        (f.role ?? '').toLowerCase().includes(q)
      );
    });
  }, [foremen, siteFilter, roleFilter, statusFilter, search, assignmentsByForeman]);

  /** 반장 + 파생 정보 통합 행 */
  type ForemanRow = {
    foreman: Foreman;
    status: ForemanStatus;
    assignments: ForemanSite[];
    primaryAssignment: ForemanSite | undefined;
    teamCount: number;
    metric: ForemanMetrics | undefined;
    lastActivity: string | undefined;
    reasons: string[];
  };
  const rows: ForemanRow[] = useMemo(() => {
    return filteredForemen.map((f) => {
      const fas = assignmentsByForeman.get(f.id) ?? [];
      const primary = fas.find((a) => a.isPrimary) ?? fas[0];
      const status = deriveStatus(f, fas.length > 0);
      const teamCount = teamCountByForeman.get(f.id) ?? 0;
      const metric = metricsByForeman.get(f.id);
      const lastActivity = f.lastActiveAt ?? lastActivityByForeman.get(f.id);
      const reasons = computeNeedActionReasons(f, status, fas, teamCount, metric);
      return { foreman: f, status, assignments: fas, primaryAssignment: primary, teamCount, metric, lastActivity, reasons };
    });
  }, [filteredForemen, assignmentsByForeman, teamCountByForeman, metricsByForeman, lastActivityByForeman]);

  // 분류
  const needActionRows = useMemo(() => rows.filter((r) => r.reasons.length > 0), [rows]);
  const pendingRows = useMemo(
    () => rows.filter((r) => !r.foreman.registered && r.reasons.length === 0),
    [rows],
  );
  const activeRows = useMemo(
    () => rows.filter((r) => r.foreman.registered && r.reasons.length === 0),
    [rows],
  );

  // KPI
  const kpi = useMemo(() => {
    const total = rows.length;
    const active = rows.filter((r) => r.foreman.registered).length;
    const pending = rows.filter((r) => !r.foreman.registered).length;
    const todayActive = rows.filter((r) => (r.metric?.todayAttendanceCount ?? 0) > 0).length;
    const need = needActionRows.length;
    return { total, active, pending, todayActive, need };
  }, [rows, needActionRows]);

  function siteNameOf(siteId: string): string {
    return sites.find((s) => s.id === siteId)?.name ?? '—';
  }

  function exportForemenCsv(rs: ForemanRow[], fileLabel: string) {
    if (rs.length === 0) return;
    const header = ['이름', '전화', '직종', '주현장', '등록일', '상태', '오늘출역', '수동처리', 'GPS오류'];
    const lines = [header.join(',')];
    for (const r of rs) {
      const row = [
        r.foreman.name,
        r.foreman.phone,
        r.foreman.role ?? '기타',
        r.primaryAssignment ? siteNameOf(r.primaryAssignment.siteId) : siteNameOf(r.foreman.siteId),
        formatKDate(r.foreman.invitedAt),
        statusBadge(r.status).label,
        String(r.metric?.todayAttendanceCount ?? 0),
        String(r.metric?.recentManualCount ?? 0),
        String(r.metric?.recentGpsMissingCount ?? 0),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(row.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileLabel}-${localDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openDetail(foreman: Foreman, tab: DetailTab = 'basic') {
    setOpenForeman(foreman);
    setOpenTab(tab);
  }

  function openAssign(f: Foreman, edit?: ForemanSite) {
    setAssignTarget(f);
    setEditingAssignment(edit ?? null);
  }

  return (
    <div className="foreman-page">
      <PageHeader
        title="반장관리"
        subtitle="누가 어느 현장을 맡고, 오늘 출역을 처리했는지 — 운영상태 중심으로 본다."
        actions={
          <div className="sl-actions">
            <button
              type="button"
              className="sl-btn sl-btn--ghost"
              onClick={() => exportForemenCsv(rows, '반장목록')}
              disabled={rows.length === 0}
              title="반장 목록 CSV 내보내기"
            >
              ↓ CSV 내보내기
            </button>
            <button
              type="button"
              className="sl-btn sl-btn--primary"
              onClick={() => setForemanRegOpen(true)}
            >
              ＋ 반장 등록
            </button>
          </div>
        }
      />

      {/* KPI 5장 — 조치필요는 빨강 강조 */}
      <section className="foreman-kpi">
        <KpiCard label="전체 반장"  value={kpi.total} />
        <KpiCard label="활성 반장"  value={kpi.active} tone="green" />
        <KpiCard label="대기 반장"  value={kpi.pending} tone="amber" />
        <KpiCard label="오늘 활동"  value={kpi.todayActive} tone="blue" />
        <KpiCard label="조치 필요"  value={kpi.need} tone="red" emphasized />
      </section>

      {/* 필터 행 — 인력관리와 동일 패턴 (라벨 위 / 셀렉트 아래) */}
      <section className="team-list__filters team-list__filters--flat">
        <div className="team-list__filter">
          <label>현장</label>
          <MacSelect
              value={siteFilter}
              onChange={(v) => setSiteFilter(v)}
              options={[{ value: "ALL", label: '전체 현장' }, ...sites.map((s) => (
              ({ value: s.id, label: s.name })
            ))]}
            />
        </div>
        <div className="team-list__filter">
          <label>직종</label>
          <MacSelect
              value={roleFilter}
              onChange={(v) => setRoleFilter(v)}
              options={[{ value: "ALL", label: '전체 직종' }, ...Array.from(new Set(foremen.map((f) => f.role).filter(Boolean))).sort().map((r) => (
              ({ value: r as string, label: r as string })
            ))]}
            />
        </div>
        <div className="team-list__filter">
          <label>상태</label>
          <MacSelect
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[{ value: "ALL", label: '전체' }, { value: "ACTIVE", label: '활성' }, { value: "PENDING", label: '대기' }]}
            />
        </div>
        <div className="team-list__filter team-list__search">
          <input
            type="search"
            placeholder="이름·전화·직종 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

      {error && <p className="foreman-page__error">{error}</p>}

      {loading ? (
        <p className="foreman-page__loading">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <div className="foreman-settings__empty">
          <p>등록된 반장이 없습니다.</p>
          <p className="foreman-settings__empty-sub">「반장 등록」 버튼으로 새 반장을 추가하세요.</p>
          <button
            type="button"
            className="foreman-settings__btn foreman-settings__btn--primary"
            onClick={() => setForemanRegOpen(true)}
          >
            반장 등록
          </button>
        </div>
      ) : (
        <>
          {/* 1) 조치 필요 — 최우선 */}
          {needActionRows.length > 0 && (
            <ForemanSection
              title="조치 필요"
              accent="red"
              count={needActionRows.length}
              description="아래 반장들은 즉시 확인이 필요합니다. 사유를 클릭하면 해당 영역으로 이동합니다."
            >
              {needActionRows.map((r) => (
                <ForemanCard
                  key={r.foreman.id}
                  row={r}
                  variant="needAction"
                  siteNameOf={siteNameOf}
                  onOpenDetail={(tab) => openDetail(r.foreman, tab)}
                  onAssign={() => openAssign(r.foreman)}
                  onResendInvite={() => window.alert(`${r.foreman.name} 반장에게 초대를 재발송했습니다.`)}
                  onDelete={async () => {
                    if (!window.confirm(`${r.foreman.name} 반장을 삭제하시겠습니까?`)) return;
                    try {
                      await siteApi.deleteForeman(r.foreman.id);
                      await load();
                    } catch (err) {
                      window.alert('삭제 실패: ' + getErrorMessage(err, '서버 오류'));
                    }
                  }}
                />
              ))}
            </ForemanSection>
          )}

          {/* 2) 활성 반장 */}
          {activeRows.length > 0 && (
            <ForemanSection
              title="활성 반장"
              count={activeRows.length}
              description="현장에서 운영 중인 반장입니다. 행을 클릭하면 상세를 봅니다."
            >
              {activeRows.map((r) => (
                <ForemanCard
                  key={r.foreman.id}
                  row={r}
                  variant="active"
                  siteNameOf={siteNameOf}
                  onOpenDetail={(tab) => openDetail(r.foreman, tab)}
                  onAssign={() => openAssign(r.foreman)}
                  onDelete={async () => {
                    if (!window.confirm(`${r.foreman.name} 반장을 삭제하시겠습니까?`)) return;
                    try {
                      await siteApi.deleteForeman(r.foreman.id);
                      await load();
                    } catch (err) {
                      window.alert('삭제 실패: ' + getErrorMessage(err, '서버 오류'));
                    }
                  }}
                />
              ))}
            </ForemanSection>
          )}

          {/* 3) 대기 명단 */}
          {pendingRows.length > 0 && (
            <ForemanSection
              title="대기 명단"
              count={pendingRows.length}
              description="초대를 보냈지만 아직 가입을 마치지 않은 반장입니다."
            >
              {pendingRows.map((r) => (
                <ForemanCard
                  key={r.foreman.id}
                  row={r}
                  variant="pending"
                  cancelled={cancelledIds.has(r.foreman.id)}
                  siteNameOf={siteNameOf}
                  onOpenDetail={(tab) => openDetail(r.foreman, tab)}
                  onAssign={() => openAssign(r.foreman)}
                  onResendInvite={() => {
                    setCancelled(r.foreman.id, false);
                    window.alert(`${r.foreman.name} 반장에게 초대를 재발송했습니다.`);
                  }}
                  onCancelInvite={() => {
                    if (!window.confirm(`${r.foreman.name} 반장의 초대를 취소하시겠습니까?\n· 명단에는 유지되며 「초대 취소됨」 으로 표시됩니다.`)) return;
                    setCancelled(r.foreman.id, true);
                  }}
                  onDelete={async () => {
                    if (!window.confirm(`${r.foreman.name} 반장을 명단에서 영구 삭제하시겠습니까?`)) return;
                    try {
                      await siteApi.deleteForeman(r.foreman.id);
                      setCancelled(r.foreman.id, false);
                      await load();
                    } catch (err) {
                      window.alert('삭제 실패: ' + getErrorMessage(err, '서버 오류'));
                    }
                  }}
                />
              ))}
            </ForemanSection>
          )}
        </>
      )}

      {/* 반장 등록 다이얼로그 */}
      <ForemanRegisterDialog
        open={foremanRegOpen}
        onClose={() => setForemanRegOpen(false)}
        sites={sites}
        defaultSiteId={siteFilter !== 'ALL' ? siteFilter : undefined}
        onCreated={async () => {
          setForemanRegOpen(false);
          await load();
        }}
      />

      {/* 현장배정 다이얼로그 */}
      {assignTarget && (
        <SiteAssignmentDialog
          foreman={assignTarget}
          sites={sites}
          existing={editingAssignment ?? undefined}
          defaultSiteId={
            siteFilter !== 'ALL'
              ? siteFilter
              : assignTarget.siteId && assignTarget.siteId !== ''
                ? assignTarget.siteId
                : sites[0]?.id
          }
          onClose={() => { setAssignTarget(null); setEditingAssignment(null); }}
          onSent={async () => {
            setAssignTarget(null);
            setEditingAssignment(null);
            await load();
          }}
        />
      )}

      {/* 반장 상세 — 5탭 사이드패널.
          현장배정 다이얼로그가 열려 있을 동안에는 가려서 모달 중첩 방지 (assignTarget 으로 가드) */}
      {openForeman && !assignTarget && (
        <ForemanDetailPanel
          foreman={openForeman}
          assignments={assignmentsByForeman.get(openForeman.id) ?? []}
          members={members.filter((m) => m.foremanId === openForeman.id)}
          metric={metricsByForeman.get(openForeman.id)}
          sites={sites}
          tab={openTab}
          setTab={setOpenTab}
          onClose={() => setOpenForeman(null)}
          onAssignNew={() => openAssign(openForeman)}
          onAssignEdit={(a) => openAssign(openForeman, a)}
          onAssignEnd={async (a) => {
            if (!window.confirm(`「${siteNameOf(a.siteId)}」 배정을 종료하시겠습니까?`)) return;
            try {
              await siteApi.updateForemanSite(a.id, { status: 'TERMINATED' });
              await load();
            } catch (err) {
              window.alert('종료 실패: ' + getErrorMessage(err, '서버 오류'));
            }
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// KPI 카드
// ─────────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, tone, emphasized,
}: {
  label: string; value: number; tone?: 'green' | 'amber' | 'blue' | 'red'; emphasized?: boolean;
}) {
  const cls =
    'foreman-kpi__card' +
    (tone ? ` foreman-kpi__card--${tone}` : '') +
    (emphasized ? ' foreman-kpi__card--emphasized' : '');
  return (
    <div className={cls}>
      <div className="foreman-kpi__label">{label}</div>
      <div className="foreman-kpi__value">{value.toLocaleString('ko-KR')}<span className="foreman-kpi__unit">명</span></div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 섹션 컨테이너
// ─────────────────────────────────────────────────────────────────────

function ForemanSection({
  title, count, description, accent, children,
}: {
  title: string;
  count: number;
  description: string;
  accent?: 'red';
  children: React.ReactNode;
}) {
  return (
    <div className={'foreman-settings__section' + (accent === 'red' ? ' foreman-settings__section--accent-red' : '')}>
      <header className="foreman-settings__head">
        <div className="foreman-settings__head-text">
          <h2>
            {title}
            <span className="foreman-settings__head-count">{count}</span>
          </h2>
          <p>{description}</p>
        </div>
      </header>
      <ul className="foreman-settings__list">{children}</ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 반장 카드 (행) — 정보밀도 낮춘 2줄 구조
// ─────────────────────────────────────────────────────────────────────

interface ForemanRowProps {
  row: {
    foreman: Foreman;
    status: ForemanStatus;
    assignments: ForemanSite[];
    primaryAssignment: ForemanSite | undefined;
    teamCount: number;
    metric: ForemanMetrics | undefined;
    lastActivity: string | undefined;
    reasons: string[];
  };
  variant: 'needAction' | 'active' | 'pending';
  cancelled?: boolean;
  siteNameOf: (siteId: string) => string;
  onOpenDetail: (tab: DetailTab) => void;
  onAssign: () => void;
  onResendInvite?: () => void;
  onCancelInvite?: () => void;
  onDelete: () => void | Promise<void>;
}

function ForemanCard({
  row, variant, cancelled, siteNameOf,
  onOpenDetail, onAssign, onResendInvite, onCancelInvite, onDelete,
}: ForemanRowProps) {
  const f = row.foreman;
  const sb = statusBadge(row.status);
  const metric = row.metric;
  const primaryName = row.primaryAssignment
    ? siteNameOf(row.primaryAssignment.siteId)
    : f.siteId
      ? siteNameOf(f.siteId)
      : null;
  const trade = row.primaryAssignment?.trade ?? f.role ?? '기타';

  return (
    <li
      className={
        'fr-card' +
        (variant === 'needAction' ? ' fr-card--need-action' : '') +
        (variant === 'pending' ? ' fr-card--pending' : '') +
        (cancelled ? ' fr-card--cancelled' : '')
      }
      onClick={() => onOpenDetail('basic')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail('basic'); } }}
    >
      {/* 1차 행 */}
      <div className="fr-card__primary">
        <span className="fr-card__avatar">
          {variant !== 'pending' && (
            <img
              src={getAvatarUrl(f.id, 96)}
              alt={f.name}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
                (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'flex');
              }}
            />
          )}
          <em className="fr-card__avatar-fallback">{f.name.slice(0, 1)}</em>
        </span>

        <div className="fr-card__title">
          <div className="fr-card__name-row">
            <strong className="fr-card__name">{f.name} 반장</strong>
            <span className={'fr-status fr-status--' + sb.tone}>{sb.label}</span>
            {cancelled && <span className="fr-status fr-status--gray">초대취소</span>}
          </div>
          <div className="fr-card__site-row">
            {primaryName ? (
              <>
                <span className="fr-card__site">{primaryName}</span>
                <span className="fr-dot">·</span>
                <span className="fr-card__trade">{trade}</span>
                {row.assignments.length > 1 && (
                  <span className="fr-multi-chip" title="여러 현장에 배정된 반장">
                    + {row.assignments.length - 1}곳
                  </span>
                )}
              </>
            ) : (
              <span className="fr-card__site fr-card__site--none">현장 미배정</span>
            )}
          </div>
        </div>

        {/* 핵심 수치 (variant 별로 다름) */}
        {variant !== 'pending' ? (
          <div className="fr-card__metrics">
            <Metric label="팀원" value={`${row.teamCount}명`} />
            <Metric label="오늘 출역" value={`${metric?.todayAttendanceCount ?? 0}명`} />
            <Metric label="수동처리" value={`${metric?.recentManualCount ?? 0}건`} tone={metric && metric.recentManualCount >= 3 ? 'warn' : undefined} />
            <Metric label="GPS 오류" value={`${metric?.recentGpsMissingCount ?? 0}건`} tone={metric && metric.recentGpsMissingCount >= 2 ? 'warn' : undefined} />
          </div>
        ) : (
          <div className="fr-card__metrics">
            <Metric label="발송" value={f.notifyChannel === 'KAKAO' ? '카톡' : 'SMS'} />
            <Metric label="초대일" value={formatKDate(f.invitedAt)} />
            <Metric label="경과" value={`D+${daysSince(f.invitedAt)}`} tone={daysSince(f.invitedAt) >= 3 ? 'warn' : undefined} />
          </div>
        )}

        {/* 액션 — onClick 으로 이벤트 버블 차단 */}
        <div className="fr-card__actions" onClick={(e) => e.stopPropagation()}>
          {variant !== 'pending' && (
            <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost foreman-settings__btn--sm" onClick={() => onOpenDetail('members')}>
              팀원
            </button>
          )}
          <button type="button" className="foreman-settings__btn foreman-settings__btn--primary foreman-settings__btn--sm" onClick={onAssign}>
            현장배정
          </button>
          {variant === 'pending' && !cancelled && (
            <>
              <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost foreman-settings__btn--sm" onClick={onResendInvite}>
                재발송
              </button>
              <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost foreman-settings__btn--sm" onClick={onCancelInvite}>
                초대취소
              </button>
            </>
          )}
          {variant === 'pending' && cancelled && (
            <button type="button" className="foreman-settings__btn foreman-settings__btn--primary foreman-settings__btn--sm" onClick={onResendInvite}>
              초대
            </button>
          )}
          <button
            type="button"
            className="fr-card__icon-btn"
            title="삭제"
            aria-label="삭제"
            onClick={() => void onDelete()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2차 행 — 보조정보 */}
      <div className="fr-card__secondary">
        <span className="fr-card__sub">{f.phone}</span>
        <span className="fr-dot">·</span>
        <span className="fr-card__sub">등록 {formatKDate(f.invitedAt)}</span>
        {row.lastActivity && (
          <>
            <span className="fr-dot">·</span>
            <span className="fr-card__sub">최근활동 {formatKDate(row.lastActivity)}</span>
          </>
        )}
        {variant === 'needAction' && row.reasons.length > 0 && (
          <span className="fr-reasons">
            {row.reasons.map((r, i) => (
              <span key={i} className="fr-reason-chip" title={r}>· {r}</span>
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' }) {
  return (
    <div className={'fr-metric' + (tone === 'warn' ? ' fr-metric--warn' : '')}>
      <span className="fr-metric__label">{label}</span>
      <span className="fr-metric__value">{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 반장 상세 — 5탭 사이드 패널 (Modal 기반)
// ─────────────────────────────────────────────────────────────────────

type DetailTab = 'basic' | 'sites' | 'members' | 'metrics' | 'permissions';
const DETAIL_TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'basic',       label: '기본정보' },
  { key: 'sites',       label: '현장배정' },
  { key: 'members',     label: '팀원' },
  { key: 'metrics',     label: '출역지표' },
  { key: 'permissions', label: '권한' },
];

function ForemanDetailPanel({
  foreman, assignments, members, metric, sites, tab, setTab, onClose,
  onAssignNew, onAssignEdit, onAssignEnd,
}: {
  foreman: Foreman;
  assignments: ForemanSite[];
  members: TeamMember[];
  metric: ForemanMetrics | undefined;
  sites: Site[];
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onClose: () => void;
  onAssignNew: () => void;
  onAssignEdit: (a: ForemanSite) => void;
  onAssignEnd: (a: ForemanSite) => void;
}) {
  const status = deriveStatus(foreman, assignments.length > 0);
  const sb = statusBadge(status);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '—';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${foreman.name} 반장`}
      subtitle={`${foreman.phone} · 상태 ${sb.label}`}
      width={920}
    >
      <div className="fdp">
        <nav className="fdp__tabs" role="tablist">
          {DETAIL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={'fdp__tab' + (tab === t.key ? ' fdp__tab--active' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="fdp__body">
          {tab === 'basic' && (
            <BasicInfoTab foreman={foreman} status={status} metric={metric} />
          )}
          {tab === 'sites' && (
            <SitesTab
              assignments={assignments}
              siteName={siteName}
              onAssignNew={onAssignNew}
              onAssignEdit={onAssignEdit}
              onAssignEnd={onAssignEnd}
            />
          )}
          {tab === 'members' && (
            <MembersTab members={members} />
          )}
          {tab === 'metrics' && (
            <MetricsTab metric={metric} />
          )}
          {tab === 'permissions' && (
            <PermissionsTab assignments={assignments} siteName={siteName} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function BasicInfoTab({
  foreman, status, metric,
}: { foreman: Foreman; status: ForemanStatus; metric: ForemanMetrics | undefined }) {
  const sb = statusBadge(status);
  return (
    <div className="fdp__grid">
      <Field label="이름"          value={foreman.name + ' 반장'} />
      <Field label="휴대폰"        value={foreman.phone} mono />
      <Field label="상태"          value={<span className={'fr-status fr-status--' + sb.tone}>{sb.label}</span>} />
      <Field label="등록일"        value={formatKDate(foreman.registeredAt ?? foreman.invitedAt)} />
      <Field label="최근활동"      value={formatKDate(foreman.lastActiveAt)} />
      <Field label="초대 채널"     value={foreman.notifyChannel === 'KAKAO' ? '카카오톡' : 'SMS'} />
      <Field label="초대일"        value={`${formatKDate(foreman.invitedAt)} (D+${daysSince(foreman.invitedAt)})`} />
      <Field label="누적 출역"     value={metric ? `${metric.totalAttendanceCount}건` : '—'} />
    </div>
  );
}

function SitesTab({
  assignments, siteName, onAssignNew, onAssignEdit, onAssignEnd,
}: {
  assignments: ForemanSite[];
  siteName: (id: string) => string;
  onAssignNew: () => void;
  onAssignEdit: (a: ForemanSite) => void;
  onAssignEnd: (a: ForemanSite) => void;
}) {
  const active = assignments.filter((a) => a.status !== 'TERMINATED');
  return (
    <div className="fdp__sites">
      <div className="fdp__sites-head">
        <p className="fdp__hint">반장 1명이 여러 현장에 동시 배정될 수 있습니다.</p>
        <button type="button" className="foreman-settings__btn foreman-settings__btn--primary foreman-settings__btn--sm" onClick={onAssignNew}>
          + 새 현장배정
        </button>
      </div>
      {active.length === 0 ? (
        <div className="fdp__empty">아직 배정된 현장이 없습니다.</div>
      ) : (
        <ul className="fdp__site-list">
          {active.map((a) => (
            <li key={a.id} className={'fdp__site-row' + (a.isPrimary ? ' fdp__site-row--primary' : '')}>
              <div className="fdp__site-info">
                <div className="fdp__site-name">
                  {siteName(a.siteId)}
                  {a.isPrimary && <span className="fdp__primary-chip">주담당</span>}
                </div>
                <div className="fdp__site-meta">
                  <span>{a.role}</span>
                  <span className="fr-dot">·</span>
                  <span>{a.trade}</span>
                  <span className="fr-dot">·</span>
                  <span>{a.startDate} ~ {a.endDate}</span>
                  <span className="fr-dot">·</span>
                  <span className={'fr-status fr-status--' + (a.status === 'APPROVED' || a.status === 'ACTIVE' ? 'green' : a.status === 'PENDING' ? 'amber' : 'gray')}>
                    {a.status === 'PENDING' ? '승인대기' : a.status === 'APPROVED' ? '승인완료' : a.status === 'ACTIVE' ? '운영중' : a.status === 'REJECTED' ? '반려' : '종료'}
                  </span>
                </div>
              </div>
              <div className="fdp__site-actions">
                <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost foreman-settings__btn--sm" onClick={() => onAssignEdit(a)}>
                  변경
                </button>
                <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost foreman-settings__btn--sm" onClick={() => onAssignEnd(a)}>
                  종료
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MembersTab({ members }: { members: TeamMember[] }) {
  if (members.length === 0) {
    return <div className="fdp__empty">아직 등록된 팀원이 없습니다.</div>;
  }
  const total = members.length;
  const ready = members.filter((m) => !m.leftAt && !!m.contractSigned && m.faceVerified !== false).length;
  const noContract = members.filter((m) => !m.contractSigned).length;
  const noFace = members.filter((m) => m.faceVerified === false).length;
  const noSafetyEdu = members.filter((m) => !m.safetyEduCompleted).length;
  return (
    <div className="fdp__members">
      <div className="fdp__members-summary">
        <Field label="전체 팀원"           value={`${total}명`} />
        <Field label="출근 가능"           value={`${ready}명`} />
        <Field label="계약 미체결"         value={`${noContract}명`} tone={noContract > 0 ? 'warn' : undefined} />
        <Field label="얼굴 미등록"         value={`${noFace}명`} tone={noFace > 0 ? 'warn' : undefined} />
        <Field label="안전교육 미이수"     value={`${noSafetyEdu}명`} tone={noSafetyEdu > 0 ? 'warn' : undefined} />
      </div>
      <div className="fmd__table-wrap">
        <table className="fmd__table">
          <thead>
            <tr>
              <th className="fmd__th-num">#</th>
              <th>이름</th>
              <th>직종</th>
              <th>국적</th>
              <th className="fmd__th-center">인증</th>
              <th className="fmd__th-center">4대보험</th>
              <th className="fmd__th-center">기초안전교육</th>
              <th>자격증</th>
              <th className="fmd__th-center">상태</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.id}>
                <td className="fmd__td-num">{i + 1}</td>
                <td>
                  <div className="fmd__name">
                    {m.name}
                    <span className={'fmd__tier fmd__tier--' + tierLabel(decideTrustTier(m)).tone}>
                      {tierLabel(decideTrustTier(m)).sub}
                    </span>
                  </div>
                  <div className="fmd__sub">{m.phone}</div>
                </td>
                <td><span className="fmd__role-chip">{m.role}</span></td>
                <td><NationalityChip idType={m.idType} /></td>
                <td className="fmd__td-center"><VerificationPills member={m} /></td>
                <td className="fmd__td-center"><InsurancePills insurance={m.insurance} /></td>
                <td className="fmd__td-center">
                  {m.safetyEduCompleted
                    ? <span className="fmd__chip fmd__chip--ok">✓ 이수</span>
                    : <span className="fmd__chip fmd__chip--warn">미이수</span>}
                </td>
                <td><CertificateCell role={m.role} memberId={m.id} /></td>
                <td className="fmd__td-center">
                  {m.leftAt
                    ? <span className="fmd__chip fmd__chip--off">이탈</span>
                    : m.siteId
                      ? <span className="fmd__chip fmd__chip--ok">출근중</span>
                      : <span className="fmd__chip fmd__chip--info">대기중</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricsTab({ metric }: { metric: ForemanMetrics | undefined }) {
  if (!metric) return <div className="fdp__empty">출역지표가 아직 산출되지 않았습니다.</div>;
  return (
    <div className="fdp__grid">
      <Field label="오늘 출역 처리"     value={`${metric.todayAttendanceCount}건`} />
      <Field label="이번 달 출역"       value={`${metric.monthAttendanceCount}건`} />
      <Field label="얼굴인식 성공률"    value={pct(metric.faceRecognitionRate)}
             tone={metric.faceRecognitionRate < 0.85 ? 'warn' : undefined} />
      <Field label="수동처리율"         value={pct(metric.manualProcessingRate)}
             tone={metric.manualProcessingRate > 0.15 ? 'warn' : undefined} />
      <Field label="GPS 정상률"          value={pct(metric.gpsValidRate)}
             tone={metric.gpsValidRate < 0.9 ? 'warn' : undefined} />
      <Field label="최근 수동처리"       value={`${metric.recentManualCount}건`}
             tone={metric.recentManualCount >= 3 ? 'warn' : undefined} />
      <Field label="최근 GPS 미수집"     value={`${metric.recentGpsMissingCount}건`}
             tone={metric.recentGpsMissingCount >= 2 ? 'warn' : undefined} />
      <Field label="누적 출역"           value={`${metric.totalAttendanceCount}건`} />
    </div>
  );
}

function PermissionsTab({
  assignments, siteName,
}: { assignments: ForemanSite[]; siteName: (id: string) => string }) {
  if (assignments.length === 0) {
    return <div className="fdp__empty">현장배정이 있어야 권한을 설정할 수 있습니다.</div>;
  }
  // 첫 활성 배정의 권한을 기준으로 노출
  const active = assignments.filter((a) => a.status !== 'TERMINATED');
  return (
    <div className="fdp__perm">
      {active.map((a) => {
        const preset = a.permissionPreset;
        const flags = a.permissions ?? presetToPermissions(preset);
        return (
          <div key={a.id} className="fdp__perm-block">
            <div className="fdp__perm-head">
              <strong>{siteName(a.siteId)}</strong>
              <span className="fr-dot">·</span>
              <span>{a.role}</span>
              <span className="fdp__perm-preset">프리셋: {permissionPresetLabel(preset)}</span>
            </div>
            <ul className="fdp__perm-list">
              <PermItem label="팀원 등록"           on={!!flags.memberRegister} />
              <PermItem label="얼굴등록 요청"       on={!!flags.faceRegisterRequest} />
              <PermItem label="출근처리"            on={!!flags.attendanceConfirm} />
              <PermItem label="수동공수 요청"       on={!!flags.manualGongsuRequest} />
              <PermItem label="안전공지 발송"       on={!!flags.safetyNoticeSend} />
              <PermItem label="팀원 정보 수정"      on={!!flags.memberInfoEdit} />
              <PermItem label="노임 결재"            on={!!flags.payApproval} />
              <PermItem label="서류 발행"            on={!!flags.documentIssue} />
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function PermItem({ label, on }: { label: string; on: boolean }) {
  return (
    <li className={'fdp__perm-item' + (on ? ' fdp__perm-item--on' : '')}>
      <span className="fdp__perm-dot" aria-hidden>{on ? '✓' : '×'}</span>
      <span className="fdp__perm-label">{label}</span>
    </li>
  );
}

function Field({
  label, value, mono, tone,
}: { label: string; value: React.ReactNode; mono?: boolean; tone?: 'warn' }) {
  return (
    <div className={'fdp__field' + (tone === 'warn' ? ' fdp__field--warn' : '')}>
      <div className="fdp__field-label">{label}</div>
      <div className={'fdp__field-value' + (mono ? ' fdp__field-value--mono' : '')}>{value}</div>
    </div>
  );
}

function permissionPresetLabel(p: ForemanPermissionPreset): string {
  switch (p) {
    case 'FULL':     return '일반 반장 (FULL)';
    case 'STANDARD': return '보조 반장 (STANDARD)';
    case 'LIMITED':  return '임시 반장 (LIMITED)';
    case 'CUSTOM':   return '직접 설정 (CUSTOM)';
  }
}

function presetToPermissions(p: ForemanPermissionPreset): ForemanPermissions {
  switch (p) {
    case 'FULL':
      return {
        memberRegister: true, faceRegisterRequest: true, attendanceConfirm: true,
        manualGongsuRequest: true, safetyNoticeSend: true, memberInfoEdit: true,
        payApproval: true, documentIssue: true,
      };
    case 'STANDARD':
      return {
        memberRegister: true, faceRegisterRequest: true, attendanceConfirm: true,
        manualGongsuRequest: true, safetyNoticeSend: false, memberInfoEdit: true,
        payApproval: false, documentIssue: false,
      };
    case 'LIMITED':
      return {
        memberRegister: false, faceRegisterRequest: false, attendanceConfirm: true,
        manualGongsuRequest: false, safetyNoticeSend: false, memberInfoEdit: false,
        payApproval: false, documentIssue: false,
      };
    case 'CUSTOM':
      return {};
  }
}

// ─────────────────────────────────────────────────────────────────────
// 현장배정 다이얼로그 — ForemanSite 신규/수정
// ─────────────────────────────────────────────────────────────────────

const ASSIGN_DEFAULT_HEADCOUNT = 5;
const ASSIGN_DEFAULT_DAILY_WAGE = 280_000;

function todayIso(): string { return localDateStr(); }
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

const SPECIAL_TERMS = [
  '숙소 지원', '식대 지원', '교통비 지원', '장비 지참',
  '경력자 우대', '외국인 가능', '기타',
] as const;
type SpecialTerm = typeof SPECIAL_TERMS[number];

/** note 문자열에서 「[특약: ...]」 prefix 분리 — 다이얼로그 초기값 복원용 */
function parseTerms(note?: string): { terms: Set<SpecialTerm>; rest: string } {
  const empty = { terms: new Set<SpecialTerm>(), rest: '' };
  if (!note) return empty;
  const m = note.match(/^\[특약:\s*([^\]]+)\]\s*\n?\n?/);
  if (!m) return { terms: new Set(), rest: note };
  const arr = m[1].split(',').map((s) => s.trim()).filter(
    (s): s is SpecialTerm => (SPECIAL_TERMS as readonly string[]).includes(s),
  );
  return { terms: new Set<SpecialTerm>(arr), rest: note.slice(m[0].length).trim() };
}

function SiteAssignmentDialog({
  foreman, sites, existing, defaultSiteId, onClose, onSent,
}: {
  foreman: Foreman;
  sites: Site[];
  existing?: ForemanSite;
  defaultSiteId?: string;
  onClose: () => void;
  onSent: (a: ForemanSite) => void;
}) {
  const [siteId, setSiteId] = useState<string>(existing?.siteId ?? defaultSiteId ?? sites[0]?.id ?? '');
  const [companyId, setCompanyId] = useState<string>(existing?.companyId ?? foreman.defaultCompanyId ?? '');
  const [trade, setTrade] = useState<string>(existing?.trade ?? foreman.role ?? '기타');
  const [siteRole, setSiteRole] = useState<ForemanSiteRole>(existing?.role ?? '주반장');
  const [preset, setPreset] = useState<ForemanPermissionPreset>(existing?.permissionPreset ?? 'STANDARD');
  const [startDate, setStartDate] = useState<string>(existing?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState<string>(existing?.endDate ?? addDaysIso(todayIso(), 30));
  const [dailyWage, setDailyWage] = useState<number>(existing?.dailyWage ?? ASSIGN_DEFAULT_DAILY_WAGE);
  const [headcount, setHeadcount] = useState<number>(existing?.headcount ?? ASSIGN_DEFAULT_HEADCOUNT);
  const [isPrimary, setIsPrimary] = useState<boolean>(existing?.isPrimary ?? true);
  // 특약사항 + 비고 — note 필드를 prefix 「[특약: A, B]」 + cleanNote 로 분리 저장
  const initialParsed = parseTerms(existing?.note);
  const [terms, setTerms] = useState<Set<SpecialTerm>>(initialParsed.terms);
  const [note, setNote] = useState<string>(initialParsed.rest);
  function toggleTerm(t: SpecialTerm) {
    setTerms((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
        // 「기타」 가 해제되면 자유 입력 비고도 함께 비운다 — 의도치 않은 잔여 데이터 발송 방지
        if (t === '기타') setNote('');
      } else {
        next.add(t);
      }
      return next;
    });
  }
  function buildFinalNote(): string | undefined {
    const prefix = terms.size > 0 ? '[특약: ' + [...terms].join(', ') + ']\n\n' : '';
    const merged = (prefix + note.trim()).trim();
    return merged || undefined;
  }
  // 발송 채널 — 반장 앱 푸시 / SMS / 둘 다.
  // 기본값: 반장이 가입(앱 로그인)을 마쳤으면 「APP」, 아니면 「SMS」
  type NotifyMode = 'APP' | 'SMS' | 'BOTH';
  const [notifyMode, setNotifyMode] = useState<NotifyMode>(foreman.registered ? 'APP' : 'SMS');
  const [submitting, setSubmitting] = useState(false);

  const selectedSite = useMemo(() => sites.find((s) => s.id === siteId), [sites, siteId]);

  // 같은 현장에 참여한 회사 후보 (SiteCompany 풀 — 시연 모드에선 회사 없을 수 있음)
  // 회사 셀렉트는 시연용으로 freeform.
  const dateError =
    !startDate || !endDate
      ? '시작일·종료일을 모두 선택하세요.'
      : new Date(endDate) < new Date(startDate)
        ? '종료일이 시작일보다 빠릅니다.'
        : null;
  const canSend = !!selectedSite && !dateError && trade.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || !selectedSite) return;
    setSubmitting(true);
    try {
      let saved: ForemanSite;
      if (existing) {
        const r = await siteApi.updateForemanSite(existing.id, {
          siteId, companyId, trade, role: siteRole, permissionPreset: preset,
          startDate, endDate, dailyWage, headcount, isPrimary, note: buildFinalNote(),
          status: 'PENDING',
        });
        saved = r.foremanSite;
      } else {
        const r = await siteApi.createForemanSite({
          foremanId: foreman.id,
          siteId, companyId, trade, role: siteRole, permissionPreset: preset,
          startDate, endDate, dailyWage, headcount, isPrimary, note: buildFinalNote(),
        });
        saved = r.foremanSite;
      }
      const channelLabel =
        notifyMode === 'APP' ? '반장 앱 푸시'
        : notifyMode === 'SMS' ? 'SMS'
        : '반장 앱 + SMS';
      window.alert(
        `${foreman.name} 반장에게 계약서가 발송되었습니다.\n\n` +
          `· 발송 채널: ${channelLabel}\n` +
          `· 현장: ${selectedSite.name}\n` +
          `· 역할: ${siteRole} (${permissionPresetLabel(preset)})\n` +
          `· 기간: ${startDate} ~ ${endDate}\n` +
          (dailyWage ? `· 일당: ${dailyWage.toLocaleString('ko-KR')}원\n` : '') +
          (headcount ? `· 필요 인원: ${headcount}명\n` : '') +
          `\n반장이 ${notifyMode === 'SMS' ? 'SMS 링크에서' : '앱에서'} 승인하면 「승인완료」 로 표시됩니다.`,
      );
      onSent(saved);
    } catch (err) {
      window.alert('배정 실패: ' + getErrorMessage(err, '서버 오류'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${foreman.name} 반장 — 현장배정 계약서`}
      subtitle={existing ? '내용을 수정하면 새로 승인이 필요합니다.' : '아래 내용으로 반장 스마트폰에 계약서가 발송됩니다.'}
      width={680}
    >
      <div className="fa-dialog">
        <div className="fa-dialog__grid">
          <label className="fa-dialog__field fa-dialog__field--full">
            <span className="fa-dialog__label">현장 <em className="fa-dialog__req">*</em></span>
            <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              className="fa-dialog__input"
              options={[...sites.map((s) => ({ value: s.id, label: s.name }))]}
            />
            {selectedSite && <span className="fa-dialog__hint">{selectedSite.address}</span>}
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">소속 회사</span>
            <input className="fa-dialog__input" placeholder="비워두면 현장 정보로 자동 추론"
              value={companyId} onChange={(e) => setCompanyId(e.target.value)} />
            <span className="fa-dialog__hint">선택 — 미입력 시 반장 기본 회사 또는 현장 owner 회사로 자동 설정됩니다.</span>
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">담당 공종 <em className="fa-dialog__req">*</em></span>
            <input className="fa-dialog__input" placeholder="형틀 / 철근 / 전기 …"
              value={trade} onChange={(e) => setTrade(e.target.value)} />
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">역할 <em className="fa-dialog__req">*</em></span>
            <MacSelect
              value={siteRole}
              onChange={(v) => setSiteRole(v as ForemanSiteRole)}
              className="fa-dialog__input"
              options={[{ value: "주반장", label: '주반장' }, { value: "보조반장", label: '보조반장' }, { value: "임시반장", label: '임시반장' }]}
            />
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">권한 프리셋</span>
            <MacSelect
              value={preset}
              onChange={(v) => setPreset(v as ForemanPermissionPreset)}
              className="fa-dialog__input"
              options={[{ value: "FULL", label: '일반 반장 (FULL)' }, { value: "STANDARD", label: '보조 반장 (STANDARD)' }, { value: "LIMITED", label: '임시 반장 (LIMITED)' }, { value: "CUSTOM", label: '직접 설정 (CUSTOM)' }]}
            />
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">시작일 <em className="fa-dialog__req">*</em></span>
            <MacDatePicker
              value={startDate}
              onChange={(v) => setStartDate(v)}
              className="fa-dialog__input"
            />
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">종료일 <em className="fa-dialog__req">*</em></span>
            <MacDatePicker
              value={endDate}
              onChange={(v) => setEndDate(v)}
              className="fa-dialog__input"
            />
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">필요 인원</span>
            <div className="fa-dialog__input-suffix">
              <NumberStepper min={0} step={1} className="fa-dialog__input"
                value={headcount} onChange={(next) => setHeadcount(next)} />
              <span className="fa-dialog__suffix">명</span>
            </div>
          </label>

          <label className="fa-dialog__field">
            <span className="fa-dialog__label">일당 (반장 본인)</span>
            <div className="fa-dialog__input-suffix">
              <NumberStepper min={0} step={1000} className="fa-dialog__input"
                value={dailyWage} onChange={(next) => setDailyWage(next)} />
              <span className="fa-dialog__suffix">원</span>
            </div>
          </label>

          {/* 발송 채널 — 반장 앱 / SMS / 둘 다 */}
          <div className="fa-dialog__field fa-dialog__field--full">
            <span className="fa-dialog__label">계약서 발송 채널 <em className="fa-dialog__req">*</em></span>
            <div className="fa-dialog__channel">
              <button
                type="button"
                className={'fa-dialog__channel-btn' + (notifyMode === 'APP' ? ' is-active' : '')}
                onClick={() => setNotifyMode('APP')}
                disabled={!foreman.registered}
                title={foreman.registered ? '' : '반장이 앱 가입을 완료해야 푸시 발송이 가능합니다.'}
              >
                <span className="fa-dialog__channel-icon" aria-hidden>📱</span>
                반장 앱 푸시
                {!foreman.registered && <span className="fa-dialog__channel-warn">앱 미가입</span>}
              </button>
              <button
                type="button"
                className={'fa-dialog__channel-btn' + (notifyMode === 'SMS' ? ' is-active' : '')}
                onClick={() => setNotifyMode('SMS')}
              >
                <span className="fa-dialog__channel-icon" aria-hidden>✉️</span>
                SMS
              </button>
              <button
                type="button"
                className={'fa-dialog__channel-btn' + (notifyMode === 'BOTH' ? ' is-active' : '')}
                onClick={() => setNotifyMode('BOTH')}
                disabled={!foreman.registered}
                title={foreman.registered ? '' : '앱 가입 후에 사용 가능'}
              >
                <span className="fa-dialog__channel-icon" aria-hidden>🔔</span>
                앱 + SMS
              </button>
            </div>
            <span className="fa-dialog__hint">
              {notifyMode === 'APP'
                ? '반장 앱 푸시 알림으로 계약서가 도착합니다.'
                : notifyMode === 'SMS'
                  ? `SMS 로 계약서 링크가 ${foreman.phone} 으로 발송됩니다.`
                  : '앱 푸시와 SMS 양쪽으로 발송 — 반장이 어느 쪽으로든 승인 가능.'}
            </span>
          </div>

          <label className="fa-dialog__field fa-dialog__field--full fa-dialog__field--inline">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            <span className="fa-dialog__label" style={{ marginLeft: 8 }}>이 현장을 「주 담당」으로 지정 (다른 현장의 주담당은 자동 해제)</span>
          </label>

          {/* 특약사항 — 7개 토글 칩. 발송 시 note 의 「[특약: A, B]」 prefix 로 직렬화 */}
          <div className="fa-dialog__field fa-dialog__field--full">
            <span className="fa-dialog__label">특약사항</span>
            <div className="fa-dialog__terms">
              {SPECIAL_TERMS.map((t) => {
                const on = terms.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={'fa-dialog__term-chip' + (on ? ' is-on' : '')}
                    onClick={() => toggleTerm(t)}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <span className="fa-dialog__hint">선택한 항목은 계약서 상단에 자동으로 명시됩니다.</span>
          </div>

          <label className={'fa-dialog__field fa-dialog__field--full' + (terms.has('기타') ? '' : ' is-disabled')}>
            <span className="fa-dialog__label">
              비고 (선택)
              {!terms.has('기타') && (
                <span className="fa-dialog__hint-inline"> · 「기타」 선택 시 활성화</span>
              )}
            </span>
            <textarea
              rows={2}
              className="fa-dialog__input"
              placeholder={terms.has('기타') ? '작업 상세, 출역 시간, 식대 포함 여부 등' : '「기타」 칩을 선택하면 입력할 수 있습니다.'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={!terms.has('기타')}
            />
          </label>
        </div>

        {dateError && <div className="fa-dialog__error">{dateError}</div>}

        <div className="fa-dialog__footer">
          <button type="button" className="foreman-settings__btn foreman-settings__btn--ghost" onClick={onClose} disabled={submitting}>
            취소
          </button>
          <button type="button" className="foreman-settings__btn foreman-settings__btn--primary"
            disabled={!canSend || submitting} onClick={handleSend}>
            {submitting ? '발송 중…' : existing ? '재발송' : '계약서 발송'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 작은 셀 컴포넌트들 (팀원 탭에서 사용)
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// 작은 셀 컴포넌트들 (팀원 탭에서 사용)
// ─────────────────────────────────────────────────────────────────────

function NationalityChip({ idType }: { idType: number }) {
  if (idType === 2) return <span className="fmd__chip fmd__chip--foreign">외국인 (외국인 등록증)</span>;
  if (idType === 3) return <span className="fmd__chip fmd__chip--foreign">외국인 (여권)</span>;
  return <span className="fmd__chip fmd__chip--korean">내국인</span>;
}

function InsurancePills({ insurance }: { insurance?: InsuranceFlags }) {
  const ins = insurance ?? { pension: false, health: false, employment: false, accident: false };
  const items: { key: keyof InsuranceFlags; short: string; full: string }[] = [
    { key: 'pension', short: '국', full: '국민연금' },
    { key: 'health', short: '건', full: '건강보험' },
    { key: 'employment', short: '고', full: '고용보험' },
    { key: 'accident', short: '산', full: '산재보험' },
  ];
  return (
    <span className="fmd__ins">
      {items.map((it) => (
        <span key={it.key} className={'fmd__ins-pill' + (ins[it.key] ? ' is-on' : '')}
          title={`${it.full} ${ins[it.key] ? '가입' : '미가입'}`}>
          {it.short}
        </span>
      ))}
    </span>
  );
}

function VerificationPills({ member }: { member: TeamMember }) {
  let h = 0;
  for (const c of member.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const faceOn = member.faceVerified === true;
  const idOn = !!member.idNumberMasked && member.idNumberMasked !== '-' && (h % 10 < 8);
  const bankOn = !!member.bankName && !!member.accountMasked && (h % 10 < 9);
  const items = [
    { key: 'face', short: '얼', full: '얼굴 인증', on: faceOn },
    { key: 'id',   short: '신', full: '신분증 인증', on: idOn },
    { key: 'bank', short: '통', full: '통장 인증', on: bankOn },
  ];
  return (
    <div className="fmd__verify-row">
      {items.map((it) => (
        <Tooltip key={it.key} text={`${it.full}: ${it.on ? '완료' : '미완료'}`} placement="top">
          <span className={'fmd__verify-chip' + (it.on ? ' is-on' : ' is-off')}>{it.short}</span>
        </Tooltip>
      ))}
    </div>
  );
}

/* 자격증 셀 — 직종에 따라 권장 자격증 정보 표시 (시연 stub) */
function CertificateCell({ role, memberId: _memberId }: { role: string; memberId: string }) {
  void _memberId;
  // 직종별 권장 자격증 매핑 (대표 예시)
  const certByRole: Record<string, string> = {
    '전기공': '전기기능사',
    '용접공': '용접기능사',
    '도장공': '도장기능사',
    '미장공': '미장기능사',
    '철근공': '철근기능사',
    '형틀공': '형틀목공',
    '콘크리트공': '거푸집기능사',
  };
  const cert = certByRole[role];
  if (!cert) return <span className="fmd__cert fmd__cert--none">—</span>;
  return <span className="fmd__cert fmd__cert--info">{cert}</span>;
}
