import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { siteApi } from '../api/site';
import { safetyApi } from '../api/safety';
import {
  buildAlertMessage,
  detectAllAlerts,
  fetchWeeklyForecast,
  type WeatherAlert,
} from '../utils/weatherForecast';
import type { Site } from '../api/site.types';
import './WeatherAlertBanner.css';

const SCHEDULED_KEY = 'bodapass.safety.weatherScheduled.v1';

interface ScheduledEntry {
  id: string;
  alertKey: string;        // siteId:date:kind
  siteId: string;
  siteName: string;
  date: string;
  kind: string;
  scheduledAt: string;     // ISO — 발송 예정 시각
  scheduledLabel: string;  // 사람이 읽는 라벨 (예: "5/5 17:00")
  message: string;
  channels: ('SMS' | 'APP')[];
  audience: string;        // 한국어 라벨
  createdAt: string;
}

function loadScheduled(): ScheduledEntry[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_KEY);
    return raw ? (JSON.parse(raw) as ScheduledEntry[]) : [];
  } catch {
    return [];
  }
}
function saveScheduled(rows: ScheduledEntry[]) {
  try {
    localStorage.setItem(SCHEDULED_KEY, JSON.stringify(rows));
  } catch { /* ignore */ }
}

function alertKey(siteId: string, a: WeatherAlert): string {
  return `${siteId}:${a.date}:${a.kind}`;
}

interface SiteAlert {
  site: Site;
  alert: WeatherAlert;
}

/**
 * 기상특보 기반 안전공지 자동 제안 배너.
 *
 *   - 7일 daily 예보를 가져와 강풍/호우/대설/뇌우/한파 위험 일자를 추출
 *   - 현장별로 row 표시 (현장 좌표 → 예보)
 *   - 「발송 검토」 클릭 → WeatherAlertDialog 모달
 *   - 작업 중단 권고(workSuspendLikely=true) 일자는 「전날 17시」 / 「당일 06시」 예약 옵션 노출
 *   - 예약 발송은 localStorage 에 저장 (백엔드 스케줄러 미연결, 시연 모드)
 */
