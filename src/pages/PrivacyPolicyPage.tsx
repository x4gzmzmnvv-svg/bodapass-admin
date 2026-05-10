import { Link } from 'react-router-dom';
import { PRIVACY_EFFECTIVE_DATE, PRIVACY_SECTIONS, PRIVACY_VERSION } from '../utils/privacyPolicy';
import './PrivacyPolicyPage.css';

/**
 * 개인정보 처리방침 — 비인증 상태에서도 접근 가능한 정적 페이지.
 *  로그인 화면 / 알림톡 안내 본문에서 직접 링크.
 *  내용은 src/utils/privacyPolicy.tsx 의 PRIVACY_SECTIONS 단일 소스를 사용.
 */
export function PrivacyPolicyPage() {
  return (
    <div className="privacy">
      <header className="privacy__head">
        <Link to="/login" className="privacy__back">← 로그인으로</Link>
        <h1 className="privacy__title">개인정보 처리방침</h1>
        <p className="privacy__meta">
          {PRIVACY_VERSION} · 시행 {PRIVACY_EFFECTIVE_DATE}
        </p>
      </header>

      <article className="privacy__body">
        <p className="privacy__intro">
          주식회사 홍(이하 ‘회사’)은 「개인정보 보호법」 등 관계 법령에 따라 정보주체의
          개인정보를 보호하고, 개인정보 처리와 관련한 고충을 신속하고 원활하게 처리하기
          위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.
        </p>

        {PRIVACY_SECTIONS.map((s) => (
          <section key={s.title} className="privacy__sec">
            <h2 className="privacy__sec-title">{s.title}</h2>
            <div className="privacy__sec-body">{s.body}</div>
          </section>
        ))}
      </article>

      <footer className="privacy__foot">
        본 처리방침의 사본을 PDF로 받으시려면 회사로 요청해주세요. 발송 채널은 SMS·
        이메일·종이 출력 중 선택할 수 있습니다.
      </footer>
    </div>
  );
}
