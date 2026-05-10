/**
 * 노임대장 계산식 — 출처: "노임대장계산식.xlsx" Sheet1 (BE6~BE26)
 *
 * 한 사람의 한 달 임금을 계산하는 식.
 *
 *  ── 일별 ──
 *  일금   = 단가(일당) × 공수
 *  일소득세 = ROUNDDOWN((일금 - 근로소득공제) × 원천세율 × (1 - 세액공제율), -1)
 *           단, 1,000원 미만은 0 처리
 *
 *  ── 월별 ──
 *  지급합계 = 일금 합계 + 주휴수당 + 월차수당
 *  소득세   = 일소득세 합계 + 주휴분 소득세
 *  주민세   = ROUNDDOWN(소득세 × 0.1, -1)
 *  건강보험 = 출근 ≥ 8일 일 때, ROUNDDOWN(MIN(상한, MAX(하한, 지급합계)) × 3.545%, -10원)
 *  장기요양 = 건강보험 × 12.95%
 *  국민연금 = (출근 > 7일 OR 지급합계 ≥ 2,200,000) AND 60세 미만 일 때,
 *            ROUNDDOWN(MIN(상한, MAX(하한, 지급합계)) × 4.5%, -10원)
 *  고용보험 = 65세 미만 일 때, TRUNC(지급합계 × 0.9%, -10원)
 *  공제합계 = 위 모두 합
 *  차인지급액 = 지급합계 - 공제합계
 */

// 2025년 기준값 (Sheet1 BE6~BE26)
export const WAGE_PARAMS = {
  // 일용근로소득
  baseWorkHours: 8,
  laborDeductionPerDay: 150_000,
  withholdingRate: 0.06,
  taxCreditRate: 0.55,
  localTaxRate: 0.1,
  weeklyMonthlyTaxRate: 0.45,

  // 건강보험
  healthRate: 0.03545,
  healthIncomeMax: 12_705_698,
  healthIncomeMin: 279_066,
  healthMinWorkDays: 8,
  longCareRate: 0.1295,

  // 국민연금
  pensionRate: 0.045,
  pensionIncomeMax: 6_370_000,
  pensionIncomeMin: 400_000,
  pensionMinWorkDays: 7,
  pensionMinIncome: 2_200_000,
  pensionMaxAge: 60,

  // 고용보험
  employmentRate: 0.009,
  employmentMaxAge: 65,

  // 주휴수당
  weeklyMinWorkDays: 6,
} as const;

/** 10원 단위 내림 (소득세 등 한국 노임 표기 관행) */
export function roundDown10(n: number): number {
  return Math.floor(n / 10) * 10;
}

/** Excel TRUNC(x, -1) 과 동일 */
function trunc10(n: number): number {
  return Math.trunc(n / 10) * 10;
}

/**
 * 일급(단가) → 그날의 소득세
 *  일금 = 단가 × 공수 (호출 측에서 미리 곱해서 넘김)
 */
export function calcDailyIncomeTax(dailyPay: number): number {
  if (dailyPay < WAGE_PARAMS.laborDeductionPerDay) return 0;
  const taxableBase = dailyPay - WAGE_PARAMS.laborDeductionPerDay;
  const raw =
    taxableBase * WAGE_PARAMS.withholdingRate -
    taxableBase * WAGE_PARAMS.withholdingRate * WAGE_PARAMS.taxCreditRate;
  const rounded = roundDown10(raw);
  return rounded < 1000 ? 0 : rounded;
}

/** 주민세(지방소득세) — 소득세 × 10%, 10원 단위 내림 */
export function calcLocalTax(incomeTax: number): number {
  return roundDown10(incomeTax * WAGE_PARAMS.localTaxRate);
}

/** 건강보험 — 8일 이상 근무 시 적용 */
export function calcHealthInsurance(workDays: number, monthlyPay: number): number {
  if (workDays < WAGE_PARAMS.healthMinWorkDays) return 0;
  const base = Math.min(
    WAGE_PARAMS.healthIncomeMax,
    Math.max(WAGE_PARAMS.healthIncomeMin, monthlyPay),
  );
  return roundDown10(base * WAGE_PARAMS.healthRate);
}

/** 장기요양 — 건강보험 × 12.95% */
export function calcLongCareInsurance(healthAmount: number): number {
  return roundDown10(healthAmount * WAGE_PARAMS.longCareRate);
}

/** 국민연금 — (7일 초과 또는 지급합계 220만원 이상) AND 60세 미만 */
export function calcNationalPension(
  workDays: number,
  monthlyPay: number,
  age: number,
): number {
  const meetsThreshold =
    workDays > WAGE_PARAMS.pensionMinWorkDays ||
    monthlyPay >= WAGE_PARAMS.pensionMinIncome;
  if (!meetsThreshold) return 0;
  if (age >= WAGE_PARAMS.pensionMaxAge) return 0;
  const base = Math.min(
    WAGE_PARAMS.pensionIncomeMax,
    Math.max(WAGE_PARAMS.pensionIncomeMin, monthlyPay),
  );
  return roundDown10(base * WAGE_PARAMS.pensionRate);
}

