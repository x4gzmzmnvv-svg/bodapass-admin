import { createContext, ReactNode, useContext, useReducer } from 'react';
import type {
  SignupCompanyInfo,
  SignupUserInfo,
  TermAgreement,
  TermKind,
} from '../api/types';

/**
 * 회원가입 3-step에서 공유되는 상태 (와이어프레임 003~005.png)
 *  Step 1: 약관 동의
 *  Step 2: 사용자/회사 정보 + 공인인증서
 *  Step 3: 가입 완료 (서버 응답을 보여줌)
 */

const REQUIRED_TERMS: TermKind[] = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'];
const OPTIONAL_TERMS: TermKind[] = ['PRIVACY_THIRD_PARTY', 'MARKETING'];
export const ALL_TERMS: TermKind[] = [...REQUIRED_TERMS, ...OPTIONAL_TERMS];

export const TERM_LABELS: Record<TermKind, string> = {
  TERMS_OF_SERVICE: '회원가입약관 (필수)',
  PRIVACY_POLICY: '개인정보처리방침 (필수)',
  PRIVACY_THIRD_PARTY: '개인정보 제3자 제공 동의 (선택)',
  MARKETING: '마케팅 정보 수신 동의 (선택)',
};

export interface SignupState {
  // Step 1
  agreements: Record<TermKind, boolean>;

  // Step 2
  user: Partial<SignupUserInfo> & { passwordConfirm?: string };
  company: Partial<SignupCompanyInfo>;
  /** 아이디 중복 확인 결과 */
  loginIdChecked: boolean;
  /** 공인인증서 업로드 후 받은 ID */
  certificateId?: string;
  certificateFileName?: string;

  // Step 3 — 서버 응답 보관
  result?: {
    userId: string;
    companyId: string;
    loginId: string;
    createdAt: string;
  };
}

const initialState: SignupState = {
  agreements: {
    TERMS_OF_SERVICE: false,
    PRIVACY_POLICY: false,
    PRIVACY_THIRD_PARTY: false,
    MARKETING: false,
  },
  user: {},
  company: { isConstructionCompany: true },
  loginIdChecked: false,
};

type Action =
  | { type: 'set_agreement'; kind: TermKind; agreed: boolean }
  | { type: 'set_all_agreements'; agreed: boolean }
  | { type: 'set_user'; patch: Partial<SignupState['user']> }
  | { type: 'set_company'; patch: Partial<SignupCompanyInfo> }
  | { type: 'set_login_id_checked'; checked: boolean }
  | { type: 'set_certificate'; certificateId?: string; fileName?: string }
  | { type: 'set_result'; result: SignupState['result'] }
  | { type: 'reset' };

function reducer(state: SignupState, action: Action): SignupState {
  switch (action.type) {
    case 'set_agreement':
      return {
        ...state,
        agreements: { ...state.agreements, [action.kind]: action.agreed },
      };
    case 'set_all_agreements':
      return {
        ...state,
        agreements: ALL_TERMS.reduce(
          (acc, k) => ({ ...acc, [k]: action.agreed }),
          {} as Record<TermKind, boolean>,
        ),
      };
    case 'set_user':
      return {
        ...state,
        user: { ...state.user, ...action.patch },
        // 아이디가 바뀌면 중복확인 무효
        loginIdChecked:
          action.patch.loginId !== undefined && action.patch.loginId !== state.user.loginId
            ? false
            : state.loginIdChecked,
      };
    case 'set_company':
      return { ...state, company: { ...state.company, ...action.patch } };
    case 'set_login_id_checked':
      return { ...state, loginIdChecked: action.checked };
    case 'set_certificate':
      return {
        ...state,
        certificateId: action.certificateId,
        certificateFileName: action.fileName,
      };
    case 'set_result':
      return { ...state, result: action.result };
    case 'reset':
      return initialState;
  }
}

interface SignupCtx {
  state: SignupState;
  dispatch: React.Dispatch<Action>;
  /** Step 1 → 다음으로 진행 가능한지 (필수 약관 모두 동의) */
  canProceedFromStep1: boolean;
  /** 동의된 약관을 TermAgreement[] 형태로 반환 (서버 제출용) */
  buildAgreements: () => TermAgreement[];
}

const Ctx = createContext<SignupCtx | null>(null);

export function SignupProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const canProceedFromStep1 = REQUIRED_TERMS.every((k) => state.agreements[k]);

  const buildAgreements = (): TermAgreement[] => {
    const now = new Date().toISOString();
    return ALL_TERMS.map((kind) => ({
      kind,
      agreed: state.agreements[kind],
      agreedAt: state.agreements[kind] ? now : undefined,
    }));
  };

  return (
    <Ctx.Provider value={{ state, dispatch, canProceedFromStep1, buildAgreements }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSignup() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSignup must be used within <SignupProvider>');
  return ctx;
}
