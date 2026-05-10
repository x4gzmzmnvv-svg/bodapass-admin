/**
 * 한국 공휴일 데이터 (2024 ~ 2027)
 *
 *  음력 공휴일(설날/부처님오신날/추석)과 대체공휴일은 매년 다르므로 상수표로 관리.
 *  필요 연도가 추가되면 KOREAN_HOLIDAYS 객체에 항목을 더 추가하세요.
 *
 *  사용:
 *    isHoliday('2026-05-05')      → true
 *    getHolidayName('2026-05-05') → '어린이날'
 *    isWeekend('2026-04-26')      → true (일요일)
 */

export type HolidayKind = 'NATIONAL' | 'SUBSTITUTE' | 'TEMPORARY';

export interface Holiday {
  name: string;
  kind: HolidayKind;
}

/** 'YYYY-MM-DD' → 휴일 정보 */
export const KOREAN_HOLIDAYS: Record<string, Holiday> = {
  // ───── 2024 ─────
  '2024-01-01': { name: '신정', kind: 'NATIONAL' },
  '2024-02-09': { name: '설날 연휴', kind: 'NATIONAL' },
  '2024-02-10': { name: '설날', kind: 'NATIONAL' },
  '2024-02-11': { name: '설날 연휴', kind: 'NATIONAL' },
  '2024-02-12': { name: '설날 대체공휴일', kind: 'SUBSTITUTE' },
  '2024-03-01': { name: '삼일절', kind: 'NATIONAL' },
  '2024-04-10': { name: '제22대 국회의원 선거', kind: 'TEMPORARY' },
  '2024-05-05': { name: '어린이날', kind: 'NATIONAL' },
  '2024-05-06': { name: '어린이날 대체공휴일', kind: 'SUBSTITUTE' },
  '2024-05-15': { name: '부처님오신날', kind: 'NATIONAL' },
  '2024-06-06': { name: '현충일', kind: 'NATIONAL' },
  '2024-08-15': { name: '광복절', kind: 'NATIONAL' },
  '2024-09-16': { name: '추석 연휴', kind: 'NATIONAL' },
  '2024-09-17': { name: '추석', kind: 'NATIONAL' },
  '2024-09-18': { name: '추석 연휴', kind: 'NATIONAL' },
  '2024-10-01': { name: '국군의 날', kind: 'TEMPORARY' },
  '2024-10-03': { name: '개천절', kind: 'NATIONAL' },
  '2024-10-09': { name: '한글날', kind: 'NATIONAL' },
  '2024-12-25': { name: '크리스마스', kind: 'NATIONAL' },

  // ───── 2025 ─────
  '2025-01-01': { name: '신정', kind: 'NATIONAL' },
  '2025-01-28': { name: '설날 연휴', kind: 'NATIONAL' },
  '2025-01-29': { name: '설날', kind: 'NATIONAL' },
  '2025-01-30': { name: '설날 연휴', kind: 'NATIONAL' },
  '2025-03-01': { name: '삼일절', kind: 'NATIONAL' },
  '2025-03-03': { name: '삼일절 대체공휴일', kind: 'SUBSTITUTE' },
  '2025-05-05': { name: '어린이날 / 부처님오신날', kind: 'NATIONAL' },
  '2025-05-06': { name: '대체공휴일', kind: 'SUBSTITUTE' },
  '2025-06-06': { name: '현충일', kind: 'NATIONAL' },
  '2025-08-15': { name: '광복절', kind: 'NATIONAL' },
  '2025-10-03': { name: '개천절', kind: 'NATIONAL' },
  '2025-10-06': { name: '추석 연휴', kind: 'NATIONAL' },
  '2025-10-07': { name: '추석', kind: 'NATIONAL' },
  '2025-10-08': { name: '추석 연휴', kind: 'NATIONAL' },
  '2025-10-09': { name: '한글날', kind: 'NATIONAL' },
  '2025-12-25': { name: '크리스마스', kind: 'NATIONAL' },

  // ───── 2026 ─────
  '2026-01-01': { name: '신정', kind: 'NATIONAL' },
  '2026-02-16': { name: '설날 연휴', kind: 'NATIONAL' },
  '2026-02-17': { name: '설날', kind: 'NATIONAL' },
  '2026-02-18': { name: '설날 연휴', kind: 'NATIONAL' },
  '2026-03-01': { name: '삼일절', kind: 'NATIONAL' },
  '2026-03-02': { name: '삼일절 대체공휴일', kind: 'SUBSTITUTE' },
  '2026-05-05': { name: '어린이날', kind: 'NATIONAL' },
  '2026-05-25': { name: '부처님오신날', kind: 'NATIONAL' },
  '2026-06-06': { name: '현충일', kind: 'NATIONAL' },
  '2026-08-15': { name: '광복절', kind: 'NATIONAL' },
  '2026-08-17': { name: '광복절 대체공휴일', kind: 'SUBSTITUTE' },
  '2026-09-24': { name: '추석 연휴', kind: 'NATIONAL' },
  '2026-09-25': { name: '추석', kind: 'NATIONAL' },
  '2026-09-26': { name: '추석 연휴', kind: 'NATIONAL' },
  '2026-10-03': { name: '개천절', kind: 'NATIONAL' },
  '2026-10-05': { name: '개천절 대체공휴일', kind: 'SUBSTITUTE' },
  '2026-10-09': { name: '한글날', kind: 'NATIONAL' },
  '2026-12-25': { name: '크리스마스', kind: 'NATIONAL' },

  // ───── 2027 ─────
  '2027-01-01': { name: '신정', kind: 'NATIONAL' },
  '2027-02-06': { name: '설날 연휴', kind: 'NATIONAL' },
  '2027-02-07': { name: '설날', kind: 'NATIONAL' },
  '2027-02-08': { name: '설날 연휴', kind: 'NATIONAL' },
  '2027-02-09': { name: '설날 대체공휴일', kind: 'SUBSTITUTE' },
  '2027-03-01': { name: '삼일절', kind: 'NATIONAL' },
  '2027-05-05': { name: '어린이날', kind: 'NATIONAL' },
  '2027-05-13': { name: '부처님오신날', kind: 'NATIONAL' },
  '2027-06-06': { name: '현충일', kind: 'NATIONAL' },
  '2027-08-15': { name: '광복절', kind: 'NATIONAL' },
  '2027-08-16': { name: '광복절 대체공휴일', kind: 'SUBSTITUTE' },
  '2027-09-14': { name: '추석 연휴', kind: 'NATIONAL' },
  '2027-09-15': { name: '추석', kind: 'NATIONAL' },
  '2027-09-16': { name: '추석 연휴', kind: 'NATIONAL' },
  '2027-10-03': { name: '개천절', kind: 'NATIONAL' },
  '2027-10-04': { name: '개천절 대체공휴일', kind: 'SUBSTITUTE' },
  '2027-10-09': { name: '한글날', kind: 'NATIONAL' },
  '2027-10-11': { name: '한글날 대체공휴일', kind: 'SUBSTITUTE' },
  '2027-12-25': { name: '크리스마스', kind: 'NATIONAL' },
};

