import { useEffect, useState } from 'react';

/**
 * 실시간 날씨 훅 — Open-Meteo (무료, API 키 불필요)
 *  - 브라우저 Geolocation 으로 현재 위치 측정
 *  - 권한 거부 / 실패 시 서울(37.5665, 126.9780) 폴백
 *  - 30분마다 자동 갱신
 *  - localStorage 에 마지막 측정 위치 캐싱(빠른 초기 표시)
 */

export type WeatherKind =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'thunder'
  | 'unknown';

export interface WeatherInfo {
  /** 섭씨 기온 (정수 반올림) */
  temperatureC: number;
  /** 분류된 날씨 종류 */
  kind: WeatherKind;
  /** WMO weather code (원본) */
  code: number;
  /** 표시할 이모지 */
  emoji: string;
  /** 한국어 라벨 (예: "맑음") */
  label: string;
  /** 측정 위치 (도시 추정 — 단순 좌표) */
  location?: { lat: number; lon: number };
  /** 최근 갱신 시각 ISO */
  fetchedAt: string;
  /** 로딩 중 여부 */
  loading: boolean;
  /** 에러 메시지 (있다면) */
  error?: string;
}

const SEOUL = { lat: 37.5665, lon: 126.978 };
const REFRESH_MS = 30 * 60 * 1000; // 30분
const CACHE_KEY = 'ilgampack_admin:weather:lastCoord';

/** WMO weather code → kind/emoji/label */
function classify(code: number): { kind: WeatherKind; emoji: string; label: string } {
  if (code === 0) return { kind: 'clear', emoji: '☀️', label: '맑음' };
  if (code === 1) return { kind: 'partly', emoji: '🌤️', label: '대체로 맑음' };
  if (code === 2) return { kind: 'partly', emoji: '⛅', label: '구름 조금' };
  if (code === 3) return { kind: 'cloudy', emoji: '☁️', label: '흐림' };
  if (code === 45 || code === 48) return { kind: 'fog', emoji: '🌫️', label: '안개' };
  if (code >= 51 && code <= 57) return { kind: 'rain', emoji: '🌦️', label: '이슬비' };
  if (code >= 61 && code <= 67) return { kind: 'rain', emoji: '🌧️', label: '비' };
  if (code >= 71 && code <= 77) return { kind: 'snow', emoji: '❄️', label: '눈' };
  if (code >= 80 && code <= 82) return { kind: 'rain', emoji: '🌦️', label: '소나기' };
  if (code === 85 || code === 86) return { kind: 'snow', emoji: '🌨️', label: '눈 소나기' };
  if (code >= 95 && code <= 99) return { kind: 'thunder', emoji: '⛈️', label: '뇌우' };
  return { kind: 'unknown', emoji: '🌡️', label: '기상정보' };
}

function loadCachedCoord(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { lat: number; lon: number; at: number };
    // 24시간 이내 캐시만 사용
    if (Date.now() - v.at > 24 * 3600_000) return null;
    return { lat: v.lat, lon: v.lon };
  } catch {
    return null;
  }
}

function saveCachedCoord(c: { lat: number; lon: number }) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...c, at: Date.now() }));
  } catch { /* ignore */ }
}

async function fetchOpenMeteo(lat: number, lon: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=temperature_2m,weather_code` +
    `&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather api failed (' + res.status + ')');
  const json = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  const t = json.current?.temperature_2m;
  const c = json.current?.weather_code;
  if (typeof t !== 'number' || typeof c !== 'number') {
    throw new Error('weather api: bad payload');
  }
  return { temperatureC: Math.round(t), code: c };
}

function getCoord(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(loadCachedCoord() ?? SEOUL);
      return;
    }
    const fallback = loadCachedCoord() ?? SEOUL;
    // 5초 안에 응답 없으면 폴백 사용
    const timer = setTimeout(() => resolve(fallback), 5000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const c = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        saveCachedCoord(c);
        resolve(c);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 10 * 60_000 },
    );
  });
}

const INITIAL: WeatherInfo = {
  temperatureC: 0,
  kind: 'unknown',
  code: -1,
  emoji: '…',
  label: '날씨 불러오는 중',
  fetchedAt: '',
  loading: true,
};

export function useWeather(): WeatherInfo {
  const [info, setInfo] = useState<WeatherInfo>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const coord = await getCoord();
        const { temperatureC, code } = await fetchOpenMeteo(coord.lat, coord.lon);
        const cls = classify(code);
        if (cancelled) return;
        setInfo({
          temperatureC,
          kind: cls.kind,
          code,
          emoji: cls.emoji,
          label: cls.label,
          location: coord,
          fetchedAt: new Date().toISOString(),
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setInfo((p) => ({
          ...p,
          loading: false,
          error: (err as Error).message,
        }));
      }
    }

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return info;
}
