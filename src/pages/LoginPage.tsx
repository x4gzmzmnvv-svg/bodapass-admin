import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getErrorMessage } from '../api/client';
import './LoginPage.css';

/**
 * 관리자 로그인 페이지 (와이어프레임 002.png 기준)
 */
export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [loginId, setLoginId] = useState('akoma');
  const [password, setPassword] = useState('akoma');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (isAuthenticated) {
    const from = (location.state as { from?: Location })?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!loginId || !password) {
      setErrorMsg('아이디와 비밀번호를 입력해주세요.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await login({ loginId, password, remember });
      navigate('/', { replace: true });
    } catch (err) {
      setErrorMsg(getErrorMessage(err, '로그인에 실패했습니다.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-page__brand">
        <div className="login-page__logo">일당백</div>
        <div className="login-page__brand-copy">
          <p className="login-page__brand-title">
            출퇴근 관리,
            <br />
            얼굴 인식 한 번으로
          </p>
          <p className="login-page__brand-sub">
            건설 현장 반장이 팀원의 얼굴을 인식해
            <br />
            출/퇴근을 즉시 처리합니다.
          </p>
        </div>
        <p className="login-page__brand-foot">© AKOMA</p>
      </aside>

      <main className="login-page__form-wrap">
        <div className="login-page__form">
          <h1 className="login-page__title">안녕하세요, 일당백입니다.</h1>
          <p className="login-page__sub">
            쉽고, 편리하고 정확한 출퇴근 플랫폼.
            <br />
            아이디로 로그인해주세요.
          </p>

          <form onSubmit={handleSubmit} className="login-form">
            <label className="login-form__label" htmlFor="loginId">
              아이디
            </label>
            <input
              id="loginId"
              className="input"
              autoComplete="username"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="아이디를 입력하세요"
              disabled={submitting}
            />

            <label className="login-form__label" htmlFor="password">
              비밀번호
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력하세요"
              disabled={submitting}
            />

            <label className="login-form__remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>자동 로그인</span>
            </label>

            {errorMsg && <p className="login-form__error">{errorMsg}</p>}

            <button
              type="submit"
              className="login-form__submit"
              disabled={submitting}
            >
              {submitting ? '로그인 중…' : '로그인'}
            </button>

            <div className="login-form__divider">
              <span>또는</span>
            </div>

            <button
              type="button"
              className="login-form__alt"
              onClick={() => alert('휴대폰번호 로그인은 다음 단계에서 구현됩니다.')}
            >
              휴대폰번호로 계속하기
            </button>

            <div className="login-form__links">
              <button type="button" className="login-form__link">아이디 찾기</button>
              <span className="login-form__sep" aria-hidden />
              <button type="button" className="login-form__link">비밀번호 찾기</button>
              <span className="login-form__sep" aria-hidden />
              <button
                type="button"
                className="login-form__link login-form__link--strong"
                onClick={() => navigate('/signup')}
              >
                회원가입
              </button>
            </div>

            <p className="login-form__demo">
              데모 계정 — 아이디 <code>akoma</code> / 비번 <code>akoma</code>
            </p>
            <p className="login-form__demo" style={{ marginTop: 8 }}>
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--color-primary)', fontWeight: 600 }}
              >
                개인정보 처리방침 보기
              </a>
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
