import { useNavigate } from 'react-router-dom';
import { ALL_TERMS, TERM_LABELS, useSignup } from '../../contexts/SignupContext';
import type { TermKind } from '../../api/types';
import { PRIVACY_SECTIONS, PRIVACY_VERSION } from '../../utils/privacyPolicy';
import { SignupLayout } from './SignupLayout';
import './SignupStep1.css';

/**
 * Step 1 — 회원가입약관 + 개인정보처리방침 동의
 * 와이어프레임 003.png + 개인정보 지침.pdf 12조항 반영
 */
export function SignupStep1() {
  const navigate = useNavigate();
  const { state, dispatch, canProceedFromStep1 } = useSignup();

  const allChecked = ALL_TERMS.every((k) => state.agreements[k]);

  function toggleAll(checked: boolean) {
    dispatch({ type: 'set_all_agreements', agreed: checked });
  }
  function toggleOne(kind: TermKind, checked: boolean) {
    dispatch({ type: 'set_agreement', kind, agreed: checked });
  }
  function goNext() {
    if (!canProceedFromStep1) return;
    navigate('/signup?step=2');
  }

  return (
    <SignupLayout currentStep={1}>
      <div className="su1">
        <header className="su1__header">
          <h1 className="su1__title">회원가입약관 및 개인정보처리방침</h1>
          <p className="su1__sub">
            서비스 이용에 앞서 약관과 개인정보 처리 방침을 확인해 주세요.
          </p>
        </header>

        <div className="su1__notice" role="alert">
          <span className="su1__notice-mark" aria-hidden>!</span>
          <p>
            아래 내용은 일당백 서비스 이용에 동의하는 데 필요한 필수·선택 약관입니다.
            <br />
            필수 항목에 동의하지 않으시면 회원가입이 진행되지 않습니다.
          </p>
        </div>

        {/* 회원가입약관 */}
        <TermCard
          kind="TERMS_OF_SERVICE"
          title="회원가입약관 (필수)"
          checked={state.agreements.TERMS_OF_SERVICE}
          onChange={(c) => toggleOne('TERMS_OF_SERVICE', c)}
        >
          <p>
            <strong>제1조 (목적)</strong>
            <br />이 약관은 (주)AKOMA가 제공하는 일당백 서비스(이하 "서비스")의 이용 조건과 절차,
            회사와 회원 간의 권리·의무·책임사항을 규정함을 목적으로 합니다.
          </p>
          <p>
            <strong>제2조 (서비스의 제공)</strong>
            <br />회사는 회원의 출퇴근 인증, 팀원 관리, 임금 정산, 현장 공지 등 건설현장
            노무관리에 필요한 기능을 제공합니다.
          </p>
          <p>
            <strong>제3조 (이용 계약의 성립)</strong>
            <br />이용 계약은 회원이 약관에 동의하고 회사가 정한 가입 양식에 정보를 입력해
            가입 신청을 한 뒤 회사가 이를 승낙함으로써 성립합니다.
          </p>
          <p>
            <strong>제4조 (회원의 의무)</strong>
            <br />회원은 본인의 ID·비밀번호를 타인에게 양도·대여해서는 안 되며, 등록된
            팀원의 신분증·얼굴·계좌 등 개인정보를 본 서비스 목적 외로 사용해서는 안 됩니다.
          </p>
          <p>
            <strong>제5조 (서비스 이용 제한)</strong>
            <br />회원이 본 약관 또는 관계 법령을 위반한 경우 회사는 사전 통지 없이 서비스
            이용을 제한할 수 있습니다.
          </p>
        </TermCard>

        {/* 개인정보처리방침안내 — "개인정보 지침.pdf" 12조항 그대로 적용 */}
        <TermCard
          kind="PRIVACY_POLICY"
          title={`개인정보처리방침안내 (필수) · ${PRIVACY_VERSION}`}
          checked={state.agreements.PRIVACY_POLICY}
          onChange={(c) => toggleOne('PRIVACY_POLICY', c)}
        >
          <p style={{ marginBottom: 12 }}>
            주식회사 홍(이하 ‘회사’)은 「개인정보 보호법」 등 관계 법령에 따라 정보주체의
            개인정보를 보호하고, 개인정보 처리와 관련한 고충을 신속하고 원활하게 처리하기
            위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.
          </p>
          {PRIVACY_SECTIONS.map((s) => (
            <div key={s.title} className="su1__priv-sec">
              <p className="su1__priv-title">{s.title}</p>
              <div className="su1__priv-body">{s.body}</div>
            </div>
          ))}
          <p className="su1__priv-foot">
            * 본 처리방침의 전문은 마이 페이지 또는 회사 홈페이지의 ‘개인정보 처리방침’
            메뉴에서 언제든지 다시 열람할 수 있습니다.
          </p>
        </TermCard>

        {/* 선택 약관 */}
        <SimpleAgree
          kind="PRIVACY_THIRD_PARTY"
          checked={state.agreements.PRIVACY_THIRD_PARTY}
          onChange={(c) => toggleOne('PRIVACY_THIRD_PARTY', c)}
          description="현장 발주처·시공사와의 출근 정산 연동 시 필요한 최소 정보 제공에 동의합니다."
        />
        <SimpleAgree
          kind="MARKETING"
          checked={state.agreements.MARKETING}
          onChange={(c) => toggleOne('MARKETING', c)}
          description="신규 기능·이벤트·교육 자료 등의 안내를 SMS·이메일로 받습니다."
        />

        {/* 전체 동의 */}
        <div className="su1__all">
          <label className="su1__all-label">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            <span>회원가입에 필요한 약관에 모두 동의합니다.</span>
          </label>
        </div>

        {/* 액션 */}
        <div className="su1__actions">
          <button
            type="button"
            className="su1__btn su1__btn--ghost"
            onClick={() => navigate('/login')}
          >
            취소
          </button>
          <button
            type="button"
            className="su1__btn su1__btn--primary"
            onClick={goNext}
            disabled={!canProceedFromStep1}
          >
            Next Step
          </button>
        </div>

        {!canProceedFromStep1 && (
          <p className="su1__hint">
            * 필수 약관(<em>{TERM_LABELS.TERMS_OF_SERVICE.replace(' (필수)', '')}</em>,{' '}
            <em>{TERM_LABELS.PRIVACY_POLICY.replace(' (필수)', '')}</em>)에 모두 동의해야
            다음 단계로 진행할 수 있습니다.
          </p>
        )}
      </div>
    </SignupLayout>
  );
}

/* ───────── 약관 카드 ───────── */

interface TermCardProps {
  kind: TermKind;
  title: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}

function TermCard({ kind, title, checked, onChange, children }: TermCardProps) {
  return (
    <section className={`term-card ${checked ? 'is-checked' : ''}`}>
      <header className="term-card__head">
        <label className="term-card__check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            aria-label={`${title} 동의`}
          />
          <span className="term-card__title">{title}</span>
        </label>
      </header>
      <div className="term-card__body" data-kind={kind}>
        {children}
      </div>
    </section>
  );
}

/* ───────── 단순 동의 (선택 약관용) ───────── */

interface SimpleAgreeProps {
  kind: TermKind;
  checked: boolean;
  onChange: (c: boolean) => void;
  description: string;
}

function SimpleAgree({ kind, checked, onChange, description }: SimpleAgreeProps) {
  return (
    <label className="simple-agree">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <p className="simple-agree__title">{TERM_LABELS[kind]}</p>
        <p className="simple-agree__desc">{description}</p>
      </div>
    </label>
  );
}
