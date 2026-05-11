/**
 * 7일 예보 fetch + 기상특보 감지 유틸.
 *
 *   Open-Meteo daily 엔드포인트(무료, 키 불필요)에서 코드/풍속/강수/적설 가져온 뒤,
 *   기상청(KMA) 주의보 기준에 가까운 임계치로 위험 일자를 추출.
 *
 *   기준 (단순화):
 *     - 강풍주의보 가능: max wind ≥ 14 m/s   (CRITICAL ≥ 20 m/s)
 *     - 호우주의보 가능: 24h 강수 ≥ 50 mm   (CRITICAL ≥ 110 mm)
 *     - 대설주의보 가능: 24h 적설 ≥ 5 cm    (CRITICAL ≥ 20 cm)
 *     - 뇌우: WMO code 95~99
 *     - 한파: tempMin ≤ -10°C
 *
 *   workSuspendLikely (작업 중단 권고): 강풍 CRITICAL / 호우 CRITICAL / 대설 CAUTION+ /
 *     뇌우 / 태풍.  배너에서 「전날 17시 / 당일 06시」 자동 예약 옵션 노출.
 */

import { localDateStr } from './dateLocal';

export type WeatherSeverity = 'INFO' | 'CAUTION' | 'CRITICAL';

export type WeatherAlertKind =
  | 'STRONG_WIND'
  | 'HEAVY_RAIN'
  | 'HEAVY_SNOW'
  | 'THUNDER'
  | 'COLD_SHOCK';

export interface WeatherDayForecast {
  date: string;
  code: number;
  emoji: string;
  label: string;
  tempMin: number;
  tempMax: number;
  precipMm: number;
  windMaxMs: number;
  snowCm: number;
}

export interface WeatherAlert {
  date: string;
  kind: WeatherAlertKind;
  label: string;
  severity: WeatherSeverity;
  /** 한 줄 요약 — 배너용 */
  message: string;
  /** 작업 중단 권고 — 전날/새벽 예약 발송 옵션 활성화 */
  workSuspendLikely: boolean;
  forecast: WeatherDayForecast;
}

export const WEATHER_ALERT_LABEL: Record<WeatherAlertKind, string> = {
  STRONG_WIND: '강풍',
  HEAVY_RAIN: '호우',
  HEAVY_SNOW: '대설',
  THUNDER: '뇌우',
  COLD_SHOCK: '한파',
};

function classify(code: number): { emoji: string; label: string } {
  if (code === 0) return { emoji: '☀', label: '맑음' };
  if (code <= 2) return { emoji: '⛅', label: '구름 조금' };
  if (code === 3) return { emoji: '☁', label: '흐림' };
  if (code === 45 || code === 48) return { emoji: '🌫', label: '안개' };
  if (code >= 51 && code <= 57) return { emoji: '🌦', label: '이슬비' };
  if (code >= 61 && code <= 67) return { emoji: '🌧', label: '비' };
  if (code >= 71 && code <= 77) return { emoji: '❄', label: '눈' };
  if (code >= 80 && code <= 82) return { emoji: '🌦', label: '소나기' };
  if (code === 85 || code === 86) return { emoji: '🌨', label: '눈 소나기' };
  if (code >= 95) return { emoji: '⛈', label: '뇌우' };
  return { emoji: '🌡', label: '기상정보' };
}

