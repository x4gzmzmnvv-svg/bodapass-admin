/**
 * 비과세 소득 처리 유틸 — 보험료·소득세 산정용 「과세 보수」 분리
 *
 *  · 「2026년도 산재·고용보험 가입 및 부과업무 실무편람」 제11편 참고2 기준
 *  · 식대 / 자가운전보조금 / 차량유지비 / 출산·보육수당 / 기타
 *
 *  법정 한도 (2026년 기준):
 *    식대:           월 20만원까지
 *    자가운전보조금: 월 20만원까지
 *    출산·보육수당:   월 10만원까지
 *    차량유지비:     조건별 (출장 실비 등)
 */

import type { TeamMember } from './../api/team.types';

/** 비과세 항목별 법정 한도 (월 원 단위) */
export const NONTAX_LIMITS = {
  meal: 200_000,
  vehicle: 200_000,
  travel: 0,           // 한도 없음 (실비 정산 기준)
  childcare: 100_000,
  other: 0,            // 한도 없음
} as const;

/** 비과세 항목 라벨 */
export const NONTAX_LABELS: Record<keyof NonNullable<TeamMember['nontaxable']>, string> = {
  meal: '식대',
  vehicle: '자가운전보조금',
  travel: '차량유지비/출장비',
  childcare: '출산·보육수당',
  other: '기타',
};

/** 한 멤버의 월 비과세 합계 — 한도 적용
 *  법정 한도(NONTAX_LIMITS)를 초과하는 부분은 「과세」로 자동 변환.
 */
export function totalNontaxable(member: TeamMember | undefined | null): number {
  const n = member?.nontaxable;
  if (!n) return 0;
  let total = 0;
  for (const k of Object.keys(NONTAX_LIMITS) as Array<keyof typeof NONTAX_LIMITS>) {
    const value = n[k] || 0;
    const limit = NONTAX_LIMITS[k];
    total += limit > 0 ? Math.min(value, limit) : value;
  }
  return total;
}

/** 멤버의 월 「과세 보수」 — 보험료·세금 산정 기준
 *  과세 보수 = 월 지급액 - 비과세 합계
 *  · 비과세 합계는 한도 적용된 값 사용
 */
export function taxableMonthlyWage(
  member: TeamMember | undefined | null,
  totalMonthlyPay: number,
): number {
  const nontax = totalNontaxable(member);
  const taxable = totalMonthlyPay - nontax;
  return Math.max(0, Math.round(taxable));
}

/** 항목별 분해 — UI 표시 용 (한도 적용 전후 모두 표시) */
export interface NontaxBreakdown {
  key: keyof NonNullable<TeamMember['nontaxable']>;
  label: string;
  inputAmount: number;        // 사용자가 입력한 원금
  appliedAmount: number;      // 한도 적용 후 실제 비과세 처리되는 금액
  limit: number;              // 법정 한도 (0 = 한도 없음)
  exceeded: boolean;          // 한도 초과 여부
}

export function nontaxBreakdown(member: TeamMember | undefined | null): NontaxBreakdown[] {
  const n = member?.nontaxable ?? {};
  const result: NontaxBreakdown[] = [];
  for (const k of Object.keys(NONTAX_LIMITS) as Array<keyof typeof NONTAX_LIMITS>) {
    const input = n[k] || 0;
    const limit = NONTAX_LIMITS[k];
    const applied = limit > 0 ? Math.min(input, limit) : input;
    if (input === 0) continue;
    result.push({
      key: k,
      label: NONTAX_LABELS[k],
      inputAmount: input,
      appliedAmount: applied,
      limit,
      exceeded: limit > 0 && input > limit,
    });
  }
  return result;
}
