import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signupApi } from '../../api/signup';
import { getErrorMessage } from '../../api/client';
import { useSignup } from '../../contexts/SignupContext';
import { SignupLayout } from './SignupLayout';
import './SignupStep3.css';

/**
 * Step 3 — 회원 가입 완료
 *  와이어프레임 005.png:
 *    - 큰 체크 아이콘 + 환영 메시지
 *    - 입력하신 정보 요약 (계정/회사/연락처/연락처)
 *    - 메인으로 이동 버튼
 *
 * 진입 시 자동으로 /auth/signup 호출 → 결과를 context.result 에 저장.
 */
export function SignupStep3() {
  const navigate = useNavigate();
  const { state, dispatch, buildAgreements, canProceedFromStep1 } = useSignup();
  const [submitting, setSubmitting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Step 1·2 미통과 시 처음으로
  useEffect(() => {
    if (!canProceedFromStep1) {
      navigate('/signup', { replace: true });
      return;
    }
    if (!state.user.loginId || !state.company.companyName) {
      navigate('/signup?step=2', { replace: true });
      return;
    }

    // 이미 결과가 있으면 (사용자가 새로고침/뒤로) 그대로 보여주기
    if (state.result) {
      setSubmitting(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await signupApi.submit({
          agreements: buildAgreements(),
          user: {
            loginId: state.user.loginId!,
            password: state.user.password!,
            name: state.user.name!,
            birthDate: state.user.birthDate!,
            phoneNumber: state.user.phoneNumber!,
            email: state.user.email!,
          },
          company: {
            companyName: state.company.companyName!,
            businessNumber: state.company.businessNumber!,
            representative: state.company.representative!,
            representativePhone: state.company.representativePhone!,
            address: state.company.address!,
            addressDetail: state.company.addressDetail,
            companyPhone: state.company.companyPhone!,
            companyEmail: state.company.companyEmail,
            managerName: state.company.managerName!,
            managerPhone: state.company.managerPhone!,
            isConstructionCompany: !!state.company.isConstructionCompany,
          },
          certificateId: state.certificateId,
        });
        if (cancelled) return;
        dispatch({
          type: 'set_result',
          result: {
            userId: res.userId,
            companyId: res.companyId,
            loginId: res.loginId,
            createdAt: res.createdAt,
          },
        });
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, '회원가입 처리에 실패했습니다.'));
      } finally {
        if (!cancelled) setSubmitting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 처리 중 ── */
  if (submitting) {
    return (
      <SignupLayout currentStep={3}>
        <div className="su3 su3--loading">
          <div className="su3__spinner" aria-hidden />
          <p className="su3__loading-title">가입 정보를 등록하고 있습니다…</p>
          <p className="su3__loading-sub">잠시만 기다려 주세요.</p>
        </div>
      </SignupLayout>
    );
  }

  /* ── 처리 실패 ── */
  if (error) {
    return (
      <SignupLayout currentStep={3}>
        <div className="su3 su3--error">
          <div className="su3__error-mark" aria-hidden>
            !
          </div>
          <h1 className="su3__title">가입 처리 중 문제가 발생했습니다</h1>
          <p className="su3__sub">{error}</p>
          <div className="su3__actions">
            <button
              type="button"
              className="su1__btn su1__btn--ghost"
              onClick={() => navigate('/signup?step=2')}
            >
              이전 단계로
            </button>
            <button
              type="button"
              className="su1__btn su1__btn--primary"
              onClick={() => window.location.reload()}
            >
              다시 시도
            </button>
          </div>
        </div>
      </SignupLayout>
    );
  }

  /* ── 처리 완료 ── */
  const result = state.result!;
  const u = state.user;
  const c = state.company;

  return (
    <SignupLayout currentStep={3}>
      <div className="su3">
        <div className="su3__icon" aria-hidden>
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 5 5L20 7" />
          </svg>
        </div>
        <h1 className="su3__title">회원가입이 완료되었습니다.</h1>
        <p className="su3__sub">
          <strong>{c.companyName}</strong>의 일당백 관리자 계정이 정상 등록되었습니다.
          <br />
          아래 정보를 확인하신 뒤 메인 페이지로 이동해 주세요.
        </p>

        {/* 가입 정보 요약 */}
        <section className="su3__summary card">
          <SummaryRow label="아이디" value={result.loginId} />
          <SummaryRow label="이름 / 담당자" value={`${u.name} / ${c.managerName}`} />
          <SummaryRow label="회사명" value={c.companyName ?? ''} />
          <SummaryRow
            label="사업자번호"
            value={c.businessNumber ?? ''}
            extra={c.isConstructionCompany ? '건설업' : undefined}
          />
          <SummaryRow
            label="회사 주소"
            value={[c.address, c.addressDetail].filter(Boolean).join(' ')}
          />
          <SummaryRow label="회사 대표 전화" value={c.companyPhone ?? ''} />
          <SummaryRow label="이메일" value={u.email ?? ''} />
          <SummaryRow
            label="공인인증서"
            value={
              state.certificateFileName
                ? `${state.certificateFileName} (등록됨)`
                : '미등록'
            }
            highlight={!state.certificateFileName && !!c.isConstructionCompany}
          />
          <SummaryRow
            label="가입 일시"
            value={formatDateTime(result.createdAt)}
          />
        </section>

        <div className="su3__notice">
          <p>
            <strong>다음 단계 안내</strong>
          </p>
          <ul>
            <li>로그인 후 사이드바에서 <em>현장 등록</em> → <em>반장 등록</em>까지 마치면 출퇴근 처리가 시작됩니다.</li>
            <li>
              {c.isConstructionCompany && !state.certificateFileName ? (
                <>
                  공인인증서가 아직 등록되지 않았습니다. <em>설정 &gt; 회사 정보</em>에서
                  추가 등록해주세요. (정산·전자서명 기능은 등록 후 활성화됩니다.)
                </>
              ) : (
                <>마이페이지에서 회사 로고·인장 이미지를 등록할 수 있습니다.</>
              )}
            </li>
          </ul>
        </div>

        <div className="su3__actions">
          <button
            type="button"
            className="su1__btn su1__btn--ghost"
            onClick={() => navigate('/login')}
          >
            로그인 화면으로
          </button>
          <button
            type="button"
            className="su1__btn su1__btn--primary"
            onClick={() => {
              dispatch({ type: 'reset' });
              navigate('/login');
            }}
          >
            메인으로
          </button>
        </div>
      </div>
    </SignupLayout>
  );
}

function SummaryRow({
  label,
  value,
  extra,
  highlight,
}: {
  label: string;
  value: string;
  extra?: string;
  highlight?: boolean;
}) {
  return (
    <div className="su3-row">
      <span className="su3-row__label">{label}</span>
      <span className={`su3-row__value ${highlight ? 'su3-row__value--warn' : ''}`}>
        {value || '-'}
        {extra && <span className="su3-row__chip">{extra}</span>}
      </span>
    </div>
  );
}

function formatDateTime(iso: string) {
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}.${m}.${dd} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}