/** 단일 일자 예보를 알림 목록으로 변환 */
export function detectAlertsForDay(d: WeatherDayForecast): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];

  // 강풍
  if (d.windMaxMs >= 20) {
    alerts.push({
      date: d.date,
      kind: 'STRONG_WIND',
      label: '강풍주의보 가능성',
      severity: 'CRITICAL',
      message: `최대풍속 ${d.windMaxMs.toFixed(1)} m/s — 양중·외부비계·고소작업 중단 권고`,
      workSuspendLikely: true,
      forecast: d,
    });
  } else if (d.windMaxMs >= 14) {
    alerts.push({
      date: d.date,
      kind: 'STRONG_WIND',
      label: '강풍 주의',
      severity: 'CAUTION',
      message: `최대풍속 ${d.windMaxMs.toFixed(1)} m/s — 양중작업·자재 비산 주의`,
      workSuspendLikely: false,
      forecast: d,
    });
  }

  // 호우
  if (d.precipMm >= 110) {
    alerts.push({
      date: d.date,
      kind: 'HEAVY_RAIN',
      label: '호우주의보 가능성',
      severity: 'CRITICAL',
      message: `24시간 강수량 ${Math.round(d.precipMm)}mm — 야외 작업 중단 / 침수 우려 점검`,
      workSuspendLikely: true,
      forecast: d,
    });
  } else if (d.precipMm >= 50) {
    alerts.push({
      date: d.date,
      kind: 'HEAVY_RAIN',
      label: '호우 주의',
      severity: 'CAUTION',
      message: `24시간 강수량 ${Math.round(d.precipMm)}mm — 미끄럼·전동공구 누전 점검`,
      workSuspendLikely: false,
      forecast: d,
    });
  }

  // 대설
  if (d.snowCm >= 20) {
    alerts.push({
      date: d.date,
      kind: 'HEAVY_SNOW',
      label: '대설경보 가능성',
      severity: 'CRITICAL',
      message: `적설 ${Math.round(d.snowCm)}cm — 현장 출입 통제 / 결빙 위험`,
      workSuspendLikely: true,
      forecast: d,
    });
  } else if (d.snowCm >= 5) {
    alerts.push({
      date: d.date,
      kind: 'HEAVY_SNOW',
      label: '대설 주의',
      severity: 'CAUTION',
      message: `적설 ${Math.round(d.snowCm)}cm — 결빙·미끄럼 / 비계 결빙 점검`,
      workSuspendLikely: true,
      forecast: d,
    });
  }

  // 뇌우
  if (d.code >= 95) {
    alerts.push({
      date: d.date,
      kind: 'THUNDER',
      label: '뇌우 주의',
      severity: 'CRITICAL',
      message: '낙뢰 위험 — 고소작업 / 철근 결속 / 전동공구 사용 중단',
      workSuspendLikely: true,
      forecast: d,
    });
  }

  // 한파
  if (d.tempMin <= -10) {
    alerts.push({
      date: d.date,
      kind: 'COLD_SHOCK',
      label: '한파 주의',
      severity: 'CAUTION',
      message: `최저기온 ${Math.round(d.tempMin)}°C — 동상·미끄럼 / 콘크리트 양생 보온 점검`,
      workSuspendLikely: false,
      forecast: d,
    });
  }

  return alerts;
}

/** 시연 fallback — 날씨 API 실패 / 네트워크 차단 시 결정적 더미 예보 생성. */
function mockForecast(): WeatherDayForecast[] {
  const today = new Date();
  const days: WeatherDayForecast[] = [];
  // 7일치
  const recipes: Array<Partial<WeatherDayForecast> & { code: number }> = [
    { code: 1, tempMin: 14, tempMax: 22, precipMm: 0, windMaxMs: 4, snowCm: 0 },     // d0 맑음
    { code: 63, tempMin: 13, tempMax: 19, precipMm: 65, windMaxMs: 9, snowCm: 0 },   // d+1 비 (CAUTION)
    { code: 65, tempMin: 11, tempMax: 17, precipMm: 130, windMaxMs: 16, snowCm: 0 }, // d+2 호우+강풍 (CRITICAL)
    { code: 3, tempMin: 9, tempMax: 16, precipMm: 0, windMaxMs: 7, snowCm: 0 },       // d+3 흐림
    { code: 95, tempMin: 12, tempMax: 18, precipMm: 22, windMaxMs: 11, snowCm: 0 },   // d+4 뇌우
    { code: 1, tempMin: 11, tempMax: 19, precipMm: 0, windMaxMs: 5, snowCm: 0 },      // d+5 맑음
    { code: 67, tempMin: 8, tempMax: 14, precipMm: 38, windMaxMs: 21, snowCm: 0 },    // d+6 강풍 CRITICAL
  ];
  for (let i = 0; i < recipes.length; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const ds = localDateStr(d);
    const r = recipes[i];
    const cls = classify(r.code);
    days.push({
      date: ds,
      code: r.code,
      emoji: cls.emoji,
      label: cls.label,
      tempMin: r.tempMin ?? 10,
      tempMax: r.tempMax ?? 20,
      precipMm: r.precipMm ?? 0,
      windMaxMs: r.windMaxMs ?? 0,
      snowCm: r.snowCm ?? 0,
    });
  }
  return days;
}

