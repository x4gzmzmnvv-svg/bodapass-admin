/**
 * 4대보험 신고 마감일 통합 계산 — 「2026년도 산재·고용보험 가입 및 부과업무 실무편람」 기준
 *
 * 4가지 신고 유형:
 *   1) 보험관계 성립신고 — 사업장(현장) 신설일로부터 14일 이내
 *   2) 자격취득 신고 — 근로자 고용일이 속한 달의 다음달 15일까지
 *   3) 근로내용확인신고 — 일용근로자 — 매월 다음달 15일까지 (지속 작업 중인 현장은 매월 1회)
 *   4) 보수총액 신고 — 자진신고 사업장(건설업) — 익년 3월 15일까지 (1년 1회)
 *
 * 출력: DeadlineItem[] — UI 에서 사이드바 뱃지 / 대시보드 알림 / 캘린더에 그대로 표시
 */

import type { Site } from '../api/site.types';
import type { TeamMember } from '../api/team.types';

export type DeadlineKind =
  | 'ESTABLISH'           // 보험관계 성립신고
  | 'ACQUIRE'             // 자격취득 신고
  | 'MONTHLY_REPORT'      // 근로내용확인신고
  | 'ANNUAL_TOTAL_PAY';   // 보수총액 신고 (자진신고)

export type DeadlineSeverity = 'safe' | 'soon' | 'urgent' | 'overdue';

export interface DeadlineItem {
  id: string;
  kind: DeadlineKind;
  title: string;
  description: string;
  siteId?: string;
  siteName?: string;
  /** 마감일 'YYYY-MM-DD' */
  dueDate: string;
  /** 오늘로부터 며칠 남았는지 (음수 = 지난 일수) */
  daysLeft: number;
  severity: DeadlineSeverity;
  /** 관련 근로자 (자격취득 / 월별 신고에서 사용) */
  memberCount?: number;
  /** 클릭 시 이동할 라우트 (있으면 카드 클릭 시 점프) */
  routeTo?: string;
}

const MS_PER_DAY = 86_400_000;

function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function severityFor(daysLeft: number): DeadlineSeverity {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 3) return 'urgent';
  if (daysLeft <= 7) return 'soon';
  return 'safe';
}

/** 다음달 15일 'YYYY-MM-DD' */
function nextMonth15th(baseDate: string): string {
  const d = new Date(baseDate + 'T00:00:00');
  d.setMonth(d.getMonth() + 1);
  d.setDate(15);
  return ymd(d);
}

