/**
 * 두루누리 사회보험료 지원 — 자동 판별 유틸
 *
 * 「2026년도 산재·고용보험 가입 및 부과업무 실무편람」 제5편 기준
 *
 * 지원 조건:
 *   1) 사업장: 상시근로자 10명 미만
 *   2) 근로자: 월평균 보수 280만원 미만
 *   3) 가입 후 36개월 한도
 *
 * 지원 비율:
 *   - 신규 가입자 (직전 6개월 미가입): 80%
 *   - 기존 가입자: 40%
 *   (보험: 국민연금 + 고용보험 — 사업주·근로자 부담분 모두)
 */

import type { TeamMember } from '../api/team.types';

/** 월평균 보수 한도 (2026년 기준 — 매년 갱신될 수 있음) */
export const DURU_WAGE_CEILING = 2_800_000;
/** 사업장 규모 한도 */
export const DURU_STAFF_CEILING = 10;
/** 지원 한도 개월 수 */
export const DURU_MONTH_LIMIT = 36;

/** 두루누리 지원 비율 */
export const DURU_SUPPORT_RATIO_NEW = 0.8;       // 신규 가입자 80%
export const DURU_SUPPORT_RATIO_EXIST = 0.4;     // 기존 가입자 40%

/** 사업장이 두루누리 대상인지 — 상시근로자 수 기준 */
export function isSiteEligible(staffCount: number): boolean {
  return staffCount > 0 && staffCount < DURU_STAFF_CEILING;
}

/** 근로자가 두루누리 대상인지 — 월평균 보수 + 사업장 규모 */
export interface MemberEligibility {
  eligible: boolean;
  reason: string;
  /** 신규 가입자 여부 — true 면 80%, false 면 40% */
  isNew: boolean;
  monthlyWage: number;
}

export function checkMemberEligibility(
  member: TeamMember,
  monthlyWageEstimate: number,
  siteStaffCount: number,
  /** 가입 시작일 (없으면 joinedAt 사용) */
  enrolledAt?: string,
): MemberEligibility {
  if (!isSiteEligible(siteStaffCount)) {
    return {
      eligible: false,
      reason: `상시근로자 ${siteStaffCount}명 — 10명 미만 사업장만 가능`,
      isNew: false,
      monthlyWage: monthlyWageEstimate,
    };
  }
  if (monthlyWageEstimate >= DURU_WAGE_CEILING) {
    return {
      eligible: false,
      reason: `월 보수 ${(monthlyWageEstimate / 10000).toFixed(0)}만원 — 280만원 미만만 가능`,
      isNew: false,
      monthlyWage: monthlyWageEstimate,
    };
  }
  // 신규 가입자 판별 — 가입일이 6개월 이내면 신규로 간주 (실제는 직전 6개월 보험가입 이력 X 조건)
  const enrollDate = enrolledAt || member.joinedAt;
  const isNew = enrollDate
    ? (Date.now() - new Date(enrollDate + 'T00:00:00').getTime()) < (6 * 30 * 86_400_000)
    : false;
  return {
    eligible: true,
    reason: isNew ? '신규 가입자 (가입 6개월 이내) — 80% 지원' : '기존 가입자 — 40% 지원',
    isNew,
    monthlyWage: monthlyWageEstimate,
  };
}

/** 예상 지원금 계산 — 한 근로자의 한 달 분
 *
 *  국민연금 기준 (간단화):
 *    국민연금 보험료율 = 9% (사업주 4.5% + 근로자 4.5%)
 *    고용보험 보험료율 = 1.8% (사업주 0.9% + 근로자 0.9%) — 우대업종 제외 일반
 *
 *  지원 대상 = 사업주 + 근로자 부담분 (국민연금 + 고용보험 합계)
 */
export interface SupportEstimate {
  /** 월 보수 기준 국민연금 + 고용보험 총 보험료 */
  totalPremium: number;
  /** 그 중 정부 지원 금액 (지원비율 적용) */
  supportAmount: number;
  /** 지원 비율 (0.8 / 0.4) */
  ratio: number;
}

export function estimateMonthlySupport(
  monthlyWage: number,
  isNew: boolean,
): SupportEstimate {
  // 국민연금 9% + 고용보험 1.8% = 10.8%
  const totalRate = 0.09 + 0.018;
  const totalPremium = Math.round(monthlyWage * totalRate);
  const ratio = isNew ? DURU_SUPPORT_RATIO_NEW : DURU_SUPPORT_RATIO_EXIST;
  const supportAmount = Math.round(totalPremium * ratio);
  return { totalPremium, supportAmount, ratio };
}

/** 사업장의 두루누리 대상 근로자 수 + 월 예상 지원금 합계 */
export interface SiteSupportSummary {
  eligibleCount: number;
  totalMonthlySupport: number;
  /** 사업장 자체가 대상인지 (상시근로자 10명 미만) */
  siteEligible: boolean;
}

export function summarizeSiteSupport(
  members: TeamMember[],
  siteStaffCount: number,
  /** 멤버별 월 보수 평균 (원) — 일당 × 평균 근무일(가정 22일) */
  monthlyWageOf?: (m: TeamMember) => number,
): SiteSupportSummary {
  const wageOf = monthlyWageOf || ((m) => (m.dailyWage || 0) * 22);
  if (!isSiteEligible(siteStaffCount)) {
    return { eligibleCount: 0, totalMonthlySupport: 0, siteEligible: false };
  }
  let count = 0;
  let support = 0;
  for (const m of members) {
    if (m.status !== 'ACTIVE') continue;
    const wage = wageOf(m);
    const elig = checkMemberEligibility(m, wage, siteStaffCount);
    if (!elig.eligible) continue;
    count++;
    support += estimateMonthlySupport(wage, elig.isNew).supportAmount;
  }
  return { eligibleCount: count, totalMonthlySupport: support, siteEligible: true };
}
