import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { SearchIcon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Tooltip } from '../components/Tooltip';
import { RoleSelect } from '../components/RoleSelect';
import { MacSelect } from '../components/MacSelect';
import { teamApi } from '../api/team';
import { siteApi } from '../api/site';
import type { InsuranceFlags, TeamMember } from '../api/team.types';
import type { Foreman, Site } from '../api/site.types';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { getAvatarUrl } from '../utils/avatar';
import { formatRRN, formatAccount } from '../utils/phone';
import { KOREAN_BANKS } from '../utils/banks';
import { makeWorkerCode, decideTrustTier, tierLabel } from '../utils/workerCode';
import './TeamListPage.css';
import { TeamRegisterPage } from './TeamRegisterPage';
import { TeamInvitePage } from './TeamInvitePage';
import { ForemanRegisterDialog } from '../components/ForemanRegisterDialog';

type MemberSortKey =
  | 'name'
  | 'role'
  | 'dailyWage'
  | 'phone'
  | 'site'
  | 'foreman'
  | 'joinedAt';

function sortMembers(
  rows: TeamMember[],
  key: MemberSortKey,
  dir: 'asc' | 'desc',
  foremen: Foreman[],
  sites: Site[],
): TeamMember[] {
  const sign = dir === 'asc' ? 1 : -1;
  const siteName = (id: string) =>
    sites.find((s) => s.id === id)?.name ?? '';
  const foremanName = (id?: string) =>
    foremen.find((f) => f.id === id)?.name ?? '';
  const get = (m: TeamMember): string | number => {
    switch (key) {
      case 'name': return m.name;
      case 'role': return m.role;
      case 'dailyWage': return m.dailyWage;
      case 'phone': return m.phone;
      case 'site': return siteName(m.siteId);
      case 'foreman': {
        // 현장담당자(소장) 직접 관리는 그룹 묶기 위해 「ㅎ현장담당자」로 정렬키 부여
        if (m.assignedToSiteManager || !m.foremanId) return 'ㅎ현장담당자';
        return foremanName(m.foremanId);
      }
      case 'joinedAt': return m.joinedAt;
    }
  };
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), 'ko') * sign;
  });
}

/**
 * 팀원 관리 — 반장 중심 + 행열 테이블 형태 + 수정/삭제
 *
 *  현장 선택 ▼  + 검색
 *
 *  [반장 리스트 — 카드 행]
 *   각 반장 카드 클릭 → 모달로 그 반장이 관리하는 팀원 표시
 *
 *  [전체 팀원 — 행열 테이블]
 *   #/이름/직종/일당/주민번호/계좌/현장/반장/등록방식/상태/관리(수정/삭제)
 */
