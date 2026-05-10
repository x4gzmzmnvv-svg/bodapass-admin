import { ChangeEvent, FormEvent, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from '../../components/Field';
import { signupApi } from '../../api/signup';
import { getErrorMessage } from '../../api/client';
import { useSignup } from '../../contexts/SignupContext';
import {
  formatBusinessNumber,
  formatPhone,
  isValidBirthDate,
  isValidBusinessNumber,
  isValidEmail,
  isValidLoginId,
  isValidName,
  isValidPassword,
  isValidPhone,
  passwordStrength,
} from '../../utils/validation';
import { SignupLayout } from './SignupLayout';
import './SignupStep2.css';

/**
 * Step 2 — 회원 가입 정보 입력
 *  와이어프레임 004.png:
 *   좌측: 사용자 정보 (아이디·비밀번호·이름·생년월일·휴대폰·이메일)
 *         + 회사 정보 (회사명·사업자번호·대표자·연락처·주소·담당자)
 *   우측: 공인인증서 등록 (건설회사면 필수)
 *   하단: 이전 / Next Step
 */
export function SignupStep2() {
  const navigate = useNavigate();
  const { state, dispatch, canProceedFromStep1 } = useSignup();

  const [pwConfirm, setPwConfirm] = useState(state.user.passwordConfirm ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [checkingId, setCheckingId] = useState(false);
  const [idCheckMsg, setIdCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploadingCert, setUploadingCert] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Step 1 미통과 시 Step 1으로 돌려보내기
  if (!canProceedFromStep1) {
    setTimeout(() => navigate('/signup', { replace: true }), 0);
    return null;
  }

  const u = state.user;
  const c = state.company;

  /* ───────── 필드별 에러 (제출 시도 후 표시) ───────── */
  const errors = useMemo(() => {
    const e: Record<string, string | undefined> = {};

    if (!u.loginId || !isValidLoginId(u.loginId))
      e.loginId = '영문 소문자/숫자 4~20자로 입력해주세요.';
    else if (!state.loginIdChecked) e.loginId = '아이디 중복 확인이 필요합니다.';

    if (!u.password || !isValidPassword(u.password))
      e.password = '8~20자, 영문·숫자·특수문자 중 2종 이상.';
    if (!pwConfirm) e.passwordConfirm = '비밀번호를 한 번 더 입력해주세요.';
    else if (u.password !== pwConfirm) e.passwordConfirm = '비밀번호가 일치하지 않습니다.';

    if (!u.name || !isValidName(u.name)) e.name = '이름을 정확히 입력해주세요.';
    if (!u.birthDate || !isValidBirthDate(u.birthDate))
      e.birthDate = '생년월일(YYYY-MM-DD)을 입력해주세요.';
    if (!u.phoneNumber || !isValidPhone(u.phoneNumber))
      e.phoneNumber = '예) 010-1234-5678';
    if (!u.email || !isValidEmail(u.email)) e.email = '이메일 형식이 올바르지 않습니다.';

    if (!c.companyName) e.companyName = '회사명을 입력해주세요.';
    if (!c.businessNumber || !isValidBusinessNumber(c.businessNumber))
      e.businessNumber = '사업자등록번호 10자리를 정확히 입력해주세요.';
    if (!c.representative) e.representative = '대표자명을 입력해주세요.';
    if (!c.representativePhone || !isValidPhone(c.representativePhone))
      e.representativePhone = '예) 010-1234-5678';
    if (!c.address) e.address = '주소를 입력해주세요.';
    if (!c.companyPhone || !isValidPhone(c.companyPhone))
      e.companyPhone = '예) 02-123-4567';
    if (!c.managerName) e.managerName = '담당자 성명을 입력해주세요.';
    if (!c.managerPhone || !isValidPhone(c.managerPhone))
      e.managerPhone = '예) 010-1234-5678';

    if (c.isConstructionCompany && !state.certificateId)
      e.certificate = '건설업 회사인 경우 공인인증서 등록이 필수입니다.';

    return e;
  }, [u, pwConfirm, c, state.loginIdChecked, state.certificateId]);

  const hasError = Object.values(errors).some(Boolean);
  const showErr = (key: string) => (submitted ? errors[key] : undefined);

  /* ───────── 핸들러 ───────── */
  function setU(patch: Partial<typeof u>) {
    dispatch({ type: 'set_user', patch });
  }
  function setC(patch: Partial<typeof c>) {
    dispatch({ type: 'set_company', patch });
  }

  async function checkId() {
    if (!u.loginId || !isValidLoginId(u.loginId)) {
      setIdCheckMsg({ ok: false, text: '아이디 형식을 먼저 확인해주세요.' });
      return;
    }
    setCheckingId(true);
    setIdCheckMsg(null);
    try {
      const res = await signupApi.checkLoginId(u.loginId);
      if (res.available) {
        dispatch({ type: 'set_login_id_checked', checked: true });
        setIdCheckMsg({ ok: true, text: '사용 가능한 아이디입니다.' });
      } else {
        dispatch({ type: 'set_login_id_checked', checked: false });
        setIdCheckMsg({
          ok: false,
          text: res.reason ?? '이미 사용 중인 아이디입니다.',
        });
      }
    } catch (err) {
      setIdCheckMsg({ ok: false, text: getErrorMessage(err, '중복확인 실패') });
    } finally {
      setCheckingId(false);
    }
  }

  async function handleCertChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadErr(null);
    setUploadingCert(true);
    try {
      const res = await signupApi.uploadCertificate(file);
      dispatch({
        type: 'set_certificate',
        certificateId: res.certificateId,
        fileName: file.name,
      });
    } catch (err) {
      setUploadErr(getErrorMessage(err, '인증서 업로드 실패'));
    } finally {
      setUploadingCert(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleNext(e?: FormEvent) {
    e?.preventDefault();
    setSubmitted(true);
    if (hasError) {
      // 첫 에러 필드로 스크롤
      const firstErrorKey = Object.keys(errors).find((k) => errors[k]);
      if (firstErrorKey) {
        const el = document.getElementById(`f-${firstErrorKey}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.focus({ preventScroll: true });
      }
      return;
    }
    // 비밀번호 확인은 별도로 보관
    setU({ passwordConfirm: pwConfirm });
    navigate('/signup?step=3');
  }

  /* ───────── 렌더 ───────── */

  return (
    <SignupLayout currentStep={2}>
      <form className="su2" onSubmit={handleNext} noValidate>
        <header className="su2__header">
          <h1 className="su2__title">회원 가입 정보 등록</h1>
          <p className="su2__sub">서비스 이용에 필요한 정보를 입력해주세요.</p>
        </header>

        <div className="su2__grid">
          {/* ── 좌측: 사용자/회사 정보 ── */}
          <div className="su2__left">
            <Section title="계정 정보">
              <Field
                id="f-loginId"
                label="아이디"
                required
                placeholder="영문 소문자/숫자 4~20자"
                value={u.loginId ?? ''}
                onChange={(v) => setU({ loginId: v.toLowerCase() })}
                helper={
                  idCheckMsg ? (
                    idCheckMsg.ok ? (
                      <span className="su2__ok">{idCheckMsg.text}</span>
                    ) : (
                      <span className="su2__warn">{idCheckMsg.text}</span>
                    )
                  ) : (
                    '영문 소문자와 숫자 조합 4~20자'
                  )
                }
                error={showErr('loginId')}
                trailing={
                  <button
                    type="button"
                    className="su2__check-btn"
                    onClick={checkId}
                    disabled={checkingId || !u.loginId}
                  >
                    {checkingId ? '확인 중…' : '중복확인'}
                  </button>
                }
              />

              <div className="su2__row">
                <Field
                  id="f-password"
                  label="비밀번호"
                  required
                  type="password"
                  autoComplete="new-password"
                  placeholder="8~20자 / 영문·숫자·특수문자 중 2종 이상"
                  value={u.password ?? ''}
                  onChange={(v) => setU({ password: v })}
                  helper={<PasswordMeter value={u.password ?? ''} />}
                  error={showErr('password')}
                />
                <Field
                  id="f-passwordConfirm"
                  label="비밀번호 확인"
                  required
                  type="password"
                  autoComplete="new-password"
                  placeholder="동일하게 한 번 더 입력"
                  value={pwConfirm}
                  onChange={(v) => setPwConfirm(v)}
                  error={showErr('passwordConfirm')}
                />
              </div>
            </Section>

            <Section title="사용자 정보">
              <div className="su2__row">
                <Field
                  id="f-name"
                  label="이름"
                  required
                  placeholder="홍길동"
                  value={u.name ?? ''}
                  onChange={(v) => setU({ name: v })}
                  error={showErr('name')}
                />
                <Field
                  id="f-birthDate"
                  label="생년월일"
                  required
                  type="date"
                  value={u.birthDate ?? ''}
                  onChange={(v) => setU({ birthDate: v })}
                  error={showErr('birthDate')}
                />
              </div>
              <div className="su2__row">
                <Field
                  id="f-phoneNumber"
                  label="휴대폰 번호"
                  required
                  inputMode="tel"
                  placeholder="010-1234-5678"
                  formatter={formatPhone}
                  value={u.phoneNumber ?? ''}
                  onChange={(v) => setU({ phoneNumber: v })}
                  error={showErr('phoneNumber')}
                />
                <Field
                  id="f-email"
                  label="이메일"
                  required
                  type="email"
                  inputMode="email"
                  placeholder="me@company.com"
                  value={u.email ?? ''}
                  onChange={(v) => setU({ email: v })}
                  error={showErr('email')}
                />
              </div>
            </Section>

            <Section title="회사 정보">
              <div className="su2__row">
                <Field
                  id="f-companyName"
                  label="회사명"
                  required
                  placeholder="(주)회사이름"
                  value={c.companyName ?? ''}
                  onChange={(v) => setC({ companyName: v })}
                  error={showErr('companyName')}
                />
                <Field
                  id="f-businessNumber"
                  label="사업자등록번호"
                  required
                  inputMode="numeric"
                  placeholder="123-45-67890"
                  formatter={formatBusinessNumber}
                  value={c.businessNumber ?? ''}
                  onChange={(v) => setC({ businessNumber: v })}
                  error={showErr('businessNumber')}
                />
              </div>

              <div className="su2__row">
                <Field
                  id="f-representative"
                  label="대표자명"
                  required
                  value={c.representative ?? ''}
                  onChange={(v) => setC({ representative: v })}
                  error={showErr('representative')}
                />
                <Field
                  id="f-representativePhone"
                  label="대표자 연락처"
                  required
                  inputMode="tel"
                  placeholder="010-1234-5678"
                  formatter={formatPhone}
                  value={c.representativePhone ?? ''}
                  onChange={(v) => setC({ representativePhone: v })}
                  error={showErr('representativePhone')}
                />
              </div>

              <Field
                id="f-address"
                label="회사 주소"
                required
                placeholder="도로명 주소"
                value={c.address ?? ''}
                onChange={(v) => setC({ address: v })}
                error={showErr('address')}
              />
              <Field
                label="상세주소"
                placeholder="동·호수 등 (선택)"
                value={c.addressDetail ?? ''}
                onChange={(v) => setC({ addressDetail: v })}
              />

              <div className="su2__row">
                <Field
                  id="f-companyPhone"
                  label="회사 대표 전화"
                  required
                  inputMode="tel"
                  placeholder="02-123-4567"
                  formatter={formatPhone}
                  value={c.companyPhone ?? ''}
                  onChange={(v) => setC({ companyPhone: v })}
                  error={showErr('companyPhone')}
                />
                <Field
                  label="회사 이메일 (선택)"
                  type="email"
                  placeholder="info@company.com"
                  value={c.companyEmail ?? ''}
                  onChange={(v) => setC({ companyEmail: v })}
                />
              </div>

              <div className="su2__row">
                <Field
                  id="f-managerName"
                  label="담당자 성명"
                  required
                  value={c.managerName ?? ''}
                  onChange={(v) => setC({ managerName: v })}
                  error={showErr('managerName')}
                />
                <Field
                  id="f-managerPhone"
                  label="담당자 핸드폰"
                  required
                  inputMode="tel"
                  formatter={formatPhone}
                  placeholder="010-1234-5678"
                  value={c.managerPhone ?? ''}
                  onChange={(v) => setC({ managerPhone: v })}
                  error={showErr('managerPhone')}
                />
              </div>

              <label className="su2__construction">
                <input
                  type="checkbox"
                  checked={c.isConstructionCompany ?? true}
                  onChange={(e) =>
                    setC({ isConstructionCompany: e.target.checked })
                  }
                />
                <span>건설회사입니다 (선택 시 공인인증서 등록 필수)</span>
              </label>
            </Section>
          </div>

          {/* ── 우측: 공인인증서 등록 ── */}
          <aside className="su2__right">
            <Section title="공인인증서 등록" required={c.isConstructionCompany}>
              <p className="su2__cert-desc">
                건설회사인 경우 사업자 명의의 <strong>공인인증서(.pfx)</strong>가 필요합니다.
                <br />
                일감 정산·전자서명에 사용됩니다.
              </p>

              <div className="su2__cert-zone">
                {state.certificateId ? (
                  <div className="su2__cert-uploaded">
                    <div className="su2__cert-mark" aria-hidden>
                      ✓
                    </div>
                    <div>
                      <p className="su2__cert-name">{state.certificateFileName}</p>
                      <p className="su2__cert-meta">업로드 완료</p>
                    </div>
                    <button
                      type="button"
                      className="su2__cert-remove"
                      onClick={() =>
                        dispatch({
                          type: 'set_certificate',
                          certificateId: undefined,
                          fileName: undefined,
                        })
                      }
                    >
                      삭제
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="su2__cert-upload"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingCert}
                  >
                    <span className="su2__cert-plus">＋</span>
                    {uploadingCert ? '업로드 중…' : '인증서 파일 등록'}
                    <span className="su2__cert-formats">
                      .pfx, .p12 / 최대 10MB
                    </span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pfx,.p12"
                  hidden
                  onChange={handleCertChange}
                />

                {(uploadErr || showErr('certificate')) && (
                  <p className="su2__cert-error">{uploadErr ?? showErr('certificate')}</p>
                )}
              </div>

              <div className="su2__cert-tip">
                <strong>Tip</strong> · 인증서가 아직 없다면 일단 가입을 마치고 마이페이지에서
                나중에 등록할 수 있어요. 단, 건설회사로 체크하셨다면 등록 전까지 일부 기능
                (정산·전자서명)이 잠깁니다.
              </div>
            </Section>
          </aside>
        </div>

        {/* 액션 행 */}
        <div className="su2__actions">
          <button
            type="button"
            className="su1__btn su1__btn--ghost"
            onClick={() => navigate('/signup?step=1')}
          >
            이전
          </button>
          <button type="submit" className="su1__btn su1__btn--primary">
            Next Step
          </button>
        </div>

        {submitted && hasError && (
          <p className="su2__overall-error">입력하지 않은 필수 항목이 있습니다. 다시 확인해 주세요.</p>
        )}
      </form>
    </SignupLayout>
  );
}

/* ───────── 보조 컴포넌트 ───────── */

function Section({
  title,
  required,
  children,
}: {
  title: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="su2-section">
      <h2 className="su2-section__title">
        {title}
        {required && <span className="su2-section__required">필수</span>}
      </h2>
      <div className="su2-section__body">{children}</div>
    </section>
  );
}

function PasswordMeter({ value }: { value: string }) {
  const score = passwordStrength(value);
  const labels = ['', '약함', '보통', '강함'] as const;
  const colors = ['', '#ef4444', '#f59e0b', '#007AFF'];
  return (
    <span className="pw-meter">
      <span className="pw-meter__bar">
        <span
          className="pw-meter__fill"
          style={{
            width: `${(score / 3) * 100}%`,
            background: colors[score] || 'transparent',
          }}
        />
      </span>
      {value && <span className="pw-meter__label">{labels[score]}</span>}
    </span>
  );
}
