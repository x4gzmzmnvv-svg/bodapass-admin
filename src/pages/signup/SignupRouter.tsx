import { useSearchParams } from 'react-router-dom';
import { SignupProvider } from '../../contexts/SignupContext';
import { SignupStep1 } from './SignupStep1';
import { SignupStep2 } from './SignupStep2';
import { SignupStep3 } from './SignupStep3';

/**
 * URL의 ?step= 으로 분기 (기본 1)
 *  /signup        → step 1 (약관 동의)
 *  /signup?step=2 → step 2 (사용자/회사 정보)
 *  /signup?step=3 → step 3 (가입 완료)
 *
 * SignupProvider 가 모든 스텝의 상태를 보유합니다 — 이전 단계로 돌아가도 입력값 유지.
 */
export function SignupRouter() {
  return (
    <SignupProvider>
      <SignupRouterInner />
    </SignupProvider>
  );
}

function SignupRouterInner() {
  const [params] = useSearchParams();
  const step = Number(params.get('step') ?? '1');

  if (step === 2) return <SignupStep2 />;
  if (step === 3) return <SignupStep3 />;
  return <SignupStep1 />;
}