export function TeamListPage() {
  const navigate = useNavigate();
  const { user, viewMode, assignedSiteId } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [foremen, setForemen] = useState<Foreman[]>([]);
  const [siteFilter, setSiteFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  /** 근로계약서 발송 팝업 — 대상 멤버 */
  const [contractSendFor, setContractSendFor] = useState<TeamMember | null>(null);
  /** 얼굴인증 요청 팝업 — 대상 멤버 */
  const [faceRequestFor, setFaceRequestFor] = useState<TeamMember | null>(null);
  const [excelOpen, setExcelOpen] = useState(false);
  /** 「+ 직접 등록」 팝업 — 페이지 이동 대신 모달로 표시 */
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [foremanRegOpen, setForemanRegOpen] = useState(false);
  /** 「온라인 등록 요청」 팝업 — 페이지 이동 대신 모달로 표시 */
  const [inviteOpen, setInviteOpen] = useState(false);
  /** 직종별 필터 — null = 전체, 그 외 = 그 직종만 */
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  /** 반장 필터 — 'ALL' = 전체, 그 외 = 그 반장 ID */
  const [foremanFilter, setForemanFilter] = useState<string>('ALL');
  /** 상태 필터 — ALL | WORKING(출근중) | AVAILABLE(출근가능, 미배정) | REVIEW(확인필요) | LEFT(이탈) */
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'WORKING' | 'AVAILABLE' | 'REVIEW' | 'LEFT' | 'PENDING' | 'PAYABLE'>('ALL');
  /** 행별 주민번호 일시 노출 — 클릭 시 토글 (Set 에 추가/제거). 새로고침 시 자동 마스킹 복귀 */
  const [revealedIdRows, setRevealedIdRows] = useState<Set<string>>(new Set());
  /** 인력관리 내부 탭 — 반장별 보기(기본) / 근로자 전체 */
  const [hrTab, setHrTab] = useState<'foreman' | 'workers'>('foreman');
  /** 검토 필요 모달 열기 */
  const [reviewOpen, setReviewOpen] = useState(false);
  /** 검토 모달 — 카테고리별 chip 필터 (기본: 첫 번째 has-value 항목, 없으면 전체) */
  const [reviewCatFilter, setReviewCatFilter] = useState<string | null>(null);
  /** 근로자 상세 패널 — 클릭한 행의 5섹션 정보 다이얼로그 */
  const [detailFor, setDetailFor] = useState<TeamMember | null>(null);
  /** 투입 인력 요청 다이얼로그 — 「출근 가능」 KPI 클릭 시 오픈 */
  const [recruitOpen, setRecruitOpen] = useState(false);
  /** 정렬 */
  const [sortKey, setSortKey] = useState<MemberSortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // SITE 모드는 자기 현장만 강제
      const effectiveSiteFilter =
        viewMode === 'SITE' && assignedSiteId ? assignedSiteId : siteFilter;
      const [m, s, f] = await Promise.all([
        teamApi.list(effectiveSiteFilter !== 'ALL' ? { siteId: effectiveSiteFilter } : {}),
        siteApi.listSites(),
        siteApi.listForemen(),
      ]);
      const visibleSites =
        viewMode === 'SITE' && assignedSiteId
          ? s.sites.filter((x) => x.id === assignedSiteId)
          : s.sites;
      const visibleForemen =
        viewMode === 'SITE' && assignedSiteId
          ? f.foremen.filter((x) => x.siteId === assignedSiteId)
          : f.foremen;
      setMembers(m.members);
      setSites(visibleSites);
      setForemen(visibleForemen);
    } catch (err) {
      setError(getErrorMessage(err, '팀원 목록 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [siteFilter, viewMode, assignedSiteId]);

  useEffect(() => {
    load();
  }, [load]);

  /** 사이트 필터에 맞는 반장 */
  const visibleForemen = useMemo(() => {
    if (siteFilter === 'ALL') return foremen;
    return foremen.filter((f) => f.siteId === siteFilter);
  }, [foremen, siteFilter]);

  /** 직종별 카운트 — { '형틀공': 3, '철근공': 4, ... } */
  const countByRole = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) {
      map.set(m.role, (map.get(m.role) ?? 0) + 1);
    }
    return map;
  }, [members]);

  /** 출근 가능 = 계약·얼굴 모두 OK + 재직 중 */
  function isReadyToWork(m: TeamMember) {
    return !m.leftAt && !!m.contractSigned && m.faceVerified !== false;
  }
  /** 신규 등록자 — joinedAt 이 최근 7일 이내 (NEW 배지) */
  function isRecentlyJoined(joinedAt?: string) {
    if (!joinedAt) return false;
    const t = Date.parse(joinedAt);
    if (Number.isNaN(t)) return false;
    return Date.now() - t < 7 * 24 * 60 * 60 * 1000;
  }
  /** 보험 정보 누락 — insurance 객체 자체 없음 또는 모든 항목 false */
  function hasInsuranceGap(m: TeamMember) {
    if (!m.insurance) return true;
    const { pension, health, employment, accident } = m.insurance;
    return !accident; // 산재만 의무 — 가장 약한 기준
  }

  /** ─── 인력관리 KPI 계산 ─── */
  // 분류 헬퍼 — 「확인 필요」 (필수서류 누락 1개 이상) / 「등록 대기」 (faceVerified === undefined) / 「정산 가능」 (T1 등급)
  function isReviewNeeded(m: TeamMember) {
    if (m.leftAt) return false;
    if (!m.contractSigned) return true;
    if (m.faceVerified === false) return true;
    if (m.safetyEduCompleted === false) return true;
    return false;
  }
  function isRegPending(m: TeamMember) {
    if (m.leftAt) return false;
    return m.faceVerified === undefined;
  }
  function isPayable(m: TeamMember) {
    if (m.leftAt) return false;
    return !!m.contractSigned && m.faceVerified === true && m.safetyEduCompleted !== false;
  }
  const kpis = useMemo(() => {
    const total = members.filter((m) => !m.leftAt).length;
    const working = members.filter((m) => isReadyToWork(m) && m.siteId).length;
    const available = members.filter((m) => isReadyToWork(m) && !m.siteId).length;
    const review = members.filter((m) => isReviewNeeded(m)).length;
    const pending = members.filter((m) => isRegPending(m)).length;
    const payable = members.filter((m) => isPayable(m)).length;
    const noFace = members.filter((m) => !m.leftAt && m.faceVerified === false).length;
    const noConsent = members.filter((m) => !m.leftAt && m.faceVerified === undefined).length;
    const noIns = members.filter((m) => !m.leftAt && hasInsuranceGap(m)).length;
    return { total, working, available, review, pending, payable, noFace, noConsent, noIns };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  /** ─── 처리 필요 카운트 (4종) ─── */
  const reviewCounts = useMemo(() => {
    const noContract = members.filter((m) => !m.leftAt && !m.contractSigned).length;
    // 동의 미완료 — faceVerified가 undefined 인 경우 (아직 동의서 미진행)
    const noConsent = members.filter((m) => !m.leftAt && m.faceVerified === undefined).length;
    const noFace = members.filter((m) => !m.leftAt && m.faceVerified === false).length;
    const noIns = members.filter((m) => !m.leftAt && hasInsuranceGap(m)).length;
    return { noContract, noConsent, noFace, noIns };
  }, [members]);

  /** 검색 + 직종 + 반장 + 상태 + 정렬 적용 팀원 */
  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = members.filter((m) => {
      if (roleFilter && m.role !== roleFilter) return false;
      if (foremanFilter !== 'ALL') {
        if (foremanFilter === 'DIRECT') {
          if (!(m.assignedToSiteManager || !m.foremanId)) return false;
        } else if (m.foremanId !== foremanFilter) {
          return false;
        }
      }
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'PENDING' && !isRegPending(m)) return false;
        if (statusFilter === 'PAYABLE' && !isPayable(m)) return false;
        // 출근중 = 재직 + 준비 완료 + 현장 배정
        if (statusFilter === 'WORKING' && !(isReadyToWork(m) && m.siteId)) return false;
        // 출근가능 = 재직 + 준비 완료 + 현장 미배정 (대기 풀)
        if (statusFilter === 'AVAILABLE' && !(isReadyToWork(m) && !m.siteId)) return false;
        if (statusFilter === 'REVIEW' && (m.leftAt || isReadyToWork(m))) return false;
        if (statusFilter === 'LEFT' && !m.leftAt) return false;
      }
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.phone.includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.idNumberMasked.includes(q)
      );
    });
    return sortMembers(list, sortKey, sortDir, foremen, sites);
  }, [members, search, roleFilter, foremanFilter, statusFilter, sortKey, sortDir, foremen, sites]);

  function toggleSort(key: MemberSortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  /** 반장 ID → 팀원 수 */
  const countByForeman = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) {
      if (m.foremanId) map.set(m.foremanId, (map.get(m.foremanId) ?? 0) + 1);
    }
    return map;
  }, [members]);
  /** 반장별 상세 통계 — 팀원 / 출근중 / 출근가능 / 확인필요 */
  const statsByForeman = useMemo(() => {
    const map = new Map<string, { total: number; working: number; available: number; check: number }>();
    for (const m of members) {
      if (!m.foremanId) continue;
      const s = map.get(m.foremanId) ?? { total: 0, working: 0, available: 0, check: 0 };
      s.total += 1;
      if (isReadyToWork(m)) {
        if (m.siteId) s.working += 1;
        else s.available += 1;
      }
      // 확인필요 — 필수서류(계약/얼굴/안전) 중 하나라도 누락
      const needCheck = !m.contractSigned
                     || m.faceVerified === false
                     || m.safetyEduCompleted === false;
      if (needCheck) s.check += 1;
      map.set(m.foremanId, s);
    }
    return map;
  }, [members]);

  function siteNameOf(siteId: string): string {
    return sites.find((s) => s.id === siteId)?.name ?? '-';
  }
  function foremanNameOf(foremanId?: string): string {
    if (!foremanId) return '미배정';
    return foremen.find((f) => f.id === foremanId)?.name ?? '미배정';
  }

  async function handleDelete(m: TeamMember) {
    const ok = window.confirm(
      `[${m.name}] 팀원을 삭제하시겠습니까?\n\n출퇴근/임금 등 이미 기록된 데이터는 그대로 남아있고, 명단에서만 제거됩니다.`,
    );
    if (!ok) return;
    try {
      await teamApi.remove(m.id);
      await load();
      // 모달 안에서 삭제했으면 모달 데이터도 갱신
    } catch (err) {
      window.alert(getErrorMessage(err, '삭제에 실패했습니다.'));
    }
  }

  return (
    <div className="team-list">
      <PageHeader
        title="인력관리"
        subtitle="반장이 관리하는 팀원 단위로 보고, 전체 팀원을 표 형태로 한눈에 확인합니다."
        actions={
          <div className="team-list__actions">
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={() => setInviteOpen(true)}
            >
              온라인 등록 요청
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={() => setExcelOpen(true)}
            >
              엑셀 일괄 등록
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={() =>
                downloadTeamReport(
                  user?.companyName ?? '회사',
                  members,
                  sites,
                  foremen,
                )
              }
              disabled={members.length === 0}
              title="현재 명단 기준 보고서 (직종별·ㄱㄴㄷ 정렬)"
            >
              ⬇ 명부 다운로드
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={() => setQuickAddOpen(true)}
            >
              + 직접 등록
            </button>
          </div>
        }
      />

      {error && <div className="team-list__error">{error}</div>}

      {/* ─── 인력관리 히어로 KPI (iOS 알림 카드 스타일) ─── */}
      <div className="team-hero">
        {([
          { key: 'ALL',       title: '전체',       count: kpis.total,     sub: '명 등록',         tone: 'plain'  },
          { key: 'WORKING',   title: '출근 중',     count: kpis.working,   sub: '명 활동',         tone: 'info'   },
          { key: 'AVAILABLE', title: '출근 가능',   count: kpis.available, sub: '명 대기',         tone: 'ok'     },
          { key: 'REVIEW',    title: '확인 필요',   count: kpis.review,    sub: '명 점검',         tone: 'danger' },
          { key: 'PENDING',   title: '등록 대기',   count: kpis.pending,   sub: '명 미처리',       tone: 'amber'  },
          { key: 'PAYABLE',   title: '정산 가능',   count: kpis.payable,   sub: '명 정산',         tone: 'ok'     },
        ] as const).map((it) => {
          const active = statusFilter === it.key;
          return (
            <button
              key={it.key}
              type="button"
              className={'team-hero__tile team-hero__tile--' + it.tone + (active ? ' is-active' : '')}
              onClick={() =>
                setStatusFilter((cur) =>
                  it.key === 'ALL' ? 'ALL' : (cur === it.key ? 'ALL' : it.key as typeof statusFilter)
                )
              }
              title={it.title + ' 근로자만 보기'}
            >
              <span className="team-hero__icon" aria-hidden>
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
              <span className="team-hero__body">
                <strong className="team-hero__title">{it.title}</strong>
                <span className="team-hero__sub">
                  <b>{it.count}</b>{it.sub}
                </span>
              </span>
              <span className="team-hero__time">{active ? '필터중' : '오늘'}</span>
            </button>
          );
        })}
      </div>

      {/* 「처리 필요」 인라인 섹션 제거 — 「확인필요」 KPI 클릭 시 동일 모달이 열림 */}

      {/* ─── 필터 (현장 / 반장 / 직종 / 상태 / 검색) ─── */}
      <section className="team-list__filters team-list__filters--flat">
        <div className="team-list__filter">
          <label>현장</label>
          <MacSelect
            value={siteFilter}
            onChange={(v) => setSiteFilter(v)}
            options={[
              { value: 'ALL', label: '전체 현장' },
              ...sites
                .filter((s) => s.status !== 'COMPLETED')
                .map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </div>
        <div className="team-list__filter">
          <label>반장</label>
          <MacSelect
            value={foremanFilter}
            onChange={(v) => setForemanFilter(v)}
            options={[
              { value: 'ALL', label: '전체 반장' },
              { value: 'DIRECT', label: '현장담당자 직접' },
              ...visibleForemen.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        </div>
        <div className="team-list__filter">
          <label>직종</label>
          <MacSelect
            value={roleFilter ?? 'ALL'}
            onChange={(v) => setRoleFilter(v === 'ALL' ? null : v)}
            options={[
              { value: 'ALL', label: '전체 직종' },
              ...Array.from(countByRole.keys())
                .sort((a, b) => a.localeCompare(b, 'ko'))
                .map((r) => ({
                  value: r,
                  label: r,
                  hint: countByRole.get(r) + '명',
                })),
            ]}
          />
        </div>
        <div className="team-list__filter">
          <label>상태</label>
          <MacSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: 'ALL', label: '전체' },
              { value: 'WORKING', label: '출근중' },
              { value: 'AVAILABLE', label: '출근가능' },
              { value: 'REVIEW', label: '확인필요' },
              { value: 'LEFT', label: '이탈' },
            ]}
          />
        </div>
        <div className="team-list__search">
          <SearchIcon size={16} />
          <input
            placeholder="이름·전화·직종·주민번호 마스킹 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="team-list__counts">
          <span>
            팀원 <strong>{filteredMembers.length}</strong>명
          </span>
        </div>
      </section>

      {/* 「반장별 보기」 탭 전용 — 좌·우 분할 (좌 300px 반장 카드 + 우 근로자 테이블) */}
      {hrTab === 'foreman' && (
      <div className="team-split">
        {/* 좌측 — 반장별 압축 카드 */}
        <aside className="team-foremen-aside">
          <div className="team-foremen-aside__head">
            <h2 className="team-foremen-aside__title">반장별 팀원 ({visibleForemen.length}명)</h2>
            <div className="team-foremen-aside__sub">
              활동 {visibleForemen.filter((f) => f.registered).length} · 대기 {visibleForemen.filter((f) => !f.registered).length}
            </div>
          </div>
          {loading ? (
            <p className="team-list__loading">불러오는 중…</p>
          ) : visibleForemen.length === 0 ? (
            <div className="team-list__empty">
              <p>등록된 반장이 없습니다.</p>
              <p className="team-list__empty-sub">대시보드에서 "반장 등록"으로 추가하세요.</p>
            </div>
          ) : (
            <ul className="team-foremen-list">
              {visibleForemen.map((f) => {
                const stats = statsByForeman.get(f.id) ?? { total: 0, working: 0, available: 0, check: 0 };
                const isFiltered = foremanFilter === f.id;
                const tone = !f.registered ? 'warn' : 'ok';
                const stateLabel = !f.registered ? '대기' : '활동중';
                const siteName = siteNameOf(f.siteId);
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={'team-foreman-card team-foreman-card--' + tone + (isFiltered ? ' is-selected' : '')}
                      title={isFiltered ? '소속 근로자만 표시 중 — 클릭으로 해제' : '이 반장 소속만 보기'}
                      onClick={() => {
                        setForemanFilter((cur) => (cur === f.id ? 'ALL' : f.id));
                      }}
                    >
                      {/* 1행: 상태 뱃지 + 반장명 + 직종 */}
                      <div className="team-foreman-card__head">
                        <span className={'team-foreman-card__badge team-foreman-card__badge--' + tone}>{stateLabel}</span>
                        <strong className="team-foreman-card__name" title={`${f.name} 반장 · ${f.role ?? ''}`}>
                          {f.name} 반장{f.role ? ` · ${f.role}` : ''}
                        </strong>
                      </div>
                      {/* 2행: 현장명 — 카드 폭 초과 시 ellipsis (...) */}
                      <div className="team-foreman-card__site" title={siteName}>{siteName}</div>
                      {/* 3행: 팀원/출근중/확인필요 */}
                      <div className="team-foreman-card__line">
                        팀원 <strong>{stats.total}</strong>명·출근중 <strong>{stats.working}</strong>명·확인필요 <strong>{stats.check}</strong>명
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

      {/* 근로자 목록 — 신규 컬럼 구성 */}
      <section className="team-list__section">
        <header className="team-list__sec-head">
          <div className="team-list__head-row">
            <h2>
              근로자 목록 ({filteredMembers.length}명)
              {foremanFilter !== 'ALL' && foremanFilter !== 'DIRECT' && (() => {
                const f = foremen.find((x) => x.id === foremanFilter);
                if (!f) return null;
                return (
                  <span className="team-list__filter-badge">
                    <em>{f.name} 반장</em> 소속만
                    <button type="button"
                      className="team-list__filter-clear"
                      onClick={() => setForemanFilter('ALL')}
                      title="필터 해제">✕</button>
                  </span>
                );
              })()}
            </h2>
          </div>
        </header>
        {loading ? (
          <p className="team-list__loading">불러오는 중…</p>
        ) : filteredMembers.length === 0 ? (
          <div className="team-list__empty">
            <p>표시할 팀반장이 없습니다.</p>
            <div className="team-list__empty-actions">
              <button
                type="button"
                className="team-list__btn team-list__btn--primary"
                onClick={() => setForemanRegOpen(true)}
              >
                + 첫 반장 등록
              </button>
              <button
                type="button"
                className="team-list__btn team-list__btn--primary"
                onClick={() => setQuickAddOpen(true)}
              >
                + 첫 팀원 등록
              </button>
            </div>
          </div>
        ) : (
          <div className="card team-table-wrap">
            <table className="team-table team-table--workers">
              <thead>
                <tr>
                  <th className="team-table__num">#</th>
                  <SortHeader label="이름" col="name" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                  <th className="team-table__th-id">주민등록번호</th>
                  <SortHeader label="직종" col="role" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                  <SortHeader label="일당" col="dailyWage" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} numeric />
                  <th className="team-table__th-status">출근상태</th>
                  <th className="team-table__th-docs" title="계약·동의·얼굴인증·기초안전">필수서류</th>
                  <th className="team-table__th-ins" title="국민·건강·고용·산재보험 가입 여부">보험</th>
                  <th className="team-table__actions-col">관리</th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((m, i) => {
                  const ready = isReadyToWork(m);
                  const insGap = hasInsuranceGap(m);
                  return (
                    <tr
                      key={m.id}
                      className="team-table__row team-table__row--clickable"
                      onClick={() => setDetailFor(m)}
                      title="클릭 → 상세 정보 패널"
                    >
                      <td className="team-table__num">{i + 1}</td>
                      <td className="team-table__name">
                        {/* 이름 + Tier — 같은 줄, 모든 행 같은 위치에 정렬됨 (display: flex) */}
                        <div className="team-table__name-row">
                          <Tooltip text={`${m.name} · ${m.phone}`} placement="top">
                            <span className="team-table__name-cell">
                              <span className={'team-table__name-text' + (m.name.length > 4 ? ' team-table__name-text--marquee' : '')}>
                                <span className="team-table__name-inner">{m.name}</span>
                              </span>
                            </span>
                          </Tooltip>
                          {(() => {
                            const t = decideTrustTier(m);
                            const tl = tierLabel(t);
                            return (
                              <span className={`team-table__tier team-table__tier--${tl.tone}`} title={`${tl.label} · ${tl.sub}`}>
                                T{t}
                              </span>
                            );
                          })()}
                          {isRecentlyJoined(m.joinedAt) && (
                            <span className="team-table__new" title={`신규 등록 — ${m.joinedAt}`} aria-label="신규 등록">
                              N
                            </span>
                          )}
                          {/* 기초안전보건교육 미이수 ⚠ 아이콘 제거 — 「필수서류 → 안전」 컬럼과 중복 */}
                        </div>
                      </td>
                      {/* 주민등록번호 — 기본 마스킹, 눈 아이콘 클릭 시 임시 노출 */}
                      <td className="team-table__id-cell" onClick={(e) => e.stopPropagation()}>
                        <span className="team-table__id-mono">
                          {revealedIdRows.has(m.id) ? (m.idNumberRaw ?? m.idNumberMasked) : m.idNumberMasked}
                        </span>
                        <button
                          type="button"
                          className="team-table__id-eye"
                          title={revealedIdRows.has(m.id) ? '마스킹으로 되돌리기' : '주민번호 일시 노출 (감사 로그)'}
                          onClick={() => {
                            setRevealedIdRows((prev) => {
                              const next = new Set(prev);
                              if (next.has(m.id)) next.delete(m.id);
                              else next.add(m.id);
                              return next;
                            });
                          }}
                          aria-label="주민번호 보기/숨기기"
                        >
                          {revealedIdRows.has(m.id) ? '🙈' : '👁'}
                        </button>
                      </td>
                      <td className="team-table__role">{m.role}</td>
                      <td className="team-table__num team-table__num--strong">
                        {m.dailyWage.toLocaleString()}
                      </td>
                      <td>
                        {m.leftAt ? (
                          <span className="team-table__chip is-off" title={`이탈일 ${m.leftAt}`}>이탈</span>
                        ) : !ready ? (
                          <span className="team-table__chip is-pending">확인필요</span>
                        ) : m.siteId ? (
                          <span className="team-table__chip is-ok" title="현장 배정 — 출근 가능 상태">출근중</span>
                        ) : (
                          <span className="team-table__chip is-info" title="현장 미배정 — 배정 시 출근 가능">출근가능</span>
                        )}
                      </td>
                      <td className="team-table__docs" onClick={(e) => e.stopPropagation()}>
                        <DocStatusChip
                          ok={!!m.contractSigned}
                          label="계약"
                          okTitle={m.contractSignedAt ? `계약 체결 ${m.contractSignedAt}` : '계약 체결됨'}
                          pendingTitle="근로계약 미체결 — 클릭 → 알림톡 발송"
                          onPendingClick={() => setContractSendFor(m)}
                        />
                        <DocStatusChip
                          ok={m.faceVerified === true}
                          label="얼굴"
                          okTitle="얼굴인증 완료"
                          pendingTitle="얼굴인증 미완료 — 클릭 → 반장에게 요청"
                          onPendingClick={() => setFaceRequestFor(m)}
                        />
                        <DocStatusChip
                          ok={m.faceVerified !== undefined}
                          label="동의"
                          okTitle="개인정보 동의 완료"
                          pendingTitle="개인정보 동의 미완료"
                        />
                        <DocStatusChip
                          ok={m.safetyEduCompleted === true}
                          label="안전"
                          okTitle="기초안전보건교육 이수"
                          pendingTitle="기초안전보건교육 미이수"
                        />
                      </td>
                      <td className="team-table__ins">
                        {insGap ? (
                          <Tooltip text="보험 정보 누락 — 4대보험 자격 점검 필요" tone="warning">
                            <span className="team-table__chip is-pending">확인 필요</span>
                          </Tooltip>
                        ) : (
                          <InsuranceDots insurance={m.insurance} />
                        )}
                      </td>
                      <td className="team-table__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="team-table__btn team-table__btn--edit"
                          onClick={() => setDetailFor(m)}
                          title="상세 패널에서 정보 수정"
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          className="team-table__btn team-table__btn--del"
                          onClick={() => handleDelete(m)}
                        >
                          이탈
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </div>
      )}{/* /.team-split */}

      {/* 「근로자 전체」 탭 — 전체 근로자 표 (반장 분할 없이 전체 폭) */}
      {hrTab === 'workers' && (
        <section className="team-list__section team-list__section--full">
          <header className="team-list__sec-head">
            <div className="team-list__head-row">
              <h2>근로자 전체 ({members.filter((m) => !m.leftAt).length}명)</h2>
            </div>
          </header>
          <div className="team-list__empty-sub" style={{ padding: 16 }}>
            전체 근로자 검색·조회는 위 KPI 와 필터를 활용하세요. (반장별 보기 탭에서 모든 근로자 테이블을 동일하게 사용 — 이 탭은 좌측 반장 패널 없이 풀폭 노출)
          </div>
        </section>
      )}

      {/* ─── 처리 필요 모달 — Excel 스타일 표 + 행별 조치 ─── */}
      {reviewOpen && (() => {
        // 카테고리별 대상자 산출
        const reviewCategories: Array<{
          key: string; label: string; reason: string; action: string;
          rows: TeamMember[];
        }> = [
          {
            key: 'no-contract', label: '계약미체결', reason: '근로계약서 미서명',
            action: '계약서 재발송',
            rows: members.filter((m) => !m.leftAt && !m.contractSigned),
          },
          {
            key: 'no-consent', label: '동의미완료', reason: '개인정보·얼굴인증 동의 미완',
            action: '동의서 재발송',
            rows: members.filter((m) => !m.leftAt && m.faceVerified === undefined),
          },
          {
            key: 'no-face', label: '얼굴미인증', reason: '얼굴인증 미완료',
            action: '얼굴인증 요청',
            rows: members.filter((m) => !m.leftAt && m.faceVerified === false),
          },
          {
            key: 'no-ins', label: '보험확인', reason: '4대보험 자격취득 정보 누락',
            action: '정보 입력',
            rows: members.filter((m) => !m.leftAt && hasInsuranceGap(m)),
          },
        ];
        type ReviewItem = {
          catKey: string; catLabel: string; reason: string; action: string;
          member: TeamMember;
        };
        // 모든 카테고리 항목 (전체 합)
        const allItems: ReviewItem[] = [];
        for (const c of reviewCategories) {
          for (const m of c.rows) {
            allItems.push({ catKey: c.key, catLabel: c.label, reason: c.reason, action: c.action, member: m });
          }
        }
        // 모달 진입 시 첫 번째 has-value 카테고리 자동 선택 (없으면 null)
        const effectiveCat = reviewCatFilter
          ?? reviewCategories.find((c) => c.rows.length > 0)?.key
          ?? null;
        // 선택된 카테고리만 필터 (null = 전체)
        const reviewItems = effectiveCat
          ? allItems.filter((it) => it.catKey === effectiveCat)
          : allItems;
        const totalCount = reviewItems.length;
        function handleAction(it: ReviewItem) {
          if (it.catKey === 'no-contract') {
            setReviewOpen(false);
            setContractSendFor(it.member);
            return;
          }
          if (it.catKey === 'no-face') {
            setReviewOpen(false);
            setFaceRequestFor(it.member);
            return;
          }
          if (!window.confirm(`「${it.member.name}」 — ${it.action} 처리하시겠습니까?\n\n사유: ${it.reason}`)) return;
          window.alert(`✓ 「${it.member.name}」 ${it.action} 완료 (mock).`);
        }
        const activeCatLabel = reviewCategories.find((c) => c.key === effectiveCat)?.label;
        return (
          <Modal
            open={true}
            onClose={() => { setReviewOpen(false); setReviewCatFilter(null); }}
            title="처리 필요 세부 항목"
            subtitle={
              activeCatLabel
                ? `「${activeCatLabel}」 ${totalCount}명 · 상단 칩 클릭으로 항목 전환 · 우측 「조치」 버튼으로 처리`
                : `조치 필요 ${totalCount}명 · 상단 칩 클릭으로 카테고리 선택 · 우측 「조치」 버튼으로 처리`
            }
            width={880}
            footer={
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="button"
                  className="team-list__btn team-list__btn--ghost"
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
                  className="team-list__btn team-list__btn--ghost"
                  onClick={() => setReviewOpen(false)}
                >
                  닫기
                </button>
              </div>
            }
          >
            {/* 카테고리별 카운트 chip — 클릭 시 그 카테고리만 필터 */}
            <div className="team-review-modal__summary">
              {reviewCategories.map((c) => {
                const isActive = effectiveCat === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={
                      'team-review-modal__chip' +
                      (c.rows.length > 0 ? ' has-value' : '') +
                      (isActive ? ' is-active' : '')
                    }
                    onClick={() => setReviewCatFilter(isActive ? null : c.key)}
                    title={isActive ? '다시 클릭 → 전체 보기' : `${c.label} ${c.rows.length}명만 보기`}
                  >
                    <em>{c.label}</em>
                    <strong>{c.rows.length}</strong>
                  </button>
                );
              })}
            </div>

            {/* 상세 표 */}
            {reviewItems.length === 0 ? (
              <div className="team-review-modal__empty">
                {activeCatLabel
                  ? `✓ 「${activeCatLabel}」 항목이 없습니다.`
                  : '✓ 처리가 필요한 항목이 없습니다.'}
              </div>
            ) : (
              <div className="team-review-modal__scroll">
                <table className="team-review-modal__table">
                  <colgroup>
                    <col style={{ width: 32 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 80 }} />
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
                      <tr key={`${it.catKey}-${it.member.id}-${i}`}>
                        <td className="team-review-modal__num">{i + 1}</td>
                        <td>
                          <span className={'team-review-modal__cat team-review-modal__cat--' + it.catKey}>
                            {it.catLabel}
                          </span>
                        </td>
                        <td className="team-review-modal__name">{it.member.name}</td>
                        <td>{it.member.role}</td>
                        <td className="team-review-modal__reason">{it.reason}</td>
                        <td>
                          <button
                            type="button"
                            className="team-review-modal__btn"
                            onClick={() => handleAction(it)}
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
        );
      })()}

      {/* 반장 모달 — 제거됨. 카드 클릭 시 하단 「근로자 목록」 이 해당 반장 소속만 필터로 표시.   */}

      {/* 수정 모달 */}
      {editing && (
        <MemberEditDialog
          member={editing}
          sites={sites}
          foremen={foremen}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {/* 엑셀 업로드 모달 */}
      {excelOpen && (
        <ExcelImportDialog onClose={() => setExcelOpen(false)} />
      )}

      {/* 직접 등록 팝업 — 기존 TeamRegisterPage 를 모달 안에 임베드 */}
      {quickAddOpen && (
        <Modal
          open
          onClose={() => setQuickAddOpen(false)}
          title="근로자 직접 등록"
          subtitle="신분증·계좌·얼굴 사진까지 한 번에 등록합니다."
          width={1080}
        >
          <TeamRegisterPage
            embedded
            onClose={() => setQuickAddOpen(false)}
            onCreated={async () => {
              setQuickAddOpen(false);
              await load();
            }}
          />
        </Modal>
      )}

      {/* 온라인 등록 요청 팝업 — 기존 TeamInvitePage 를 모달 안에 임베드 */}
      {inviteOpen && (
        <Modal
          open
          onClose={() => setInviteOpen(false)}
          title="온라인 등록 요청"
          subtitle="이름·전화·직종만 입력하면 SMS 로 등록 링크가 발송됩니다."
          width={720}
        >
          <TeamInvitePage
            embedded
            onClose={() => setInviteOpen(false)}
            onSent={async () => {
              setInviteOpen(false);
              await load();
            }}
          />
        </Modal>
      )}

      {/* 근로계약서 발송 모달 */}
      {contractSendFor && (
        <ContractSendDialog
          member={contractSendFor}
          siteName={siteNameOf(contractSendFor.siteId)}
          onClose={() => setContractSendFor(null)}
          onSent={async () => {
            setContractSendFor(null);
            await load();
          }}
        />
      )}

      {/* 얼굴인증 요청 모달 */}
      {faceRequestFor && (
        <FaceVerifyRequestDialog
          member={faceRequestFor}
          foreman={foremen.find((f) => f.id === faceRequestFor.foremanId) ?? null}
          siteName={siteNameOf(faceRequestFor.siteId)}
          onClose={() => setFaceRequestFor(null)}
          onSent={() => setFaceRequestFor(null)}
        />
      )}

      {/* 투입 인력 요청 다이얼로그 — 출근가능 풀 + 반장에게 SMS */}
      {recruitOpen && (
        <RecruitmentRequestDialog
          availableMembers={members.filter((m) => isReadyToWork(m) && !m.siteId)}
          allMembers={members}
          foremen={foremen}
          sites={sites}
          onClose={() => setRecruitOpen(false)}
        />
      )}



      {/* 근로자 상세 패널 — 5섹션 (기본·현장·필수·민감·출역) — 인라인 편집 지원 */}
      {detailFor && (
        <MemberDetailDialog
          member={detailFor}
          siteName={siteNameOf(detailFor.siteId)}
          foremanLabel={
            detailFor.assignedToSiteManager
              ? '🛡 현장담당자 직접 관리'
              : detailFor.foremanId
                ? `반장 ${foremanNameOf(detailFor.foremanId)}`
                : '— 미배정 —'
          }
          foremanState={
            detailFor.assignedToSiteManager
              ? 'site_manager'
              : detailFor.foremanId
                ? 'foreman'
                : 'unassigned'
          }
          sites={sites}
          foremen={foremen}
          onClose={() => setDetailFor(null)}
          onSendContract={() => { setContractSendFor(detailFor); setDetailFor(null); }}
          onSendFace={() => { setFaceRequestFor(detailFor); setDetailFor(null); }}
          onAssignForeman={() => { setDetailFor(null); setInviteOpen(true); }}
          onSaved={async (updated) => {
            // 모달 유지 — 업데이트된 정보로 detailFor 갱신, 목록도 새로고침
            setDetailFor(updated);
            await load();
          }}
        />
      )}

      {/* 반장 등록 다이얼로그 */}
      {foremanRegOpen && (
        <ForemanRegisterDialog
          open={foremanRegOpen}
          onClose={() => setForemanRegOpen(false)}
          sites={sites}
          onCreated={async () => {
            setForemanRegOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/* ───────── 엑셀 업로드 다이얼로그 ───────── */

/**
 * 양식은 "근로자내역서" 통상 양식 기반.
 *  - ＊ 표시는 필수 컬럼
 *  - 첫 시트: 근로자 1행당 1명, 둘째 시트: 은행/국가/체류자격/퇴직직종 코드표
 */
const EXCEL_HEADER = [
  '＊근로자코드',
  '＊한글이름',
  '＊주민등록번호\n(외국인등록번호)',
  '＊단가',
  '우편번호',
  '주소',
  '＊연락처',
  '＊거래은행명',
  '＊계좌번호',
  '＊예금주',
  '＊외국인 여부',
  '＊영문이름',
  '여권번호',
  '국가명',
  '체류자격명',
  '＊공종코드',
  '공종명',
  '＊직종코드',
  '직종명',
  '퇴직직종코드',
  '퇴직직종명',
  '＊팀코드',
  '팀명',
  '외국인 체류자격에\n따른 고용공제여부',
];

const EXCEL_SAMPLE_ROW = [
  'M-001',
  '홍길동',
  '850923-1******',
  '250000',
  '22724',
  '인천 서구 보현동 134-1',
  '010-1111-2222',
  '국민은행',
  '301-123-456789',
  '홍길동',
  'N',
  '',
  '',
  '한국',
  '',
  '01',
  '건축',
  '030',
  '형틀공',
  '',
  '',
  'T-001',
  '김민수반',
  '',
];

async function downloadExcelTemplate() {
  // 1) /public/templates 에 정적 파일이 있으면 우선 다운로드
  try {
    const r = await fetch('/templates/근로자내역서_양식.xlsx');
    if (r.ok) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '근로자내역서_양식.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
  } catch {
    /* fallthrough → 클라이언트 생성 */
  }

  // 2) Fallback — SpreadsheetML(.xls) 형식의 XML 스프레드시트로 생성 (외부 라이브러리 불필요)
  const headerCells = EXCEL_HEADER.map((h) =>
    `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`,
  ).join('');
  const sampleCells = EXCEL_SAMPLE_ROW.map((v) =>
    `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`,
  ).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="hdr">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#FFF59D" ss:Pattern="Solid"/>
   <Alignment ss:WrapText="1" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="근로자내역서">
  <Table>
   <Row ss:AutoFitHeight="0" ss:Height="42">${headerCells}</Row>
   <Row>${sampleCells}</Row>
  </Table>
 </Worksheet>
 <Worksheet ss:Name="기초코드표">
  <Table>
   <Row><Cell ss:StyleID="hdr"><Data ss:Type="String">은행명</Data></Cell><Cell ss:StyleID="hdr"><Data ss:Type="String">은행코드</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">한국은행</Data></Cell><Cell><Data ss:Type="Number">1</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">국민은행</Data></Cell><Cell><Data ss:Type="Number">4</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">신한은행</Data></Cell><Cell><Data ss:Type="Number">12</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">우리은행</Data></Cell><Cell><Data ss:Type="Number">11</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">하나은행</Data></Cell><Cell><Data ss:Type="Number">15</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">농협은행</Data></Cell><Cell><Data ss:Type="Number">9</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">기업은행</Data></Cell><Cell><Data ss:Type="Number">3</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">카카오뱅크</Data></Cell><Cell><Data ss:Type="Number">90</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">토스뱅크</Data></Cell><Cell><Data ss:Type="Number">92</Data></Cell></Row>
  </Table>
 </Worksheet>
</Workbook>`;
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `근로자내역서_양식_${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;');
}

/* ───────── 보고서 다운로드 (출력인원) ───────── */

function downloadTeamReport(
  companyName: string,
  members: TeamMember[],
  sites: Site[],
  foremen: Foreman[],
) {
  if (members.length === 0) {
    window.alert('등록된 팀원이 없습니다.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '-';
  const foremanName = (id?: string) =>
    foremen.find((f) => f.id === id)?.name ?? '미배정';

  // 직종별 그룹핑 + ㄱㄴㄷ 정렬
  const byRole = new Map<string, TeamMember[]>();
  for (const m of members) {
    const list = byRole.get(m.role) ?? [];
    list.push(m);
    byRole.set(m.role, list);
  }
  const roles = Array.from(byRole.keys()).sort((a, b) => a.localeCompare(b, 'ko'));
  for (const r of roles) {
    byRole.get(r)!.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  const totalCount = members.length;

  /*
   * ── 한 페이지 레이아웃 ──
   * A4 가로 (landscape) + FitToPage 1×1
   * 컬럼 구성: 번호(3) / 이름(8) / 휴대폰(11) / 일당(8) / 현장(20) / 반장(8) / 입사일(9)
   *           = 67 글자폭 — A4 가로 인쇄 시 한 페이지에 들어가는 폭
   * 각 행 17px 컴팩트.
   */
  const COLS = 7;
  const COL_HEADERS = ['번호', '이름', '휴대폰', '일당(원)', '현장', '반장', '입사일'];

  function rowFromCells(cells: { v: string; type?: string; style?: string }[]): string {
    return '<Row ss:AutoFitHeight="0" ss:Height="17">' + cells.map((c) => {
      const styleAttr = c.style ? ` ss:StyleID="${c.style}"` : '';
      const t = c.type ?? 'String';
      return `<Cell${styleAttr}><Data ss:Type="${t}">${escapeXml(c.v)}</Data></Cell>`;
    }).join('') + '</Row>';
  }
  function rowMerged(text: string, span: number, styleId: string, height = 26): string {
    return `<Row ss:AutoFitHeight="0" ss:Height="${height}">` +
      `<Cell ss:MergeAcross="${span - 1}" ss:StyleID="${styleId}"><Data ss:Type="String">${escapeXml(text)}</Data></Cell>` +
      '</Row>';
  }

  const xmlRows: string[] = [];

  // ─ 제목 + 부제 ─
  xmlRows.push(rowMerged(`${companyName} 출력인원`, COLS, 'title', 32));
  xmlRows.push(rowMerged(`기준일 ${today}    ·    총 ${totalCount}명    ·    직종 ${roles.length}개`, COLS, 'subtitle', 18));

  // ─ 직종별 요약 박스 ─
  const summaryLine = roles
    .map((r) => `${r} ${byRole.get(r)!.length}명`)
    .join('   ·   ');
  xmlRows.push(rowMerged(summaryLine, COLS, 'summary', 24));

  // 빈 줄 (간격용)
  xmlRows.push('<Row ss:AutoFitHeight="0" ss:Height="6"/>');

  // ─ 통합 명단 표 헤더 ─
  xmlRows.push(rowFromCells(COL_HEADERS.map((h) => ({ v: h, style: 'th' }))));

  // ─ 직종별 명단 (그룹 헤더 + 행) ─
  for (const r of roles) {
    const list = byRole.get(r)!;
    xmlRows.push(rowMerged(`▶ ${r}   (${list.length}명)`, COLS, 'group', 20));
    list.forEach((m, i) => {
      const isAlt = i % 2 === 1;
      xmlRows.push(rowFromCells([
        { v: String(i + 1),                 style: isAlt ? 'tdAltC' : 'tdC' },
        { v: m.name,                        style: isAlt ? 'tdAltStrong' : 'tdStrong' },
        { v: m.phone,                       style: isAlt ? 'tdAltMono' : 'tdMono' },
        { v: m.dailyWage.toLocaleString(),  style: isAlt ? 'tdAltR' : 'tdR' },
        { v: siteName(m.siteId),            style: isAlt ? 'tdAlt' : 'td' },
        { v: foremanName(m.foremanId),      style: isAlt ? 'tdAlt' : 'td' },
        { v: m.joinedAt,                    style: isAlt ? 'tdAltC' : 'tdC' },
      ]));
    });
  }

  // ─ 합계 행 ─
  const totalWage = members.reduce((s, m) => s + m.dailyWage, 0);
  xmlRows.push(rowFromCells([
    { v: '합계',                         style: 'totalC' },
    { v: `${totalCount}명`,               style: 'totalC' },
    { v: '',                              style: 'total' },
    { v: totalWage.toLocaleString(),      style: 'totalR' },
    { v: '',                              style: 'total' },
    { v: '',                              style: 'total' },
    { v: '',                              style: 'total' },
  ]));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Font ss:FontName="맑은 고딕" ss:Size="9"/>
   <Alignment ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="title">
   <Font ss:FontName="맑은 고딕" ss:Size="20" ss:Bold="1" ss:Color="#0F766E"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#15A09F"/>
   </Borders>
  </Style>
  <Style ss:ID="subtitle">
   <Font ss:FontName="맑은 고딕" ss:Size="10" ss:Color="#6B7280"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="summary">
   <Font ss:FontName="맑은 고딕" ss:Size="10" ss:Bold="1" ss:Color="#0F766E"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Interior ss:Color="#ECFDF5" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#15A09F"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#15A09F"/>
    <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#15A09F"/>
    <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#15A09F"/>
   </Borders>
  </Style>
  <Style ss:ID="group">
   <Font ss:FontName="맑은 고딕" ss:Size="10" ss:Bold="1" ss:Color="#1F2937"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:Indent="1"/>
   <Interior ss:Color="#F3F4F6" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#9CA3AF"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#9CA3AF"/>
   </Borders>
  </Style>
  <Style ss:ID="th">
   <Font ss:FontName="맑은 고딕" ss:Size="9" ss:Bold="1" ss:Color="#1F2937"/>
   <Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#000000"/>
    <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1D5DB"/>
    <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1D5DB"/>
   </Borders>
  </Style>
  <Style ss:ID="td">
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
    <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
    <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
   </Borders>
  </Style>
  <Style ss:ID="tdAlt" ss:Parent="td">
   <Interior ss:Color="#F9FAFB" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="tdC" ss:Parent="td">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="tdAltC" ss:Parent="tdAlt">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="tdR" ss:Parent="td">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <NumberFormat ss:Format="#,##0"/>
  </Style>
  <Style ss:ID="tdAltR" ss:Parent="tdAlt">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <NumberFormat ss:Format="#,##0"/>
  </Style>
  <Style ss:ID="tdMono" ss:Parent="td">
   <Font ss:FontName="Consolas" ss:Size="9" ss:Color="#374151"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="tdAltMono" ss:Parent="tdAlt">
   <Font ss:FontName="Consolas" ss:Size="9" ss:Color="#374151"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="tdStrong" ss:Parent="td">
   <Font ss:FontName="맑은 고딕" ss:Size="9" ss:Bold="1" ss:Color="#111827"/>
  </Style>
  <Style ss:ID="tdAltStrong" ss:Parent="tdAlt">
   <Font ss:FontName="맑은 고딕" ss:Size="9" ss:Bold="1" ss:Color="#111827"/>
  </Style>
  <Style ss:ID="total">
   <Font ss:FontName="맑은 고딕" ss:Size="10" ss:Bold="1" ss:Color="#0F766E"/>
   <Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top"    ss:LineStyle="Double" ss:Weight="2" ss:Color="#0F766E"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0F766E"/>
    <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0F766E"/>
    <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0F766E"/>
   </Borders>
  </Style>
  <Style ss:ID="totalC" ss:Parent="total">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="totalR" ss:Parent="total">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <NumberFormat ss:Format="#,##0"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="출력인원">
  <Table>
   <Column ss:Width="32"/>
   <Column ss:Width="64"/>
   <Column ss:Width="84"/>
   <Column ss:Width="64"/>
   <Column ss:Width="180"/>
   <Column ss:Width="60"/>
   <Column ss:Width="68"/>
   ${xmlRows.join('\n   ')}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup>
    <Layout x:Orientation="Landscape" x:CenterHorizontal="1"/>
    <PageMargins x:Bottom="0.4" x:Left="0.4" x:Right="0.4" x:Top="0.4"/>
    <Header x:Margin="0.2"/>
    <Footer x:Margin="0.2"/>
   </PageSetup>
   <Print>
    <ValidPrinterInfo/>
    <PaperSizeIndex>9</PaperSizeIndex>
    <Scale>100</Scale>
    <FitWidth>1</FitWidth>
    <FitHeight>1</FitHeight>
    <HorizontalResolution>600</HorizontalResolution>
    <VerticalResolution>600</VerticalResolution>
   </Print>
   <FitToPage/>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${companyName}_출력인원_${today}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExcelImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  function handleParse() {
    if (!file) return;
    setParsing(true);
    setInfo(null);
    // 데모 — 실제로는 SheetJS / Papaparse 등으로 파싱 후 teamApi.register 반복 호출
    setTimeout(() => {
      setParsing(false);
      setInfo(
        `[데모] "${file.name}" 파일을 받았습니다. 실서버 연결 시 SheetJS로 파싱하여 행별로 자동 등록됩니다.`,
      );
    }, 700);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="엑셀로 팀원 일괄 등록"
      subtitle="근로자내역서 양식 (＊ 표시 = 필수, 첫 행은 헤더)"
      width={680}
      footer={
        <>
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={onClose}
          >
            닫기
          </button>
          <button
            type="button"
            className="team-list__btn team-list__btn--primary"
            onClick={handleParse}
            disabled={!file || parsing}
          >
            {parsing ? '처리 중…' : '업로드 시작'}
          </button>
        </>
      }
    >
      <div className="excel-imp">
        <ol className="excel-imp__steps">
              <li><strong>① 양식 다운로드</strong> — 아래 버튼을 눌러 빈 엑셀 양식을 받습니다.</li>
              <li><strong>② 정보 입력</strong> — 각 행에 한 명씩 정보를 입력합니다 (＊ 표시는 필수 입력).</li>
              <li><strong>③ 업로드 시작</strong> — 작성한 파일을 업로드해 일괄 등록합니다.</li>
            </ol>

        <div className="excel-imp__dl">
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={downloadExcelTemplate}
          >
            ⬇ 양식 다운로드 (.xlsx)
          </button>
          <span className="excel-imp__dl-note">
            우리 회사용으로 제작된 빈 양식. 다른 업체 정보는 포함되어 있지 않습니다.
          </span>
        </div>

        <div className="excel-imp__sample">
          <strong>양식 컬럼 (24개)</strong>
          <table>
            <thead>
              <tr>
                {EXCEL_HEADER.slice(0, 12).map((h) => (
                  <th key={h}>{h.replace(/\n/g, ' ')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {EXCEL_SAMPLE_ROW.slice(0, 12).map((v, i) => (
                  <td key={i}>{v || '—'}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                {EXCEL_HEADER.slice(12).map((h) => (
                  <th key={h}>{h.replace(/\n/g, ' ')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {EXCEL_SAMPLE_ROW.slice(12).map((v, i) => (
                  <td key={i}>{v || '—'}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <label className="excel-imp__file">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} hidden />
          <span className="excel-imp__file-btn">+ 업로드</span>
          {file && <span className="excel-imp__file-name">{file.name}</span>}
        </label>
        {info && <p className="excel-imp__info">{info}</p>}
      </div>
    </Modal>
  );
}

/* ───────── 투입 인력 요청 다이얼로그 (출근가능 풀 + SMS) ───────── */

function RecruitmentRequestDialog({
  availableMembers,
  allMembers,
  foremen,
  sites,
  onClose,
}: {
  availableMembers: TeamMember[];
  allMembers: TeamMember[];
  foremen: Foreman[];
  sites: Site[];
  onClose: () => void;
}) {
  const inProgressSites = sites.filter((s) => s.status !== 'COMPLETED');
  // 폼 state
  const [siteId, setSiteId] = useState<string>(inProgressSites[0]?.id ?? '');
  const [role, setRole] = useState<string>('철근공');
  const [wage, setWage] = useState<string>('250000');
  const today = new Date().toISOString().slice(0, 10);
  const oneMonthLater = (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(oneMonthLater);
  const [headcount, setHeadcount] = useState<string>('5');
  const [perks, setPerks] = useState({
    lodging: false,    // 숙소 지원
    meal: false,       // 식대 지원
    transit: false,    // 교통비 지원
    equipment: false,  // 장비 지참
    experienced: false,// 경력자 우대
    foreigner: false,  // 외국인 가능
    etc: false,
  });
  const [perksEtc, setPerksEtc] = useState<string>('');
  // 발송 대상 반장 (멀티 선택)
  const [selectedForemen, setSelectedForemen] = useState<Set<string>>(
    () => new Set(foremen.map((f) => f.id)),
  );
  const [sending, setSending] = useState(false);
  /** 발송 전 미리보기 팝업 — 텍스트 확인 후 전송 */
  const [previewOpen, setPreviewOpen] = useState(false);
  const { user } = useAuth();

  function toggleForeman(id: string) {
    setSelectedForemen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllForemen() {
    if (selectedForemen.size === foremen.length) {
      setSelectedForemen(new Set());
    } else {
      setSelectedForemen(new Set(foremen.map((f) => f.id)));
    }
  }

  const selectedSite = sites.find((s) => s.id === siteId);

  /** 발송 메시지 본문 생성 — 미리보기 / 실 발송에서 동일하게 사용 */
  function buildMessage(): string {
    const perkList: string[] = [];
    if (perks.lodging) perkList.push('숙소 지원');
    if (perks.meal) perkList.push('식대 지원');
    if (perks.transit) perkList.push('교통비 지원');
    if (perks.equipment) perkList.push('장비 지참');
    if (perks.experienced) perkList.push('경력자 우대');
    if (perks.foreigner) perkList.push('외국인 가능');
    if (perks.etc && perksEtc.trim()) perkList.push(perksEtc.trim());
    const wageNum = Number(wage.replace(/[^0-9]/g, ''));
    const requester = user?.name ?? user?.companyName ?? '아코마';
    // 등록 링크 — 추후 토큰·짧은 URL 로 교체
    const link = 'https://bodapass.app/recruit/...';
    return (
      `[보다패스 인력요청]\n` +
      `현장: ${selectedSite?.name ?? siteId}\n` +
      `직종: ${role}\n` +
      `인원: ${headcount}명\n` +
      `일당: ${wageNum.toLocaleString()}원\n` +
      `기간: ${startDate} ~ ${endDate}\n` +
      (perkList.length > 0 ? `조건: ${perkList.join(', ')}\n` : '') +
      `요청자: ${requester}\n` +
      `등록 링크: ${link}`
    );
  }

  /** 1단계 — 폼 검증 후 미리보기 팝업 오픈 */
  function handleOpenPreview() {
    if (!siteId) { window.alert('현장을 선택해주세요.'); return; }
    if (!role.trim()) { window.alert('직종을 입력해주세요.'); return; }
    if (selectedForemen.size === 0) { window.alert('발송 대상 반장을 한 명 이상 선택해주세요.'); return; }
    if (perks.etc && !perksEtc.trim()) { window.alert('「기타」 특약사항 내용을 입력해주세요.'); return; }
    setPreviewOpen(true);
  }

  /** 2단계 — 미리보기 후 실제 전송 */
  function handleConfirmSend() {
    setPreviewOpen(false);
    setSending(true);
    setTimeout(() => {
      window.alert(`✓ 반장 ${selectedForemen.size}명에게 인력요청 SMS 전송됐습니다 (mock).`);
      setSending(false);
      onClose();
    }, 400);
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="투입 인력 요청"
      subtitle={`출근가능 인력 ${availableMembers.length}명 · 등록 반장 ${foremen.length}명에게 SMS 발송`}
      width={680}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={onClose}
            disabled={sending}
          >
            취소
          </button>
          <button
            type="button"
            className="team-list__btn team-list__btn--primary"
            onClick={handleOpenPreview}
            disabled={sending || selectedForemen.size === 0}
          >
            {sending ? '요청 중…' : `반장 ${selectedForemen.size}명에게 요청`}
          </button>
        </div>
      }
    >
      <div className="recruit">
        {/* 현재 출근가능 풀 요약 */}
        <section className="recruit__pool">
          <h4 className="recruit__sec-h">출근가능 풀 ({availableMembers.length}명)</h4>
          {availableMembers.length === 0 ? (
            <p className="recruit__muted">현장 미배정 + 출근 준비된 인력이 없습니다. 반장에게 투입 인력 요청을 보내 새 인력을 받을 수 있습니다.</p>
          ) : (
            <ul className="recruit__pool-list">
              {availableMembers.slice(0, 8).map((m) => (
                <li key={m.id} className="recruit__pool-item">
                  <strong>{m.name}</strong>
                  <span className="recruit__pool-meta">{m.role} · {m.dailyWage.toLocaleString()}원</span>
                </li>
              ))}
              {availableMembers.length > 8 && (
                <li className="recruit__pool-more">외 {availableMembers.length - 8}명</li>
              )}
            </ul>
          )}
        </section>

        {/* 투입 인력 요청 폼 */}
        <section className="recruit__form">
          <h4 className="recruit__sec-h">요청 내용</h4>
          <div className="recruit__row">
            <label className="recruit__field">
              <span>현장 *</span>
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {inProgressSites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="recruit__field">
              <span>직종 *</span>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="예: 철근공, 형틀공"
              />
            </label>
          </div>
          <div className="recruit__row">
            <label className="recruit__field">
              <span>예상 일당 *</span>
              <input
                type="text"
                value={wage}
                onChange={(e) => setWage(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="250000"
              />
            </label>
            <label className="recruit__field">
              <span>필요 인원 *</span>
              <input
                type="text"
                value={headcount}
                onChange={(e) => setHeadcount(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="5"
              />
            </label>
          </div>
          <div className="recruit__row">
            <label className="recruit__field">
              <span>근무 시작 *</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className="recruit__field">
              <span>근무 종료</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>

          {/* 특약사항 */}
          <div className="recruit__perks">
            <span className="recruit__perks-label">특약사항</span>
            <div className="recruit__perks-chips">
              <label className={'recruit__perk' + (perks.lodging ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.lodging} onChange={(e) => setPerks((p) => ({ ...p, lodging: e.target.checked }))} />
                <span>숙소 지원</span>
              </label>
              <label className={'recruit__perk' + (perks.meal ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.meal} onChange={(e) => setPerks((p) => ({ ...p, meal: e.target.checked }))} />
                <span>식대 지원</span>
              </label>
              <label className={'recruit__perk' + (perks.transit ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.transit} onChange={(e) => setPerks((p) => ({ ...p, transit: e.target.checked }))} />
                <span>교통비 지원</span>
              </label>
              <label className={'recruit__perk' + (perks.equipment ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.equipment} onChange={(e) => setPerks((p) => ({ ...p, equipment: e.target.checked }))} />
                <span>장비 지참</span>
              </label>
              <label className={'recruit__perk' + (perks.experienced ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.experienced} onChange={(e) => setPerks((p) => ({ ...p, experienced: e.target.checked }))} />
                <span>경력자 우대</span>
              </label>
              <label className={'recruit__perk' + (perks.foreigner ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.foreigner} onChange={(e) => setPerks((p) => ({ ...p, foreigner: e.target.checked }))} />
                <span>외국인 가능</span>
              </label>
              <label className={'recruit__perk' + (perks.etc ? ' is-on' : '')}>
                <input type="checkbox" checked={perks.etc} onChange={(e) => setPerks((p) => ({ ...p, etc: e.target.checked }))} />
                <span>기타</span>
              </label>
            </div>
            {perks.etc && (
              <input
                type="text"
                className="recruit__perk-etc"
                value={perksEtc}
                onChange={(e) => setPerksEtc(e.target.value)}
                placeholder="기타 특약사항을 자유롭게 입력하세요 (예: 숙소 제공, 주말 수당 등)"
              />
            )}
          </div>
        </section>

        {/* 발송 대상 반장 */}
        <section className="recruit__recipients">
          <header className="recruit__sec-head">
            <h4 className="recruit__sec-h">발송 대상 반장 ({selectedForemen.size}/{foremen.length})</h4>
            <button
              type="button"
              className="recruit__select-all"
              onClick={toggleAllForemen}
            >
              {selectedForemen.size === foremen.length ? '전체 해제' : '전체 선택'}
            </button>
          </header>
          <ul className="recruit__recipients-list">
            {foremen.map((f) => {
              const teamCount = allMembers.filter((m) => m.foremanId === f.id).length;
              const checked = selectedForemen.has(f.id);
              return (
                <li key={f.id}>
                  <label className={'recruit__recipient' + (checked ? ' is-on' : '')}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleForeman(f.id)}
                    />
                    <span className="recruit__recipient-name">{f.name}</span>
                    <span className="recruit__recipient-meta">{f.phone} · 팀원 {teamCount}명</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {previewOpen && (
        <Modal
          open={true}
          onClose={() => setPreviewOpen(false)}
          title="문자 미리보기"
          subtitle={`반장 ${selectedForemen.size}명에게 아래 메시지가 SMS 로 전송됩니다`}
          width={460}
          footer={
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <button
                type="button"
                className="team-list__btn team-list__btn--ghost"
                onClick={() => setPreviewOpen(false)}
              >
                ← 수정
              </button>
              <button
                type="button"
                className="team-list__btn team-list__btn--primary"
                onClick={handleConfirmSend}
                disabled={sending}
              >
                {sending ? '전송 중…' : '전송'}
              </button>
            </div>
          }
        >
          <pre className="recruit__preview">{buildMessage()}</pre>
        </Modal>
      )}
    </Modal>
  );
}

/* ───────── 근로자 상세 패널 (5섹션) ───────── */

function MemberDetailDialog({
  member,
  siteName,
  foremanLabel,
  foremanState,
  sites,
  foremen,
  onClose,
  onSendContract,
  onSendFace,
  onAssignForeman,
  onSaved,
}: {
  member: TeamMember;
  siteName: string;
  foremanLabel: string;
  foremanState: 'foreman' | 'site_manager' | 'unassigned';
  sites: Site[];
  foremen: Foreman[];
  onClose: () => void;
  onSendContract: () => void;
  onSendFace: () => void;
  onAssignForeman: () => void;
  onSaved: (updated: TeamMember) => void | Promise<void>;
}) {
  const { user } = useAuth();
  const [showSensitive, setShowSensitive] = useState(false);
  /** 본 화면에서 발생한 열람 — 사용자가 닫기 전에 로그 확인 가능 */
  const [revealHistory, setRevealHistory] = useState<SensitiveAccessLog[]>([]);
  /** 열람 이력 (감사 로그) 보기 */
  const [logsOpen, setLogsOpen] = useState(false);
  /** 사진·서류 업로드 미리보기 (UI 전용 — 시연용) */
  const [docPreviews, setDocPreviews] = useState<{
    idCard?: string;
    bankBook?: string;
    alienCard?: string;
    passport?: string;
    safetyCert?: string;
  }>({});
  /** 인라인 편집 모드 — 정보 수정 버튼 클릭 시 토글 */
  const [editing, setEditing] = useState(false);
  const [editRole, setEditRole] = useState(member.role);
  const [editWage, setEditWage] = useState(String(member.dailyWage));
  const [editSiteId, setEditSiteId] = useState(member.siteId ?? '');
  const [editForemanId, setEditForemanId] = useState(member.foremanId ?? '');
  /** 민감정보 편집 — 주민번호, 은행, 계좌번호. 디폴트는 마스킹, 수정하면 modified=true 로 마킹 */
  const [editIdNumber, setEditIdNumber] = useState(member.idNumberMasked || '');
  const [editIdModified, setEditIdModified] = useState(false);
  const [editIdShow, setEditIdShow] = useState(false);
  const [editBankName, setEditBankName] = useState(member.bankName ?? '');
  const [editAcctNumber, setEditAcctNumber] = useState(member.accountMasked || '');
  const [editAcctModified, setEditAcctModified] = useState(false);
  const [editAcctShow, setEditAcctShow] = useState(false);
  /** 연락처 / 국적 / 4대보험 / 기초안전교육 — 정산 관련 필드 */
  const [editPhone, setEditPhone] = useState(member.phone ?? '');
  const [editIdType, setEditIdType] = useState<1 | 2 | 3>((member.idType as 1 | 2 | 3) ?? 1);
  const [editInsPension, setEditInsPension] = useState(!!member.insurance?.pension);
  const [editInsHealth, setEditInsHealth] = useState(!!member.insurance?.health);
  const [editInsEmployment, setEditInsEmployment] = useState(member.insurance?.employment !== false);
  const [editInsAccident, setEditInsAccident] = useState(member.insurance?.accident !== false);
  const [editSafetyEdu, setEditSafetyEdu] = useState(member.safetyEduCompleted === true);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const visibleEditForemen = foremen.filter((f) => f.siteId === editSiteId);
  function startEdit() {
    setEditRole(member.role);
    setEditWage(String(member.dailyWage));
    setEditSiteId(member.siteId ?? '');
    setEditForemanId(member.foremanId ?? '');
    setEditIdNumber(member.idNumberMasked || '');
    setEditIdModified(false);
    setEditIdShow(false);
    setEditBankName(member.bankName ?? '');
    setEditAcctNumber(member.accountMasked || '');
    setEditAcctModified(false);
    setEditAcctShow(false);
    setEditPhone(member.phone ?? '');
    setEditIdType((member.idType as 1 | 2 | 3) ?? 1);
    setEditInsPension(!!member.insurance?.pension);
    setEditInsHealth(!!member.insurance?.health);
    setEditInsEmployment(member.insurance?.employment !== false);
    setEditInsAccident(member.insurance?.accident !== false);
    setEditSafetyEdu(member.safetyEduCompleted === true);
    setEditError(null);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setEditError(null);
  }
  /** * 가 들어 있으면 사용자 입력이 아니라 마스킹된 값 그대로 — 서버 전송 안 함 */
  function isCleanInput(v: string): boolean {
    return !!v.trim() && !v.includes('*');
  }
  async function handleSaveEdit() {
    setEditError(null);
    const wage = Number((editWage || '').replace(/[^0-9]/g, ''));
    if (!editRole.trim()) { setEditError('직종을 입력해주세요.'); return; }
    if (!Number.isFinite(wage) || wage <= 0) { setEditError('일당을 올바르게 입력해주세요.'); return; }
    const bankChanged = editBankName !== (member.bankName ?? '');
    setEditSubmitting(true);
    try {
      const res = await teamApi.update(member.id, {
        role: editRole,
        dailyWage: wage,
        siteId: editSiteId || undefined,
        // __SITE_MANAGER__ 는 반장 ID 가 아닌 sentinel — assignToSiteManager 플래그로 분리 전달
        foremanId: editForemanId && editForemanId !== '__SITE_MANAGER__' ? editForemanId : undefined,
        assignToSiteManager: editForemanId === '__SITE_MANAGER__',
        phone: editPhone || undefined,
        idType: editIdType,
        insurance: {
          pension: editInsPension,
          health: editInsHealth,
          employment: editInsEmployment,
          accident: editInsAccident,
        },
        safetyEduCompleted: editSafetyEdu,
        ...(bankChanged ? { bankName: editBankName } : {}),
        ...(editAcctModified && isCleanInput(editAcctNumber) ? { accountNumber: editAcctNumber.trim() } : {}),
        ...(editIdModified && isCleanInput(editIdNumber) ? { idNumber: editIdNumber.trim() } : {}),
      });
      // 저장 성공 — 편집 모드 종료, 모달은 그대로 (읽기 모드로 전환)
      setEditing(false);
      await onSaved(res.member);
    } catch (err) {
      setEditError(getErrorMessage(err, '수정에 실패했습니다.'));
    } finally {
      setEditSubmitting(false);
    }
  }
  const ins = member.insurance;
  // 출역이력 mock — 실 운영시 attendanceApi 연동
  const attendanceMock = {
    lastDate: '—',
    monthGongsu: '—',
    manualCount: 0,
  };

  function regModeLabel(mode: string) {
    switch (mode) {
      case 'OFFLINE_QR':  return '오프라인 등록 (QR)';
      case 'ONLINE_SMS':  return '온라인 등록 (SMS)';
      case 'EXCEL_BULK':  return '엑셀 일괄 등록';
      default:            return mode || '—';
    }
  }
  function nationalityLabel(idType: number | string) {
    // IdType: 1 = 주민등록번호(내국인) / 2 = 외국인등록증 / 3 = 여권
    if (idType === 3 || idType === 'PASSPORT') return '외국인 (여권)';
    if (idType === 2 || idType === 'ALIEN')    return '외국인 (외국인등록증)';
    return '내국인 (주민등록번호)';
  }
  /** 신뢰등급 사유 — decideTrustTier 와 동일 기준 (얼굴 · 신분증 · 본인 명의 통장) */
  function tierReasons(): { ok: string[]; missing: string[] } {
    const ok: string[] = [];
    const missing: string[] = [];
    // 1) 얼굴 인증
    if (member.faceVerified === true) ok.push('얼굴인증');
    else missing.push('얼굴인증');
    // 2) 신분증
    const hasId = !!member.idNumberMasked && member.idNumberMasked !== '-' && member.idNumberMasked.length > 0;
    if (hasId) ok.push('신분증');
    else missing.push('신분증');
    // 3) 본인 명의 통장 — decideTrustTier 와 동일한 해시 로직
    let h = 0;
    for (const c of member.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const hasOwnBank = !!member.accountMasked && h % 10 < 8;
    if (hasOwnBank) ok.push('본인 명의 통장');
    else if (member.accountMasked) missing.push('본인 명의 통장 (현재 가족·반장 명의)');
    else missing.push('통장사본');
    return { ok, missing };
  }
  const _tierT = decideTrustTier(member);
  const _tierTl = tierLabel(_tierT);
  const _tierR = tierReasons();
  // 타이틀: 이름(볼드) + 직종(일반) + T-tier 배지 모두 한 줄에 정렬
  const titleNode = (
    <span className="member-detail__title-row">
      <span className="member-detail__title-name">
        <strong>{member.name}</strong>
        {member.role ? <span className="member-detail__title-role">({member.role})</span> : null}
      </span>
      <span
        className={`team-table__tier team-table__tier--${_tierTl.tone} member-detail__title-tier`}
        title={
          `T${_tierT} · ${_tierTl.label}\n` +
          (_tierR.ok.length ? `✓ 충족: ${_tierR.ok.join(', ')}\n` : '') +
          (_tierR.missing.length ? `! 부족: ${_tierR.missing.join(', ')}` : '')
        }
      >
        T{_tierT} · {_tierTl.label}
        {_tierR.missing.length > 0 && (
          <span style={{ marginLeft: 4, fontSize: 9.5, fontWeight: 500, opacity: 0.85 }}>
            (부족: {_tierR.missing.join('·')})
          </span>
        )}
      </span>
    </span>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={titleNode}
      width={620}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8, flexWrap: 'wrap' }}>
          {editing && editError && (
            <span style={{ color: '#b91c1c', fontSize: 12, alignSelf: 'center' }}>{editError}</span>
          )}
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={editing ? cancelEdit : onClose}
            disabled={editSubmitting}
          >
            {editing ? '취소' : '닫기'}
          </button>
          {editing ? (
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={handleSaveEdit}
              disabled={editSubmitting}
            >
              {editSubmitting ? '저장 중…' : '저장'}
            </button>
          ) : (
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={startEdit}
            >
              ✎ 정보 수정
            </button>
          )}
        </div>
      }
    >
      <div className="member-detail">
        {/* 1. 기본정보 — 좌측 얼굴 사진 + 우측 정보 */}
        <section className="member-detail__sec">
          <h4 className="member-detail__sec-h">기본정보</h4>
          <div className="member-detail__basic">
            <div className="member-detail__photo">
              {member.facePhotoUrl ? (
                <img src={member.facePhotoUrl} alt={`${member.name} 얼굴 사진`} />
              ) : (
                <div className="member-detail__photo-empty" aria-label="사진 없음">
                  <span>{member.name?.slice(0, 1) ?? '?'}</span>
                </div>
              )}
            </div>
          <dl className="member-detail__rows">
            <div><dt>이름</dt><dd>{member.name}</dd></div>
            <div>
              <dt>워커 코드</dt>
              <dd>
                <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', background: '#f3f4f6', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>
                  {makeWorkerCode(member)}
                </code>
              </dd>
            </div>
            <div>
              <dt>연락처</dt>
              <dd>
                {editing ? (
                  <input
                    type="text"
                    inputMode="tel"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="010-1234-5678"
                    className="member-detail__input"
                  />
                ) : (
                  member.phone || '—'
                )}
              </dd>
            </div>
            <div>
              <dt>직종</dt>
              <dd>
                {editing ? (
                  <RoleSelect
                    value={editRole}
                    onChange={(v) => setEditRole(v)}
                    placeholder="직종 선택"
                  />
                ) : member.role}
              </dd>
            </div>
            <div>
              <dt>일당</dt>
              <dd>
                {editing ? (
                  <input
                    inputMode="numeric"
                    value={editWage ? Number(editWage.replace(/[^0-9]/g, '')).toLocaleString() : ''}
                    onChange={(e) => setEditWage(e.target.value.replace(/[^0-9]/g, ''))}
                    className="member-detail__input"
                    placeholder="예) 250,000"
                  />
                ) : (
                  `${member.dailyWage.toLocaleString()}원`
                )}
              </dd>
            </div>
            <div>
              <dt>국적</dt>
              <dd>
                {editing ? (
                  <select
                    value={editIdType}
                    onChange={(e) => setEditIdType(Number(e.target.value) as 1 | 2 | 3)}
                    className="member-detail__input"
                  >
                    <option value={1}>내국인 (주민등록번호)</option>
                    <option value={2}>외국인 (외국인등록증)</option>
                    <option value={3}>외국인 (여권)</option>
                  </select>
                ) : (
                  nationalityLabel(member.idType)
                )}
              </dd>
            </div>
          </dl>
          </div>
        </section>

        {/* 2. 필수상태 — 4종 인증을 1줄에 + 4대보험은 별도 행 */}
        <section className="member-detail__sec">
          <h4 className="member-detail__sec-h">필수 상태</h4>
          {/* 얼굴인증 / 신분증 / 통장사본 / 기초안전보건교육 — 한 줄에 4컬럼 */}
          <div className="member-detail__verify-row">
            <div className="member-detail__verify-item">
              <span className="member-detail__verify-label">얼굴 인증</span>
              {member.faceVerified === true ? (
                <span className="member-detail__chip is-ok">✓ 인증 완료</span>
              ) : (
                <button type="button" className="member-detail__chip is-pending member-detail__chip--btn" onClick={onSendFace}>
                  ! 미인증
                </button>
              )}
            </div>
            <div className="member-detail__verify-item">
              <span className="member-detail__verify-label">신분증</span>
              {(docPreviews.idCard || (member.idNumberMasked && member.idNumberMasked !== '-')) ? (
                <span className="member-detail__chip is-ok">✓ 등록 완료</span>
              ) : (
                <span className="member-detail__chip is-pending">! 미등록</span>
              )}
            </div>
            <div className="member-detail__verify-item">
              <span className="member-detail__verify-label">통장사본</span>
              {(docPreviews.bankBook || member.accountMasked) ? (
                <span className="member-detail__chip is-ok">✓ 등록 완료</span>
              ) : (
                <span className="member-detail__chip is-pending">! 미등록</span>
              )}
            </div>
            <div className="member-detail__verify-item">
              <span className="member-detail__verify-label">기초안전보건교육</span>
              {editing ? (
                <button
                  type="button"
                  className={'member-detail__toggle' + (editSafetyEdu ? ' is-on' : '')}
                  onClick={() => setEditSafetyEdu((v) => !v)}
                  aria-pressed={editSafetyEdu}
                  title="기초안전보건교육 이수 여부"
                >
                  {editSafetyEdu ? '✓ 이수' : '○ 미이수'}
                </button>
              ) : member.safetyEduCompleted === true ? (
                <span className="member-detail__chip is-ok">✓ 이수</span>
              ) : docPreviews.safetyCert ? (
                <span className="member-detail__chip is-ok">✓ 이수증 등록</span>
              ) : (
                <span className="member-detail__chip is-pending">! 미이수</span>
              )}
            </div>
          </div>
          {/* 4대보험 — 별도 행 (full width) */}
          <dl className="member-detail__rows" style={{ marginTop: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>4대보험</dt>
              <dd>
                {editing ? (
                  <span className="member-detail__ins-toggles">
                    {[
                      { k: 'pension',     label: '국민', v: editInsPension,    set: setEditInsPension },
                      { k: 'health',      label: '건강', v: editInsHealth,     set: setEditInsHealth },
                      { k: 'employment',  label: '고용', v: editInsEmployment, set: setEditInsEmployment },
                      { k: 'accident',    label: '산재', v: editInsAccident,   set: setEditInsAccident },
                    ].map((it) => (
                      <button
                        key={it.k}
                        type="button"
                        className={'member-detail__toggle' + (it.v ? ' is-on' : '')}
                        onClick={() => it.set(!it.v)}
                        aria-pressed={it.v}
                      >
                        {it.v ? '✓' : '○'} {it.label}
                      </button>
                    ))}
                  </span>
                ) : member.insurance ? (
                  <span className="member-detail__ins-toggles">
                    {[
                      { k: 'p', label: '국민', v: !!member.insurance.pension },
                      { k: 'h', label: '건강', v: !!member.insurance.health },
                      { k: 'e', label: '고용', v: !!member.insurance.employment },
                      { k: 'a', label: '산재', v: !!member.insurance.accident },
                    ].map((it) => (
                      <span
                        key={it.k}
                        className={'member-detail__chip ' + (it.v ? 'is-ok' : 'is-muted')}
                      >
                        {it.v ? '✓' : '○'} {it.label}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="member-detail__chip is-pending">! 가입정보 없음</span>
                )}
              </dd>
            </div>
          </dl>
        </section>

        {/* 3. 현장정보 — 1줄: 배정현장(풀폭) / 2줄: 관리반장·근로계약·등록경로(3컬럼) */}
        <section className="member-detail__sec">
          <h4 className="member-detail__sec-h">현장정보</h4>
          {/* 1줄 — 배정 현장 (풀폭, 현장명을 한 줄에 길게 노출) */}
          <dl className="member-detail__rows member-detail__rows--full">
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>배정 현장</dt>
              <dd className="member-detail__site-name">
                {editing ? (
                  <select
                    value={editSiteId}
                    onChange={(e) => {
                      const next = e.target.value;
                      setEditSiteId(next);
                      const first = foremen.find((f) => f.siteId === next);
                      setEditForemanId(first?.id ?? '');
                    }}
                    className="member-detail__input"
                  >
                    <option value="">— 미정 (대기 인력 / 본사 직접 관리) —</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                ) : (
                  siteName || <span className="member-detail__chip is-pending">— 미정 (대기 인력) —</span>
                )}
              </dd>
            </div>
          </dl>
          {/* 2줄 — 관리 반장 / 근로계약 / 등록 경로 (3컬럼) */}
          <dl className="member-detail__rows member-detail__rows--3col">
            <div>
              <dt>관리 반장</dt>
              <dd>
                {editing ? (
                  <select
                    value={editForemanId}
                    onChange={(e) => setEditForemanId(e.target.value)}
                    disabled={!editSiteId}
                    className="member-detail__input"
                  >
                    {!editSiteId ? (
                      <option value="">— 배정 현장 미정 (본사 직접 관리) —</option>
                    ) : (
                      <>
                        <option value="">— 미배정 (반장 자동 배정) —</option>
                        <option value="__SITE_MANAGER__">🛡 반장 없이 등록 (현장담당자 직접 관리)</option>
                        {visibleEditForemen.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}{f.role ? ` (${f.role})` : ''}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                ) : foremanState === 'unassigned' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="member-detail__chip is-pending">⚠ 반장 미배정</span>
                    <button
                      type="button"
                      className="member-detail__chip is-pending member-detail__chip--btn"
                      onClick={onAssignForeman}
                      title="반장 등록·초대 화면으로 이동"
                    >
                      ＋ 반장 등록·배정
                    </button>
                    <span style={{ fontSize: 11, color: '#92400e' }}>
                      얼굴 인식 출퇴근을 위해 반장 또는 현장담당자 배정이 필요합니다.
                    </span>
                  </div>
                ) : foremanState === 'site_manager' ? (
                  <span className="member-detail__chip is-ok">{foremanLabel}</span>
                ) : (
                  foremanLabel
                )}
              </dd>
            </div>
            <div>
              <dt>근로계약</dt>
              <dd>
                {member.contractSigned ? (
                  <span className="member-detail__chip is-ok">
                    ✓ 체결{member.contractSignedAt ? ` · ${member.contractSignedAt}` : ''}
                  </span>
                ) : (
                  <button type="button" className="member-detail__chip is-pending member-detail__chip--btn" onClick={onSendContract}>
                    ! 미체결 — 알림톡 발송
                  </button>
                )}
              </dd>
            </div>
            <div><dt>등록 경로</dt><dd>{regModeLabel(member.registrationMode)}</dd></div>
          </dl>
        </section>

        {/* 4. 민감정보 — 주민등록번호 / 계좌번호 (마스킹 + 「보기」 토글) */}
        <section className="member-detail__sec member-detail__sec--sensitive">
          <h4 className="member-detail__sec-h">
            민감정보
            <span className="member-detail__sec-h-actions">
              <button
                type="button"
                className="member-detail__reveal-link"
                onClick={() => setLogsOpen(true)}
                title="민감정보 열람 이력 보기"
              >
                📋 열람 이력
              </button>
              <button
                type="button"
                className="member-detail__reveal"
                onClick={() => {
                  if (showSensitive) { setShowSensitive(false); return; }
                  const log = appendSensitiveAccessLog({
                    memberId: member.id,
                    memberName: member.name,
                    fields: ['주민번호', '계좌번호'],
                    actorName: user?.name ?? '본사 관리자',
                    actorId: user?.userId ?? 'unknown',
                    actorRole: user?.role ?? 'HQ',
                  });
                  setRevealHistory((prev) => [log, ...prev]);
                  setShowSensitive(true);
                }}
                title={showSensitive ? '마스킹으로 돌아가기' : '평문 보기 — 열람자·시각이 감사 로그에 자동 기록됩니다'}
              >
                {showSensitive ? '👁 마스킹' : '🔒 보기'}
              </button>
            </span>
          </h4>
          {showSensitive && revealHistory[0] && (
            <p className="member-detail__reveal-notice">
              ⚠ 본 열람은 감사 로그에 기록됩니다 — {revealHistory[0].actorName} · {new Date(revealHistory[0].at).toLocaleString('ko-KR')}
            </p>
          )}
          <dl className="member-detail__rows">
            <div>
              <dt>주민등록번호</dt>
              <dd className="member-detail__mono">
                {editing ? (
                  <input
                    type={showSensitive || editIdModified ? 'text' : 'password'}
                    value={
                      editIdModified
                        ? editIdNumber
                        : (showSensitive ? (member.idNumberRaw || member.idNumberMasked || '') : (member.idNumberMasked || ''))
                    }
                    onChange={(e) => {
                      setEditIdNumber(formatRRN(e.target.value));
                      setEditIdModified(true);
                    }}
                    placeholder="770417-1234567"
                    className="member-detail__input member-detail__input--mono"
                    autoComplete="off"
                    style={{ width: 130, maxWidth: 130 }}
                  />
                ) : (
                  showSensitive && member.idNumberRaw ? member.idNumberRaw : member.idNumberMasked
                )}
              </dd>
            </div>
            <div>
              <dt>계좌번호</dt>
              <dd className="member-detail__mono">
                {editing ? (
                  <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', width: '100%' }}>
                    <select
                      value={editBankName}
                      onChange={(e) => setEditBankName(e.target.value)}
                      className="member-detail__input"
                      style={{ width: 70, flex: '0 0 70px', padding: '0 4px' }}
                    >
                      {KOREAN_BANKS.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                    <input
                      type={showSensitive || editAcctModified ? 'text' : 'password'}
                      value={
                        editAcctModified
                          ? editAcctNumber
                          : (showSensitive ? (member.accountNumberRaw || member.accountMasked || '') : (member.accountMasked || ''))
                      }
                      onChange={(e) => {
                        setEditAcctNumber(formatAccount(e.target.value));
                        setEditAcctModified(true);
                      }}
                      placeholder="110-123-456789"
                      className="member-detail__input member-detail__input--mono"
                      autoComplete="off"
                    />
                  </span>
                ) : (
                  <>
                    {member.bankName}{' '}
                    {showSensitive && member.accountNumberRaw ? member.accountNumberRaw : member.accountMasked}
                  </>
                )}
              </dd>
            </div>
          </dl>
        </section>

        {/* 5. 사진·서류 등록 — 신분증·통장사본·외국인등록증·여권·건설안전교육증 (5개 1줄) */}
        <section className="member-detail__sec">
          <h4 className="member-detail__sec-h">사진·서류 등록</h4>
          <p className="member-detail__hint">필요한 항목에 사진을 업로드하세요. 업로드된 사진은 신원 확인·노임 처리에만 사용됩니다.</p>
          <div className="member-detail__doc-grid">
            <DocUploadTile label="신분증" apiKind="id"
              preview={docPreviews.idCard} onUpload={(p) => setDocPreviews((s) => ({ ...s, idCard: p }))} />
            <DocUploadTile label="통장사본" apiKind="bank"
              preview={docPreviews.bankBook} onUpload={(p) => setDocPreviews((s) => ({ ...s, bankBook: p }))} />
            <DocUploadTile label="외국인등록증" apiKind="id"
              preview={docPreviews.alienCard} onUpload={(p) => setDocPreviews((s) => ({ ...s, alienCard: p }))} />
            <DocUploadTile label="여권" apiKind="id"
              preview={docPreviews.passport} onUpload={(p) => setDocPreviews((s) => ({ ...s, passport: p }))} />
            <DocUploadTile label="건설안전교육증" apiKind="id"
              preview={docPreviews.safetyCert} onUpload={(p) => setDocPreviews((s) => ({ ...s, safetyCert: p }))} />
          </div>
        </section>
      </div>

      {logsOpen && (
        <SensitiveAccessLogDialog
          memberId={member.id}
          memberName={member.name}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </Modal>
  );
}

/* ───────── 민감정보 열람 감사 로그 ───────── */

/**
 * 민감정보 열람은 누가 / 언제 / 무엇을 / 왜 — 4 요소를 모두 기록합니다.
 * 실 운영 시엔 서버 감사 테이블에 기록하지만, 현재는 localStorage 에 보관합니다.
 */
interface SensitiveAccessLog {
  id: string;
  /** 누가 — 열람한 사용자 */
  actorId: string;
  actorName: string;
  actorRole: string;
  /** 언제 — ISO 시각 */
  at: string;
  /** 무엇 — 대상 근로자 + 열람한 필드 목록 */
  memberId: string;
  memberName: string;
  fields: string[];
  /** 왜 — 사유 (현재 정책: 사유 입력 미요구 — 향후 필요 시 사용) */
  reason?: string;
}

const SENSITIVE_LOG_KEY = 'bodapass.sensitive_access_log.v1';

function loadSensitiveAccessLog(): SensitiveAccessLog[] {
  try {
    const raw = localStorage.getItem(SENSITIVE_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendSensitiveAccessLog(input: Omit<SensitiveAccessLog, 'id' | 'at'>): SensitiveAccessLog {
  const log: SensitiveAccessLog = {
    ...input,
    id: 'SAL-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
  };
  const all = loadSensitiveAccessLog();
  all.unshift(log);
  // 최근 500건만 보관 (localStorage 용량 보호)
  const trimmed = all.slice(0, 500);
  try {
    localStorage.setItem(SENSITIVE_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    // 용량 초과 시 무시
  }
  return log;
}

function SensitiveAccessLogDialog({
  memberId,
  memberName,
  onClose,
}: {
  memberId: string;
  memberName: string;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const allLogs = loadSensitiveAccessLog();
  const memberLogs = allLogs.filter((l) => l.memberId === memberId);
  const displayLogs = showAll ? allLogs : memberLogs;
  return (
    <Modal
      open={true}
      onClose={onClose}
      title="민감정보 열람 이력"
      subtitle={
        showAll
          ? `전체 근로자 — 최근 ${displayLogs.length}건`
          : `${memberName} — 최근 ${displayLogs.length}건`
      }
      width={680}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? `↩ ${memberName} 만 보기` : '🔍 전체 근로자 이력'}
          </button>
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={onClose}
          >
            닫기
          </button>
        </div>
      }
    >
      {displayLogs.length === 0 ? (
        <p className="member-detail__muted" style={{ padding: '32px 16px', textAlign: 'center' }}>
          기록된 열람 이력이 없습니다.
        </p>
      ) : (
        <ul className="audit-log">
          {displayLogs.map((l) => (
            <li key={l.id} className="audit-log__item">
              <div className="audit-log__head">
                <strong className="audit-log__actor">{l.actorName}</strong>
                <span className="audit-log__role">{l.actorRole}</span>
                <span className="audit-log__sep">·</span>
                <span className="audit-log__time">
                  {new Date(l.at).toLocaleString('ko-KR')}
                </span>
              </div>
              <div className="audit-log__what">
                <span className="audit-log__label">대상</span>
                <strong>{l.memberName}</strong>
                <span className="audit-log__fields">
                  {l.fields.map((f) => (
                    <span key={f} className="audit-log__field">{f}</span>
                  ))}
                </span>
              </div>
              {l.reason && (
                <div className="audit-log__why">
                  <span className="audit-log__label">사유</span>
                  <span>{l.reason}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ───────── 팀원 수정 다이얼로그 ───────── */

interface EditProps {
  member: TeamMember;
  sites: Site[];
  foremen: Foreman[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/** 일반적으로 쓰는 한국 은행 — 노임 처리에 필요한 주요 은행만 모음 */
// 공통 은행 목록 — src/utils/banks.ts (등록 페이지와 동일 리스트)

/** 입력값이 마스킹된 값(*가 포함됐는지)이 아니라 실제 새 번호인지 검사 */
function idValueIsClean(v: string): boolean {
  return !!v.trim() && !v.includes('*');
}

function MemberEditDialog({ member, sites, foremen, onClose, onSaved }: EditProps) {
  const [role, setRole] = useState<string>(member.role);
  const [dailyWage, setDailyWage] = useState<string>(String(member.dailyWage));
  const [siteId, setSiteId] = useState<string>(member.siteId);
  const [foremanId, setForemanId] = useState<string>(member.foremanId ?? '');
  /* 민감정보 — 디폴트는 마스킹 표시, 눈 누르면 raw 노출, 사용자가 지우고 새로 입력하면 modified 로 마킹 */
  const [idValue, setIdValue] = useState<string>(member.idNumberMasked || '');
  const [idShow, setIdShow] = useState<boolean>(false);
  const [idModified, setIdModified] = useState<boolean>(false);
  const [bankName, setBankName] = useState<string>(member.bankName ?? '');
  const [acctValue, setAcctValue] = useState<string>(member.accountMasked || '');
  const [acctShow, setAcctShow] = useState<boolean>(false);
  const [acctModified, setAcctModified] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  /**
   * raw 가 서버에서 없으면 마스킹된 자릿수의 별표만 ?로 표시한다.
   * 마스킹 앞부분은 절대 바꾸지 않는다 — 사용자 데이터 무결성 우선.
   */
  function fallbackRawId(): string {
    if (member.idNumberRaw) return member.idNumberRaw;
    return (member.idNumberMasked || '').replace(/\*+/g, (m) => '?'.repeat(m.length));
  }
  function fallbackRawAcct(): string {
    if (member.accountNumberRaw) return member.accountNumberRaw;
    return (member.accountMasked || '').replace(/\*+/g, (m) => '?'.repeat(m.length));
  }

  /** 눈 토글 — 사용자가 아직 수정 안 했으면 마스킹↔raw 스왑, 수정했으면 password↔text 만 토글 */
  function toggleIdShow() {
    if (!idModified) {
      const next = !idShow;
      setIdShow(next);
      setIdValue(next ? fallbackRawId() : (member.idNumberMasked ?? ''));
    } else {
      setIdShow((v) => !v);
    }
  }
  function toggleAcctShow() {
    if (!acctModified) {
      const next = !acctShow;
      setAcctShow(next);
      setAcctValue(next ? fallbackRawAcct() : (member.accountMasked ?? ''));
    } else {
      setAcctShow((v) => !v);
    }
  }

  const visibleForemen = foremen.filter((f) => f.siteId === siteId);

  function pickSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    const first = foremen.find((x) => x.siteId === nextSiteId);
    setForemanId(first?.id ?? '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrMsg(null);
    if (!role.trim()) {
      setErrMsg('직종을 선택해주세요.');
      return;
    }
    const wage = Number(dailyWage.replace(/[^0-9]/g, ''));
    if (!Number.isFinite(wage) || wage <= 0) {
      setErrMsg('일당을 올바르게 입력해주세요.');
      return;
    }
    if (!siteId) {
      setErrMsg('현장을 선택해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      // 민감정보: 사용자가 직접 새 값을 입력한 경우(modified)에만 서버로 전송
      const bankChanged = bankName !== (member.bankName ?? '');
      await teamApi.update(member.id, {
        role,
        dailyWage: wage,
        siteId,
        foremanId: foremanId || undefined,
        ...(bankChanged ? { bankName } : {}),
        ...(acctModified && idValueIsClean(acctValue) ? { accountNumber: acctValue.trim() } : {}),
        ...(idModified && idValueIsClean(idValue) ? { idNumber: idValue.trim() } : {}),
      });
      await onSaved();
    } catch (err) {
      setErrMsg(getErrorMessage(err, '수정에 실패했습니다.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${member.name} 팀원 정보 수정`}
      subtitle={`${member.phone} · ${member.idNumberMasked}`}
      width={620}
      footer={
        <div className="med__cta">
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={onClose}
            disabled={submitting}
          >
            취소
          </button>
          <button
            type="submit"
            form="member-edit-form"
            className="team-list__btn team-list__btn--primary"
            disabled={submitting}
          >
            {submitting ? '저장 중…' : '저장'}
          </button>
        </div>
      }
    >
      <form id="member-edit-form" className="med" onSubmit={handleSubmit} noValidate>
        <div className="med__row">
          <label>직종</label>
          <RoleSelect value={role} onChange={setRole} placeholder="직종 선택" />
        </div>

        <div className="med__row">
          <label>일당 (원)</label>
          <input
            type="text"
            inputMode="numeric"
            value={Number(dailyWage.replace(/[^0-9]/g, '') || '0').toLocaleString()}
            onChange={(e) => setDailyWage(e.target.value.replace(/[^0-9]/g, ''))}
            className="med__input"
          />
        </div>

        <div className="med__row">
          <label>배정 현장</label>
          <select
            value={siteId}
            onChange={(e) => pickSite(e.target.value)}
            className="med__input"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="med__row">
          <label>관리 반장</label>
          <select
            value={foremanId}
            onChange={(e) => setForemanId(e.target.value)}
            className="med__input"
          >
            <option value="">— 미배정 (자동) —</option>
            {visibleForemen.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.role ? ` (${f.role})` : ''} · {f.phone}
                {f.registered ? '' : ' · 가입 대기'}
              </option>
            ))}
          </select>
        </div>

        {/* 민감정보 — 항상 편집 가능, 디폴트는 마스킹 표시. 눈 아이콘으로 raw 노출 */}
        <fieldset className="med__sensitive">
          <legend className="med__sensitive-legend">민감정보 (4대보험·노임대장 처리용)</legend>
          <p className="med__sensitive-hint">
            현재 값은 마스킹되어 표시됩니다. <strong>👁 아이콘</strong>을 누르면 실제 번호가 보이고,
            마스킹을 지우고 <strong>새 번호를 입력</strong>하면 그 값으로 갱신됩니다.
          </p>

          <div className="med__row">
            <label>주민등록번호</label>
            <div className="med__sensitive-input">
              <input
                type={(idShow || idModified) ? 'text' : 'text'}
                inputMode="numeric"
                value={idValue}
                onChange={(e) => {
                  setIdValue(formatRRN(e.target.value));
                  setIdModified(true);
                }}
                placeholder="770417-1055112"
                className="med__input"
                autoComplete="off"
              />
              <button
                type="button"
                className="med__eye-btn"
                onClick={toggleIdShow}
                title={idShow ? '마스킹' : '실제 번호 보기'}
                aria-label="주민번호 보기 토글"
              >
                {idShow ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="med__row med__row--split">
            <label>은행 / 계좌번호</label>
            <div className="med__split">
              <select
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                className="med__input med__input--bank"
              >
                <option value="">— 은행 선택 —</option>
                {KOREAN_BANKS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <div className="med__sensitive-input">
                <input
                  type="text"
                  inputMode="numeric"
                  value={acctValue}
                  onChange={(e) => {
                    setAcctValue(formatAccount(e.target.value));
                    setAcctModified(true);
                  }}
                  placeholder="110-123-456789"
                  className="med__input"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="med__eye-btn"
                  onClick={toggleAcctShow}
                  title={acctShow ? '마스킹' : '실제 번호 보기'}
                  aria-label="계좌번호 보기 토글"
                >
                  {acctShow ? '🙈' : '👁'}
                </button>
              </div>
            </div>
          </div>
        </fieldset>

        {errMsg && <p className="med__err">{errMsg}</p>}
      </form>
    </Modal>
  );
}

/* ───────── 사진·서류 업로드 타일 (시연용) ─────────
 *  - 클릭하면 파일 선택 → FileReader 로 dataURL 미리보기
 *  - 실제 업로드는 시연 단계라 호출 안 함 (apiKind 만 보관)
 */
function DocUploadTile({
  label,
  apiKind: _apiKind,
  preview,
  onUpload,
}: {
  label: string;
  apiKind: 'id' | 'bank';
  preview?: string;
  onUpload: (dataUrl: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  function handlePick(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onUpload(reader.result);
    };
    reader.readAsDataURL(file);
  }
  return (
    <button
      type="button"
      className={'doc-tile' + (preview ? ' is-filled' : '')}
      onClick={() => inputRef.current?.click()}
      title={`${label} 업로드`}
    >
      {preview ? (
        <img src={preview} alt={label} className="doc-tile__img" />
      ) : (
        <span className="doc-tile__placeholder">📷</span>
      )}
      <span className="doc-tile__label">{label}</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handlePick(f);
          e.target.value = '';
        }}
      />
    </button>
  );
}

/* ───────── 근로계약서 발송 다이얼로그 ─────────
 *  Step 1: "계약서 발송을 하시겠습니까?" 확인
 *  Step 2: 회사 정보 입력 폼
 *  Step 3: 화면 내 계약서 미리보기 (HTML) → 「근로자에게 발송」/「PDF 저장(인쇄)」
 *
 *  ※ 일당(R27 = 포괄일당) 기준으로 시급·기본일당·항목별 일당을 JS 로 계산.
 *    G7 근로자 성명 / Z7 주민등록번호 / Z8 핸드폰
 *    F15 취업장소 / AE15 취업직종
 *    I9 계약기간
 *    R27 포괄일당 (입력하면 시급/기본일당/항목별 일당이 자동 산식 계산)
 */
const CONTRACT_COMPANY_KEY = 'bodapass_admin:contract_company';

function ContractSendDialog({
  member,
  siteName,
  onClose,
  onSent,
}: {
  member: TeamMember;
  siteName: string;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const [step, setStep] = useState<'confirm' | 'form' | 'preview'>('confirm');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // 회사 정보 — localStorage 캐시 + user.companyName 으로 초기값
  const cached = (() => {
    try {
      const raw = localStorage.getItem(CONTRACT_COMPANY_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as {
        companyName?: string;
        ceoName?: string;
        companyAddr?: string;
        companyPhone?: string;
      };
    } catch {
      return null;
    }
  })();
  const [companyName, setCompanyName] = useState(cached?.companyName ?? user?.companyName ?? '');
  const [ceoName, setCeoName] = useState(cached?.ceoName ?? '');
  const [companyAddr, setCompanyAddr] = useState(cached?.companyAddr ?? '');
  const [companyPhone, setCompanyPhone] = useState(cached?.companyPhone ?? '');

  // 계약 기간 — 오늘 ~ 공사 완료시까지
  const today = useMemo(() => {
    const d = new Date();
    return {
      yyyy: d.getFullYear(),
      mm: String(d.getMonth() + 1).padStart(2, '0'),
      dd: String(d.getDate()).padStart(2, '0'),
    };
  }, []);
  const todayStr = `${today.yyyy}-${today.mm}-${today.dd}`;

  // ── 임금 자동 계산 (포괄일당 → 시급/기본일당/항목별 일당) ──
  // 8h 기본 + 1h 연장(1.5배) → 통상 환산 시간 9.5h
  const calc = useMemo(() => {
    const wage = member.dailyWage;
    const hourly = Math.round(wage / 9.5); // 통상시급
    const baseDaily = hourly * 8; // 기본일당
    const overtime = Math.round(hourly * 1.5); // 연장근로 1h 가산금
    const night = Math.round(hourly * 0.5); // 야간근로 가산
    const holiday = Math.round(hourly * 1); // 휴일근로 가산
    const weeklyRest = Math.round((hourly * 8) / 5); // 주휴수당 (5일 1일치)
    const lunch = wage - baseDaily - overtime - night - holiday - weeklyRest;
    return {
      hourly,
      baseDaily,
      overtime,
      night,
      holiday,
      weeklyRest,
      lunch: Math.max(0, lunch),
      total: wage,
    };
  }, [member.dailyWage]);

  function handleProceedToPreview() {
    setErrMsg(null);
    if (!companyName.trim()) {
      setErrMsg('사업체명을 입력해주세요.');
      return;
    }
    // 회사 정보 캐시
    try {
      localStorage.setItem(
        CONTRACT_COMPANY_KEY,
        JSON.stringify({ companyName, ceoName, companyAddr, companyPhone }),
      );
    } catch {
      /* noop */
    }
    setStep('preview');
  }

  function handlePrint() {
    // 미리보기 영역만 인쇄 — 전역 CSS 의 @media print 규칙으로 처리
    document.body.classList.add('contract-printing');
    // 스타일이 적용될 시간 후 인쇄 (Safari 대응)
    requestAnimationFrame(() => {
      window.print();
      document.body.classList.remove('contract-printing');
    });
  }

  async function handleSendToWorker() {
    setSending(true);
    try {
      // 시연: 발송만 시뮬, 실제 운영에선 PDF 생성·서명 요청 링크 발송
      await new Promise((r) => setTimeout(r, 350));
      window.alert(
        `${member.name}님(${member.phone})에게\n` +
          `근로계약서 PDF 열람·전자서명 링크가\n발송되었습니다.\n\n` +
          `서명이 완료되면 자동으로 「체결」 상태로 변경됩니다.`,
      );
      await onSent();
    } finally {
      setSending(false);
    }
  }

  // ── Step 1: 확인 ──
  if (step === 'confirm') {
    return (
      <Modal
        open
        onClose={onClose}
        title="계약서 발송을 하시겠습니까?"
        subtitle={`${member.name} · ${siteName}`}
        width={480}
        footer={
          <div className="med__cta">
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={onClose}
            >
              아니오
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={() => setStep('form')}
            >
              네, 계속
            </button>
          </div>
        }
      >
        <div className="med">
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--color-bg-soft)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              display: 'grid',
              gridTemplateColumns: '88px 1fr',
              rowGap: 6,
              columnGap: 10,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div style={{ color: 'var(--color-text-muted)' }}>성명</div>
            <div style={{ fontWeight: 700 }}>{member.name}</div>
            <div style={{ color: 'var(--color-text-muted)' }}>휴대폰</div>
            <div>{member.phone}</div>
            <div style={{ color: 'var(--color-text-muted)' }}>현장</div>
            <div>{siteName}</div>
            <div style={{ color: 'var(--color-text-muted)' }}>직종</div>
            <div>{member.role}</div>
            <div style={{ color: 'var(--color-text-muted)' }}>일당</div>
            <div style={{ fontWeight: 700, color: 'var(--color-primary-dark)' }}>
              {member.dailyWage.toLocaleString()}원
            </div>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--color-text-muted)',
              lineHeight: 1.5,
            }}
          >
            다음 단계에서 회사 정보를 입력하면, 일당을 기준으로 시급·기본일당·항목별 일당이 자동
            계산된 근로계약서를 화면에서 바로 확인할 수 있습니다.
          </p>
        </div>
      </Modal>
    );
  }

  // ── Step 2: 회사 정보 입력 ──
  if (step === 'form') {
    return (
      <Modal
        open
        onClose={onClose}
        title="근로계약서 작성"
        subtitle={`${member.name} · ${siteName} · 일당 ${member.dailyWage.toLocaleString()}원`}
        width={620}
        footer={
          <div className="med__cta">
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={() => setStep('confirm')}
            >
              이전
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={handleProceedToPreview}
              disabled={!companyName.trim()}
            >
              📄 계약서 미리보기
            </button>
          </div>
        }
      >
        <div className="med">
          {/* 근로자 정보 (읽기전용) */}
          <fieldset className="med__sensitive">
            <legend className="med__sensitive-legend">근로자 정보</legend>
            <div className="med__row">
              <label>성명</label>
              <div style={{ fontWeight: 700 }}>{member.name}</div>
            </div>
            <div className="med__row">
              <label>휴대폰</label>
              <div>{member.phone}</div>
            </div>
            <div className="med__row">
              <label>주민등록번호</label>
              <div style={{ fontFamily: 'monospace' }}>
                {member.idNumberMasked || '—'}
              </div>
            </div>
            <div className="med__row">
              <label>직종 / 일당</label>
              <div>
                {member.role}{' '}
                <span style={{ color: 'var(--color-text-muted)' }}>·</span>{' '}
                <strong style={{ color: 'var(--color-primary-dark)' }}>
                  {member.dailyWage.toLocaleString()}원
                </strong>
              </div>
            </div>
            <div className="med__row">
              <label>계약기간</label>
              <div style={{ color: 'var(--color-text-soft)' }}>
                {todayStr} ~ 공사 완료시까지
              </div>
            </div>
          </fieldset>

          {/* 회사 정보 (입력) */}
          <fieldset className="med__sensitive">
            <legend className="med__sensitive-legend">회사 정보</legend>
            <div className="med__row">
              <label>
                사업체명 <span style={{ color: 'var(--color-error)' }}>*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="med__input"
                placeholder="(주)○○건설"
                autoFocus
              />
            </div>
            <div className="med__row">
              <label>대표자</label>
              <input
                type="text"
                value={ceoName}
                onChange={(e) => setCeoName(e.target.value)}
                className="med__input"
                placeholder="홍길동"
              />
            </div>
            <div className="med__row">
              <label>소재지</label>
              <input
                type="text"
                value={companyAddr}
                onChange={(e) => setCompanyAddr(e.target.value)}
                className="med__input"
                placeholder="서울특별시 ○○구 ○○로 123"
              />
            </div>
            <div className="med__row">
              <label>회사 전화</label>
              <input
                type="text"
                value={companyPhone}
                onChange={(e) => setCompanyPhone(e.target.value)}
                className="med__input"
                placeholder="02-1234-5678"
                inputMode="tel"
              />
            </div>
            <p className="med__sensitive-hint">
              <strong>입력한 회사 정보는 이 브라우저에 저장</strong>되어 다음 계약서 작성 때 자동으로
              채워집니다.
            </p>
          </fieldset>

          {errMsg && <p className="med__err">{errMsg}</p>}
        </div>
      </Modal>
    );
  }

  // ── Step 3: 화면 미리보기 + PDF ──
  return (
    <Modal
      open
      onClose={onClose}
      title="근로계약서 미리보기"
      subtitle={`${member.name} · ${siteName}`}
      width={920}
      footer={
        <div className="med__cta" style={{ justifyContent: 'space-between', width: '100%' }}>
          <button
            type="button"
            className="team-list__btn team-list__btn--ghost"
            onClick={() => setStep('form')}
            disabled={sending}
          >
            ← 정보 수정
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="team-list__btn team-list__btn--ghost"
              onClick={handlePrint}
              disabled={sending}
              title="브라우저 인쇄 다이얼로그에서 「PDF 로 저장」 선택"
            >
              🖨 PDF 저장(인쇄)
            </button>
            <button
              type="button"
              className="team-list__btn team-list__btn--primary"
              onClick={handleSendToWorker}
              disabled={sending}
            >
              {sending ? '발송 중…' : '📧 근로자에게 발송'}
            </button>
          </div>
        </div>
      }
    >
      {/* 인쇄 영역 — @media print 시 이 영역만 보임 */}
      <div className="contract-doc" id="contract-doc-print">
        <h1 className="contract-doc__title">현장 일용직 근로계약서</h1>

        <table className="contract-grid">
          <colgroup>
            <col style={{ width: '8%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '40%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '25%' }} />
          </colgroup>
          <tbody>
            {/* 1. 당사자 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={4}>당사자</th>
              <th rowSpan={2}>사용자</th>
              <th>사업체명</th>
              <td>{companyName || '—'}</td>
              <th>대 표 자</th>
              <td>{ceoName || '—'}</td>
            </tr>
            <tr>
              <th>소 재 지</th>
              <td>{companyAddr || '—'}</td>
              <th>전　　화</th>
              <td>{companyPhone || '—'}</td>
            </tr>
            <tr>
              <th rowSpan={2}>근로자</th>
              <th>성　　명</th>
              <td style={{ fontWeight: 700 }}>{member.name}</td>
              <th>생년월일</th>
              <td style={{ fontFamily: 'monospace' }}>{member.idNumberMasked || '—'}</td>
            </tr>
            <tr>
              <th>주　　소</th>
              <td>—</td>
              <th>핸 드 폰</th>
              <td>{member.phone}</td>
            </tr>

            {/* 2. 계약기간 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={2}>계약기간</th>
              <td colSpan={5} className="contract-grid__txt">
                <p>ㅇ 일용직 근로계약기간 : <strong>( {today.yyyy} 년 {today.mm} 월 {today.dd} 일 ~ 공사 완료시까지 )</strong> 근로계약만료시 근로관계는 자동종료된다.</p>
                <p>계약기간 내에도 조기에 현장이 종료되거나 "근로자"의 담당업무 및 공종이 만료된 때 근로계약기간은 자동 종료된다.</p>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                <p>※ 아래(①항~②항)와 같은사유가 발생 시에도 본 근로계약기간은 그 사유발생일에 자동 종료된다.</p>
                <p>① 발주처 또는 원청의 계약해지, 공사중지 명령, 설계변경, 천재지변 등 기타 불가피한 사유으로 인하여 작업이 중단되었을 때</p>
                <p>② "근로자"가 계약기간 내에 타사의 건설현장에 취업 시 또는 "사용자"의 동의없이 "근로자"가 건설현장에 대한 비품, 자산, 현장사진 등을 외부로 유출(사적으로 사용, 처분, 횡령 등 포함)하거나 또는 현장 내외부 및 시설물에 대한 사진 촬영을 했을 때</p>
              </td>
            </tr>

            {/* 3. 취업장소 및 취업직종 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={2}>취업장소<br/>및<br/>취업직종</th>
              <td colSpan={5} className="contract-grid__txt">
                <p>① 취업장소 : <strong>{siteName}</strong>　　　② 취업직종 : <strong>{member.role}</strong></p>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                ③ 전 ①항 및 ②항은 "사용자"의 경영사정에 따라 변경될 수 있으며, "근로자"는 변경지시(전직 및 배치전환) 이에 따를 것을 동의한다. <span style={{ float: 'right' }}>[ 동의(인) : <strong>{member.name}</strong> ]</span>
              </td>
            </tr>

            {/* 4. 근로시간 및 휴게시간 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={2}>근로시간<br/>및<br/>휴게시간</th>
              <td colSpan={5} className="contract-grid__txt">
                <p>하기의 근로/휴게시간은 "사용자"의 경영상 필요와 계절의 변화에 의해 변경될 수 있다.</p>
                <table className="contract-grid__sub">
                  <tbody>
                    <tr><td>① 근로시간 : (평일　 : 08시00분~17시00분)</td><td>② 휴게시간 : (평일　 : 12시00분~13시00분)</td></tr>
                    <tr><td>　　　　　　(휴일　 : 08시00분~17시00분)</td><td>　　　　　　(휴일　 : 12시00분~13시00분)</td></tr>
                    <tr><td>　　　　　　(공휴일 : 08시00분~17시00분)</td><td>　　　　　　(공휴일 : 12시00분~13시00분)</td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                ③ 소정근로시간은 1일 8시간, 1주 40시간을 기준으로 하되, 추가로 발생할 수 있는 연장근로에 "근로자"는 동의한다.
              </td>
            </tr>

            {/* 5. 임금 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={4}>임　금</th>
              <td colSpan={5} className="contract-grid__txt">
                <p>① "근로자"의 임금은 <strong>시간급 {calc.hourly.toLocaleString()} 원</strong>, 1일 8시간 <strong>기본일당 {calc.baseDaily.toLocaleString()} 원</strong>으로 한다.</p>
                <table className="contract-grid__sub contract-grid__sub--legend">
                  <tbody>
                    <tr><td>1. 유급주휴(일요일) : 시급×8시간</td><td>2. 토,일할증 : 시급×휴일근로시간×50% + 연장 8시간 초과×50%</td></tr>
                    <tr><td>3. 연차수당 : 미사용연차휴가</td><td>4. 평일연장 : 시급×평일연장근로시간×150%</td></tr>
                    <tr><td>5. 유급휴일(근로) : 국공휴일·근로자의 날</td><td>6. 야간근로 : 시급×야간할증시간×50%</td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt">
                <p>② "근로자"의 임금은 위 "①항" 기본일당에 제반수당이 포함된 <strong>포괄일당 {calc.total.toLocaleString()} 원</strong> 이며, 임금정책 변경 시 포괄일당 및 시간급으로 산정하는데에 동의한다. <span style={{ float: 'right' }}>[ 동의(인) : <strong>{member.name}</strong> ]</span></p>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt">
                ③ 임금계산은 매월 1 일에서 매월 말일 까지 정산하여 익월 말일 에 지급한다. 매월 급여 정산은 세금 및 4대 보험의 공제액 발생 시 "근로자"의 부담금액을 공제 후 지급한다.
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt">
                ④ 지급방법 : <strong>통장지급</strong> · {member.bankName} {member.accountMasked}
              </td>
            </tr>

            {/* 6. 포괄일당 산정내역 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={3}>포괄일당<br/>산정내역</th>
              <td colSpan={5} style={{ padding: 0 }}>
                <table className="contract-wage">
                  <thead>
                    <tr>
                      <th>임금구성내역</th>
                      <th>기본일당</th>
                      <th>유급주휴</th>
                      <th>토,일할증</th>
                      <th>연차수당</th>
                      <th>평일연장</th>
                      <th>야간할증</th>
                      <th>유급휴일</th>
                      <th>합계</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>시간(H)</th>
                      <td>8H</td>
                      <td>1.6H</td>
                      <td>0H</td>
                      <td>0H</td>
                      <td>1H</td>
                      <td>0.5H</td>
                      <td>0H</td>
                      <td className="contract-wage__total">11.1H</td>
                    </tr>
                    <tr>
                      <th>일당(원)</th>
                      <td>{calc.baseDaily.toLocaleString()}</td>
                      <td>{calc.weeklyRest.toLocaleString()}</td>
                      <td>0</td>
                      <td>0</td>
                      <td>{calc.overtime.toLocaleString()}</td>
                      <td>{calc.night.toLocaleString()}</td>
                      <td>0</td>
                      <td className="contract-wage__total">{calc.total.toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
            <tr style={{ display: 'none' }}><td/></tr>
            <tr style={{ display: 'none' }}><td/></tr>

            {/* 7. 근로계약 해지사유 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={1}>근로계약<br/>해지사유</th>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                <p>① 안전수칙(안전용품 미착용 및 안전관리자 지시위반) 불이행 또는 회사규정 불이행으로 경고처분을 받고 현장에 근로를 제공할 수 없을 때</p>
                <p>② 정당한 업무지시 불이행 또는 고의ㆍ중대한 과실로 사고나 손실을 야기시킨 경우</p>
                <p>③ 신체(고혈압, 디스크 포함)·정신상 장애로 계속근로가 불가하다고 인정되었을 때</p>
                <p>④ 외국인근로자 : 사업장에서 외국인과 더 이상 고용관계를 유지할 수 없는 경우</p>
                <p>⑤ "사용자"의 승인없이 타사의 작업현장에 취업한 때 또는 무단결근일을 주 3일 이상 또는 월 5일 이상 했을 때</p>
                <p>⑥ 도박, 풍기문란, 폭행, 파괴, 태업을 선도하는 등 불미한 행동을 하거나 모의한 때</p>
                <p>⑦ 불법체류자, 지명수배중에 있는자, 장해판정 등에 의거 노동력의 일부분이 상실되었음이 확인된 자는 채용될 수 없으며, 위 사실이 추후 발견된 경우 본 근로계약은 취소된다.</p>
                <p>⑧ 일용근로자의 최종 인사권은 본사에 있으므로 본사 승인이 없는 현장소장 해고는 무효로 한다.</p>
              </td>
            </tr>

            {/* 8. 기타조건 */}
            <tr>
              <th className="contract-grid__lbl">기타조건</th>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                <p>① 법정휴일은 주휴일(소정 근로일 만근) 및 근로자의 날(5.1)이고, 법정휴가(연차휴가 등)는 근로기준법에 따르며 휴가의 자유로운 사용을 보장한다.</p>
                <p>② "근로자"는 채용 전에 현장업무 수행과 인과관계가 있는 지병(질병)을 고지해야 하며 이를 숨기거나 허위로 작성된 건강진단서를 제출하고 근무 중에 지병의 사실이 확인된 경우에는 해당 시점에 근로계약은 자동 해지된다.</p>
                <p>③ 개인정보(성명, 주민등록번호, 주소, 전화번호)를 현장내 출입관리, 공사 및 노무관리에 활용할 수 있도록 원청 및 발주처 관계자에게 제공하고 활용하는데 이의없이 동의한다.</p>
              </td>
            </tr>

            {/* 9. 안전장구 지급확인 */}
            <tr>
              <th className="contract-grid__lbl" rowSpan={2}>안전장구<br/>지급확인</th>
              <td colSpan={5} className="contract-grid__txt">
                <span className="contract-chk">안전교육 [ <strong>O</strong> ]</span>
                <span className="contract-chk">안전모 [ <strong>O</strong> ]</span>
                <span className="contract-chk">안전화 [ <strong>O</strong> ]</span>
                <span className="contract-chk">안전벨트 [ <strong>O</strong> ]</span>
                <span className="contract-chk">기타장비 [ <strong>O</strong> ]</span>
              </td>
            </tr>
            <tr>
              <td colSpan={5} className="contract-grid__txt contract-grid__txt--small">
                ※ 상기 안전장구를 수령했고, 현장 안전수칙을 확인 및 이행함에 동의한다.
              </td>
            </tr>

            {/* 10. 특약사항 */}
            <tr>
              <th className="contract-grid__lbl">특약사항</th>
              <td colSpan={5} className="contract-grid__special">
                <div className="contract-grid__special-line"></div>
                <div className="contract-grid__special-line"></div>
                <div className="contract-grid__special-line"></div>
              </td>
            </tr>
          </tbody>
        </table>

        <p className="contract-doc__bottom-note">
          상기 "근로자"는 계약서에 정한 규정을 성실히 준수하고, 본 계약서에 없는 사항은 "사용자"의 해석에 따르기로 한다.
        </p>
        <p className="contract-doc__date">
          {today.yyyy} 년 {today.mm} 월 {today.dd} 일
        </p>

        <table className="contract-sign">
          <tbody>
            <tr>
              <th>사 용 자</th>
              <td>{companyName || '—'}</td>
              <td className="contract-sign__stamp">( 서명 / 인 )</td>
              <th>근 로 자</th>
              <td>{member.name}</td>
              <td className="contract-sign__stamp">( 서명 / 인 )</td>
            </tr>
            <tr>
              <th>대　　표</th>
              <td>{ceoName || '—'}</td>
              <td></td>
              <th>근로계약서<br/>교부확인</th>
              <td colSpan={2} className="contract-sign__stamp">( 서명 / 인 )</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/* ───────── 얼굴인증 요청 다이얼로그 ───────── */
function FaceVerifyRequestDialog({
  member,
  foreman,
  siteName,
  onClose,
  onSent,
}: {
  member: TeamMember;
  foreman: Foreman | null;
  siteName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const targetName = foreman ? `${foreman.name} 반장` : '현장담당자';
  const targetPhone = foreman?.phone || '현장담당자';
  const messageBody =
    `[보다패스] ${targetName}님,\n` +
    `${siteName}\n${member.name}님(${member.phone})의\n얼굴인증이 아직 완료되지 않았습니다.\n\n` +
    `출퇴근 본인확인을 위해 다음 출근 시 사진 등록을 완료할 수 있도록 안내 부탁드립니다.\n\n` +
    `* 인증 안내 링크: https://bodapass.app/face/${member.id}`;

  async function handleSend() {
    setSending(true);
    try {
      await new Promise((r) => setTimeout(r, 300));
      window.alert(
        `${targetName}(${targetPhone})에게\n` +
          `${member.name}님의 얼굴인증 요청이 발송되었습니다.`,
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
      title="얼굴인증 요청 발송"
      subtitle={`${member.name} · ${siteName}`}
      width={520}
      footer={
        <div className="med__cta">
          <button type="button" className="team-list__btn team-list__btn--ghost" onClick={onClose} disabled={sending}>
            취소
          </button>
          <button type="button" className="team-list__btn team-list__btn--primary" onClick={handleSend} disabled={sending}>
            {sending ? '발송 중…' : '📧 요청 발송'}
          </button>
        </div>
      }
    >
      <div className="med">
        <div className="med__row">
          <label>요청 대상</label>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{targetName}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {foreman ? `${foreman.phone} · ${foreman.role || '반장'}` : '반장 미배정 — 현장담당자가 직접 처리'}
            </div>
          </div>
        </div>

        <div className="med__row" style={{ alignItems: 'flex-start' }}>
          <label style={{ paddingTop: 6 }}>메시지 미리보기</label>
          <pre
            style={{
              margin: 0,
              padding: '10px 12px',
              background: 'var(--color-bg-soft)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'inherit',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              color: 'var(--color-text)',
            }}
          >
            {messageBody}
          </pre>
        </div>
      </div>
    </Modal>
  );
}

/* ───────── 마스킹 ↔ 원본 토글 셀 (테이블에서 사용) ───────── */
function MaskCell({
  masked,
  raw,
  label,
}: {
  masked?: string;
  raw?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const text = open ? (raw || masked || '') : (masked || '');
  if (!masked) return null;
  return (
    <button
      type="button"
      className={'mask-cell' + (open ? ' is-open' : '')}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      title={open ? `${label} — 클릭하여 마스킹` : `${label} — 클릭하여 보기`}
    >
      <span className="mask-cell__text">{text}</span>
      <span className="mask-cell__icon" aria-hidden>{open ? '🙈' : '👁'}</span>
    </button>
  );
}

/* ───────── 정렬 가능한 컬럼 헤더 ───────── */

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onClick,
  numeric,
}: {
  label: string;
  col: MemberSortKey;
  sortKey: MemberSortKey;
  sortDir: 'asc' | 'desc';
  onClick: (col: MemberSortKey) => void;
  numeric?: boolean;
}) {
  const active = sortKey === col;
  return (
    <th
      className={
        (numeric ? 'team-table__num ' : '') +
        'team-table__sort' +
        (active ? ' is-active' : '')
      }
      onClick={() => onClick(col)}
    >
      {label}
      <span className="team-table__sort-ind" aria-hidden>
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

/* ───────── 직종별 카운트 칩 ───────── */

function RoleBreakdown({
  total,
  countByRole,
  activeRole,
  onSelect,
}: {
  total: number;
  countByRole: Map<string, number>;
  activeRole: string | null;
  onSelect: (role: string | null) => void;
}) {
  const entries = Array.from(countByRole.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'),
  );
  return (
    <div className="role-bd">
      <button
        type="button"
        className={'role-bd__chip role-bd__chip--all' + (!activeRole ? ' is-active' : '')}
        onClick={() => onSelect(null)}
      >
        전체 <em>{total}</em>
      </button>
      {entries.map(([role, count]) => (
        <button
          key={role}
          type="button"
          className={'role-bd__chip' + (activeRole === role ? ' is-active' : '')}
          onClick={() => onSelect(activeRole === role ? null : role)}
        >
          {role} <em>{count}</em>
        </button>
      ))}
    </div>
  );
}

/* ── 4대보험 가입 인디케이터 (4개 미니 점) ── */
/** 필수서류 상태 — 완료는 박스 없이 「✓계약」 평문, 미완료는 노란 워닝 chip */
function DocStatusChip({
  ok,
  label,
  okTitle,
  pendingTitle,
  onPendingClick,
}: {
  ok: boolean;
  label: string;
  okTitle?: string;
  pendingTitle: string;
  onPendingClick?: () => void;
}) {
  // 완료 → 평문 「✓계약」 (박스 없음, 옅은 회색 톤)
  if (ok) {
    return (
      <span className="doc-text" title={okTitle ?? `${label} 완료`}>
        ✓{label}
      </span>
    );
  }
  // 미완료 → 노란 워닝 chip
  if (onPendingClick) {
    return (
      <button
        type="button"
        className="doc-chip is-pending doc-chip--btn"
        onClick={onPendingClick}
        title={pendingTitle}
      >
        ! {label}
      </button>
    );
  }
  return (
    <span className="doc-chip is-pending" title={pendingTitle}>
      ! {label}
    </span>
  );
}

function InsuranceDots({ insurance }: { insurance?: InsuranceFlags }) {
  const ins = insurance ?? { pension: false, health: false, employment: false, accident: false };
  const items: { k: keyof InsuranceFlags; label: string; full: string }[] = [
    { k: 'pension', label: '국', full: '국민연금' },
    { k: 'health', label: '건', full: '건강보험' },
    { k: 'employment', label: '고', full: '고용보험' },
    { k: 'accident', label: '산', full: '산재보험' },
  ];
  return (
    <span className="ins-dots">
      {items.map((it) => (
        <span
          key={it.k}
          className={'ins-dot' + (ins[it.k] ? ' is-on' : '')}
          title={`${it.full} ${ins[it.k] ? '가입' : '미가입'}`}
        >
          {it.label}
        </span>
      ))}
    </span>
  );
}
