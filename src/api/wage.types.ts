/**
 * 노임비 / 퇴직금 도메인 타입 — 와이어프레임 030, 033, 034.png
 */

import type { WorkerRole } from './team.types';

/** 월간 노임 시트의 한 행 (한 명의 그달 정산 결과) */
export interface WageRow {
  memberId: string;
  memberName: string;
  /** 마스킹된 주민번호 (감사용) */
  idNumberMasked: string;
  role: WorkerRole;
  /** 근로일수 */
  workDays: number;
  /** 일당 (원) */
  dailyWage: number;
  /** 기본급 = workDays × dailyWage */
  baseAmount: number;
  /** 공제 — 4대보험 + 소득세 + 40H공단 등 */
  deductionPension: number; // 국민연금
  deductionHealth: number; // 건강보험
  deductionEmployment: number; // 고용보험
  deductionAccident: number; // 산재보험
  deductionIncomeTax: number; // 소득세
  deductionLocalTax: number; // 지방소득세
  deductionTotal: number;
  /** 실지급액 */
  netAmount: number;
  /** 퇴직금 적립 (이번 달 분) */
  severanceAccrued: number;
}

export interface WageMonthSummary {
  year: number;
  month: number;
  totalDays: number;
  totalBase: number;
  totalDeduction: number;
  totalNet: number;
  totalSeverance: number;
  /** 직종별 합계 */
  byRole: Array<{
    role: WorkerRole;
    count: number;
    days: number;
    net: number;
  }>;
  /** 행 데이터 */
  rows: WageRow[];
}

export interface WageQuery {
  siteId: string;
  yearMonth: string; // 'YYYY-MM'
}

// ───────── 퇴직금 ─────────

export interface SeveranceRow {
  memberId: string;
  memberName: string;
  idNumberMasked: string;
  role: WorkerRole;
  /** 입사일 */
  joinedAt: string;
  /** 일당 (원) — 평균임금 추정의 베이스 */
  dailyWage: number;
  /** 누적 근무일 */
  totalWorkDays: number;
  /** 총 누적 적립 */
  accruedTotal: number;
  /** 이미 지급된 퇴직금 */
  paidTotal: number;
  /** 잔액 */
  balance: number;
  /** 마지막 지급일 */
  lastPaidAt?: string;
}

export interface SeveranceMonthSummary {
  year: number;
  month: number;
  /** 당일 출력된 인원 — 와이어프레임 034 */
  attendedToday: number;
  totalAccrued: number;
  totalPaid: number;
  totalBalance: number;
  rows: SeveranceRow[];
}

export interface SeveranceQuery {
  siteId: string;
  yearMonth: string;
}

/** 출력 / 발송 응답 */
export interface PayoutDispatchResponse {
  count: number; // 처리된 인원
  channel: 'EXCEL' | 'KAKAO' | 'SMS' | 'PRINT';
  exportedAt: string;
}
