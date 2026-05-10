import { apiClient } from './client';
import type {
  CertificateUploadResponse,
  CheckLoginIdResponse,
  SignupStep3Request,
  SignupResponse,
} from './types';

/** 회사 최초 등록 (관리자 회원가입) API */
export const signupApi = {
  /** Step 2 — 아이디 중복 확인 */
  checkLoginId: async (loginId: string): Promise<CheckLoginIdResponse> => {
    const { data } = await apiClient.get<CheckLoginIdResponse>('/auth/signup/check-id', {
      params: { loginId },
    });
    return data;
  },

  /** Step 2 — 공인인증서 업로드 (multipart) */
  uploadCertificate: async (file: File): Promise<CertificateUploadResponse> => {
    const form = new FormData();
    form.append('file', file);
    const { data } = await apiClient.post<CertificateUploadResponse>(
      '/auth/signup/upload-certificate',
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return data;
  },

  /** Step 3 — 최종 가입 제출 */
  submit: async (req: SignupStep3Request): Promise<SignupResponse> => {
    const { data } = await apiClient.post<SignupResponse>('/auth/signup/submit', req);
    return data;
  },
};
