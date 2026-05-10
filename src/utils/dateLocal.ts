/**
 * dateLocal — 시차 안전 「오늘 날짜」 헬퍼
 *
 * Date.toISOString() 은 UTC 기준이라 한국(UTC+9) 새벽~오전엔
 * 어제 날짜를 반환한다. 모든 「오늘」 비교는 이 헬퍼를 사용.
 */

export function localDateStr(d: Date = new Date()): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function localYearMonth(d: Date = new Date()): string {
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  );
}

export function todayLocal(): string {
  return localDateStr(new Date());
}
