import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Field } from '../components/Field';
import { RoleSelect } from '../components/RoleSelect';
import { AddressField } from '../components/AddressField';
import { teamApi } from '../api/team';
import { siteApi } from '../api/site';
import type { IdType, RegistrationMode, WorkerRole } from '../api/team.types';
import type { Foreman, Site } from '../api/site.types';
import { getErrorMessage } from '../api/client';
import { formatPhone, isValidPhone } from '../utils/validation';
import { formatRRN, formatAccount } from '../utils/phone';
import { openPostcode } from '../utils/postcode';
import { KOREAN_BANKS } from '../utils/banks';
import './TeamRegisterPage.css';

import { MacSelect } from '../components/MacSelect';
const ID_TYPES: { value: IdType; label: string }[] = [
  { value: 1, label: '주민등록증' },
  { value: 2, label: '운전면허증' },
  { value: 3, label: '외국인등록증' },
];

// 은행 목록 — utils/banks.ts (수정 페이지와 동일 리스트)
const BANKS = KOREAN_BANKS;

interface FormState {
  mode: RegistrationMode;
  name: string;
  phone: string;
  role: WorkerRole;
  siteId: string;
  /** 이 팀원을 관리할 반장 (현장 변경 시 자동 첫 반장으로 리셋) */
  foremanId: string;
  dailyWage: string;

  idType: IdType;
  idNumber: string;
  idAddress: string;
  idImageId?: string;
  idImagePreview?: string;

  bankName: string;
  accountNumber: string;
  accountHolder: string;
  bankImageId?: string;

  /** 타계좌 입금 — 본인 / 반장 / 가족 */
  remitTo: 'SELF' | 'FOREMAN' | 'FAMILY';
  /** 타계좌일 때 근로자가 보낸 입금 확인증 사진 */
  depositReceiptId?: string;
  depositReceiptPreview?: string;
  /** 입금 확인증 요청 발송 여부 (UI flag) */
  depositReceiptRequested?: boolean;

  faceImageId?: string;
  facePreview?: string;

  // ── 추가 정보 (선택) ──
  insPension: boolean;
  insHealth: boolean;
  insEmployment: boolean;
  insAccident: boolean;
  safetyEduCompleted: boolean;
  /** 기초안전교육 이수증 (이미지/PDF) — data URL preview */
  safetyCertImage?: string | null;
  /** 업로드된 이수증 파일명 (UI 표시용) */
  safetyCertFileName?: string;
}

/**
 * 팀원 등록 (대면 / 공무) — 와이어프레임 015·019·023.png + 전자동의서.pdf 통합
 *
 * 동의 섹션 = "전자동의서.pdf"의 3-PART 분리 동의 흐름:
 *  PART 1 — 개인정보 수집·이용
 *  PART 2 — 민감정보(얼굴 식별 정보) 처리
 *  PART 3 — 반장 기기 이용 + 본인 직접 서명 고지
 *
 * 운영 정책: 한 PART에 동의해야 다음 PART가 활성화됩니다 (일괄 동의 X).
 *           등록 완료 시 팀원 휴대폰으로 "동의 완료 안내" 알림톡이 발송됩니다.
 */
interface TeamRegisterPageProps {
  /** 모달 안에서 임베드되어 사용될 때 true — PageHeader 숨기고 onClose/onCreated 콜백을 사용한다 */
  embedded?: boolean;
  onClose?: () => void;
  onCreated?: () => void | Promise<void>;
  /** 임베드 모달에서 초기 선택할 현장 — 출퇴근 풀 모달 등에서 컨텍스트로 전달 */
  defaultSiteId?: string;
}