/** N일 후 'YYYY-MM-DD' */
function addDays(baseDate: string, days: number): string {
  const d = new Date(baseDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return ymd(d);
}

// ─────────────────────────────────────────────
// 1) 보험관계 성립신고 — 현장 신설일로부터 14일
// ─────────────────────────────────────────────
function buildEstablishDeadlines(
  sites: Site[],
  reportedSiteIds: Set<string>,
): DeadlineItem[] {
  const items: DeadlineItem[] = [];
  const today = todayMidnight();
  for (const s of sites) {
    if (s.status === 'COMPLETED') continue;
    if (reportedSiteIds.has(s.id)) continue;
    const startStr = s.startDate || s.createdAt?.slice(0, 10);
    if (!startStr) continue;
    // 신설일로부터 14일 마감 — 단, 신설 후 30일 이상 지난 현장은 이미 처리된 것으로 간주
    const dueDate = addDays(startStr, 14);
    const dueDt = new Date(dueDate + 'T00:00:00');
    const daysLeft = daysBetween(today, dueDt);
    if (daysLeft < -30) continue;  // 한참 지난 건 표시 안 함
    items.push({
      id: 'EST-' + s.id,
      kind: 'ESTABLISH',
      title: '보험관계 성립신고',
      description: `${s.name} — 신설일 ${startStr} 기준`,
      siteId: s.id,
      siteName: s.name,
      dueDate,
      daysLeft,
      severity: severityFor(daysLeft),
      routeTo: '/insurance',
    });
  }
  return items;
}

// ─────────────────────────────────────────────
// 2) 자격취득 신고 — 1개월 8일 이상 근무 근로자, 다음달 15일
// ─────────────────────────────────────────────
function buildAcquireDeadlines(
  members: TeamMember[],
  sites: Site[],
  reportedAcquireMemberIds: Set<string>,
): DeadlineItem[] {
  const sitesById = new Map(sites.map((s) => [s.id, s] as const));
  const items: DeadlineItem[] = [];
  const today = todayMidnight();
  // 멤버별 acquire 후보 — joinedAt 후 8일 이상 근무 가정 (실제 8일 룰은 detectInsuranceCycles 가 정확히 처리.
  // 여기선 단순히 status === 'ACTIVE' && joinedAt 이 한 달 이상 지났으면 자격취득 가능 후보로 본다.
  for (const m of members) {
    if (reportedAcquireMemberIds.has(m.id)) continue;
    if (m.status !== 'ACTIVE') continue;
    if (!m.joinedAt) continue;
    const joinDate = new Date(m.joinedAt + 'T00:00:00');
    if (isNaN(joinDate.getTime())) continue;
    // 입사 후 30일 이상 경과한 ACTIVE 멤버 → 자격취득 신고 후보
    const daysSinceJoin = daysBetween(joinDate, today);
    if (daysSinceJoin < 30) continue;
    const site = sitesById.get(m.siteId);
    if (!site || site.status === 'COMPLETED') continue;
    // 마감 = 자격취득일 다음달 15일 (간단화: joinedAt + 30일 다음달 15일)
    const dueDate = nextMonth15th(m.joinedAt);
    const dueDt = new Date(dueDate + 'T00:00:00');
    const daysLeft = daysBetween(today, dueDt);
    if (daysLeft < -90) continue;  // 너무 옛날 건 제외
    items.push({
      id: 'ACQ-' + m.id,
      kind: 'ACQUIRE',
      title: '자격취득 신고',
      description: `${m.name} (${m.role}) — 자격취득일 ${m.joinedAt}`,
      siteId: m.siteId,
      siteName: site.name,
      dueDate,
      daysLeft,
      severity: severityFor(daysLeft),
      routeTo: '/insurance',
    });
  }
  return items;
}

// ─────────────────────────────────────────────
// 3) 근로내용확인신고 — 매월 1회, 다음달 15일까지
// ─────────────────────────────────────────────
function buildMonthlyReportDeadlines(
  sites: Site[],
  members: TeamMember[],
  reportedMonths: Set<string>,
): DeadlineItem[] {
  const items: DeadlineItem[] = [];
  const today = todayMidnight();
  // 시공중 현장 각각에 대해 「전월 + 다음달 15일」 마감 추적
  // 예: 오늘이 5월이면 4월분 신고 마감 = 5/15 / 또 5월분 신고 마감 = 6/15
  const activeSites = sites.filter((s) => s.status !== 'COMPLETED');
  // 2개월치 (이전월 + 이번월)
  for (let monthOffset = -1; monthOffset <= 0; monthOffset++) {
    const target = new Date(today);
    target.setMonth(target.getMonth() + monthOffset);
    const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
    // 마감 = 그 다음달 15일
    const due = new Date(target);
    due.setMonth(due.getMonth() + 1);
    due.setDate(15);
    const dueDate = ymd(due);
    const daysLeft = daysBetween(today, due);
    for (const s of activeSites) {
      const reportKey = s.id + '|' + ym;
      if (reportedMonths.has(reportKey)) continue;
      // 그 현장에 그 달 출역한 멤버 수 (간단히 ACTIVE + siteId 일치)
      const siteMemberCount = members.filter((m) => m.siteId === s.id && m.status === 'ACTIVE').length;
      if (siteMemberCount === 0) continue;
      items.push({
        id: 'MON-' + s.id + '-' + ym,
        kind: 'MONTHLY_REPORT',
        title: `근로내용확인신고 (${ym})`,
        description: `${s.name} — ${siteMemberCount}명`,
        siteId: s.id,
        siteName: s.name,
        dueDate,
        daysLeft,
        severity: severityFor(daysLeft),
        memberCount: siteMemberCount,
        routeTo: '/insurance',
      });
    }
  }
  return items;
}

// ─────────────────────────────────────────────
// 4) 보수총액 신고 — 자진신고 사업장(건설업), 익년 3월 15일
// ─────────────────────────────────────────────
function buildAnnualTotalPayDeadlines(
  sites: Site[],
  reportedYears: Set<string>,
): DeadlineItem[] {
  const items: DeadlineItem[] = [];
  const today = todayMidnight();
  const thisYear = today.getFullYear();
  // 작년 보수총액 신고 마감 = 올해 3/15
  // 올해 보수총액 신고 마감 = 내년 3/15 (D-90 부터 표시)
  const candidates = [
    { year: thisYear - 1, dueDate: `${thisYear}-03-15` },
    { year: thisYear,     dueDate: `${thisYear + 1}-03-15` },
  ];
  for (const c of candidates) {
    if (reportedYears.has(String(c.year))) continue;
    const dueDt = new Date(c.dueDate + 'T00:00:00');
    const daysLeft = daysBetween(today, dueDt);
    if (daysLeft > 90) continue;       // 90일 미만으로 임박했을 때만
    if (daysLeft < -60) continue;      // 60일 이상 지나면 표시 X
    for (const s of sites) {
      if (s.status === 'COMPLETED') {
        // 준공 현장은 마지막 정산 후 더는 표시 안 함
        continue;
      }
      items.push({
        id: 'ANN-' + s.id + '-' + c.year,
        kind: 'ANNUAL_TOTAL_PAY',
        title: `${c.year}년 보수총액 신고`,
        description: `${s.name} — 자진신고(건설업) 확정정산`,
        siteId: s.id,
        siteName: s.name,
        dueDate: c.dueDate,
        daysLeft,
        severity: severityFor(daysLeft),
        routeTo: '/insurance',
      });
    }
  }
  return items;
}

// ─────────────────────────────────────────────
// 통합 — 모든 마감일 한 번에
// ─────────────────────────────────────────────
export interface BuildDeadlinesInput {
  sites: Site[];
  members: TeamMember[];
  /** 이미 보고된 항목 (localStorage 기반) */
  reported?: {
    siteEstablish?: string[];     // siteId 목록
    memberAcquire?: string[];     // memberId 목록
    monthlyReports?: string[];    // 'siteId|YYYY-MM' 목록
    annualTotalPay?: string[];    // 'YYYY' 목록
  };
}

export function buildAllDeadlines(input: BuildDeadlinesInput): DeadlineItem[] {
  const r = input.reported ?? {};
  const all: DeadlineItem[] = [
    ...buildEstablishDeadlines(input.sites, new Set(r.siteEstablish ?? [])),
    ...buildAcquireDeadlines(input.members, input.sites, new Set(r.memberAcquire ?? [])),
    ...buildMonthlyReportDeadlines(input.sites, input.members, new Set(r.monthlyReports ?? [])),
    ...buildAnnualTotalPayDeadlines(input.sites, new Set(r.annualTotalPay ?? [])),
  ];
  // 마감 임박순 정렬 (overdue → urgent → soon → safe)
  all.sort((a, b) => a.daysLeft - b.daysLeft);
  return all;
}

// ─────────────────────────────────────────────
// localStorage 보관 — 신고 완료 표시
// ─────────────────────────────────────────────
const STORAGE_KEY = 'bodapass.insuranceDeadlines.reported.v1';

interface StoredReported {
  siteEstablish?: string[];
  memberAcquire?: string[];
  monthlyReports?: string[];
  annualTotalPay?: string[];
}

export function loadReportedDeadlines(): StoredReported {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredReported;
  } catch {
    return {};
  }
}

