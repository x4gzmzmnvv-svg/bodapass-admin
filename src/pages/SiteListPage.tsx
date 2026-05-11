// FILE_VERSION 1777680002
import type { ReactNode } from 'react';
import { localDateStr } from '../utils/dateLocal';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { SiteRegisterDialog } from '../components/SiteRegisterDialog';
import { GeofenceMap } from '../components/GeofenceMap';
import { AddressField } from '../components/AddressField';
import { NumberStepper } from '../components/NumberStepper';
import { MacTimePicker } from '../components/MacTimePicker';
import {
  SubcontractorInviteDialog,
  JoinByCodeDialog,
} from '../components/SubcontractorDialogs';
import { siteApi } from '../api/site';
import { attendanceApi } from '../api/attendance';
import type { Foreman, Site, SiteCompany, Company } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import { apiClient } from '../api/client';
import { teamApi } from '../api/team';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { formatPhone } from '../utils/phone';
import { makeCompanyCode, formatBizNo as formatBizNoBase } from '../utils/companyCode';
import './SiteListPage.css';

import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
/**
 * 현장 관리 — 와이어프레임 025.png
 *
 * - 좌측 컬럼: 현장 목록 카드 + 검색/등록 버튼
 * - 우측: 선택한 현장의 상세 (공정률·담당자·인원수·반장·KPI)
 */
