// FILE_VERSION 1777810051
/**
 * 4대보험 자격 사이클 계산 — 8일룰 자동 감지
 *
 *  입력: 한 멤버의 attendance records 목록 + 멤버 자체 정보
 *  출력: InsuranceCycle[] (자격취득/상실 이력) + InsuranceFilingTask[] (신고 대기)
 *
 *  핵심 로직
 *   1) 한 멤버의 attendance 를 시간순 정렬
 *   2) 한 달(YYYY-MM) 단위로 그룹화
 *   3) 그 달 누적 출근일이 8일째 도달하는 날을 자격취득일로 기록
 *   4) 멤버가 LEFT 면 마지막 출근 다음 날을 자격상실일로 기록
 *   5) 자격취득 후 그 달이 끝나기 전에 다시 8일 미달이 되어도 그 달은 유지
 *      (다음 달에는 처음부터 다시 누적 시작 — 1개월 단위 룰)
 */

import type {
  InsuranceCycle,
  InsuranceFilingTask,
  InsuranceType,
} from '../api/insurance.types';

/** AttendanceRecord 의 핵심 필드만 (의존 끊기) */
export interface AttRecordLite {
  date: string;       // 'YYYY-MM-DD'
  status: 'NORMAL' | 'LATE' | 'EARLY' | 'ABSENT' | 'OFF';
  gongsu: number;
}

/** TeamMember 의 핵심 필드만 */
export interface MemberLite {
  id: string;
  name: string;
  siteId: string;
  status: 'ACTIVE' | 'LEFT' | string;
  joinedAt?: string;
  leftAt?: string;
}

/** 1) 한 멤버의 자격 사이클 추출 */
export function detectInsuranceCycles(
  member: MemberLite,
  records: AttRecordLite[],
): InsuranceCycle[] {
  // 출근일만 (gongsu>0) 시간순
  const workDays = records
    .filter((r) => r.gongsu > 0 && r.status !== 'ABSENT')
    .map((r) => r.date)
    .sort();

  if (workDays.length === 0) return [];

  const cycles: InsuranceCycle[] = [];
  /** 현재 진행중인 사이클의 자격취득일 (없으면 null) */
  let activeCycle: { acquireDate: string; lastWorkDate: string } | null = null;
  /** 현재 월 누적 카운터 — 'YYYY-MM' 키 */
  let currentMonth = '';
  let monthCount = 0;

  for (const date of workDays) {
    const ym = date.slice(0, 7);
    if (ym !== currentMonth) {
      // 월 바뀜 — 누적 리셋
      currentMonth = ym;
      monthCount = 0;
    }
    monthCount++;

    if (monthCount === 8 && !activeCycle) {
      // 8일째 도달 — 자격취득
      activeCycle = { acquireDate: date, lastWorkDate: date };
    } else if (activeCycle) {
      activeCycle.lastWorkDate = date;
    }
  }

  // 멤버가 이탈 상태면 마지막 사이클을 자격상실로 마무리
  if (activeCycle) {
    const cycle: InsuranceCycle = {
      id: `IC-${member.id}-${activeCycle.acquireDate}`,
      memberId: member.id,
      memberName: member.name,
      siteId: member.siteId,
      acquireDate: activeCycle.acquireDate,
      insuranceTypes: ['NP', 'HI', 'EI', 'WC'],
    };
    if (member.status === 'LEFT') {
      cycle.loseDate = member.leftAt ?? activeCycle.lastWorkDate;
    }
    cycles.push(cycle);
  }

  return cycles;
}

/** 2) 신고 대기 작업 빌드 — 사이클에서 미신고 항목 추출 */
export function buildPendingFilings(
  cycles: InsuranceCycle[],
  membersById: Map<string, MemberLite>,
  sitesById: Map<string, { id: string; name: string }>,
): InsuranceFilingTask[] {
  const tasks: InsuranceFilingTask[] = [];
  for (const c of cycles) {
    const m = membersById.get(c.memberId);
    const site = sitesById.get(c.siteId);
    if (!m || !site) continue;
    if (!c.reportedAcquireAt) {
      tasks.push({
        id: `T-${c.id}-A`,
        memberId: c.memberId,
        memberName: c.memberName,
        siteId: c.siteId,
        siteName: site.name,
        type: 'ACQUIRE',
        date: c.acquireDate,
        insuranceTypes: c.insuranceTypes.filter((t) => t === 'NP' || t === 'HI'),
        dueBy: nextMonthDeadline(c.acquireDate),
        reason: `한 달 8일 이상 근무 — ${c.acquireDate} 자격취득`,
      });
    }
    if (c.loseDate && !c.reportedLoseAt) {
      tasks.push({
        id: `T-${c.id}-L`,
        memberId: c.memberId,
        memberName: c.memberName,
        siteId: c.siteId,
        siteName: site.name,
        type: 'LOSE',
        date: c.loseDate,
        insuranceTypes: c.insuranceTypes.filter((t) => t === 'NP' || t === 'HI'),
        dueBy: nextMonthDeadline(c.loseDate),
        reason: `이탈 처리 — ${c.loseDate} 자격상실`,
      });
    }
  }
  // 마감 임박 순 정렬
  tasks.sort((a, b) => a.dueBy.localeCompare(b.dueBy));
  return tasks;
}

/** 자격 발생일 다음 달 15일까지를 신고 마감으로 (참고용) */
function nextMonthDeadline(date: string): string {
  const d = new Date(date + 'T00:00:00');
  d.setMonth(d.getMonth() + 1);
  d.setDate(15);
  return d.toISOString().slice(0, 10);
}

/** 3) localStorage 보관 — 신고 완료 표시 */
const REPORTED_STORAGE_KEY = 'bodapass.insuranceReported.v1';

interface ReportedRecord {
  cycleId: string;
  type: 'ACQUIRE' | 'LOSE';
  reportedAt: string;
}

export function loadReported(): ReportedRecord[] {
  try {
    const raw = localStorage.getItem(REPORTED_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function markReported(cycleId: string, type: 'ACQUIRE' | 'LOSE'): void {
  try {
    const arr = loadReported();
    if (arr.some((r) => r.cycleId === cycleId && r.type === type)) return;
    arr.push({ cycleId, type, reportedAt: new Date().toISOString() });
    localStorage.setItem(REPORTED_STORAGE_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('신고 이력 저장 실패', e);
  }
}

export function unmarkReported(cycleId: string, type: 'ACQUIRE' | 'LOSE'): void {
  try {
    const arr = loadReported().filter((r) => !(r.cycleId === cycleId && r.type === type));
    localStorage.setItem(REPORTED_STORAGE_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('신고 이력 해제 실패', e);
  }
}

/** 보험 종류 칩 라벨 (UI 헬퍼) */
export function insuranceTypesShort(types: InsuranceType[]): string {
  const order: InsuranceType[] = ['NP', 'HI', 'EI', 'WC'];
  return types
    .slice()
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((t) => ({ NP: '국민', HI: '건강', EI: '고용', WC: '산재' }[t]))
    .join('·');
}
