import type React from 'react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { WorkCloseHeader } from '../components/WorkCloseHeader';
import { computeWorkCloseProgress } from '../utils/workCloseProgress';
import { Modal } from '../components/Modal';
import { Tooltip } from '../components/Tooltip';
import { siteApi } from '../api/site';
import { attendanceApi } from '../api/attendance';
import { teamApi } from '../api/team';
import type { TeamMember } from '../api/team.types';
import type { Foreman, Site } from '../api/site.types';
import type {
  AttendanceMonth,
  AttendanceRecord,
  AuditLogEntry,
  TodayAttendance,
} from '../api/attendance.types';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { flashCompletion } from '../utils/completionToast';
import { apiClient } from '../api/client';
import type { SiteCompany, Company } from '../api/site.types';
import type { SubVerification } from '../api/attendance.types';
import { formatGongsu, isoToHHMM } from '../utils/gongsu';
import {
  getHoliday,
  isSaturday,
  isSunday,
  shortHolidayLabel,
} from '../utils/holidays';
import {
  loadSubVerifyRequests,
  saveSubVerifyRequest,
  findLastRequest,
  buildDefaultMessage,
  CHANNEL_LABEL,
  type SubVerifyChannel,
  type SubVerifyRequestRecord,
} from '../utils/subVerifyRequest';
import {
  parseLedgerFile,
  appendToArchive,
} from '../utils/wageLedger';
import { downloadAttendanceTemplateXlsx } from '../utils/attendanceTemplate';
import './AttendancePage.css';

import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
/**
 * 출퇴근 현황
 *
 *  상단:  현장 선택 + 년월 선택 + 새로고침 + 일괄 퇴근
 *  요약:  팀원 / 공수 / 임금 / 얼굴인식 / 삭제·지각/조퇴
 *  본문:
 *    좌측 그리드(팀원 × 일자, 셀당 공수). 빈 셀도 클릭 가능.
 *    우측 사이드:
 *      - 셀 선택 + 기록 있음 → 상세 + "공수 직접 입력 / 강제 처리" 버튼
 *      - 셀 선택 + 기록 없음 → "이 일자에 공수 직접 입력" 패널
 *      - 미선택 → 감사 로그
 *
 *  공수 규칙(utils/gongsu.ts):
 *    8시간(07~15) = 1.0 공수, 4시간 단위로 0.5씩 적층, 최대 2.0
 *
 *  관리자 수동 산정(/attendance/set-gongsu):
 *    얼굴 인식이 없는 일자에도 공수를 0/0.5/1.0/1.5/2.0 중 직접 지정 가능.
 *    5자 이상 사유 필수, 감사 로그에 'MANUAL_GONGSU' 로 기록.
 */
