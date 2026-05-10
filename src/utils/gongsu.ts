/**
 * 공수(工數) 계산 유틸
 *
 *  사용자 요구 규칙: "8시간 기준(07~15시) 1공수"
 *  → 4시간 단위로 0.5 공수 적층:
 *      < 4h    : 0.0  (출근 미인정)
 *      4~7h    : 0.5
 *      8~11h   : 1.0   (표준 근로)
 *     12~15h   : 1.5
 *     16h 이상 : 2.0   (상한)
 *
 *  표준 근로시간대: 07:00 ~ 15:00 (휴게 별도 규정은 추후 반영 가능)
 */

export const STANDARD_WORK_START = '07:00';
export const STANDARD_WORK_END = '15:00';
export const STANDARD_WORK_MINUTES = 8 * 60;

/** 분 → 공수 (0.5 단위, 최대 2.0) */
export function minutesToGongsu(minutes: number): number {
  if (!minutes || minutes < 240) return 0; // 4시간 미만
  if (minutes < 480) return 0.5;
  if (minutes < 720) return 1.0;
  if (minutes < 960) return 1.5;
  return 2.0;
}

/** 출/퇴근 ISO 시각 → { workedMinutes, gongsu } */
export function calcGongsu(
  checkInIso?: string | null,
  checkOutIso?: string | null,
): { workedMinutes: number; gongsu: number } {
  if (!checkInIso || !checkOutIso) return { workedMinutes: 0, gongsu: 0 };
  const inMs = new Date(checkInIso).getTime();
  const outMs = new Date(checkOutIso).getTime();
  if (Number.isNaN(inMs) || Number.isNaN(outMs) || outMs <= inMs) {
    return { workedMinutes: 0, gongsu: 0 };
  }
  const minutes = Math.floor((outMs - inMs) / 60_000);
  return { workedMinutes: minutes, gongsu: minutesToGongsu(minutes) };
}

/** 출근 시각이 표준 시간대(07:00) 보다 늦었는지 — 지각 판정용 */
export function isLate(checkInIso: string): boolean {
  const d = new Date(checkInIso);
  const m = d.getHours() * 60 + d.getMinutes();
  return m > 7 * 60; // 07:00 이후
}

/** 퇴근 시각이 표준 종료(15:00) 보다 일렀는지 — 조퇴 판정용 */
export function isEarly(checkOutIso: string): boolean {
  const d = new Date(checkOutIso);
  const m = d.getHours() * 60 + d.getMinutes();
  return m < 15 * 60; // 15:00 이전
}

/** "분" 을 "Hh Mm" 표시 ("8h 30m" 등) */
export function formatWorkedMinutes(minutes: number): string {
  if (!minutes) return '-';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** 공수를 표시 문자열로 — "1.0", "0.5" */
export function formatGongsu(g: number): string {
  if (!g) return '-';
  return g.toFixed(1);
}

/** ISO → "HH:MM" 시각만 */
export function isoToHHMM(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
