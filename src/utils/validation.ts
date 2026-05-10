/**
 * 입력값 검증 유틸 모음.
 * 가능한 한 표준 정규식 + 한국 형식(전화번호/사업자번호)에 맞춥니다.
 */

/** 아이디: 영문 소문자/숫자, 4~20자 */
export function isValidLoginId(id: string): boolean {
  return /^[a-z0-9]{4,20}$/.test(id);
}

/** 비밀번호: 8~20자, 영문+숫자+특수문자 중 2종 이상 */
export function isValidPassword(pw: string): boolean {
  if (pw.length < 8 || pw.length > 20) return false;
  let kinds = 0;
  if (/[a-zA-Z]/.test(pw)) kinds++;
  if (/[0-9]/.test(pw)) kinds++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(pw)) kinds++;
  return kinds >= 2;
}

/** 이름: 한글/영문 2~30자 */
export function isValidName(name: string): boolean {
  return /^[가-힣A-Za-z\s]{2,30}$/.test(name.trim());
}

/** 휴대폰번호: 010-XXXX-XXXX 또는 02-XXX-XXXX 형식 등 */
export function isValidPhone(phone: string): boolean {
  return /^0\d{1,2}-\d{3,4}-\d{4}$/.test(phone);
}

/** 휴대폰번호 자동 하이픈 — 입력 중 호출 */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11);
  if (digits.length < 4) return digits;
  if (digits.startsWith('02')) {
    if (digits.length < 6) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    if (digits.length <= 9)
      return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`;
  }
  if (digits.length < 8) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

/** 이메일 형식 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 사업자등록번호: ###-##-##### + 체크섬 */
export function isValidBusinessNumber(bn: string): boolean {
  const digits = bn.replace(/\D/g, '');
  if (digits.length !== 10) return false;

  // 한국 사업자등록번호 체크섬
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * weights[i];
  sum += Math.floor((Number(digits[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[9]);
}

export function formatBusinessNumber(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** 생년월일: YYYY-MM-DD */
export function isValidBirthDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s);
  if (isNaN(d.getTime())) return false;
  // 미래 / 1900년 이전 거부
  const now = new Date();
  if (d > now) return false;
  if (d.getFullYear() < 1900) return false;
  return true;
}

/** 비밀번호 강도 0~3 */
export function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  let kinds = 0;
  if (/[a-zA-Z]/.test(pw)) kinds++;
  if (/[0-9]/.test(pw)) kinds++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(pw)) kinds++;
  if (pw.length < 8) return 0;
  if (kinds === 1) return 1;
  if (kinds === 2) return 2;
  return 3;
}
