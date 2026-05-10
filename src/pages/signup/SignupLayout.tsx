import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './SignupLayout.css';

interface Step {
  step: 1 | 2 | 3;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    step: 1,
    title: '회원가입약관 및\n개인정보처리방침',
    description: '약관 내용을 확인하시고 동의해 주십시오.',
  },
  { step: 2, title: '사이트 이용 정보', description: '사이트 이용에 필요한 정보를 입력합니다.' },
  { step: 3, title: '회원 가입 완료', description: '회원이 되신 걸 환영합니다.' },
];

interface Props {
  currentStep: 1 | 2 | 3;
  children: ReactNode;
}

/**
 * 회원가입(회사 최초 등록) 공용 레이아웃
 *  - 좌측: 검정 바 + 빨간 "일당백" 로고 (와이어프레임 003.png)
 *  - 중앙: 단계 인디케이터 패널 (1/2/3)
 *  - 우측: 각 step의 컨텐츠
 */
export function SignupLayout({ currentStep, children }: Props) {
  return (
    <div className="signup-layout">
      {/* 좌측 브랜드 바 */}
      <aside className="signup-layout__brand">
        <Link to="/login" className="signup-layout__brand-mark" aria-label="로그인으로 이동">
          일당백
        </Link>
      </aside>

      {/* 중앙 단계 인디케이터 */}
      <aside className="signup-layout__steps">
        <h2 className="signup-layout__steps-title">
          회원 가입 절차
          <span className="signup-layout__steps-count">{currentStep} / 3</span>
        </h2>
        <ol className="signup-layout__steps-list" aria-label="회원가입 단계">
          {STEPS.map((s) => {
            const status =
              s.step < currentStep ? 'done' : s.step === currentStep ? 'active' : 'todo';
            return (
              <li key={s.step} className={`signup-step signup-step--${status}`}>
                <span className="signup-step__bullet">
                  {status === 'done' ? <CheckMark /> : s.step}
                </span>
                <div className="signup-step__body">
                  <p className="signup-step__title">{s.title}</p>
                  <p className="signup-step__desc">{s.description}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <p className="signup-layout__login-link">
          이미 가입하셨나요?{' '}
          <Link to="/login" className="signup-layout__login-link-strong">
            로그인
          </Link>
        </p>
      </aside>

      {/* 우측 메인 컨텐츠 */}
      <main className="signup-layout__main">{children}</main>
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