/** 일자(YYYY-MM-DD)가 공휴일인지 */
export function isHoliday(dateStr: string): boolean {
  return Boolean(KOREAN_HOLIDAYS[dateStr]);
}

/** 공휴일 이름 (없으면 undefined) */
export function getHoliday(dateStr: string): Holiday | undefined {
  return KOREAN_HOLIDAYS[dateStr];
}

/** 일요일·토요일 여부 */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr).getDay();
  return d === 0 || d === 6;
}

export function isSunday(dateStr: string): boolean {
  return new Date(dateStr).getDay() === 0;
}

export function isSaturday(dateStr: string): boolean {
  return new Date(dateStr).getDay() === 6;
}

/** 일요일 또는 한국 공휴일 — 빨간색으로 표시할 일자 */
export function isRedDay(dateStr: string): boolean {
  return isSunday(dateStr) || isHoliday(dateStr);
}

/** 1글자 요일 (월화수목금토일) */
const DOW_KR = ['일', '월', '화', '수', '목', '금', '토'];
export function dowKr(dateStr: string): string {
  return DOW_KR[new Date(dateStr).getDay()];
}

/** 일자 셀에 보여줄 짧은 라벨 — 휴일이면 짧은 이름, 아니면 빈 문자열 */
export function shortHolidayLabel(dateStr: string): string {
  const h = KOREAN_HOLIDAYS[dateStr];
  if (!h) return '';
  // 너무 긴 이름은 줄임
  return h.name
    .replace('대체공휴일', '대체')
    .replace(' 연휴', '');
}
