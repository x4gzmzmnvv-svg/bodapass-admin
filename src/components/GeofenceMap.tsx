// FILE_VERSION 1777810020
/**
 * GeofenceMap — 지오펜싱 시각화 위젯
 *
 *  · SVG 기반 mock 지도 — 외부 라이브러리·API 키 없이 즉시 동작
 *  · 격자(주요 도로 패턴) + 현장 핀 + 반경 원 + 거리 눈금
 *  · 우측 컨트롤: 반경 슬라이더 / GPS 오차 / 위치 정책 / 현장밖 정책
 *  · 클릭으로 핀 위치 미세조정 (드래그 대체)
 *
 *  실 운영 단계에서 카카오맵 / 네이버맵 / Leaflet 으로 교체할 때
 *  같은 props 인터페이스로 갈아끼우기만 하면 됨.
 */

import { useId } from 'react';
import type {
  SiteGeofence,
  LocationRequirement,
  OutOfBoundsPolicy,
} from '../api/site.types';
import './GeofenceMap.css';

interface Props {
  value: SiteGeofence;
  onChange: (next: SiteGeofence) => void;
  /** 현장 주소 (지도 헤더 표시용) */
  address?: string;
  /** 읽기 전용 (수정 권한 없음) */
  readOnly?: boolean;
}

/** 지도 위 표시 — 좌표 → 지도 캔버스 픽셀 */
const MAP_W = 320;
const MAP_H = 220;
/** 지도 1픽셀당 m — 100m 가 60픽셀로 보이게 (반경 100m 이 시각적으로 친숙한 크기) */
const PX_PER_M = 0.6;