export function SiteListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requestedTab, setRequestedTab] = useState<'general' | 'geofence' | 'insurance' | 'external' | undefined>(undefined);
  const [sites, setSites] = useState<Site[]>([]);
  const [foremenAll, setForemenAll] = useState<Foreman[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [siteCompanies, setSiteCompanies] = useState<SiteCompany[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  /** 우측 폼 — 수정 모드 (헤더 버튼으로 토글) */
  const [editing, setEditing] = useState(false);
  const [editTick, setEditTick] = useState(0); // 취소 시 form reset 트리거
  const [saveTick, setSaveTick] = useState(0); // 저장 트리거 — SiteDetail 이 form → API 호출 후 onSaved
  const [completionOpen, setCompletionOpen] = useState(false);
  /** 하도급 초대 다이얼로그 — 어느 site 에 하도급사 초대할지 */
  const [subInviteSiteId, setSubInviteSiteId] = useState<string>('');
  /** 코드로 합류 다이얼로그 — 우리 회사가 다른 원도급사 현장에 합류 */
  const [joinByCodeOpen, setJoinByCodeOpen] = useState(false);
  /** 좌측 사이드 — 상태 필터 칩 */
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'IN_PROGRESS' | 'COMPLETED' | 'ACTION'>('ALL');
  /** 소규모 현장 표시 토글 — 기본 OFF (소규모 자동 숨김) */
  const [showSmall, setShowSmall] = useState(false);
  /** 다회사 참여(하도급) 펼치기 — 기본 OFF (필요할 때만 토글) */
  const [showCompanyBreakdown, setShowCompanyBreakdown] = useState(false);
  /** 오늘 출역 현장 — siteId → 오늘 출역 인원 수 매핑 */
  const [todayCountBySite, setTodayCountBySite] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, f, cRes, scRes, mRes] = await Promise.all([
        siteApi.listSites(),
        siteApi.listForemen(),
        apiClient.get<{ companies: Company[] }>('/companies'),
        apiClient.get<{ siteCompanies: SiteCompany[] }>('/site-companies'),
        teamApi.list({ status: 'ALL' }),
      ]);
      setSites(s.sites);
      setCompanies(cRes.data.companies ?? []);
      setSiteCompanies(scRes.data.siteCompanies ?? []);
      setMembers(mRes.members ?? []);
      setForemenAll(f.foremen);
      // 드로어가 열려 있던 현장은 유지, 그 외에는 닫힘 상태
      setSelectedId((id) => (id && s.sites.find((x) => x.id === id) ? id : null));

      // 「오늘 출역」 — 시공중 현장 전부에 대해 today() 병렬 호출
      const inProgress = s.sites.filter((x) => x.status === 'IN_PROGRESS');
      const todayResults = await Promise.allSettled(
        inProgress.map((x) => attendanceApi.today(x.id).then((r) => ({ siteId: x.id, t: r }))),
      );
      const counts = new Map<string, number>();
      for (const r of todayResults) {
        if (r.status === 'fulfilled' && r.value) {
          const sm = r.value.t.summary;
          const c = (sm?.workingCount ?? 0) + (sm?.doneCount ?? 0);
          counts.set(r.value.siteId, c);
        }
      }
      setTodayCountBySite(counts);
    } catch (err) {
      setError(getErrorMessage(err, '현장 목록 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // siteId → SiteCompany[] 매핑 (그 site 에 들어와 있는 회사들)
  const scsBySite = new Map<string, SiteCompany[]>();
  for (const sc of siteCompanies) {
    if (sc.status !== 'ACTIVE') continue;
    const arr = scsBySite.get(sc.siteId) ?? [];
    arr.push(sc);
    scsBySite.set(sc.siteId, arr);
  }
  const companyById = new Map(companies.map((c) => [c.id, c] as const));

  const filtered = sites.filter((s) => {
    // 상태 필터
    if (statusFilter === 'ACTION') {
      if (siteNeedsAction(s) === null) return false;
    } else if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
    // 소규모 숨김
    if (!showSmall && s.scale === 'SMALL') return false;
    // 검색 필터
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q) ||
      s.client.toLowerCase().includes(q) ||
      s.manager.toLowerCase().includes(q)
    );
  });

  // 상태별 카운트 (필터 칩에 표시)
  const statusCounts = {
    all: sites.length,
    inProgress: sites.filter((s) => s.status === 'IN_PROGRESS').length,
    completed: sites.filter((s) => s.status === 'COMPLETED').length,
  };

  const selected = sites.find((s) => s.id === selectedId) ?? null;
  const foremen = foremenAll.filter((f) => f.siteId === selectedId);

  const totalContract = sites.reduce((sum, s) => sum + s.contractAmount, 0);

  // ─── 「조치 필요」 현장 ───
  // 시공중 현장 중 다음 중 하나라도 해당:
  //  · 반장 미배정 (foremen 0명)
  //  · GPS(지오펜스) 미설정 — geofence 자체가 없거나 lat/lng 0
  //  · 하도급 미연결 — SiteCompany 가 원도급 1개뿐 (하도급 0개)
  //  · 정산대기 — site.status === 'SETTLEMENT_PENDING' (또는 status 가 PAUSED)
  /**
   * 「조치 필요」 — 시공·계획 단계에서 데이터·운영 결함이 있으면 KPI 카운트에 포함.
   *  · COMPLETED 는 정산 끝난 사이트 → 검사 X
   *  · 그 외(IN_PROGRESS / PLANNED / SETTLEMENT_PENDING / PAUSED) 모두 데이터 결함 + 명시적 문제 상태 검사
   *  · 사용자가 「시공중」으로 설정한 상태도 반장 미배정 등 실제 문제는 KPI 에 반영
   */
  function siteNeedsAction(s: Site): { reason: string } | null {
    if (s.status === 'COMPLETED') return null;
    // 명시적 문제 상태
    if ((s.status as string) === 'SETTLEMENT_PENDING') return { reason: '정산대기' };
    if ((s.status as string) === 'PAUSED') return { reason: '운영 일시중지' };
    // 데이터 결함 — 시공중·계획 모두 검사
    const fm = foremenAll.filter((f) => f.siteId === s.id);
    if (fm.length === 0) return { reason: '반장 미배정' };
    const g = s.geofence;
    if (!g || (g.lat === 0 && g.lng === 0)) return { reason: 'GPS 미설정' };
    const scs = scsBySite.get(s.id) ?? [];
    const hado = scs.filter((sc) => sc.role === '하도급').length;
    if (hado === 0) return { reason: '하도급 미연결' };
    return null;
  }
  const actionSites = sites.filter((s) => siteNeedsAction(s) !== null);
  const actionRequiredCount = actionSites.length;
  const todayActiveCount = Array.from(todayCountBySite.values()).filter((n) => n > 0).length;

  /** 워닝 chip 클릭 — 해당 영역으로 이동/드로어 오픈 + 자동 편집 모드 */
  function openSiteAt(siteId: string, tab: 'general' | 'geofence' | 'external', autoEdit = false) {
    setRequestedTab(tab);
    setSelectedId(siteId);
    if (autoEdit) setEditing(true);
  }
  function goForemen(siteId: string) {
    navigate(`/foremen?siteId=${encodeURIComponent(siteId)}`);
  }
  function goAttendance(siteId: string) {
    navigate(`/attendance?siteId=${encodeURIComponent(siteId)}`);
  }
  function goWage(siteId: string) {
    navigate(`/wage?siteId=${encodeURIComponent(siteId)}`);
  }

  // ─── 행 표시용 헬퍼 ───
  /** 종료일까지 남은 일수 (음수면 지연). 100% 면 그냥 100% 만 표시 */
  function daysRemaining(endDate: string): number {
    if (!endDate) return 0;
    const end = new Date(endDate).getTime();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((end - today.getTime()) / 86_400_000);
  }
  function progressLabel(s: Site): string {
    if (s.progressPercent >= 100) return '100%';
    const d = daysRemaining(s.endDate);
    if (d > 0) return `${s.progressPercent}% · D-${d}`;
    if (d === 0) return `${s.progressPercent}% · D-day`;
    return `${s.progressPercent}% · D+${-d}`;
  }
  function gpsLabel(s: Site): { ok: boolean; text: string; ended: boolean } {
    const g = s.geofence;
    const isSet = !!g && !(g.lat === 0 && g.lng === 0);
    // 준공 현장 — GPS 자동 해지 (좌표 설정 여부와 무관하게 모니터링 종료)
    if (s.status === 'COMPLETED') {
      return { ok: false, text: 'GPS 해지', ended: true };
    }
    return { ok: isSet, text: isSet ? 'GPS 설정' : 'GPS 미설정', ended: false };
  }
  /** 정산 컬럼 텍스트 — 시공중/확인필요/준공 */
  function settlementLabel(s: Site): string {
    if (s.status === 'COMPLETED') return '준공정산 완료';
    if (siteNeedsAction(s)) return '정산대기 없음';
    return '노무비 진행중';
  }
  /**
   * 상태 라벨 — 사용자 결정(`status`) 존중.
   *  · IN_PROGRESS → 시공중 (데이터 결함이 있어도 그대로 표시. 결함은 「운영」 셀의 칩으로 별도 안내)
   *  · COMPLETED → 준공
   *  · 그 외(PLANNED / SETTLEMENT_PENDING / PAUSED) + 결함이 있으면 → 확인필요
   */
  function statusInfo(s: Site): { label: string; cls: string } {
    if (s.status === 'COMPLETED') return { label: '준공', cls: 'done' };
    if (s.status === 'IN_PROGRESS') return { label: '시공중', cls: 'on' };
    if (siteNeedsAction(s)) return { label: '확인필요', cls: 'warn' };
    return { label: '시공중', cls: 'on' };
  }

  return (
    <div className="site-list">
      <PageHeader
        title="현장 관리"
        subtitle="공사 현장 등록 · 수정 · 준공 처리"
        actions={
          <div className="sl-actions">
            <button
              type="button"
              className="sl-btn sl-btn--ghost"
              onClick={() => setJoinByCodeOpen(true)}
              title="원도급사로부터 받은 초대 코드를 입력해 그 현장에 합류"
            >
              코드로 합류
            </button>
            <button
              type="button"
              className="sl-btn sl-btn--ghost"
              onClick={() => {
                if (sites.length === 0) {
                  window.alert('등록된 현장이 없습니다.\n먼저 현장을 등록해주세요.');
                  return;
                }
                const target =
                  selectedId ||
                  sites.find((s) => s.status === 'IN_PROGRESS')?.id ||
                  sites[0]?.id;
                if (target) setSubInviteSiteId(target);
              }}
              disabled={sites.length === 0}
              title="선택한 현장(또는 시공중 현장)에 하도급사 초대 코드를 발송"
            >
              + 하도급 등록
            </button>
            <button
              type="button"
              className="sl-btn sl-btn--primary"
              onClick={() => setSiteDialogOpen(true)}
            >
              + 현장 등록
            </button>
          </div>
        }
      />

      {error && <div className="site-list__error">{error}</div>}

      {/* ─── 현장관리 히어로 KPI (iOS 알림 카드 스타일 — 인력관리·일일출역확정과 통일) ─── */}
      <div className="team-hero">
        {([
          { key: 'ALL',         title: '전체 현장',  count: statusCounts.all,        sub: '개 등록',  tone: 'plain',  filterable: true,  filterKey: 'ALL'         },
          { key: 'IN_PROGRESS', title: '시공중',     count: statusCounts.inProgress, sub: '개 진행',  tone: 'info',   filterable: true,  filterKey: 'IN_PROGRESS' },
          { key: 'COMPLETED',   title: '준공',       count: statusCounts.completed,  sub: '개 완료',  tone: 'plain',  filterable: true,  filterKey: 'COMPLETED'   },
          { key: 'ACTION',      title: '조치 필요',  count: actionRequiredCount,     sub: '건 점검',  tone: 'amber',  filterable: true,  filterKey: 'ACTION'      },
          { key: 'ACTIVE',      title: '오늘 출역',  count: todayActiveCount,        sub: '개 활동',  tone: 'ok',     filterable: false, filterKey: null          },
          { key: 'CONTRACT',    title: '도급금액',   count: krwShort(totalContract), sub: '',        tone: 'plain',  filterable: false, filterKey: null          },
        ] as const).map((it) => {
          const active = it.filterable && statusFilter === it.filterKey;
          const Tag: 'button' | 'div' = it.filterable ? 'button' : 'div';
          const onClick = it.filterable
            ? () => setStatusFilter((cur) => (it.filterKey === 'ALL' ? 'ALL' : (cur === it.filterKey ? 'ALL' : it.filterKey as typeof statusFilter)))
            : undefined;
          const titleHint =
            it.key === 'ACTION'
              ? (actionSites.length === 0
                  ? '조치 필요 현장 없음'
                  : '반장 미배정 · GPS 미설정 · 하도급 미연결 · 정산대기 등\n· '
                    + actionSites.map((s) => `${s.name} (${siteNeedsAction(s)?.reason})`).join('\n· '))
              : it.key === 'ACTIVE'
                ? '시공중 현장 중 오늘 출역자(체크인 1명 이상)가 있는 현장'
                : `${it.title} 보기`;
          return (
            <Tag
              key={it.key}
              {...(it.filterable ? { type: 'button' as const } : {})}
              className={'team-hero__tile team-hero__tile--' + it.tone + (active ? ' is-active' : '')}
              onClick={onClick}
              title={titleHint}
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
            </Tag>
          );
        })}
      </div>

      {/* ─── 검색 줄 (히어로 아래) — 좌: 참여회사 보기 + 준공 / 우: 검색바 + 시공중 카운트 ─── */}
      <div className="sl-search-row">
        <div className="sl-search-row__left">
          <label className="sl-toggle sl-toggle--inline">
            <input
              type="checkbox"
              checked={showCompanyBreakdown}
              onChange={(e) => setShowCompanyBreakdown(e.target.checked)}
            />
            <span>참여회사 보기</span>
          </label>
          <button
            type="button"
            className="sl-btn sl-btn--ghost"
            onClick={() => setCompletionOpen(true)}
            disabled={sites.length === 0}
            title="현장 준공 처리"
          >
            준공
          </button>
        </div>
        <div className="sl-search-row__right">
          <div className="sl-search">
            <input
              type="text"
              className="sl-search__input"
              placeholder="현장명·주소·담당자·발주처 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="sl-search__clear"
                onClick={() => setSearch('')}
                aria-label="지우기"
              >
                ×
              </button>
            )}
          </div>
          <span className="sl-search-row__count">
            시공중 <strong>{statusCounts.inProgress}</strong>개소
          </span>
        </div>
      </div>

      {/* 메인 테이블 — 한 행 = 한 현장 */}
      <section className="sl-table card">

        {loading ? (
          <div className="sl-table__loading">불러오는 중…</div>
        ) : filtered.length === 0 ? (
          <div className="sl-table__empty">
            <p>{search ? '검색 결과가 없습니다.' : '등록된 현장이 없습니다.'}</p>
            {!search && (
              <button
                type="button"
                className="sl-btn sl-btn--primary"
                onClick={() => setSiteDialogOpen(true)}
              >
                ＋ 첫 현장 등록
              </button>
            )}
          </div>
        ) : (
          <div className="sl-table__scroll">
            <table className="sl-table__t">
              <thead>
                <tr>
                  <th>현장</th>
                  <th>도급/금액</th>
                  <th className="sl-table__th-num">공정</th>
                  <th>운영</th>
                  <th>정산</th>
                  <th>상태</th>
                  <th aria-label="액션"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const fc = foremenAll.filter((f) => f.siteId === s.id).length;
                  const isActive = selectedId === s.id;
                  const scs = scsBySite.get(s.id) ?? [];
                  const subCompanies = scs.filter((sc) => sc.role === '하도급');
                  return (
                    <Fragment key={s.id}>
                      <tr
                        className={
                          'sl-row' +
                          (isActive ? ' is-active' : '') +
                          (s.scale === 'SMALL' ? ' sl-row--small' : '') +
                          (s.status === 'COMPLETED' ? ' sl-row--completed' : '')
                        }
                      >
                        {/* 1. 현장 */}
                        <td className="sl-row__name">
                          <strong>{s.name}</strong>
                          <span className="sl-row__name-sub">{s.address}</span>
                        </td>
                        {/* 2. 도급/금액 */}
                        <td className="sl-row__contract">
                          <span
                            className={
                              'sl-kind sl-kind--' +
                              (s.contractKind === '원도급' ? 'prime' : 'sub')
                            }
                          >
                            {s.contractKind}
                          </span>
                          <span className="sl-row__contract-sep">·</span>
                          <strong className="sl-row__contract-amt">{krwShort(s.contractAmount)}</strong>
                          {s.scale === 'SMALL' && (
                            <span className="sl-tag-small" title="소규모 현장">소규모</span>
                          )}
                        </td>
                        {/* 3. 공정 (퍼센트 + D-N) */}
                        <td className="sl-row__progress-cell">
                          <div className="sl-progress">
                            <div className="sl-progress__bar">
                              <div
                                className="sl-progress__fill"
                                style={{ width: `${s.progressPercent}%` }}
                              />
                            </div>
                            <span className="sl-progress__text">{progressLabel(s)}</span>
                          </div>
                        </td>
                        {/* 4. 운영 — 반장 N · 오늘 N · GPS (워닝은 클릭 가능) */}
                        <td className="sl-row__ops">
                          {(() => {
                            const gps = gpsLabel(s);
                            const today = todayCountBySite.get(s.id) ?? 0;
                            const noForeman = fc === 0;
                            const todayWarn = today === 0 && s.status === 'IN_PROGRESS';
                            return (
                              <span className="sl-ops">
                                {noForeman ? (
                                  <button
                                    type="button"
                                    className="sl-ops__chip is-warn sl-ops__chip--badge sl-ops__chip--btn"
                                    onClick={(e) => { e.stopPropagation(); goForemen(s.id); }}
                                    title="반장 관리 페이지로 이동"
                                  >반장 미배정</button>
                                ) : (
                                  <button
                                    type="button"
                                    className="sl-ops__chip sl-ops__chip--btn"
                                    onClick={(e) => { e.stopPropagation(); goForemen(s.id); }}
                                    title="이 현장의 반장 보기"
                                  >반장 {fc}명</button>
                                )}
                                <span className="sl-ops__sep">·</span>
                                <button
                                  type="button"
                                  className={'sl-ops__chip sl-ops__chip--btn' + (todayWarn ? ' is-warn' : '')}
                                  onClick={(e) => { e.stopPropagation(); goAttendance(s.id); }}
                                  title={todayWarn ? '오늘 출역자가 없음 — 출퇴근 페이지로 이동' : '오늘 출퇴근 현황으로 이동'}
                                >오늘 {today}명</button>
                                <span className="sl-ops__sep">·</span>
                                {gps.ok ? (
                                  <button
                                    type="button"
                                    className="sl-ops__chip sl-ops__chip--gps sl-ops__chip--btn is-live"
                                    onClick={(e) => { e.stopPropagation(); openSiteAt(s.id, 'geofence'); }}
                                    title="지오펜스 좌표·반경 설정 보기/수정"
                                  >
                                    <span className="sl-ops__gps-dot" aria-hidden />
                                    {gps.text}
                                  </button>
                                ) : (
                                  /* 준공 또는 미설정 — pill 없이 회색 plain text + 회색 dot */
                                  <span className="sl-ops__gps-text" title={gps.ended ? '준공 현장 — GPS 모니터링 해지됨' : 'GPS 좌표 미설정'}>
                                    <span className="sl-ops__gps-dot sl-ops__gps-dot--off" aria-hidden />
                                    {gps.text}
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </td>
                        {/* 5. 정산 — 클릭 시 노임/임금 페이지로 */}
                        <td className="sl-row__settle">
                          <button
                            type="button"
                            className={
                              'sl-settle sl-settle--btn sl-settle--' +
                              (s.status === 'COMPLETED'
                                ? 'done'
                                : siteNeedsAction(s)
                                ? 'pending'
                                : 'progress')
                            }
                            onClick={(e) => { e.stopPropagation(); goWage(s.id); }}
                            title="노임/임금 정산 페이지로 이동"
                          >
                            {settlementLabel(s)}
                          </button>
                        </td>
                        {/* 6. 상태 — 시공중/확인필요/준공 (확인필요는 클릭으로 세부내용 진입) */}
                        <td>
                          {(() => {
                            const si = statusInfo(s);
                            const needs = siteNeedsAction(s);
                            if (si.cls === 'warn' && needs) {
                              // 확인필요 사유에 따라 적절한 탭으로
                              const targetTab: 'general' | 'geofence' | 'external' =
                                needs.reason === 'GPS 미설정' ? 'geofence'
                                : needs.reason === '하도급 미연결' ? 'external'
                                : 'general';
                              return (
                                <button
                                  type="button"
                                  className="sl-status sl-status--warn sl-status--btn"
                                  onClick={(e) => { e.stopPropagation(); openSiteAt(s.id, targetTab, true); }}
                                  title={`${needs.reason} — 클릭하면 해당 탭으로 이동`}
                                >{si.label}</button>
                              );
                            }
                            return (
                              <span className={'sl-status sl-status--' + si.cls}>{si.label}</span>
                            );
                          })()}
                        </td>
                        <td className="sl-row__action-cell">
                          <button
                            type="button"
                            className="sl-row__action sl-row__action--labeled"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(s.id);
                            }}
                            aria-label="세부내용 보기"
                            title="상세 보기 / 수정"
                          >
                            <span className="sl-row__action-label">세부내용</span>
                            <span className="sl-row__action-arrow" aria-hidden>›</span>
                          </button>
                        </td>
                      </tr>

                      {/* 하도급 펼침 행 — 토글 ON 일 때만 */}
                      {showCompanyBreakdown &&
                        subCompanies.map((sc) => {
                          const co = companyById.get(sc.companyId);
                          const subForemenCnt = foremenAll.filter(
                            (f) => f.siteCompanyId === sc.id,
                          ).length;
                          const subTrade = sc.trade ?? sc.specialty;
                          return (
                            <tr key={sc.id} className="sl-row sl-row--child">
                              {/* 1. 현장 — 들여쓰기 + 회사명 + 현장 부제 */}
                              <td className="sl-row__name">
                                <span className="sl-row__indent" aria-hidden>└</span>
                                <strong>{co?.name ?? sc.companyId}</strong>
                                <span className="sl-row__name-sub">{s.name}</span>
                              </td>
                              {/* 2. 도급/금액 — 하도급(공종) · 금액 */}
                              <td className="sl-row__contract">
                                <span className="sl-kind sl-kind--sub">하도급</span>
                                {subTrade && <span className="sl-tag-spec">{subTrade}</span>}
                                <span className="sl-row__contract-sep">·</span>
                                <strong className="sl-row__contract-amt">
                                  {sc.contractAmount ? krwShort(sc.contractAmount) : '—'}
                                </strong>
                              </td>
                              {/* 3. 공정 */}
                              <td className="sl-row__progress-cell">
                                {typeof sc.progressPercent === 'number' ? (
                                  <div className="sl-progress">
                                    <div className="sl-progress__bar">
                                      <div
                                        className="sl-progress__fill"
                                        style={{ width: `${sc.progressPercent}%` }}
                                      />
                                    </div>
                                    <span className="sl-progress__text">{sc.progressPercent}%</span>
                                  </div>
                                ) : '—'}
                              </td>
                              {/* 4. 운영 — 하도급 행은 반장 수만 노출 (오늘/GPS는 사이트 단위라 생략) */}
                              <td className="sl-row__ops">
                                <span className="sl-ops">
                                  <span className={'sl-ops__chip' + (subForemenCnt === 0 ? ' is-warn sl-ops__chip--badge' : '')}>
                                    {subForemenCnt === 0 ? '반장 미배정' : `반장 ${subForemenCnt}명`}
                                  </span>
                                </span>
                              </td>
                              {/* 5. 정산 — 하도급은 별도 정산 칸 사용 안 함 */}
                              <td className="sl-row__settle">
                                <span className="sl-settle sl-settle--muted">—</span>
                              </td>
                              {/* 6. 상태 */}
                              <td>
                                <span
                                  className={
                                    'sl-status sl-status--' +
                                    (sc.status === 'ACTIVE' ? 'on' : sc.status === 'INVITED' ? 'planned' : 'paused')
                                  }
                                >
                                  {sc.status === 'ACTIVE' ? '시공중' : sc.status === 'INVITED' ? '초대됨' : '차단'}
                                </span>
                              </td>
                              <td className="sl-row__action-cell" />
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 우측 슬라이드 드로어 — 현장 상세 + 수정 */}
      {selected && (
        <SiteDrawer
          site={selected}
          foremen={foremen}
          editing={editing}
          resetTick={editTick}
          saveTick={saveTick}
          siteCompanies={siteCompanies}
          companies={companies}
          members={members}
          myCompanyId={user?.companyId ?? ''}
          requestedTab={requestedTab}
          onEditToggle={() => setEditing((v) => !v)}
          onSave={() => setSaveTick((t) => t + 1)}
          onCancel={() => {
            setEditing(false);
            setEditTick((t) => t + 1);
          }}
          onClose={() => {
            setSelectedId(null);
            setEditing(false);
          }}
          onSaved={async () => {
            await load();
            setEditing(false);
          }}
        />
      )}

      <SiteRegisterDialog
        open={siteDialogOpen}
        onClose={() => setSiteDialogOpen(false)}
        onCreated={(s) => {
          setSelectedId(s.id);
          load();
        }}
      />

      {subInviteSiteId &&
        (() => {
          const target = sites.find((s) => s.id === subInviteSiteId);
          if (!target) return null;
          return (
            <SubcontractorInviteDialog
              site={target}
              sites={sites}
              onSiteChange={(id) => setSubInviteSiteId(id)}
              siteCompanies={siteCompanies}
              companies={companies}
              onClose={() => setSubInviteSiteId('')}
            />
          );
        })()}

      {joinByCodeOpen && (
        <JoinByCodeDialog
          companyId={user?.companyId ?? ''}
          companyName={user?.companyName ?? ''}
          onClose={() => setJoinByCodeOpen(false)}
          onJoined={async () => {
            setJoinByCodeOpen(false);
            await load();
          }}
        />
      )}

      {completionOpen && (
        <CompletionDialog
          sites={sites.filter((s) => s.status !== 'COMPLETED')}
          defaultSiteId={selectedId ?? undefined}
          onClose={() => setCompletionOpen(false)}
          onConfirm={async (siteId, dateISO) => {
            const target = sites.find((s) => s.id === siteId);
            // eslint-disable-next-line no-console
            console.log('[준공] siteId=', siteId, 'date=', dateISO, 'target=', target?.name);
            try {
              const res = await siteApi.updateSite(siteId, {
                status: 'COMPLETED',
                endDate: dateISO,
                progressPercent: 100,
              });
              // eslint-disable-next-line no-console
              console.log('[준공] API 응답=', res);
              await load(); // 사이트 목록 갱신 → UI 즉시 반영
              window.alert(
                (target?.name ?? '현장') +
                  ' 준공 처리가 완료되었습니다.\n' +
                  '· 준공일 : ' +
                  dateISO +
                  '\n· 공정률 : 100%',
              );
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('[준공 실패]', err);
              window.alert(
                '준공 처리 실패\n원인: ' +
                  getErrorMessage(err, '서버 오류') +
                  '\n\n개발자 콘솔(F12)에서 자세한 에러를 확인하세요.\n' +
                  'Mock API가 갱신되지 않았다면 dev server를 재시작(Ctrl+C 후 npm run dev)해주세요.',
              );
            }
            setCompletionOpen(false);
          }}
        />
      )}

    </div>
  );
}

/* ────────── 모듈 헬퍼 ────────── */

function krwShort(n: number): string {
  if (!n) return '0원';
  if (n >= 100_000_000_000) return (n / 100_000_000_000).toFixed(1) + '천억';
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return n.toLocaleString();
}

/* ────────── 우측 슬라이드 드로어 — 현장 상세 + 수정 ────────── */

function SiteDrawer({
  site,
  foremen,
  editing,
  resetTick,
  saveTick,
  onEditToggle,
  onSave,
  onCancel,
  onClose,
  onSaved,
  siteCompanies,
  companies,
  members,
  myCompanyId,
  requestedTab,
}: {
  site: Site;
  foremen: Foreman[];
  editing: boolean;
  resetTick: number;
  saveTick: number;
  onEditToggle: () => void;
  onSave: () => void;
  onCancel: () => void;
  onClose: () => void;
  onSaved: () => void;
  siteCompanies: SiteCompany[];
  companies: Company[];
  members: TeamMember[];
  myCompanyId: string;
  /** 외부에서 특정 탭을 열도록 요청 (워닝 chip 클릭 시) */
  requestedTab?: 'general' | 'geofence' | 'insurance' | 'external';
}) {
  // 우측 폼 탭 — 일반/세부/보험
  const [tab, setTab] = useState<'general' | 'geofence' | 'insurance' | 'external'>('general');

  // 이 site 의 참여 회사 + 각자 작업자 수 집계
  const scsInSite = siteCompanies.filter((sc) => sc.siteId === site.id && sc.status === 'ACTIVE');
  const companyById = new Map(companies.map((c) => [c.id, c] as const));
  const memberCountBySc = new Map<string, number>();
  for (const m of members) {
    if (m.siteId !== site.id || !m.siteCompanyId) continue;
    memberCountBySc.set(m.siteCompanyId, (memberCountBySc.get(m.siteCompanyId) ?? 0) + 1);
  }

  // 시점 (어느 SiteCompany 로 보고 있는지) — 기본값: 내 회사 SC, 없으면 첫 SC
  const myOwnSc = scsInSite.find((sc) => sc.companyId === myCompanyId);
  const [viewAsScId, setViewAsScId] = useState<string>(
    myOwnSc?.id ?? scsInSite[0]?.id ?? '',
  );
  const viewAs = scsInSite.find((sc) => sc.id === viewAsScId) ?? myOwnSc ?? scsInSite[0];
  const isMyView = viewAs?.companyId === myCompanyId;
  // 사회보험 탭은 자기 회사 시점일 때만 / 수정도 자기 회사 시점일 때만
  const canEdit = isMyView;
  const showInsuranceTab = isMyView;
  // 보고 있던 탭이 사회보험인데 시점 바꿔서 숨겨지면 일반현황으로 폴백
  useEffect(() => {
    if (!showInsuranceTab && tab === 'insurance') setTab('general');
  }, [showInsuranceTab, tab]);
  // 외부(워닝 chip)에서 특정 탭을 요청하면 즉시 전환
  useEffect(() => {
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab, site.id]);

  return (
    <div
      className="sl-drawer__backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="sl-drawer">
        <header className="sl-drawer__head">
          <div className="sl-drawer__title">
            <span
              className={
                'sl-status sl-status--' +
                (site.status === 'IN_PROGRESS'
                  ? 'on'
                  : site.status === 'COMPLETED'
                  ? 'done'
                  : site.status === 'PLANNED'
                  ? 'planned'
                  : 'paused')
              }
            >
              {site.status === 'IN_PROGRESS'
                ? '시공중'
                : site.status === 'COMPLETED'
                ? '준공'
                : site.status === 'PLANNED'
                ? '예정'
                : '중단'}
            </span>
            <h2>{site.name}</h2>
          </div>
          <div className="sl-drawer__head-actions">
            {!editing && canEdit && (
              <button type="button" className="sl-btn sl-btn--ghost" onClick={onEditToggle}>
                ✎ 수정
              </button>
            )}
            {editing && (
              <>
                <button type="button" className="sl-btn sl-btn--primary" onClick={onSave}>
                  저장
                </button>
                <button type="button" className="sl-btn sl-btn--ghost" onClick={onCancel}>
                  취소
                </button>
              </>
            )}
            <button
              type="button"
              className="sl-drawer__close"
              onClick={onClose}
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        </header>

        {/* 참여 회사 — 텍스트 요약 (발주처 / 감리업체 / 협력업체 N개소) */}
        {scsInSite.length > 0 && (
          <section className="sl-parties sl-parties--summary">
            <div className="sl-parties__summary">
              <span className="sl-parties__summary-item">
                <strong>발주처</strong> {site.client || <em className="sl-parties__summary-muted">—</em>}
              </span>
              <span className="sl-parties__summary-sep">·</span>
              <span className="sl-parties__summary-item">
                <strong>감리업체</strong>{' '}
                {site.qualityInspector?.name ? (
                  site.qualityInspector.name
                ) : (
                  <em className="sl-parties__summary-muted">—</em>
                )}
              </span>
              <span className="sl-parties__summary-sep">·</span>
              <span className="sl-parties__summary-item">
                <strong>협력업체</strong>{' '}
                <span className="sl-parties__summary-count">
                  {scsInSite.filter((sc) => sc.role === '하도급').length}개소
                </span>
              </span>
            </div>
            <span className="sl-parties__hint">
              <span className="sl-parties__code-row">
                <span className="sl-parties__code-label">원도급 코드</span>
                <code className="sl-parties__code">{makePrimeInviteCode(site.id, site.address, site.startDate)}</code>
              </span>
            </span>
          </section>
        )}

        {/* 폼 탭 — 4개 (기본정보 / 출역정책 / 사회보험 / 협력업체) */}
        <nav className="sl-drawer__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'general'}
            className={'sl-drawer__tab' + (tab === 'general' ? ' is-active' : '')}
            onClick={() => setTab('general')}
          >
            기본정보
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'geofence'}
            className={'sl-drawer__tab' + (tab === 'geofence' ? ' is-active' : '')}
            onClick={() => setTab('geofence')}
          >
            출역정책
          </button>
          {showInsuranceTab && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'insurance'}
              className={'sl-drawer__tab' + (tab === 'insurance' ? ' is-active' : '')}
              onClick={() => setTab('insurance')}
            >
              사회보험
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'external'}
            className={'sl-drawer__tab' + (tab === 'external' ? ' is-active' : '')}
            onClick={() => setTab('external')}
          >
            협력업체
          </button>

          {!isMyView && (
            <span className="sl-drawer__readonly-badge" title="다른 회사 정보는 읽기 전용입니다">
              🔒 읽기 전용
            </span>
          )}
        </nav>

        <div className="sl-drawer__body">
          <SiteDetail
            site={site}
            siteCompany={viewAs}
            foremen={foremen}
            editing={editing}
            resetTick={resetTick}
            saveTick={saveTick}
            activeTab={tab}
            onSaved={onSaved}
            siteCompanies={scsInSite}
            companies={companies}
          />
        </div>
      </aside>
    </div>
  );
}

/* ── 우측 상세 — 일반현황 / 세부내용 / 4대보험 ── */

interface SiteFormState {
  contractKind: string;
  name: string;
  contractAmount: number;
  startDate: string;
  endDate: string;
  client: string;
  contractType: string;
  address: string;
  addressPostal: string;
  addressDetail: string;
  manager: string;
  managerPhone: string;
  siteAgent: string;
  siteAgentPhone: string;
  safetyManager: string;
  safetyManagerPhone: string;
  qualityTester: string;
  qualityTesterPhone: string;
  supervisorCompany: string;
  supervisorPhone: string;
  supervisorContact: string;
  supervisorAddress: string;
  /** 발주기관 배열 (양식: 다수 가능) */
  clients: Array<{ company: string; contact: string; phone: string }>;
  /** 감리업체 배열 */
  supervisors: Array<{ company: string; contact: string; phone: string }>;
  /** 지오펜싱 출퇴근 정책 — 좌표·반경·GPS오차·위치필수·현장밖정책 */
  geofence?: import('../api/site.types').SiteGeofence;
  /** 출근 인증 정책 — 출근 허용 시간대 / 수동보정 승인 / 기본 공수 / 퇴근 인증 방식 */
  attendanceWindowStart: string;       // '05:00'
  attendanceWindowEnd: string;         // '09:00'
  requireManualApproval: boolean;      // 수동보정 승인 필요
  defaultGongsu: number;               // 1.0
  checkoutMode: 'EXCEPTION' | 'STRICT';// 예외 입력형 / 출퇴근 인증형
  /** 운영상태 — 시공중 / 중지 / 준공 / 정산대기 */
  siteStatus: 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'SETTLEMENT_PENDING';
  contractDate: string;
  groundBreakingDate: string;
  publicNoticeDate: string;
  insuranceBaseDate: string;
  empInsuranceMgmtNo: string;
  woundInsuranceMgmtNo: string;
  healthInsuranceMgmtNoDaily: string;
  healthInsuranceMgmtNoRegular: string;
  pensionMgmtNoDaily: string;
  pensionMgmtNoRegular: string;
  retireMutualNo: string;
  retireMutualStartDate: string;
  kiscon: string;
  empInsuranceStartDate: string;
  woundInsuranceStartDate: string;
  healthInsuranceStartDateDaily: string;
  healthInsuranceStartDateRegular: string;
  pensionStartDateDaily: string;
  pensionStartDateRegular: string;
}

/**
 * SiteCompany 시점이 있으면 그쪽 도급/금액/기간을 우선 사용 (하도급 보기).
 * 없으면 site (원도급 시점) 그대로.
 */
function buildInitial(site: Site, sc?: SiteCompany | null): SiteFormState {
  const useSc = !!sc && sc.role !== '원도급';
  return {
    contractKind: useSc ? sc!.role : (site.contractKind || '원도급'),
    name: site.name,
    contractAmount: useSc ? (sc!.contractAmount ?? 0) : site.contractAmount,
    startDate: useSc ? (sc!.startDate ?? site.startDate) : site.startDate,
    endDate: useSc ? (sc!.endDate ?? site.endDate) : site.endDate,
    client: site.client,
    contractType: '공공',
    address: site.address,
    addressPostal: '',
    addressDetail: site.addressDetail || '',
    manager: site.manager,
    managerPhone: site.managerPhone,
    siteAgent: site.siteAgent?.name ?? '',
    siteAgentPhone: site.siteAgent?.phone ?? '',
    safetyManager: site.safetyOfficer?.name ?? '',
    safetyManagerPhone: site.safetyOfficer?.phone ?? '',
    qualityTester: site.qualityInspector?.name ?? '',
    qualityTesterPhone: site.qualityInspector?.phone ?? '',
    supervisorCompany: '',
    supervisorPhone: '',
    supervisorContact: '',
    supervisorAddress: '',
    clients: [{ company: site.client ?? '', contact: site.manager ?? '', phone: site.managerPhone ?? '' }],
    supervisors: [{ company: '', contact: '', phone: '' }],
    // 기존 site.geofence 로드 (없으면 기본값 — 서울시청 좌표)
    geofence: site.geofence ?? {
      lat: 37.5665, lng: 126.9780,
      radiusM: 100, gpsTolerance: 30,
      locationRequired: 'RECOMMENDED',
      outOfBoundsPolicy: 'WARN',
    },
    // 출근 인증 정책 기본값 (백엔드 스키마 미연동 — UI 모드)
    attendanceWindowStart: '05:00',
    attendanceWindowEnd: '09:00',
    requireManualApproval: true,
    defaultGongsu: 1.0,
    checkoutMode: 'EXCEPTION',
    siteStatus:
      site.status === 'COMPLETED' ? 'COMPLETED' :
      site.status === 'PAUSED' ? 'PAUSED' :
      'IN_PROGRESS',
    contractDate: site.startDate,
    groundBreakingDate: site.startDate,
    publicNoticeDate: '',
    insuranceBaseDate: '',
    empInsuranceMgmtNo: '',
    woundInsuranceMgmtNo: '',
    healthInsuranceMgmtNoDaily: '',
    healthInsuranceMgmtNoRegular: '',
    pensionMgmtNoDaily: '',
    pensionMgmtNoRegular: '',
    retireMutualNo: '25-01101-0001',
    retireMutualStartDate: '',
    kiscon: '',
    empInsuranceStartDate: '',
    woundInsuranceStartDate: '',
    healthInsuranceStartDateDaily: '',
    healthInsuranceStartDateRegular: '',
    pensionStartDateDaily: '',
    pensionStartDateRegular: '',
  };
}


/**
 * 식별 체계 — 코드 1종 + 자연 식별자 1종으로 단순화
 *  · 회사 식별   = 사업자번호 (국세청 발급, 자연 unique)
 *  · 현장 식별   = 현장 코드 (P-YY-RR-NNN)
 *  · 협력관계    = (현장 코드, 사업자번호) 페어 — 별도 코드 불필요
 *
 *  현장 코드 형식: P-YY-RR-NNN
 *    · YY  = 발행 연도 마지막 두 자리 (예: 26 = 2026)
 *    · RR  = 광역시도 코드 (행정안전부 표준)
 *             11 서울 · 26 부산 · 27 대구 · 28 인천 · 29 광주 · 30 대전 · 31 울산 · 36 세종
 *             41 경기 · 42 강원 · 43 충북 · 44 충남 · 45 전북 · 46 전남 · 47 경북 · 48 경남 · 50 제주
 *    · NNN = 시리얼 발행번호 (siteId 해시 기반 결정적)
 */

const REGION_CODE_MAP: Array<[RegExp, string]> = [
  [/^서울/, '11'], [/^부산/, '26'], [/^대구/, '27'],
  [/^인천/, '28'], [/^광주/, '29'], [/^대전/, '30'],
  [/^울산/, '31'], [/^세종/, '36'],
  [/^경기/, '41'], [/^강원/, '42'], [/^충청북도|^충북/, '43'],
  [/^충청남도|^충남/, '44'], [/^전라북도|^전북/, '45'],
  [/^전라남도|^전남/, '46'], [/^경상북도|^경북/, '47'],
  [/^경상남도|^경남/, '48'], [/^제주/, '50'],
];

function inferRegionCode(address?: string): string {
  if (!address) return '00';
  for (const [pat, code] of REGION_CODE_MAP) {
    if (pat.test(address)) return code;
  }
  return '00';
}

function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 현장 코드 (= 원도급이 협력업체에게 공유하는 가입 토큰) — P-YY-RR-NNN */
function makePrimeInviteCode(siteId: string, address?: string, contractDate?: string): string {
  const yy = (contractDate ? contractDate.slice(2, 4) : new Date().getFullYear().toString().slice(2));
  const rr = inferRegionCode(address);
  const nnn = String(hashStr(siteId) % 1000).padStart(3, '0');
  return `P-${yy}-${rr}-${nnn}`;
}

/** 사업자번호 포맷 — utils/companyCode.formatBizNo 의 alias (역방향 호환) */
function formatBizNo(bizNo?: string, companyId?: string): string {
  return formatBizNoBase(bizNo, companyId);
}

function SiteDetail({
  site,
  siteCompany,
  foremen = [],
  editing,
  resetTick,
  saveTick,
  activeTab,
  onSaved,
  siteCompanies = [],
  companies = [],
}: {
  site: Site;
  /** 시점 — 하도급 칩 클릭 시 그 SiteCompany 의 도급/금액/기간을 보여줌 */
  siteCompany?: SiteCompany | null;
  foremen: Foreman[];
  editing: boolean;
  resetTick: number;
  saveTick: number;
  /** 드로어에서 어떤 섹션을 보여줄지 — 미지정 시 전부 노출 (구버전 호환) */
  activeTab?: 'general' | 'geofence' | 'insurance' | 'external';
  onSaved: () => void;
  /** 외부업체 탭 — 이 현장의 SiteCompany 목록 (원도급 + 하도급 모두) */
  siteCompanies?: SiteCompany[];
  /** 회사 마스터 — SiteCompany.companyId → 회사 이름 매핑 */
  companies?: Company[];
}) {
  const initial = useMemo(() => buildInitial(site, siteCompany), [site, siteCompany]);
  const [form, setForm] = useState<SiteFormState>(initial);

  // 현장 또는 시점(SiteCompany) 변경 / 취소(resetTick) 시 폼 초기화
  useEffect(() => {
    setForm(buildInitial(site, siteCompany));
  }, [site.id, siteCompany?.id, resetTick]);

  // 헤더의 저장 버튼 클릭 → saveTick 변화 → 실제 API 호출
  useEffect(() => {
    if (saveTick === 0) return;
    (async () => {
      try {
        await siteApi.updateSite(site.id, {
          name: form.name,
          contractKind: form.contractKind as Site['contractKind'],
          contractAmount: form.contractAmount,
          startDate: form.startDate,
          endDate: form.endDate,
          client: form.client,
          address: form.address,
          addressDetail: form.addressDetail,
          manager: form.manager,
          managerPhone: form.managerPhone,
          // 지오펜싱 정책 — 좌표·반경·GPS오차·위치필수·현장밖정책
          geofence: form.geofence,
        });
        window.alert(form.name + ' 현장 정보가 저장되었습니다.');
        onSaved();
      } catch (err) {
        window.alert('저장 실패: ' + getErrorMessage(err, '서버 오류'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveTick]);

  function set<K extends keyof SiteFormState>(k: K, v: SiteFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  const ro = !editing;

  function fmtAmt(n: number) {
    if (!n) return '0원';
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억원';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만원';
    return n.toLocaleString() + '원';
  }

  // 탭 미지정 시 모두 보여주기 (이전 화면 호환)
  const show = (key: 'general' | 'geofence' | 'insurance' | 'external') =>
    !activeTab || activeTab === key;

  return (
    <div className="site-form">
      {/* === 기본정보 — 6개 서브 카드 구조 === */}
      {show('general') && (
      <>
      {/* 1) 기본정보 카드 — 행1: 현장명·발주처 / 행2: 발주구분·도급종류·공사금액 */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">기본정보</h3>
          {editing && (
            <span className="site-form__editing-badge">✎ 수정 모드</span>
          )}
        </header>
        {/* 식별자 요약 — 현장 코드 + 원도급사 회사 코드·사업자번호 */}
        {(() => {
          const ownerCo = companies.find((c) => c.id === site.ownerCompanyId);
          return (
            <div className="site-form__id-summary">
              <span className="site-form__id-block">
                <em>현장 코드</em>
                <code>{makePrimeInviteCode(site.id, site.address, site.contractDate)}</code>
              </span>
              <span className="site-form__id-block">
                <em>원도급사</em>
                <strong>{ownerCo?.name ?? '—'}</strong>
              </span>
              {ownerCo && (
                <>
                  <span className="site-form__id-block">
                    <em>회사 코드</em>
                    <code>{makeCompanyCode(ownerCo)}</code>
                  </span>
                  <span className="site-form__id-block">
                    <em>사업자번호</em>
                    <code>{formatBizNoBase(ownerCo.bizNo, ownerCo.id)}</code>
                  </span>
                </>
              )}
            </div>
          );
        })()}
        <div className="site-form__grid site-form__grid--basic-r1-span">
          <FormField label="현장명" big>
            <input type="text" className="site-form__big-input" value={form.name} readOnly={ro}
              onChange={(e) => set('name', e.target.value)} />
          </FormField>
          <FormField label="발주처" big>
            <input
              type="text"
              value={form.clients[0]?.company ?? ''}
              readOnly={ro}
              placeholder="발주기관명 (협력업체 탭에서 다수 등록 가능)"
              onChange={(e) => {
                const next = form.clients.length > 0
                  ? form.clients.map((c, i) => (i === 0 ? { ...c, company: e.target.value } : c))
                  : [{ company: e.target.value, contact: '', phone: '' }];
                set('clients', next);
              }}
            />
          </FormField>
        </div>
        <div className="site-form__grid site-form__grid--basic-r2">
          <FormField label="발주구분">
            <MacSelect
              value={form.contractType}
              onChange={(v) => set('contractType', v)}
              disabled={ro}
              options={[{ value: '', label: '공공' }, { value: '', label: '민간' }]}
            />
          </FormField>
          <FormField label="도급종류">
            <MacSelect
              value={form.contractKind}
              onChange={(v) => set('contractKind', v)}
              disabled={ro}
              options={[{ value: '', label: '원도급' }, { value: '', label: '하도급' }]}
            />
          </FormField>
          <FormField label="공사금액">
            <input type="text" inputMode="numeric"
              value={ro ? fmtAmt(form.contractAmount) : form.contractAmount.toLocaleString()}
              readOnly={ro}
              onChange={(e) => set('contractAmount', Number(e.target.value.replace(/\D/g, '')) || 0)} />
          </FormField>
        </div>
      </section>

      {/* 2) 담당자 카드 — 행1 소장/연락처, 행2 현장담당자/전화·안전관리자/전화·품질관리자/전화 */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">담당자</h3>
        </header>
        <div className="site-form__grid site-form__grid--gen-r3">
          <FormField label="소장">
            <input type="text" value={form.manager} readOnly={ro} onChange={(e) => set('manager', e.target.value)} />
          </FormField>
          <FormField label="연락처">
            <input type="tel" inputMode="numeric" value={form.managerPhone} readOnly={ro}
              onChange={(e) => set('managerPhone', formatPhone(e.target.value))} />
          </FormField>
        </div>
        <div className="site-form__grid site-form__grid--staff2">
          <FormField label="현장담당자">
            <input type="text" placeholder="이름" value={form.siteAgent} readOnly={ro}
              onChange={(e) => set('siteAgent', e.target.value)} />
          </FormField>
          <FormField label="전화">
            <input type="tel" inputMode="numeric" placeholder="010-0000-0000" value={form.siteAgentPhone} readOnly={ro}
              onChange={(e) => set('siteAgentPhone', formatPhone(e.target.value))} />
          </FormField>
          <FormField label="안전관리자">
            <input type="text" placeholder="이름" value={form.safetyManager} readOnly={ro}
              onChange={(e) => set('safetyManager', e.target.value)} />
          </FormField>
          <FormField label="전화">
            <input type="tel" inputMode="numeric" placeholder="010-0000-0000" value={form.safetyManagerPhone} readOnly={ro}
              onChange={(e) => set('safetyManagerPhone', formatPhone(e.target.value))} />
          </FormField>
          <FormField label="품질관리자">
            <input type="text" placeholder="이름" value={form.qualityTester} readOnly={ro}
              onChange={(e) => set('qualityTester', e.target.value)} />
          </FormField>
          <FormField label="전화">
            <input type="tel" inputMode="numeric" placeholder="010-0000-0000" value={form.qualityTesterPhone} readOnly={ro}
              onChange={(e) => set('qualityTesterPhone', formatPhone(e.target.value))} />
          </FormField>
        </div>
      </section>

      {/* 3) 공사기간 카드 — 계약일 / 착공일 / 실제착공일 / 준공예정일 (4 동일 칼럼) */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">공사기간</h3>
        </header>
        <div className="site-form__grid site-form__grid--period">
          <FormField label="계약일">
            <MacDatePicker
              value={form.contractDate}
              onChange={(v) => set('contractDate', v)}
            />
          </FormField>
          <FormField label="착공일">
            <MacDatePicker
              value={form.startDate}
              onChange={(v) => set('startDate', v)}
            />
          </FormField>
          <FormField label="실제착공일">
            <MacDatePicker
              value={form.groundBreakingDate}
              onChange={(v) => set('groundBreakingDate', v)}
            />
          </FormField>
          <FormField label="준공예정일">
            <MacDatePicker
              value={form.endDate}
              onChange={(v) => set('endDate', v)}
            />
          </FormField>
        </div>
      </section>

      {/* 4) 위치정보 카드 — 한 줄: 우편번호(좁) / 주소(넓) / 상세주소 */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">위치정보</h3>
        </header>
        <div className="site-form__grid site-form__grid--location">
          <FormField label="우편번호">
            <input type="text" value={form.addressPostal} readOnly={ro} placeholder="00000"
              onChange={(e) => set('addressPostal', e.target.value)} />
          </FormField>
          <FormField label="주소" big>
            <AddressField
              value={form.address}
              onSelect={(d) => {
                set('address', d.address);
                set('addressPostal', d.zonecode);
              }}
              onChange={(v) => set('address', v)}
              readOnly={ro}
              big
            />
          </FormField>
          <FormField label="상세주소">
            <input type="text" value={form.addressDetail} readOnly={ro} placeholder="동·호수 등"
              onChange={(e) => set('addressDetail', e.target.value)} />
          </FormField>
        </div>
      </section>

{/* 6) 운영상태 카드 — 시공중 / 중지 / 준공 / 정산대기 */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">운영상태</h3>
        </header>
        <div className="site-form__status-row">
          {[
            { v: 'IN_PROGRESS', label: '시공중', desc: '출퇴근·노무비 처리 진행' },
            { v: 'PAUSED', label: '중지', desc: '일시 중단 — 데이터 보존' },
            { v: 'COMPLETED', label: '준공', desc: '공사 종료, 정산 마감' },
            { v: 'SETTLEMENT_PENDING', label: '정산대기', desc: '준공 후 정산만 미완료' },
          ].map((s) => (
            <button
              key={s.v}
              type="button"
              disabled={ro}
              className={'site-form__status-card' + (form.siteStatus === s.v ? ' is-active' : '')}
              onClick={() => set('siteStatus', s.v as typeof form.siteStatus)}
            >
              <span className="site-form__status-card-label">{s.label}</span>
              <span className="site-form__status-card-desc">{s.desc}</span>
            </button>
          ))}
        </div>
      </section>
      </>
      )}

      {/* === 출역정책 — 출근 인증 중심 (왼쪽: 폼 / 오른쪽: 요약 카드) === */}
      {show('geofence') && (
      <>
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">출근 인증 정책</h3>
          {editing && (
            <span className="site-form__editing-badge">✎ 수정 모드</span>
          )}
        </header>

        <div className="site-form__attendance-layout">
          {/* 좌측 — 폼 필드 (모든 행 동일한 2등분 그리드) */}
          <div className="site-form__attendance-form">
            <div className="site-form__grid site-form__grid--attn-r2">
              <FormField label="인증 반경">
                <NumberStepper
                  min={20}
                  max={500}
                  step={10}
                  value={form.geofence?.radiusM ?? 100}
                  disabled={ro}
                  onChange={(next) => {
                    set('geofence', {
                      ...(form.geofence ?? {
                        lat: 37.5665, lng: 126.9780, radiusM: 100, gpsTolerance: 30,
                        locationRequired: 'RECOMMENDED', outOfBoundsPolicy: 'WARN',
                      }),
                      radiusM: next || 100,
                    });
                  }}
                />
              </FormField>
              <FormField label="GPS 오차 허용">
                <NumberStepper
                  min={5}
                  max={100}
                  step={5}
                  value={form.geofence?.gpsTolerance ?? 30}
                  disabled={ro}
                  onChange={(next) => {
                    set('geofence', {
                      ...(form.geofence ?? {
                        lat: 37.5665, lng: 126.9780, radiusM: 100, gpsTolerance: 30,
                        locationRequired: 'RECOMMENDED', outOfBoundsPolicy: 'WARN',
                      }),
                      gpsTolerance: next || 30,
                    });
                  }}
                />
              </FormField>
            </div>

            <div className="site-form__grid site-form__grid--attn-r3">
              <FormField label="출근 허용시간 (시작)">
                <MacTimePicker
                  value={form.attendanceWindowStart}
                  onChange={(v) => set('attendanceWindowStart', v)}
                  disabled={ro}
                />
              </FormField>
              <FormField label="퇴근 허용시간 (종료)">
                <MacTimePicker
                  value={form.attendanceWindowEnd}
                  onChange={(v) => set('attendanceWindowEnd', v)}
                  disabled={ro}
                />
              </FormField>
              <FormField label="기본 공수 기준">
                <NumberStepper
                  step={0.25}
                  min={0}
                  max={2}
                  value={form.defaultGongsu}
                  disabled={ro}
                  onChange={(next) => set('defaultGongsu', next || 1.0)}
                />
              </FormField>
            </div>

            <div className="site-form__grid site-form__grid--attn-r2">
              <FormField label="수동보정 승인 필요">
                <MacSelect
              value={form.requireManualApproval ? 'YES' : 'NO'}
              onChange={(v) => set('requireManualApproval', v === 'YES')}
              disabled={ro}
              options={[{ value: "YES", label: '예 — 본사 승인 후 반영' }, { value: "NO", label: '아니오 — 반장 입력 즉시 반영' }]}
            />
              </FormField>
              <FormField label="퇴근 인증 방식">
                <MacSelect
              value={form.checkoutMode}
              onChange={(v) => set('checkoutMode', v as 'EXCEPTION' | 'STRICT')}
              disabled={ro}
              options={[{ value: "EXCEPTION", label: '예외 입력형 (조퇴·외출만 입력)' }, { value: "STRICT", label: '출퇴근 인증형 (퇴근 시에도 위치 인증)' }]}
            />
              </FormField>
            </div>
          </div>

          {/* 우측 — 안내 카드 (현재 설정 요약) */}
          <aside className="site-form__attendance-summary site-form__attendance-summary--side">
            <div className="site-form__attendance-summary-row">
              <span>출근·퇴근 허용시간</span>
              <strong>{form.attendanceWindowStart} ~ {form.attendanceWindowEnd}</strong>
            </div>
            <div className="site-form__attendance-summary-row">
              <span>기본 공수 기준</span>
              <strong>출근 인증 시 {form.defaultGongsu.toFixed(1)} 공수 자동 부여</strong>
            </div>
            <div className="site-form__attendance-summary-row">
              <span>퇴근 인증 방식</span>
              <strong>{form.checkoutMode === 'EXCEPTION' ? '예외 입력형' : '출퇴근 인증형'}</strong>
            </div>
          </aside>
        </div>
      </section>

      {/* 지도 — 좌표·반경 설정 (기존 GeofenceMap 유지) */}
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">현장 좌표 (지오펜싱)</h3>
        </header>
        <div className="site-form__grid site-form__grid--geofence">
          <GeofenceMap
            value={form.geofence ?? {
              lat: 37.5665, lng: 126.9780,
              radiusM: 100, gpsTolerance: 30,
              locationRequired: 'RECOMMENDED',
              outOfBoundsPolicy: 'WARN',
            }}
            onChange={(g) => set('geofence', g)}
            address={[form.address, form.addressDetail].filter(Boolean).join(' ')}
            readOnly={ro}
          />
        </div>
      </section>
      </>
      )}

      {/* 외부업체 — 발주기관 / 감리업체 / 협력업체 (텍스트 요약 형태) */}
      {show('external') && (
      <section className="card site-form__card">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">협력업체</h3>
        </header>

        {/* 발주기관 + 감리업체 — 가로 2열 배치 */}
        <div className="site-form__ext-pair">
        {/* 1) 발주기관 — 다수 가능 (입력 폼 + 추가행) */}
        <div className="site-form__ext-group">
          <div className="site-form__ext-head">
            <strong>발주기관</strong>
            <span className="site-form__ext-meta">{form.clients.length}곳</span>
            <button
              type="button"
              className="site-form__ext-add"
              disabled={ro}
              onClick={() => set('clients', [...form.clients, { company: '', contact: '', phone: '' }])}
            >
              ＋ 추가행
            </button>
          </div>
          {form.clients.map((c, i) => (
            <div key={'client-' + i} className="site-form__grid site-form__grid--ext-row">
              <FormField label={i === 0 ? '업체명' : ''}>
                <input type="text" value={c.company} readOnly={ro}
                  onChange={(e) => set('clients', form.clients.map((x, j) => j === i ? { ...x, company: e.target.value } : x))} />
              </FormField>
              <FormField label={i === 0 ? '담당자' : ''}>
                <input type="text" value={c.contact} readOnly={ro}
                  onChange={(e) => set('clients', form.clients.map((x, j) => j === i ? { ...x, contact: e.target.value } : x))} />
              </FormField>
              <FormField label={i === 0 ? '전화' : ''}>
                <span className="site-form__ext-row-input">
                  <input type="tel" inputMode="numeric" value={c.phone} readOnly={ro}
                    onChange={(e) => set('clients', form.clients.map((x, j) => j === i ? { ...x, phone: formatPhone(e.target.value) } : x))} />
                  {!ro && form.clients.length > 1 && (
                    <button type="button" className="site-form__ext-del"
                      onClick={() => set('clients', form.clients.filter((_, j) => j !== i))}
                      title="이 행 삭제">✕</button>
                  )}
                </span>
              </FormField>
            </div>
          ))}
        </div>

        {/* 2) 감리업체 — 다수 가능 (입력 폼 + 추가행) */}
        <div className="site-form__ext-group">
          <div className="site-form__ext-head">
            <strong>감리업체</strong>
            <span className="site-form__ext-meta">{form.supervisors.length}곳</span>
            <button
              type="button"
              className="site-form__ext-add"
              disabled={ro}
              onClick={() => set('supervisors', [...form.supervisors, { company: '', contact: '', phone: '' }])}
            >
              ＋ 추가행
            </button>
          </div>
          {form.supervisors.map((s, i) => (
            <div key={'sv-' + i} className="site-form__grid site-form__grid--ext-row">
              <FormField label={i === 0 ? '업체명' : ''}>
                <input type="text" value={s.company} readOnly={ro}
                  onChange={(e) => set('supervisors', form.supervisors.map((x, j) => j === i ? { ...x, company: e.target.value } : x))} />
              </FormField>
              <FormField label={i === 0 ? '담당자' : ''}>
                <input type="text" value={s.contact} readOnly={ro}
                  onChange={(e) => set('supervisors', form.supervisors.map((x, j) => j === i ? { ...x, contact: e.target.value } : x))} />
              </FormField>
              <FormField label={i === 0 ? '전화' : ''}>
                <span className="site-form__ext-row-input">
                  <input type="tel" inputMode="numeric" value={s.phone} readOnly={ro}
                    onChange={(e) => set('supervisors', form.supervisors.map((x, j) => j === i ? { ...x, phone: formatPhone(e.target.value) } : x))} />
                  {!ro && form.supervisors.length > 1 && (
                    <button type="button" className="site-form__ext-del"
                      onClick={() => set('supervisors', form.supervisors.filter((_, j) => j !== i))}
                      title="이 행 삭제">✕</button>
                  )}
                </span>
              </FormField>
            </div>
          ))}
        </div>

        </div>
        {/* 3) 협력업체 — 표 형태 (SiteCompany 시점 자동 연동) */}
        <div className="site-form__ext-group">
          <div className="site-form__ext-head">
            <strong>협력업체</strong>
            <span className="site-form__ext-meta">
              총 {siteCompanies.filter((sc) => sc.role === '하도급').length}곳
            </span>
            <button type="button" className="site-form__ext-add" disabled={ro}>＋ 추가행</button>
          </div>
          <div className="site-form__ext-table-wrap">
            <table className="site-form__ext-table">
              <thead>
                <tr>
                  <th>업체명</th>
                  <th>회사 코드</th>
                  <th>사업자번호</th>
                  <th>공종</th>
                  <th className="num">공사금액 (억원)</th>
                  <th>공사기간</th>
                  <th>담당자</th>
                  <th>전화번호</th>
                </tr>
              </thead>
              <tbody>
                {siteCompanies.filter((sc) => sc.role === '하도급').length === 0 ? (
                  <tr>
                    <td colSpan={8} className="site-form__ext-empty">
                      이 현장에 등록된 협력업체가 없습니다.
                    </td>
                  </tr>
                ) : (
                  siteCompanies
                    .filter((sc) => sc.role === '하도급')
                    .map((sc) => {
                      const co = companies.find((c) => c.id === sc.companyId);
                      const period = [sc.startDate, sc.endDate].filter(Boolean).join(' ~ ');
                      const startD = sc.startDate || '';
                      const endD = sc.endDate || '';
                      // 회사 식별자 3계층 — 표시 코드(C-26-NNNNNN) + 자연키(사업자번호)
                      const compCode = co ? makeCompanyCode(co) : '—';
                      const bizNo = formatBizNo(co?.bizNo, co?.id);
                      // 공사금액 — 억원 단위로 포맷
                      const amtOk = !!sc.contractAmount && sc.contractAmount > 0;
                      const amtBillion = amtOk
                        ? (sc.contractAmount! / 100_000_000).toFixed(1) + '억'
                        : null;
                      // 담당자 / 전화 — Foreman 중 이 SiteCompany 소속 첫 명을 사용 (없으면 회사 대표)
                      const sf = foremen.find((f) => f.siteCompanyId === sc.id);
                      const contactName = sf?.name ?? co?.representative ?? '—';
                      const contactPhone = sf?.phone ?? '—';
                      return (
                        <tr key={sc.id}>
                          <td className="site-form__ext-name">{co?.name ?? '—'}</td>
                          <td>
                            <code className="site-form__ext-code">{compCode}</code>
                          </td>
                          <td>
                            <code className="site-form__ext-bizno">{bizNo}</code>
                          </td>
                          <td>
                            {(sc.trade ?? sc.specialty) ? (
                              <span className="site-form__ext-tag">{sc.trade ?? sc.specialty}</span>
                            ) : (
                              <span className="site-form__ext-muted">미지정</span>
                            )}
                          </td>
                          <td className="num">
                            {amtBillion ?? <span className="site-form__ext-muted">—</span>}
                          </td>
                          <td className="site-form__ext-period">
                            {period ? (
                              <span className="site-form__ext-period-stack">
                                <span className="site-form__ext-period-row">{startD}</span>
                                <span className="site-form__ext-period-row">~ {endD}</span>
                              </span>
                            ) : (
                              <span className="site-form__ext-muted">—</span>
                            )}
                          </td>
                          <td>{contactName}</td>
                          <td className="site-form__ext-phone">{contactPhone}</td>
                        </tr>
                      );
                    })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      )}

      {/* === 사회보험 — 5개 타일 (고용 / 산재 / 건강(일용+상용) / 연금(일용+상용) / 퇴직공제) === */}
      {show('insurance') && (
      <section className="card site-form__card site-form__insurance-section">
        <header className="site-form__sec-head">
          <h3 className="site-form__sec-title">사회보험</h3>
        </header>

        <div className="site-form__insurance-grid">
          {/* 1) 고용보험 */}
          <FieldGroup title="고용보험" tone="indigo">
            <div className="site-form__grid site-form__grid--attn-r2">
              <FormField label="관리번호">
                <input type="text" value={form.empInsuranceMgmtNo} readOnly={ro} onChange={(e) => set('empInsuranceMgmtNo', e.target.value)} />
              </FormField>
              <FormField label="성립일">
                <MacDatePicker
              value={form.empInsuranceStartDate}
              onChange={(v) => set('empInsuranceStartDate', v)}
            />
              </FormField>
            </div>
          </FieldGroup>

          {/* 2) 산재보험 */}
          <FieldGroup title="산재보험" tone="emerald">
            <div className="site-form__grid site-form__grid--attn-r2">
              <FormField label="관리번호">
                <input type="text" value={form.woundInsuranceMgmtNo} readOnly={ro} onChange={(e) => set('woundInsuranceMgmtNo', e.target.value)} />
              </FormField>
              <FormField label="성립일">
                <MacDatePicker
              value={form.woundInsuranceStartDate}
              onChange={(v) => set('woundInsuranceStartDate', v)}
            />
              </FormField>
            </div>
          </FieldGroup>

          {/* 5) 퇴직공제 (가입번호 + 가입일) */}
          <FieldGroup title="퇴직공제" tone="indigo">
            <div className="site-form__grid site-form__grid--attn-r2">
              <FormField label="가입번호">
                <input type="text" value={form.retireMutualNo} readOnly={ro} onChange={(e) => set('retireMutualNo', e.target.value)} />
              </FormField>
              <FormField label="가입일">
                <MacDatePicker
              value={form.retireMutualStartDate}
              onChange={(v) => set('retireMutualStartDate', v)}
            />
              </FormField>
            </div>
          </FieldGroup>

          {/* 3) 건강보험 — 일용 + 상용 한 타일 안 분할 */}
          <FieldGroup title="건강보험" tone="indigo" wide>
            <div className="site-form__sub-pair">
              <div className="site-form__sub-block">
                <span className="site-form__sub-label">일용</span>
                <div className="site-form__grid site-form__grid--attn-r2">
                  <FormField label="관리번호">
                    <input type="text" value={form.healthInsuranceMgmtNoDaily} readOnly={ro} onChange={(e) => set('healthInsuranceMgmtNoDaily', e.target.value)} />
                  </FormField>
                  <FormField label="성립일">
                    <MacDatePicker
              value={form.healthInsuranceStartDateDaily}
              onChange={(v) => set('healthInsuranceStartDateDaily', v)}
            />
                  </FormField>
                </div>
              </div>
              <div className="site-form__sub-block">
                <span className="site-form__sub-label">상용</span>
                <div className="site-form__grid site-form__grid--attn-r2">
                  <FormField label="관리번호">
                    <input type="text" value={form.healthInsuranceMgmtNoRegular} readOnly={ro} onChange={(e) => set('healthInsuranceMgmtNoRegular', e.target.value)} />
                  </FormField>
                  <FormField label="성립일">
                    <MacDatePicker
              value={form.healthInsuranceStartDateRegular}
              onChange={(v) => set('healthInsuranceStartDateRegular', v)}
            />
                  </FormField>
                </div>
              </div>
            </div>
          </FieldGroup>

          {/* 4) 연금보험 — 일용 + 상용 한 타일 안 분할 */}
          <FieldGroup title="연금보험" tone="emerald" wide>
            <div className="site-form__sub-pair">
              <div className="site-form__sub-block">
                <span className="site-form__sub-label">일용</span>
                <div className="site-form__grid site-form__grid--attn-r2">
                  <FormField label="관리번호">
                    <input type="text" value={form.pensionMgmtNoDaily} readOnly={ro} onChange={(e) => set('pensionMgmtNoDaily', e.target.value)} />
                  </FormField>
                  <FormField label="성립일">
                    <MacDatePicker
              value={form.pensionStartDateDaily}
              onChange={(v) => set('pensionStartDateDaily', v)}
            />
                  </FormField>
                </div>
              </div>
              <div className="site-form__sub-block">
                <span className="site-form__sub-label">상용</span>
                <div className="site-form__grid site-form__grid--attn-r2">
                  <FormField label="관리번호">
                    <input type="text" value={form.pensionMgmtNoRegular} readOnly={ro} onChange={(e) => set('pensionMgmtNoRegular', e.target.value)} />
                  </FormField>
                  <FormField label="성립일">
                    <MacDatePicker
              value={form.pensionStartDateRegular}
              onChange={(v) => set('pensionStartDateRegular', v)}
            />
                  </FormField>
                </div>
              </div>
            </div>
          </FieldGroup>
        </div>
      </section>
      )}
    </div>
  );
}

function FormField({
  label,
  children,
  wide,
  big,
  plus,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  big?: boolean;
  plus?: boolean;
}) {
  const cls =
    'site-form__field' +
    (wide ? ' site-form__field--wide' : '') +
    (big ? ' site-form__field--big' : '') +
    (plus ? ' site-form__field--plus' : '');
  return (
    <div className={cls}>
      <label className={'site-form__label' + (big ? ' site-form__label--big' : '')}>
        {label}
        {plus && <span className="site-form__plus" aria-hidden>+</span>}
      </label>
      {children}
    </div>
  );
}

function FieldGroup({
  title,
  tone,
  wide,
  children,
}: {
  title: string;
  tone: 'indigo' | 'emerald';
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={'site-form__group site-form__group--' + tone + (wide ? ' site-form__group--wide' : '')}>
      <header className="site-form__group-head">{title}</header>
      <div className="site-form__group-body">{children}</div>
    </div>
  );
}

/* ─── 준공 처리 모달 — 결산 요약(임금/세금/사회보험/퇴직공제) 포함 ─── */
function CompletionDialog({
  sites,
  defaultSiteId,
  onClose,
  onConfirm,
}: {
  sites: Site[];
  defaultSiteId?: string;
  onClose: () => void;
  onConfirm: (siteId: string, dateISO: string) => void;
}) {
  const [siteId, setSiteId] = useState<string>(defaultSiteId || sites[0]?.id || '');
  const [date, setDate] = useState<string>(localDateStr());

  // ── 결산 요약 계산 ──────────────────────────────────────
  // 임금 ≈ 도급금액 × 35% (인건비 비율, WagePage 와 동일 모형)
  // 세금 ≈ 임금 × 6.6% (일용직 원천세)
  // 사회보험 ≈ 임금 × 9.87% (4대보험 사용자부담분 합계)
  // 퇴직공제 ≈ 임금 × 0.5% (건설근로자공제회 적립)
  // 집행 = 예산 × 공정률 — 100% 미만이면 "미결산" 으로 적색 강조
  // ────────────────────────────────────────────────────────
  const cur = sites.find((s) => s.id === siteId);
  const contractAmount = cur?.contractAmount ?? 0;
  const progress = Math.min(1, Math.max(0, (cur?.progressPercent ?? 0) / 100));
  const wageBudget = Math.round(contractAmount * 0.35);
  const taxBudget = Math.round(wageBudget * 0.066);
  const insBudget = Math.round(wageBudget * 0.0987);
  const retBudget = Math.round(wageBudget * 0.005);
  const settlementItems = [
    { key: 'wage', label: '임금 결산', budget: wageBudget, settled: Math.round(wageBudget * progress) },
    { key: 'tax', label: '세금 결산', budget: taxBudget, settled: Math.round(taxBudget * progress) },
    { key: 'ins', label: '사회보험 결산', budget: insBudget, settled: Math.round(insBudget * progress) },
    { key: 'ret', label: '퇴직공제부금 결산', budget: retBudget, settled: Math.round(retBudget * progress) },
  ];
  // 집행률 95% 이상이면 결산 완료로 본다
  const SETTLE_THRESHOLD = 0.95;
  const incomplete = settlementItems.filter(
    (it) => it.budget > 0 && it.settled / it.budget < SETTLE_THRESHOLD,
  );

  function fmt(n: number): string {
    if (!n) return '0원';
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
    return n.toLocaleString();
  }

  return (
    <div
      className="ct-modal__backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ct-modal" style={{ maxWidth: 560 }}>
        <header className="ct-modal__head">
          <h3>현장 준공 처리</h3>
          <button type="button" className="ct-modal__x" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <div className="ct-modal__body">
          {sites.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 13 }}>
              준공 처리할 현장이 없습니다.
            </p>
          ) : (
            <>
              <label className="ct-modal__row">
                <span className="ct-modal__lbl">현장 선택</span>
                <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              options={[...sites.map((s) => (
                    ({ value: s.id, label: s.name })
                  ))]}
            />
              </label>
              <label className="ct-modal__row">
                <span className="ct-modal__lbl">준공일</span>
                <MacDatePicker
              value={date}
              onChange={(v) => setDate(v)}
            />
              </label>

              {/* 결산 요약 */}
              <div className="ct-settle">
                <div className="ct-settle__head">
                  <h4>결산 요약 <span className="ct-settle__hint">(계약 vs 집행)</span></h4>
                  <span className="ct-settle__progress">
                    공정률 <strong>{Math.round(progress * 100)}%</strong>
                  </span>
                </div>
                <table className="ct-settle__table">
                  <thead>
                    <tr>
                      <th>항목</th>
                      <th className="ct-settle__num">계약</th>
                      <th className="ct-settle__num">집행</th>
                      <th className="ct-settle__num">집행률</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlementItems.map((it) => {
                      const rate = it.budget > 0 ? it.settled / it.budget : 0;
                      const ratePct = Math.round(rate * 100);
                      const done = rate >= SETTLE_THRESHOLD;
                      return (
                        <tr key={it.key} className={done ? 'is-done' : 'is-incomplete'}>
                          <td>{it.label}</td>
                          <td className="ct-settle__num">{fmt(it.budget)}</td>
                          <td className="ct-settle__num">{fmt(it.settled)}</td>
                          <td className="ct-settle__num">{ratePct}%</td>
                          <td>
                            {done ? (
                              <span className="ct-settle__chip ct-settle__chip--done">결산완료</span>
                            ) : (
                              <span className="ct-settle__chip ct-settle__chip--warn">미결산</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {incomplete.length > 0 && (
                  <p className="ct-settle__warn">
                    미결산 항목 {incomplete.length}건 — 준공 후엔 별도 결산 처리가 필요합니다.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <footer className="ct-modal__foot">
          <button type="button" className="ct-modal__cancel" onClick={onClose}>취소</button>
          <button
            type="button"
            className="ct-modal__send"
            disabled={!siteId || !date}
            onClick={() => {
              if (incomplete.length > 0) {
                if (!window.confirm(
                  `결산 미완료 항목이 ${incomplete.length}건 있습니다.\n\n` +
                  incomplete.map((it) => ` · ${it.label}`).join('\n') +
                  `\n\n그래도 준공 확정하시겠습니까?`,
                )) return;
              }
              onConfirm(siteId, date);
            }}
          >
            준공 확정
          </button>
        </footer>
      </div>
    </div>
  );
}