export function WeatherAlertBanner({ onSent }: { onSent?: () => void }) {
  const [siteAlerts, setSiteAlerts] = useState<SiteAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [openAlert, setOpenAlert] = useState<SiteAlert | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledEntry[]>(() => loadScheduled());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const sitesRes = await siteApi.listSites();
        // 진행 중 현장만, 좌표(geofence) 가진 곳만 사용
        const targets = sitesRes.sites.filter(
          (s) => s.status === 'IN_PROGRESS' && s.geofence?.lat && s.geofence?.lng,
        );
        // 각 현장 7일 예보 fetch (병렬)
        const results = await Promise.all(
          targets.map(async (s) => {
            const days = await fetchWeeklyForecast(s.geofence!.lat, s.geofence!.lng);
            const alerts = detectAllAlerts(days);
            return { site: s, alerts };
          }),
        );
        if (cancelled) return;
        const flat: SiteAlert[] = [];
        for (const r of results) {
          for (const a of r.alerts) flat.push({ site: r.site, alert: a });
        }
        // CRITICAL 우선, 가까운 날짜 우선
        const order: Record<string, number> = { CRITICAL: 0, CAUTION: 1, INFO: 2 };
        flat.sort((a, b) => {
          const so = order[a.alert.severity] - order[b.alert.severity];
          if (so !== 0) return so;
          return a.alert.date.localeCompare(b.alert.date);
        });
        setSiteAlerts(flat.slice(0, 8));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function isScheduled(entry: SiteAlert): ScheduledEntry | null {
    const key = alertKey(entry.site.id, entry.alert);
    return scheduled.find((s) => s.alertKey === key) ?? null;
  }

  async function handleConfirm(payload: {
    siteAlert: SiteAlert;
    message: string;
    channels: ('SMS' | 'APP')[];
    audience: 'ALL_REGISTERED' | 'BY_FOREMAN' | 'WORKING_TODAY';
    timing: 'NOW' | 'PREV_17' | 'TODAY_06';
  }) {
    const { siteAlert, message, channels, audience, timing } = payload;
    if (timing === 'NOW') {
      // 즉시 발송 — 기존 safetyApi.sendMessage 사용
      try {
        await safetyApi.sendMessage({
          categoryId: null,
          categoryTitle: '기상 안전공지',
          message,
          severity: siteAlert.alert.severity === 'CRITICAL' ? 'CRITICAL' : 'CAUTION',
          audienceFilter: audience,
          siteId: siteAlert.site.id,
          channels,
          note: `weather:${siteAlert.alert.kind}:${siteAlert.alert.date}`,
        });
        window.alert(`${siteAlert.site.name}\n${siteAlert.alert.label} 안전공지 발송 완료`);
        onSent?.();
      } catch (err) {
        window.alert('발송 실패: ' + (err as Error).message);
      }
    } else {
      // 예약 발송 — localStorage 에 저장 (시연 모드)
      const sendDate = new Date(siteAlert.alert.date);
      let scheduledAt = '';
      let scheduledLabel = '';
      if (timing === 'PREV_17') {
        // 전날 17:00
        sendDate.setDate(sendDate.getDate() - 1);
        sendDate.setHours(17, 0, 0, 0);
        scheduledAt = sendDate.toISOString();
        scheduledLabel = `${sendDate.getMonth() + 1}/${sendDate.getDate()} 17:00 (전날 퇴근)`;
      } else {
        // 당일 06:00
        sendDate.setHours(6, 0, 0, 0);
        scheduledAt = sendDate.toISOString();
        scheduledLabel = `${sendDate.getMonth() + 1}/${sendDate.getDate()} 06:00 (당일 새벽)`;
      }
      const entry: ScheduledEntry = {
        id: 'wsch-' + Math.random().toString(36).slice(2, 9),
        alertKey: alertKey(siteAlert.site.id, siteAlert.alert),
        siteId: siteAlert.site.id,
        siteName: siteAlert.site.name,
        date: siteAlert.alert.date,
        kind: siteAlert.alert.kind,
        scheduledAt,
        scheduledLabel,
        message,
        channels,
        audience: audienceLabel(audience),
        createdAt: new Date().toISOString(),
      };
      const next = [...scheduled, entry];
      setScheduled(next);
      saveScheduled(next);
      window.alert(
        `${siteAlert.site.name}\n${siteAlert.alert.label} 안전공지가 ${scheduledLabel}에 자동 발송되도록 예약되었습니다.`,
      );
      onSent?.();
    }
    setOpenAlert(null);
  }

  function cancelScheduled(s: ScheduledEntry) {
    if (!confirm(`${s.siteName} ${s.scheduledLabel} 예약을 취소하시겠습니까?`)) return;
    const next = scheduled.filter((x) => x.id !== s.id);
    setScheduled(next);
    saveScheduled(next);
  }

  if (loading) {
    return (
      <div className="weather-alert weather-alert--loading">
        기상 예보 불러오는 중…
      </div>
    );
  }
  if (siteAlerts.length === 0 && scheduled.length === 0) return null;

  return (
    <section className="weather-alert">
      <header className="weather-alert__head">
        <h3>기상특보 안전공지 제안</h3>
        <p>7일 예보에서 강풍·호우·대설·뇌우·한파 위험 일자를 자동 감지합니다. 행을 눌러 발송을 검토하세요.</p>
      </header>

      {siteAlerts.length > 0 && (
        <ul className="weather-alert__list">
          {siteAlerts.map((sa, i) => {
            const sched = isScheduled(sa);
            const sev = sa.alert.severity;
            return (
              <li
                key={i}
                className={
                  'weather-alert__row' +
                  (sev === 'CRITICAL' ? ' is-critical' : sev === 'CAUTION' ? ' is-caution' : '')
                }
              >
                <div className="weather-alert__date">
                  <strong>{formatKDate(sa.alert.date)}</strong>
                  <span className="weather-alert__emoji" aria-hidden>
                    {sa.alert.forecast.emoji}
                  </span>
                </div>
                <div className="weather-alert__body">
                  <div className="weather-alert__label-row">
                    <span className={'weather-alert__chip is-' + sev.toLowerCase()}>
                      {sa.alert.label}
                    </span>
                    {sa.alert.workSuspendLikely && (
                      <span className="weather-alert__chip is-suspend">작업 중단 가능</span>
                    )}
                    <span className="weather-alert__site">{sa.site.name}</span>
                  </div>
                  <div className="weather-alert__msg">{sa.alert.message}</div>
                </div>
                <div className="weather-alert__action">
                  {sched ? (
                    <span className="weather-alert__scheduled">
                      예약됨 · {sched.scheduledLabel}
                      <button
                        type="button"
                        className="weather-alert__btn weather-alert__btn--ghost"
                        onClick={() => cancelScheduled(sched)}
                      >
                        취소
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="weather-alert__btn weather-alert__btn--primary"
                      onClick={() => setOpenAlert(sa)}
                    >
                      발송 검토
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {scheduled.length > 0 && (
        <details className="weather-alert__sched-list">
          <summary>예약된 안전공지 {scheduled.length}건</summary>
          <ul>
            {scheduled.map((s) => (
              <li key={s.id}>
                <strong>{s.siteName}</strong> · {formatKDate(s.date)}{' '}
                {WEATHER_KIND_KO[s.kind] ?? s.kind} → 발송 {s.scheduledLabel} ·{' '}
                {s.channels.join('+')} · {s.audience}
                <button
                  type="button"
                  className="weather-alert__btn weather-alert__btn--ghost"
                  onClick={() => cancelScheduled(s)}
                >
                  취소
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {openAlert && (
        <WeatherAlertDialog
          siteAlert={openAlert}
          onClose={() => setOpenAlert(null)}
          onConfirm={handleConfirm}
        />
      )}
    </section>
  );
}

const WEATHER_KIND_KO: Record<string, string> = {
  STRONG_WIND: '강풍',
  HEAVY_RAIN: '호우',
  HEAVY_SNOW: '대설',
  THUNDER: '뇌우',
  COLD_SHOCK: '한파',
};

function audienceLabel(a: 'ALL_REGISTERED' | 'BY_FOREMAN' | 'WORKING_TODAY'): string {
  if (a === 'BY_FOREMAN') return '반장 전체';
  if (a === 'WORKING_TODAY') return '오늘 출근자';
  return '전체 등록자';
}

function formatKDate(iso: string): string {
  const d = new Date(iso);
  const dows = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()}(${dows[d.getDay()]})`;
}

/* ───────── 발송 검토 다이얼로그 ───────── */

function WeatherAlertDialog({
  siteAlert,
  onClose,
  onConfirm,
}: {
  siteAlert: SiteAlert;
  onClose: () => void;
  onConfirm: (payload: {
    siteAlert: SiteAlert;
    message: string;
    channels: ('SMS' | 'APP')[];
    audience: 'ALL_REGISTERED' | 'BY_FOREMAN' | 'WORKING_TODAY';
    timing: 'NOW' | 'PREV_17' | 'TODAY_06';
  }) => void;
}) {
  const initialMessage = useMemo(
    () => buildAlertMessage(siteAlert.alert, siteAlert.site.name),
    [siteAlert],
  );
  const [message, setMessage] = useState(initialMessage);
  const [channels, setChannels] = useState<('SMS' | 'APP')[]>(['SMS', 'APP']);
  const [audience, setAudience] = useState<'ALL_REGISTERED' | 'BY_FOREMAN' | 'WORKING_TODAY'>(
    siteAlert.alert.workSuspendLikely ? 'ALL_REGISTERED' : 'WORKING_TODAY',
  );
  // 작업 중단 권고면 「전날 17시」 기본, 아니면 「지금」 기본
  const [timing, setTiming] = useState<'NOW' | 'PREV_17' | 'TODAY_06'>(
    siteAlert.alert.workSuspendLikely ? 'PREV_17' : 'NOW',
  );

  function toggleChannel(c: 'SMS' | 'APP') {
    setChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  const canSend = channels.length > 0 && message.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${siteAlert.site.name} — ${siteAlert.alert.label} 안전공지 발송`}
      subtitle={`${formatKDate(siteAlert.alert.date)} · ${siteAlert.alert.message}`}
      width={680}
    >
      <div className="weather-dlg">
        <div className="weather-dlg__field">
          <label>대상</label>
          <div className="weather-dlg__row">
            <button
              type="button"
              className={'weather-dlg__pill' + (audience === 'ALL_REGISTERED' ? ' is-on' : '')}
              onClick={() => setAudience('ALL_REGISTERED')}
            >
              전체 등록자
            </button>
            <button
              type="button"
              className={'weather-dlg__pill' + (audience === 'WORKING_TODAY' ? ' is-on' : '')}
              onClick={() => setAudience('WORKING_TODAY')}
            >
              오늘 출근자
            </button>
            <button
              type="button"
              className={'weather-dlg__pill' + (audience === 'BY_FOREMAN' ? ' is-on' : '')}
              onClick={() => setAudience('BY_FOREMAN')}
            >
              반장 전체
            </button>
          </div>
        </div>

        <div className="weather-dlg__field">
          <label>채널</label>
          <div className="weather-dlg__row">
            <button
              type="button"
              className={'weather-dlg__pill' + (channels.includes('SMS') ? ' is-on' : '')}
              onClick={() => toggleChannel('SMS')}
            >
              {channels.includes('SMS') ? '✓ ' : ''}문자(SMS)
            </button>
            <button
              type="button"
              className={'weather-dlg__pill' + (channels.includes('APP') ? ' is-on' : '')}
              onClick={() => toggleChannel('APP')}
            >
              {channels.includes('APP') ? '✓ ' : ''}앱 알림
            </button>
          </div>
        </div>

        <div className="weather-dlg__field">
          <label>발송 시각</label>
          <div className="weather-dlg__row">
            <button
              type="button"
              className={'weather-dlg__pill' + (timing === 'NOW' ? ' is-on' : '')}
              onClick={() => setTiming('NOW')}
            >
              즉시 발송
            </button>
            <button
              type="button"
              className={'weather-dlg__pill' + (timing === 'PREV_17' ? ' is-on' : '')}
              onClick={() => setTiming('PREV_17')}
            >
              전날 17:00 (퇴근 직전)
            </button>
            <button
              type="button"
              className={'weather-dlg__pill' + (timing === 'TODAY_06' ? ' is-on' : '')}
              onClick={() => setTiming('TODAY_06')}
            >
              당일 06:00 (새벽)
            </button>
          </div>
          {siteAlert.alert.workSuspendLikely && (
            <p className="weather-dlg__hint">
              ※ 작업 중단 가능성이 있어 「전날 17:00」 또는 「당일 06:00」 예약 발송이 권장됩니다.
            </p>
          )}
        </div>

        <div className="weather-dlg__field">
          <label>메시지 미리보기 (수정 가능)</label>
          <textarea
            className="weather-dlg__textarea"
            rows={10}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="weather-dlg__counter">{message.length}자</div>
        </div>

        <div className="weather-dlg__actions">
          <button type="button" className="weather-dlg__btn weather-dlg__btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="weather-dlg__btn weather-dlg__btn--primary"
            disabled={!canSend}
            onClick={() => onConfirm({ siteAlert, message, channels, audience, timing })}
          >
            {timing === 'NOW' ? '지금 발송' : '예약 발송'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