export function AttendancePage({ forceTab }: { forceTab?: 'auth' | 'daily' } = {}) {
  const { viewMode, assignedSiteId, user } = useAuth();
  // URL ?siteId=… 로 진입한 경우 해당 현장을 자동 선택. 대시보드 「출역」 버튼 등에서 사용.
  const [searchParams, setSearchParams] = useSearchParams();
  const querySiteId = searchParams.get('siteId') ?? null;
  const navigate = useNavigate();
  const [sites, setSites] = useState<Site[]>([]);
  const [foremen, setForemen] = useState<Foreman[]>([]);
  /** 'ALL' = 전체 현장 합계 / 그 외 = 특정 사이트 ID */
  const [siteId, setSiteId] = useState<string>(
    viewMode === 'SITE' && assignedSiteId
      ? assignedSiteId
      : querySiteId
        ? querySiteId
        : 'ALL',
  );
  // 사이트 목록 로딩 후 querySiteId 가 실제 존재하면 그쪽으로 sync
  useEffect(() => {
    if (!querySiteId) return;
    if (siteId === querySiteId) return;
    setSiteId(querySiteId);
    // 한번 적용 후 ?siteId= 파라미터 제거 (히스토리 깔끔하게)
    setSearchParams((sp: URLSearchParams) => {
      const next = new URLSearchParams(sp);
      next.delete('siteId');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySiteId]);
  const [yearMonth, setYearMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [month, setMonth] = useState<AttendanceMonth | null>(null);
  const [today, setToday] = useState<TodayAttendance | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  /** 일자별 뷰에서 선택된 날짜 — 좌측 팀원 리스트가 그 날 출석자로 전환됨 */
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  /** 우측 패널 탭 — 'DAILY'(일자별 출력) / 'MEMBER'(개인별 캘린더) */
  const [rightView, setRightView] = useState<'DAILY' | 'MEMBER'>('DAILY');
  /** 일일 출역확정 — 보기 모드 (인증관리 패턴 적용)
   *  · site     : 현장별 카드 + 근로자 확정 테이블 (기본)
   *  · calendar : 월간 캘린더 (기존 UI)
   *  · member   : 개인별 보기 (월간 출역·공수 흐름)
   */
  const [dailyView, setDailyView] = useState<'site' | 'calendar' | 'member'>('site');
  /** 일일확정 — 선택 현장 (우측 상세) */
  const [dailySelectedSite, setDailySelectedSite] = useState<string | null>(null);
  /** 일일확정 — 상태 필터 */
  const [dailyFilter, setDailyFilter] = useState<'all' | 'pending' | 'done' | 'check' | 'manual' | 'lateEarly' | 'exception'>('all');
  /** 일일확정 테이블 — 정렬 컬럼 + 방향 (인증관리와 동일 패턴) */
  type DailySortCol = 'name' | 'role' | 'foreman' | 'auth' | 'in' | 'out' | 'exception' | 'base' | 'final' | 'wage' | 'pay' | 'status' | null;
  const [dailySortCol, setDailySortCol] = useState<DailySortCol>(null);
  const [dailySortDir, setDailySortDir] = useState<'asc' | 'desc'>('asc');
  function toggleDailySort(col: DailySortCol) {
    if (col === dailySortCol) setDailySortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setDailySortCol(col); setDailySortDir('asc'); }
  }
  /** 일일확정 — 처리 이력 (확정/보류/제외) — localStorage 영속 */
  type DailyHandledAction = 'done' | 'hold' | 'excluded';
  type DailyHandledEntry = { action: DailyHandledAction; at: string; gongsu?: number; reason?: string };
  const [dailyHandled, setDailyHandled] = useState<Map<string, DailyHandledEntry>>(() => {
    try {
      const raw = localStorage.getItem('bodapass.daily.handled');
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj) as [string, DailyHandledEntry][]);
    } catch { return new Map(); }
  });
  function markDailyHandled(recordKey: string, action: DailyHandledAction, gongsu?: number, reason?: string) {
    setDailyHandled((prev) => {
      const next = new Map(prev);
      next.set(recordKey, { action, at: new Date().toISOString(), gongsu, reason });
      try { localStorage.setItem('bodapass.daily.handled', JSON.stringify(Object.fromEntries(next))); } catch { /* */ }
      return next;
    });
    const label = action === 'done' ? '확정' : action === 'hold' ? '보류' : '제외';
    flashCompletion(label + ' 처리되었습니다.', { tone: action === 'excluded' ? 'danger' : 'ok' });
  }
  /** 일일확정 — 출역 미등록 패널 토글 */
  const [dailyPoolOpen, setDailyPoolOpen] = useState<boolean>(false);
  /** 출역 추가 다이얼로그 — 클릭한 멤버 정보를 받아 폼 + 사진 업로드로 출역 등록 */
  const [attendAddFor, setAttendAddFor] = useState<TeamMember | null>(null);
  /** 월간 내역 — 선택 현장 / 필터 / 일자필터 / 근로자 상세 / 출역 미등록 패널 */
  const [monthlySelectedSite, setMonthlySelectedSite] = useState<string | null>(null);
  const [monthlyFilter, setMonthlyFilter] = useState<'all' | 'closeable' | 'done' | 'check' | 'unconfirmed' | 'exception' | 'manual' | 'closed'>('all');
  const [monthlyDateFilter, setMonthlyDateFilter] = useState<string | null>(null);
  const [monthlyDetailMember, setMonthlyDetailMember] = useState<string | null>(null);
  const [monthlyPoolOpen, setMonthlyPoolOpen] = useState<boolean>(false);
  /** 월간 내역 — 좌측 사이트 리스트 필터 (전체/주의/정상/확인필요) */
  const [monthlySiteFilter, setMonthlySiteFilter] = useState<'all' | 'warn' | 'ok' | 'check'>('all');
  /** 근로자 월간 상세 모달 — 보기 모드 (달력/목록) + 선택 일자 */
  const [memberDetailView, setMemberDetailView] = useState<'cal' | 'list'>('cal');
  const [memberDetailDate, setMemberDetailDate] = useState<string | null>(null);
  /**
   * 출역관리 화면 탭 — 인증관리 / 공수확정.
   *  · auth  : 얼굴인식·GPS·수기입력 검증 («이 출근 기록을 믿을 수 있나»)
   *  · daily : 일일 공수 확정 («오늘 몇 공수로 인정할까») — 월말에는 정산관리 → 공수마감 으로 연결
   * 탭 전환 시 우측 패널 보기(DAILY/MEMBER) 도 자연스럽게 따라감.
   */
  const [attTab, setAttTab] = useState<'auth' | 'daily'>(() => {
    try {
      const saved = localStorage.getItem('att.tab');
      if (saved === 'auth' || saved === 'daily') return saved;
    } catch { /* */ }
    return 'auth';
  });
  function selectAttTab(t: 'auth' | 'daily') {
    setAttTab(t);
    try { localStorage.setItem('att.tab', t); } catch { /* */ }
    // 인증관리 탭은 일자별(오늘) 시점 / 공수확정 탭은 개인별 캘린더 시점이 자연스러움
    if (t === 'auth') setRightView('DAILY');
    else setRightView('MEMBER');
  }
  // forceTab prop — /auth-mgmt 또는 /daily-confirm 라우트로 진입 시 해당 탭 강제 적용
  useEffect(() => {
    if (forceTab && forceTab !== attTab) {
      selectAttTab(forceTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceTab]);

  const [bulkOpen, setBulkOpen] = useState(false);
  /** 월마감 상태 — 출역 stage 노출 (노임/지급/정산은 노임비 페이지에서 처리) */
  const [monthClose, setMonthClose] = useState<{
    status: 'OPEN' | 'CLOSED';
    /** 호환용 종합 stage */
    stage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
    /** 출역 stage — 출퇴근 페이지에 노출 */
    attStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
    /** 노임 stage — 출퇴근 페이지는 읽기만 (출역 되돌림 차단 판단용) */
    wageStage: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
    attSiteClosedAt?: string;
    attSiteClosedByName?: string;
    attHqConfirmedAt?: string;
    attHqConfirmedByName?: string;
    // 호환용 (구)
    closedAt?: string;
    closedByName?: string;
    hqConfirmedAt?: string;
    hqConfirmedByName?: string;
    settledAt?: string;
    settledByName?: string;
  } | null>(null);
  /** 일마감 set — 'YYYY-MM-DD' 만 들어있음 */
  const [closedDates, setClosedDates] = useState<Set<string>>(new Set());
  const [closeLoading, setCloseLoading] = useState(false);
  /** ALL 모드 — 사이트별 attStage 매핑 (배지·요약용) */
  const [siteAttStages, setSiteAttStages] = useState<Map<string, 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED'>>(new Map());
  /** 빠른 팀원 추가 다이얼로그 */
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  /** 관리 인원 풀 — 전체 회사 등록 인원 (미출근 인력 풀 사이드 패널) */
  const [allMembers, setAllMembers] = useState<TeamMember[]>([]);
  /** ALL 모드 — 현장별 출퇴근 요약 (전체 N개 클릭 시 드롭다운으로 노출) */
  /** 인증관리 화면 전용 — 사이트별 today 매핑 (멀티사이트 카드 리스트 + 상세 분리) */
  const [todayBySiteAuth, setTodayBySiteAuth] = useState<Record<string, any>>({});
  /** 인증관리 보기 모드 */
  const [authView, setAuthView] = useState<'site' | 'all'>('site');
  /** 인증관리 테이블 — 정렬 컬럼 + 방향 (asc/desc).
   *  같은 컬럼 다시 클릭 시 desc, asc 순환. 다른 컬럼이면 asc 부터.    */
  type AuthSortCol = 'name' | 'foreman' | 'site' | 'date' | 'time' | 'method' | 'face' | 'gps' | 'distance' | 'status' | null;
  const [authSortCol, setAuthSortCol] = useState<AuthSortCol>(null);
  const [authSortDir, setAuthSortDir] = useState<'asc' | 'desc'>('asc');
  function toggleAuthSort(col: AuthSortCol) {
    if (col === authSortCol) {
      setAuthSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setAuthSortCol(col); setAuthSortDir('asc');
    }
  }
  /** 인증관리 — 선택된 현장 (오른쪽 상세 패널) */
  const [authSelectedSite, setAuthSelectedSite] = useState<string | null>(null);
  /** 인증관리 — 상태 필터 */
  const [authFilter, setAuthFilter] = useState<'all' | 'normal' | 'pending' | 'check' | 'rejected' | 'gps' | 'manual' | 'face_fail'>('all');
  /** 인증관리 — 기간 프리셋 */
  type AuthDatePreset = 'today' | 'week' | 'month' | 'all' | 'custom' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  const [authDatePreset, setAuthDatePreset] = useState<AuthDatePreset>('today');
  /** 「이번 주」 활성 여부 — true 면 월~일 요일 칩이 인라인 노출 */
  const [authWeekModeActive, setAuthWeekModeActive] = useState<boolean>(false);
  const [authStartDate, setAuthStartDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  /**
   * 인증관리 — 처리(승인·반려·확인)된 record ID 추적.
   *  · 현장별 보기 : 이 set 에 들어간 record 는 화면에서 사라짐 (큐 모드)
   *  · 전체 로그 보기 : 모두 표시되며 처리 상태 라벨(처리완료) 노출 (이력 모드)
   *  localStorage 에 영구 저장 — 시연용. 실 운영에선 백엔드 record.handledStatus.
   */
  type AuthHandledEntry = { action: 'approved' | 'rejected' | 'confirmed'; at: string; by?: string; reason?: string };
  const [authHandledRecords, setAuthHandledRecords] = useState<Map<string, AuthHandledEntry>>(() => {
    try {
      const raw = localStorage.getItem('bodapass.auth.handled');
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      // 옛 포맷 (string) → 새 포맷 (entry) 호환
      const map = new Map<string, AuthHandledEntry>();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') map.set(k, { action: v as any, at: new Date().toISOString() });
        else if (v && typeof v === 'object') map.set(k, v as AuthHandledEntry);
      }
      return map;
    } catch { return new Map(); }
  });
  function markAuthHandled(recordId: string, action: 'approved' | 'rejected' | 'confirmed', reason?: string) {
    setAuthHandledRecords((prev) => {
      const next = new Map(prev);
      next.set(recordId, { action, at: new Date().toISOString(), by: user?.name, reason });
      try { localStorage.setItem('bodapass.auth.handled', JSON.stringify(Object.fromEntries(next))); } catch { /* */ }
      return next;
    });
    const label = action === 'approved' ? '승인' : action === 'rejected' ? '반려' : '확인';
    flashCompletion(label + ' 처리되었습니다.', { tone: action === 'rejected' ? 'danger' : 'ok' });
  }
  /** 인증관리 — 상세 팝업으로 열린 record */
  const [authDetailRecord, setAuthDetailRecord] = useState<any | null>(null);
  /** 인증관리 — 클릭 액션 피드백 토스트 */
  const [authToast, setAuthToast] = useState<string | null>(null);
  /** 인증관리 — 승인/반려/확인 사유 입력 프롬프트 (record + action) */
  const [authActionPrompt, setAuthActionPrompt] = useState<{ tm: any; action: 'approved' | 'rejected' | 'confirmed' } | null>(null);
  function flashAuthToast(msg: string) {
    setAuthToast(msg);
    setTimeout(() => setAuthToast(null), 1800);
  }
  const [authEndDate, setAuthEndDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  function applyAuthDatePreset(preset: AuthDatePreset, startOverride?: string, endOverride?: string) {
    setAuthDatePreset(preset);
    if (preset === 'custom') {
      if (startOverride !== undefined) setAuthStartDate(startOverride);
      if (endOverride !== undefined) setAuthEndDate(endOverride);
      return;
    }
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (preset === 'today') {
      const t = iso(today);
      setAuthStartDate(t); setAuthEndDate(t);
    } else if (preset === 'week') {
      const day = today.getDay();
      const diffToMon = (day + 6) % 7;
      const mon = new Date(today); mon.setDate(today.getDate() - diffToMon);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      setAuthStartDate(iso(mon)); setAuthEndDate(iso(sun));
    } else if (preset === 'month') {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      setAuthStartDate(iso(first)); setAuthEndDate(iso(last));
    } else if (preset === 'all') {
      // 「전체」 — 올해 1월 1일 ~ 오늘
      const yearStart = new Date(today.getFullYear(), 0, 1);
      setAuthStartDate(iso(yearStart)); setAuthEndDate(iso(today));
    } else {
      // 요일 단일 (이번 주의 해당 요일)
      const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const targetDay = dayMap[preset] ?? 0;
      const dDay = today.getDay();
      const dDiff = targetDay - dDay;
      const target = new Date(today); target.setDate(today.getDate() + dDiff);
      const t = iso(target);
      setAuthStartDate(t); setAuthEndDate(t);
    }
  }
  const [perSiteStats, setPerSiteStats] = useState<Array<{
    siteId: string;
    siteName: string;
    workingNow: number;
    todayTotal: number;
    monthGongsu: number;
    monthPay: number;
    members: number;
  }>>([]);
  const [siteListOpen, setSiteListOpen] = useState(false);
  /** 하도급 출력인원 확인 — site 별 sub 회사들의 verify 기록 */
  const [subVerifications, setSubVerifications] = useState<SubVerification[]>([]);
  /** 현재 site 의 site_company 목록 (회사명 매핑용) */
  const [siteCompanies, setSiteCompanies] = useState<SiteCompany[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  /** 현재 site 의 팀원 목록 — 하도급 출력인원 popover 의 SiteCompany 별 인원 카운트용 */
  const [siteMembers, setSiteMembers] = useState<TeamMember[]>([]);
  /** 하도급 출역확인 popover open/close */
  const [subVerifyOpen, setSubVerifyOpen] = useState(false);
  /** 「출역확인 요청」 모달 — 어떤 하도급사에게 보낼지 + 미리보기 메시지 */
  const [subRequestModal, setSubRequestModal] = useState<{
    siteCompanyId: string;
    companyName: string;
    siteName: string;
    memberCount: number;
    todayTotal: number;
    todayWorking: number;
    message: string;
    channels: SubVerifyChannel[];
    sending: boolean;
  } | null>(null);
  /** 발송 이력 — bump 로 강제 리렌더 (요청 후 「요청됨」 배지 즉시 갱신) */
  const [requestLogBump, setRequestLogBump] = useState(0);
  /** 엑셀 업로드 모달 — 양식 선택 + 파일 업로드 (입력양식 / 노임대장) */
  const [uploadOpen, setUploadOpen] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayClosed = closedDates.has(todayStr);
  const [manualOpen, setManualOpen] = useState<{ memberId: string } | null>(null);
  const [gongsuOpen, setGongsuOpen] = useState<{
    memberId: string;
    memberName: string;
    role: string;
    date: string;
    dailyWage: number;
    initial: number;
    /** 그 날짜에 이미 있는 기록(없으면 null) — 상세 표시용 */
    record: AttendanceRecord | null;
    /** 현장명 — 어느 현장에서 일했는지 명확히 */
    siteName?: string;
  } | null>(null);
  /** 드래그로 여러 일자를 한꺼번에 입력 */
  const [bulkGongsuOpen, setBulkGongsuOpen] = useState<{
    memberId: string;
    memberName: string;
    role: string;
    dates: string[];
    dailyWage: number;
  } | null>(null);

  useEffect(() => {
    siteApi.listSites().then((s) => {
      // 「시공중」 현장만 노출 — 완공된 현장은 출역·노무마감 대상 아님 (모든 페이지 공통 정책)
      const inProgress = (s.sites ?? []).filter((x) => x.status !== 'COMPLETED');
      const visible =
        viewMode === 'SITE' && assignedSiteId
          ? inProgress.filter((x) => x.id === assignedSiteId)
          : inProgress;
      setSites(visible);
    });
  }, [viewMode, assignedSiteId]);

  const load = useCallback(async () => {
    if (!siteId) return;
    if (siteId !== 'ALL' && sites.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // 'ALL' 이면 모든 현장의 데이터를 받아 합쳐서 표시
      // HQ 모드 + 다중 현장: 항상 모든 현장 fetch (popover 용 stats 포함)
      // SITE 모드 또는 단일 현장: 그 현장만 fetch
      const allSiteIds = sites.map((s) => s.id);
      const isHQMulti = viewMode === 'HQ' && allSiteIds.length > 1;
      const fetchIds = isHQMulti ? allSiteIds : [siteId];
      const targetIds = siteId === 'ALL' ? allSiteIds : [siteId];
      if (fetchIds.length === 0 || targetIds.length === 0) {
        setMonth(null);
        setToday(null);
        setAudit([]);
        return;
      }
      // SiteCompany / Company / TeamMember 동시 로드
      try {
        const [scRes, cRes, tmRes] = await Promise.all([
          apiClient.get<{ siteCompanies: SiteCompany[] }>('/site-companies'),
          apiClient.get<{ companies: Company[] }>('/companies'),
          siteId !== 'ALL'
            ? teamApi.list({ siteId })
            : Promise.resolve({ members: [] as TeamMember[], total: 0 }),
        ]);
        setSiteCompanies(scRes.data.siteCompanies ?? []);
        setCompanies(cRes.data.companies ?? []);
        setSiteMembers((tmRes as { members: TeamMember[] }).members ?? []);
        // 인력 풀 — 전체 회사 등록 인원 (사이트 무관)
        try {
          const all = await teamApi.list({ status: 'ALL' });
          setAllMembers(all.members ?? []);
        } catch { /* ignore */ }
      } catch { /* ignore */ }
      // 모든 현장(HQ Multi 시) 또는 현재 현장만 fetch
      const [allMonths, allTodays, allAudits, closeStatuses, allCloseStatuses] = await Promise.all([
        Promise.all(fetchIds.map((sid) => attendanceApi.month({ siteId: sid, yearMonth }))),
        Promise.all(fetchIds.map((sid) => attendanceApi.today(sid))),
        Promise.all(fetchIds.map((sid) => attendanceApi.auditLog({ siteId: sid, yearMonth }))),
        // 단일 site 일 때만 단일 마감 상태 조회 (UI 가 monthClose 단일 객체로 사용)
        siteId !== 'ALL'
          ? attendanceApi.closeStatus(siteId, yearMonth)
          : Promise.resolve(null),
        // 모든 사이트의 attStage — ALL 모드 배지에서 「OO 출역확정 대기」 노출용
        Promise.all(fetchIds.map((sid) => attendanceApi.closeStatus(sid, yearMonth).catch(() => null))),
      ]);
      // siteId → attStage 매핑
      const stageMap = new Map<string, 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED'>();
      fetchIds.forEach((sid, i) => {
        const att = allCloseStatuses[i]?.monthClose?.attStage ?? 'OPEN';
        stageMap.set(sid, att);
      });
      setSiteAttStages(stageMap);
      // 디스플레이용 month/today — siteId 가 ALL 이면 전체 합산, 특정이면 그 현장만
      const displayMonths = siteId === 'ALL'
        ? allMonths
        : allMonths.filter((_, i) => fetchIds[i] === siteId);
      const displayTodays = siteId === 'ALL'
        ? allTodays
        : allTodays.filter((_, i) => fetchIds[i] === siteId);
      const displayAudits = siteId === 'ALL'
        ? allAudits
        : allAudits.filter((_, i) => fetchIds[i] === siteId);
      const months = displayMonths;
      const todays = displayTodays;
      const audits = displayAudits;
      setMonth(mergeMonths(months, yearMonth));
      setToday(mergeTodays(todays));
      // 인증관리/일일확정 — 사이트별 today 매핑 (auth-tab + new daily-tab 모두 사용)
      // 「오늘」 record 만 추출하여 사이트 ID 키로 매핑
      const todayIso = new Date().toISOString().slice(0, 10);
      const bySite: Record<string, any> = {};
      fetchIds.forEach((sid, i) => {
        const t = allTodays[i];
        // attendanceApi.today() 가 today 의 오늘자 record 를 반환 — 사이트 단위
        bySite[sid] = t;
      });
      // 기존 데이터 기반 안전 보강 — 만약 today record 의 date 가 오늘이 아니면 month 의 오늘 일자로 채움
      fetchIds.forEach((sid, i) => {
        const m = allMonths[i];
        if (!m) return;
        const todayMembers: any[] = [];
        for (const row of m.rows ?? []) {
          const rec = row.daily?.[todayIso];
          if (rec && rec.checkInAt) {
            todayMembers.push({
              memberId: row.memberId,
              memberName: row.memberName,
              role: row.role,
              status: 'CHECKED_IN',
              record: rec,
            });
          }
        }
        if (todayMembers.length > 0) {
          bySite[sid] = { ...(bySite[sid] ?? {}), members: todayMembers, summary: bySite[sid]?.summary };
        }
      });
      setTodayBySiteAuth(bySite);
      // HQ 다중 현장 모드면 항상 perSiteStats 채움 (popover 가 어디서든 동일하게 보임)
      if (isHQMulti) {
        setPerSiteStats(
          fetchIds.map((sid, i) => {
            const s = sites.find((x) => x.id === sid);
            const m = allMonths[i];
            const t = allTodays[i];
            return {
              siteId: sid,
              siteName: s?.name ?? sid,
              workingNow: t.summary.workingCount,
              todayTotal: t.summary.totalCount,
              monthGongsu: m.summary.totalGongsu,
              monthPay: m.summary.totalPay,
              members: m.summary.totalMembers,
            };
          }),
        );
      } else {
        setPerSiteStats([]);
      }
      setAudit(
        audits
          .flatMap((a) => a.entries)
          .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))
          .slice(0, 80),
      );
      setMonthClose(
        closeStatuses
          ? {
              status: closeStatuses.monthClose.status,
              stage: closeStatuses.monthClose.stage ?? (closeStatuses.monthClose.status === 'CLOSED' ? 'SITE_CLOSED' : 'OPEN'),
              attStage: closeStatuses.monthClose.attStage ?? 'OPEN',
              wageStage: closeStatuses.monthClose.wageStage ?? 'OPEN',
              attSiteClosedAt: closeStatuses.monthClose.attSiteClosedAt,
              attSiteClosedByName: closeStatuses.monthClose.attSiteClosedByName,
              attHqConfirmedAt: closeStatuses.monthClose.attHqConfirmedAt,
              attHqConfirmedByName: closeStatuses.monthClose.attHqConfirmedByName,
              closedAt: closeStatuses.monthClose.closedAt,
              closedByName: closeStatuses.monthClose.closedByName,
              hqConfirmedAt: closeStatuses.monthClose.hqConfirmedAt,
              hqConfirmedByName: closeStatuses.monthClose.hqConfirmedByName,
              settledAt: closeStatuses.monthClose.settledAt,
              settledByName: closeStatuses.monthClose.settledByName,
            }
          : null,
      );
      setSubVerifications(closeStatuses?.monthClose.subVerifications ?? []);
      setClosedDates(
        closeStatuses
          ? new Set(closeStatuses.dayCloses.filter((d) => d.status === 'CLOSED').map((d) => d.date))
          : new Set(),
      );
    } catch (err) {
      setError(getErrorMessage(err, '출퇴근 현황 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [siteId, yearMonth, sites]);

  useEffect(() => {
    load();
  }, [load]);

  // 월이 로드되면 첫 팀원 자동 선택
  // month 로드 시 selectedDate 자동 초기화 (DAILY 모드용) — 오늘이 이번 달이면 오늘, 아니면 가장 최근 출석일자
  useEffect(() => {
    if (!month) return;
    if (selectedDate) return; // 이미 설정돼 있으면 유지
    const today = new Date().toISOString().slice(0, 10);
    if (today.startsWith(yearMonth)) {
      setSelectedDate(today);
      return;
    }
    let last = '';
    for (const r of month.rows) {
      for (const d of Object.keys(r.daily)) {
        const rec = r.daily[d];
        if (rec && rec.gongsu > 0 && d > last) last = d;
      }
    }
    setSelectedDate(last || `${yearMonth}-01`);
    // selectedMemberId 는 자동 선택하지 않음 — 개인별 모드는 빈 상태로 시작
  }, [month, yearMonth, selectedDate]);

  /** 선택된 팀원의 row */
  const selectedRow = useMemo(() => {
    if (!month || !selectedMemberId) return null;
    return month.rows.find((r) => r.memberId === selectedMemberId) ?? null;
  }, [selectedMemberId, month]);

  /** 원도급 본인 뷰 여부 — DateAttendanceList(잠금) + TeamListUnified(필터) 공유 */
  const isOwnerViewer = useMemo(() => {
    if (!user || siteId === 'ALL') return false;
    return siteCompanies.some(
      (sc) =>
        sc.siteId === siteId &&
        sc.companyId === user.companyId &&
        sc.role === '원도급',
    );
  }, [user, siteId, siteCompanies]);

  /** 원/하도급 팀원 ID 분류 + 멤버별 specialty(업종) 매핑 — KPI / 캘린더 / 출석자 리스트가 공유 */
  const { ownMemberIds, subMemberIds, memberSpecialty } = useMemo(() => {
    if (siteId === 'ALL' || siteCompanies.length === 0) {
      return {
        ownMemberIds: new Set<string>(),
        subMemberIds: new Set<string>(),
        memberSpecialty: new Map<string, string>(),
      };
    }
    const subScIds = new Set(
      siteCompanies
        .filter((sc) => sc.siteId === siteId && sc.role === '하도급' && sc.status === 'ACTIVE')
        .map((sc) => sc.id),
    );
    const scMap = new Map(siteCompanies.map((sc) => [sc.id, sc] as const));
    const subSet = new Set(
      siteMembers
        .filter((m) => m.siteCompanyId && subScIds.has(m.siteCompanyId))
        .map((m) => m.id),
    );
    const ownSet = new Set(
      siteMembers.filter((m) => !subSet.has(m.id)).map((m) => m.id),
    );
    const specialtyMap = new Map<string, string>();
    for (const member of siteMembers) {
      if (member.siteCompanyId) {
        const sc = scMap.get(member.siteCompanyId);
        if (sc?.specialty) specialtyMap.set(member.id, sc.specialty);
      }
    }
    return { ownMemberIds: ownSet, subMemberIds: subSet, memberSpecialty: specialtyMap };
  }, [siteId, siteCompanies, siteMembers]);

  /** 하도급사별 출력인원 / 출력 완료 통계 — 원도급 시점 popover 용 */
  const subStats = useMemo(() => {
    if (siteId === 'ALL') return [];
    const subs = siteCompanies.filter(
      (sc) => sc.siteId === siteId && sc.role === '하도급' && sc.status === 'ACTIVE',
    );
    return subs.map((sc) => {
      const members = siteMembers.filter((m) => m.siteCompanyId === sc.id);
      const memberIds = new Set(members.map((m) => m.id));
      const todayMembers = today?.members.filter((tm) => memberIds.has(tm.memberId)) ?? [];
      const todayWorking = todayMembers.filter((m) => m.status === 'WORKING').length;
      const todayDone = todayMembers.filter((m) => m.status === 'DONE').length;
      const company = companies.find((c) => c.id === sc.companyId) ?? null;
      const verification = subVerifications.find((x) => x.siteCompanyId === sc.id) ?? null;
      return {
        sc,
        company,
        memberCount: members.length,
        todayWorking,
        todayDone,
        todayTotal: todayWorking + todayDone,
        verification,
      };
    });
  }, [siteId, siteCompanies, siteMembers, today, companies, subVerifications]);

  // 선택된 멤버가 더 이상 month 에 없으면 정리 (현장 변경 시 등)
  // + 원도급 본인 뷰에서 하도급 멤버가 선택된 경우 해제
  useEffect(() => {
    if (!month || !selectedMemberId) return;
    if (!month.rows.some((r) => r.memberId === selectedMemberId)) {
      setSelectedMemberId('');
      return;
    }
    if (isOwnerViewer && subMemberIds.has(selectedMemberId)) {
      setSelectedMemberId('');
    }
  }, [month, selectedMemberId, isOwnerViewer, subMemberIds]);

  /** 하도급 출역확인 popover — 외부 클릭 / Esc 시 닫힘 */
  useEffect(() => {
    if (!subVerifyOpen) return;
    function onDoc(e: MouseEvent) {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      if (!tgt.closest('.att__sub-verify')) setSubVerifyOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSubVerifyOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [subVerifyOpen]);

  function openGongsuDialog(args: {
    memberId: string;
    memberName: string;
    role: string;
    date: string;
    dailyWage: number;
    initial: number;
    record: AttendanceRecord | null;
    siteName?: string;
  }) {
    // 현장명 자동 보강 — 레코드의 siteId 또는 현재 화면의 siteId 기준
    const recSiteId = args.record?.siteId;
    const resolvedSite = recSiteId
      ? sites.find((s) => s.id === recSiteId)
      : (siteId !== 'ALL' ? sites.find((s) => s.id === siteId) : undefined);
    setGongsuOpen({ ...args, siteName: args.siteName ?? resolvedSite?.name });
  }

  const pageActions = (
          <>
            {/* 1);

  const pageActions = (
    <>
            {(() => {
              const siteWaiting = siteId === 'ALL'
                ? sites.filter((s) => siteAttStages.get(s.id) === 'SITE_CLOSED')
                : monthClose?.attStage === 'SITE_CLOSED'
                  ? sites.filter((s) => s.id === siteId)
                  : [];
              const allHQDone = siteId === 'ALL'
                ? sites.length > 0 && sites.every((s) => siteAttStages.get(s.id) === 'HQ_CONFIRMED')
                : monthClose?.attStage === 'HQ_CONFIRMED';
              if (siteWaiting.length > 0) {
                const first = siteWaiting[0];
                const more = siteWaiting.length - 1;
                const truncName = first.name.length > 14 ? first.name.slice(0, 14) + '…' : first.name;
                const label = more > 0 ? `${truncName} 외 ${more}건 출역확정` : `${truncName} 출역확정`;
                return (
                  <button
                    type="button"
                    className="att__close-badge att__close-badge--inline is-site att__close-badge--breathe"
                    title={`현장 출역확정 — 본사 승인 대기\n· ${siteWaiting.map((s) => s.name).join('\n· ')}`}
                    onClick={() => { if (siteId === 'ALL' || siteId !== first.id) setSiteId(first.id); }}
                  >{label}</button>
                );
              }
              if (allHQDone) {
                return (
                  <span className="att__close-badge att__close-badge--inline is-hq" title="본사 출역확정 완료">
                    ✓ 본사 출역확정 완료
                  </span>
                );
              }
              return (
                <span className="att__close-badge att__close-badge--inline is-open" title="현장에서 월 출역확정을 진행하면 여기에 표시됩니다">
                  현장 출역확정 대기
                </span>
              );
            })()}
            {/* 2) 일출역확정 / 월출역확정 — 두 버튼 (현장 모드별 권한 분기) */}
            {siteId === 'ALL' && (
              <>
                <button type="button" className="att__btn"
                  onClick={() => window.alert('일출역확정은 단일 현장에서 처리합니다.\n\n좌측에서 현장을 선택해 주세요.')}
                  title="단일 현장 선택 후 사용 가능">일출역확정</button>
                <button type="button" className="att__btn"
                  onClick={() => navigate('/gongsu-close')}
                  title="정산관리 → 월 공수마감 페이지로 이동">월 공수마감 →</button>
              </>
            )}
            {siteId !== 'ALL' && monthClose && (() => {
              const curSite = sites.find((s) => s.id === siteId);
              const mode = curSite?.attendanceConfirmMode ?? 'SITE_OFFICE';
              const att = monthClose.attStage;
              const myCompanyId = user?.companyId;
              const mySubSc = myCompanyId
                ? siteCompanies.find((sc) => sc.siteId === siteId && sc.companyId === myCompanyId && sc.role !== '원도급')
                : null;
              const subVerified = mySubSc ? subVerifications.find((v) => v.siteCompanyId === mySubSc.id) : null;
              // 말일 경과 — 월출역확정 호흡 트리거
              const last = new Date(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(5, 7)), 0, 23, 59, 59);
              const monthEndPassed = new Date() > last;
              // 누구 권한?
              //  · 일출역확정 — SITE_OFFICE 면 누구든 / HQ_DIRECT 면 본사만
              const canDoDaily = mode === 'HQ_DIRECT' ? viewMode === 'HQ' : true;
              const monthlyDone = att === 'HQ_CONFIRMED';
              // 월출역확정 호흡 — 마무리 차례
              const monthlyShouldBreathe = !monthlyDone && (
                mode === 'HQ_DIRECT'
                  ? viewMode === 'HQ' && monthEndPassed
                  : (viewMode === 'SITE' && att === 'OPEN' && monthEndPassed)
                    || (viewMode === 'HQ' && att === 'SITE_CLOSED')
              );
              // 월출역확정 가능 여부
              const monthlyDisabled = closeLoading || monthlyDone || (
                mode === 'HQ_DIRECT'
                  ? viewMode !== 'HQ'
                  : (att === 'OPEN' && viewMode !== 'SITE')
                    || (att === 'SITE_CLOSED' && viewMode !== 'HQ')
              );
              const monthlyLabel = monthlyDone
                ? '✓ 월출역확정 완료'
                : (mode === 'SITE_OFFICE' && att === 'SITE_CLOSED' && viewMode === 'HQ')
                  ? '본사 월출역확정'
                  : '월출역확정';

              async function handleDaily() {
                if (closeLoading || !canDoDaily || monthlyDone) return;
                if (todayClosed) {
                  if (!window.confirm(`오늘(${todayStr}) 일출역확정을 해제하시겠습니까?\n\n해제하면 출퇴근 데이터가 다시 편집 가능 상태로 돌아갑니다.`)) return;
                  setCloseLoading(true);
                  try {
                    await attendanceApi.dayClose({ siteId, date: todayStr, action: viewMode === 'HQ' ? 'REOPEN_BY_HQ' : 'REOPEN_BY_SITE', reason: '일출역확정 해제' });
                    await load();
                  } catch (e: any) { window.alert(getErrorMessage(e, '해제 실패')); }
                  finally { setCloseLoading(false); }
                  return;
                }
                if (!window.confirm(`오늘(${todayStr}) 일출역확정 처리하시겠습니까?\n\n그 날 출퇴근 데이터가 잠금됩니다.${mySubSc ? '\n원도급 화면에도 하도급 확인 체크가 표시됩니다.' : ''}`)) return;
                setCloseLoading(true);
                try {
                  await attendanceApi.dayClose({ siteId, date: todayStr, action: viewMode === 'HQ' ? 'CLOSE_BY_HQ' : 'CLOSE_BY_SITE' });
                  if (mySubSc && !subVerified) await attendanceApi.subVerify({ siteId, yearMonth, siteCompanyId: mySubSc.id });
                  await load();
                } catch (e: any) { window.alert(getErrorMessage(e, '확정 실패')); }
                finally { setCloseLoading(false); }
              }
              async function handleMonthly() {
                if (monthlyDisabled) return;
                // 통합 정책: 권한·단계 무관하게 한 번에 SITE_CLOSE → HQ_CONFIRM 진행 (GongsuClose 와 동일)
                if (!window.confirm(`${yearMonth} 월출역확정 처리하시겠습니까?\n\n· 출역 데이터 잠금 + 마감까지 한 번에 진행됩니다.`)) return;
                setCloseLoading(true);
                try {
                  if (att === 'OPEN') await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_SITE_CLOSE' });
                  await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_HQ_CONFIRM' });
                  window.alert('월출역확정 완료. 노무비 페이지에서 정산 단계를 진행할 수 있습니다.');
                  await load();
                } catch (e: any) { window.alert(getErrorMessage(e, '확정 실패')); }
                finally { setCloseLoading(false); }
              }

              return (
                <>
                  <button
                    type="button"
                    className={'att__btn ' + (todayClosed ? 'att__btn--ghost' : 'att__btn--primary')}
                    onClick={handleDaily}
                    disabled={closeLoading || !canDoDaily || monthlyDone}
                    title={
                      monthlyDone ? '월출역확정 후 — 변경 불가' :
                      !canDoDaily ? '본사 직접 처리 모드 — 본사 사용자만 가능' :
                      todayClosed ? '오늘 일출역확정 해제' : '오늘 일출역확정 — 출퇴근 데이터 잠금'
                    }
                  >
                    {closeLoading ? '처리 중…' : (todayClosed ? '일출역확정 해제' : '일출역확정')}
                  </button>
                  <button
                    type="button"
                    className={
                      'att__btn '
                      + (monthlyDone ? 'att__btn--ghost' : 'att__btn--primary')
                      + (monthlyShouldBreathe ? ' att__btn--breathe' : '')
                    }
                    onClick={handleMonthly}
                    disabled={monthlyDisabled}
                    title={
                      monthlyDone ? '✓ 월출역확정 완료' :
                      mode === 'HQ_DIRECT' ? '본사 직접 처리 모드 — 본사가 일/월 모두 처리' :
                      att === 'OPEN' ? '현장에서 월출역확정 진행' :
                      att === 'SITE_CLOSED' ? '본사가 월출역확정 승인' : '월출역확정'
                    }
                  >
                    {closeLoading ? '처리 중…' : monthlyLabel}
                  </button>
                </>
              );
            })()}
            {/* 3) 출역 워크플로우 — 새 일/월출역확정 버튼이 모든 단계 처리. 이 블록은 비활성. */}
            {false && siteId !== 'ALL' && monthClose && (() => {
              const att = (monthClose as NonNullable<typeof monthClose>).attStage;
              const wageInProgress = (monthClose as NonNullable<typeof monthClose>).wageStage !== 'OPEN';
              // SITE viewMode — 출역확정 / 해지 (HQ 확정 전만)
              if (viewMode === 'SITE') {
                if (att === 'OPEN') {
                  return (
                    <button
                      type="button"
                      className="att__btn att__btn--primary"
                      onClick={async () => {
                        if (closeLoading) return;
                        if (!window.confirm(`${yearMonth} 출력을 「③ 현장 월 공수 확정」 처리하시겠습니까?\n\n· 출퇴근 데이터가 잠금됩니다.\n· 본사 확정 전엔 현장에서 직접 해지 가능합니다.`)) return;
                        setCloseLoading(true);
                        try {
                          await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_SITE_CLOSE' });
                          window.alert(`${yearMonth} ③ 현장 월 공수 확정 완료. 본사 확정을 기다리세요.`);
                          await load();
                        } catch (e: any) { window.alert(getErrorMessage(e, '확정 실패')); }
                        finally { setCloseLoading(false); }
                      }}
                      disabled={closeLoading}
                    >
                      {closeLoading ? '처리 중…' : '🔒 현장 출역확정'}
                    </button>
                  );
                }
                if (att === 'SITE_CLOSED') {
                  return (
                    <button
                      type="button"
                      className="att__btn att__btn--danger"
                      onClick={async () => {
                        if (closeLoading) return;
                        if (wageInProgress) {
                          window.alert('노임 단계가 진행 중인 월은 출역을 되돌릴 수 없습니다.');
                          return;
                        }
                        const reason = window.prompt('현장 출역확정 해지 사유 (5자 이상):');
                        if (!reason || reason.trim().length < 5) return;
                        setCloseLoading(true);
                        try {
                          await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_REOPEN', reason });
                          window.alert('현장 출역확정이 해지됐습니다.');
                          await load();
                        } catch (e: any) { window.alert(getErrorMessage(e, '해지 실패')); }
                        finally { setCloseLoading(false); }
                      }}
                      disabled={closeLoading || wageInProgress}
                      title={wageInProgress ? '노임 단계가 진행 중 — 해지 불가' : '본사 확정 전에만 해지 가능'}
                    >
                      {closeLoading ? '처리 중…' : '🔓 현장 출역확정 해지'}
                    </button>
                  );
                }
                // attStage === 'HQ_CONFIRMED' — 현장은 잠김
                return (
                  <span className="att__btn att__btn--locked" title="본사가 출력을 확정했습니다 — 해지하려면 본사에 요청하세요">
                    🔒 본사 출역확정됨
                  </span>
                );
              }
              // HQ viewMode — 본사 출역확정 / 되돌림
              if (att === 'OPEN') {
                return (
                  <span className="att__btn att__btn--locked" title="현장에서 출역확정을 먼저 진행해야 합니다">
                    ⏳ 현장 출역확정 대기
                  </span>
                );
              }
              if (att === 'SITE_CLOSED') {
                return (
                  <button
                    type="button"
                    className="att__btn att__btn--primary"
                    onClick={async () => {
                      if (closeLoading) return;
                      if (!window.confirm(`${yearMonth} 의 현장 출역확정을 본사가 「④ 본사 월 공수 확정」으로 승인하시겠습니까?\n\n승인 후엔 노임비 페이지에서 노임 단계로 진행할 수 있습니다.`)) return;
                      setCloseLoading(true);
                      try {
                        await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_HQ_CONFIRM' });
                        window.alert('④ 본사 월 공수 확정 완료. 노임비 페이지에서 노임 단계를 진행하세요.');
                        await load();
                      } catch (e: any) { window.alert(getErrorMessage(e, '확정 실패')); }
                      finally { setCloseLoading(false); }
                    }}
                    disabled={closeLoading}
                  >
                    {closeLoading ? '처리 중…' : '✅ 본사 출역확정'}
                  </button>
                );
              }
              // attStage === 'HQ_CONFIRMED' — HQ 본사 확정 되돌림 (노임 미진행 시만)
              return (
                <button
                  type="button"
                  className="att__btn att__btn--ghost"
                  onClick={async () => {
                    if (closeLoading) return;
                    if (wageInProgress) {
                      window.alert('노임 단계가 진행 중인 월은 출역을 되돌릴 수 없습니다.');
                      return;
                    }
                    const reason = window.prompt('본사 출역확정 되돌림 사유 (5자 이상):');
                    if (!reason || reason.trim().length < 5) return;
                    setCloseLoading(true);
                    try {
                      await attendanceApi.monthClose({ siteId, yearMonth, action: 'ATT_REVERT_CONFIRM', reason });
                      window.alert('본사 출역확정이 되돌려졌습니다.');
                      await load();
                    } catch (e: any) { window.alert(getErrorMessage(e, '되돌리기 실패')); }
                    finally { setCloseLoading(false); }
                  }}
                  disabled={closeLoading || wageInProgress}
                  title={wageInProgress ? '노임 단계가 진행 중 — 되돌리기 불가' : '본사 출역확정을 되돌립니다'}
                >
                  ↶ 본사 출역확정 되돌림
                </button>
              );
            })()}
            {/* 4) 원도급 시점 — 하도급 출역확인 버튼 + popover (회사명·업종·출력인원·출력 완료) */}
            {siteId !== 'ALL' && user && (() => {
              const myCompanyId = user.companyId;
              const isOwner = siteCompanies.some(
                (sc) => sc.siteId === siteId && sc.companyId === myCompanyId && sc.role === '원도급',
              );
              if (!isOwner) return null;
              if (subStats.length === 0) return null;
              const verifiedCount = subStats.filter((s) => s.verification).length;
              const totalCount = subStats.length;
              const allDone = verifiedCount === totalCount;
              return (
                <span className="att__sub-verify">
                  <button
                    type="button"
                    className={
                      'att__sub-verify-btn' +
                      (subVerifyOpen ? ' is-open' : '') +
                      (allDone ? ' is-all-done' : '')
                    }
                    onClick={() => setSubVerifyOpen((v) => !v)}
                    title="하도급사별 출력인원 / 출력 완료 확인"
                  >
                    📋 하도급 출역확인
                    <strong className="att__sub-verify-count">
                      {verifiedCount}/{totalCount}
                    </strong>
                    <span className="att__sub-verify-caret">{subVerifyOpen ? '▴' : '▾'}</span>
                  </button>
                  {subVerifyOpen && (
                    <div className="att__sub-verify-popover" role="dialog">
                      <div className="att__sub-verify-popover-head">
                        <span>📋 하도급 출역확인</span>
                        <span className="att__sub-verify-popover-meta">
                          {verifiedCount}/{totalCount} 확인 완료
                        </span>
                      </div>
                      <ul className="att__sub-verify-list">
                        {subStats.map((s) => (
                          <li
                            key={s.sc.id}
                            className={
                              'att__sub-verify-item ' +
                              (s.verification ? 'is-verified' : 'is-pending')
                            }
                          >
                            <div className="att__sub-verify-row1">
                              <strong className="att__sub-verify-name">
                                {s.company?.name ?? s.sc.companyId}
                              </strong>
                              <span className="att__sub-verify-spec">
                                {s.sc.specialty ?? '업종 미지정'}
                              </span>
                            </div>
                            <div className="att__sub-verify-row2">
                              <span className="att__sub-verify-cnt">
                                출력인원 <strong>{s.memberCount}</strong>명
                                {s.todayTotal > 0 && (
                                  <em>
                                    {' '}· 오늘 출근 {s.todayTotal}명 (근무 중 {s.todayWorking})
                                  </em>
                                )}
                              </span>
                              {s.verification ? (
                                <span className="att__sub-verify-status is-verified">
                                  ✓ 출력 완료 ·{' '}
                                  {s.verification.verifiedAt.slice(0, 16).replace('T', ' ')} ·{' '}
                                  {s.verification.verifiedByName}
                                </span>
                              ) : (
                                (() => {
                                  void requestLogBump; // 강제 리렌더
                                  const lastReq = findLastRequest(todayStr, s.sc.id);
                                  const siteName = sites.find((x) => x.id === siteId)?.name ?? '';
                                  return (
                                    <span className="att__sub-verify-pending">
                                      <span
                                        className={
                                          'att__sub-verify-status is-pending' +
                                          (lastReq ? ' has-req' : '')
                                        }
                                        title={
                                          lastReq
                                            ? `요청 발송: ${lastReq.sentAt.slice(0, 16).replace('T', ' ')} · ${lastReq.sentByName}`
                                            : undefined
                                        }
                                      >
                                        {lastReq ? '📨 요청됨' : '⏳ 확인 대기'}
                                      </span>
                                      <button
                                        type="button"
                                        className={
                                          'att__sub-verify-req-btn' +
                                          (lastReq ? ' is-resend' : '')
                                        }
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSubRequestModal({
                                            siteCompanyId: s.sc.id,
                                            companyName: s.company?.name ?? s.sc.companyId,
                                            siteName,
                                            memberCount: s.memberCount,
                                            todayTotal: s.todayTotal,
                                            todayWorking: s.todayWorking,
                                            message: buildDefaultMessage({
                                              siteName,
                                              companyName: s.company?.name ?? s.sc.companyId,
                                              date: todayStr,
                                              memberCount: s.memberCount,
                                              todayTotal: s.todayTotal,
                                              todayWorking: s.todayWorking,
                                              senderName: user?.name ?? '원도급 담당자',
                                            }),
                                            channels: ['APP', 'SMS'],
                                            sending: false,
                                          });
                                          setSubVerifyOpen(false);
                                        }}
                                        title={
                                          lastReq
                                            ? '재요청 — 한 번 더 알림을 보냅니다'
                                            : '하도급사에 출역확인을 요청하는 알림을 보냅니다'
                                        }
                                      >
                                        {lastReq ? '🔁 재요청' : '✉️ 요청'}
                                      </button>
                                    </span>
                                  );
                                })()
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </span>
              );
            })()}
            {/* 5) 엑셀 업로드 */}
            <button
              type="button"
              className="att__btn att__btn--ghost"
              onClick={() => {
                if (siteId === 'ALL') { window.alert('엑셀 업로드는 단일 현장에서 처리합니다.'); return; }
                setUploadOpen(true);
              }}
              title="출퇴근 데이터를 엑셀로 일괄 업로드 — 입력양식 또는 노임대장 양식 중 선택"
            >
              엑셀 업로드
            </button>
          </>
  );


  return (
    <div className="att" data-att-tab={attTab}>
      <PageHeader
        title={attTab === 'auth' ? '인증관리' : '일일 출역확정'}
        subtitle={attTab === 'auth'
          ? '얼굴인식·GPS·수기입력 출근 로그를 검증합니다. 「이 출근 기록을 믿을 수 있나?」'
          : '인증된 출근을 바탕으로 오늘 공수를 확정합니다. 월말에는 「월 공수마감」 으로 넘깁니다.'}
        actions={(() => {
          const ymDate = new Date(yearMonth + '-01');
          const daysInMonth = new Date(ymDate.getFullYear(), ymDate.getMonth() + 1, 0).getDate();
          const todayDay = new Date().getDate();
          const todayYM = new Date().toISOString().slice(0, 7);
          const denomDays = yearMonth === todayYM ? todayDay : daysInMonth;
          const closedCount = closedDates.size;
          const dailyPct = denomDays > 0 ? Math.round((closedCount / denomDays) * 100) : 0;
          const todayMembers = today?.members ?? [];
          const todayAttended = todayMembers.filter((m) => m.record?.checkInAt).length;
          const todayAuthOk = todayMembers.filter((m) => {
            const r = m.record;
            if (!r?.checkInAt) return false;
            if (r.checkInMethod === 'MANUAL') return false;
            if (r.geofenceResult && r.geofenceResult !== 'INSIDE') return false;
            if (r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7) return false;
            return true;
          }).length;
          const authPct = todayAttended > 0 ? Math.round((todayAuthOk / todayAttended) * 100) : 0;
          const isAuthTab = attTab === 'auth';
          const currentPct = isAuthTab ? authPct : dailyPct;
          const currentLabel = isAuthTab ? `오늘 ${todayAuthOk}/${todayAttended}명 인증 (${authPct}%)` : undefined;
          return (
            <WorkCloseHeader
              active={isAuthTab ? 'auth' : 'daily'}
              siteId={siteId}
              progress={computeWorkCloseProgress({ today, monthClose })}
              currentStepProgress={currentPct}
              currentStepLabel={currentLabel}
              rightActions={undefined}
            />
          );
        })()}
      />


      {attTab === 'auth' && (() => {
        const foremanById = new Map(foremen.map((f) => [f.id, f]));
        const memberById = new Map(allMembers.map((m) => [m.id, m]));
        const siteName = (sid: string) => sites.find((s) => s.id === sid)?.name ?? '—';
        const fmtTime = (iso?: string | null) => {
          if (!iso) return '—';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '—';
          return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        };

        // 사이트별 stat 계산
        type AuthStat = {
          siteId: string; siteName: string;
          total: number; normal: number; pending: number; check: number;
          faceOk: number; manual: number; gpsErr: number;
          status: 'ok' | 'warn' | 'danger';
          records: any[];
        };
        function classify(rec: any): 'ok' | 'pending' | 'check' {
          if (!rec) return 'ok';
          if (rec.checkInMethod === 'MANUAL') return 'pending';
          const faceFail = rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7;
          const gpsBad = rec.geofenceResult && rec.geofenceResult !== 'INSIDE';
          if (faceFail || gpsBad) return 'check';
          return 'ok';
        }

        const visibleSites = sites.filter((s) => s.status !== 'COMPLETED');
        const sourceSites = (siteId === 'ALL' ? visibleSites : visibleSites.filter((s) => s.id === siteId));
        // 기간 내 records 가져오기 — 단일 today 면 todayBySiteAuth, 그 외엔 month.rows 에서 추출
        const todayIso = new Date().toISOString().slice(0, 10);
        const isSingleToday = authStartDate === todayIso && authEndDate === todayIso;
        function buildRecordsForSite(s: any): any[] {
          if (isSingleToday) {
            const t = todayBySiteAuth[s.id];
            return (t?.members ?? []).filter((tm: any) => !!tm.record);
          }
          // month state has merged rows; filter by site via members (foremanId etc.) — but rows don't carry siteId.
          // Use allMembers to map memberId → siteId, then filter month.rows.
          const memberSiteMap = new Map(allMembers.map((m: any) => [m.id, m.siteId]));
          const out: any[] = [];
          for (const row of (month?.rows ?? [])) {
            if (memberSiteMap.get(row.memberId) !== s.id) continue;
            for (const [d, rec] of Object.entries(row.daily ?? {})) {
              if (!rec) continue;
              if (d < authStartDate || d > authEndDate) continue;
              out.push({ memberId: row.memberId, memberName: row.memberName, role: row.role, status: 'DONE', record: rec });
            }
          }
          return out;
        }
        // 처리된 record 도 항상 노출 — 상태 칩으로 구분하므로 큐/이력 모드 분리 불필요.
        // (이전 로직: site 모드에서 처리된 record 숨김 → 토글 제거 후 통일)
        function filterHandled(records: any[]): any[] {
          return records;
        }
        const stats: AuthStat[] = sourceSites.map((s) => {
          const records = filterHandled(buildRecordsForSite(s));
          const normal  = records.filter((tm: any) => classify(tm.record) === 'ok').length;
          const pending = records.filter((tm: any) => classify(tm.record) === 'pending').length;
          const check   = records.filter((tm: any) => classify(tm.record) === 'check').length;
          const faceOk  = records.filter((tm: any) => tm.record.checkInMethod === 'FACE' && (tm.record.checkInScore ?? 0) > 0.7).length;
          const manual  = records.filter((tm: any) => tm.record.checkInMethod === 'MANUAL').length;
          const gpsErr  = records.filter((tm: any) => tm.record.geofenceResult && tm.record.geofenceResult !== 'INSIDE').length;
          const total   = records.length;
          const facePool   = records.filter((tm: any) => tm.record.checkInMethod === 'FACE').length;
          const faceFailRate = facePool > 0 ? (facePool - faceOk) / facePool : 0;
          let status: AuthStat['status'];
          if (pending === 0 && check === 0 && gpsErr === 0) status = 'ok';
          else if (pending >= 5 || gpsErr >= 5 || faceFailRate >= 0.2) status = 'danger';
          else status = 'warn';
          return { siteId: s.id, siteName: s.name, total, normal, pending, check, faceOk, manual, gpsErr, status, records };
        });

        // 정렬: 위험 → 승인대기 많은 → GPS 오류 많은 → 수기 많은 → 정상
        const statusOrder = { danger: 0, warn: 1, ok: 2 } as const;
        const sortedStats = [...stats].sort((a, b) => {
          if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
          if (a.pending !== b.pending) return b.pending - a.pending;
          if (a.gpsErr !== b.gpsErr) return b.gpsErr - a.gpsErr;
          if (a.manual !== b.manual) return b.manual - a.manual;
          return 0;
        });

        // 전체 합계 (상단 요약)
        const total = stats.reduce((s, x) => s + x.total, 0);
        const totNormal  = stats.reduce((s, x) => s + x.normal, 0);
        const totManual  = stats.reduce((s, x) => s + x.manual, 0);
        const totGpsErr  = stats.reduce((s, x) => s + x.gpsErr, 0);
        const totPending = stats.reduce((s, x) => s + x.pending, 0);

        // 선택된 사이트의 상세 records (또는 전체)
        const selectedSite = authSelectedSite
          ? sortedStats.find((x) => x.siteId === authSelectedSite)
          : sortedStats[0];

        // records 필터링
        function applyFilter(rs: any[], f: typeof authFilter) {
          return rs.filter((tm) => {
            const r = tm.record;
            if (!r) return false;
            const cls = classify(r);
            switch (f) {
              case 'all':     return true;
              case 'normal':  return cls === 'ok';
              case 'pending': return cls === 'pending';
              case 'check': {
                // 확인필요 = GPS 오류 OR 얼굴실패 — 수기입력(MANUAL)은 「승인대기」로 분리
                const gpsBad   = !!(r.geofenceResult && r.geofenceResult !== 'INSIDE');
                const manual   = r.checkInMethod === 'MANUAL';
                const faceFail = r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7;
                if (manual) return false; // 승인대기와 중복 방지 — 수기는 그쪽에서 처리
                return gpsBad || faceFail;
              }
              case 'rejected': {
                // 반려 — markAuthHandled 로 'rejected' 처리된 record 만 표시
                return authHandledRecords.get(r.id)?.action === 'rejected';
              }
              // 호환성 유지 — 옛 키 호출 시도 동작
              case 'gps':       return !!(r.geofenceResult && r.geofenceResult !== 'INSIDE');
              case 'manual':    return r.checkInMethod === 'MANUAL';
              case 'face_fail': return r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7;
            }
            return true;
          });
        }

        const allRecords = stats.flatMap((s) => s.records.map((tm: any) => ({ ...tm, _siteId: s.siteId })));
        const detailRecordsRaw = authView === 'all'
          ? applyFilter(allRecords, authFilter)
          : (selectedSite ? applyFilter(selectedSite.records, authFilter) : []);

        // ─── 정렬 적용 (authSortCol 기준) ─────────────────────────
        function authSortValue(tm: any, col: AuthSortCol): string | number {
          const r = tm.record!;
          const member = memberById.get(tm.memberId);
          const foreman = member?.foremanId ? foremanById.get(member.foremanId) : undefined;
          switch (col) {
            case 'name':     return tm.memberName ?? '';
            case 'foreman':  return foreman?.name ?? '';
            case 'site':     return siteName(r.siteId) ?? '';
            case 'date':     return r.date ?? r.checkInAt ?? '';
            case 'time':     return r.checkInAt ?? '';
            case 'method':   return r.checkInMethod ?? '';
            case 'face':     return r.checkInScore ?? -1;
            case 'gps':      return r.geofenceResult ?? '';
            case 'distance': return r.distanceFromSiteM ?? -1;
            case 'status':   return classify(r);
            default:         return 0;
          }
        }
        const detailRecords = (() => {
          if (!authSortCol) return detailRecordsRaw;
          const sorted = [...detailRecordsRaw];
          sorted.sort((a, b) => {
            const va = authSortValue(a, authSortCol);
            const vb = authSortValue(b, authSortCol);
            if (typeof va === 'number' && typeof vb === 'number') return va - vb;
            return String(va).localeCompare(String(vb), 'ko');
          });
          if (authSortDir === 'desc') sorted.reverse();
          return sorted;
        })();

        // 정렬 가능한 헤더 — 화살표 표시 (asc ▲ / desc ▼ / 미선택 ↕︎)
        function SortableTh({ col, children, className }: { col: AuthSortCol; children: React.ReactNode; className?: string }) {
          const isActive = authSortCol === col;
          const arrow = isActive ? (authSortDir === 'asc' ? '▲' : '▼') : '↕';
          return (
            <th className={(className ?? '') + ' sortable' + (isActive ? ' is-active' : '')}
                onClick={() => toggleAuthSort(col)}>
              <span className="sortable__label">{children}</span>
              <span className="sortable__arrow" aria-hidden>{arrow}</span>
            </th>
          );
        }

        function renderRow(tm: any, includeSiteCol: boolean, includeDateCol: boolean = false, idx: number = 0) {
          const r = tm.record!;
          const member = memberById.get(tm.memberId);
          const foreman = member?.foremanId ? foremanById.get(member.foremanId) : undefined;
          const isManual = r.checkInMethod === 'MANUAL';
          const isFace = r.checkInMethod === 'FACE';
          const score = r.checkInScore ?? 0;
          const faceLabel = isFace ? (score > 0.7 ? '성공' : '실패') : (member?.faceVerified === false ? '미등록' : '실패');
          const faceTone  = isFace ? (score > 0.7 ? 'ok' : 'danger') : 'gray';
          // 라이브니스 시연 — 얼굴 success 면 통과, 실패면 실패, 외엔 미실시
          const liveLabel = isFace ? (score > 0.7 ? '성공' : '실패') : '실패';
          const liveTone  = isFace ? (score > 0.7 ? 'ok' : 'danger') : 'gray';
          const gpsLabel  = r.geofenceResult === 'INSIDE' ? '정상' : '이탈';
          const gpsTone   = r.geofenceResult === 'INSIDE' ? 'ok' : r.geofenceResult ? 'danger' : 'gray';
          const cls = classify(r);
          const statusLabel = cls === 'ok' ? '정상' : cls === 'pending' ? '승인대기' : '확인필요';
          const statusTone  = cls === 'ok' ? 'green' : cls === 'pending' ? 'amber' : 'red';
          // MANUAL 입력은 입력자별로 분류 — 시연 모드: 멤버 ID 해시 기반 결정적 노이즈
          //   · 반장입력 (현장 반장이 직접 입력)
          //   · 현장입력 (현장담당자/사무실에서 입력)
          // 실 운영: r.manualBy === 'FOREMAN' | 'SITE' | 'HQ' 필드로 구분
          let methodLabel: string;
          let methodTone: string;
          if (r.checkInMethod === 'FACE') {
            methodLabel = '얼굴인식';
            methodTone = 'face';
          } else if (r.checkInMethod === 'MANUAL') {
            // 우선순위: 실제 record.manualEntryRole > legacy manualBy > 시연 fallback
            const role = (r.manualEntryRole ?? (r as any).manualBy) as 'HQ' | 'SITE' | 'FOREMAN' | undefined;
            if (role === 'HQ') {
              methodLabel = '본사입력'; methodTone = 'hq';
            } else if (role === 'FOREMAN') {
              methodLabel = '반장입력'; methodTone = 'foreman';
            } else if (role === 'SITE') {
              methodLabel = '현장입력'; methodTone = 'site';
            } else {
              // 시연 — record id 해시로 50/50 분배
              let h = 0;
              for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
              if (h % 2 === 0) { methodLabel = '반장입력'; methodTone = 'foreman'; }
              else             { methodLabel = '현장입력'; methodTone = 'site'; }
            }
          } else {
            methodLabel = '—';
            methodTone = 'gray';
          }
          const distance = r.distanceFromSiteM !== undefined ? Math.round(r.distanceFromSiteM) + 'm' : '—';

          return (
            <tr key={r.id} className={'auth-row auth-row--' + cls + ' is-clickable'}
                onClick={() => setAuthDetailRecord(tm)}
                role="button" tabIndex={0}
                title="상세 로그 보기">
              <td className="auth-td-no">{idx + 1}</td>
              <td className="auth-td-name auth-td-name--link"><strong>{tm.memberName}</strong></td>
              <td>{foreman ? foreman.name + ' 반장' : '—'}</td>
              {includeSiteCol && <td className="auth-td-site">{siteName(r.siteId)}</td>}
              {includeDateCol && <td className="auth-td-num">{r.date ?? r.checkInAt?.slice(0, 10) ?? '—'}</td>}
              <td className="auth-td-num">{fmtTime(r.checkInAt)}</td>
              <td><span className={'auth-pill auth-pill--' + methodTone}>{methodLabel}</span></td>
              <td><span className={'auth-pill auth-pill--mini auth-pill--' + faceTone}>{isFace && score > 0 ? Math.round(score*100) + '%' : faceLabel}</span></td>
              <td><span className={'auth-pill auth-pill--mini auth-pill--' + liveTone}>{liveLabel}</span></td>
              <td><span className={'auth-pill auth-pill--mini auth-pill--' + gpsTone}>{gpsLabel}</span></td>
              <td className="auth-td-num">{distance}</td>
              <td>
                {(() => {
                  const entry = authHandledRecords.get(r.id);
                  if (entry) {
                    const handledLabel = entry.action === 'approved' ? '승인' : entry.action === 'rejected' ? '반려' : '확인';
                    const handledTone  = entry.action === 'rejected' ? 'red' : 'green';
                    return (
                      <span className={'auth-status auth-status--' + handledTone}
                        title={`${handledLabel} · ${new Date(entry.at).toLocaleString('ko-KR')}${entry.by ? ' · ' + entry.by : ''}`}>
                        {handledLabel}
                      </span>
                    );
                  }
                  return <span className={'auth-status auth-status--' + statusTone}>{statusLabel}</span>;
                })()}
              </td>
              <td className="auth-td-actions" onClick={(e) => e.stopPropagation()}>
                {/* 처리된 record 는 액션 버튼 모두 숨김 — 상태 칩으로 결과 확인.
                 *  미처리 record (handled 없음) 만 행위별 버튼 노출.
                 *  「상세」 버튼은 제거 — 행 클릭으로 상세 모달 열림. */}
                {!authHandledRecords.has(r.id) && cls === 'pending' && (
                  <>
                    <button type="button" className="auth-btn auth-btn--ok"
                      onClick={(e) => { e.stopPropagation(); setAuthActionPrompt({ tm, action: 'approved' }); }}>승인</button>
                    <button type="button" className="auth-btn auth-btn--no"
                      onClick={(e) => { e.stopPropagation(); setAuthActionPrompt({ tm, action: 'rejected' }); }}>반려</button>
                  </>
                )}
                {!authHandledRecords.has(r.id) && cls === 'check' && (
                  <button type="button" className="auth-btn auth-btn--no"
                    onClick={(e) => { e.stopPropagation(); setAuthActionPrompt({ tm, action: 'confirmed' }); }}>확인</button>
                )}
                {authHandledRecords.has(r.id) && (
                  <span className="auth-td-actions__done">처리완료</span>
                )}
              </td>
            </tr>
          );
        }

        const SUMMARY_FILTERS: Array<{ key: typeof authFilter; label: string; value: number; tone: 'plain' | 'ok' | 'amber' | 'danger' }> = [
          { key: 'all',     label: '오늘 인증',  value: total,      tone: 'plain'  },
          { key: 'normal',  label: '정상',       value: totNormal,  tone: 'ok'     },
          { key: 'manual',  label: '수기입력',   value: totManual,  tone: 'amber'  },
          { key: 'gps',     label: 'GPS 오류',   value: totGpsErr,  tone: 'danger' },
          { key: 'pending', label: '승인대기',   value: totPending, tone: 'amber'  },
        ];

        // 메인 4 칩 + (오늘 인증 모드에서만) 세분화 3 칩 + 처리이력 1 칩
        const FILTER_CHIPS: Array<{ key: typeof authFilter; label: string; group?: 'main' | 'sub' | 'history' }> = [
          { key: 'all',       label: '전체',     group: 'main' },
          { key: 'normal',    label: '정상',     group: 'main' },
          { key: 'pending',   label: '승인대기', group: 'main' },
          { key: 'check',     label: '확인필요', group: 'main' },
          // 세분화 — 「오늘 인증」 모드에서만 노출 (확인필요 분해)
          { key: 'gps',       label: 'GPS 오류',  group: 'sub' },
          // { key: 'face_fail', label: '라이브니스', group: 'sub' },  // 사용자 요청으로 제거
          { key: 'manual',    label: '수기입력',  group: 'sub' },
          // ── 별도 카테고리: 처리 이력 (전체 로그 보기에서만) ──
          { key: 'rejected',  label: '반려',     group: 'history' },
        ];

        // 칩별 해당 근로자 수 — 현장별 보기면 선택 현장 records, 전체 로그 보기면 모든 records 기준
        const filterSourceRecords = authView === 'site'
          ? (selectedSite?.records ?? [])
          : allRecords;
        const filterCounts: Record<typeof authFilter, number> = {
          all:       filterSourceRecords.length,
          normal:    filterSourceRecords.filter((tm: any) => classify(tm.record) === 'ok').length,
          pending:   filterSourceRecords.filter((tm: any) => classify(tm.record) === 'pending').length,
          // 확인필요 — GPS 오류 / 얼굴실패 (수기입력은 「승인대기」로 분리)
          check:     filterSourceRecords.filter((tm: any) => {
                       const r = tm.record;
                       const gpsBad   = !!(r.geofenceResult && r.geofenceResult !== 'INSIDE');
                       const manual   = r.checkInMethod === 'MANUAL';
                       const faceFail = r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7;
                       if (manual) return false;
                       return gpsBad || faceFail;
                     }).length,
          // 반려 — 처리 이력에서 'rejected' 인 record 수
          rejected:  filterSourceRecords.filter((tm: any) => authHandledRecords.get(tm.record?.id)?.action === 'rejected').length,
          gps:       filterSourceRecords.filter((tm: any) => tm.record.geofenceResult && tm.record.geofenceResult !== 'INSIDE').length,
          manual:    filterSourceRecords.filter((tm: any) => tm.record.checkInMethod === 'MANUAL').length,
          face_fail: filterSourceRecords.filter((tm: any) => tm.record.checkInMethod === 'FACE' && (tm.record.checkInScore ?? 0) <= 0.7).length,
        };

        return (
          <section className="att-auth-panel" aria-label="인증관리">
            {/* 5 요약 카드 — iOS 알림 카드 톤 (일일 출역확정과 동일 패턴) */}
            <div className="att-daily-kpi--notif">
              {SUMMARY_FILTERS.map((s) => {
                const active = authFilter === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    className={'att-hero__tile att-hero__tile--' + s.tone + (active ? ' is-active' : '')}
                    onClick={() => setAuthFilter(s.key)}
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
                      <span className="att-hero__sub">
                        <b>{s.value.toLocaleString('ko-KR')}</b>건
                      </span>
                    </span>
                    <span className="att-hero__time">{active ? '필터중' : '오늘'}</span>
                  </button>
                );
              })}
            </div>
            {/* 보기 토글 + 인라인 기간 필터 (가로 1단, 박스 없음)
             *  · 「오늘 인증」(site view) — 오늘 1일자 record 만 노출. 기간 필터 UI 숨김.
             *  · 「전체 로그 보기」(all view) — 전체 기간 record + 처리이력 라벨. 기간 필터 노출.
             *  · 보기 토글은 좌측 끝, 알약 필터칩은 우측 끝. */}
            <div className="auth-toolbar-inline">
              {/* 기간 필터 — 항상 노출 (오늘/이번 주/이번 달/전체 + 날짜 입력)
               *  보기 토글(「오늘 인증/전체 로그」) 는 제거 — 기간 변경으로 동일 효과. */}
              <span className="auth-inline-label">기간</span>
              <button type="button" className={'auth-date-chip' + (authDatePreset === 'today' ? ' is-active' : '')}
                onClick={() => { setAuthWeekModeActive(false); applyAuthDatePreset('today'); }}>오늘</button>
              <button type="button" className={'auth-date-chip auth-date-chip--accent' + (authWeekModeActive ? ' is-active' : '')}
                onClick={() => {
                  const next = !authWeekModeActive;
                  setAuthWeekModeActive(next);
                  if (next) applyAuthDatePreset('week');
                }}>이번 주</button>

              {/* 「이번 주」 활성 시 — 월~일 요일 칩 인라인 노출. */}
              {authWeekModeActive && (() => {
                const labels = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
                const order = ['mon','tue','wed','thu','fri','sat','sun'] as const;
                const jsDay = new Date().getDay();
                const todayIdx = jsDay === 0 ? 6 : jsDay - 1;
                return order.map((d, idx) => {
                  const isFuture = idx > todayIdx;
                  return (
                    <button key={d} type="button"
                      className={'auth-date-chip auth-date-chip--day' + (authDatePreset === d ? ' is-active' : '') + (isFuture ? ' is-disabled' : '')}
                      disabled={isFuture}
                      aria-disabled={isFuture}
                      onClick={() => { if (!isFuture) applyAuthDatePreset(d); }}
                      title={isFuture ? '아직 도래하지 않은 요일' : undefined}
                    >{labels[d]}</button>
                  );
                });
              })()}

              <button type="button" className={'auth-date-chip' + (authDatePreset === 'month' ? ' is-active' : '')}
                onClick={() => { setAuthWeekModeActive(false); applyAuthDatePreset('month'); }}>이번 달</button>
              <button type="button" className={'auth-date-chip' + (authDatePreset === 'all' ? ' is-active' : '')}
                onClick={() => { setAuthWeekModeActive(false); applyAuthDatePreset('all'); }}>전체</button>

              <MacDatePicker
                value={authStartDate}
                onChange={(v) => { setAuthStartDate(v); setAuthDatePreset('custom'); setAuthWeekModeActive(false); }}
              />
              <span className="auth-inline-tilde" aria-hidden>~</span>
              <MacDatePicker
                value={authEndDate}
                onChange={(v) => { setAuthEndDate(v); setAuthDatePreset('custom'); setAuthWeekModeActive(false); }}
              />

              {/* 필터 칩 — 우측 끝
               *  · 메인 (전체/정상/승인대기/확인필요) + 세분화 (GPS/라이브니스/수기) + 처리이력(반려) 모두 항상 노출
               *  · 처리된 record 는 상태 칩으로 구분 — 별도 모드 토글 불필요 */}
              <div className="auth-filter-chips auth-filter-chips--right">
                {FILTER_CHIPS
                  .map((f, i, arr) => {
                    const prev = i > 0 ? arr[i - 1] : null;
                    const needDivider = prev && prev.group !== f.group;
                  return (
                    <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {needDivider && <span className="auth-inline-divider" aria-hidden />}
                      <button
                        type="button"
                        className={'auth-filter-chip auth-filter-chip--xs' + (authFilter === f.key ? ' is-active' : '') + (f.group === 'history' ? ' auth-filter-chip--history' : '')}
                        onClick={() => setAuthFilter(f.key)}
                      >
                        <span className="auth-filter-chip__label">{f.label}</span>
                        <span className="auth-filter-chip__count">{filterCounts[f.key]}</span>
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>

            {authView === 'site' ? (
              <div className="auth-split">
                {/* LEFT 1/3 — 현장별 카드 */}
                <aside className="auth-sites">
                  {sortedStats.length === 0 ? (
                    <div className="auth-empty auth-empty--small">시공중인 현장이 없습니다.</div>
                  ) : sortedStats.map((s) => {
                    const isSelected = (selectedSite?.siteId === s.siteId);
                    const statusLabel = s.status === 'ok' ? '정상' : s.status === 'warn' ? '주의' : '위험';
                    const statusTone  = s.status === 'ok' ? 'green' : s.status === 'warn' ? 'amber' : 'red';
                    return (
                      <button
                        key={s.siteId}
                        type="button"
                        className={'auth-site-card' + (isSelected ? ' is-selected' : '') + ' auth-site-card--' + s.status}
                        onClick={() => setAuthSelectedSite(s.siteId)}
                      >
                        <div className="auth-site-card__head">
                          <span className={'auth-status auth-status--' + statusTone}>{statusLabel}</span>
                          <strong className="auth-site-card__name" title={s.siteName}>{s.siteName}</strong>
                        </div>
                        <div className="auth-site-card__line">
                          인증 <strong>{s.total}</strong>·정상 <strong>{s.normal}</strong>·확인 <strong>{s.check}</strong>·승인 <strong>{s.pending}</strong>
                        </div>
                        <div className="auth-site-card__line auth-site-card__line--sub">
                          수기 {s.manual}·GPS {s.gpsErr}·얼굴 {s.faceOk}
                        </div>
                      </button>
                    );
                  })}
                </aside>

                {/* RIGHT 2/3 — 선택 현장 상세 */}
                <section className="auth-detail">
                  {!selectedSite ? (
                    <div className="auth-empty">왼쪽에서 현장을 선택하세요.</div>
                  ) : (
                    <>
                      <header className="auth-detail__head">
                        <h3>{selectedSite.siteName}</h3>
                        <p>오늘 인증 {selectedSite.total}명 · 정상 {selectedSite.normal}명 · 확인필요 {selectedSite.check}명 · 승인대기 {selectedSite.pending}명</p>
                      </header>

                      {detailRecords.length === 0 ? (
                        <div className="auth-empty">선택한 필터에 해당하는 기록이 없습니다.</div>
                      ) : (
                        <div className="auth-table-wrap">
                          <table className="auth-table">
                            <thead>
                              <tr>
                                <th className="auth-th-no">#</th>
                                <SortableTh col="name" className="auth-th-name">근로자</SortableTh>
                                <SortableTh col="foreman">반장</SortableTh>
                                <SortableTh col="time">인증시간</SortableTh>
                                <SortableTh col="method">인증방식</SortableTh>
                                <SortableTh col="face">얼굴상태</SortableTh>
                                <th>라이브니스</th>
                                <SortableTh col="gps">GPS상태</SortableTh>
                                <SortableTh col="distance">위치</SortableTh>
                                <SortableTh col="status">상태</SortableTh>
                                <th>조치</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detailRecords.map((tm: any, idx: number) => renderRow(tm, false, false, idx))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            ) : (
              <div className="auth-split">
                {/* LEFT 1/3 — 현장별 카드 (과거 로그 포함) */}
                <aside className="auth-sites">
                  {sortedStats.length === 0 ? (
                    <div className="auth-empty auth-empty--small">시공중인 현장이 없습니다.</div>
                  ) : sortedStats.map((s) => {
                    const isSelected = (selectedSite?.siteId === s.siteId);
                    const statusLabel = s.status === 'ok' ? '정상' : s.status === 'warn' ? '주의' : '위험';
                    const statusTone  = s.status === 'ok' ? 'green' : s.status === 'warn' ? 'amber' : 'red';
                    return (
                      <button
                        key={s.siteId}
                        type="button"
                        className={'auth-site-card' + (isSelected ? ' is-selected' : '') + ' auth-site-card--' + s.status}
                        onClick={() => setAuthSelectedSite(s.siteId)}
                      >
                        <div className="auth-site-card__head">
                          <span className={'auth-status auth-status--' + statusTone}>{statusLabel}</span>
                          <strong className="auth-site-card__name" title={s.siteName}>{s.siteName}</strong>
                        </div>
                        <div className="auth-site-card__line">
                          로그 <strong>{s.total}</strong>·정상 <strong>{s.normal}</strong>·확인 <strong>{s.check}</strong>·승인 <strong>{s.pending}</strong>
                        </div>
                        <div className="auth-site-card__line auth-site-card__line--sub">
                          수기 {s.manual}·GPS {s.gpsErr}·얼굴 {s.faceOk}
                        </div>
                      </button>
                    );
                  })}
                </aside>

                {/* RIGHT 2/3 — 선택 현장의 과거 로그 상세 */}
                <section className="auth-detail">
                  {!selectedSite ? (
                    <div className="auth-empty">왼쪽에서 현장을 선택하세요.</div>
                  ) : (
                    <>
                      <header className="auth-detail__head">
                        <h3>{selectedSite.siteName}</h3>
                        <p>로그 {selectedSite.total}건 · 정상 {selectedSite.normal} · 확인필요 {selectedSite.check} · 승인대기 {selectedSite.pending}</p>
                      </header>

                      {detailRecords.length === 0 ? (
                        <div className="auth-empty">선택한 필터에 해당하는 기록이 없습니다.</div>
                      ) : (
                        <div className="auth-table-wrap">
                          <table className="auth-table">
                            <thead>
                              <tr>
                                <th className="auth-th-no">#</th>
                                <SortableTh col="name" className="auth-th-name">근로자</SortableTh>
                                <SortableTh col="foreman">반장</SortableTh>
                                <SortableTh col="date">일자</SortableTh>
                                <SortableTh col="time">인증시간</SortableTh>
                                <SortableTh col="method">인증방식</SortableTh>
                                <SortableTh col="face">얼굴상태</SortableTh>
                                <th>라이브니스</th>
                                <SortableTh col="gps">GPS상태</SortableTh>
                                <SortableTh col="distance">위치</SortableTh>
                                <SortableTh col="status">상태</SortableTh>
                                <th>조치</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detailRecords.map((tm: any, idx: number) => renderRow(tm, false, true, idx))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
          </section>
        );
      })()}

      {/* ───── 일일 출역확정 — 새 레이아웃 (인증관리 패턴) ─────
       *  · 보기 토글: 현장별 보기 / 월간 캘린더 / 개인별 보기 (기본 현장별)
       *  · 5 KPI: 오늘 출역 / 확정완료 / 확인필요 / 예외공수 / 오늘 노무비
       *  · 좌 1/3: 현장별 일일 확정 상태 카드
       *  · 우 2/3: 선택 현장 근로자별 공수 확정 목록 + 일괄 확정 버튼
       *  · 출역 미등록은 별도 패널 토글로 분리
       * ─────────────────────────────────────────────── */}
      {attTab === 'daily' && (() => {
        // 보기 토글 + (현장별 보기일 때만) 새 레이아웃
        const visibleSites = sites.filter((s) => s.status !== 'COMPLETED');
        const sourceSites = (siteId === 'ALL' ? visibleSites : visibleSites.filter((s) => s.id === siteId));
        const memberById = new Map(allMembers.map((m) => [m.id, m]));
        const foremanById = new Map(foremen.map((f) => [f.id, f]));

        // 현장별 stat 계산 — 오늘 record 기반
        type DailyStat = {
          siteId: string; siteName: string;
          total: number;
          done: number;
          check: number;
          pending: number;       // 미확정 (얼굴인식 OK 인데 아직 확정 처리 안 됨)
          manual: number;
          lateEarly: number;     // 지각/조퇴
          exception: number;     // 예외공수 (수동 입력 / 0.5 / 외부업무 등)
          payToday: number;      // 오늘 노무비
          status: 'ok' | 'warn' | 'danger';
          records: any[];
        };
        function classifyDaily(rec: any, key: string): { kind: 'done' | 'check' | 'pending' | 'manual' | 'lateEarly' | 'exception'; isException: boolean } {
          const handled = dailyHandled.get(key);
          if (handled?.action === 'done') return { kind: 'done', isException: false };
          if (!rec) return { kind: 'pending', isException: false };
          // 확인필요 (인증관리 분류 일치)
          const faceFail = rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7;
          const gpsBad   = !!(rec.geofenceResult && rec.geofenceResult !== 'INSIDE');
          if (faceFail || gpsBad) return { kind: 'check', isException: false };
          if (rec.checkInMethod === 'MANUAL') return { kind: 'manual', isException: true };
          // 지각/조퇴 — record.late / record.early 플래그 (없으면 false)
          if (rec.late || rec.early) return { kind: 'lateEarly', isException: false };
          // 예외 공수 — gongsu 가 0.5 이거나 1.0 이 아닌 경우
          const g = rec.gongsu ?? 0;
          if (g > 0 && g !== 1 && g !== 1.0) return { kind: 'exception', isException: true };
          return { kind: 'pending', isException: false };
        }

        const stats: DailyStat[] = sourceSites.map((s) => {
          const t = todayBySiteAuth[s.id];
          const records = (t?.members ?? []).filter((tm: any) => !!tm.record);
          let done = 0, check = 0, pending = 0, manual = 0, lateEarly = 0, exception = 0, payToday = 0;
          for (const tm of records) {
            const k = (tm.record?.id ?? tm.memberId) + ':' + s.id;
            const c = classifyDaily(tm.record, k);
            if (c.kind === 'done') done++;
            else if (c.kind === 'check') check++;
            else if (c.kind === 'manual') { manual++; exception++; }
            else if (c.kind === 'lateEarly') lateEarly++;
            else if (c.kind === 'exception') exception++;
            else pending++;
            const wage = tm.record?.dailyWage ?? 0;
            const g = tm.record?.gongsu ?? 0;
            payToday += wage * g;
          }
          let status: DailyStat['status'];
          if (check === 0 && pending === 0) status = 'ok';
          else if (check >= 5 || pending >= 5) status = 'danger';
          else status = 'warn';
          return {
            siteId: s.id, siteName: s.name,
            total: records.length, done, check, pending, manual, lateEarly, exception, payToday,
            status, records,
          };
        });

        // 정렬: 위험 → 미확정 많음 → 확인필요 많음 → 수동 많음 → 정상
        const statusOrder = { danger: 0, warn: 1, ok: 2 } as const;
        const sortedStats = [...stats].sort((a, b) => {
          if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
          if (a.pending !== b.pending) return b.pending - a.pending;
          if (a.check !== b.check) return b.check - a.check;
          if (a.manual !== b.manual) return b.manual - a.manual;
          return 0;
        });

        // 선택 현장 (없으면 정렬 첫 번째)
        const selected = dailySelectedSite
          ? sortedStats.find((s) => s.siteId === dailySelectedSite) ?? sortedStats[0]
          : sortedStats[0];

        // KPI — 선택 현장 기준 (없으면 0). 표 합계와 일대일로 매칭되어 신뢰성 보장.
        // (기존엔 모든 사이트 합계라서 우측 표(선택 현장)와 숫자가 달라 혼란)
        const kpiTotal     = selected?.total ?? 0;
        const kpiDone      = selected?.done ?? 0;
        const kpiCheck     = selected?.check ?? 0;
        const kpiException = selected?.exception ?? 0;
        const kpiPay       = selected?.payToday ?? 0;
        function kFmt(n: number): string {
          if (!n) return '0';
          if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
          if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
          return n.toLocaleString();
        }

        // 필터 적용
        function applyDailyFilter(records: any[], f: typeof dailyFilter): any[] {
          return records.filter((tm) => {
            const k = (tm.record?.id ?? tm.memberId) + ':' + (selected?.siteId ?? '');
            const c = classifyDaily(tm.record, k);
            switch (f) {
              case 'all':       return true;
              case 'pending':   return c.kind === 'pending';
              case 'done':      return c.kind === 'done';
              case 'check':     return c.kind === 'check';
              case 'manual':    return c.kind === 'manual';
              case 'lateEarly': return c.kind === 'lateEarly';
              case 'exception': return c.isException;
            }
            return true;
          });
        }
        const detailRecordsRaw = selected ? applyDailyFilter(selected.records, dailyFilter) : [];

        // ─── 일일확정 테이블 정렬 ────────────────────────────────
        function dailySortValue(tm: any, col: DailySortCol): string | number {
          const r = tm.record;
          const member = memberById.get(tm.memberId);
          const foreman = member?.foremanId ? foremanById.get(member.foremanId) : undefined;
          const k = (r?.id ?? tm.memberId) + ':' + (selected?.siteId ?? '');
          const handled = dailyHandled.get(k);
          const baseG = r?.gongsu ?? 0;
          const finalG = handled?.gongsu ?? baseG;
          switch (col) {
            case 'name':       return tm.memberName ?? '';
            case 'role':       return tm.role || member?.role || '';
            case 'foreman':    return foreman?.name ?? '';
            case 'auth':       return r?.checkInMethod === 'FACE' ? (r.geofenceResult === 'INSIDE' && (r.checkInScore ?? 0) > 0.7 ? 1 : 2) : 3;
            case 'in':         return r?.checkInAt ?? '';
            case 'out':        return r?.checkOutAt ?? '';
            case 'exception':  return r?.late ? 1 : r?.early ? 2 : r?.checkInMethod === 'MANUAL' ? 3 : finalG !== 1 && finalG > 0 ? 4 : 0;
            case 'base':       return baseG;
            case 'final':      return finalG;
            case 'wage':       return r?.dailyWage ?? 0;
            case 'pay':        return (r?.dailyWage ?? 0) * finalG;
            case 'status':     return handled?.action ?? 'pending';
            default:           return 0;
          }
        }
        const detailRecords = (() => {
          if (!dailySortCol) return detailRecordsRaw;
          const sorted = [...detailRecordsRaw];
          sorted.sort((a, b) => {
            const va = dailySortValue(a, dailySortCol);
            const vb = dailySortValue(b, dailySortCol);
            if (typeof va === 'number' && typeof vb === 'number') return va - vb;
            return String(va).localeCompare(String(vb), 'ko');
          });
          if (dailySortDir === 'desc') sorted.reverse();
          return sorted;
        })();

        // 정렬 가능 헤더 컴포넌트 (인증관리와 동일 톤)
        function DailySortableTh({ col, children, className }: { col: DailySortCol; children: React.ReactNode; className?: string }) {
          const isActive = dailySortCol === col;
          const arrow = isActive ? (dailySortDir === 'asc' ? '▲' : '▼') : '↕';
          return (
            <th className={(className ?? '') + ' sortable' + (isActive ? ' is-active' : '')}
                onClick={() => toggleDailySort(col)}>
              <span className="sortable__label">{children}</span>
              <span className="sortable__arrow" aria-hidden>{arrow}</span>
            </th>
          );
        }

        // 인증상태 라벨 — 수동 등록(MANUAL)은 출처(본사/현장/반장)에 따라 별도 표시
        function authBadge(rec: any): { label: string; tone: 'ok' | 'warn' | 'danger' | 'amber'; subtitle?: string } {
          if (!rec) return { label: '—', tone: 'warn' };
          const faceOk = rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) > 0.7;
          const gpsOk  = rec.geofenceResult === 'INSIDE';
          const faceFail = rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7;
          const gpsBad   = rec.geofenceResult && rec.geofenceResult !== 'INSIDE';
          if (faceFail || gpsBad) return { label: '확인필요', tone: 'danger' };
          if (faceOk && gpsOk)    return { label: '얼굴+GPS', tone: 'ok' };
          if (faceOk)             return { label: '얼굴', tone: 'ok' };
          if (rec.checkInMethod === 'MANUAL') {
            // 수동 등록 — 출처 기반 라벨
            const role = rec.manualEntryRole;
            if (role === 'HQ')      return { label: '본사 입력', tone: 'amber', subtitle: rec.manualEntryByName };
            if (role === 'SITE')    return { label: '현장 입력', tone: 'amber', subtitle: rec.manualEntryByName };
            if (role === 'FOREMAN') return { label: '반장 입력', tone: 'amber', subtitle: rec.manualEntryByName };
            return { label: '수기승인', tone: 'amber' };
          }
          return { label: '확인필요', tone: 'warn' };
        }
        function exceptionLabel(rec: any): string {
          if (!rec) return '없음';
          if (rec.early) return '조기퇴근';
          if (rec.late)  return '지각';
          if (rec.checkInMethod === 'MANUAL') return '외부업무';
          const g = rec.gongsu ?? 0;
          if (g === 0.5) return '반일';
          if (g > 1)     return '연장';
          return '없음';
        }
        function statusLabel(rec: any, key: string): { label: string; tone: 'ok' | 'amber' | 'danger' | 'gray' } {
          const handled = dailyHandled.get(key);
          if (handled?.action === 'done')     return { label: '확정완료', tone: 'ok' };
          if (handled?.action === 'hold')     return { label: '보류',     tone: 'gray' };
          if (handled?.action === 'excluded') return { label: '제외',     tone: 'danger' };
          const c = classifyDaily(rec, key);
          if (c.kind === 'check') return { label: '확인필요', tone: 'danger' };
          return { label: '확정대기', tone: 'amber' };
        }

        function fmtTime(iso?: string | null): string {
          if (!iso) return '—';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '—';
          return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        }

        // 일괄 확정 가능자 = 확정대기 + 인증OK
        function bulkDoneEligible(records: any[]): any[] {
          return records.filter((tm: any) => {
            const k = (tm.record?.id ?? tm.memberId) + ':' + (selected?.siteId ?? '');
            const c = classifyDaily(tm.record, k);
            return c.kind === 'pending';
          });
        }
        function handleBulkDone() {
          if (!selected) return;
          const eligible = bulkDoneEligible(selected.records);
          const hasCheck = selected.check > 0;
          const proceedMsg = hasCheck
            ? `확인필요 ${selected.check}건이 있습니다. 확인필요 건을 제외하고 ${eligible.length}명을 일괄 확정하시겠습니까?`
            : `${eligible.length}명을 일괄 확정하시겠습니까?`;
          if (!window.confirm(proceedMsg)) return;
          for (const tm of eligible) {
            const k = (tm.record?.id ?? tm.memberId) + ':' + selected.siteId;
            markDailyHandled(k, 'done');
          }
        }

        const SUMMARY: Array<{ key: typeof dailyFilter; label: string; value: number; tone: 'plain' | 'ok' | 'amber' | 'danger'; unit?: string; raw?: string }> = [
          { key: 'all',       label: '오늘 출역',  value: kpiTotal,     tone: 'plain'  , unit: '명' },
          { key: 'done',      label: '확정완료',   value: kpiDone,      tone: 'ok'     , unit: '명' },
          { key: 'check',     label: '확인필요',   value: kpiCheck,     tone: 'danger' , unit: '건' },
          { key: 'exception', label: '예외공수',   value: kpiException, tone: 'amber'  , unit: '건' },
          { key: 'all',       label: '오늘 노무비', value: 0,           tone: 'plain'  , raw: kFmt(kpiPay) + '원' },
        ];
        const FILTER_CHIPS: Array<{ key: typeof dailyFilter; label: string }> = [
          { key: 'all',       label: '전체' },
          { key: 'pending',   label: '확정대기' },
          { key: 'done',      label: '확정완료' },
          { key: 'check',     label: '확인필요' },
          { key: 'manual',    label: '수동처리' },
          { key: 'lateEarly', label: '지각/조퇴' },
          { key: 'exception', label: '예외공수' },
        ];
        const filterCounts: Record<typeof dailyFilter, number> = (() => {
          const src = selected?.records ?? [];
          const out: any = {};
          for (const f of FILTER_CHIPS) out[f.key] = applyDailyFilter(src, f.key).length;
          return out;
        })();

        return (
          <section className="att-daily-panel" aria-label="일일 출역확정">
            {/* 「현장별 보기」일 때만 새 레이아웃 노출. 다른 보기는 아래 기존 UI 가 표시. */}
            {dailyView === 'site' && (
              <>
                {/* 5 KPI — iOS 알림 카드 톤 */}
                <div className="att-daily-kpi att-daily-kpi--notif">
                  {SUMMARY.map((s, i) => {
                    const active = dailyFilter === s.key && s.label !== '오늘 노무비';
                    return (
                      <button
                        key={i}
                        type="button"
                        className={'att-hero__tile att-hero__tile--' + s.tone + (active ? ' is-active' : '')}
                        onClick={() => setDailyFilter(s.key)}
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
                          <span className="att-hero__sub">
                            {s.raw ?? <><b>{s.value.toLocaleString('ko-KR')}</b>{s.unit}</>}
                          </span>
                        </span>
                        <span className="att-hero__time">{active ? '필터중' : '오늘'}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 액션 바 — 아래 auth-split [300px sidebar | 16px gap | 1fr detail] 와 X축 정렬
                 *  · LEFT 셀  : 오늘 확정 / 월간 내역 토글  (사이드바 컬럼 위)
                 *  · RIGHT 셀 : 현장 일일확정 완료 + + 출역 추가 + 필터 칩  (디테일 카드 컬럼 좌측 정렬) */}
                <div className="att-daily-actionbar">
                  <div className="att-daily-actionbar__left">
                    <div className="auth-view-toggle">
                      <button type="button"
                        className={'auth-view-btn' + ((dailyView as string) === 'site' ? ' is-active' : '')}
                        onClick={() => setDailyView('site')}>오늘 확정</button>
                      <button type="button"
                        className={'auth-view-btn' + ((dailyView as string) === 'calendar' ? ' is-active' : '')}
                        onClick={() => setDailyView('calendar')}>월간 내역</button>
                    </div>
                  </div>
                  <div className="att-daily-actionbar__right">
                    {/* 일일확정 / 확정 취소 — 코랄 레드 primary, 토글 + 안내 팝업 */}
                    {(() => {
                      const dailyClosed = !!selected && closedDates.has(todayStr);
                      // 본사 확정 / 노무비 단계 — 월 단위 stage 사용
                      const wageStage = monthClose?.wageStage;
                      const attStage = monthClose?.attStage;
                      const isWageInProgress = wageStage && wageStage !== 'OPEN';
                      const isHqConfirmed = attStage === 'HQ_CONFIRMED';
                      if (dailyClosed) {
                        return (
                          <button type="button" className="auth-btn auth-btn--primary auth-btn--coral"
                            onClick={async () => {
                              if (!selected) return;
                              // 1) 노무비 마감/지급 중 → 취소 불가 안내
                              if (isWageInProgress) {
                                window.alert('노무비 마감(혹은 노무비 지급) 중입니다.\n수정을 원하시면 본사 담당자에게 문의하시기 바랍니다.');
                                return;
                              }
                              // 2) 본사 확정 완료 → 취소 불가 안내
                              if (isHqConfirmed) {
                                window.alert('본사에서도 출역확정이 완료되었습니다.\n수정을 원하시면 본사 담당자에게 문의하시기 바랍니다.');
                                return;
                              }
                              // 3) 현장 확정만 → 취소 확인 후 reopen
                              if (!window.confirm('확정을 취소하시겠습니까?')) return;
                              try {
                                await attendanceApi.dayClose({
                                  siteId: selected.siteId,
                                  date: todayStr,
                                  action: viewMode === 'HQ' ? 'REOPEN_BY_HQ' : 'REOPEN_BY_SITE',
                                  reason: '일일확정 취소',
                                });
                                await load();
                              } catch (e: any) {
                                window.alert(getErrorMessage(e, '확정 취소 실패'));
                              }
                            }}
                            title="일일확정 취소"
                          >확정 취소</button>
                        );
                      }
                      return (
                        <button type="button" className="auth-btn auth-btn--primary auth-btn--coral"
                          disabled={!selected || selected.check > 0 || selected.pending > 0}
                          onClick={async () => {
                            if (!selected) return;
                            if (!window.confirm(`${selected.siteName} 일일확정 완료 처리하시겠습니까?\n\n· ${todayStr} 일자 잠금\n· 월 공수마감의 「미확정 일수」 카운트에서 제외됩니다`)) return;
                            try {
                              await attendanceApi.dayClose({
                                siteId: selected.siteId,
                                date: todayStr,
                                action: viewMode === 'HQ' ? 'CLOSE_BY_HQ' : 'CLOSE_BY_SITE',
                              });
                              flashCompletion(`${selected.siteName} 일일확정 완료`);
                              await load();
                            } catch (e: any) {
                              window.alert(getErrorMessage(e, '일일확정 처리 실패'));
                            }
                          }}
                          title={selected && (selected.check > 0 || selected.pending > 0) ? '확인필요 또는 미확정이 남아있어 완료 불가' : ''}
                        >일일확정</button>
                      );
                    })()}
                    {/* + 출역 추가 — 배경색 제거 (ghost) */}
                    <button type="button" className="auth-btn"
                      onClick={() => setDailyPoolOpen(true)}
                      title="출역 대기 인력 패널 열기 — 오늘 출역에 추가할 수 있습니다">
                      <span aria-hidden style={{ fontWeight: 800, marginRight: 4 }}>＋</span>출역 추가
                    </button>
                    <div className="auth-filter-chips auth-filter-chips--right">
                      {FILTER_CHIPS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          className={'auth-filter-chip auth-filter-chip--xs' + (dailyFilter === f.key ? ' is-active' : '')}
                          onClick={() => setDailyFilter(f.key)}
                        >
                          <span className="auth-filter-chip__label">{f.label}</span>
                          <span className="auth-filter-chip__count">{filterCounts[f.key]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 좌 1/3 + 우 2/3 분할 */}
                <div className="auth-split">
                  {/* LEFT — 현장 카드 */}
                  <aside className="auth-sites">
                    {sortedStats.length === 0 ? (
                      <div className="auth-empty auth-empty--small">시공중인 현장이 없습니다.</div>
                    ) : sortedStats.map((s) => {
                      const isSelected = selected?.siteId === s.siteId;
                      const sLabel = s.status === 'ok' ? '정상' : s.status === 'warn' ? '주의' : '위험';
                      const sTone  = s.status === 'ok' ? 'green' : s.status === 'warn' ? 'amber' : 'red';
                      return (
                        <button
                          key={s.siteId}
                          type="button"
                          className={'auth-site-card' + (isSelected ? ' is-selected' : '') + ' auth-site-card--' + s.status}
                          onClick={() => setDailySelectedSite(s.siteId)}
                        >
                          {/* 1행: 상태뱃지 + 현장명 1줄 말줄임 */}
                          <div className="auth-site-card__head">
                            <span className={'auth-status auth-status--' + sTone}>{sLabel}</span>
                            <strong className="auth-site-card__name" title={s.siteName}>{s.siteName}</strong>
                          </div>
                          {/* 2행 핵심 — 출역 / 확정 / 확인 / 노무비 */}
                          <div className="auth-site-card__line">
                            출역 <strong>{s.total}</strong>·확정 <strong>{s.done}</strong>·확인 <strong>{s.check}</strong>·<strong>{kFmt(s.payToday)}원</strong>
                          </div>
                          {/* 3행 보조 — 수동·미확정·예외 */}
                          <div className="auth-site-card__line auth-site-card__line--sub">
                            수동 {s.manual}·미확정 {s.pending}·예외 {s.exception}
                          </div>
                        </button>
                      );
                    })}
                  </aside>

                  {/* RIGHT — 근로자별 공수 확정 테이블 */}
                  <div className="auth-detail">
                    {!selected ? (
                      <div className="auth-empty">현장을 선택하세요.</div>
                    ) : (
                      <>
                        {(() => {
                          // ─── 확정 공수 합산 + 0.5/1.0/1.5/2.0 별 인원 그룹핑 ───
                          // 확정 record(handled.action === 'done') 만 대상.
                          // 공수 값은 handled.gongsu 우선 (사용자 수정값), 없으면 record.gongsu.
                          let doneTotalGongsu = 0;
                          const byGongsu = new Map<number, number>();   // 공수 값 → 인원
                          for (const tm of selected.records) {
                            const r = tm.record;
                            const k = (r?.id ?? tm.memberId) + ':' + selected.siteId;
                            const handled = dailyHandled.get(k);
                            if (handled?.action !== 'done') continue;
                            const g = handled?.gongsu ?? r?.gongsu ?? 0;
                            doneTotalGongsu += g;
                            byGongsu.set(g, (byGongsu.get(g) ?? 0) + 1);
                          }
                          // 표시용 정렬: 큰 공수 → 작은 공수
                          const breakdown = [...byGongsu.entries()]
                            .filter(([g]) => g > 0)
                            .sort((a, b) => b[0] - a[0])
                            .map(([g, n]) => `${g}공수 ${n}명`)
                            .join(', ');
                          return (
                            <header className="att-daily-summary">
                              <strong className="att-daily-summary__name">{selected.siteName}</strong>
                              <div className="att-daily-summary__line">
                                {/* 누계 금액 — 가장 앞 (사용자 요청: 제목 하단 첫 항목으로, 원 단위 풀 표기) */}
                                <span className="att-daily-summary__sum">
                                  누계 <strong>{Math.round(selected.payToday).toLocaleString('ko-KR')}원</strong>
                                </span>
                                <span className="att-daily-summary__sep">·</span>
                                오늘 출역 <strong>{selected.total}명</strong>
                                <span className="att-daily-summary__sep">·</span>
                                확정 <strong>{doneTotalGongsu.toFixed(1).replace(/\.0$/, '')}공수</strong>
                                {breakdown && (
                                  <span className="att-daily-summary__breakdown">({breakdown})</span>
                                )}
                                <span className="att-daily-summary__sep">·</span>
                                확인필요 <strong>{selected.check}건</strong>
                              </div>
                            </header>
                          );
                        })()}

                        {detailRecords.length === 0 ? (
                          <div className="auth-empty auth-empty--small">조건에 해당하는 근로자가 없습니다.</div>
                        ) : (
                          <div className="att-daily-table-wrap">
                            <table className="att-daily-table">
                              <thead>
                                <tr>
                                  <th className="att-daily-th-no">#</th>
                                  <DailySortableTh col="name" className="att-daily-th-name">근로자</DailySortableTh>
                                  <DailySortableTh col="role">직종</DailySortableTh>
                                  <DailySortableTh col="foreman">반장</DailySortableTh>
                                  <DailySortableTh col="auth">인증상태</DailySortableTh>
                                  <DailySortableTh col="in">출근</DailySortableTh>
                                  <DailySortableTh col="out">퇴근</DailySortableTh>
                                  <DailySortableTh col="exception">예외</DailySortableTh>
                                  <DailySortableTh col="base">기본</DailySortableTh>
                                  <DailySortableTh col="final">최종</DailySortableTh>
                                  <DailySortableTh col="wage">일당</DailySortableTh>
                                  <DailySortableTh col="pay">오늘임금</DailySortableTh>
                                  <DailySortableTh col="status">상태</DailySortableTh>
                                  <th>조치</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detailRecords.map((tm: any, idx: number) => {
                                  const r = tm.record;
                                  const k = (r?.id ?? tm.memberId) + ':' + selected.siteId;
                                  const member = memberById.get(tm.memberId);
                                  const foreman = member?.foremanId ? foremanById.get(member.foremanId) : undefined;
                                  const ab = authBadge(r);
                                  const sl = statusLabel(r, k);
                                  const handled = dailyHandled.get(k);
                                  const baseGongsu = r?.gongsu ?? 0;
                                  const finalGongsu = handled?.gongsu ?? baseGongsu;
                                  const dailyWage = r?.dailyWage ?? 0;
                                  const todayPay = dailyWage * finalGongsu;
                                  // 한국 이름 3자 ≈ 7~8자 라틴 폭. 그 이상이면 좌측 슬라이딩 마키.
                                  const isLongName = (tm.memberName ?? '').length > 4;
                                  return (
                                    <tr key={k}>
                                      <td className="att-daily-td-no">{idx + 1}</td>
                                      <td className="att-daily-td-name">
                                        <span className={'att-daily-name' + (isLongName ? ' att-daily-name--marquee' : '')}>
                                          <span className="att-daily-name__inner">{tm.memberName}</span>
                                        </span>
                                      </td>
                                      <td>{tm.role || member?.role || '—'}</td>
                                      <td>{foreman?.name ?? '—'}</td>
                                      <td>
                                        <span
                                          className={'auth-pill auth-pill--' + ab.tone}
                                          title={ab.subtitle ? `${ab.label} — ${ab.subtitle}` : ab.label}
                                        >
                                          {ab.label}
                                        </span>
                                      </td>
                                      <td>{fmtTime(r?.checkInAt)}</td>
                                      <td>{fmtTime(r?.checkOutAt)}</td>
                                      <td>{exceptionLabel(r)}</td>
                                      <td>{baseGongsu.toFixed(1)}</td>
                                      <td><strong>{finalGongsu.toFixed(1)}</strong></td>
                                      <td>{dailyWage.toLocaleString('ko-KR')}원</td>
                                      <td><strong>{kFmt(todayPay)}원</strong></td>
                                      <td><span className={'auth-status auth-status--' + sl.tone}>{sl.label}</span></td>
                                      <td className="att-daily-actions">
                                        {!handled && (
                                          <button type="button" className="auth-btn auth-btn--ok auth-btn--xs"
                                            onClick={() => markDailyHandled(k, 'done')}>확정</button>
                                        )}
                                        <button type="button" className="auth-btn auth-btn--xs"
                                          onClick={() => {
                                            // 「공수수정」 = 월간 캘린더와 동일한 SetGongsuDialog 사용
                                            //  · 0 / 0.5 / 1.0 / 1.5 / 2.0 5단계 선택 + 사유 입력 + 임금 자동 계산
                                            //  · 「공수수정」 버튼 클릭 자체로 「확정완료」 처리 — 다이얼로그 저장/취소 무관 (사용자 의도 존중)
                                            //  · 다이얼로그 저장 시 attendanceApi.setGongsu 가 record 를 직접 갱신 → load() 후 새 공수가 표 반영
                                            markDailyHandled(k, 'done');
                                            openGongsuDialog({
                                              memberId: tm.memberId,
                                              memberName: tm.memberName,
                                              role: (member?.role ?? tm.role ?? ''),
                                              date: (r?.date ?? todayStr),
                                              dailyWage: (r?.dailyWage ?? 0),
                                              initial: finalGongsu,
                                              record: r ?? null,
                                              siteName: selected.siteName,
                                            });
                                          }}
                                        >공수수정</button>
                                        {handled?.action !== 'hold' && (
                                          <button type="button" className="auth-btn auth-btn--xs"
                                            onClick={() => markDailyHandled(k, 'hold')}>보류</button>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* 출역 대기 인력 — 중앙 모달 (월간 뷰의 풀 모달과 동일 디자인) */}
                {dailyPoolOpen && (() => {
                  const checkedIds = new Set((today?.members ?? []).filter((tm: any) => tm.record).map((tm: any) => tm.memberId));
                  const pool = (selected
                    ? allMembers.filter((m) => m.siteId === selected.siteId && !checkedIds.has(m.id))
                    : allMembers.filter((m) => !checkedIds.has(m.id))
                  );
                  return (
                    <Modal
                      open
                      onClose={() => setDailyPoolOpen(false)}
                      title="출역 대기 인력"
                      subtitle={
                        <>
                          <div>{selected?.siteName ?? '전체'} · {pool.length}명</div>
                          <div style={{ marginTop: 2 }}>등록되었지만 출역 기록이 없는 인력</div>
                        </>
                      }
                      width={640}
                    >
                      <div className="att-monthly-pool">
                        <div className="att-monthly-pool__actions">
                          <button type="button" className="auth-btn auth-btn--ok"
                            onClick={() => { setDailyPoolOpen(false); setQuickAddOpen(true); }}>＋ 신규 근로자 등록</button>
                          <button type="button" className="auth-btn"
                            onClick={() => { setDailyPoolOpen(false); setUploadOpen(true); }}>엑셀 업로드</button>
                          <button type="button" className="auth-btn"
                            onClick={() => window.alert('반장에게 카카오톡·SMS 로 출역자 확인 요청을 보냅니다. (시연)')}>반장에게 등록 요청</button>
                        </div>
                        {pool.length === 0 ? (
                          <p className="att-monthly-pool__empty">전원 출역 등록 완료 — 대기 인력이 없습니다.</p>
                        ) : (
                          <>
                            <p className="att-monthly-pool__hint">
                              ＋ 출역 추가 — 해당 인력에 대해 출역 기록을 수동으로 추가합니다 (사유 필수, 감사 로그 기록)
                            </p>
                            <ul className="att-monthly-pool__list">
                              {pool.slice(0, 50).map((m) => (
                                <li key={m.id} className="att-monthly-pool__item">
                                  <strong>{m.name}</strong>
                                  <em>{m.role || '—'}</em>
                                  <span className="att-monthly-pool__role">{m.contractSigned === false ? '계약 미체결' : ''}</span>
                                  <button
                                    type="button"
                                    className="auth-btn auth-btn--ok att-monthly-pool__add"
                                    disabled={m.contractSigned === false}
                                    title={
                                      m.contractSigned === false
                                        ? '근로계약 미체결 — 계약 체결 후 출역 추가 가능'
                                        : `${m.name} — 오늘 출역으로 추가`
                                    }
                                    onClick={() => { setDailyPoolOpen(false); setAttendAddFor(m); }}
                                  >
                                    ＋ 출역 추가
                                  </button>
                                </li>
                              ))}
                            </ul>
                            {pool.length > 50 && (
                              <p className="att-monthly-pool__more">… 외 {pool.length - 50}명 — 검색·필터 기능은 다음 단계에 추가 예정</p>
                            )}
                          </>
                        )}
                      </div>
                    </Modal>
                  );
                })()}
              </>
            )}
          </section>
        );
      })()}

      {/* ───── 월간 내역 — 3단 레이아웃 (조회 전용) ─────
       *  · 좌 1/4 : 현장별 월 상태 카드
       *  · 가운데 2/4 : 선택 현장 근로자별 월 공수 테이블
       *  · 우 1/4 : 미니 달력 + 출역 대기 인력 토글
       *  · 마감/잠금 X — 「월 공수마감」 버튼은 라우팅만
       * ─────────────────────────────────────────────── */}
      {attTab === 'daily' && dailyView === 'calendar' && (() => {
        const visibleSites = sites.filter((s) => s.status !== 'COMPLETED');
        const sourceSites = (siteId === 'ALL' ? visibleSites : visibleSites.filter((s) => s.id === siteId));
        const memberById = new Map(allMembers.map((m) => [m.id, m]));
        const foremanById = new Map(foremen.map((f) => [f.id, f]));

        // ─── 사이트별 월간 stat ───
        type MStat = {
          siteId: string; siteName: string;
          memberSet: Set<string>;
          totalGongsu: number;
          totalPay: number;
          done: number;
          check: number;
          unconfirmedDays: number;
          exception: number;
          manual: number;
          status: 'ok' | 'warn' | 'danger';
        };
        const memberSiteMap = new Map(allMembers.map((m) => [m.id, m.siteId]));
        function isCheckRecord(rec: any): boolean {
          const faceFail = rec?.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7;
          const gpsBad = rec?.geofenceResult && rec.geofenceResult !== 'INSIDE';
          return !!(faceFail || gpsBad);
        }
        const ymDate = new Date(yearMonth + '-01');
        const daysInMonth = new Date(ymDate.getFullYear(), ymDate.getMonth() + 1, 0).getDate();
        const todayYM = new Date().toISOString().slice(0, 7);
        const todayDay = new Date().getDate();
        const passedDays = yearMonth === todayYM ? todayDay : daysInMonth;

        // ── 현장별 stats 계산 ──
        const monthRows = month?.rows ?? [];
        const stats: MStat[] = sourceSites.map((s) => {
          const memberSet = new Set<string>();
          let totalGongsu = 0, totalPay = 0, done = 0, check = 0, exception = 0, manual = 0;
          const dateAttended = new Set<string>();
          for (const row of monthRows) {
            if (memberSiteMap.get(row.memberId) !== s.id) continue;
            for (const [d, rec] of Object.entries(row.daily ?? {})) {
              if (!rec) continue;
              if (rec.status === 'ABSENT') continue;
              if (!rec.checkInAt) continue;
              memberSet.add(row.memberId);
              dateAttended.add(d);
              const k = rec.id + ':' + s.id;
              const handled = dailyHandled.get(k);
              const g = handled?.gongsu ?? rec.gongsu ?? 0;
              totalGongsu += g;
              totalPay += (rec.dailyWage ?? 0) * g;
              const isHandledDone = handled?.action === 'done';
              if (isHandledDone) done++;
              // 확인필요 — 처리된(done) record 는 카운트에서 제외 (실시간 반영)
              if (isCheckRecord(rec) && !isHandledDone) check++;
              if (rec.checkInMethod === 'MANUAL') { manual++; if (!isHandledDone) exception++; }
              else if (g > 0 && g !== 1 && !isHandledDone) exception++;
            }
          }
          // 미확정 일수 — 출역이 발생한 일자 중 closedDates 에 없는 것
          let unconfirmedDays = 0;
          for (const d of dateAttended) if (!closedDates.has(d)) unconfirmedDays++;

          let status: MStat['status'];
          if (check === 0 && unconfirmedDays === 0) status = 'ok';
          else if (check >= 5 || unconfirmedDays >= 5) status = 'danger';
          else status = 'warn';
          return { siteId: s.id, siteName: s.name, memberSet, totalGongsu, totalPay, done, check, unconfirmedDays, exception, manual, status };
        });

        const statusOrder = { danger: 0, warn: 1, ok: 2 } as const;
        const sortedStats = [...stats].sort((a, b) => {
          if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
          if (a.check !== b.check) return b.check - a.check;
          if (a.unconfirmedDays !== b.unconfirmedDays) return b.unconfirmedDays - a.unconfirmedDays;
          if (a.exception !== b.exception) return b.exception - a.exception;
          return 0;
        });

        const selectedM = monthlySelectedSite
          ? sortedStats.find((s) => s.siteId === monthlySelectedSite) ?? sortedStats[0]
          : sortedStats[0];

        // ── 선택 현장의 근로자별 월간 합계 ──
        type MMember = {
          memberId: string;
          memberName: string;
          role: string;
          foremanName: string;
          attendDays: number;
          totalGongsu: number;
          baseGongsu: number;
          exceptionGongsu: number;
          manualCount: number;
          checkCount: number;
          monthPay: number;
          status: 'closeable' | 'check' | 'hold' | 'closed' | 'done';
          dailyMap: Record<string, number>;     // 일자 → 공수
          /** 확정 완료된 일자 수 (handled.action === 'done') */
          doneDayCount: number;
        };
        function buildMembers(siteIdSel: string, dateFilter: string | null): MMember[] {
          const out: MMember[] = [];
          for (const row of monthRows) {
            if (memberSiteMap.get(row.memberId) !== siteIdSel) continue;
            const member = memberById.get(row.memberId);
            const foreman = member?.foremanId ? foremanById.get(member.foremanId) : undefined;
            let attendDays = 0, totalGongsu = 0, baseG = 0, excG = 0;
            let manualCount = 0, manualUnhandled = 0;
            let checkCount = 0, checkUnhandled = 0;
            let doneCount = 0;
            let monthPay = 0;
            const dailyMap: Record<string, number> = {};
            let hasDateFilter = false;
            for (const [d, rec] of Object.entries(row.daily ?? {})) {
              if (!rec || rec.status === 'ABSENT' || !rec.checkInAt) continue;
              if (dateFilter && d !== dateFilter) continue;
              if (dateFilter) hasDateFilter = true;
              const k = rec.id + ':' + siteIdSel;
              const handled = dailyHandled.get(k);
              const g = handled?.gongsu ?? rec.gongsu ?? 0;
              attendDays++;
              totalGongsu += g;
              monthPay += (rec.dailyWage ?? 0) * g;
              if (g === 1) baseG += g; else if (g > 0) excG += g;
              const isHandledDone = handled?.action === 'done';
              if (isHandledDone) doneCount++;
              if (rec.checkInMethod === 'MANUAL') {
                manualCount++;
                if (!isHandledDone) manualUnhandled++;
              }
              if (isCheckRecord(rec)) {
                checkCount++;
                if (!isHandledDone) checkUnhandled++;
              }
              dailyMap[d] = g;
            }
            if (dateFilter && !hasDateFilter) continue;
            if (attendDays === 0) continue;
            // 상태 결정 우선순위:
            //   1) closed   — 모든 일자가 일일확정(closedDates) 처리됨
            //   2) check    — 미처리 확인필요·수동입력 record 가 남아있음
            //   3) done     — 모든 출역일이 개별 확정 완료 (handled.action='done')
            //   4) closeable — 그 외 (마감/확정 가능)
            let status: MMember['status'] = 'closeable';
            const allClosed = Object.keys(dailyMap).every((d) => closedDates.has(d));
            if (allClosed) {
              status = 'closed';
            } else if (checkUnhandled > 0 || manualUnhandled > 0) {
              status = 'check';
            } else if (doneCount === attendDays && attendDays > 0) {
              status = 'done';
            }
            out.push({
              memberId: row.memberId, memberName: row.memberName, role: row.role,
              foremanName: foreman?.name ?? '—',
              attendDays, totalGongsu, baseGongsu: baseG, exceptionGongsu: excG,
              // 표 컬럼 — 미처리 카운트로 노출 (handled.action='done' 은 카운트에서 제외)
              manualCount: manualUnhandled,
              checkCount: checkUnhandled,
              monthPay, status, dailyMap,
              doneDayCount: doneCount,
            });
          }
          return out;
        }
        const filteredMembersRaw = selectedM ? buildMembers(selectedM.siteId, monthlyDateFilter) : [];

        // 필터 칩 적용 — predicate 를 분리해서 카운트와 결과 양쪽에 재사용
        function passMonthlyFilter(m: any, key: typeof monthlyFilter): boolean {
          switch (key) {
            case 'all':       return true;
            case 'closeable': return m.status === 'closeable';
            case 'done':      return m.status === 'done';
            case 'check':     return m.status === 'check';
            case 'unconfirmed':
              return m.attendDays > 0
                && m.attendDays > m.doneDayCount
                && Object.keys(m.dailyMap).some((d) => !closedDates.has(d));
            case 'exception': return m.exceptionGongsu > 0;
            case 'manual':    return m.manualCount > 0;
            case 'closed':    return m.status === 'closed';
          }
          return true;
        }
        const filteredMembers = filteredMembersRaw.filter((m) => passMonthlyFilter(m, monthlyFilter));
        // 칩에 표시할 키별 카운트
        const monthlyFilterCounts: Record<typeof monthlyFilter, number> = {
          all:         filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'all')).length,
          closeable:   filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'closeable')).length,
          done:        filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'done')).length,
          check:       filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'check')).length,
          unconfirmed: filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'unconfirmed')).length,
          exception:   filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'exception')).length,
          manual:      filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'manual')).length,
          closed:      filteredMembersRaw.filter((m) => passMonthlyFilter(m, 'closed')).length,
        };

        // ── 미니 달력 일자별 합계 ──
        // closed 판정: 일일확정(closedDates) 처리됐거나, 출역 전원이 개별 확정(handled.action='done') 완료된 경우
        // check 카운트: handled.action='done' 인 record 는 제외 (사용자가 개별 확정한 건은 더 이상 확인필요 X)
        type DayStat = { date: string; attended: number; gongsu: number; check: number; closed: boolean };
        const dayStats: DayStat[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${yearMonth}-${String(d).padStart(2, '0')}`;
          let attended = 0, gongsu = 0, check = 0, doneCount = 0;
          for (const row of monthRows) {
            if (selectedM && memberSiteMap.get(row.memberId) !== selectedM.siteId) continue;
            const rec = row.daily?.[dateStr];
            if (!rec || rec.status === 'ABSENT' || !rec.checkInAt) continue;
            attended++;
            const k = rec.id + ':' + (selectedM?.siteId ?? '');
            const handled = dailyHandled.get(k);
            const isHandledDone = handled?.action === 'done';
            if (isHandledDone) doneCount++;
            gongsu += handled?.gongsu ?? rec.gongsu ?? 0;
            if (isCheckRecord(rec) && !isHandledDone) check++;
          }
          const allConfirmed = attended > 0 && doneCount === attended;
          dayStats.push({
            date: dateStr,
            attended,
            gongsu,
            check,
            closed: closedDates.has(dateStr) || allConfirmed,
          });
        }

        function kFmtMonth(n: number): string {
          if (!n) return '0';
          if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
          if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
          return n.toLocaleString();
        }

        const FILTER_CHIPS: Array<{ key: typeof monthlyFilter; label: string }> = [
          { key: 'all',         label: '전체' },
          { key: 'closeable',   label: '확정가능' },
          { key: 'done',        label: '확정완료' },
          { key: 'check',       label: '확인필요' },
          { key: 'unconfirmed', label: '미확정' },
          { key: 'exception',   label: '예외공수' },
          { key: 'manual',      label: '수동처리' },
          { key: 'closed',      label: '마감완료' },
        ];

        // 월간 내역 KPI — 가운데 영역 위 5타일
        const kpiTotalAttend = stats.reduce((acc, s) => acc + s.memberSet.size, 0);
        const kpiTotalDone   = stats.reduce((acc, s) => acc + s.done, 0);
        const kpiTotalCheck  = stats.reduce((acc, s) => acc + s.check, 0);
        const kpiTotalExc    = stats.reduce((acc, s) => acc + s.exception, 0);
        const kpiTotalPay    = stats.reduce((acc, s) => acc + s.totalPay, 0);

        return (
          <section className="att-monthly" aria-label="월간 내역">
            {/* 보기 토글은 .att-daily-panel 상단 공통 영역(.att-daily-viewtoggle)에서 노출 — 여기 중복 제거 */}
            {/* 보조 안내 배너(노란 box) 는 사용자 요청으로 제거 — 깔끔하게 KPI 부터 바로 시작 */}

            {/* 상단 — 5 KPI 타일 (오늘 확정 히어로와 동일한 iOS 알림 카드 톤) */}
            <div className="att-daily-kpi att-daily-kpi--notif">
              {(() => {
                // SITE 뷰 SUMMARY 와 동일한 구조 — label / sub / tone / filter key
                const MONTHLY_SUMMARY: Array<{
                  key: typeof monthlyFilter;
                  label: string;
                  tone: 'plain' | 'ok' | 'danger' | 'amber' | 'info';
                  raw: React.ReactNode;
                  filterable: boolean;
                }> = [
                  { key: 'all',       label: '월 출역인원', tone: 'plain',  raw: <><b>{kpiTotalAttend.toLocaleString('ko-KR')}</b>명</>,        filterable: false },
                  { key: 'done',      label: '확정완료',   tone: 'ok',     raw: <><b>{kpiTotalDone.toLocaleString('ko-KR')}</b>건</>,           filterable: true  },
                  { key: 'check',     label: '확인필요',   tone: 'danger', raw: <><b>{kpiTotalCheck.toLocaleString('ko-KR')}</b>건</>,          filterable: true  },
                  { key: 'exception', label: '예외공수',   tone: 'amber',  raw: <><b>{kpiTotalExc.toLocaleString('ko-KR')}</b>건</>,            filterable: true  },
                  { key: 'all',       label: '월 노무비',   tone: 'plain',  raw: <><b>{kFmtMonth(kpiTotalPay)}</b>원</>,                        filterable: false },
                ];
                return MONTHLY_SUMMARY.map((s, i) => {
                  const active = s.filterable && monthlyFilter === s.key;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={'att-hero__tile att-hero__tile--' + s.tone + (active ? ' is-active' : '')}
                      onClick={() => { if (s.filterable) setMonthlyFilter(s.key); }}
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
                      <span className="att-hero__time">{active ? '필터중' : '월간'}</span>
                    </button>
                  );
                });
              })()}
            </div>

            {/* 보기 토글 + 액션 — SITE 액션바와 동일 레이아웃 (LEFT 토글 / RIGHT 액션 + 빈 칩 슬롯) */}
            <div className="att-daily-actionbar att-daily-actionbar--monthly">
              <div className="att-daily-actionbar__left">
                <div className="auth-view-toggle">
                  <button type="button"
                    className={'auth-view-btn' + ((dailyView as string) === 'site' ? ' is-active' : '')}
                    onClick={() => setDailyView('site')}>오늘 확정</button>
                  <button type="button"
                    className={'auth-view-btn' + ((dailyView as string) === 'calendar' ? ' is-active' : '')}
                    onClick={() => setDailyView('calendar')}>월간 내역</button>
                </div>
              </div>
              <div className="att-daily-actionbar__right">
                {/* 월간 확정 / 확정 취소 — 코랄 레드 primary, 토글 + 안내 팝업 */}
                {(() => {
                  const wageStage = monthClose?.wageStage;
                  const attStage = monthClose?.attStage;
                  const isMonthlyClosed = attStage === 'SITE_CLOSED' || attStage === 'HQ_CONFIRMED';
                  const isWageInProgress = wageStage && wageStage !== 'OPEN';
                  const isHqConfirmed = attStage === 'HQ_CONFIRMED';
                  if (isMonthlyClosed) {
                    return (
                      <button type="button" className="auth-btn auth-btn--primary auth-btn--coral"
                        onClick={async () => {
                          if (!selectedM) return;
                          // 1) 노무비 마감/지급 중 → 취소 불가 안내
                          if (isWageInProgress) {
                            window.alert('노무비 마감(혹은 노무비 지급) 중입니다.\n수정을 원하시면 본사 담당자에게 문의하시기 바랍니다.');
                            return;
                          }
                          // 2) 본사 확정 완료 → 취소 불가 안내
                          if (isHqConfirmed) {
                            window.alert('본사에서도 출역확정이 완료되었습니다.\n수정을 원하시면 본사 담당자에게 문의하시기 바랍니다.');
                            return;
                          }
                          // 3) 현장 확정만 → 취소 확인 후 reopen
                          if (!window.confirm('확정을 취소하시겠습니까?')) return;
                          try {
                            await attendanceApi.monthClose({
                              siteId: selectedM.siteId,
                              yearMonth,
                              // 본사: ATT_REVERT_CONFIRM (본사 확정 해제), 현장: ATT_REOPEN (현장 마감 해제)
                              action: viewMode === 'HQ' ? 'ATT_REVERT_CONFIRM' : 'ATT_REOPEN',
                              reason: '월간 확정 취소',
                            });
                            await load();
                          } catch (e: any) {
                            window.alert(getErrorMessage(e, '확정 취소 실패'));
                          }
                        }}
                        title="월간 확정 취소"
                      >확정 취소</button>
                    );
                  }
                  return (
                    <button type="button" className="auth-btn auth-btn--primary auth-btn--coral"
                      onClick={() => navigate('/gongsu-close' + (selectedM ? `?siteId=${encodeURIComponent(selectedM.siteId)}` : ''))}
                      title={selectedM ? `${selectedM.siteName} 월간 확정 화면으로 이동` : '월간 확정 화면으로 이동'}
                    >월간 확정</button>
                  );
                })()}
                {/* + 출역 추가 — ghost (SITE 액션바와 동일 톤) */}
                <button type="button" className="auth-btn"
                  onClick={() => setMonthlyPoolOpen(true)}
                  title="출역 대기 인력 패널 열기 — 월간 내역에 추가할 수 있습니다">
                  <span aria-hidden style={{ fontWeight: 800, marginRight: 4 }}>＋</span>출역 추가
                </button>
                {/* 필터 칩 — 우측 끝(=우측 캘린더 사이드바 위)에 정렬 + 키별 카운트 표시 */}
                <div className="auth-filter-chips auth-filter-chips--right" style={{ marginLeft: 'auto' }}>
                  {FILTER_CHIPS.map((f) => (
                    <button key={f.key} type="button"
                      className={'auth-filter-chip auth-filter-chip--xs' + (monthlyFilter === f.key ? ' is-active' : '')}
                      onClick={() => setMonthlyFilter(f.key)}>
                      <span className="auth-filter-chip__label">{f.label}</span>
                      <span className="auth-filter-chip__count">{monthlyFilterCounts[f.key]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="att-monthly-grid">
              {/* LEFT — SITE 사이드바 카드 형식과 동일 (헤더 + 필터 칩 제거, 카드만 노출) */}
              <aside className="att-monthly-sites auth-sites">
                {/* 헤더 「현장별 상태」 + 필터 칩 4종 — 사용자 요청으로 제거.
                 *  필터 기능이 필요하면 monthlySiteFilter state 는 그대로 두고 다른 곳에서 노출. */}
                {(() => {
                  const filtered = sortedStats.filter((s) => {
                    if (monthlySiteFilter === 'all')   return true;
                    if (monthlySiteFilter === 'ok')    return s.status === 'ok';
                    if (monthlySiteFilter === 'warn')  return s.status === 'warn' || s.status === 'danger';
                    if (monthlySiteFilter === 'check') return s.check > 0;
                    return true;
                  });
                  if (filtered.length === 0) {
                    return <div className="auth-empty auth-empty--small">조건에 해당하는 현장이 없습니다.</div>;
                  }
                  return filtered.map((s) => {
                    const isSelected = selectedM?.siteId === s.siteId;
                    const sLabel = s.status === 'ok' ? '정상' : s.status === 'warn' ? '주의' : '위험';
                    const sTone  = s.status === 'ok' ? 'green' : s.status === 'warn' ? 'amber' : 'red';
                    return (
                      <button
                        key={s.siteId}
                        type="button"
                        className={'auth-site-card' + (isSelected ? ' is-selected' : '') + ' auth-site-card--' + s.status}
                        onClick={() => { setMonthlySelectedSite(s.siteId); setMonthlyDateFilter(null); }}
                      >
                        {/* 1행 — 상태 배지 + 현장명 (SITE 사이드바와 동일 구조) */}
                        <div className="auth-site-card__head">
                          <span className={'auth-status auth-status--' + sTone}>{sLabel}</span>
                          <strong className="auth-site-card__name" title={s.siteName}>{s.siteName}</strong>
                        </div>
                        {/* 2행 핵심 — 출역 / 확정 / 확인 / 노무비 */}
                        <div className="auth-site-card__line">
                          출역 <strong>{s.memberSet.size}</strong>·확정 <strong>{s.done}</strong>·확인 <strong>{s.check}</strong>·<strong>{kFmtMonth(s.totalPay)}원</strong>
                        </div>
                        {/* 3행 보조 — 수동·미확정·예외 */}
                        <div className="auth-site-card__line auth-site-card__line--sub">
                          수동 {s.manual}·미확정 {s.unconfirmedDays}·예외 {s.exception}
                        </div>
                      </button>
                    );
                  });
                })()}
              </aside>

              {/* CENTER — 근로자별 월 출역·공수 테이블 */}
              <div className="att-monthly-center">
                {!selectedM ? (
                  <div className="auth-empty">현장을 선택하세요.</div>
                ) : (
                  <>
                    <header className="att-monthly-summary att-monthly-summary--2lines">
                      {/* Line 1: 현장명만 (단독 라인) */}
                      <div className="att-monthly-summary__row1">
                        <strong className="att-monthly-summary__name">{selectedM.siteName}</strong>
                      </div>
                      {/* Line 2: 월 노무비 + 출역 + 총공수 + 확정 + 확인필요 (KPI 인라인) */}
                      <div className="att-monthly-summary__line">
                        <span className="att-daily-summary__sum">월 노무비 <strong>{Math.round(selectedM.totalPay).toLocaleString('ko-KR')}원</strong></span>
                        <span className="att-daily-summary__sep">·</span>
                        출역 <strong>{selectedM.memberSet.size}명</strong>
                        <span className="att-daily-summary__sep">·</span>
                        총공수 <strong>{selectedM.totalGongsu.toFixed(1)}</strong>
                        <span className="att-daily-summary__sep">·</span>
                        확정 <strong>{selectedM.done}</strong>
                        <span className="att-daily-summary__sep">·</span>
                        확인필요 <strong>{selectedM.check}</strong>
                        {monthlyDateFilter && (
                          <>
                            <span className="att-daily-summary__sep">·</span>
                            <button type="button" className="att-monthly-summary__date-clear"
                              onClick={() => setMonthlyDateFilter(null)}>
                              {monthlyDateFilter} 만 보기 ✕
                            </button>
                          </>
                        )}
                      </div>
                      {/* Line 2 액션 버튼 4종 — 사용자 요청으로 모두 제거
                       *  · ＋ 출역자 추가 → 상단 「+ 출역 추가」 와 중복
                       *  · 엑셀 업로드 / 반장에게 요청 → 「+ 출역 추가」 팝업 내부에 존재
                       *  · 월 공수마감 → 상단 「월간마감」 버튼으로 이전 (selectedM 연결) */}
                    </header>

                    {/* 필터 칩은 상단 액션바 우측 끝(=우측 캘린더 사이드바 위)으로 이동했습니다 */}

                    {filteredMembers.length === 0 ? (
                      <div className="auth-empty auth-empty--small">조건에 해당하는 근로자가 없습니다.</div>
                    ) : (
                      <div className="att-daily-table-wrap">
                        <table className="att-daily-table">
                          <thead>
                            <tr>
                              <th className="att-daily-th-no">#</th>
                              <th className="att-daily-th-name">근로자</th>
                              <th>직종</th>
                              <th>반장</th>
                              <th>출역일</th>
                              <th>총공수</th>
                              <th>기본</th>
                              <th>예외</th>
                              <th>수동</th>
                              <th>확인필요</th>
                              <th>월 임금</th>
                              <th>상태</th>
                              <th>조치</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredMembers.map((m, idx) => {
                              const sLabel = m.status === 'closeable' ? '확정가능'
                                           : m.status === 'check' ? '확인필요'
                                           : m.status === 'hold' ? '보류'
                                           : m.status === 'done' ? '확정완료'
                                           : '마감완료';
                              const sTone = m.status === 'closeable' ? 'amber'
                                          : m.status === 'check' ? 'red'
                                          : m.status === 'hold' ? 'gray'
                                          : m.status === 'done' ? 'green'
                                          : 'blue';
                              return (
                                <tr key={m.memberId} onClick={() => setMonthlyDetailMember(m.memberId)} style={{ cursor: 'pointer' }}>
                                  <td className="att-daily-td-no">{idx + 1}</td>
                                  <td className="att-daily-td-name">
                                    <span className="att-daily-name"><span className="att-daily-name__inner">{m.memberName}</span></span>
                                  </td>
                                  <td>{m.role || '—'}</td>
                                  <td>{m.foremanName}</td>
                                  <td>{m.attendDays}일</td>
                                  <td><strong>{m.totalGongsu.toFixed(1)}</strong></td>
                                  <td>{m.baseGongsu.toFixed(1)}</td>
                                  <td>{m.exceptionGongsu.toFixed(1)}</td>
                                  <td>{m.manualCount}</td>
                                  <td>{m.checkCount}</td>
                                  <td><strong>{kFmtMonth(m.monthPay)}원</strong></td>
                                  <td><span className={'auth-status auth-status--' + sTone}>{sLabel}</span></td>
                                  <td className="att-daily-actions" onClick={(e) => e.stopPropagation()}>
                                    <button type="button" className="auth-btn auth-btn--xs"
                                      onClick={() => setMonthlyDetailMember(m.memberId)}>상세</button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* RIGHT — 미니 달력 */}
              <aside className="att-monthly-cal">
                <header className="att-monthly-cal__head">
                  <YearMonthPicker value={yearMonth} onChange={setYearMonth} />
                </header>
                <div className="att-monthly-cal__grid">
                  {['일','월','화','수','목','금','토'].map((d) => (
                    <span key={d} className="att-monthly-cal__dow">{d}</span>
                  ))}
                  {(() => {
                    const first = new Date(yearMonth + '-01');
                    const padCount = first.getDay(); // sun=0
                    const cells: React.ReactNode[] = [];
                    for (let i = 0; i < padCount; i++) cells.push(<span key={'pad-' + i} className="att-monthly-cal__pad" />);
                    for (const ds of dayStats) {
                      const day = Number(ds.date.slice(-2));
                      const isSelected = monthlyDateFilter === ds.date;
                      const tone = ds.check > 0 ? 'check' : ds.closed ? 'closed' : ds.attended > 0 ? 'normal' : 'empty';
                      cells.push(
                        <button key={ds.date} type="button"
                          className={'att-monthly-cal__day att-monthly-cal__day--' + tone + (isSelected ? ' is-selected' : '')}
                          onClick={() => setMonthlyDateFilter(isSelected ? null : ds.date)}
                          title={`${ds.date} · 출역 ${ds.attended}명 · 공수 ${ds.gongsu.toFixed(1)} · 확인필요 ${ds.check}건${ds.closed ? ' · 일일확정' : ''}`}>
                          <span className="att-monthly-cal__num">{day}</span>
                          {ds.attended > 0 && <span className="att-monthly-cal__att">{ds.attended}명</span>}
                          {ds.gongsu > 0 && <span className="att-monthly-cal__gongsu">{ds.gongsu.toFixed(1)}</span>}
                          {ds.check > 0 && <span className="att-monthly-cal__check">⚠{ds.check}</span>}
                          {ds.closed && <span className="att-monthly-cal__closed">✓</span>}
                        </button>
                      );
                    }
                    return cells;
                  })()}
                </div>
                <div className="att-monthly-cal__legend">
                  <span><i className="dot dot--normal" /> 출역</span>
                  <span><i className="dot dot--check" /> 확인필요</span>
                  <span><i className="dot dot--closed" /> 일일확정</span>
                </div>
              </aside>
            </div>

            {/* 근로자 월간 상세 모달 — 달력 보기(기본) + 목록 보기 토글 */}
            {monthlyDetailMember && (() => {
              const m = filteredMembersRaw.find((x) => x.memberId === monthlyDetailMember);
              if (!m) return null;
              const member = memberById.get(m.memberId);
              // 월 임금
              const monthPay = m.monthPay;
              // 원본 record 접근 — selectedM.records 에서 찾음
              const memberRow = monthRows.find((r) => r.memberId === m.memberId);
              // record 유효성 — 결근(ABSENT) 또는 checkInAt 없는 건은 「출역 없음」 으로 간주.
              // 우측 상세 패널이 결근 record 를 마치 출역한 것처럼 노출하던 버그 방지.
              function getRec(date: string) {
                const r = memberRow?.daily?.[date];
                if (!r) return null;
                if (r.status === 'ABSENT') return null;
                if (!r.checkInAt) return null;
                return r;
              }
              function gongsuTone(g: number): 'none' | 'half' | 'full' | 'over' | 'double' {
                if (!g) return 'none';
                if (g <= 0.5) return 'half';
                if (g <= 1.0) return 'full';
                if (g <= 1.5) return 'over';
                return 'double';
              }
              const ymDateLocal = new Date(yearMonth + '-01');
              const yLabel = ymDateLocal.getFullYear();
              const mLabel = ymDateLocal.getMonth() + 1;
              const padCount = ymDateLocal.getDay();
              const isMonthClosed = monthClose?.attStage === 'HQ_CONFIRMED' || monthClose?.status === 'CLOSED';

              const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
              const selectedDate = memberDetailDate;
              const selectedRec = selectedDate ? getRec(selectedDate) : null;

              return (
                <Modal
                  open
                  onClose={() => { setMonthlyDetailMember(null); setMemberDetailDate(null); }}
                  title={`${m.memberName} 월간 출역 상세`}
                  subtitle={`${selectedM?.siteName ?? ''} · ${m.role} · ${m.foremanName} 반장 · ${yLabel}년 ${mLabel}월`}
                  width={780}
                  footer={
                    <button type="button" className="att__btn att__btn--ghost"
                      onClick={() => { setMonthlyDetailMember(null); setMemberDetailDate(null); }}>닫기</button>
                  }
                >
                  <div className="mdetail">
                    {(() => {
                      // 카테고리별 매칭 일자 수집 (오름차순)
                      // · 「수동 처리 N건」 / 「확인필요 N건」 표시 수와 일치하도록 handled.action='done' 제외.
                      const attendDates: string[] = [];
                      const manualDates: string[] = [];
                      const checkDates: string[] = [];
                      for (const d of days) {
                        const ds = `${yearMonth}-${String(d).padStart(2, '0')}`;
                        const rec = getRec(ds);
                        if (!rec) continue;   // getRec 가 ABSENT/!checkInAt 이미 필터
                        attendDates.push(ds);
                        const handledKey = rec.id + ':' + (selectedM?.siteId ?? '');
                        const handledHere = dailyHandled.get(handledKey);
                        const isHandledDone = handledHere?.action === 'done';
                        if (rec.checkInMethod === 'MANUAL' && !isHandledDone) manualDates.push(ds);
                        const faceFail = rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7;
                        const gpsBad = rec.geofenceResult && rec.geofenceResult !== 'INSIDE';
                        if ((faceFail || gpsBad) && !isHandledDone) checkDates.push(ds);
                      }
                      // 카드 클릭 → 해당 카테고리 일자 중 다음 매치로 이동.
                      // 현재 selectedDate 가 매치 안에 있으면 다음(순환), 아니면 첫번째.
                      function navigateTo(dates: string[]) {
                        if (dates.length === 0) return;
                        const cur = memberDetailDate;
                        const idx = cur ? dates.indexOf(cur) : -1;
                        const next = idx === -1 ? dates[0] : dates[(idx + 1) % dates.length];
                        setMemberDetailDate(next);
                        if (memberDetailView !== 'cal') setMemberDetailView('cal');
                      }
                      // 다중 인디케이터 도트 — 최대 5개 표시, 그 이상은 +N
                      function Dots({ dates, tone }: { dates: string[]; tone: string }) {
                        if (dates.length <= 1) return null;
                        const visible = dates.slice(0, 5);
                        const more = dates.length - visible.length;
                        return (
                          <div className={'mdetail-summary__dots mdetail-summary__dots--' + tone}>
                            {visible.map((d, i) => (
                              <span key={d} className={'mdetail-summary__dot' + (memberDetailDate === d ? ' is-active' : '')} aria-hidden />
                            ))}
                            {more > 0 && <span className="mdetail-summary__dots-more">+{more}</span>}
                          </div>
                        );
                      }
                      return (
                        <div className="mdetail-summary">
                          <button type="button"
                            className="mdetail-summary__card mdetail-summary__card--btn"
                            onClick={() => navigateTo(attendDates)}
                            title={attendDates.length > 0 ? '출역 일자로 이동' : ''}
                            disabled={attendDates.length === 0}>
                            <span className="mdetail-summary__label">출역일수</span>
                            <strong className="mdetail-summary__value">{m.attendDays}<em>일</em></strong>
                            <Dots dates={attendDates} tone="plain" />
                          </button>
                          <button type="button"
                            className="mdetail-summary__card mdetail-summary__card--ok mdetail-summary__card--btn"
                            onClick={() => navigateTo(attendDates)}
                            disabled={attendDates.length === 0}>
                            <span className="mdetail-summary__label">총공수</span>
                            <strong className="mdetail-summary__value">{m.totalGongsu.toFixed(1)}</strong>
                          </button>
                          <button type="button"
                            className="mdetail-summary__card mdetail-summary__card--btn"
                            onClick={() => navigateTo(attendDates)}
                            disabled={attendDates.length === 0}>
                            <span className="mdetail-summary__label">월 임금</span>
                            <strong className="mdetail-summary__value">{kFmtMonth(monthPay)}<em>원</em></strong>
                          </button>
                          <button type="button"
                            className={'mdetail-summary__card mdetail-summary__card--btn' + (m.manualCount > 0 ? ' mdetail-summary__card--amber' : '')}
                            onClick={() => navigateTo(manualDates)}
                            title={manualDates.length > 0 ? '수동 처리 일자로 이동' : '수동 처리 없음'}
                            disabled={manualDates.length === 0}>
                            <span className="mdetail-summary__label">수동 처리</span>
                            <strong className="mdetail-summary__value">{m.manualCount}<em>건</em></strong>
                            <Dots dates={manualDates} tone="amber" />
                          </button>
                          <button type="button"
                            className={'mdetail-summary__card mdetail-summary__card--btn' + (m.checkCount > 0 ? ' mdetail-summary__card--danger' : '')}
                            onClick={() => navigateTo(checkDates)}
                            title={checkDates.length > 0 ? '확인필요 일자로 이동' : '확인필요 없음'}
                            disabled={checkDates.length === 0}>
                            <span className="mdetail-summary__label">확인필요</span>
                            <strong className="mdetail-summary__value">{m.checkCount}<em>건</em></strong>
                            <Dots dates={checkDates} tone="danger" />
                          </button>
                        </div>
                      );
                    })()}

                    {/* 보기 토글 + 마감 안내 */}
                    <div className="mdetail-toolbar">
                      <div className="auth-view-toggle">
                        <button type="button"
                          className={'auth-view-btn' + (memberDetailView === 'cal' ? ' is-active' : '')}
                          onClick={() => setMemberDetailView('cal')}>달력 보기</button>
                        <button type="button"
                          className={'auth-view-btn' + (memberDetailView === 'list' ? ' is-active' : '')}
                          onClick={() => setMemberDetailView('list')}>목록 보기</button>
                      </div>
                      {isMonthClosed && (
                        <span className="mdetail-toolbar__lock">🔒 월 공수마감 완료 — 마감취소 후 수정 가능</span>
                      )}
                    </div>

                    {memberDetailView === 'cal' ? (
                      <div className="mdetail-cal-wrap">
                        <div className="mdetail-cal">
                          <div className="mdetail-cal__head">
                            {['일','월','화','수','목','금','토'].map((dl, idx) => (
                              <span key={dl} className={'mdetail-cal__dow' + (idx === 0 ? ' is-sun' : idx === 6 ? ' is-sat' : '')}>{dl}</span>
                            ))}
                          </div>
                          <div className="mdetail-cal__grid">
                            {Array.from({ length: padCount }, (_, i) => (
                              <span key={'pad-' + i} className="mdetail-cal__pad" />
                            ))}
                            {days.map((d) => {
                              const ds = `${yearMonth}-${String(d).padStart(2, '0')}`;
                              const rec = getRec(ds);
                              const g = m.dailyMap[ds] ?? 0;
                              const tone = gongsuTone(g);
                              const isManual = rec?.checkInMethod === 'MANUAL';
                              const isFace = rec?.checkInMethod === 'FACE';
                              const isGpsBad = !!(rec?.geofenceResult && rec.geofenceResult !== 'INSIDE');
                              // 「확인필요」 통합 = 얼굴 점수 낮음 OR GPS 이탈 (셀 외곽선 강조용 — 표시는 분리)
                              const isCheck = rec ? (
                                (rec.checkInMethod === 'FACE' && (rec.checkInScore ?? 0) <= 0.7) ||
                                isGpsBad
                              ) : false;
                              const isClosed = closedDates.has(ds);
                              const dow = new Date(ds).getDay();
                              const isSelected = memberDetailDate === ds;
                              // 개별 확정(handled.action === 'done') 여부
                              const handledKey = (rec?.id ?? m.memberId) + ':' + (selectedM?.siteId ?? '');
                              const handledHere = dailyHandled.get(handledKey);
                              const isHandledDone = handledHere?.action === 'done';
                              // 처리 완료 = 일일확정 OR 개별 확정 (출역이 있는 경우만)
                              const isResolved = isClosed || (rec && isHandledDone);
                              // 미처리 경고 = 출역 있음 + (수동 OR 확인필요) + 아직 처리 안 됨
                              const hasPending = !!rec && (isManual || isCheck) && !isResolved;
                              return (
                                <button key={ds} type="button"
                                  className={
                                    'mdetail-cal__day mdetail-cal__day--' + tone
                                    + (isSelected ? ' is-selected' : '')
                                    + (isManual ? ' is-manual' : '')
                                    + (isCheck ? ' is-check' : '')
                                    + (isResolved ? ' is-resolved' : '')
                                    + (hasPending ? ' is-pending' : '')
                                  }
                                  onClick={() => setMemberDetailDate(isSelected ? null : ds)}
                                  title={`${ds} · ${g > 0 ? g.toFixed(1) + '공수' : '없음'}${isManual ? ' · 수동' : ''}${isCheck ? ' · 확인필요' : ''}${isResolved ? ' · 처리 완료' : (hasPending ? ' · 처리 필요' : '')}`}>
                                  <span className={'mdetail-cal__num' + (dow === 0 ? ' is-sun' : dow === 6 ? ' is-sat' : '')}>{d}</span>
                                  {g > 0 ? (
                                    <strong className="mdetail-cal__gongsu">{g.toFixed(1)}공수</strong>
                                  ) : (
                                    <span className="mdetail-cal__empty">—</span>
                                  )}
                                  <span className="mdetail-cal__tags">
                                    {tone === 'over' && (
                                      <span className={'mdetail-cal__tag mdetail-cal__tag--over' + (isResolved ? ' is-resolved' : '')}>연장</span>
                                    )}
                                    {tone === 'double' && (
                                      <span className={'mdetail-cal__tag mdetail-cal__tag--double' + (isResolved ? ' is-resolved' : '')}>특근</span>
                                    )}
                                    {/* 1줄: 인증 방식 — 얼굴 / 수동 */}
                                    {isFace && (
                                      <span className={'mdetail-cal__tag mdetail-cal__tag--face' + (isResolved ? ' is-resolved' : '')}>얼굴</span>
                                    )}
                                    {isManual && (
                                      <span className={'mdetail-cal__tag mdetail-cal__tag--manual' + (isResolved ? ' is-resolved' : '')}>수동</span>
                                    )}
                                    {/* 2줄: GPS 이탈만 별도 칩으로 (기타 확인필요는 셀 외곽선 강조로만) */}
                                    {isGpsBad && (
                                      <span className={'mdetail-cal__tag mdetail-cal__tag--check' + (isResolved ? ' is-resolved' : '')}>GPS이탈</span>
                                    )}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          {/* 범례 */}
                          <div className="mdetail-legend">
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--half" /> 0.5 반공수</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--full" /> 1.0 기본</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--over" /> 1.5 연장</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--double" /> 2.0 특근</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--manual" /> 수동</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--check" /> 확인필요</span>
                            <span><i className="mdetail-legend__dot mdetail-legend__dot--closed" /> 확정완료</span>
                          </div>
                        </div>

                        {/* 우측 일자 상세 패널 */}
                        <aside className="mdetail-day">
                          {!selectedRec || !selectedDate ? (
                            <div className="mdetail-day__empty">
                              날짜를 클릭하면<br />
                              상세 정보가 표시됩니다.
                            </div>
                          ) : (() => {
                            const r = selectedRec;
                            const inT = r.checkInAt ? new Date(r.checkInAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
                            const outT = r.checkOutAt ? new Date(r.checkOutAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
                            const work = r.workedMinutes ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : '—';
                            const auth = r.checkInMethod === 'FACE' ? (r.geofenceResult === 'INSIDE' ? '얼굴+GPS' : '얼굴') : r.checkInMethod === 'MANUAL' ? '수기승인' : '—';
                            const reason = r.manualReason ?? (r.gongsu === 0.5 ? '반일' : r.gongsu === 1.5 ? '연장' : r.gongsu === 2.0 ? '특근' : '');
                            const handledKey = (r.id ?? m.memberId) + ':' + (selectedM?.siteId ?? '');
                            const handled = dailyHandled.get(handledKey);
                            const stateLabel = handled?.action === 'done' ? '확정완료' : handled?.action === 'hold' ? '보류' : '확정대기';
                            const stateTone  = handled?.action === 'done' ? 'green' : handled?.action === 'hold' ? 'gray' : 'amber';
                            return (
                              <>
                                {/* 헤더 — 일자 + 상태 칩 (한눈에) */}
                                <header className="mdetail-day__head">
                                  <span className="mdetail-day__date">{selectedDate.slice(5)}</span>
                                  <span className={'mdetail-day__status auth-status auth-status--' + stateTone}>{stateLabel}</span>
                                </header>

                                {/* 핵심 — 공수 + 일 임금 (큰 글씨로 3초 가독성) */}
                                <div className="mdetail-day__hero">
                                  <div className="mdetail-day__hero-row">
                                    <span className="mdetail-day__hero-label">공수</span>
                                    <strong className="mdetail-day__hero-value">{(r.gongsu ?? 0).toFixed(1)}</strong>
                                    <button type="button" className="mdetail-day__edit-icon"
                                      disabled={isMonthClosed}
                                      title={isMonthClosed ? '마감취소 후 수정 가능' : '공수 수정'}
                                      onClick={() => openGongsuDialog({
                                        memberId: m.memberId,
                                        memberName: m.memberName,
                                        role: m.role,
                                        date: selectedDate,
                                        dailyWage: r.dailyWage ?? 0,
                                        initial: r.gongsu ?? 0,
                                        record: r,
                                        siteName: selectedM?.siteName,
                                      })}>✎</button>
                                  </div>
                                  <div className="mdetail-day__hero-row">
                                    <span className="mdetail-day__hero-label">일 임금</span>
                                    <strong className="mdetail-day__hero-value mdetail-day__hero-value--money">
                                      {Math.round((r.dailyWage ?? 0) * (r.gongsu ?? 0)).toLocaleString('ko-KR')}원
                                    </strong>
                                  </div>
                                </div>

                                {/* 출퇴근 시간대 — 1줄 가로 표시 */}
                                <div className="mdetail-day__time">
                                  <span><em>출</em><strong>{inT}</strong></span>
                                  <span className="mdetail-day__time-arrow">→</span>
                                  <span><em>퇴</em><strong>{outT}</strong></span>
                                  <span className="mdetail-day__time-work">{work}</span>
                                </div>

                                {/* 부가 정보 — 인증/얼굴/GPS 한 줄 알약 */}
                                <div className="mdetail-day__chips">
                                  <span className="mdetail-day__chip">{auth}</span>
                                  {r.checkInScore != null && <span className="mdetail-day__chip">얼굴 {Math.round(r.checkInScore * 100)}%</span>}
                                  <span className={'mdetail-day__chip' + (r.geofenceResult && r.geofenceResult !== 'INSIDE' ? ' mdetail-day__chip--bad' : '')}>
                                    GPS {r.geofenceResult === 'INSIDE' ? '정상' : r.geofenceResult ? '이탈' : '—'}
                                  </span>
                                  <span className="mdetail-day__chip mdetail-day__chip--mute">일당 {(r.dailyWage ?? 0).toLocaleString('ko-KR')}원</span>
                                </div>

                                {reason && (
                                  <div className="mdetail-day__reason">
                                    <em>사유</em><span>{reason}</span>
                                  </div>
                                )}

                                {/* 액션 — 확정/확정취소 + 로그 보기 */}
                                <div className="mdetail-day__actions">
                                  {handled?.action !== 'done' && (
                                    <button type="button" className="auth-btn auth-btn--ok auth-btn--xs"
                                      disabled={isMonthClosed}
                                      title={isMonthClosed ? '마감취소 후 처리 가능' : '이 일자를 확정 처리합니다'}
                                      onClick={() => markDailyHandled(handledKey, 'done')}>
                                      ✓ 확정
                                    </button>
                                  )}
                                  {handled?.action === 'done' && (
                                    <button type="button" className="auth-btn auth-btn--xs"
                                      disabled={isMonthClosed}
                                      title={isMonthClosed ? '마감취소 후 처리 가능' : '확정 취소 (확정대기로 되돌림)'}
                                      onClick={() => {
                                        setDailyHandled((prev) => {
                                          const next = new Map(prev);
                                          next.delete(handledKey);
                                          try { localStorage.setItem('bodapass.daily.handled', JSON.stringify(Object.fromEntries(next))); } catch { /* */ }
                                          return next;
                                        });
                                        flashCompletion('확정 취소', { tone: 'danger' });
                                      }}>
                                      확정 취소
                                    </button>
                                  )}
                                  <button type="button" className="auth-btn auth-btn--xs"
                                    onClick={() => {
                                      setAuthDetailRecord({
                                        memberId: m.memberId,
                                        memberName: m.memberName,
                                        role: m.role,
                                        record: r,
                                        status: 'DONE',
                                      });
                                    }}>로그 보기</button>
                                </div>
                              </>
                            );
                          })()}
                        </aside>
                      </div>
                    ) : (
                      // 목록 보기 — 기존 표 형식
                      <div className="mdetail-list-wrap">
                        <table className="mdetail-list">
                          <thead>
                            <tr>
                              <th>날짜</th>
                              <th>요일</th>
                              <th>출근</th>
                              <th>퇴근</th>
                              <th>공수</th>
                              <th>상태</th>
                              <th>사유</th>
                              <th>조치</th>
                            </tr>
                          </thead>
                          <tbody>
                            {days.map((d) => {
                              const ds = `${yearMonth}-${String(d).padStart(2, '0')}`;
                              const rec = getRec(ds);
                              const g = rec?.gongsu ?? 0;
                              const dow = new Date(ds).getDay();
                              const dowLabel = ['일','월','화','수','목','금','토'][dow];
                              const inT = rec?.checkInAt ? new Date(rec.checkInAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
                              const outT = rec?.checkOutAt ? new Date(rec.checkOutAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
                              const reason = rec?.manualReason ?? (g === 0.5 ? '반일' : g === 1.5 ? '연장' : g === 2.0 ? '특근' : '');
                              const handledKey = (rec?.id ?? m.memberId) + ':' + (selectedM?.siteId ?? '');
                              const handled = dailyHandled.get(handledKey);
                              const stateLabel = !rec || rec.status === 'ABSENT' ? '—' : handled?.action === 'done' ? '확정완료' : handled?.action === 'hold' ? '보류' : '확정대기';
                              const stateTone  = !rec || rec.status === 'ABSENT' ? 'gray' : handled?.action === 'done' ? 'green' : handled?.action === 'hold' ? 'gray' : 'amber';
                              return (
                                <tr key={ds} className={!rec || rec.status === 'ABSENT' ? 'is-absent' : ''}>
                                  <td>{ds.slice(5)}</td>
                                  <td className={dow === 0 ? 'is-sun' : dow === 6 ? 'is-sat' : ''}>{dowLabel}</td>
                                  <td>{inT}</td>
                                  <td>{outT}</td>
                                  <td className="mdetail-list__num">{g > 0 ? g.toFixed(1) : '—'}</td>
                                  <td><span className={'auth-status auth-status--' + stateTone}>{stateLabel}</span></td>
                                  <td>{reason || '—'}</td>
                                  <td>
                                    {rec && rec.status !== 'ABSENT' && (
                                      <button type="button" className="auth-btn auth-btn--xs"
                                        disabled={isMonthClosed}
                                        onClick={() => openGongsuDialog({
                                          memberId: m.memberId,
                                          memberName: m.memberName,
                                          role: m.role,
                                          date: ds,
                                          dailyWage: rec.dailyWage ?? 0,
                                          initial: rec.gongsu ?? 0,
                                          record: rec,
                                          siteName: selectedM?.siteName,
                                        })}>수정</button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </Modal>
              );
            })()}

            {/* 출역 대기 인력 패널 — 모달 */}
            {monthlyPoolOpen && (() => {
              const attended = new Set<string>();
              for (const row of monthRows) {
                if (selectedM && memberSiteMap.get(row.memberId) !== selectedM.siteId) continue;
                for (const [_, rec] of Object.entries(row.daily ?? {})) {
                  if (rec && rec.checkInAt) { attended.add(row.memberId); break; }
                }
              }
              const pool = (selectedM
                ? allMembers.filter((m) => m.siteId === selectedM.siteId && !attended.has(m.id))
                : allMembers.filter((m) => !attended.has(m.id))
              );
              return (
                <Modal
                  open
                  onClose={() => setMonthlyPoolOpen(false)}
                  title="출역 대기 인력"
                  subtitle={`${selectedM?.siteName ?? '전체'} · ${pool.length}명 — 등록되었지만 이번 달 출역 기록이 없는 인력`}
                  width={640}
                >
                  <div className="att-monthly-pool">
                    <div className="att-monthly-pool__actions">
                      <button type="button" className="auth-btn auth-btn--ok"
                        onClick={() => { setMonthlyPoolOpen(false); setQuickAddOpen(true); }}>＋ 신규 근로자 등록</button>
                      <button type="button" className="auth-btn"
                        onClick={() => { setMonthlyPoolOpen(false); setUploadOpen(true); }}>엑셀 업로드</button>
                      <button type="button" className="auth-btn"
                        onClick={() => window.alert('반장에게 카카오톡·SMS 로 출역자 확인 요청을 보냅니다. (시연)')}>반장에게 등록 요청</button>
                    </div>
                    {pool.length === 0 ? (
                      <p className="att-monthly-pool__empty">전원 출역 등록 완료 — 대기 인력이 없습니다.</p>
                    ) : (
                      <>
                        <p className="att-monthly-pool__hint">
                          ＋ 출역 추가 — 해당 인력에 대해 출역 기록을 수동으로 추가합니다 (사유 필수, 감사 로그 기록)
                        </p>
                        <ul className="att-monthly-pool__list">
                          {pool.slice(0, 50).map((m) => {
                            const targetDate = selectedDate ?? new Date().toISOString().slice(0, 10);
                            return (
                              <li key={m.id} className="att-monthly-pool__item">
                                <strong>{m.name}</strong>
                                <em>{m.role || '—'}</em>
                                <span className="att-monthly-pool__role">{m.contractSigned === false ? '계약 미체결' : ''}</span>
                                <button
                                  type="button"
                                  className="auth-btn auth-btn--ok att-monthly-pool__add"
                                  disabled={m.contractSigned === false}
                                  title={
                                    m.contractSigned === false
                                      ? '근로계약 미체결 — 계약 체결 후 출역 추가 가능'
                                      : `${targetDate} — ${m.name} 출역 수동 추가`
                                  }
                                  onClick={() => {
                                    setMonthlyPoolOpen(false);
                                    openGongsuDialog({
                                      memberId: m.id,
                                      memberName: m.name,
                                      role: m.role || '',
                                      date: targetDate,
                                      dailyWage: m.dailyWage ?? 0,
                                      initial: 1.0,
                                      record: null,
                                      siteName: selectedM?.siteName,
                                    });
                                  }}
                                >
                                  ＋ 출역 추가
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                        {pool.length > 50 && (
                          <p className="att-monthly-pool__more">… 외 {pool.length - 50}명 — 검색·필터 기능은 다음 단계에 추가 예정</p>
                        )}
                      </>
                    )}
                  </div>
                </Modal>
              );
            })()}
          </section>
        );
      })()}

      {/* 일일확정 «개인별 보기» — dailyView === 'member' 일 때만 노출.
       *  attTab === "auth" 인증관리 탭에서는 그대로 노출 (auth-panel 아래 보조 정보).
       *  「월간 캘린더」는 별도 MonthlyView 가 렌더 (att-monthly-* 섹션). */}
      {(attTab !== 'daily' || dailyView === 'member') && (
      <>
      <section className="att__controls">
        {/* col 1: 현장 — HQ 모드에선 항상 클릭 가능 (전체 ↔ 특정 현장 전환) */}
        {(() => {
          const isHQMulti = viewMode === 'HQ' && sites.length > 1;
          return (
        <div
          className={
            'att__mini-kpi att__mini-kpi--site' +
            (isHQMulti ? ' att__mini-kpi--clickable' : '') +
            (siteListOpen ? ' is-open' : '')
          }
          title={
            isHQMulti
              ? '클릭 — 다른 현장 또는 전체 보기 전환'
              : sites.find((s) => s.id === siteId)?.name ?? '—'
          }
          onClick={() => {
            if (isHQMulti) setSiteListOpen((v) => !v);
          }}
          role={isHQMulti ? 'button' : undefined}
        >
          <span className="att__mini-kpi-label">현장</span>
          <span className="att__mini-kpi-value att__mini-kpi-value--site">
            {siteId === 'ALL'
              ? `전체 ${sites.length}개`
              : sites.find((s) => s.id === siteId)?.name ?? '—'}
            {isHQMulti && (siteListOpen ? ' ▴' : ' ▾')}
          </span>

          {/* 드롭다운 — 전체 + 현장별 출퇴근 요약 (스크롤) */}
          {isHQMulti && siteListOpen && (
            <div
              className="att__site-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="att__site-popover-head">
                <strong>현장별 출퇴근 — {sites.length}개 현장</strong>
                <button
                  type="button"
                  className="att__site-popover-close"
                  onClick={() => setSiteListOpen(false)}
                  aria-label="닫기"
                >
                  ×
                </button>
              </header>
              <ul className="att__site-popover-list">
                {/* 전체로 돌아가기 옵션 — 항상 첫 번째 */}
                <li
                  className={
                    'att__site-popover-item att__site-popover-item--all' +
                    (siteId === 'ALL' ? ' is-active' : '')
                  }
                  onClick={() => {
                    setSiteId('ALL');
                    setSiteListOpen(false);
                  }}
                  title="전체 현장 합계로 보기"
                >
                  <span className="att__site-popover-name">
                    📋 전체 {sites.length}개 현장
                  </span>
                  <span className="att__site-popover-stats">
                    <span className="att__site-popover-stat">
                      <em>합계</em>
                      <strong>{perSiteStats.reduce((s, p) => s + p.workingNow, 0)}</strong>
                      <small>명 근무중</small>
                    </span>
                  </span>
                </li>
                {perSiteStats.map((s) => (
                  <li
                    key={s.siteId}
                    className={
                      'att__site-popover-item' +
                      (siteId === s.siteId ? ' is-active' : '')
                    }
                    onClick={() => {
                      setSiteId(s.siteId);
                      setSiteListOpen(false);
                    }}
                    title={`${s.siteName} 으로 필터`}
                  >
                    <span className="att__site-popover-name">{s.siteName}</span>
                    <span className="att__site-popover-stats">
                      <span className="att__site-popover-stat">
                        <em>오늘</em>
                        <strong>{s.workingNow}</strong>
                        <small>/ {s.todayTotal}명</small>
                      </span>
                      <span className="att__site-popover-stat">
                        <em>공수</em>
                        <strong>{s.monthGongsu.toFixed(1)}</strong>
                      </span>
                      {/* 임금은 출퇴근 현황에서 노출하지 않음 — 원·하도급 간 공유 금지 정책 */}
                    </span>
                  </li>
                ))}
                {perSiteStats.length === 0 && (
                  <li className="att__site-popover-empty">
                    현장 데이터가 없습니다.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
          );
        })()}

        {/* col 2: 3개 KPI — 이달 총 인원 / 오늘 출력인원 / 원·하도급 출력인원 */}
        <div className="att__mini-kpis-mid">
          {month && today && (() => {
            // ─── 단일 source of truth: month.rows ─────────────────
            //  · 오늘 출력인원 / 오늘 공수 / 결근·지각·조퇴 모두 month.rows 의 오늘 일자 셀 기준.
            //  · today API 의 summary 와 KPI 가 어긋나는 문제 해결 — 캘린더 숫자(현장별 일자별 노출) 와 동일한 값으로 통일.
            // ────────────────────────────────────────────────────
            let todayHeadcount = 0;
            let todayGongsu = 0;
            let todayWorking = 0;          // 출근만 (퇴근 X) — 「근무 중」
            let todayLate = 0;             // 오늘 지각
            let todayEarly = 0;            // 오늘 조퇴
            let todayAbsentCount = 0;      // 오늘 결근 (record 가 ABSENT)
            for (const r of month.rows) {
              const rec = r.daily[todayStr];
              if (!rec) continue;
              if (rec.status === 'ABSENT') { todayAbsentCount++; continue; }
              if (rec.checkInAt) {
                todayHeadcount++;
                todayGongsu += rec.gongsu ?? 0;
                if (!rec.checkOutAt) todayWorking++;
                if (rec.status === 'LATE')  todayLate++;
                if (rec.status === 'EARLY') todayEarly++;
              }
            }

            // ─── 원·하도급 출력 — 「오늘 출력인원」 옆 KPI 이므로 오늘 일자 record 기준 ───
            //  · 이전 버그: 이달 총 인원/누적 공수를 노출 → 옆 「오늘 출력인원」(13명) 과 매치 X
            //  · 수정: 오늘 체크인한 사람만 원·하 분리 + 오늘 공수만 합산
            //  · 검산: ownCount + subCount === todayHeadcount,  ownGongsu + subGongsu === todayGongsu
            let ownCount = 0;
            let subCount = 0;
            let ownGongsu = 0;
            let subGongsu = 0;
            const showSplit = siteId !== 'ALL' && siteCompanies.length > 0;
            if (showSplit) {
              const ownIds = new Set(
                siteCompanies
                  .filter((sc) => sc.siteId === siteId && sc.role !== '하도급' && sc.status === 'ACTIVE')
                  .map((sc) => sc.id),
              );
              const subIds = new Set(
                siteCompanies
                  .filter((sc) => sc.siteId === siteId && sc.role === '하도급' && sc.status === 'ACTIVE')
                  .map((sc) => sc.id),
              );
              const subMemberIds = new Set(
                siteMembers
                  .filter((m) => m.siteCompanyId && subIds.has(m.siteCompanyId))
                  .map((m) => m.id),
              );
              const ownMemberIds = new Set(
                siteMembers
                  .filter(
                    (m) =>
                      !subMemberIds.has(m.id) &&
                      (!m.siteCompanyId || ownIds.has(m.siteCompanyId)),
                  )
                  .map((m) => m.id),
              );
              // 오늘 체크인한 멤버만 원·하 분리
              for (const r of month.rows) {
                const rec = r.daily[todayStr];
                if (!rec || !rec.checkInAt) continue;
                const g = rec.gongsu ?? 0;
                if (subMemberIds.has(r.memberId)) {
                  subCount++; subGongsu += g;
                } else if (ownMemberIds.has(r.memberId)) {
                  ownCount++; ownGongsu += g;
                } else {
                  // 회사 매핑이 없는 record — 원도급으로 분류 (보수적)
                  ownCount++; ownGongsu += g;
                }
              }
            }

            return (
              <>
                <div className="att__mini-kpi">
                  <div className="att__mini-kpi-row">
                    <span className="att__mini-kpi-label">이달 총 인원</span>
                    <span className="att__mini-kpi-value att__mini-kpi-value--strong">
                      {month.summary.totalMembers}
                      <em>명</em>
                    </span>
                  </div>
                  <span className="att__mini-kpi-sub">
                    누적 {month.summary.totalGongsu.toFixed(1)} 공수
                  </span>
                </div>
                <div className="att__mini-kpi">
                  <div className="att__mini-kpi-row">
                    <span className="att__mini-kpi-label">오늘 출력인원</span>
                    <span className="att__mini-kpi-value att__mini-kpi-value--accent">
                      {todayHeadcount}
                      <em>명</em>
                    </span>
                  </div>
                  <span className="att__mini-kpi-sub">
                    오늘 {todayGongsu.toFixed(1)} 공수
                    {todayWorking > 0 && ` · 근무 중 ${todayWorking}`}
                  </span>
                </div>
                <div className="att__mini-kpi">
                  <div className="att__mini-kpi-row">
                    <span className="att__mini-kpi-label">오늘 원·하도급</span>
                    {showSplit ? (
                      <span className="att__mini-kpi-value att__mini-kpi-value--success att__mini-kpi-value--split">
                        <span className="att__split">
                          <em className="att__split-tag">원</em>
                          <strong>{ownCount}</strong>
                        </span>
                        <i className="att__split-sep">·</i>
                        <span className="att__split">
                          <em className="att__split-tag">하</em>
                          <strong>{subCount}</strong>
                        </span>
                        <em>명</em>
                      </span>
                    ) : (
                      // ALL 모드 — 오늘 출력인원 합계 (전체 현장)
                      <span className="att__mini-kpi-value att__mini-kpi-value--success">
                        {todayHeadcount}
                        <em>명</em>
                      </span>
                    )}
                  </div>
                  <span className="att__mini-kpi-sub">
                    {showSplit
                      ? `원 ${ownGongsu.toFixed(1)} · 하 ${subGongsu.toFixed(1)} 공수`
                      : '현장 선택 시 원·하 분리 표시'}
                  </span>
                </div>
                {/* 얼굴 / 수동 통계 — 오늘 체크인 기준 (month.rows 기반 — 위 KPI 와 source 통일) */}
                {(() => {
                  let faceCount = 0;
                  let manualCount = 0;
                  for (const r of month.rows) {
                    const rec = r.daily[todayStr];
                    if (!rec || !rec.checkInAt) continue;
                    if (rec.checkInMethod === 'FACE') faceCount++;
                    else if (rec.checkInMethod === 'MANUAL') manualCount++;
                  }
                  const total = faceCount + manualCount;
                  const facePct = total > 0 ? Math.round((faceCount / total) * 100) : 0;
                  return (
                    <div className="att__mini-kpi">
                      <div className="att__mini-kpi-row">
                        <span className="att__mini-kpi-label">얼굴 · 수동</span>
                        <span className="att__mini-kpi-value att__mini-kpi-value--split">
                          <span className="att__split att__split--face">
                            <em className="att__split-tag att__split-tag--face">얼굴</em>
                            <strong>{faceCount}</strong>
                          </span>
                          <i className="att__split-sep">·</i>
                          <span className="att__split att__split--manual">
                            <em className="att__split-tag att__split-tag--manual">수동</em>
                            <strong>{manualCount}</strong>
                          </span>
                          <em>명</em>
                        </span>
                      </div>
                      <span className="att__mini-kpi-sub">
                        얼굴 인식률 <strong>{facePct}%</strong>
                      </span>
                    </div>
                  );
                })()}
              </>
            );
          })()}
        </div>

        {/* col 3: 결근/지각/조퇴 — 이달 누적 (라벨에 「이달」 명시하여 「오늘」 KPI 와 혼동 방지) */}
        {month && (
          <div className="att__mini-kpi">
            <div className="att__mini-kpi-row">
              <span className="att__mini-kpi-label">이달 결근 / 지각 / 조퇴</span>
              <span className="att__mini-kpi-value att__mini-kpi-value--danger">
                {month.summary.absentCount} / {month.summary.lateCount} / {month.summary.earlyCount}
              </span>
            </div>
            <span className="att__mini-kpi-sub">이달 누적 건수</span>
          </div>
        )}

        {/* 년월은 캘린더 우측 상단으로 이동 (att-cal__head 내부) */}
      </section>

      {/* 일일확정 — 액션 버튼 바 (인증관리 toolbar 와 동일 위치 — hero 타일 바로 아래)
       *  · 4 버튼: 일출역확정 / 월출역확정 / 하도급 출역확인 / 엑셀 업로드
       *  · 사이즈 = auth-view-btn 컴팩트 pill (24~26px)
       *  · 우측 정렬 (사이드바 우측 모서리와 동일 x 좌표) */}
      {attTab === 'daily' && (
        <div className="att__action-bar" role="toolbar" aria-label="일일확정 액션">
          {pageActions}
        </div>
      )}

      {error && <div className="att__error">{error}</div>}

      {/* KPI 스트립은 controls 행으로 흡수됨 (att__mini-kpis) */}

      <section className="att__body3">
        {/* 좌: 탭 (일자별/개인별) + 모드별 리스트 */}
        <div className="card att__col">
          {/* 탭 스위처 — 좌측 최상단으로 이동 */}
          <div className="att-cal__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={rightView === 'DAILY'}
              className={'att-cal__tab' + (rightView === 'DAILY' ? ' is-active' : '')}
              onClick={() => {
                setRightView('DAILY');
                // DAILY 진입 시 selectedDate 가 없으면 오늘 또는 최근 데이터 일자 자동 선택
                if (!selectedDate && month) {
                  const today = new Date().toISOString().slice(0, 10);
                  if (today.startsWith(yearMonth)) {
                    setSelectedDate(today);
                  } else {
                    let last = '';
                    for (const r of month.rows) {
                      for (const d of Object.keys(r.daily)) {
                        const rec = r.daily[d];
                        if (rec && rec.gongsu > 0 && d > last) last = d;
                      }
                    }
                    setSelectedDate(last || `${yearMonth}-01`);
                  }
                }
              }}
              title="일자별 총 출력인원·공수"
            >
              📅 일자별 출력
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightView === 'MEMBER'}
              className={'att-cal__tab' + (rightView === 'MEMBER' ? ' is-active' : '')}
              onClick={() => setRightView('MEMBER')}
              title="개인별 공수 캘린더"
            >
              👤 개인별 출력
            </button>
          </div>

          {loading || !month ? (
            <p className="att__loading">불러오는 중…</p>
          ) : month.rows.length === 0 ? (
            <div className="att__empty-state">
              <p className="att__empty">해당 현장에 등록된 팀원이 없습니다.</p>
              <p className="att__empty-sub">
                팀원이 없으면 출역을 입력할 수 없습니다. 먼저 팀원을 등록해주세요.
              </p>
              <button
                type="button"
                className="att__btn att__btn--primary att__empty-cta"
                onClick={() => {
                  if (siteId === 'ALL') {
                    window.alert('현장을 먼저 선택해 주세요.');
                    return;
                  }
                  setQuickAddOpen(true);
                }}
                title="이 현장의 팀원을 새로 등록"
              >
                ＋ 팀원 등록하기
              </button>
            </div>
          ) : rightView === 'DAILY' ? (
            // 일자별 — 그날 출석자 리스트 (선택된 일자가 없으면 오늘로 폴백)
            <DateAttendanceList
              rows={month.rows}
              date={selectedDate ?? new Date().toISOString().slice(0, 10)}
              ownMemberIds={ownMemberIds}
              subMemberIds={subMemberIds}
              memberSpecialty={memberSpecialty}
              splitEnabled={siteId !== 'ALL' && siteCompanies.length > 0}
              isOwnerViewer={isOwnerViewer}
              onAddMember={
                siteId === 'ALL'
                  ? undefined
                  : () => setQuickAddOpen(true)
              }
              onPickMember={(id) => {
                const r = month.rows.find((x) => x.memberId === id);
                const d = selectedDate ?? new Date().toISOString().slice(0, 10);
                if (!r) return;
                const rec = r.daily[d];
                openGongsuDialog({
                  memberId: r.memberId,
                  memberName: r.memberName,
                  role: r.role,
                  date: d,
                  dailyWage: r.dailyWage,
                  initial: rec?.gongsu ?? 1.0,
                  record: rec ?? null,
                });
              }}
            />
          ) : (
            // 개인별 — 전체 팀원 리스트 (ㄱㄴㄷ 정렬)
            // 원도급 본인 뷰일 땐 하도급 멤버 제외 (자기 회사 작업자만 표시)
            <TeamListUnified
              rows={
                isOwnerViewer
                  ? month.rows.filter((r) => !subMemberIds.has(r.memberId))
                  : month.rows
              }
              selectedId={selectedMemberId}
              onSelect={(id) => setSelectedMemberId(id)}
            />
          )}
        </div>

        {/* 중앙: 캘린더 — 드롭 존: 인력 풀에서 끌어온 멤버를 현재 현장에 배정 */}
        <div
          className="card att__col att__col--cal"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            (e.currentTarget as HTMLElement).classList.add('is-drop-target');
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).classList.add('is-drop-target');
          }}
          onDragLeave={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (
              e.clientX < rect.left || e.clientX > rect.right
              || e.clientY < rect.top || e.clientY > rect.bottom
            ) {
              (e.currentTarget as HTMLElement).classList.remove('is-drop-target');
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).classList.remove('is-drop-target');
            const memberId = e.dataTransfer.getData('text/plain');
            console.log('[cal] drop fired. memberId =', memberId, 'siteId =', siteId);
            if (!memberId) {
              window.alert('드롭 데이터가 비어있습니다. 카드의 ⋮⋮ 핸들을 잡고 끄세요.');
              return;
            }
            if (siteId === 'ALL') {
              window.alert('현장을 먼저 선택해 주세요.');
              return;
            }
            // 비동기 — 1) siteId 갱신 2) 오늘 1.0 공수 자동 입력 3) reload
            (async () => {
              try {
                const memName = allMembers.find((m) => m.id === memberId)?.name ?? memberId;
                await teamApi.update(memberId, { siteId });
                const today = new Date().toISOString().slice(0, 10);
                try {
                  await attendanceApi.setGongsu({
                    memberId,
                    date: today,
                    gongsu: 1,
                    reason: '드래그 배정 — 현장 출역',
                  });
                } catch (gErr) {
                  console.warn('공수 입력 실패 (배정은 정상):', gErr);
                }
                await load();
                console.log('[cal] drop ok — assigned + today 1.0 공수 등록 to', siteId);
                // 토스트 대신 간단한 alert (mock 시연용)
                window.alert(`${memName}님이 오늘 현장에 출역으로 등록됐습니다.`);
              } catch (err: any) {
                window.alert(getErrorMessage(err, '배정 실패'));
              }
            })();
          }}
        >
          {!month ? (
            <p className="att__loading">불러오는 중…</p>
          ) : rightView === 'DAILY' ? (
            <DailyAttendanceCalendar
              month={month}
              yearMonth={yearMonth}
              selectedDate={selectedDate}
              onPickDate={setSelectedDate}
              onYearMonthChange={setYearMonth}
              ownMemberIds={ownMemberIds}
              subMemberIds={subMemberIds}
              splitEnabled={siteId !== 'ALL' && siteCompanies.length > 0}
            />
          ) : !selectedRow ? (
            // 개인별 + 미선택 → 빈 캘린더 (안내 + 회색 그리드)
            <EmptyMemberCalendar yearMonth={yearMonth} onYearMonthChange={setYearMonth} />
          ) : (
            <MemberCalendar
              row={selectedRow}
              yearMonth={yearMonth}
              onYearMonthChange={setYearMonth}
              onPick={(date, initial) =>
                openGongsuDialog({
                  memberId: selectedRow.memberId,
                  memberName: selectedRow.memberName,
                  role: selectedRow.role,
                  date,
                  dailyWage: selectedRow.dailyWage,
                  initial,
                  record: selectedRow.daily[date] ?? null,
                })
              }
              onBulkPick={(dates) =>
                setBulkGongsuOpen({
                  memberId: selectedRow.memberId,
                  memberName: selectedRow.memberName,
                  role: selectedRow.role,
                  dates,
                  dailyWage: selectedRow.dailyWage,
                })
              }
              onManual={() =>
                setManualOpen({ memberId: selectedRow.memberId })
              }
            />
          )}
        </div>

        {/* 우: 인력 풀 — 등록된 인력 중 오늘 미출근자 (드래그 → 현장 배정) */}
        <aside className="card att__col att__col--audit">
          <WorkerPoolPanel
            allMembers={allMembers}
            currentSiteId={siteId}
            onReturnToPool={async (memberId: string) => {
              const today = new Date().toISOString().slice(0, 10);
              const memName = allMembers.find((m) => m.id === memberId)?.name ?? memberId;
              const todayRec = month?.rows
                .find((r) => r.memberId === memberId)?.daily?.[today];
              const hasTodayAttendance = !!(todayRec && todayRec.gongsu > 0);
              if (!hasTodayAttendance) {
                // 풀에 이미 있는 경우 — 변화 없음
                return;
              }
              const ok = window.confirm(
                `${memName}님의 오늘(${today}) 출역을 취소하시겠습니까?\n\n`
                + `· 오늘 공수 ${todayRec!.gongsu.toFixed(1)} 가 0 으로 변경됩니다.\n`
                + `· 「관리인원 풀」 에 다시 표시됩니다.\n`
                + `· 다른 날 공수·임금·과거 출역 기록은 그대로 보존됩니다.\n`
                + `· 현장 배정(siteId)은 유지됩니다.`,
              );
              if (!ok) return;
              try {
                await attendanceApi.setGongsu({
                  memberId, date: today, gongsu: 0,
                  reason: '오늘 출역 취소 (드래그)',
                });
                await load();
                window.alert(`${memName}님의 오늘 출역이 취소됐습니다. 과거 출역 기록은 그대로 유지됩니다.`);
              } catch (e: any) {
                window.alert(getErrorMessage(e, '풀 반환 실패'));
              }
            }}
            todayCheckedInIds={(() => {
              // 「오늘 출역(공수>0)이 있는 모든 사람」 제외 — FACE·MANUAL 모두 포함.
              // 풀은 「오늘 아직 일 안 한 사람」 = 배정 가능한 인력만 노출.
              const set = new Set<string>();
              const todayStr = new Date().toISOString().slice(0, 10);
              // 1) today.members (FACE 출근 + 일부 MANUAL)
              if (today) for (const m of today.members) {
                if (m.record && (m.record.gongsu ?? 0) > 0) {
                  set.add(m.memberId);
                }
              }
              // 2) month.rows 의 오늘 daily 기록 (드래그 배정 등으로 등록된 MANUAL 포함)
              if (month) for (const r of month.rows) {
                const rec = r.daily?.[todayStr];
                if (rec && (rec.gongsu ?? 0) > 0) {
                  set.add(r.memberId);
                }
              }
              return set;
            })()}
            onOpenAdd={() => setQuickAddOpen(true)}
            onAssignToSite={async (memberId: string) => {
              if (siteId === 'ALL') {
                window.alert('현장을 먼저 선택해 주세요.');
                return;
              }
              try {
                await teamApi.update(memberId, { siteId });
                await load();
              } catch (e: any) {
                window.alert(getErrorMessage(e, '배정 실패'));
              }
            }}
          />
        </aside>
      </section>
      </>
      )}

      {bulkOpen && today && (
        <BulkCheckOutDialog
          open={bulkOpen}
          today={today}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            load();
          }}
        />
      )}

      {manualOpen && (
        <ManualCheckDialog
          open={!!manualOpen}
          memberId={manualOpen.memberId}
          memberName={
            month?.rows.find((r) => r.memberId === manualOpen.memberId)?.memberName ?? ''
          }
          onClose={() => setManualOpen(null)}
          onDone={() => {
            setManualOpen(null);
            load();
          }}
        />
      )}

      {gongsuOpen && (
        <SetGongsuDialog
          open={!!gongsuOpen}
          {...gongsuOpen}
          onClose={() => setGongsuOpen(null)}
          onDone={() => {
            setGongsuOpen(null);
            load();
          }}
        />
      )}

      {bulkGongsuOpen && (
        <BulkGongsuDialog
          open={!!bulkGongsuOpen}
          {...bulkGongsuOpen}
          onClose={() => setBulkGongsuOpen(null)}
          onDone={() => {
            setBulkGongsuOpen(null);
            load();
          }}
        />
      )}

      {/* 출역확인 요청 모달 — 원도급이 하도급사에 알림 발송 */}
      {subRequestModal && (
        <SubVerifyRequestModal
          state={subRequestModal}
          date={todayStr}
          siteId={siteId}
          senderName={user?.name ?? '원도급 담당자'}
          onChange={(patch) => setSubRequestModal((s) => (s ? { ...s, ...patch } : s))}
          onClose={() => setSubRequestModal(null)}
          onSent={() => {
            setSubRequestModal(null);
            setRequestLogBump((n) => n + 1);
          }}
        />
      )}

      {/* 엑셀 업로드 모달 — 양식 다운로드 + 입력양식/노임대장 양식 선택 업로드 */}
      {uploadOpen && (
        <ExcelUploadModal
          site={sites.find((s) => s.id === siteId) ?? null}
          siteId={siteId}
          siteName={sites.find((s) => s.id === siteId)?.name ?? ''}
          yearMonth={yearMonth}
          members={siteMembers}
          companyName={user?.companyName}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            load();
          }}
        />
      )}
      {quickAddOpen && siteId !== 'ALL' && (
        <QuickAddMemberDialog
          open={quickAddOpen}
          siteId={siteId}
          siteName={sites.find((s) => s.id === siteId)?.name ?? ''}
          onClose={() => setQuickAddOpen(false)}
          onDone={() => {
            setQuickAddOpen(false);
            load();
          }}
        />
      )}
      {attendAddFor && (
        /* + 출역 추가 — 수동 공수 처리 dialog (SetGongsuDialog) 와 통일된 UI 사용
         * 기존 AttendAddDialog (이름·주민번호·일당·보험·안전교육 입력 폼) 는 사용 중지 */
        <SetGongsuDialog
          open={true}
          memberId={attendAddFor.id}
          memberName={attendAddFor.name}
          role={attendAddFor.role || ''}
          date={todayStr}
          siteName={sites.find((s) => s.id === attendAddFor.siteId)?.name ?? ''}
          dailyWage={attendAddFor.dailyWage || 250000}
          initial={1}
          record={null}
          onClose={() => setAttendAddFor(null)}
          onDone={async () => {
            setAttendAddFor(null);
            await load();
          }}
        />
      )}

      {/* 인증관리 — 상세 로그 팝업 */}
      {authDetailRecord && (() => {
        const tm = authDetailRecord;
        const r = tm.record;
        const member = allMembers.find((m) => m.id === tm.memberId);
        const foreman = member?.foremanId ? foremen.find((f) => f.id === member.foremanId) : undefined;
        const site = sites.find((s) => s.id === r?.siteId);
        const handled = authHandledRecords.get(r?.id);
        const fmt = (iso?: string | null) => {
          if (!iso) return '—';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return iso;
          return d.toLocaleString('ko-KR');
        };
        return (
          <Modal
            open
            onClose={() => setAuthDetailRecord(null)}
            title={`인증 로그 상세 — ${tm.memberName}`}
            subtitle={`${site?.name ?? ''} · ${(r?.checkInAt ?? '').slice(0, 10) || '—'}`}
            width={640}
          >
            <div className="auth-detail-modal">
              {/* 처리 이력 — 가장 위 */}
              {handled && (
                <div className={'auth-detail-modal__handled auth-detail-modal__handled--' + (handled.action === 'rejected' ? 'danger' : 'ok')}>
                  <div className="auth-detail-modal__handled-row">
                    <strong>
                      {handled.action === 'approved' ? '✓ 승인 완료' :
                       handled.action === 'rejected' ? '✕ 반려 완료' : '✓ 확인 완료'}
                    </strong>
                    <span>{fmt(handled.at)}</span>
                    {handled.by && <span>by {handled.by}</span>}
                  </div>
                  {handled.reason && (
                    <div className="auth-detail-modal__handled-reason">
                      <span className="auth-detail-modal__handled-reason-label">사유</span>
                      <span className="auth-detail-modal__handled-reason-value">{handled.reason}</span>
                    </div>
                  )}
                </div>
              )}

              {/* ① 신원 — 가장 큰 타이틀 */}
              <div className="auth-dx__id">
                <div className="auth-dx__name">{tm.memberName}</div>
                <div className="auth-dx__sub">
                  {member?.role && <span>{member.role}</span>}
                  <span className="auth-dx__dot">·</span>
                  <span>반장 {foreman ? foreman.name : '—'}</span>
                  <span className="auth-dx__dot">·</span>
                  <span>{site?.name ?? '—'}</span>
                </div>
              </div>

              {/* ② 근로일 / 출근·퇴근 / 공수·일당 — 3단 그리드 */}
              <div className="auth-dx__time">
                {/* 1단 — 근로일 (왼쪽 정렬, 진한 폰트) */}
                <div className="auth-dx__col auth-dx__col--date">
                  <span className="auth-dx__metric-label">근로일</span>
                  <strong className="auth-dx__date-value">{r?.date ?? (r?.checkInAt ?? '').slice(0, 10) ?? '—'}</strong>
                </div>

                <div className="auth-dx__col-divider" />

                {/* 2단 — 출근 → 퇴근 */}
                <div className="auth-dx__col auth-dx__col--time">
                  <div className="auth-dx__col-row">
                    <div className="auth-dx__metric">
                      <span className="auth-dx__metric-label">출근</span>
                      <strong className="auth-dx__metric-value">{r?.checkInAt ? new Date(r.checkInAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</strong>
                    </div>
                    <div className="auth-dx__arrow" aria-hidden>→</div>
                    <div className="auth-dx__metric">
                      <span className="auth-dx__metric-label">퇴근</span>
                      <strong className="auth-dx__metric-value">{r?.checkOutAt ? new Date(r.checkOutAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</strong>
                    </div>
                  </div>
                </div>

                <div className="auth-dx__col-divider" />

                {/* 3단 — 공수 + 일당 */}
                <div className="auth-dx__col auth-dx__col--pay">
                  <div className="auth-dx__col-row">
                    <div className="auth-dx__metric">
                      <span className="auth-dx__metric-label">공수</span>
                      <strong className="auth-dx__metric-value">{r?.gongsu != null ? r.gongsu : '—'}</strong>
                    </div>
                    <div className="auth-dx__metric">
                      <span className="auth-dx__metric-label">일당</span>
                      <strong className="auth-dx__metric-value">{r?.dailyWage != null ? r.dailyWage.toLocaleString('ko-KR') + '원' : '—'}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* ③ 인증 결과 — 4개 칩 한 줄 */}
              <div className="auth-dx__verify">
                <div className="auth-dx__verify-item">
                  <span className="auth-dx__verify-label">인증방식</span>
                  <span className="auth-dx__verify-value">{r?.checkInMethod === 'FACE' ? '얼굴인식' : r?.checkInMethod === 'MANUAL' ? '수기입력' : '—'}</span>
                </div>
                <div className="auth-dx__verify-item">
                  <span className="auth-dx__verify-label">얼굴 점수</span>
                  <span className={'auth-dx__verify-value' + (r?.checkInScore != null && r.checkInScore <= 0.7 ? ' auth-dx__verify-value--bad' : '')}>
                    {r?.checkInScore != null ? Math.round(r.checkInScore * 100) + '%' : '—'}
                  </span>
                </div>
                <div className="auth-dx__verify-item">
                  <span className="auth-dx__verify-label">GPS</span>
                  <span className={'auth-dx__verify-value' + (r?.geofenceResult && r?.geofenceResult !== 'INSIDE' ? ' auth-dx__verify-value--bad' : '')}>
                    {r?.geofenceResult === 'INSIDE' ? '정상' : '이탈'}
                  </span>
                </div>
                <div className="auth-dx__verify-item">
                  <span className="auth-dx__verify-label">거리</span>
                  <span className="auth-dx__verify-value">{r?.distanceFromSiteM != null ? Math.round(r.distanceFromSiteM) + 'm' : '—'}</span>
                </div>
              </div>

              {r?.manualReason && (
                <div className="auth-detail-modal__reason">
                  <strong>수기 입력 사유</strong>
                  <p>{r.manualReason}</p>
                </div>
              )}

              {/* 수정 이력 (manualPayHistory) — 가장 최근부터 */}
              {Array.isArray(r?.manualPayHistory) && r.manualPayHistory.length > 0 && (
                <div className="auth-detail-modal__history">
                  <strong>공수·임금 수정 이력 ({r.manualPayHistory.length}건)</strong>
                  <ul>
                    {r.manualPayHistory.slice().reverse().map((h: any, i: number) => (
                      <li key={i}>
                        <span className="hist-time">{fmt(h.at)}</span>
                        <span className="hist-change">
                          공수 {h.fromGongsu} → <strong>{h.toGongsu}</strong> ·
                          임금 {h.fromPay?.toLocaleString('ko-KR')}원 → <strong>{h.toPay?.toLocaleString('ko-KR')}원</strong>
                        </span>
                        {h.reason && <span className="hist-reason">사유: {h.reason}</span>}
                        {h.by && <span className="hist-by">by {h.by}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="auth-detail-modal__actions">
                {/* 처리되지 않은 record — 분류별 의사결정 버튼 */}
                {!handled && (() => {
                  const cls = (() => {
                    if (!r) return 'ok';
                    if (r.checkInMethod === 'MANUAL') return 'pending';
                    const faceFail = r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7;
                    const gpsBad = r.geofenceResult && r.geofenceResult !== 'INSIDE';
                    if (faceFail || gpsBad) return 'check';
                    return 'ok';
                  })();
                  if (cls === 'pending') {
                    return (
                      <>
                        <button type="button" className="auth-btn auth-btn--ok"
                          onClick={() => setAuthActionPrompt({ tm, action: 'approved' })}>승인</button>
                        <button type="button" className="auth-btn auth-btn--no"
                          onClick={() => setAuthActionPrompt({ tm, action: 'rejected' })}>반려</button>
                      </>
                    );
                  }
                  if (cls === 'check') {
                    return (
                      <>
                        <button type="button" className="auth-btn auth-btn--ok"
                          onClick={() => setAuthActionPrompt({ tm, action: 'confirmed' })}>확인</button>
                        <button type="button" className="auth-btn auth-btn--no"
                          onClick={() => setAuthActionPrompt({ tm, action: 'rejected' })}>반려</button>
                      </>
                    );
                  }
                  return (
                    <button type="button" className="auth-btn auth-btn--no"
                      onClick={() => setAuthActionPrompt({ tm, action: 'rejected' })}>반려</button>
                  );
                })()}
                {/* 처리된 record — 「내용 수정」 (같은 action 으로 사유만 갱신) + 「반려로 변경」 또는 반대 액션 */}
                {handled && (() => {
                  // 현재 action 의 라벨
                  const curLabel = handled.action === 'approved' ? '승인'
                                 : handled.action === 'rejected' ? '반려' : '확인';
                  // 현재가 반려가 아니면 「반려로 변경」 노출. 반려면 record 분류에 따라 「승인/확인으로 변경」 노출.
                  const isCurrentRejected = handled.action === 'rejected';
                  const cls = (() => {
                    if (!r) return 'ok';
                    if (r.checkInMethod === 'MANUAL') return 'pending';
                    const faceFail = r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7;
                    const gpsBad = r.geofenceResult && r.geofenceResult !== 'INSIDE';
                    if (faceFail || gpsBad) return 'check';
                    return 'ok';
                  })();
                  // 반려 → 승인/확인으로 변경 가능 (분류 기준)
                  const restoreAction: 'approved' | 'confirmed' | null = isCurrentRejected
                    ? (cls === 'pending' ? 'approved' : cls === 'check' ? 'confirmed' : 'approved')
                    : null;
                  const restoreLabel = restoreAction === 'approved' ? '승인' : '확인';
                  return (
                    <>
                      {/* 1. 내용 수정 — 같은 결정 유지, 사유만 갱신 */}
                      <button type="button" className="auth-btn"
                        onClick={() => setAuthActionPrompt({ tm, action: handled.action })}
                        title={`현재 결정(${curLabel}) 의 사유를 수정합니다`}>
                        내용 수정
                      </button>
                      {/* 2. action 변경 — 반려 ↔ 승인/확인 토글 */}
                      {!isCurrentRejected && (
                        <button type="button" className="auth-btn auth-btn--no"
                          onClick={() => setAuthActionPrompt({ tm, action: 'rejected' })}
                          title="반려로 변경 (사유 입력 필요)">
                          반려로 변경
                        </button>
                      )}
                      {isCurrentRejected && restoreAction && (
                        <button type="button" className="auth-btn auth-btn--ok"
                          onClick={() => setAuthActionPrompt({ tm, action: restoreAction })}
                          title={`${restoreLabel} 으로 다시 처리`}>
                          {restoreLabel}으로 변경
                        </button>
                      )}
                    </>
                  );
                })()}
                <button type="button" className="auth-btn"
                  onClick={() => setAuthDetailRecord(null)}>닫기</button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* 인증관리 — 승인/반려/확인 사유 입력 프롬프트
       *  · JSX 상 detail 모달보다 뒤에 위치 → 같은 z-index 라도 document order 로 위에 표시.
       *  · onConfirm 시 처리 완료 후 상세 팝업도 함께 닫음. */}
      {authActionPrompt && (() => {
        const { tm, action } = authActionPrompt;
        const r = tm.record;
        const actionLabel = action === 'approved' ? '승인' : action === 'rejected' ? '반려' : '확인';
        const isManualRecord = r?.checkInMethod === 'MANUAL';
        const isFaceFail = r?.checkInMethod === 'FACE' && (r?.checkInScore ?? 0) <= 0.7;
        const reasonRequired = isManualRecord || isFaceFail; // 수기 입력 또는 얼굴 실패 시 사유 필수
        return (
          <AuthReasonPicker
            memberName={tm.memberName}
            actionLabel={actionLabel}
            action={action}
            reasonRequired={reasonRequired}
            onClose={() => setAuthActionPrompt(null)}
            onConfirm={(reason) => {
              markAuthHandled(r.id, action, reason);
              setAuthActionPrompt(null);
              // 상세 팝업도 함께 닫음 — 처리된 record 의 detail 은 「닫기」만 노출되므로 자연스럽게 종료
              setAuthDetailRecord(null);
            }}
          />
        );
      })()}

      {authToast && (
        <div className="auth-toast" role="status">{authToast}</div>
      )}
    </div>
  );
}

function cellClass(r: AttendanceRecord | undefined): string {
  if (!r) return '';
  if (r.status === 'ABSENT') return 'att-cell--absent';
  // 입력 방식·공수 값과 무관하게 단일 톤 (수동/얼굴은 셀 내 라벨로 구분)
  return 'att-cell--filled';
}

/* ───────── 좌측: 팀원 요약 리스트 (이름·직종·공수·일수) ───────── */

/* ───────── 다중 현장 합계 머지 ───────── */

function mergeMonths(
  months: AttendanceMonth[],
  yearMonth: string,
): AttendanceMonth | null {
  if (months.length === 0) return null;
  if (months.length === 1) return months[0];
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  // dates 는 같은 yearMonth 면 동일하므로 첫 번째 것 사용
  const dates = months[0].dates;
  const rows = months.flatMap((m) => m.rows);
  const summary = {
    totalMembers: 0,
    totalGongsu: 0,
    totalPay: 0,
    faceCount: 0,
    manualCount: 0,
    absentCount: 0,
    lateCount: 0,
    earlyCount: 0,
  };
  for (const m of months) {
    summary.totalMembers += m.summary.totalMembers;
    summary.totalGongsu += m.summary.totalGongsu;
    summary.totalPay += m.summary.totalPay;
    summary.faceCount += m.summary.faceCount;
    summary.manualCount += m.summary.manualCount;
    summary.absentCount += m.summary.absentCount;
    summary.lateCount += m.summary.lateCount;
    summary.earlyCount += m.summary.earlyCount;
  }
  return { year, month, siteId: 'ALL', dates, rows, summary };
}

function mergeTodays(todays: TodayAttendance[]): TodayAttendance | null {
  if (todays.length === 0) return null;
  if (todays.length === 1) return todays[0];
  const members = todays.flatMap((t) => t.members);
  const summary = {
    totalCount: 0, beforeCount: 0, workingCount: 0, doneCount: 0,
  };
  for (const t of todays) {
    summary.totalCount += t.summary.totalCount;
    summary.beforeCount += t.summary.beforeCount;
    summary.workingCount += t.summary.workingCount;
    summary.doneCount += t.summary.doneCount;
  }
  return {
    siteId: 'ALL',
    date: todays[0].date,
    members,
    summary,
  };
}

/* ───────── 년월 선택기 (네이티브 month input 대체) ───────── */

function YearMonthPicker({
  value,
  onChange,
}: {
  value: string; // 'YYYY-MM'
  onChange: (next: string) => void;
}) {
  const [yStr, mStr] = value.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;

  // 올해 기준 ±3년 범위
  const years: number[] = [];
  for (let y = thisYear - 3; y <= thisYear + 1; y++) years.push(y);
  const months: number[] = [];
  for (let m = 1; m <= 12; m++) months.push(m);

  function set(y: number, m: number) {
    onChange(`${y}-${String(m).padStart(2, '0')}`);
  }
  function shift(delta: number) {
    let y = year, m = month + delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    set(y, m);
  }
  function goThisMonth() {
    set(thisYear, thisMonth);
  }

  return (
    <div className="ymp">
      <button
        type="button"
        className="ymp__nav"
        onClick={() => shift(-1)}
        aria-label="이전 달"
        title="이전 달"
      >
        ‹
      </button>
      <MacSelect
              value={year}
              onChange={(v) => set(Number(v), month)}
              className="ymp__select ymp__select--year"
              menuMinWidth={120}
              options={[...years.map((y) => (
          ({ value: y, label: <>{y}년</> })
        ))]}
            />
      <MacSelect
              value={month}
              onChange={(v) => set(year, Number(v))}
              className="ymp__select ymp__select--month"
              menuMinWidth={90}
              options={[...months.map((m) => (
          ({ value: m, label: <>{m}월</> })
        ))]}
            />
      <button
        type="button"
        className="ymp__nav"
        onClick={() => shift(1)}
        aria-label="다음 달"
        title="다음 달"
      >
        ›
      </button>
      <button
        type="button"
        className="ymp__today"
        onClick={goThisMonth}
        title="이번 달로 이동"
      >
        이번 달
      </button>
    </div>
  );
}

/**
 * 일자별 출력 모드의 좌측 리스트.
 *  - 그 날 출석한 팀원 (gongsu > 0) — ㄱㄴㄷ 정렬
 *  - 헤더: MM-DD (요일) + 출석명수 + 총공수 + 임금
 *  - 행 클릭 → 그 사람·그 날 의 공수 직접 입력 다이얼로그 직행
 */
/** specialty 문자열에서 식별용 두 글자 추출 — "철근·콘크리트공사" → "철근" */
function shortSpecialty(s: string | undefined | null): string {
  if (!s) return '하';
  const clean = s.replace(/[·\s,()/]|제\d+종/g, '');
  return clean.slice(0, 2) || '하';
}

function DateAttendanceList({
  rows,
  date,
  onPickMember,
  ownMemberIds,
  subMemberIds,
  memberSpecialty,
  splitEnabled,
  isOwnerViewer,
  onAddMember,
}: {
  rows: AttendanceMonth['rows'];
  date: string;
  onPickMember: (memberId: string) => void;
  /** 원도급(또는 직속/미배정) 멤버 ID 셋 — "원" 칩 + 정렬 우선 */
  ownMemberIds: Set<string>;
  /** 하도급 멤버 ID 셋 — 업종 두 글자 칩 */
  subMemberIds: Set<string>;
  /** 멤버 ID → SiteCompany.specialty(업종) 매핑 — 하도급 칩 라벨 */
  memberSpecialty: Map<string, string>;
  /** 원/하 분리 표시 활성 여부 (ALL 모드에선 false) */
  splitEnabled: boolean;
  /** 원도급 본인 뷰 — 하도급 멤버 출근 기록 수정 차단 */
  isOwnerViewer: boolean;
  /** 「팀원 추가」 — 단일 현장 모드일 때만 노출 */
  onAddMember?: () => void;
}) {
  // 그 날 출석한 사람만 추리기 (gongsu > 0) — 원도급 → 하도급 순서, 그 안에서 ㄱㄴㄷ 정렬
  const present = rows
    .map((r) => ({ row: r, rec: r.daily[date] }))
    .filter((x) => x.rec && (x.rec as { gongsu: number }).gongsu > 0)
    .sort((a, b) => {
      // 1차: 원도급(false) → 하도급(true) 순
      const aSub = subMemberIds.has(a.row.memberId);
      const bSub = subMemberIds.has(b.row.memberId);
      if (aSub !== bSub) return aSub ? 1 : -1;
      // 2차: 이름 ㄱㄴㄷ
      return a.row.memberName.localeCompare(b.row.memberName, 'ko');
    });

  const totalGongsu = present.reduce((s, p) => s + (p.rec?.gongsu ?? 0), 0);
  const ownCount = present.filter((p) => !subMemberIds.has(p.row.memberId)).length;
  const subCount = present.filter((p) => subMemberIds.has(p.row.memberId)).length;
  // 임금(payAmount)은 출퇴근 현황 화면에선 노출하지 않음 — 원·하도급 간 임금 정보 공유 금지 정책
  const dow = new Date(date + 'T00:00:00').getDay();
  const dowKr = ['일', '월', '화', '수', '목', '금', '토'][dow];
  void ownMemberIds; // 분류 시 subMemberIds 만 사용 (own = !sub)

  return (
    <div className="att-day-list">
      <header className="att-day-list__head">
        <div className="att-day-list__head-l">
          <h3 className="att-day-list__title">
            {date.slice(5)} <small>({dowKr})</small>
          </h3>
          <p className="att-day-list__sub">
            {splitEnabled ? (
              <>
                <span className="att-day-list__split-tag att-day-list__split-tag--own">원도급</span>
                <strong>{ownCount}</strong>명 ·{' '}
                <span className="att-day-list__split-tag att-day-list__split-tag--sub">하도급</span>
                <strong>{subCount}</strong>명 · 총{' '}
                <strong>{totalGongsu.toFixed(1)}</strong> 공수
              </>
            ) : (
              <>
                출석 <strong>{present.length}</strong>명 · 총{' '}
                <strong>{totalGongsu.toFixed(1)}</strong> 공수
              </>
            )}
          </p>
        </div>
        {onAddMember && (
          <button
            type="button"
            className="att-day-list__add"
            onClick={onAddMember}
            title="이 현장에 새 팀원 등록"
          >
            ＋ 팀원 추가
          </button>
        )}
        <div className="att-day-list__legend">
          <span className="att-day-list__legend-item att-day-list__legend-item--face">
            <span className="att-day-list__legend-dot" /> 얼굴인식 출근
          </span>
          <span className="att-day-list__legend-item att-day-list__legend-item--manual">
            <span className="att-day-list__legend-dot" /> 수동
          </span>
        </div>
      </header>

      {present.length === 0 ? (
        <p className="att-day-list__empty">이 날 출석한 사람이 없습니다.</p>
      ) : (
        <ul className="att-day-list__items">
          {present.map(({ row: r, rec }) => {
            if (!rec) return null;
            const method = rec.checkInMethod ?? rec.checkOutMethod ?? null;
            const isSub = subMemberIds.has(r.memberId);
            // 원도급 본인 뷰에서 하도급 멤버는 수정 불가 — 클릭/안내 차단
            const locked = isOwnerViewer && isSub;
            return (
              <li
                key={r.memberId}
                className={
                  'att-day-list__item' + (locked ? ' is-locked' : '')
                }
                onClick={() => {
                  if (locked) return;
                  onPickMember(r.memberId);
                }}
                title={
                  locked
                    ? '하도급사 작업자 — 원도급은 수정할 수 없습니다'
                    : '개인별 캘린더로 보기'
                }
              >
                {splitEnabled ? (
                  <span
                    className={
                      'att-day-list__owner-tag att-day-list__owner-tag--' +
                      (isSub ? 'sub' : 'own')
                    }
                    aria-label={
                      isSub
                        ? `하도급 — ${memberSpecialty.get(r.memberId) ?? '업종 미지정'}`
                        : '원도급'
                    }
                    title={
                      isSub
                        ? `하도급 · ${memberSpecialty.get(r.memberId) ?? '업종 미지정'}`
                        : '원도급'
                    }
                  >
                    {isSub
                      ? shortSpecialty(memberSpecialty.get(r.memberId))
                      : '원'}
                  </span>
                ) : null}
                <span className="att-day-list__name">
                  {r.memberName}
                  <em className="att-day-list__role">{r.role}</em>
                  {locked && (
                    <span className="att-day-list__lock" aria-hidden>🔒</span>
                  )}
                  <span className="att-day-list__times">
                    {rec.checkInAt ? (
                      <span
                        className={
                          'att-day-list__time' +
                          (rec.checkInMethod === 'FACE' ? ' is-face' : ' is-manual')
                        }
                        title={`${methodLabel(rec.checkInMethod, rec.checkInScore) || '출근'} · ${isoToHHMM(rec.checkInAt)}`}
                      >
                        {isoToHHMM(rec.checkInAt)}
                      </span>
                    ) : (
                      <span className="att-day-list__time att-day-list__time--none">─</span>
                    )}
                    <span className="att-day-list__time-sep">~</span>
                    {rec.checkOutAt ? (
                      <span
                        className={
                          'att-day-list__time' +
                          (rec.checkOutMethod === 'FACE' ? ' is-face' : ' is-manual')
                        }
                        title={`${checkOutMethodLabel(rec) || '퇴근'} · ${isoToHHMM(rec.checkOutAt)}`}
                      >
                        {isoToHHMM(rec.checkOutAt)}
                      </span>
                    ) : (
                      <span className="att-day-list__time att-day-list__time--none">─</span>
                    )}
                  </span>
                </span>
                <span className="att-day-list__gongsu">
                  <strong>{rec.gongsu.toFixed(1)}</strong>
                  <em>공수</em>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 지오펜싱 결과 뱃지 — 출석자 행 옆에 작은 아이콘
 *  · INSIDE → 표시 없음 (정상)
 *  · OUTSIDE → ⚠ 빨강 (현장 밖 출근 시도)
 *  · LOW_ACCURACY → 📍 노랑 (GPS 오차범위 초과)
 *  · NO_LOCATION → ❓ 회색 (위치정보 미수집)
 */
function GeofenceBadge({ rec }: { rec: AttendanceRecord }) {
  const result = rec.geofenceResult;
  if (!result || result === 'INSIDE') return null;
  if (result === 'OUTSIDE') {
    const dist = rec.distanceFromSiteM ? `${rec.distanceFromSiteM}m` : '반경 밖';
    const acc = rec.checkInLocation?.accuracy;
    return (
      <Tooltip
        tone="danger"
        title="⚠ 현장 밖 출근 시도"
        body={
          <>
            현장 좌표로부터 <strong>{dist}</strong> 떨어진 위치에서 인증 시도
            {acc && <> · 정확도 ±{acc}m</>}
          </>
        }
      >
        <span className="att-day-list__geo att-day-list__geo--out" aria-label={`현장 밖 ${dist}`}>
          ⚠
        </span>
      </Tooltip>
    );
  }
  if (result === 'LOW_ACCURACY') {
    const acc = rec.checkInLocation?.accuracy;
    return (
      <Tooltip
        tone="warning"
        title="📍 GPS 오차범위 초과"
        body={
          <>
            측정 정확도{acc && <> ±{acc}m</>}로 위치 신뢰도가 낮습니다. 실내·터널·고층빌딩 영향 가능
          </>
        }
      >
        <span className="att-day-list__geo att-day-list__geo--low" aria-label="GPS 오차">
          📍
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      tone="default"
      title="❓ 위치정보 미수집"
      body={<>위치 권한이 없거나 반장이 수동으로 처리한 출근입니다</>}
    >
      <span className="att-day-list__geo att-day-list__geo--none" aria-label="GPS 위치 미수집">
        ❓
      </span>
    </Tooltip>
  );
}

/**
 * 개인별 출력 모드의 좌측 리스트 — 전체 팀원 (ㄱㄴㄷ 정렬).
 *  - 1단 행 (아바타·이름·직종칩·이달 누적 공수) — DateAttendanceList 와 동일 스타일
 *  - 행 클릭 → 우측 캘린더가 그 사람의 공수로 채워짐
 */
function TeamListUnified({
  rows,
  selectedId,
  onSelect,
  onAddMember,
}: {
  rows: AttendanceMonth['rows'];
  selectedId: string;
  onSelect: (memberId: string) => void;
  /** 「팀원 추가」 버튼 클릭 — 미제공 시 버튼 자체가 안 보임 (예: ALL 모드) */
  onAddMember?: () => void;
}) {
  function handleDragStart(e: React.DragEvent<HTMLLIElement>, memberId: string) {
    // 풀로 되돌리는 드래그 — text/plain 으로 memberId 전송
    e.dataTransfer.setData('text/plain', memberId);
    e.dataTransfer.effectAllowed = 'move';
    console.log('[team-list] dragstart (back to pool)', memberId);
  }
  const sorted = [...rows].sort((a, b) =>
    a.memberName.localeCompare(b.memberName, 'ko'),
  );
  return (
    <div className="att-day-list">
      <header className="att-day-list__head att-day-list__head--row">
        <div className="att-day-list__title-wrap">
          <h3 className="att-day-list__title">팀원 ({sorted.length}명)</h3>
          <p className="att-day-list__sub">
            이름 클릭 시 우측에 그 사람의 공수 캘린더가 표시됩니다.
          </p>
        </div>
        {onAddMember && (
          <button
            type="button"
            className="att-day-list__add"
            onClick={onAddMember}
            title="이 현장에 새 팀원 등록"
          >
            ＋ 팀원 추가
          </button>
        )}
      </header>
      {sorted.length === 0 ? (
        <p className="att-day-list__empty">등록된 팀원이 없습니다.</p>
      ) : (
        <ul className="att-day-list__items">
          {sorted.map((r) => {
            const isSel = r.memberId === selectedId;
            return (
              <li
                key={r.memberId}
                className={'att-day-list__item' + (isSel ? ' is-selected' : '') + ' is-draggable'}
                onClick={() => onSelect(r.memberId)}
                draggable
                onDragStart={(e) => handleDragStart(e, r.memberId)}
                title="클릭 → 캘린더에 표시 / 드래그 → 우측 「관리인원」으로 되돌리기"
              >
                <span className="att-day-list__avatar" aria-hidden>
                  {r.memberName.slice(0, 1)}
                </span>
                <span className="att-day-list__name">
                  {r.memberName}
                  <em className="att-day-list__role">{r.role}</em>
                </span>
                <span className="att-day-list__gongsu">
                  <strong>{r.totalGongsu.toFixed(1)}</strong>
                  <em>공수</em>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 개인별 출력 모드 + 미선택 시의 빈 캘린더.
 *  - 그리드 구조는 유지 (월/일자만), 데이터는 비움
 *  - 안내 문구 표시
 */
function EmptyMemberCalendar({
  yearMonth,
  onYearMonthChange,
}: {
  yearMonth: string;
  onYearMonthChange: (next: string) => void;
}) {
  const [y, mo] = yearMonth.split('-').map(Number);
  const firstDay = new Date(y, mo - 1, 1);
  const lastDay = new Date(y, mo, 0);
  const startDow = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const cells: Array<{ day: number | null }> = [];
  for (let i = 0; i < startDow; i++) cells.push({ day: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });
  while (cells.length < 42) cells.push({ day: null });
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  return (
    <div className="att-cal att-cal--empty">
      <header className="att-col__head att-cal__head">
        <div>
          <h3>개인별 출력</h3>
          <p>좌측에서 팀원을 선택하면 그 사람의 공수가 여기에 표시됩니다.</p>
        </div>
        <div className="att-cal__ym">
          <YearMonthPicker value={yearMonth} onChange={onYearMonthChange} />
        </div>
      </header>
      <div className="att-cal__grid att-cal__grid--placeholder">
        {dows.map((d, i) => (
          <div
            key={d}
            className={
              'att-cal__dow' +
              (i === 0 ? ' is-sun' : '') +
              (i === 6 ? ' is-sat' : '')
            }
          >
            {d}
          </div>
        ))}
        {cells.map((c, idx) => (
          <div key={idx} className="att-cal__cell att-cal__cell--placeholder">
            {c.day && <span className="att-day-cell__day">{c.day}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

type AttSortKey = 'name' | 'role' | 'gongsu' | 'days';

function MemberSummaryList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: AttendanceMonth['rows'];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<AttSortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);

  function toggle(key: AttSortKey) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  const countByRole = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.role, (m.get(r.role) ?? 0) + 1);
    return m;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const list = roleFilter ? rows.filter((r) => r.role === roleFilter) : rows;
    const sign = sortDir === 'asc' ? 1 : -1;
    const get = (r: AttendanceMonth['rows'][number]): string | number => {
      switch (sortKey) {
        case 'name': return r.memberName;
        case 'role': return r.role;
        case 'gongsu': return r.totalGongsu;
        case 'days': return r.totalDays;
      }
    };
    return [...list].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
      return String(va).localeCompare(String(vb), 'ko') * sign;
    });
  }, [rows, roleFilter, sortKey, sortDir]);

  return (
    <div className="att-mlist">
      <header className="att-col__head">
        <h3>팀원 ({visibleRows.length}명)</h3>
        <p>직종 칩으로 필터링 · 컬럼 헤더 클릭으로 오름/내림차순 정렬.</p>
      </header>
      <div className="att-mlist__chips">
        <button
          type="button"
          className={'role-bd__chip role-bd__chip--all' + (!roleFilter ? ' is-active' : '')}
          onClick={() => setRoleFilter(null)}
        >
          전체 <strong>{rows.length}</strong>
        </button>
        {Array.from(countByRole.entries())
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
          .map(([role, count]) => (
            <button
              key={role}
              type="button"
              className={'role-bd__chip' + (roleFilter === role ? ' is-active' : '')}
              onClick={() => setRoleFilter(roleFilter === role ? null : role)}
            >
              {role} <strong>{count}</strong>
            </button>
          ))}
      </div>
      <div className="att-mlist__scroll">
      <table className="att-mlist__table">
        <thead>
          <tr>
            <AttSortTh label="이름" col="name" cur={sortKey} dir={sortDir} on={toggle} />
            <AttSortTh label="직종" col="role" cur={sortKey} dir={sortDir} on={toggle} />
            <AttSortTh label="공수" col="gongsu" cur={sortKey} dir={sortDir} on={toggle} numeric />
            <AttSortTh label="일수" col="days" cur={sortKey} dir={sortDir} on={toggle} numeric />
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r) => (
            <tr
              key={r.memberId}
              className={
                'att-mlist__row' + (selectedId === r.memberId ? ' is-selected' : '')
              }
              onClick={() => onSelect(r.memberId)}
            >
              <td className="att-mlist__name">
                <span className="att-mlist__avatar">{r.memberName.slice(0, 1)}</span>
                {r.memberName}
              </td>
              <td className="att-mlist__role">{r.role}</td>
              <td className="att-mlist__num att-mlist__num--strong">
                {r.totalGongsu.toFixed(1)}
              </td>
              <td className="att-mlist__num">{r.totalDays}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function AttSortTh({
  label, col, cur, dir, on, numeric,
}: {
  label: string;
  col: AttSortKey;
  cur: AttSortKey;
  dir: 'asc' | 'desc';
  on: (k: AttSortKey) => void;
  numeric?: boolean;
}) {
  const active = cur === col;
  return (
    <th
      className={
        (numeric ? 'att-mlist__num ' : '') +
        'att-mlist__sort' +
        (active ? ' is-active' : '')
      }
      onClick={() => on(col)}
    >
      {label}
      <span className="att-mlist__sort-ind" aria-hidden>
        {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

/* ───────── 중앙: 선택 팀원의 달력 ───────── */

/**
 * 일자별 출력인원 캘린더 — 팀원 미선택 시 기본 뷰.
 *  · 셀: 큰 숫자(출석명수) + 작은 숫자(총 공수)
 *  · 색상: 출석율(전체팀원 대비 %)에 따른 heatmap (낮음 → 높음)
 *  · 셀 hover: 그날 출석한 팀원 목록 + 미출석 팀원 (요약 tooltip)
 *  · 셀 클릭: 그 날 출석한 사람 중 첫 명을 선택 (member 뷰 진입) — 또는 전체보기 유지
 */
function DailyAttendanceCalendar({
  month,
  yearMonth,
  selectedDate,
  onPickDate,
  onYearMonthChange,
  ownMemberIds,
  subMemberIds,
  splitEnabled,
}: {
  month: AttendanceMonth;
  yearMonth: string;
  selectedDate: string | null;
  onPickDate: (date: string | null) => void;
  onYearMonthChange: (next: string) => void;
  /** 원도급(또는 직속/미배정) 멤버 ID 셋 — 헤더 메타의 "원" 분리 카운트 */
  ownMemberIds: Set<string>;
  /** 하도급 멤버 ID 셋 — 헤더 메타의 "하" 분리 카운트 */
  subMemberIds: Set<string>;
  /** ALL 모드(여러 현장)에서는 분리 표시가 의미 없으므로 false */
  splitEnabled: boolean;
}) {
  const [y, mo] = yearMonth.split('-').map(Number);
  const firstDay = new Date(y, mo - 1, 1);
  const lastDay = new Date(y, mo, 0);
  const startDow = firstDay.getDay();
  const daysInMonth = lastDay.getDate();

  // 6주 × 7일 = 42칸 그리드
  const cells: Array<{ date: string | null; day: number | null }> = [];
  for (let i = 0; i < startDow; i++) cells.push({ date: null, day: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${yearMonth}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d });
  }
  while (cells.length < 42) cells.push({ date: null, day: null });

  const todayStr = new Date().toISOString().slice(0, 10);
  const dows = ['일', '월', '화', '수', '목', '금', '토'];

  // 일자별 집계 ─ 출석명수 + 총 공수 + 출석자 이름
  type DayStat = { count: number; gongsu: number; names: string[] };
  const byDate = new Map<string, DayStat>();
  for (const r of month.rows) {
    for (const date in r.daily) {
      const rec = r.daily[date];
      if (!rec || rec.gongsu <= 0) continue;
      const cur = byDate.get(date) ?? { count: 0, gongsu: 0, names: [] };
      cur.count += 1;
      cur.gongsu += rec.gongsu;
      cur.names.push(r.memberName);
      byDate.set(date, cur);
    }
  }
  const totalMembers = month.rows.length;
  // 최고 출석율 계산 (heatmap 정규화용)
  let maxCount = 0;
  for (const v of byDate.values()) if (v.count > maxCount) maxCount = v.count;
  void totalMembers; // 헤더 메타에서 더 이상 사용 안 함 (향후 복원용)

  function densityClass(count: number): string {
    if (count === 0) return '';
    const ratio = maxCount > 0 ? count / maxCount : 0;
    if (ratio >= 0.85) return 'is-h4';
    if (ratio >= 0.6) return 'is-h3';
    if (ratio >= 0.35) return 'is-h2';
    return 'is-h1';
  }

  // ─── 헤더 메타 — 월 합계 / 선택 일자 합계, 원·하도급 분리 ───
  // 카운트 단위:
  //  · 월 합계: byDate 의 unique 출석자 수 (동일인 여러 일자 출석해도 1명)
  //  · 일 합계: 그 날 출석한 인원 (그 날만)
  function aggregate(filterFn: (rec: AttendanceRecord, date: string) => boolean) {
    let total = 0;
    let own = 0;
    let sub = 0;
    let gongsu = 0;
    let ownGongsu = 0;
    let subGongsu = 0;
    const seen = new Set<string>();
    for (const r of month.rows) {
      let memberAttended = false;
      for (const date in r.daily) {
        const rec = r.daily[date];
        if (!rec || rec.gongsu <= 0) continue;
        if (!filterFn(rec, date)) continue;
        gongsu += rec.gongsu;
        if (subMemberIds.has(r.memberId)) subGongsu += rec.gongsu;
        else ownGongsu += rec.gongsu;
        memberAttended = true;
      }
      if (memberAttended && !seen.has(r.memberId)) {
        seen.add(r.memberId);
        total += 1;
        if (subMemberIds.has(r.memberId)) sub += 1;
        else own += 1;
      }
    }
    return { total, own, sub, gongsu, ownGongsu, subGongsu };
  }

  const monthAgg = aggregate(() => true);
  const dayAgg = selectedDate ? aggregate((_rec, d) => d === selectedDate) : null;
  const showAgg = dayAgg ?? monthAgg;
  const headerLabel = selectedDate
    ? `일자별 출력인원 — ${selectedDate}`
    : '일자별 출력인원';
  // 분리 표시 비활성 시(전체 N개 현장)는 원/하 칩 미노출
  void totalMembers; // (현재 메타에선 불필요 — 향후 복원용)

  return (
    <div className="att-cal att-cal--daily">
      <header className="att-col__head att-cal__head">
        <div>
          <h3>
            {headerLabel}
            {selectedDate && (
              <button
                type="button"
                className="att-cal__head-clear"
                onClick={() => onPickDate(null)}
                title="월 전체 합계로 보기"
              >
                ✕
              </button>
            )}
          </h3>
          <p className="att-cal__meta">
            <span className="att-cal__meta-item">
              총 출력인원 <strong>{showAgg.total}</strong>명
            </span>
            <span className="att-cal__meta-sep">·</span>
            <span className="att-cal__meta-item">
              총 공수 <strong>{showAgg.gongsu.toFixed(1)}</strong>
            </span>
            {splitEnabled && (
              <span className="att-cal__meta-split">
                (
                <em className="att-cal__meta-tag">원</em>
                <strong>{showAgg.own}</strong>명
                <i className="att-cal__meta-sep-thin">·</i>
                <em className="att-cal__meta-tag att-cal__meta-tag--sub">하</em>
                <strong>{showAgg.sub}</strong>명
                )
              </span>
            )}
          </p>
        </div>
        <div className="att-cal__ym">
          <YearMonthPicker value={yearMonth} onChange={onYearMonthChange} />
        </div>
      </header>

      <div className="att-cal__grid">
        {dows.map((d, i) => (
          <div
            key={d}
            className={
              'att-cal__dow' +
              (i === 0 ? ' is-sun' : '') +
              (i === 6 ? ' is-sat' : '')
            }
          >
            {d}
          </div>
        ))}
        {cells.map((c, idx) => {
          if (!c.date) return <div key={idx} className="att-cal__cell att-cal__cell--blank" />;
          const stat = byDate.get(c.date);
          const isToday = c.date === todayStr;
          const isSun = idx % 7 === 0;
          const isSat = idx % 7 === 6;
          const isFuture = c.date > todayStr;
          const isSelected = selectedDate === c.date;
          const cls =
            'att-day-cell ' +
            (isFuture ? 'is-future ' : '') +
            (isToday ? 'is-today ' : '') +
            (isSelected ? 'is-selected ' : '') +
            (isSun ? 'is-sun ' : '') +
            (isSat ? 'is-sat ' : '') +
            (stat ? densityClass(stat.count) : 'is-empty');
          // 툴팁 — 출석자 이름 (최대 12명 + 나머지 'N명 더')
          const tipNames = stat
            ? stat.names.length > 12
              ? stat.names.slice(0, 12).join(', ') + ` 외 ${stat.names.length - 12}명`
              : stat.names.join(', ')
            : '';
          const tip = stat
            ? `${c.date}\n출석 ${stat.count}명 / 전체 ${totalMembers}명\n총 ${stat.gongsu.toFixed(1)} 공수\n${tipNames}`
            : isFuture
              ? `${c.date} (예정)`
              : `${c.date}\n출석 0명`;
          return (
            <button
              key={idx}
              type="button"
              className={cls}
              title={tip}
              onClick={() => {
                // 같은 셀 다시 클릭 → 선택 해제 / 다른 셀 → 그 날짜로 변경
                onPickDate(isSelected ? null : c.date);
              }}
            >
              <span className="att-day-cell__day">{c.day}</span>
              {stat ? (
                <>
                  <span className="att-day-cell__count">
                    <strong>{stat.count}</strong>
                    <em>명</em>
                  </span>
                  <span className="att-day-cell__sub">
                    {stat.gongsu.toFixed(1)} 공수
                  </span>
                </>
              ) : !isFuture ? (
                <span className="att-day-cell__zero">·</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MemberCalendar({
  row,
  yearMonth,
  onPick,
  onBulkPick,
  onBack,
  onYearMonthChange,
}: {
  row: AttendanceMonth['rows'][number];
  yearMonth: string; // 'YYYY-MM'
  onPick: (date: string, initial: number) => void;
  onBulkPick: (dates: string[]) => void;
  onManual: () => void;
  onBack?: () => void;
  onYearMonthChange: (next: string) => void;
}) {
  const [y, mo] = yearMonth.split('-').map(Number);
  const firstDay = new Date(y, mo - 1, 1);
  const lastDay = new Date(y, mo, 0);
  const startDow = firstDay.getDay(); // 0=Sun
  const daysInMonth = lastDay.getDate();

  // 6주 × 7일 = 42칸 그리드
  const cells: Array<{ date: string | null; day: number | null }> = [];
  for (let i = 0; i < startDow; i++) cells.push({ date: null, day: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${yearMonth}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d });
  }
  while (cells.length < 42) cells.push({ date: null, day: null });

  const todayStr = new Date().toISOString().slice(0, 10);
  const dows = ['일', '월', '화', '수', '목', '금', '토'];

  // ───────── 드래그 선택 상태 ─────────
  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [dragHover, setDragHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** 두 일자 사이 (포함) 범위. 미래 일자는 자동 제외. */
  function rangeBetween(a: string, b: string): string[] {
    if (!a || !b) return [];
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const out: string[] = [];
    const startD = Number(lo.split('-')[2]);
    const endD = Number(hi.split('-')[2]);
    for (let d = startD; d <= endD; d++) {
      const ds = `${yearMonth}-${String(d).padStart(2, '0')}`;
      if (ds > todayStr) continue;
      out.push(ds);
    }
    return out;
  }

  const draggedRange =
    dragAnchor && dragHover ? rangeBetween(dragAnchor, dragHover) : [];

  function commitDrag() {
    if (!dragging) {
      setDragAnchor(null);
      setDragHover(null);
      return;
    }
    setDragging(false);
    if (draggedRange.length >= 2) {
      // 2일 이상 → 일괄 입력 다이얼로그
      onBulkPick(draggedRange);
    } else if (draggedRange.length === 1) {
      // 1일만 → 단일 입력 다이얼로그
      const r = row.daily[draggedRange[0]];
      onPick(draggedRange[0], r?.gongsu ?? 1.0);
    }
    setDragAnchor(null);
    setDragHover(null);
  }

  return (
    <div className="att-cal">
      <header className="att-col__head att-cal__head">
        <div>
          <h3>
            {row.memberName} <small>({row.role})</small>
          </h3>
          <p>
            총 <strong>{row.totalGongsu.toFixed(1)}</strong> 공수 ·{' '}
            <strong>{row.totalDays}</strong>일
            {/* 임금은 출퇴근 현황 화면에서 노출하지 않음 — 원·하도급 간 공유 금지 정책 */}
          </p>
        </div>
        <div className="att-cal__ym">
          <YearMonthPicker value={yearMonth} onChange={onYearMonthChange} />
        </div>
      </header>

      <div
        className="att-cal__grid"
        onMouseLeave={() => {
          // 그리드 밖으로 마우스가 나가면 드래그 취소
          if (dragging) {
            setDragging(false);
            setDragAnchor(null);
            setDragHover(null);
          }
        }}
        onMouseUp={commitDrag}
      >
        {dows.map((d, i) => (
          <div
            key={d}
            className={
              'att-cal__dow' +
              (i === 0 ? ' is-sun' : '') +
              (i === 6 ? ' is-sat' : '')
            }
          >
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c.date || !c.day) {
            return <div key={i} className="att-cal__cell att-cal__cell--blank" />;
          }
          const r = row.daily[c.date];
          const holiday = getHoliday(c.date);
          const sun = isSunday(c.date);
          const sat = isSaturday(c.date);
          const isFuture = c.date > todayStr;
          const isToday = c.date === todayStr;
          const cls = cellClass(r);
          const inDrag = draggedRange.includes(c.date);
          return (
            <button
              key={i}
              type="button"
              className={
                'att-cal__cell' +
                (sun || holiday ? ' is-holi' : '') +
                (sat && !holiday ? ' is-sat' : '') +
                (isToday ? ' is-today' : '') +
                (isFuture ? ' is-future' : '') +
                (r ? ' has-record' : '') +
                (inDrag ? ' is-drag' : '') +
                (cls ? ' ' + cls : '')
              }
              onMouseDown={(e) => {
                if (isFuture) return;
                e.preventDefault();
                setDragAnchor(c.date!);
                setDragHover(c.date!);
                setDragging(true);
              }}
              onMouseEnter={() => {
                if (!dragging || isFuture) return;
                setDragHover(c.date!);
              }}
              onClick={(e) => {
                // 드래그가 아니라 단일 클릭이면 즉시 입력
                if (dragging) return;
                if (isFuture) return;
                e.preventDefault();
                onPick(c.date!, r?.gongsu ?? 1.0);
              }}
              disabled={isFuture}
              title={
                isFuture
                  ? '미래 일자는 입력할 수 없습니다'
                  : holiday
                    ? `${holiday.name}${r ? ' · 공수 ' + formatGongsu(r.gongsu) : ' · 휴일 근무 시 클릭'}`
                    : r
                      ? `${c.date} · 공수 ${formatGongsu(r.gongsu)}`
                      : `${c.date} · 클릭(단일) / 드래그(여러 일자) 로 입력`
              }
            >
              <span className="att-cal__day">{c.day}</span>
              {holiday && (
                <span className="att-cal__holi">{shortHolidayLabel(c.date)}</span>
              )}
              <span className="att-cal__val">
                {r ? (
                  r.status === 'ABSENT' ? (
                    ''
                  ) : (
                    <>
                      <strong className="att-cal__val-num">{formatGongsu(r.gongsu)}</strong>
                      {r.checkInMethod === 'MANUAL' || r.checkOutMethod === 'MANUAL' ? (
                        <em className="att-cal__val-method att-cal__val-method--manual">수동</em>
                      ) : (
                        <em className="att-cal__val-method">얼굴</em>
                      )}
                    </>
                  )
                ) : isFuture ? (
                  ''
                ) : (
                  '+'
                )}
              </span>
            </button>
          );
        })}
      </div>

    </div>
  );
}


/* ───────── 우측 사이드: 감사 로그 ───────── */

/** AuditLogPanel — 부모 aside.att__col 가 카드 역할이라 내부엔 .att-audit (no card) 만 둠 */
function AuditLogPanel({ audit }: { audit: AuditLogEntry[] }) {
  function shortType(t: string): string {
    if (t === 'MANUAL_CHECK_IN') return '출근';
    if (t === 'MANUAL_CHECK_OUT') return '퇴근';
    if (t === 'BULK_CHECK_OUT') return '일괄퇴근';
    if (t === 'MANUAL_GONGSU') return '공수입력';
    return '기타';
  }
  function typeCls(t: string): string {
    if (t === 'BULK_CHECK_OUT') return 'bulk';
    if (t === 'MANUAL_GONGSU') return 'gongsu';
    return 'manual';
  }
  return (
    <div className="att-audit">
      <h3 className="att-audit__title">감사 로그</h3>
      {audit.length === 0 ? (
        <p className="att-audit__empty">최근 처리 기록이 없습니다.</p>
      ) : (
        <ul className="att-audit__list">
          {audit.map((a) => {
            const names = a.memberNames.join(', ') + (a.memberNames.length > 1 ? ` 외 ${a.memberNames.length - 1}명` : '');
            return (
              <li key={a.id} className="att-audit__item">
                <div className="att-audit__top">
                  <strong className="att-audit__name">
                    {a.memberNames[0] ?? '-'}
                    {a.memberNames.length > 1 && (
                      <em className="att-audit__cnt"> · {a.memberNames.length}명</em>
                    )}
                  </strong>
                  <span className={`att-audit__type att-audit__type--${typeCls(a.type)}`}>
                    {shortType(a.type)}
                  </span>
                </div>
                <p className="att-audit__bottom">
                  <span className="att-audit__by">{a.performedBy}</span>
                  <span className="att-audit__time">
                    {new Date(a.performedAt).toLocaleString('ko-KR', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </p>
                {a.reason && <p className="att-audit__reason" title={names}>{a.reason}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ───────── 일괄 퇴근 다이얼로그 ───────── */

function BulkCheckOutDialog({
  open,
  today,
  onClose,
  onDone,
}: {
  open: boolean;
  today: TodayAttendance;
  onClose: () => void;
  onDone: () => void;
}) {
  const working = today.members.filter((m) => m.status === 'WORKING');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(working.map((m) => m.memberId)),
  );
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((s) => {
      const ns = new Set(s);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });
  }

  async function handleSubmit() {
    setErr(null);
    if (selected.size === 0) {
      setErr('1명 이상 선택해주세요.');
      return;
    }
    if (reason.trim().length < 5) {
      setErr('사유는 5자 이상 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      await attendanceApi.bulkCheckOut({
        memberIds: Array.from(selected),
        reason: reason.trim(),
      });
      onDone();
    } catch (error) {
      setErr(getErrorMessage(error, '처리 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="일괄 퇴근 처리"
      subtitle={`현재 근무 중 ${working.length}명. 선택한 인원을 일괄 퇴근으로 처리합니다.`}
      width={560}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="att__btn att__btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '처리 중…' : `${selected.size}명 일괄 퇴근`}
          </button>
        </>
      }
    >
      <div className="att-bulk">
        <ul className="att-bulk__list">
          {working.map((m) => (
            <li key={m.memberId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(m.memberId)}
                  onChange={() => toggle(m.memberId)}
                />
                <span className="att-bulk__name">{m.memberName}</span>
                <span className="att-bulk__role">{m.role}</span>
                <span className="att-bulk__in">
                  출근 {isoToHHMM(m.record?.checkInAt)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <label className="att-bulk__reason-label">사유 (5자 이상)</label>
        <textarea
          className="att-bulk__reason"
          rows={3}
          placeholder="예) 현장 종료로 일괄 퇴근 처리"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {err && <p className="att__form-err">{err}</p>}
      </div>
    </Modal>
  );
}

/* ───────── 강제 처리 다이얼로그 (CHECK_IN / CHECK_OUT) ───────── */

function ManualCheckDialog({
  open,
  memberId,
  memberName,
  onClose,
  onDone,
}: {
  open: boolean;
  memberId: string;
  memberName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<'CHECK_IN' | 'CHECK_OUT'>('CHECK_IN');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit() {
    setErr(null);
    if (reason.trim().length < 5) {
      setErr('사유는 5자 이상 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      await attendanceApi.manualCheck({ memberId, action, reason: reason.trim() });
      onDone();
    } catch (error) {
      setErr(getErrorMessage(error, '처리 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="출/퇴근 강제 처리"
      subtitle={`${memberName} 님의 출/퇴근을 직접 처리합니다.`}
      width={460}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="att__btn att__btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '처리 중…' : '처리'}
          </button>
        </>
      }
    >
      <div className="att-manual">
        <div className="att-manual__seg">
          <button
            type="button"
            className={`att-manual__seg-btn ${action === 'CHECK_IN' ? 'is-active' : ''}`}
            onClick={() => setAction('CHECK_IN')}
          >
            출근
          </button>
          <button
            type="button"
            className={`att-manual__seg-btn ${action === 'CHECK_OUT' ? 'is-active' : ''}`}
            onClick={() => setAction('CHECK_OUT')}
          >
            퇴근
          </button>
        </div>

        <label className="att-bulk__reason-label">사유 (5자 이상)</label>
        <textarea
          className="att-bulk__reason"
          rows={4}
          placeholder="예) 카메라 오작동으로 직접 처리"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="att-manual__note">
          처리 시 오늘 날짜 · 현재 시각으로 기록되고 감사 로그에 남습니다.
        </p>
        {err && <p className="att__form-err">{err}</p>}
      </div>
    </Modal>
  );
}

/* ───────── 공수 직접 입력 다이얼로그 ───────── */

const GONGSU_OPTIONS = [
  { value: 0, label: '0',   sub: '공수 제외' },
  { value: 0.5, label: '0.5', sub: '반공수' },
  { value: 1, label: '1.0', sub: '기본공수' },
  { value: 1.5, label: '1.5', sub: '연장공수' },
  { value: 2, label: '2.0', sub: '특근' },
];

/** 수동 공수 처리 사유 빠른 선택 */
const REASON_PRESETS = [
  '카메라/통신 오류',
  '얼굴인식 실패',
  '임시 투입자',
  '외부업무',
  '반장 확인',
];
const REASON_ETC = '기타';

/* ───────── 기록 상세 패널 (다이얼로그 상단에 표시) ───────── */

function RecordDetailPanel({ record: r, siteName }: { record: AttendanceRecord; siteName?: string }) {
  const inMethod = methodLabel(r.checkInMethod, r.checkInScore);
  const outMethod = checkOutMethodLabel(r);
  const statusInfo = statusBadge(r);
  return (
    <div className="rec-detail">
      {/* 헤더 — 2단:
          1단: 현장명 (긴 이름도 줄바꿈 가능)
          2단: 날짜(좌) + 상태 칩(우) */}
      <div className="rec-detail__head2">
        {siteName && (
          <div className="rec-detail__head2-row">
            <span className="rec-detail__site">📍 {siteName}</span>
          </div>
        )}
        <div className="rec-detail__head2-row rec-detail__head2-row--bottom">
          <span className="rec-detail__date">{r.date}</span>
          {statusInfo.label && (
            <span className={'rec-detail__chip rec-detail__chip--' + statusInfo.kind}>
              {statusInfo.label}
            </span>
          )}
        </div>
      </div>
      {/* 2행: 출근 / 퇴근 / 근로시간 — 3분할 깔끔하게 */}
      <div className="rec-detail__times">
        <div className="rec-detail__time">
          <p className="rec-detail__time-label">출근</p>
          <p className="rec-detail__time-value">
            {isoToHHMM(r.checkInAt) || '—'}
          </p>
          {inMethod && <p className="rec-detail__time-method">{inMethod}</p>}
        </div>
        <div className="rec-detail__time">
          <p className="rec-detail__time-label">퇴근</p>
          <p className="rec-detail__time-value">
            {isoToHHMM(r.checkOutAt) || '—'}
          </p>
          {outMethod && <p className="rec-detail__time-method">{outMethod}</p>}
        </div>
        <div className="rec-detail__time">
          <p className="rec-detail__time-label">근로시간</p>
          <p className="rec-detail__time-value">
            {r.workedMinutes
              ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m`
              : '—'}
          </p>
          <p className="rec-detail__time-method">
            현재 공수 <strong>{r.gongsu.toFixed(1)}</strong>
          </p>
        </div>
      </div>
      {r.manualReason && (() => {
        const history = r.manualPayHistory ?? [];
        // 변동 체인 — 이력 있으면 모든 단계 펼침 (첫·중간·끝 모두 보존)
        let chain: Array<{ pay: number; gongsu: number; ord?: number }>;
        if (history.length > 0) {
          chain = [
            { pay: history[0].fromPay, gongsu: history[0].fromGongsu, ord: 0 },
            ...history.map((h, i) => ({ pay: h.toPay, gongsu: h.toGongsu, ord: i + 1 })),
          ];
        } else {
          // 이력 없음 — 추정값(1.0 → 현재)
          chain = [
            { pay: r.dailyWage * 1.0, gongsu: 1.0 },
            { pay: r.payAmount, gongsu: r.gongsu },
          ];
        }
        // 이력이 있으면 무조건 표시 (시작·끝 같아도 중간 변동 노출)
        const showChain = history.length > 0
          || (chain.length >= 2 && chain[0].pay !== chain[chain.length - 1].pay);
        return (
          <div className="rec-detail__reason">
            <p className="rec-detail__reason-title">
              <strong>강제 처리 / 수동 입력 사유</strong>
              <span className="rec-detail__reason-inline">({r.manualReason})</span>
            </p>
            {showChain && (
              <p className="rec-detail__reason-pay">
                <em>임금 변동 이력</em>
                {chain.map((c, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span className="rec-detail__reason-pay-arrow">→</span>}
                    <span
                      className={
                        i === 0
                          ? 'rec-detail__reason-pay-from'
                          : i === chain.length - 1
                            ? 'rec-detail__reason-pay-to'
                            : 'rec-detail__reason-pay-mid'
                      }
                      title={c.ord !== undefined ? (c.ord === 0 ? '최초 자동 산정' : `${c.ord}차 보정`) : undefined}
                    >
                      {c.ord !== undefined && c.ord > 0 && (
                        <span className="rec-detail__reason-pay-tag">{c.ord}차</span>
                      )}
                      {Math.round(c.pay).toLocaleString()}원
                    </span>
                  </Fragment>
                ))}
              </p>
            )}
            {history.length >= 1 && (
              <p className="rec-detail__reason-history-meta">
                총 {history.length}회 보정됨
                {history[history.length - 1].fromGongsu === history[history.length - 1].toGongsu
                  ? ''
                  : history[0].fromGongsu === history[history.length - 1].toGongsu
                    ? ' · 최초값으로 복원'
                    : ''}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function methodLabel(
  m: AttendanceRecord['checkInMethod'],
  score: number | null,
): string {
  if (!m) return '';
  if (m === 'FACE') {
    return score != null
      ? `인식률 ${Math.round(score * 100)}%`
      : '얼굴인식';
  }
  return '관리자 수동보정';
}

/** 퇴근용 라벨 — 시각이 18시 이후이고 method 가 EXCEPTION 이거나 점수 null 이면 「자동퇴근」 */
function checkOutMethodLabel(r: AttendanceRecord): string {
  if (!r.checkOutMethod) return '';
  if (r.checkOutMethod === 'FACE') {
    return r.checkOutScore != null
      ? `인식률 ${Math.round(r.checkOutScore * 100)}%`
      : '얼굴인식';
  }
  // MANUAL — 18시 이후 자동 처리(EXCEPTION) 인지 시각으로 추정
  if (r.checkOutAt) {
    const hh = new Date(r.checkOutAt).getHours();
    if (hh >= 18 && r.checkOutScore == null) return '자동퇴근';
  }
  return '관리자 수동보정';
}

function statusBadge(r: AttendanceRecord): { kind: string; label: string } {
  if (r.status === 'ABSENT') return { kind: 'absent', label: '' };
  if (r.checkInMethod === 'MANUAL' || r.checkOutMethod === 'MANUAL') {
    return { kind: 'manual', label: '수동 처리' };
  }
  if (r.status === 'LATE') return { kind: 'late', label: '지각' };
  if (r.status === 'EARLY') return { kind: 'early', label: '조퇴' };
  if (!r.checkOutAt) return { kind: 'working', label: '근무 중' };
  return { kind: 'ok', label: '정상' };
}

function SetGongsuDialog({
  open,
  memberId,
  memberName,
  role,
  date,
  siteName,
  dailyWage,
  initial,
  record,
  onClose,
  onDone,
}: {
  open: boolean;
  memberId: string;
  memberName: string;
  role: string;
  date: string;
  /** 현장명 — 「전체 현장」 모드에서 어느 현장인지 명확히 표시 */
  siteName?: string;
  dailyWage: number;
  initial: number;
  /** 그 날짜에 이미 있는 기록 (없으면 null) */
  record: AttendanceRecord | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [gongsu, setGongsu] = useState<number>(initial);
  /** 선택된 프리셋 사유. null = 미선택, 'ETC' = 기타(직접 입력) */
  const [reasonPick, setReasonPick] = useState<string | null>(REASON_PRESETS[0]);
  const [reasonEtc, setReasonEtc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const expectedPay = Math.round(dailyWage * gongsu);
  const finalReason =
    reasonPick === REASON_ETC ? reasonEtc.trim() : (reasonPick ?? '').trim();

  async function handleSubmit() {
    setErr(null);
    if (!finalReason) {
      setErr('사유를 선택해주세요. (기타 선택 시 직접 입력)');
      return;
    }
    setSubmitting(true);
    try {
      await attendanceApi.setGongsu({
        memberId,
        date,
        gongsu,
        reason: finalReason,
      });
      onDone();
    } catch (error) {
      setErr(getErrorMessage(error, '공수 입력 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  // 권한별 버튼 라벨 — 반장(SITE) → 「승인 요청」, 본사(HQ) → 「공수 반영」
  const isHqUser = (typeof window !== 'undefined')
    && (window as { __viewMode?: string }).__viewMode === 'HQ';
  // 우선 권한 판별을 props 가 아니라 localStorage 의 user 정보로 시도 (여기선 viewMode 가 props 로 안 들어옴)
  // 단순화: ROLE = OWNER/MANAGER 면 본사, FOREMAN 면 반장
  let userRole: string | undefined;
  try {
    const u = JSON.parse(localStorage.getItem('ilgampack_admin:user') ?? 'null');
    userRole = u?.role;
  } catch { /* ignore */ }
  const isForeman = userRole === 'FOREMAN';
  const submitBtnLabel = isForeman
    ? `${gongsu.toFixed(1)}공수 승인 요청`
    : `${gongsu.toFixed(1)}공수 반영`;

  // 기존 공수·임금 → 변경 후 비교
  const prevGongsu = record?.gongsu ?? 0;
  const prevPay = Math.round(dailyWage * prevGongsu);
  const diffPay = expectedPay - prevPay;
  void isHqUser;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${memberName} (${role})`}
      subtitle="수동 공수 처리"
      width={560}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="att__btn att__btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '저장 중…' : submitBtnLabel}
          </button>
        </>
      }
    >
      <div className="att-gongsu">
        {/* ② 대상 기록 — 헤더(현장명/일자/처리방식) + 출퇴근/근로시간/현재 공수 */}
        <section className="att-gongsu__section">
          <h4 className="att-gongsu__sec-title">대상 기록</h4>
          {record ? (
            <RecordDetailPanel record={record} siteName={siteName} />
          ) : (
            <div className="att-gongsu__head att-gongsu__head--empty">
              {siteName && (
                <p className="att-gongsu__hint-site">📍 {siteName} · {date}</p>
              )}
              <p className="att-gongsu__hint">
                이 일자에 출·퇴근 기록이 없습니다. 임시 투입·외부업무 등의 사유로
                수동 공수를 입력할 수 있습니다.
              </p>
            </div>
          )}
        </section>

        {/* ③ 공수 선택 */}
        <section className="att-gongsu__section">
          <h4 className="att-gongsu__sec-title">공수 선택</h4>
          <div className="att-gongsu__opts">
            {GONGSU_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`att-gongsu__opt ${gongsu === o.value ? 'is-active' : ''}`}
                onClick={() => setGongsu(o.value)}
              >
                <span className="att-gongsu__opt-val">{o.label}</span>
                <span className="att-gongsu__opt-sub">{o.sub}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ④ 반영 결과 — 기존 / 변경 / 차액 */}
        <section className="att-gongsu__section">
          <h4 className="att-gongsu__sec-title">반영 결과</h4>
          <table className="att-gongsu__compare">
            <thead>
              <tr>
                <th></th>
                <th>공수</th>
                <th>임금</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>기존</td>
                <td>{prevGongsu.toFixed(1)}</td>
                <td>{krw(prevPay)}</td>
              </tr>
              <tr className="is-new">
                <td>변경</td>
                <td><strong>{gongsu.toFixed(1)}</strong></td>
                <td><strong>{krw(expectedPay)}</strong></td>
              </tr>
              <tr className={'is-diff' + (diffPay > 0 ? ' is-up' : diffPay < 0 ? ' is-down' : '')}>
                <td>차액</td>
                <td>{(gongsu - prevGongsu).toFixed(1)}</td>
                <td>{(diffPay >= 0 ? '+' : '') + krw(diffPay)}</td>
              </tr>
            </tbody>
          </table>
          <p className="att-gongsu__compare-meta">일당 {krw(dailyWage)} 기준</p>
        </section>

        {/* ⑤ 사유 — 6종 프리셋 + 기타 */}
        <section className="att-gongsu__section">
          <h4 className="att-gongsu__sec-title">사유 (감사 기록)</h4>
          <div className="att-gongsu__reasons">
            {REASON_PRESETS.map((r, i) => (
              <button
                key={r}
                type="button"
                className={'att-gongsu__reason' + (reasonPick === r ? ' is-active' : '')}
                onClick={() => setReasonPick(r)}
              >
                <span className="att-gongsu__reason-num">{i + 1}</span>
                {r}
              </button>
            ))}
            <button
              type="button"
              className={'att-gongsu__reason' + (reasonPick === REASON_ETC ? ' is-active' : '')}
              onClick={() => setReasonPick(REASON_ETC)}
            >
              <span className="att-gongsu__reason-num">{REASON_PRESETS.length + 1}</span>
              {REASON_ETC}
            </button>
          </div>
          {reasonPick === REASON_ETC && (
            <textarea
              className="att-bulk__reason"
              rows={2}
              placeholder="기타 사유를 직접 입력해주세요 (필수)"
              value={reasonEtc}
              onChange={(e) => setReasonEtc(e.target.value)}
              autoFocus
            />
          )}
        </section>

        {err && <p className="att__form-err">{err}</p>}
      </div>
    </Modal>
  );
}

/* ───────── 일괄 공수 입력 다이얼로그 (드래그 다중 일자) ───────── */

function BulkGongsuDialog({
  open,
  memberId,
  memberName,
  role,
  dates,
  dailyWage,
  onClose,
  onDone,
}: {
  open: boolean;
  memberId: string;
  memberName: string;
  role: string;
  dates: string[];
  dailyWage: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [gongsu, setGongsu] = useState<number>(1.0);
  const [reasonPick, setReasonPick] = useState<string | null>(REASON_PRESETS[0]);
  const [reasonEtc, setReasonEtc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const expectedPay = Math.round(dailyWage * gongsu) * dates.length;
  const finalReason =
    reasonPick === REASON_ETC ? reasonEtc.trim() : (reasonPick ?? '').trim();

  async function handleSubmit() {
    setErr(null);
    if (!finalReason) {
      setErr('사유를 선택해주세요. (기타 선택 시 직접 입력)');
      return;
    }
    setSubmitting(true);
    try {
      await attendanceApi.bulkSetGongsu({
        memberId,
        dates,
        gongsu,
        reason: finalReason,
      });
      onDone();
    } catch (error) {
      setErr(getErrorMessage(error, '일괄 공수 입력 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  // 표시용 — 시작/끝 일자
  const sorted = [...dates].sort();
  const rangeLabel =
    dates.length <= 1
      ? sorted[0] ?? ''
      : `${sorted[0]} ~ ${sorted[sorted.length - 1]} (${dates.length}일)`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="일괄 공수 입력"
      subtitle={`${memberName} (${role}) · ${rangeLabel}`}
      width={560}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose} disabled={submitting}>
            취소
          </button>
          <button
            type="button"
            className="att__btn att__btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '저장 중…' : `${dates.length}일 × 공수 ${gongsu.toFixed(1)} 저장`}
          </button>
        </>
      }
    >
      <div className="att-gongsu">
        <div className="att-gongsu__head">
          <p className="att-gongsu__hint">
            드래그로 선택한 <strong>{dates.length}일</strong>에 같은 공수를 한 번에 적용합니다.
            드래그로 선택한 <strong>{dates.length}일</strong>에 같은 공수를 한 번에 적용합니다.
            기존 기록이 있는 일자는 덮어씁니다.
          </p>
        </div>

        <div className="att-gongsu__opts">
          {GONGSU_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`att-gongsu__opt ${gongsu === o.value ? 'is-active' : ''}`}
              onClick={() => setGongsu(o.value)}
            >
              <span className="att-gongsu__opt-val">{o.label}</span>
              <span className="att-gongsu__opt-sub">{o.sub}</span>
            </button>
          ))}
        </div>

        <dl className="att-gongsu__sum">
          <div>
            <dt>일당</dt>
            <dd>{krw(dailyWage)}</dd>
          </div>
          <div>
            <dt>선택 공수</dt>
            <dd>{gongsu.toFixed(1)} × {dates.length}일</dd>
          </div>
          <div>
            <dt>예상 합계 임금</dt>
            <dd className="is-strong">{krw(expectedPay)}</dd>
          </div>
        </dl>

        <label className="att-bulk__reason-label">사유 (감사 기록)</label>
        <div className="att-gongsu__reasons">
          {REASON_PRESETS.map((r, i) => (
            <button
              key={r}
              type="button"
              className={
                'att-gongsu__reason' + (reasonPick === r ? ' is-active' : '')
              }
              onClick={() => setReasonPick(r)}
            >
              <span className="att-gongsu__reason-num">{i + 1}</span>
              {r}
            </button>
          ))}
          <button
            type="button"
            className={
              'att-gongsu__reason' +
              (reasonPick === REASON_ETC ? ' is-active' : '')
            }
            onClick={() => setReasonPick(REASON_ETC)}
          >
            <span className="att-gongsu__reason-num">4</span>
            {REASON_ETC}
          </button>
        </div>
        {reasonPick === REASON_ETC && (
          <textarea
            className="att-bulk__reason"
            rows={2}
            placeholder="사유를 직접 입력해주세요"
            value={reasonEtc}
            onChange={(e) => setReasonEtc(e.target.value)}
            autoFocus
          />
        )}

        {err && <p className="att__form-err">{err}</p>}
      </div>
    </Modal>
  );
}

/* ───────── 공용 ───────── */

function KCard({
  label,
  value,
  sub,
  color,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  strong?: boolean;
}) {
  return (
    <div className={`att-kcard card ${strong ? 'is-strong' : ''}`}>
      <div className="att-kcard__main">
        <p className="att-kcard__label">{label}</p>
        <p className="att-kcard__value" style={color ? { color } : undefined}>
          {value}
        </p>
      </div>
      {sub && <p className="att-kcard__sub">{sub}</p>}
    </div>
  );
}


function krw(n: number) {
  return n.toLocaleString() + '원';
}

/* ───────── 출역확인 요청 모달 ───────── */

interface SubVerifyRequestModalState {
  siteCompanyId: string;
  companyName: string;
  siteName: string;
  memberCount: number;
  todayTotal: number;
  todayWorking: number;
  message: string;
  channels: SubVerifyChannel[];
  sending: boolean;
}

function SubVerifyRequestModal({
  state,
  date,
  siteId,
  senderName,
  onChange,
  onClose,
  onSent,
}: {
  state: SubVerifyRequestModalState;
  date: string;
  siteId: string;
  senderName: string;
  onChange: (patch: Partial<SubVerifyRequestModalState>) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const lastReq = findLastRequest(date, state.siteCompanyId);
  const history = loadSubVerifyRequests().filter(
    (r) => r.siteCompanyId === state.siteCompanyId && r.date === date,
  );

  const channels = state.channels;
  const toggleChannel = (c: SubVerifyChannel) => {
    const has = channels.includes(c);
    onChange({
      channels: has ? channels.filter((x) => x !== c) : [...channels, c],
    });
  };

  const canSend = !state.sending && channels.length > 0 && state.message.trim().length >= 5;

  const send = () => {
    onChange({ sending: true });
    setTimeout(() => {
      const rec: SubVerifyRequestRecord = {
        date,
        siteId,
        siteName: state.siteName,
        siteCompanyId: state.siteCompanyId,
        companyName: state.companyName,
        channels: channels.slice(),
        message: state.message,
        sentAt: new Date().toISOString(),
        sentByName: senderName,
      };
      saveSubVerifyRequest(rec);
      onSent();
    }, 350);
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="출역확인 요청"
      subtitle={`${state.companyName} · ${date.replaceAll('-', '.')}`}
      width={580}
      footer={
        <div className="att__req-modal-foot">
          <button
            type="button"
            className="att__req-btn att__req-btn--ghost"
            onClick={onClose}
            disabled={state.sending}
          >
            취소
          </button>
          <button
            type="button"
            className="att__req-btn att__req-btn--primary"
            onClick={send}
            disabled={!canSend}
          >
            {state.sending
              ? '발송 중…'
              : lastReq
                ? `🔁 재요청 발송 (${channels.length})`
                : `✉️ 발송 (${channels.length})`}
          </button>
        </div>
      }
    >
      <div className="att__req-modal-body">
        {/* 수신자 요약 */}
        <div className="att__req-recipient">
          <div className="att__req-recipient-row">
            <span className="att__req-label">현장</span>
            <strong>{state.siteName}</strong>
          </div>
          <div className="att__req-recipient-row">
            <span className="att__req-label">수신 하도급</span>
            <strong>{state.companyName}</strong>
          </div>
          <div className="att__req-recipient-row">
            <span className="att__req-label">출력 인원</span>
            <span>
              등록 <strong>{state.memberCount}</strong>명
              {' · '}
              오늘 출근 <strong>{state.todayTotal}</strong>명
              {state.todayTotal > 0 && (
                <span className="att__req-meta-em">
                  {' '}(근무 중 {state.todayWorking}명)
                </span>
              )}
            </span>
          </div>
        </div>

        {/* 발송 채널 */}
        <div className="att__req-section">
          <div className="att__req-section-h">📬 발송 채널</div>
          <div className="att__req-channels">
            {(['APP', 'SMS', 'EMAIL'] as SubVerifyChannel[]).map((c) => {
              const on = channels.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  className={'att__req-channel' + (on ? ' is-on' : '')}
                  onClick={() => toggleChannel(c)}
                >
                  {on ? '✓ ' : ''}
                  {CHANNEL_LABEL[c]}
                </button>
              );
            })}
          </div>
          <p className="att__req-hint">
            앱 푸시는 보다패스 앱 사용자에게, SMS·이메일은 등록된 담당자 연락처로 발송됩니다.
          </p>
        </div>

        {/* 메시지 미리보기·편집 */}
        <div className="att__req-section">
          <div className="att__req-section-h">
            📝 메시지 내용
            <button
              type="button"
              className="att__req-reset"
              onClick={() =>
                onChange({
                  message: buildDefaultMessage({
                    siteName: state.siteName,
                    companyName: state.companyName,
                    date,
                    memberCount: state.memberCount,
                    todayTotal: state.todayTotal,
                    todayWorking: state.todayWorking,
                    senderName,
                  }),
                })
              }
              title="기본 문구로 되돌리기"
            >
              ↺ 초기화
            </button>
          </div>
          <textarea
            className="att__req-textarea"
            value={state.message}
            onChange={(e) => onChange({ message: e.target.value })}
            rows={9}
            placeholder="하도급사에 보낼 메시지를 입력하세요"
          />
          <p className="att__req-hint">
            글자 수 {state.message.length}자 · 하도급 담당자에게 전달됩니다.
          </p>
        </div>

        {/* 이전 발송 이력 */}
        {history.length > 0 && (
          <details className="att__req-history">
            <summary>📨 오늘 발송 이력 ({history.length}건)</summary>
            <ul>
              {history.slice().reverse().map((h, i) => (
                <li key={i}>
                  <span className="att__req-history-time">
                    {h.sentAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  <span className="att__req-history-ch">
                    {h.channels.map((c) => CHANNEL_LABEL[c]).join('·')}
                  </span>
                  <span className="att__req-history-by">{h.sentByName}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

/* ───────── 엑셀 업로드 모달 — 양식 다운로드 + 입력양식/노임대장 업로드 ───────── */

type UploadFormat = 'INPUT' | 'LEDGER';

function ExcelUploadModal({
  site,
  siteId,
  siteName,
  yearMonth,
  members,
  companyName,
  onClose,
  onDone,
}: {
  site: Site | null;
  siteId: string;
  siteName: string;
  yearMonth: string;
  members: TeamMember[];
  companyName?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [format, setFormat] = useState<UploadFormat>('INPUT');
  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);

  async function handleDownloadTemplate() {
    if (!site) {
      window.alert('현장 정보를 불러올 수 없습니다.');
      return;
    }
    setDownloadBusy(true);
    try {
      await downloadAttendanceTemplateXlsx({
        site, members, yearMonth, companyName,
      });
    } catch (err) {
      window.alert('양식 생성 실패: ' + (err instanceof Error ? err.message : '알 수 없는 오류'));
    } finally {
      setDownloadBusy(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResultMsg(null);
    setErrorMsg(null);
    try {
      if (format === 'LEDGER') {
        // 노임대장 양식 — 기존 parser 재활용
        const doc = await parseLedgerFile(file);
        appendToArchive(doc);
        setResultMsg(
          `[${file.name}] 업로드 성공 (노임대장)\n· 기간 ${doc.yearMonth}\n· 현장 ${doc.siteName}\n· 인원 ${doc.rows.length}명`,
        );
      } else {
        // 입력 양식 — 향후 정의 (현재는 양식 정의 미완료)
        setErrorMsg(
          '출역 입력 양식 파서는 아직 구현 전입니다.\n\n현재 단계에선 노임대장 양식만 처리 가능합니다.\n사내 출역 입력 양식이 정의되면 본 파서를 연결합니다.',
        );
      }
    } catch (err) {
      setErrorMsg(
        `업로드 실패: ${format === 'LEDGER' ? '노임대장' : '입력'} 양식이 아닐 수 있습니다.\n` +
        (err instanceof Error ? err.message : ''),
      );
    } finally {
      setBusy(false);
      if (e.target) e.target.value = '';
    }
  }

  const formats: Array<{
    id: UploadFormat;
    icon: string;
    title: string;
    desc: string;
    badge?: string;
  }> = [
    {
      id: 'INPUT',
      icon: '',
      title: '출역 입력 양식 (사내)',
      desc: '우리 시스템에서 다운로드한 출역 일괄 입력 엑셀 양식. 일자별 공수·출퇴근 시각이 그대로 적재됩니다.',
      badge: '권장',
    },
    {
      id: 'LEDGER',
      icon: '',
      title: '노임대장 양식',
      desc: '기존에 작성하신 일용노무비지급명세서(.xlsx). 인원·일당·공수 정보를 자동 추출합니다.',
    },
  ];

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="엑셀 업로드"
      subtitle={(siteName ? siteName + ' · ' : '') + yearMonth}
      width={640}
      footer={
        <div className="att-excel__foot">
          <button type="button" className="att__btn att__btn--ghost"
            onClick={onClose} disabled={busy}>닫기</button>
          {format === 'INPUT' && (
            <button
              type="button"
              className="att__btn"
              onClick={handleDownloadTemplate}
              disabled={downloadBusy || !site}
              title={!site ? '현장 정보 로딩 중' : '엑셀 양식 다운로드'}
            >
              {downloadBusy ? '생성 중…' : '양식 다운로드'}
            </button>
          )}
        </div>
      }
    >
      <div className="att-excel">
        {/* 양식 선택 — 두 개의 라디오 카드를 별도 라인으로 정돈 */}
        <h4 className="att-excel__sec-title">양식 선택</h4>
        <div className="att-excel__formats">
          {formats.map((f) => (
            <label
              key={f.id}
              className={'att-excel__format' + (format === f.id ? ' is-selected' : '')}
            >
              <input
                type="radio"
                name="excel-format"
                value={f.id}
                checked={format === f.id}
                onChange={() => setFormat(f.id)}
              />
              <span className="att-excel__format-body">
                <span className="att-excel__format-title">
                  {f.title}
                  {f.badge && <span className="att-excel__format-badge">{f.badge}</span>}
                </span>
                <span className="att-excel__format-desc">{f.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {/* 파일 업로드 영역 */}
        <h4 className="att-excel__sec-title">파일 업로드</h4>
        <label
          className={'att-excel__drop' + (busy ? ' is-busy' : '')}
          htmlFor="att-excel-file-input"
        >
          <input
            id="att-excel-file-input"
            type="file"
            accept=".xlsx,.xls"
            disabled={busy}
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          <span className="att-excel__drop-text">
            {busy ? '업로드 중…' : '엑셀 파일을 선택하세요'}
          </span>
          <span className="att-excel__drop-hint">.xlsx, .xls 파일 지원</span>
        </label>

        {resultMsg && (
          <div className="att-excel__result att-excel__result--ok">
            <pre>{resultMsg}</pre>
          </div>
        )}
        {errorMsg && (
          <div className="att-excel__result att-excel__result--err">
            <pre>{errorMsg}</pre>
          </div>
        )}

        <div className="att-excel__hint">
          <strong className="att-excel__hint-title">참고 사항</strong>
          <ul>
            <li>같은 일자·팀원에 기존 기록이 있으면 덮어쓰기 됩니다.</li>
            <li>실패한 행은 건너뛰며, 결과 메시지에 안내됩니다.</li>
            <li>월 마감된 일자는 업로드되지 않습니다.</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}


function WorkerPoolPanel({
  allMembers,
  currentSiteId,
  onReturnToPool,
  onAssignToSite,
  onOpenAdd,
  todayCheckedInIds,
  ownMemberIds,
  subMemberIds,
  splitEnabled,
}: {
  allMembers: TeamMember[];
  currentSiteId: string;
  onReturnToPool?: (memberId: string) => Promise<void> | void;
  onAssignToSite: (memberId: string) => Promise<void> | void;
  onOpenAdd: () => void;
  todayCheckedInIds?: Set<string>;
  ownMemberIds?: Set<string>;
  subMemberIds?: Set<string>;
  splitEnabled?: boolean;
}) {
  void ownMemberIds; void subMemberIds; void splitEnabled;
  const checkedSet = todayCheckedInIds ?? new Set<string>();
  const notCheckedIn = allMembers.filter((m) => !checkedSet.has(m.id));
  function handleDragStart(e: React.DragEvent, memberId: string) {
    e.dataTransfer.setData('text/plain', memberId);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div
      className="att-pool"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        (e.currentTarget as HTMLElement).classList.add('is-drop-target');
      }}
      onDragLeave={(e) => {
        (e.currentTarget as HTMLElement).classList.remove('is-drop-target');
      }}
      onDrop={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove('is-drop-target');
        const memberId = e.dataTransfer.getData('text/plain');
        if (!memberId || !onReturnToPool) return;
        onReturnToPool(memberId);
      }}
    >
      <header className="att-pool__head">
        <div className="att-pool__title-row">
          <h3 className="att-pool__title">출역 미등록 <strong>{notCheckedIn.length}</strong>명</h3>
          <button type="button" className="att-pool__add" onClick={onOpenAdd}>＋ 등록</button>
        </div>
        <p className="att-pool__sub-hint">출역 대기 인력 — 드래그해서 현장에 배정</p>
      </header>
      {notCheckedIn.length === 0 ? (
        <p className="att-pool__empty">전원 등록 완료 — 출역 대기 인력이 없습니다.</p>
      ) : (
        <ul className="att-pool__list">
          {notCheckedIn.map((m) => (
            <li
              key={m.id}
              className="att-pool__item"
              draggable={currentSiteId !== 'ALL'}
              onDragStart={(e) => handleDragStart(e, m.id)}
              title={currentSiteId === 'ALL' ? '현장 선택 후 드래그 배정 가능' : '드래그하여 현재 현장에 배정'}
            >
              <button
                type="button"
                className="att-pool__assign"
                onClick={() => onAssignToSite(m.id)}
                disabled={currentSiteId === 'ALL'}
              >←</button>
              <span className="att-pool__name-wrap">
                <strong className="att-pool__name">{m.name}</strong>
                <em className="att-pool__role">{m.role}</em>
              </span>
              <span className="att-pool__avatar">{m.name.slice(0, 1)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuickAddMemberDialog({
  open,
  siteId,
  siteName,
  onClose,
  onDone,
}: {
  open: boolean;
  siteId: string;
  siteName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  void siteId;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="신규 근로자 등록"
      subtitle={siteName + ' · 빠른 등록'}
      width={420}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose}>취소</button>
          <button type="button" className="att__btn att__btn--primary" onClick={onDone}>완료</button>
        </>
      }
    >
      <div className="att-quick-add">
        <p className="att-quick-add__hint">
          신분증·동의·계좌 등 정식 등록은 「팀원 관리」 화면에서 진행해주세요.
          시연 모드에선 빠른 등록 폼이 비활성화되어 있습니다.
        </p>
      </div>
    </Modal>
  );
}

function AuthReasonPicker({
  memberName,
  actionLabel,
  action,
  reasonRequired,
  onClose,
  onConfirm,
}: {
  memberName: string;
  actionLabel: string;
  action: 'approved' | 'rejected' | 'confirmed';
  reasonRequired: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const PRESETS_APPROVED = [
    '현장 확인 완료',
    '반장 확인 완료',
    '근로자 확인 완료',
    '사진·CCTV 확인 완료',
  ];
  const PRESETS_REJECTED = [
    '본인 확인 불가',
    '출근시간 불일치',
    '현장 외 위치',
    '중복 출근',
  ];
  const PRESETS_CONFIRMED = [
    '현장 확인 완료',
    '반장 확인 완료',
    '근로자 확인 완료',
    '추가 검토 완료',
  ];
  const presets = action === 'approved' ? PRESETS_APPROVED
                : action === 'rejected' ? PRESETS_REJECTED
                : PRESETS_CONFIRMED;

  // 첫 프리셋을 기본 선택 — reasonRequired 인 케이스(수동/얼굴실패)에서도 사용자가
  // 한 번만 클릭하면 즉시 승인 가능하도록. 다른 프리셋이나 「기타」 선택 시 갱신.
  const [picked, setPicked] = useState<string | null>(presets[0] ?? null);
  const [other, setOther] = useState<string>('');
  const isOther = picked === '__other__';
  const finalReason = isOther ? other.trim() : (picked ?? '');
  const canSubmit = !reasonRequired || finalReason.length > 0;

  const tone = action === 'rejected' ? 'danger' : 'ok';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${memberName} · ${actionLabel}`}
      subtitle={reasonRequired ? '사유를 선택하거나 직접 입력해주세요 (감사 로그에 기록됩니다)' : '사유 부가 (선택 안해도 바로 처리 가능)'}
      width={520}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose}>취소</button>
          <button
            type="button"
            className={'att__btn ' + (tone === 'danger' ? 'att__btn--danger' : 'att__btn--primary')}
            onClick={() => onConfirm(finalReason)}
            disabled={!canSubmit}
          >
            {actionLabel}
          </button>
        </>
      }
    >
      <div className="att-reason">
        <div className="att-reason__chips">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={'att-reason__chip' + (picked === p ? ' is-active' : '')}
              onClick={() => setPicked(p)}
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            className={'att-reason__chip att-reason__chip--other' + (isOther ? ' is-active' : '')}
            onClick={() => setPicked('__other__')}
          >
            기타 (직접 입력)
          </button>
        </div>
        {isOther && (
          <textarea
            className="att-reason__textarea"
            rows={3}
            placeholder="사유를 입력해주세요"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            autoFocus
          />
        )}
      </div>
    </Modal>
  );
}

/* ───────── (DEPRECATED) 출역 추가 다이얼로그 ─────────
 *  + 출역 추가 클릭 시 SetGongsuDialog (수동 공수 처리) 로 통일되어 더 이상 호출되지 않음.
 *  TypeScript unused-function 경고만 발생 — 향후 정리 가능.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AttendAddDialog_DEPRECATED({
  member,
  siteName,
  date,
  onClose,
  onDone,
}: {
  member: TeamMember;
  siteName: string;
  date: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [name] = useState(member.name);
  const [phone] = useState(member.phone);
  const [idNumber, setIdNumber] = useState<string>(member.idNumberRaw ?? member.idNumberMasked ?? '');
  const [role, setRole] = useState(member.role || '');
  const [dailyWage, setDailyWage] = useState<string>(String(member.dailyWage || 250000));
  const [gongsu, setGongsu] = useState<number>(1);
  const [insPension, setInsPension] = useState(!!member.insurance?.pension);
  const [insHealth, setInsHealth] = useState(!!member.insurance?.health);
  const [insEmployment, setInsEmployment] = useState(member.insurance?.employment !== false);
  const [insAccident, setInsAccident] = useState(member.insurance?.accident !== false);
  const [safetyEdu, setSafetyEdu] = useState(member.safetyEduCompleted === true);
  const [reason, setReason] = useState('임시 투입자');
  const [docs, setDocs] = useState<{ idCard?: string; bankBook?: string; safetyCert?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idRef = useRef<HTMLInputElement | null>(null);
  const bankRef = useRef<HTMLInputElement | null>(null);
  const safetyRef = useRef<HTMLInputElement | null>(null);

  async function handleUpload(kind: 'idCard' | 'bankBook' | 'safetyCert', file: File) {
    try {
      const apiKind: 'id' | 'bank' | 'face' = kind === 'bankBook' ? 'bank' : 'id';
      await teamApi.upload(apiKind, file);
      const url = URL.createObjectURL(file);
      setDocs((s) => ({ ...s, [kind]: url }));
    } catch (e) {
      window.alert(getErrorMessage(e, '업로드 실패'));
    }
  }

  async function handleSubmit() {
    setErr(null);
    if (!role.trim()) { setErr('직종을 입력해주세요.'); return; }
    const wage = Number(dailyWage.replace(/[^0-9]/g, ''));
    if (!Number.isFinite(wage) || wage <= 0) { setErr('일당을 올바르게 입력해주세요.'); return; }
    if (gongsu < 0 || gongsu > 2) { setErr('공수는 0 ~ 2 사이여야 합니다.'); return; }
    if (!reason.trim() || reason.trim().length < 5) { setErr('사유는 5자 이상 입력해주세요.'); return; }
    setSubmitting(true);
    try {
      // 멤버 기본 정보 갱신 (직종·일당·보험·안전교육·주민번호 — 변경 시)
      const updates: Record<string, unknown> = {};
      if (role !== member.role) updates.role = role;
      if (wage !== member.dailyWage) updates.dailyWage = wage;
      if (idNumber && idNumber !== (member.idNumberRaw ?? '') && !idNumber.includes('*')) updates.idNumber = idNumber.trim();
      updates.insurance = { pension: insPension, health: insHealth, employment: insEmployment, accident: insAccident };
      updates.safetyEduCompleted = safetyEdu;
      try { await teamApi.update(member.id, updates as any); } catch { /* ignore — 출역 추가는 강행 */ }

      // 출역(공수) 등록
      await attendanceApi.setGongsu({ memberId: member.id, date, gongsu, reason: reason.trim() });
      await onDone();
    } catch (e) {
      setErr(getErrorMessage(e, '출역 추가 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`＋ 출역 추가 — ${name}`}
      subtitle={`${siteName || '현장'} · ${date}${phone ? ' · ' + phone : ''}`}
      width={640}
      footer={
        <>
          <button type="button" className="att__btn att__btn--ghost" onClick={onClose} disabled={submitting}>취소</button>
          <button type="button" className="att__btn att__btn--primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '저장 중…' : `${gongsu.toFixed(1)}공수로 출역 추가`}
          </button>
        </>
      }
    >
      <div className="att-add">
        <section className="att-add__sec">
          <h4 className="att-add__sec-h">기본 정보</h4>
          <div className="att-add__grid att-add__grid--2">
            <label className="att-add__field">
              <span>이름</span>
              <input type="text" value={name} disabled />
            </label>
            <label className="att-add__field">
              <span>주민번호</span>
              <input
                type="text"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                placeholder="770417-1234567"
                className="att-add__mono"
              />
            </label>
            <label className="att-add__field">
              <span>직종</span>
              <input type="text" value={role} onChange={(e) => setRole(e.target.value)} placeholder="예) 철근공" />
            </label>
            <label className="att-add__field">
              <span>일당</span>
              <input
                inputMode="numeric"
                value={dailyWage ? Number(dailyWage.replace(/[^0-9]/g, '')).toLocaleString() : ''}
                onChange={(e) => setDailyWage(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="250,000"
              />
            </label>
          </div>
        </section>

        <section className="att-add__sec">
          <h4 className="att-add__sec-h">공수</h4>
          <div className="att-add__opts">
            {[
              { v: 0,   label: '0',   sub: '제외' },
              { v: 0.5, label: '0.5', sub: '반공수' },
              { v: 1,   label: '1.0', sub: '기본' },
              { v: 1.5, label: '1.5', sub: '연장' },
              { v: 2,   label: '2.0', sub: '특근' },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                className={'att-add__opt' + (gongsu === o.v ? ' is-active' : '')}
                onClick={() => setGongsu(o.v)}
              >
                <strong>{o.label}</strong>
                <span>{o.sub}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="att-add__sec">
          <h4 className="att-add__sec-h">필수 항목</h4>
          <div className="att-add__field">
            <span>4대보험 가입</span>
            <span className="att-add__chips">
              {[
                { k: 'p', label: '국민', v: insPension,    set: setInsPension },
                { k: 'h', label: '건강', v: insHealth,     set: setInsHealth },
                { k: 'e', label: '고용', v: insEmployment, set: setInsEmployment },
                { k: 'a', label: '산재', v: insAccident,   set: setInsAccident },
              ].map((c) => (
                <button
                  key={c.k}
                  type="button"
                  className={'att-add__chip' + (c.v ? ' is-on' : '')}
                  onClick={() => c.set(!c.v)}
                >
                  {c.v ? '✓ ' : ''}{c.label}
                </button>
              ))}
            </span>
          </div>
          <div className="att-add__field">
            <span>안전교육 이수</span>
            <button
              type="button"
              className={'att-add__chip' + (safetyEdu ? ' is-on' : '')}
              onClick={() => setSafetyEdu(!safetyEdu)}
            >
              {safetyEdu ? '✓ 이수' : '○ 미이수'}
            </button>
          </div>
        </section>

        <section className="att-add__sec">
          <h4 className="att-add__sec-h">사유 (감사 기록)</h4>
          <input
            type="text"
            className="att-add__field-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder=""
          />
        </section>

        {err && <p className="att-add__err">{err}</p>}
      </div>
    </Modal>
  );
}
