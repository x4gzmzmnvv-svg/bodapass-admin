import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Field } from '../components/Field';
import { teamApi } from '../api/team';
import { siteApi } from '../api/site';
import type { WorkerRole } from '../api/team.types';
import type { Foreman, Site } from '../api/site.types';
import { getErrorMessage } from '../api/client';
import { formatPhone, isValidPhone } from '../utils/validation';
import { RoleSelect } from '../components/RoleSelect';
import './TeamInvitePage.css';

import { MacSelect } from '../components/MacSelect';
interface InviteRow {
  name: string;
  phone: string;
  role: WorkerRole;
}

const EMPTY: InviteRow = { name: '', phone: '', role: '' };

/**
 * 팀원 온라인(비대면) 초대 — 와이어프레임 016.png
 * 관리자/반장이 이름·전화·직종만 입력 → SMS URL 발송 → 팀원이 자기 폰에서 등록.
 *
 * 다수 동시에 초대 가능.
 */
interface TeamInvitePageProps {
  /** 모달 안에서 임베드되어 사용될 때 true — PageHeader 숨기고 onClose/onSent 콜백을 사용한다 */
  embedded?: boolean;
  onClose?: () => void;
  onSent?: () => void | Promise<void>;
}

const FLOW_STEPS: { n: number; title: string; desc: string }[] = [
  { n: 1, title: '관리자 입력', desc: '이름·휴대폰' },
  { n: 2, title: 'SMS 발송', desc: '팀원에게' },
  { n: 3, title: '팀원 셀프 등록', desc: '신분증·얼굴·통장' },
  { n: 4, title: '등록 완료', desc: 'SMS 토큰' },
];