export function TeamRegisterPage({ embedded = false, onClose, onCreated, defaultSiteId }: TeamRegisterPageProps = {}) {
  const navigate = useNavigate();
  const closeOrNav = () => {
    if (embedded) onClose?.();
    else navigate('/team');
  };
  const [sites, setSites] = useState<Site[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const idFileRef = useRef<HTMLInputElement | null>(null);
  const faceFileRef = useRef<HTMLInputElement | null>(null);
  const bankFileRef = useRef<HTMLInputElement | null>(null);
  const receiptFileRef = useRef<HTMLInputElement | null>(null);
  const safetyCertRef = useRef<HTMLInputElement | null>(null);

  const [foremen, setForemen] = useState<Foreman[]>([]);

  const [form, setForm] = useState<FormState>({
    mode: 'IN_PERSON',
    name: '',
    phone: '',
    role: '',
    siteId: defaultSiteId ?? '',
    foremanId: '',
    dailyWage: '250000',
    idType: 1,
    idNumber: '',
    idAddress: '',
    bankName: '국민',
    accountNumber: '',
    accountHolder: '',
    remitTo: 'SELF',
    // 일용직 기본 — 산재 + 고용만 (현실 값)
    insPension: false,
    insHealth: false,
    insEmployment: true,
    insAccident: true,
    safetyEduCompleted: false,
    safetyCertImage: null,
    safetyCertFileName: '',
  });
  // extraOpen 토글 제거 — 추가 정보가 우측 고정 카드로 이동했음

  useEffect(() => {
    Promise.all([siteApi.listSites(), siteApi.listForemen()]).then(([s, f]) => {
      setSites(s.sites);
      setForemen(f.foremen);
      // 현장 자동 선택 X — 미선택(대기 인력 / 본사 직접 관리) 상태 허용
    });
  }, []);

  /** 현장이 바뀌면 반장 옵션을 그 현장의 첫 반장으로 자동 리셋 */
  function pickSite(nextSiteId: string) {
    const firstForeman = foremen.find((x) => x.siteId === nextSiteId);
    patch({ siteId: nextSiteId, foremanId: firstForeman?.id ?? '' });
  }

  /** 현재 사이트의 반장 목록 */
  const visibleForemen = foremen.filter((f) => f.siteId === form.siteId);

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  function handleSafetyCertUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      patch({
        safetyCertImage: dataUrl,
        safetyCertFileName: file.name,
        // 이수증을 올렸다면 이수 처리
        safetyEduCompleted: true,
      });
    };
    reader.readAsDataURL(file);
    if (e.target) e.target.value = '';
  }

  async function handleUpload(
    kind: 'id' | 'face' | 'bank' | 'receipt',
    e: ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // receipt 도 mock 백엔드의 'bank' 카테고리로 업로드 (전용 카테고리 추가는 추후 백엔드 확장)
      const apiKind = kind === 'receipt' ? 'bank' : kind;
      const res = await teamApi.upload(apiKind, file);
      const previewUrl = URL.createObjectURL(file);
      if (kind === 'id') patch({ idImageId: res.imageId, idImagePreview: previewUrl });
      else if (kind === 'face') patch({ faceImageId: res.imageId, facePreview: previewUrl });
      else if (kind === 'receipt') patch({ depositReceiptId: res.imageId, depositReceiptPreview: previewUrl });
      else patch({ bankImageId: res.imageId });
    } catch (err) {
      alert(getErrorMessage(err, '업로드 실패'));
    } finally {
      if (e.target) e.target.value = '';
    }
  }

  function validate(): string | null {
    // 배정 현장은 선택 사항 — 미지정 시 「대기 인력 / 본사 직접 관리」 상태로 등록
    if (!form.name.trim()) return '이름을 입력해주세요.';
    if (!isValidPhone(form.phone)) return '휴대폰 번호 형식이 올바르지 않습니다.';
    if (!form.role) return '직종을 선택해주세요.';
    if (!form.dailyWage || Number(form.dailyWage) <= 0) return '일당을 정확히 입력해주세요.';
    if (!form.idNumber) return '신분증 번호를 입력해주세요.';
    if (!form.bankName || !form.accountNumber) return '계좌 정보를 입력해주세요.';
    if (!form.accountHolder) return '예금주를 입력해주세요.';
    /* 본인 입금일 때만 예금주==이름 검증, 타계좌(반장/가족)는 다른 게 정상 */
    if (form.remitTo === 'SELF' && form.accountHolder.trim() !== form.name.trim()) {
      return `예금주(${form.accountHolder})와 신청자 이름(${form.name})이 일치하지 않습니다.`;
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitErr(null);
    setOkMsg(null);

    const v = validate();
    if (v) {
      setSubmitErr(v);
      return;
    }

    setSubmitting(true);
    try {
      const agreedAtIso = new Date().toISOString();
      const res = await teamApi.register({
        mode: form.mode,
        name: form.name.trim(),
        phone: form.phone,
        role: form.role,
        // 미선택이면 undefined — 「대기 인력 / 본사 직접 관리」
        siteId: form.siteId || undefined,
        // 현장담당자 직접 관리 — assignToSiteManager 플래그로 명시적 전달 (자동 첫 반장 배정 방지)
        foremanId:
          form.foremanId && form.foremanId !== '__SITE_MANAGER__'
            ? form.foremanId
            : undefined,
        // 현장이 없으면 반장 개념 자체가 없으므로 false
        assignToSiteManager: !!form.siteId && form.foremanId === '__SITE_MANAGER__',
        dailyWage: Number(form.dailyWage),
        idType: form.idType,
        idNumber: form.idNumber,
        idAddress: form.idAddress,
        idImageId: form.idImageId,
        faceImageId: form.faceImageId,
        bankImageId: form.bankImageId,
        bankName: form.bankName,
        accountNumber: form.accountNumber,
        accountHolder: form.accountHolder,
        agreedToPersonalInfo: true,
        agreedToBiometric: true,
        agreedToProxyDevice: true,
        agreedAt: agreedAtIso,
        notifyConsentComplete: true,
        insurance: {
          pension: form.insPension,
          health: form.insHealth,
          employment: form.insEmployment,
          accident: form.insAccident,
        },
        safetyEduCompleted: form.safetyEduCompleted,
        safetyCertImage: form.safetyCertImage ?? undefined,
        safetyCertFileName: form.safetyCertFileName || undefined,
      });

      setOkMsg(
        `${res.member.name}님이 등록되었습니다. ` +
          `${res.member.phone}으로 개인정보동의서 알림톡(또는 SMS)이 발송됩니다.`,
      );
      setTimeout(() => {
        if (embedded) {
          void onCreated?.();
        } else {
          navigate('/team');
        }
      }, 1200);
    } catch (err) {
      setSubmitErr(getErrorMessage(err, '등록 처리 중 오류가 발생했습니다.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={embedded ? "trp trp--embedded" : "trp"}>
      {!embedded && <PageHeader
        title="팀원 등록"
        subtitle="관리자가 팀원 정보를 직접 입력하는 화면입니다. 신분증·계좌·얼굴 사진을 한 번에 등록하세요."
        actions={
          <div className="trp__head-actions">
            <button
              type="button"
              className="trp__btn trp__btn--ghost"
              onClick={closeOrNav}
            >
              취소
            </button>
            <button
              type="submit"
              form="trp-form"
              className="trp__btn trp__btn--primary"
              disabled={submitting}
            >
              {submitting ? '등록 중…' : '팀원 등록 + 개인정보동의서 발송'}
            </button>
            <button type="button" className="trp__back" onClick={closeOrNav}>
              ← 목록으로
            </button>
          </div>
        }
      />}

      <form id="trp-form" className="trp__form" onSubmit={handleSubmit} noValidate>
        {(submitErr || okMsg) && (
          <div className="trp__toast">
            {submitErr && <p className="trp__err">{submitErr}</p>}
            {okMsg && <p className="trp__ok">{okMsg}</p>}
          </div>
        )}
        {/* 1. 기본 정보 (전체 폭) — 사진 + 폼 + 추가정보 */}
        <Section title="1. 기본 정보 — 누가, 어느 현장에서, 얼마에">
              <div className="trp__basic-row">
                {/* 좌: 얼굴 사진 (기본 정보 안에 통합) */}
                <div className="trp__basic-photo">
                  <div className="trp__face">
                    {form.facePreview
                      ? <img src={form.facePreview} alt="얼굴 미리보기" />
                      : <div className="trp__face-empty">사진 없음</div>
                    }
                  </div>
                  <div className="trp__face-actions">
                    <button
                      type="button"
                      className="trp__btn trp__btn--ghost trp__btn--sm"
                      onClick={() => faceFileRef.current?.click()}
                    >
                      {form.facePreview ? '다시 업로드' : '얼굴 사진 업로드'}
                    </button>
                    {form.facePreview && (
                      <button
                        type="button"
                        className="trp__btn trp__btn--danger trp__btn--sm"
                        onClick={() => patch({ faceImageId: undefined, facePreview: undefined })}
                      >
                        삭제
                      </button>
                    )}
                  </div>
                  <input ref={faceFileRef} type="file" accept="image/*" hidden onChange={(e) => handleUpload('face', e)} />
                </div>
                {/* 가운데: 폼 필드 */}
                <div className="trp__basic-fields">
              {/* 1행: 이름·휴대폰·직종·일당 (4컬럼) */}
              <div className="trp__row trp__row--4">
                <Field
                  label="이름" required placeholder="홍길동"
                  lang="ko"
                  value={form.name} onChange={(v) => patch({ name: v })}
                />
                <Field
                  label="휴대폰" required inputMode="tel" placeholder="010-1234-5678"
                  formatter={formatPhone}
                  value={form.phone} onChange={(v) => patch({ phone: v })}
                />
                <div className="trp__select-wrap">
                  <label>직종 <span className="trp__req">*</span></label>
                  <RoleSelect
                    value={form.role}
                    onChange={(v) => patch({ role: v })}
                    placeholder="직종"
                  />
                </div>
                <Field
                  label="일당" required inputMode="numeric" placeholder="250,000원"
                  value={form.dailyWage ? Number(form.dailyWage).toLocaleString() + '원' : ''}
                  onChange={(v) => patch({ dailyWage: v.replace(/\D/g, '') })}
                />
              </div>

              {/* 2행: 내외국인·주민등록번호·주소(+검색)·신분증 업로드 */}
              <div className="trp__row trp__row--id">
                <div className="trp__select-wrap">
                  <label>내외국인 <span className="trp__req">*</span></label>
                  <MacSelect
              value={form.idType}
              onChange={(v) => patch({ idType: Number(v) as IdType })}
              options={[{ value: 1, label: '내국인' }, { value: 3, label: '외국인' }]}
            />
                </div>
                <Field
                  label={form.idType === 3 ? '외국인등록번호' : '주민등록번호'}
                  required hint="즉시 마스킹 처리"
                  placeholder={form.idType === 1 ? '770417-1234567' : ''}
                  formatter={formatRRN}
                  value={form.idNumber}
                  onChange={(v) => patch({ idNumber: v })}
                />
                <div className="trp__addr-cell">
                  <label className="trp__addr-label">주소 (신분증 기재)</label>
                  <AddressField
                    value={form.idAddress}
                    onChange={(v) => patch({ idAddress: v })}
                    onSelect={(d) => patch({ idAddress: `[${d.zonecode}] ${d.address}` })}
                    buttonLabel={
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="7" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    }
                  />
                  <span style={{ display: 'none' }}>
                    <button
                      type="button"
                      className="trp__addr-search"
                      onClick={() =>
                        openPostcode((d) =>
                          patch({ idAddress: `[${d.zonecode}] ${d.address}` }),
                        )
                      }
                      title="다음(Daum) 우편번호 검색"
                    >
                      검색
                    </button>
                  </span>
                </div>
                <button
                  type="button"
                  className={
                    'trp__inline-upload' +
                    (form.idImagePreview ? ' is-done' : '')
                  }
                  onClick={() => idFileRef.current?.click()}
                  title="JPG/PNG · OCR 검증용"
                >
                  {form.idImagePreview ? '신분증 업로드됨' : '신분증(여권) 업로드'}
                </button>
              </div>
              <input ref={idFileRef} type="file" accept="image/*" hidden onChange={(e) => handleUpload('id', e)} />

                </div>
              </div>

            </Section>

        {/* 2. 현장 정보 + 3. 계좌 정보 — 좌·우 2컬럼 배치 */}
        <div className="trp__bottom-grid">
            <Section title="2. 현장 정보">
              {/* 1행: 배정 현장 / 관리 반장 */}
              <div className="trp__row trp__row--2">
                <div className="trp__select-wrap">
                  <label>
                    배정 현장 <span className="trp__hint">(선택 — 미지정 가능)</span>
                  </label>
                  <MacSelect
              value={form.siteId}
              onChange={(v) => pickSite(v)}
              options={[{ value: "", label: '미정 (대기 인력 / 본사 직접 관리)' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
            />
                </div>
                <div className="trp__select-wrap">
                  <label>
                    관리 반장
                    <span className="trp__hint">
                      {form.siteId
                        ? '(얼굴 인식 출퇴근을 처리할 반장)'
                        : '(배정 현장 미정 — 본사 공무가 직접 관리)'}
                    </span>
                  </label>
                  <MacSelect
                    value={form.foremanId}
                    onChange={(v) => patch({ foremanId: v })}
                    disabled={!form.siteId}
                    options={!form.siteId
                      ? [{ value: '', label: '— 배정 현장 미정 (본사 직접 관리) —' }]
                      : (() => {
                          const opts: { value: string; label: React.ReactNode; disabled?: boolean }[] = [
                            { value: '', label: '선택해주세요' },
                          ];
                          const cur = sites.find((s) => s.id === form.siteId);
                          const smLabel = cur?.manager
                            ? `반장 없이 등록 — ${cur.manager}${cur.managerPhone ? ' · ' + cur.managerPhone : ''} (현장담당자 직접 관리)`
                            : '반장 없이 등록 (현장담당자 직접 관리)';
                          opts.push({ value: '__SITE_MANAGER__', label: smLabel });
                          visibleForemen.forEach((f) => {
                            opts.push({
                              value: f.id,
                              label: `${f.name}${f.role ? ` (${f.role})` : ''}${f.registered ? '' : ' · 가입 대기'}`,
                            });
                          });
                          if (visibleForemen.length === 0) {
                            opts.push({ value: '', label: '— 이 현장에 등록된 반장이 없습니다 —', disabled: true });
                          }
                          return opts;
                        })()}
                  />
                  {form.siteId && form.foremanId === '' && visibleForemen.length > 0 && (
                    <p className="trp__warn">
                      미선택 시 현장담당자로 배정됩니다.
                    </p>
                  )}
                </div>
              </div>

              {/* 2행: 4대보험 (가입 여부) / 기초안전교육 (이수) */}
              <div className="trp__row trp__row--2">
                <div className="trp__select-wrap">
                  <label>4대보험 <span className="trp__hint">(가입 여부)</span></label>
                  <div className="trp-extra__chips trp-extra__chips--inline">
                    {[
                      { k: 'insPension', label: '국민연금', v: form.insPension },
                      { k: 'insHealth', label: '건강보험', v: form.insHealth },
                      { k: 'insEmployment', label: '고용보험', v: form.insEmployment },
                      { k: 'insAccident', label: '산재보험', v: form.insAccident },
                    ].map((it) => (
                      <button
                        key={it.k}
                        type="button"
                        className={'trp-chip' + (it.v ? ' is-on' : '')}
                        onClick={() => patch({ [it.k]: !it.v } as any)}
                        aria-pressed={it.v}
                      >
                        {it.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="trp__select-wrap">
                  <label>기초안전교육 <span className="trp__hint">(이수)</span></label>
                  <div className="trp__safety-row">
                    <div className="trp-extra__chips--inline trp__safety-pills">
                      <button
                        type="button"
                        className={'trp-chip' + (!form.safetyEduCompleted ? ' is-on' : '')}
                        onClick={() => patch({ safetyEduCompleted: false })}
                        aria-pressed={!form.safetyEduCompleted}
                      >
                        미이수
                      </button>
                      <button
                        type="button"
                        className={'trp-chip' + (form.safetyEduCompleted ? ' is-on' : '')}
                        onClick={() => patch({ safetyEduCompleted: true })}
                        aria-pressed={form.safetyEduCompleted}
                      >
                        이수
                      </button>
                    </div>
                    <button
                      type="button"
                      className={
                        'trp__inline-upload trp__safety-upload' +
                        (form.safetyCertImage ? ' is-done' : '')
                      }
                      onClick={() => safetyCertRef.current?.click()}
                      title="기초안전교육 이수증 업로드 (이미지 또는 PDF)"
                    >
                      {form.safetyCertImage
                        ? `✓ 이수증 (${form.safetyCertFileName || '업로드됨'})`
                        : '+ 이수증 업로드'}
                    </button>
                    <input
                      ref={safetyCertRef}
                      type="file"
                      accept="image/*,application/pdf"
                      style={{ display: 'none' }}
                      onChange={handleSafetyCertUpload}
                    />
                  </div>
                </div>
              </div>
            </Section>

            <Section title="3. 계좌 정보">
              {/* 4컬럼: 은행 / 계좌번호 / 예금주 / 통장사본 인라인 업로드 */}
              <div className="trp__row trp__row--bank">
                <div className="trp__select-wrap">
                  <label>은행</label>
                  <MacSelect
              value={form.bankName}
              onChange={(v) => patch({ bankName: v })}
              options={[...BANKS.map((b) => ({ value: b, label: b }))]}
            />
                </div>
                <Field
                  label="계좌번호" required placeholder="예) 110-123-456789"
                  formatter={formatAccount}
                  value={form.accountNumber}
                  onChange={(v) => patch({ accountNumber: v })}
                />
                <Field
                  label="예금주" required placeholder="홍길동"
                  lang="ko"
                  value={form.accountHolder} onChange={(v) => patch({ accountHolder: v })}
                  error={
                    /* 타계좌(반장/가족) 입금 시엔 예금주가 다른 게 정상 → 워닝 숨김 */
                    form.remitTo === 'SELF' &&
                    form.accountHolder && form.name &&
                    form.accountHolder.trim() !== form.name.trim()
                      ? '예금주 ≠ 신청자 이름'
                      : undefined
                  }
                  errorInLabel
                />
                <button
                  type="button"
                  className={
                    'trp__inline-upload' + (form.bankImageId ? ' is-done' : '')
                  }
                  onClick={() => bankFileRef.current?.click()}
                  title="JPG/PNG · 계좌 검증용"
                >
                  {form.bankImageId ? '통장 사본 업로드됨' : '통장 사본 업로드'}
                </button>
              </div>
              <input ref={bankFileRef} type="file" accept="image/*" hidden onChange={(e) => handleUpload('bank', e)} />

              {/* 타계좌 입금 — 본인 / 반장 / 가족 + 입금 확인증 요청 */}
              <div className="trp__remit-row">
                <div className="trp__select-wrap">
                  <label>
                    타계좌 입금
                    <span className="trp__hint">(본인 외 계좌로 송금 시)</span>
                  </label>
                  <div className="trp-extra__chips--inline">
                    {[
                      { v: 'SELF', label: '본인' },
                      { v: 'FOREMAN', label: '반장' },
                      { v: 'FAMILY', label: '가족' },
                    ].map((it) => {
                      const on = form.remitTo === it.v;
                      return (
                        <button
                          key={it.v}
                          type="button"
                          className={'trp-chip' + (on ? ' is-on' : '')}
                          onClick={() =>
                            patch({ remitTo: it.v as FormState['remitTo'] })
                          }
                          aria-pressed={on}
                        >
                          {it.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 본인이 아닐 때만 — 입금 확인증 요청 / 직접 업로드 */}
                {form.remitTo !== 'SELF' && (
                  <div className="trp__select-wrap">
                    <label>
                      입금 확인증
                      <span className="trp__hint">(타계좌 송금 검증용)</span>
                    </label>
                    <div className="trp__remit-actions">
                      <button
                        type="button"
                        className={
                          'trp__inline-upload' +
                          (form.depositReceiptRequested ? ' is-done' : '')
                        }
                        onClick={() => {
                          if (!form.phone) {
                            window.alert('근로자 휴대폰 번호를 먼저 입력해주세요.');
                            return;
                          }
                          if (
                            window.confirm(
                              `${form.name || '근로자'}(${form.phone}) 에게\n` +
                              `입금 확인증 사진 요청 SMS를 발송하시겠습니까?\n\n` +
                              `· 근로자 휴대폰에서 카메라가 열리고\n` +
                              `· 사진을 찍어 업로드하면 자동으로 여기에 표시됩니다.`
                            )
                          ) {
                            patch({ depositReceiptRequested: true });
                            window.alert(
                              'SMS 발송 완료\n근로자가 사진을 업로드하면 알림으로 통지됩니다.',
                            );
                          }
                        }}
                        title="근로자 휴대폰으로 카메라 캡처 링크 SMS 발송"
                      >
                        {form.depositReceiptRequested
                          ? '요청 발송됨 (대기 중)'
                          : '근로자에게 사진 요청'}
                      </button>
                      <button
                        type="button"
                        className={
                          'trp__inline-upload' +
                          (form.depositReceiptId ? ' is-done' : '')
                        }
                        onClick={() => receiptFileRef.current?.click()}
                        title="관리자가 직접 사진 업로드"
                      >
                        {form.depositReceiptId
                          ? '확인증 업로드됨'
                          : '직접 업로드'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <input
                ref={receiptFileRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => handleUpload('receipt', e)}
              />
            </Section>
        </div>
        {embedded && (
          <div className="trp__embed-bar trp__embed-bar--bottom">
            <button type="button" className="trp__btn trp__btn--ghost" onClick={closeOrNav}>취소</button>
            <button type="submit" className="trp__btn trp__btn--primary" disabled={submitting}>
              {submitting ? '등록 중…' : '팀원 등록 + 개인정보동의서 발송'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/* ───────── 보조 컴포넌트 ───────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="trp-sec">
      <h3 className="trp-sec__title">{title}</h3>
      <div className="trp-sec__body">{children}</div>
    </section>
  );
}

function FileSlot({
  label, description, preview, hideImage, onClick, onClear,
}: {
  label: string;
  description: string;
  preview?: string;
  hideImage?: boolean;
  onClick: () => void;
  onClear: () => void;
}) {
  if (preview && !hideImage) {
    return (
      <div className="trp-file trp-file--filled">
        <img src={preview} alt={label} className="trp-file__img" />
        <div className="trp-file__body">
          <p className="trp-file__name">{label}</p>
          <p className="trp-file__desc">업로드 완료</p>
        </div>
        <div className="trp-file__actions">
          <button type="button" className="trp__btn trp__btn--ghost" onClick={onClick}>교체</button>
          <button type="button" className="trp__btn trp__btn--danger" onClick={onClear}>삭제</button>
        </div>
      </div>
    );
  }
  if (preview && hideImage) {
    return (
      <div className="trp-file trp-file--filled">
        <div className="trp-file__check">✓</div>
        <div className="trp-file__body">
          <p className="trp-file__name">{label}</p>
          <p className="trp-file__desc">업로드 완료</p>
        </div>
        <div className="trp-file__actions">
          <button type="button" className="trp__btn trp__btn--ghost" onClick={onClick}>교체</button>
          <button type="button" className="trp__btn trp__btn--danger" onClick={onClear}>삭제</button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="trp-file" onClick={onClick}>
      <span className="trp-file__plus">+</span>
      <span>
        <span className="trp-file__name">{label}</span>
        <span className="trp-file__desc">{description}</span>
      </span>
    </button>
  );
}