/** 고용보험 — 65세 미만일 때 지급합계 × 0.9% */
export function calcEmploymentInsurance(monthlyPay: number, age: number): number {
  if (age >= WAGE_PARAMS.employmentMaxAge) return 0;
  return trunc10(monthlyPay * WAGE_PARAMS.employmentRate);
}

/**
 * 한 명의 월 임금 명세 한 번에 계산.
 *
 * @param dailyWage   단가(일당)
 * @param totalGongsu 한 달 누적 공수 (출퇴근 페이지의 8h=1.0 규칙)
 * @param workDays    출력일수 (공수 > 0 인 일수)
 * @param weekHolidayDays 주휴 일수 (보통 출근 6일당 1일)
 * @param monthlyHolidayDays 월차 일수
 * @param age         만 나이 (보험 면제 판정용)
 */
export interface WageBreakdown {
  // 지급
  dailyWage: number;
  totalGongsu: number;
  workDays: number;
  basePay: number; // 일금 합계
  weekHolidayPay: number; // 주휴수당
  monthlyHolidayPay: number; // 월차수당
  grossPay: number; // 지급합계

  // 공제
  incomeTax: number; // 소득세
  localTax: number; // 주민세/지방소득세
  health: number; // 건강보험
  longCare: number; // 장기요양
  pension: number; // 국민연금
  employment: number; // 고용보험
  totalDeduction: number;

  // 실지급
  netPay: number;
}

export function calcWageBreakdown(args: {
  dailyWage: number;
  totalGongsu: number;
  workDays: number;
  weekHolidayDays?: number;
  monthlyHolidayDays?: number;
  age: number;
}): WageBreakdown {
  const { dailyWage, totalGongsu, workDays } = args;
  const weekHolidayDays = args.weekHolidayDays ?? Math.floor(workDays / 6);
  const monthlyHolidayDays = args.monthlyHolidayDays ?? 0;
  const age = args.age ?? 35;

  // 일금 합계 (단가 × 누적 공수)
  const basePay = Math.round(dailyWage * totalGongsu);

  // 주휴수당 — 평균 일급(= 단가) × 주휴 일수
  const weekHolidayPay = Math.round(dailyWage * weekHolidayDays);
  // 월차수당 — 평균 일급 × 월차 일수
  const monthlyHolidayPay = Math.round(dailyWage * monthlyHolidayDays);

  const grossPay = basePay + weekHolidayPay + monthlyHolidayPay;

  // 소득세: 표준 일금 기준의 일소득세 × 출력일수 + 주휴분 추가 소득세
  const dayPay = dailyWage; // 단가 × 1.0공수 기준 일소득세
  const incomeTaxPerDay = calcDailyIncomeTax(dayPay);
  const incomeTaxFromBase = incomeTaxPerDay * workDays;
  // 주휴분: (주휴수당 - 근로소득공제 × 일수) × 원천세율 × 주차/월차세율
  const weekHolidayTaxable = Math.max(
    0,
    weekHolidayPay - WAGE_PARAMS.laborDeductionPerDay * weekHolidayDays,
  );
  const incomeTaxFromHoliday =
    weekHolidayTaxable *
    WAGE_PARAMS.withholdingRate *
    WAGE_PARAMS.weeklyMonthlyTaxRate;
  const incomeTax = roundDown10(incomeTaxFromBase + incomeTaxFromHoliday);

  const localTax = calcLocalTax(incomeTax);
  const health = calcHealthInsurance(workDays, grossPay);
  const longCare = calcLongCareInsurance(health);
  const pension = calcNationalPension(workDays, grossPay, age);
  const employment = calcEmploymentInsurance(grossPay, age);

  const totalDeduction = incomeTax + localTax + health + longCare + pension + employment;
  const netPay = grossPay - totalDeduction;

  return {
    dailyWage,
    totalGongsu,
    workDays,
    basePay,
    weekHolidayPay,
    monthlyHolidayPay,
    grossPay,
    incomeTax,
    localTax,
    health,
    longCare,
    pension,
    employment,
    totalDeduction,
    netPay,
  };
}

/** 주민번호 앞자리 + 성별코드로 만 나이 계산 */
export function ageFromIdNumber(idNumber: string, today = new Date()): number {
  const cleaned = idNumber.replace(/\D/g, '');
  if (cleaned.length < 7) return 35; // 기본값
  const yy = Number(cleaned.slice(0, 2));
  const mm = Number(cleaned.slice(2, 4));
  const dd = Number(cleaned.slice(4, 6));
  const g = Number(cleaned[6]);
  const fullYear = g <= 2 ? 1900 + yy : g <= 4 ? 2000 + yy : g <= 6 ? 1800 + yy : 2000 + yy;
  let age = today.getFullYear() - fullYear;
  const monthDiff = today.getMonth() + 1 - mm;
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dd)) age--;
  return age;
}