export function markDeadlineReported(kind: DeadlineKind, key: string): void {
  try {
    const cur = loadReportedDeadlines();
    const fieldMap: Record<DeadlineKind, keyof StoredReported> = {
      ESTABLISH: 'siteEstablish',
      ACQUIRE: 'memberAcquire',
      MONTHLY_REPORT: 'monthlyReports',
      ANNUAL_TOTAL_PAY: 'annualTotalPay',
    };
    const field = fieldMap[kind];
    const arr = (cur[field] ?? []).slice();
    if (!arr.includes(key)) arr.push(key);
    cur[field] = arr;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  } catch (e) {
    console.error('마감 보고 표시 저장 실패', e);
  }
}

// ─────────────────────────────────────────────
// 요약 카운터 — 사이드바 뱃지에 사용
// ─────────────────────────────────────────────
export interface DeadlineSummary {
  total: number;
  overdue: number;
  urgent: number;     // D-3 이내
  soon: number;       // D-7 이내
  /** 사이드바에 표시할 텍스트 ('D-3' / 'D-day' / '+5일' / '') */
  badgeText: string;
  /** 뱃지 색상 (CSS color or token) */
  badgeColor: string;
}

export function summarizeDeadlines(items: DeadlineItem[]): DeadlineSummary {
  const overdue = items.filter((i) => i.severity === 'overdue').length;
  const urgent = items.filter((i) => i.severity === 'urgent').length;
  const soon = items.filter((i) => i.severity === 'soon').length;
  const total = items.length;

  // 가장 임박한 1건 기준으로 뱃지 결정
  const top = items[0];
  let badgeText = '';
  let badgeColor = '#9CA3AF';
  if (top) {
    if (top.daysLeft < 0) {
      badgeText = `+${Math.abs(top.daysLeft)}일`;
      badgeColor = '#B91C1C';        // 빨강 — 지연
    } else if (top.daysLeft === 0) {
      badgeText = 'D-day';
      badgeColor = '#FF6B6B';        // 코랄 레드
    } else if (top.daysLeft <= 7) {
      badgeText = `D-${top.daysLeft}`;
      badgeColor = top.daysLeft <= 3 ? '#FF6B6B' : '#F59E0B';  // 3일 이내 빨강 / 7일 이내 앰버
    } else {
      badgeText = `${total}건`;
      badgeColor = '#007AFF';        // 시스템 블루
    }
  }
  return { total, overdue, urgent, soon, badgeText, badgeColor };
}