export function TeamInvitePage({ embedded = false, onClose, onSent }: TeamInvitePageProps = {}) {
  const navigate = useNavigate();
  const closeOrNav = () => {
    if (embedded) onClose?.();
    else navigate('/team');
  };
  const [sites, setSites] = useState<Site[]>([]);
  const [foremen, setForemen] = useState<Foreman[]>([]);
  const [siteId, setSiteId] = useState<string>('');
  const [foremanId, setForemanId] = useState<string>('');
  const [rows, setRows] = useState<InviteRow[]>([EMPTY, EMPTY]);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ count: number } | null>(null);

  useEffect(() => {
    Promise.all([siteApi.listSites(), siteApi.listForemen()]).then(([s, f]) => {
      setSites(s.sites);
      setForemen(f.foremen);
      if (s.sites.length > 0 && !siteId) {
        const firstSiteId = s.sites[0].id;
        setSiteId(firstSiteId);
        const firstForeman = f.foremen.find((x) => x.siteId === firstSiteId);
        setForemanId(firstForeman?.id ?? '');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    const firstForeman = foremen.find((x) => x.siteId === nextSiteId);
    setForemanId(firstForeman?.id ?? '');
  }

  const visibleForemen = foremen.filter((f) => f.siteId === siteId);

  function setRow(i: number, p: Partial<InviteRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, EMPTY]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrMsg(null);
    setDone(null);

    if (!siteId) {
      setErrMsg('현장을 선택해주세요.');
      return;
    }
    const filled = rows.filter((r) => r.name.trim() || r.phone.trim());
    if (filled.length === 0) {
      setErrMsg('한 명 이상의 정보를 입력해주세요.');
      return;
    }
    const invalid = filled.find(
      (r) => !r.name.trim() || !r.phone.trim() || !isValidPhone(r.phone),
    );
    if (invalid) {
      setErrMsg('각 행의 이름·휴대폰 형식을 확인해주세요.');
      return;
    }

    setSubmitting(true);
    let okCount = 0;
    try {
      // __SITE_MANAGER__ 는 백엔드로 보내지 않음 (관리주체 = 현장담당자 라는 메타 정보만 메모)
      const realForemanId =
        foremanId && foremanId !== '__SITE_MANAGER__' ? foremanId : undefined;
      for (const row of filled) {
        await teamApi.invite({
          siteId,
          name: row.name.trim(),
          phone: row.phone,
          role: row.role,
          foremanId: realForemanId,
        });
        okCount++;
      }
      setDone({ count: okCount });
      setTimeout(() => {
        if (embedded) {
          void onSent?.();
        } else {
          navigate('/team');
        }
      }, 1400);
    } catch (err) {
      setErrMsg(getErrorMessage(err, '초대 발송 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={embedded ? "tip tip--embedded" : "tip"}>
      {!embedded && <PageHeader
        title="온라인 등록 (SMS)"
        subtitle="이름·휴대폰만 입력하면 팀원이 직접 신분증/얼굴/통장을 등록합니다."
        actions={
          <button
            type="button"
            className="trp__back"
            onClick={closeOrNav}
          >
            ← 목록으로
          </button>
        }
      />}

      {/* 흐름 — 4단계 인라인 스텝퍼 (점 + 연결선 + 라벨, 외곽 카드 없음) */}
      <ol className="tip-steps" aria-label="온라인 등록 흐름">
        {FLOW_STEPS.map((s, i) => (
          <li key={s.n} className="tip-steps__row">
            <div className="tip-steps__step is-pending">
              <span className="tip-steps__dot">{s.n}</span>
              <span className="tip-steps__label">{s.title}</span>
              <span className="tip-steps__sub">{s.desc}</span>
            </div>
            {i < FLOW_STEPS.length - 1 && (
              <span className="tip-steps__line" aria-hidden />
            )}
          </li>
        ))}
      </ol>

      <form className="tip__form card" onSubmit={handleSubmit} noValidate>
        <div className="tip__top">
          <div className="tip__select">
            <label>배정 현장</label>
            <MacSelect
              value={siteId}
              onChange={(v) => pickSite(v)}
              options={sites.length === 0
                ? [{ value: '', label: '— 등록된 현장이 없습니다 —' }]
                : sites.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div className="tip__select">
            <label>관리 반장</label>
            <MacSelect
              value={foremanId}
              onChange={(v) => setForemanId(v)}
              options={(() => {
                const opts: { value: string; label: React.ReactNode; disabled?: boolean }[] = [
                  { value: '', label: '선택해주세요 (미선택 시 현장담당자로 배정)' },
                ];
                const cur = sites.find((s) => s.id === siteId);
                if (cur?.manager) {
                  opts.push({
                    value: '__SITE_MANAGER__',
                    label: `현장담당자 — ${cur.manager}${cur.managerPhone ? ' · ' + cur.managerPhone : ''} (반장 없을 때)`,
                  });
                }
                visibleForemen.forEach((f) => {
                  opts.push({
                    value: f.id,
                    label: `${f.name}${f.role ? ` (${f.role})` : ''}${f.registered ? '' : ' · 가입 대기'}`,
                  });
                });
                if (visibleForemen.length === 0) {
                  opts.push({ value: '', label: '— 이 현장에 등록된 반장이 없습니다 —', disabled: true });
                }
                return opts;
              })()}
            />
          </div>
        </div>

        <div className="tip__rows">
          {rows.map((r, idx) => (
            <div key={idx} className="tip-row">
              <Field
                label={idx === 0 ? '이름' : ''}
                placeholder="홍길동"
                lang="ko"
                value={r.name}
                onChange={(v) => setRow(idx, { name: v })}
              />
              <Field
                label={idx === 0 ? '휴대폰' : ''}
                placeholder="010-1234-5678"
                inputMode="tel"
                formatter={formatPhone}
                value={r.phone}
                onChange={(v) => setRow(idx, { phone: v })}
              />
              <div className="trp__select-wrap">
                {idx === 0 && <label>직종</label>}
              <RoleSelect
                value={r.role}
                onChange={(v) => setRow(idx, { role: v })}
                placeholder="직종 선택"
              />
              </div>
              <button
                type="button"
                className="tip-row__remove"
                onClick={() => removeRow(idx)}
                disabled={rows.length <= 1 || submitting}
                aria-label="이 행 삭제"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="tip__add"
          onClick={addRow}
          disabled={submitting}
        >
          + 행 추가
        </button>

        {errMsg && <p className="tip__err">{errMsg}</p>}
        {done && (
          <p className="tip__ok">
            {done.count}명에게 SMS가 발송되었습니다. 팀원이 등록을 마치면 자동으로
            팀원 목록에 표시됩니다.
          </p>
        )}

        <div className="tip__cta">
          <button
            type="button"
            className="trp__btn trp__btn--ghost"
            onClick={closeOrNav}
          >
            취소
          </button>
          <button
            type="submit"
            className="trp__btn trp__btn--primary"
            disabled={submitting}
          >
            {submitting ? '발송 중…' : 'SMS 초대 발송'}
          </button>
        </div>
      </form>
    </div>
  );
}
