/**
 * severance — 일용근로자 퇴직금/퇴직공제 헬퍼
 *
 * 실무 정리 (사용자 정정)
 *  · 일용근로자는 매월 별도 적립 개념이 없음. 매월 노임명세에 「퇴직적립」을
 *    찍어두는 건 의미가 없다.
 *  · 계속근로 < 1년 → 사업주가 건설근로자공제회에 「퇴직공제부금」을
 *    출역일 × 부금 일액 만큼 납부 (월 단위 신고).
 *  · 계속근로 ≥ 1년 → 그 시점부터 「퇴직공제 신고 중단」 + 법정퇴직금 지급
 *    (1일 평균임금 × 30일 × 총계속근로일수 ÷ 365).
 *
 * 이 파일은 두 가지 산식과 「1년 임박 / 1년 도래 / 1년 초과」 판정을
 * 한 곳에 모아둔다. 페이지마다 따로 계산하지 않도록.
 */

const FUND_DAILY_KEY = 'bodapass_admin:severance_fund_daily';

/** 2024~2025 기준 건설근로자공제회 퇴직공제부금 일액 (원). 정책 변경 시 수정. */
export const DEFAULT_FUND_DAILY = 6_500;

/** 1년 임박으로 분류할 일수 (D-30 부터 알림) */
export const ONE_YEAR_SOON_DAYS = 30;

/* ─────────── 부금 일액 영속화 ─────────── */

export function loadFundDaily(): number {
  try {
    const raw = localStorage.getItem(FUND_DAILY_KEY);
    if (!raw) return DEFAULT_FUND_DAILY;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : DEFAULT_FUND_DAILY;
  } catch {
    return DEFAULT_FUND_DAILY;
  }
}

export function saveFundDaily(n: number): void {
  try {
    if (isFinite(n) && n > 0) {
      localStorage.setItem(FUND_DAILY_KEY, String(Math.round(n)));
    }
  } catch {
    /* ignore */
  }
}

/* ─────────── 계속근로기간 ─────────── */

export interface ServiceTenure {
  /** 입사일부터 기준일까지의 일수 (음수 가능: 미래 입사) */
  totalDays: number;
  /** 1년 도래 여부 (totalDays >= 365) */
  hasReachedOneYear: boolean;
  /** 1년까지 남은 일수 (양수면 아직 미도달, 0 이하면 이미 도달) */
  daysUntilOneYear: number;
  /** 1년 임박 (daysUntilOneYear <= ONE_YEAR_SOON_DAYS && > 0) */
  isApproachingOneYear: boolean;
}

function diffDays(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * 입사일(joinedAt) 과 기준일(refDate, 기본값 = 오늘)을 받아
 * 계속근로기간 정보를 반환.
 */
export function computeServiceTenure(joinedAt: string, refDate?: Date | string): ServiceTenure {
  const ref = refDate ? new Date(refDate) : new Date();
  const joined = new Date(joinedAt);
  if (isNaN(joined.getTime())) {
    return {
      totalDays: 0,
      hasReachedOneYear: false,
      daysUntilOneYear: 365,
      isApproachingOneYear: false,
    };
  }
  const totalDays = diffDays(joined, ref);
  const daysUntilOneYear = 365 - totalDays;
  return {
    totalDays,
    hasReachedOneYear: totalDays >= 365,
    daysUntilOneYear,
    isApproachingOneYear: daysUntilOneYear > 0 && daysUntilOneYear <= ONE_YEAR_SOON_DAYS,
  };
}

/* ─────────── 1) 1년 미만 — 퇴직공제부금 ─────────── */

/**
 * 출역일수 × 부금 일액 = 누적 부금 적립금 (사업주가 공제회에 납부).
 * 만 1년이 도래하면 그 시점부터 신고 중단 → 법정퇴직금으로 전환.
 */
export function mutualAidAccrued(opts: { workDays: number; fundDaily?: number }): number {
  const fund = opts.fundDaily ?? loadFundDaily();
  return Math.max(0, Math.round(opts.workDays * fund));
}

/* ─────────── 2) 1년 이상 — 법정퇴직금 ─────────── */

/**
 * 법정퇴직금 = 1일 평균임금 × 30일 × (총계속근로일수 ÷ 365)
 *  · 평균임금 = 직전 3개월 임금 총액 ÷ 직전 3개월 일수
 *  · 일용근로자도 1년 이상 계속근로 시 동일 적용
 *
 * 호출자가 평균임금을 계산해 넘기는 게 맞다 — 이 함수는 공식만 적용.
 */
export function legalSeverance(opts: {
  avgDailyWage: number;
  serviceDays: number;
}): number {
  if (opts.avgDailyWage <= 0 || opts.serviceDays <= 0) return 0;
  return Math.round((opts.avgDailyWage * 30 * opts.serviceDays) / 365);
}

/**
 * 「최근 3개월 평균임금」 추정 — 단순화 모드.
 *  실서버에서는 실제 지급내역에서 가져와야 한다.
 *  여기선 일당과 출역일을 기반으로 평균을 환산.
 */
export function estimateAvgDailyWage(opts: {
  recentMonthlyPays: { workDays: number; baseAmount: number }[];
}): number {
  const totalPay = opts.recentMonthlyPays.reduce((s, m) => s + m.baseAmount, 0);
  const totalDays = opts.recentMonthlyPays.reduce((s, m) => s + m.workDays, 0);
  if (totalDays <= 0) return 0;
  return Math.round(totalPay / totalDays);
}

/* ─────────── 그룹 분류 ─────────── */

export type SeveranceGroup = 'MUTUAL_AID' | 'LEGAL';

export interface ClassifyResult {
  group: SeveranceGroup;
  tenure: ServiceTenure;
  /** 사용자에게 보여줄 라벨 */
  label: string;
}

export function classifyForSeverance(joinedAt: string, refDate?: Date | string): ClassifyResult {
  const tenure = computeServiceTenure(joinedAt, refDate);
  if (tenure.hasReachedOneYear) {
    return { group: 'LEGAL', tenure, label: '1년 이상 (법정퇴직금)' };
  }
  if (tenure.isApproachingOneYear) {
    return {
      group: 'MUTUAL_AID',
      tenure,
      label: `1년 임박 (D-${tenure.daysUntilOneYear}) — 곧 법정퇴직금 전환`,
    };
  }
  return { group: 'MUTUAL_AID', tenure, label: '1년 미만 (공제회 부금)' };
}