/** 7일 예보 fetch (Open-Meteo). 실패 시 mockForecast 로 폴백. */
export async function fetchWeeklyForecast(lat: number, lon: number): Promise<WeatherDayForecast[]> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&daily=weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,wind_speed_10m_max,snowfall_sum` +
      `&forecast_days=7&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('forecast api failed (' + res.status + ')');
    const json = (await res.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_min?: number[];
        temperature_2m_max?: number[];
        precipitation_sum?: number[];
        wind_speed_10m_max?: number[];   // km/h (Open-Meteo default)
        snowfall_sum?: number[];          // cm
      };
    };
    const t = json.daily?.time ?? [];
    if (t.length === 0) throw new Error('forecast api: empty daily');
    const out: WeatherDayForecast[] = [];
    for (let i = 0; i < t.length; i++) {
      const code = json.daily?.weather_code?.[i] ?? 0;
      const cls = classify(code);
      const windKmh = json.daily?.wind_speed_10m_max?.[i] ?? 0;
      out.push({
        date: t[i],
        code,
        emoji: cls.emoji,
        label: cls.label,
        tempMin: Math.round(json.daily?.temperature_2m_min?.[i] ?? 0),
        tempMax: Math.round(json.daily?.temperature_2m_max?.[i] ?? 0),
        precipMm: json.daily?.precipitation_sum?.[i] ?? 0,
        // km/h → m/s
        windMaxMs: Math.round((windKmh / 3.6) * 10) / 10,
        snowCm: json.daily?.snowfall_sum?.[i] ?? 0,
      });
    }
    return out;
  } catch (err) {
    console.warn('[weatherForecast] fetch failed, falling back to mock:', err);
    return mockForecast();
  }
}

/** 강제 mock 사용 — 시연·테스트용 */
export function getMockForecast(): WeatherDayForecast[] {
  return mockForecast();
}

/** 모든 예보 일자에서 알림을 추출. severity 기준으로 정렬(CRITICAL → CAUTION). */
export function detectAllAlerts(days: WeatherDayForecast[]): WeatherAlert[] {
  const all: WeatherAlert[] = [];
  for (const d of days) {
    for (const a of detectAlertsForDay(d)) all.push(a);
  }
  const order: Record<WeatherSeverity, number> = { CRITICAL: 0, CAUTION: 1, INFO: 2 };
  all.sort((a, b) => {
    const so = order[a.severity] - order[b.severity];
    if (so !== 0) return so;
    return a.date.localeCompare(b.date);
  });
  return all;
}

/** 안전공지 자동 메시지 생성 — 알림 종류별 템플릿 */
export function buildAlertMessage(alert: WeatherAlert, siteName: string): string {
  const dayLabel = formatKDate(alert.date);
  const head = `[기상 안전공지] ${siteName}`;
  const lines: string[] = [head, ''];
  lines.push(`${dayLabel} ${alert.label} 예상`);
  lines.push(`· ${alert.message}`);
  lines.push('');
  switch (alert.kind) {
    case 'STRONG_WIND':
      lines.push('· 양중작업 / 외장비계 결속 점검 / 자재 비산 방지');
      lines.push('· 위험 시 작업 중단 — 반장 지시에 따라 대피');
      break;
    case 'HEAVY_RAIN':
      lines.push('· 미끄럼 주의 / 전동공구 누전 점검');
      lines.push('· 굴착·법면·옹벽 침수 우려 사전 점검');
      lines.push('· 호우경보 발효 시 야외작업 즉시 중단');
      break;
    case 'HEAVY_SNOW':
      lines.push('· 결빙·미끄럼 주의 / 비계 결빙 점검');
      lines.push('· 출입로 제설 / 콘크리트 양생 보온');
      break;
    case 'THUNDER':
      lines.push('· 낙뢰 위험 — 고소작업 / 철근 결속 / 전동공구 사용 중단');
      lines.push('· 작업자 실내 대피');
      break;
    case 'COLD_SHOCK':
      lines.push('· 동상·심혈관 위험 / 보온 의류 착용');
      lines.push('· 콘크리트 양생 보온 점검');
      break;
  }
  if (alert.workSuspendLikely) {
    lines.push('');
    lines.push('※ 현장 휴무 가능성 — 반장 지시 확인 후 출근하세요.');
  }
  return lines.join('\n');
}

function formatKDate(iso: string): string {
  const d = new Date(iso);
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()}(${dows[d.getDay()]})`;
}