export function GeofenceMap({ value, onChange, address, readOnly = false }: Props) {
  const id = useId();
  // 지도 중심 = 핀 좌표. 픽셀 변환은 핀이 항상 정중앙
  const cx = MAP_W / 2;
  const cy = MAP_H / 2;
  const radiusPx = Math.min(MAP_W, MAP_H) / 2 - 12;
  const visualRadius = Math.min(value.radiusM * PX_PER_M, radiusPx);

  function patch<K extends keyof SiteGeofence>(k: K, v: SiteGeofence[K]) {
    onChange({ ...value, [k]: v });
  }

  // 지도 클릭 — 핀 미세 조정 (mock: 클릭 위치만큼 좌표 이동)
  function handleMapClick(e: React.MouseEvent<SVGSVGElement>) {
    if (readOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - cx;
    const dy = y - cy;
    // 1픽셀 ≈ 0.000009도 (대략 1m) — 시연용 근사
    const dLat = -dy * 0.000009;
    const dLng = dx * 0.000009;
    onChange({
      ...value,
      lat: Number((value.lat + dLat).toFixed(6)),
      lng: Number((value.lng + dLng).toFixed(6)),
    });
  }

  return (
    <div className="geofence">
      <div className="geofence__head">
        <span className="geofence__title">📍 출퇴근 정책 (지오펜싱)</span>
        {address && <span className="geofence__addr">{address}</span>}
      </div>

      <div className="geofence__body">
        {/* ── 좌측: 지도 ── */}
        <div className="geofence__map-wrap">
          <svg
            className={'geofence__map' + (readOnly ? ' is-ro' : '')}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            preserveAspectRatio="xMidYMid meet"
            onClick={handleMapClick}
            aria-label="현장 지도"
          >
            {/* 지도 배경 — 도로/건물 격자 패턴 */}
            <defs>
              <pattern id={`grid-${id}`} width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.6" />
              </pattern>
              <pattern id={`major-${id}`} width="60" height="60" patternUnits="userSpaceOnUse">
                <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#cbd5e1" strokeWidth="1.2" />
              </pattern>
              <radialGradient id={`fade-${id}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#0f766e" stopOpacity="0.18" />
                <stop offset="80%" stopColor="#0f766e" stopOpacity="0.06" />
                <stop offset="100%" stopColor="#0f766e" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width={MAP_W} height={MAP_H} fill="#f8fafc" />
            <rect width={MAP_W} height={MAP_H} fill={`url(#grid-${id})`} />
            <rect width={MAP_W} height={MAP_H} fill={`url(#major-${id})`} />
            {/* mock 도로 — 가로/세로 굵은 선 */}
            <line x1="0" y1={cy - 30} x2={MAP_W} y2={cy - 30} stroke="#fef9c3" strokeWidth="6" />
            <line x1="0" y1={cy + 50} x2={MAP_W} y2={cy + 50} stroke="#fef9c3" strokeWidth="6" />
            <line x1={cx - 80} y1="0" x2={cx - 80} y2={MAP_H} stroke="#fef9c3" strokeWidth="6" />
            <line x1={cx + 60} y1="0" x2={cx + 60} y2={MAP_H} stroke="#fef9c3" strokeWidth="6" />

            {/* 거리 눈금 — 50m / 100m / 150m */}
            {[50, 100, 150, 200].map((m) => {
              const r = m * PX_PER_M;
              if (r > radiusPx) return null;
              return (
                <g key={m}>
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke="#cbd5e1" strokeWidth="0.6" strokeDasharray="2 3" />
                  <text x={cx + r + 3} y={cy + 3} fontSize="9" fill="#94a3b8">{m}m</text>
                </g>
              );
            })}

            {/* 지오펜스 반경 (현장 정책) */}
            <circle cx={cx} cy={cy} r={visualRadius} fill={`url(#fade-${id})`} stroke="#0f766e" strokeWidth="1.5" strokeDasharray="4 3" />

            {/* 현장 핀 */}
            <g transform={`translate(${cx}, ${cy})`}>
              <circle r="13" fill="#0f766e" opacity="0.18" />
              <circle r="6" fill="#0f766e" stroke="#fff" strokeWidth="2" />
            </g>

            {/* 안내 텍스트 */}
            {!readOnly && (
              <text x={MAP_W - 8} y={MAP_H - 8} textAnchor="end" fontSize="9" fill="#64748b">
                지도 클릭 → 핀 위치 미세조정
              </text>
            )}
          </svg>

          {/* 좌표 표시 */}
          <div className="geofence__coords">
            <span><strong>위도</strong> {value.lat.toFixed(6)}</span>
            <span><strong>경도</strong> {value.lng.toFixed(6)}</span>
            <button
              type="button"
              className="geofence__btn-tiny"
              onClick={() => alert('실 운영 단계 — 카카오맵 / 네이버맵으로 교체 예정')}
              disabled={readOnly}
            >
              📍 지도에서 검색
            </button>
          </div>
        </div>

        {/* ── 우측: 컨트롤 ── */}
        <div className="geofence__controls">
          {/* 반경 */}
          <label className="geofence__field">
            <span className="geofence__label">
              인증 반경
              <strong className="geofence__value">{value.radiusM}m</strong>
            </span>
            <input
              type="range"
              min={20}
              max={500}
              step={10}
              value={value.radiusM}
              onChange={(e) => patch('radiusM', Number(e.target.value))}
              disabled={readOnly}
            />
            <span className="geofence__hint">현장 좌표를 중심으로 한 인증 가능 거리</span>
          </label>

          {/* GPS 오차 */}
          <label className="geofence__field">
            <span className="geofence__label">
              GPS 오차 허용
              <strong className="geofence__value">±{value.gpsTolerance}m</strong>
            </span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={value.gpsTolerance}
              onChange={(e) => patch('gpsTolerance', Number(e.target.value))}
              disabled={readOnly}
            />
            <span className="geofence__hint">측정 정확도가 이보다 크면 「LOW_ACCURACY」</span>
          </label>

          {/* 위치 필수 정책 */}
          <div className="geofence__field">
            <span className="geofence__label">위치정보 수집</span>
            <div className="geofence__chips">
              {(
                [
                  ['REQUIRED', '필수', '위치 없으면 인증 거부'],
                  ['RECOMMENDED', '권장', '없어도 인증 허용 (경고만)'],
                  ['OPTIONAL', '선택', 'GPS 위치 미수집 허용'],
                ] as Array<[LocationRequirement, string, string]>
              ).map(([k, label, hint]) => (
                <button
                  key={k}
                  type="button"
                  className={'geofence__chip' + (value.locationRequired === k ? ' is-active' : '')}
                  onClick={() => patch('locationRequired', k)}
                  disabled={readOnly}
                  title={hint}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 현장 밖 정책 */}
          <div className="geofence__field">
            <span className="geofence__label">현장 밖 출근 시도</span>
            <div className="geofence__chips">
              {(
                [
                  ['BLOCK', '🚫 차단', '반경 밖이면 인증 거부'],
                  ['WARN', '⚠ 경고', '인증은 허용, 표시만 ⚠'],
                  ['ALLOW', '✓ 허용', '제한 없음'],
                ] as Array<[OutOfBoundsPolicy, string, string]>
              ).map(([k, label, hint]) => (
                <button
                  key={k}
                  type="button"
                  className={'geofence__chip' + (value.outOfBoundsPolicy === k ? ' is-active' : '')}
                  onClick={() => patch('outOfBoundsPolicy', k)}
                  disabled={readOnly}
                  title={hint}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
