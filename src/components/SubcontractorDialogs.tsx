// FILE_VERSION 1777740000
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Modal } from './Modal';
import { apiClient, getErrorMessage } from '../api/client';
import type { Site, SiteCompany, Company } from '../api/site.types';
import { SPECIALTY_OPTIONS, SPECIALTY_OTHER } from '../utils/specialty';
import { formatPhone } from '../utils/phone';
import './SubcontractorDialogs.css';

import { MacSelect } from './MacSelect';
/* ─────────────────────────────────────────
   하도급 등록 (초대) 다이얼로그
   - site 만 주면 그 현장에 하도급사 초대
   - sites + onSiteChange 까지 주면 다이얼로그 내부에서 현장 전환 가능
   ───────────────────────────────────────── */

export function SubcontractorInviteDialog({
  site,
  sites,
  onSiteChange,
  siteCompanies,
  companies,
  onClose,
}: {
  site: Site;
  /** 옵션 — 다이얼로그 내부에서 현장 변경을 허용 */
  sites?: Site[];
  /** 옵션 — sites 와 함께 사용 */
  onSiteChange?: (siteId: string) => void;
  siteCompanies: SiteCompany[];
  companies: Company[];
  onClose: () => void;
}) {
  const [companyName, setCompanyName] = useState('');
  // 공사 분야 — select 값('__OTHER__'면 자유입력) + 자유입력 텍스트
  const [specialtyKey, setSpecialtyKey] = useState<string>('');
  const [specialtyOther, setSpecialtyOther] = useState('');
  const specialty =
    specialtyKey === SPECIALTY_OTHER ? specialtyOther.trim() : specialtyKey;
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 발송 채널 — SMS / 카카오톡 (미리보기에서 선택)
  const [channel, setChannel] = useState<'SMS' | 'KAKAO'>('SMS');
  const code = site.inviteCode || 'BODA-' + site.id.slice(-6).toUpperCase();

  const companyById = new Map(companies.map((c) => [c.id, c] as const));
  const joined = siteCompanies.filter(
    (sc) => sc.siteId === site.id && sc.status === 'ACTIVE',
  );

  // 원도급사 회사명 (메시지 발신자 표시)
  const primeSC = siteCompanies.find(
    (sc) => sc.siteId === site.id && sc.role === '원도급',
  );
  const primeName = primeSC ? (companyById.get(primeSC.companyId)?.name ?? '원도급사') : '원도급사';

  // 발송할 메시지 본문 — 미리보기에 그대로 노출
  const previewMessage =
    `[보다패스 초대]\n` +
    `${companyName || '하도급사'} 귀하\n\n` +
    `「${site.name}」 현장에 하도급으로 참여를 요청드립니다.\n\n` +
    `· 발송: ${primeName}\n` +
    `· 공사 분야: ${specialty || '(미입력)'}\n` +
    `· 초대 코드: ${code}\n\n` +
    `▸ 합류 방법\n` +
    `1) 보다패스 앱·웹에 회원가입 또는 로그인\n` +
    `2) [코드로 합류] 메뉴에서 위 코드를 입력\n` +
    `3) 합류 후 자기 회사 작업자만 직접 등록·관리\n\n` +
    `본 메시지는 보다패스를 통해 자동 발송되었습니다.`;

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }

  /** 미리보기 모달 열기 (입력 검증 후) */
  function openPreview() {
    if (!companyName.trim() || !phone.trim()) {
      window.alert('하도급 회사명과 연락처를 입력해주세요.');
      return;
    }
    if (!specialtyKey) {
      window.alert('업종을 선택해주세요.');
      return;
    }
    if (specialtyKey === SPECIALTY_OTHER && !specialtyOther.trim()) {
      window.alert('업종 — 기타 항목을 직접 입력해주세요.');
      return;
    }
    setPreviewOpen(true);
  }

  /** 실제 발송 — 미리보기에서 확인 시 호출 */
  async function doSend() {
    setSending(true);
    try {
      // 시연: 실제로는 SMS/카톡 발송 + SiteCompany('INVITED') 행 생성
      await new Promise((r) => setTimeout(r, 350));
      setPreviewOpen(false);
      window.alert(
        `${companyName} (${specialty}) 에\n` +
          `${channel === 'KAKAO' ? '카카오톡' : 'SMS'} 으로 초대 메시지가 발송되었습니다.\n\n` +
          `초대 코드: ${code}\n` +
          `상대 회사가 보다패스에서 코드 입력 시 ${site.name} 에 자동 합류됩니다.`,
      );
      onClose();
    } finally {
      setSending(false);
    }
  }

  const canPickSite = !!sites && sites.length > 1 && !!onSiteChange;

  return (
    <>
    <Modal
      open
      onClose={onClose}
      title="하도급 등록 — 초대 코드 발송"
      subtitle={site.name}
      width={520}
      footer={
        <div className="sub-dlg__cta">
          <button
            type="button"
            className="sub-dlg__btn sub-dlg__btn--ghost"
            onClick={onClose}
            disabled={sending}
          >
            취소
          </button>
          <button
            type="button"
            className="sub-dlg__btn sub-dlg__btn--primary"
            onClick={openPreview}
            disabled={sending}
          >
            초대 코드 발송
          </button>
        </div>
      }
    >
      <div className="sub-dlg__body">
        <p className="sub-dlg__info">
          이 현장에 참여할 <strong>하도급사</strong>의 회사명·분야·담당자 연락처를 입력하면,
          상대에게 초대 코드가 발송됩니다. 가입 후 코드 입력 시 같은 현장에 합류해
          자기 작업자만 직접 등록·관리할 수 있습니다.
        </p>

        {canPickSite && (
          <FieldRow label="현장 선택">
            <MacSelect
              value={site.id}
              onChange={(v) => onSiteChange!(v)}
              className="sub-dlg__select"
              options={[...sites!.map((s) => (
                ({ value: s.id, label: s.name })
              ))]}
            />
          </FieldRow>
        )}

        <FieldRow label="하도급 회사명">
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="예) B철근(주)"
            className="sub-dlg__input"
          />
        </FieldRow>
        <FieldRow label="업종 (공사 분야)">
          <MacSelect
              value={specialtyKey}
              onChange={(v) => setSpecialtyKey(v)}
              className="sub-dlg__select"
              options={[{ value: "", label: '— 업종 선택 —' }, ...SPECIALTY_OPTIONS.map((o) => (
              ({ value: o.specialty, label: <>{o.specialty} · {o.industry}</> })
            )), { value: SPECIALTY_OTHER, label: '기타 (직접 입력)' }]}
            />
          {specialtyKey === SPECIALTY_OTHER && (
            <input
              type="text"
              value={specialtyOther}
              onChange={(e) => setSpecialtyOther(e.target.value)}
              placeholder="기타 업종 직접 입력 (예: 특수가설공사 등)"
              className="sub-dlg__input"
              style={{ marginTop: 6 }}
              autoFocus
            />
          )}
        </FieldRow>
        <FieldRow label="담당자 연락처">
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="010-1234-5678"
            className="sub-dlg__input"
            maxLength={13}
          />
        </FieldRow>
        <FieldRow label="초대 코드">
          <button
            type="button"
            onClick={handleCopyCode}
            title="클릭하여 복사"
            className={'sub-dlg__code-btn' + (copied ? ' is-copied' : '')}
          >
            <span>{code}</span>
            <small>{copied ? '복사됨' : '복사'}</small>
          </button>
        </FieldRow>

        {joined.length > 0 && (
          <div className="sub-dlg__joined">
            <div className="sub-dlg__joined-title">
              현재 합류된 회사 ({joined.length})
            </div>
            <ul className="sub-dlg__joined-list">
              {joined.map((sc) => {
                const co = companyById.get(sc.companyId);
                const tone =
                  sc.role === '원도급' ? 'prime'
                  : sc.role === '감리' || sc.role === '품질' || sc.role === '안전' ? 'super'
                  : 'sub';
                return (
                  <li key={sc.id} className="sub-dlg__joined-item">
                    <span className="sub-dlg__joined-left">
                      <span className={'sub-dlg__role-pill sub-dlg__role-pill--' + tone}>
                        {sc.role}
                      </span>
                      <strong className="sub-dlg__joined-name">
                        {co?.name ?? sc.companyId}
                      </strong>
                      {(sc.trade ?? sc.specialty) && (
                        <em className="sub-dlg__joined-spec">· {sc.trade ?? sc.specialty}</em>
                      )}
                    </span>
                    <span className="sub-dlg__joined-date">
                      합류 {sc.joinedAt.slice(0, 10)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Modal>

    {/* 미리보기 + 발송 확인 모달 — 채널 선택, 메시지 본문 노출, 발송 확인 */}
    {previewOpen && (
      <Modal
        open
        onClose={() => { if (!sending) setPreviewOpen(false); }}
        title="다음과 같이 발송하시겠습니까?"
        subtitle={`${companyName} · ${phone}`}
        width={560}
        footer={
          <div className="sub-dlg__cta">
            <button
              type="button"
              className="sub-dlg__btn sub-dlg__btn--ghost"
              onClick={() => setPreviewOpen(false)}
              disabled={sending}
            >
              취소
            </button>
            <button
              type="button"
              className="sub-dlg__btn sub-dlg__btn--primary"
              onClick={doSend}
              disabled={sending}
            >
              {sending ? '발송 중…' : '발송하기'}
            </button>
          </div>
        }
      >
        <div className="sub-dlg__body">
          <div className="sub-dlg__channel">
            <span className="sub-dlg__channel-label">발송 채널</span>
            <div className="sub-dlg__channel-tabs">
              <button
                type="button"
                className={'sub-dlg__channel-btn' + (channel === 'SMS' ? ' is-on' : '')}
                onClick={() => setChannel('SMS')}
                disabled={sending}
              >
                SMS
              </button>
              <button
                type="button"
                className={'sub-dlg__channel-btn' + (channel === 'KAKAO' ? ' is-on' : '')}
                onClick={() => setChannel('KAKAO')}
                disabled={sending}
              >
                카카오톡
              </button>
            </div>
          </div>

          <div className="sub-dlg__preview">
            <div className="sub-dlg__preview-head">
              <span className="sub-dlg__preview-from">
                보낸 사람: {primeName}
              </span>
              <span className="sub-dlg__preview-to">
                받는 사람: {phone}
              </span>
            </div>
            <pre className="sub-dlg__preview-body">{previewMessage}</pre>
          </div>

          <p className="sub-dlg__preview-note">
            확인을 누르면 위 메시지가 {channel === 'KAKAO' ? '카카오 알림톡' : 'SMS'}으로 발송되며,
            현장에 「초대 발송」 상태로 회사가 등록됩니다.
          </p>
        </div>
      </Modal>
    )}
    </>
  );
}

/* ─────────────────────────────────────────
   초대 코드로 합류 다이얼로그
   - 우리 회사가 다른 원도급사 현장에 하도급으로 합류
   ───────────────────────────────────────── */

export function JoinByCodeDialog({
  companyId,
  companyName,
  onClose,
  onJoined,
}: {
  companyId: string;
  companyName: string;
  onClose: () => void;
  onJoined: () => void | Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [specialtyKey, setSpecialtyKey] = useState<string>('');
  const [specialtyOther, setSpecialtyOther] = useState('');
  const specialty =
    specialtyKey === SPECIALTY_OTHER ? specialtyOther.trim() : specialtyKey;
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function handleJoin() {
    setErrMsg(null);
    if (!code.trim()) {
      setErrMsg('초대 코드를 입력해주세요.');
      return;
    }
    if (!companyId) {
      setErrMsg('회사 정보를 불러올 수 없습니다.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiClient.post<{
        siteCompany: SiteCompany;
        site: Site;
        message: string;
      }>('/site-companies/join', {
        inviteCode: code.trim().toUpperCase(),
        companyId,
        specialty: specialty.trim() || undefined,
      });
      window.alert(
        `${res.data.site.name} 에\n` +
          `${companyName} 가 하도급으로 합류되었습니다.\n\n` +
          `이제 대시보드에 이 현장이 표시되며, 자기 회사 작업자만 등록·관리할 수 있습니다.`,
      );
      await onJoined();
    } catch (err) {
      setErrMsg(getErrorMessage(err, '합류에 실패했습니다.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="초대 코드로 합류"
      subtitle={`현재 회사: ${companyName}`}
      width={500}
      footer={
        <div className="sub-dlg__cta">
          <button
            type="button"
            className="sub-dlg__btn sub-dlg__btn--ghost"
            onClick={onClose}
            disabled={submitting}
          >
            취소
          </button>
          <button
            type="button"
            className="sub-dlg__btn sub-dlg__btn--primary"
            onClick={handleJoin}
            disabled={submitting}
          >
            {submitting ? '합류 중…' : '합류'}
          </button>
        </div>
      }
    >
      <div className="sub-dlg__body">
        <p className="sub-dlg__info">
          원도급사로부터 SMS·카카오톡으로 받은 <strong>초대 코드</strong>를 입력하면
          그 현장에 우리 회사가 <strong>하도급</strong>으로 합류합니다. 합류 후엔 그 현장이
          대시보드에 자동 표시되며, 자기 작업자만 직접 등록·관리할 수 있습니다.
        </p>

        <FieldRow label="초대 코드">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="예) GANG1043"
            className="sub-dlg__input sub-dlg__input--code"
            autoFocus
          />
        </FieldRow>
        <FieldRow label="우리 업종 (공사 분야)">
          <MacSelect
              value={specialtyKey}
              onChange={(v) => setSpecialtyKey(v)}
              className="sub-dlg__select"
              options={[{ value: "", label: '(선택) 업종을 골라주세요' }, ...SPECIALTY_OPTIONS.map((o) => (
              ({ value: o.specialty, label: <>{o.specialty} · {o.industry}</> })
            )), { value: SPECIALTY_OTHER, label: '기타 (직접 입력)' }]}
            />
          {specialtyKey === SPECIALTY_OTHER && (
            <input
              type="text"
              value={specialtyOther}
              onChange={(e) => setSpecialtyOther(e.target.value)}
              placeholder="기타 업종 직접 입력"
              className="sub-dlg__input"
              style={{ marginTop: 6 }}
              autoFocus
            />
          )}
        </FieldRow>

        {errMsg && <p className="sub-dlg__error">{errMsg}</p>}
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────
   라벨 + 입력 가로 행 (내부 헬퍼)
   ───────────────────────────────────────── */

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sub-dlg__row">
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}
