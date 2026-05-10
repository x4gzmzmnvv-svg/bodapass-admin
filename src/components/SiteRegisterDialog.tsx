import { FormEvent, useState } from 'react';
import { Modal } from './Modal';
import { siteApi } from '../api/site';
import { getErrorMessage } from '../api/client';
import type { ContractKind, CreateSiteRequest, Site } from '../api/site.types';
import { formatPhone } from '../utils/validation';
import { openPostcode } from '../utils/postcode';
import './SiteRegisterDialog.css';

import { MacSelect } from './MacSelect';
import { MacDatePicker } from './MacDatePicker';
interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (site: Site) => void;
}

const CONTRACT_KINDS: ContractKind[] = ['원도급', '하도급', '단가도급', '공동도급'];

/**
 * 현장 등록 다이얼로그 — 4단계 위저드
 *
 *  1단계 일반현황   : 현장명·도급종류·도급추가내용·우편번호·소재지·상세주소
 *  2단계 계약정보   : 도급금액·공사계약일·착공일·준공일·발주처
 *  3단계 사회보험   : 고용·산재·건강(일용/상용)·연금(일용/상용) 관리번호 + 성립일
 *  4단계 기타사항   : 담당자·연락처·팩스·현장담당자·안전관리자·품질시험사·일찰공고일·보험기준일
 *
 *  · 각 단계 진입 시 필수 입력 검증, 통과 시에만 다음 단계로
 *  · 컴팩트 레이아웃 — 스크롤 없이 한 화면에 들어오도록 설계
 */

interface InsuranceForm {
  empMgmt: string;       empDate: string;
  woundMgmt: string;     woundDate: string;
  healthDailyMgmt: string;   healthDailyDate: string;
  healthRegularMgmt: string; healthRegularDate: string;
  pensionDailyMgmt: string;  pensionDailyDate: string;
  pensionRegularMgmt: string; pensionRegularDate: string;
}

type Step = 1 | 2 | 3 | 4;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: '일반현황' },
  { n: 2, label: '계약정보' },
  { n: 3, label: '사회보험' },
  { n: 4, label: '기타사항' },
];

export function SiteRegisterDialog({ open, onClose, onCreated }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [form, setForm] = useState<CreateSiteRequest>(() => emptyForm());
  const [insurance, setInsurance] = useState<InsuranceForm>(() => emptyInsurance());
  const [step, setStep] = useState<Step>(1);

  function patch(p: Partial<CreateSiteRequest>) {
    setForm((f) => ({ ...f, ...p }));
  }
  function patchIns(p: Partial<InsuranceForm>) {
    setInsurance((s) => ({ ...s, ...p }));
  }

  /** 단계별 필수값 검증 */
  function validateStep(s: Step): string | null {
    if (s === 1) {
      if (!form.name.trim()) return '현장명을 입력해주세요.';
      if (!form.contractKind) return '도급종류를 선택해주세요.';
      if (!form.address.trim()) return '소재지를 입력해주세요.';
    }
    if (s === 2) {
      if (!form.contractAmount || form.contractAmount <= 0) return '도급금액을 입력해주세요.';
      if (!form.startDate) return '착공일을 선택해주세요.';
      if (!form.endDate) return '준공일을 선택해주세요.';
      if (!form.client.trim()) return '발주처를 입력해주세요.';
    }
    // 3,4 단계는 선택사항 — 필수 검증 없음
    return null;
  }

  function next() {
    setErrMsg(null);
    const err = validateStep(step);
    if (err) {
      setErrMsg(err);
      return;
    }
    setStep((s) => Math.min(4, (s + 1)) as Step);
  }
  function prev() {
    setErrMsg(null);
    setStep((s) => Math.max(1, (s - 1)) as Step);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrMsg(null);
    // 모든 단계 검증
    for (const s of [1, 2] as Step[]) {
      const err = validateStep(s);
      if (err) {
        setStep(s);
        setErrMsg(err);
        return;
      }
    }
    if (!form.manager.trim() || !form.managerPhone.trim()) {
      setStep(4);
      setErrMsg('담당자 이름과 연락처를 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await siteApi.createSite(form);
      onCreated(res.site);
      // 리셋
      setForm(emptyForm());
      setInsurance(emptyInsurance());
      setStep(1);
      onClose();
    } catch (err) {
      setErrMsg(getErrorMessage(err, '현장 등록 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="현장 등록"
      subtitle={`${step}단계 / 4단계 — ${STEPS[step - 1].label}`}
      width={640}
      footer={
        <>
          <button type="button" className="srd__btn srd__btn--ghost" onClick={onClose}>
            취소
          </button>
          {step > 1 && (
            <button type="button" className="srd__btn srd__btn--ghost" onClick={prev}>
              이전
            </button>
          )}
          {step < 4 ? (
            <button type="button" className="srd__btn srd__btn--primary" onClick={next}>
              다음 단계 →
            </button>
          ) : (
            <button
              type="submit"
              form="site-register-form"
              className="srd__btn srd__btn--primary"
              disabled={submitting}
            >
              {submitting ? '저장 중…' : '등록 완료'}
            </button>
          )}
        </>
      }
    >
      <form id="site-register-form" className="srd-wiz" onSubmit={handleSubmit} noValidate>
        {/* 단계 인디케이터 — 점 + 연결선 + 라벨 (WorkCloseHeader 톤) */}
        <div className="srd-steps">
          {STEPS.map(({ n, label }, i) => {
            const currentIdx = step - 1;
            const isCompleted = i < currentIdx;
            const isActive = i === currentIdx;
            const stateCls = isCompleted ? 'is-completed' : isActive ? 'is-active' : 'is-pending';
            return (
              <div key={n} className="srd-steps__row">
                <div className={'srd-steps__step ' + stateCls}>
                  <span className="srd-steps__dot">{isCompleted ? '✓' : i + 1}</span>
                  <span className="srd-steps__label">{label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <span
                    className={
                      'srd-steps__line' +
                      (i < currentIdx ? ' is-full' : isActive ? ' is-partial' : '')
                    }
                  >
                    <span
                      className="srd-steps__line-fill"
                      style={{ width: i < currentIdx ? '100%' : isActive ? '50%' : '0%' }}
                    />
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* 단계 1 — 일반현황 */}
        {step === 1 && (
          <div className="srd-wiz__panel">
            <Row>
              <FieldX label="현장명" required value={form.name}
                onChange={(v) => patch({ name: v })}
                placeholder="예) 인천 서구 동현아파트 신축공사" />
            </Row>
            <Row cols={2}>
              <SelectX label="도급종류" required value={form.contractKind}
                options={CONTRACT_KINDS}
                onChange={(v) => patch({ contractKind: v as ContractKind })} />
              <FieldX label="도급추가내용" value={form.contractDescription ?? ''}
                onChange={(v) => patch({ contractDescription: v })}
                placeholder="공동도급·차수공사 등 (선택)" />
            </Row>
            <Row cols="addr">
              <div className="srd-wiz__field">
                <label className="srd-wiz__label">우편번호</label>
                <div className="srd-zip-wrap">
                  <button
                    type="button"
                    className="srd-zip-search"
                    onClick={() =>
                      openPostcode((d) =>
                        patch({ zipCode: d.zonecode, address: d.address }),
                      )
                    }
                    title="다음(Daum) 우편번호 검색"
                    aria-label="주소 검색"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" />
                      <line x1="20" y1="20" x2="16.65" y2="16.65" />
                    </svg>
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.zipCode ?? ''}
                    onChange={(e) =>
                      patch({ zipCode: e.target.value.replace(/\D/g, '').slice(0, 5) })
                    }
                    placeholder="01234"
                    className="srd-wiz__input"
                  />
                </div>
              </div>
              <div className="srd-addr-cell">
                <label className="srd-addr-label">소재지 <span style={{ color: 'var(--color-error)' }}>*</span></label>
                <div className="srd-addr-row">
                  <input
                    type="text"
                    className="srd-addr-text"
                    placeholder=""
                    lang="ko"
                    value={form.address}
                    onChange={(e) => patch({ address: e.target.value })}
                  />
                </div>
              </div>
            </Row>
            <Row>
              <FieldX label="상세주소" value={form.addressDetail ?? ''}
                onChange={(v) => patch({ addressDetail: v })}
                placeholder="동·호수 등 (선택)" />
            </Row>
          </div>
        )}

        {/* 단계 2 — 계약정보 */}
        {step === 2 && (
          <div className="srd-wiz__panel">
            <Row cols={2}>
              <FieldX label="도급금액 (원)" required inputMode="numeric"
                value={form.contractAmount ? form.contractAmount.toLocaleString() : ''}
                onChange={(v) => patch({ contractAmount: Number(v.replace(/\D/g, '') || 0) })}
                placeholder="0"
                helper={form.contractAmount ? `${(form.contractAmount / 100_000_000).toFixed(2)}억원` : ''} />
              <FieldX label="발주처" required value={form.client}
                onChange={(v) => patch({ client: v })}
                placeholder="예) 인천시 도시공사" />
            </Row>
            <Row cols={3}>
              <FieldX label="공사계약일" type="date" value={form.contractDate ?? ''}
                onChange={(v) => patch({ contractDate: v })} />
              <FieldX label="착공일" required type="date" value={form.startDate ?? ''}
                onChange={(v) => patch({ startDate: v })} />
              <FieldX label="준공일" required type="date" value={form.endDate ?? ''}
                onChange={(v) => patch({ endDate: v })} />
            </Row>
          </div>
        )}

        {/* 단계 3 — 사회보험 */}
        {step === 3 && (
          <div className="srd-wiz__panel">
            <p className="srd-wiz__hint">
              관리번호와 성립일을 입력해주세요. 모두 선택 사항이며 등록 후에도 수정할 수 있습니다.
            </p>
            <InsuranceRow label="고용보험"
              mgmt={insurance.empMgmt} date={insurance.empDate}
              onMgmt={(v) => patchIns({ empMgmt: v })} onDate={(v) => patchIns({ empDate: v })} />
            <InsuranceRow label="산재보험"
              mgmt={insurance.woundMgmt} date={insurance.woundDate}
              onMgmt={(v) => patchIns({ woundMgmt: v })} onDate={(v) => patchIns({ woundDate: v })} />
            <InsuranceRow label="건강보험 (일용)"
              mgmt={insurance.healthDailyMgmt} date={insurance.healthDailyDate}
              onMgmt={(v) => patchIns({ healthDailyMgmt: v })} onDate={(v) => patchIns({ healthDailyDate: v })} />
            <InsuranceRow label="건강보험 (상용)"
              mgmt={insurance.healthRegularMgmt} date={insurance.healthRegularDate}
              onMgmt={(v) => patchIns({ healthRegularMgmt: v })} onDate={(v) => patchIns({ healthRegularDate: v })} />
            <InsuranceRow label="연금보험 (일용)"
              mgmt={insurance.pensionDailyMgmt} date={insurance.pensionDailyDate}
              onMgmt={(v) => patchIns({ pensionDailyMgmt: v })} onDate={(v) => patchIns({ pensionDailyDate: v })} />
            <InsuranceRow label="연금보험 (상용)"
              mgmt={insurance.pensionRegularMgmt} date={insurance.pensionRegularDate}
              onMgmt={(v) => patchIns({ pensionRegularMgmt: v })} onDate={(v) => patchIns({ pensionRegularDate: v })} />
          </div>
        )}

        {/* 단계 4 — 기타사항 */}
        {step === 4 && (
          <div className="srd-wiz__panel">
            <Row cols={2}>
              <FieldX label="사무 담당자" required value={form.manager}
                onChange={(v) => patch({ manager: v })} placeholder="홍길동" />
              <FieldX label="담당자 연락처" required inputMode="tel"
                value={form.managerPhone}
                onChange={(v) => patch({ managerPhone: formatPhone(v) })}
                placeholder="010-1234-5678" />
            </Row>
            <Row cols={2}>
              <FieldX label="팩스" inputMode="tel" value={form.managerFax ?? ''}
                onChange={(v) => patch({ managerFax: formatPhone(v) })}
                placeholder="(선택)" />
              <FieldX label="일찰공고일" type="date" value={form.bidNoticeDate ?? ''}
                onChange={(v) => patch({ bidNoticeDate: v })} />
            </Row>
            <Row cols={3}>
              <RoleX title="현장담당자"
                name={form.siteAgent?.name ?? ''} phone={form.siteAgent?.phone ?? ''}
                onName={(v) => patch({ siteAgent: { ...form.siteAgent, name: v } })}
                onPhone={(v) => patch({ siteAgent: { ...form.siteAgent, phone: formatPhone(v) } })} />
              <RoleX title="안전관리자"
                name={form.safetyOfficer?.name ?? ''} phone={form.safetyOfficer?.phone ?? ''}
                onName={(v) => patch({ safetyOfficer: { ...form.safetyOfficer, name: v } })}
                onPhone={(v) => patch({ safetyOfficer: { ...form.safetyOfficer, phone: formatPhone(v) } })} />
              <RoleX title="품질시험사"
                name={form.qualityInspector?.name ?? ''} phone={form.qualityInspector?.phone ?? ''}
                onName={(v) => patch({ qualityInspector: { ...form.qualityInspector, name: v } })}
                onPhone={(v) => patch({ qualityInspector: { ...form.qualityInspector, phone: formatPhone(v) } })} />
            </Row>
            <Row>
              <FieldX label="보험기준일" type="date" value={form.insuranceBaseDate ?? ''}
                onChange={(v) => patch({ insuranceBaseDate: v })} />
            </Row>
          </div>
        )}

        {errMsg && <p className="srd-wiz__error">{errMsg}</p>}
      </form>
    </Modal>
  );
}

/* ───────── 작은 컴포넌트 ───────── */

function Row({
  children,
  cols = 1,
}: {
  children: React.ReactNode;
  cols?: 1 | 2 | 3 | 'addr';
}) {
  return <div className={'srd-wiz__row srd-wiz__row--' + cols}>{children}</div>;
}

function FieldX({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = 'text',
  inputMode,
  helper,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'url';
  helper?: string;
}) {
  return (
    <div className="srd-wiz__field">
      <label className="srd-wiz__label">
        {label}
        {required && <em className="srd-wiz__req">*</em>}
      </label>
      {type === 'date' ? (
        <MacDatePicker
          value={value}
          onChange={(v) => onChange(v)}
          className="srd-wiz__input"
        />
      ) : (
        <input
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="srd-wiz__input"
        />
      )}
      {helper && <span className="srd-wiz__helper">{helper}</span>}
    </div>
  );
}

function SelectX({
  label, value, options, onChange, required,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="srd-wiz__field">
      <label className="srd-wiz__label">
        {label}
        {required && <em className="srd-wiz__req">*</em>}
      </label>
      <MacSelect
              value={value}
              onChange={(v) => onChange(v)}
              className="srd-wiz__input"
              options={[...options.map((o) => ({ value: o, label: o }))]}
            />
    </div>
  );
}

function InsuranceRow({
  label, mgmt, date, onMgmt, onDate,
}: {
  label: string; mgmt: string; date: string;
  onMgmt: (v: string) => void; onDate: (v: string) => void;
}) {
  return (
    <div className="srd-wiz__ins-row">
      <span className="srd-wiz__ins-label">{label}</span>
      <input type="text" className="srd-wiz__input" placeholder="관리번호"
        value={mgmt} onChange={(e) => onMgmt(e.target.value)} />
      <MacDatePicker
              value={date}
              onChange={(v) => onDate(v)}
              className="srd-wiz__input"
            />
    </div>
  );
}

function RoleX({
  title, name, phone, onName, onPhone,
}: {
  title: string; name: string; phone: string;
  onName: (v: string) => void; onPhone: (v: string) => void;
}) {
  return (
    <div className="srd-wiz__role">
      <p className="srd-wiz__role-title">{title}</p>
      <input className="srd-wiz__input" placeholder="이름"
        value={name} onChange={(e) => onName(e.target.value)} />
      <input className="srd-wiz__input" placeholder="연락처"
        value={phone} onChange={(e) => onPhone(e.target.value)} />
    </div>
  );
}

/* helpers */

function emptyForm(): CreateSiteRequest {
  return {
    name: '', contractKind: '원도급', contractDescription: '',
    contractAmount: 0, contractDate: '', startDate: '', endDate: '',
    bidNoticeDate: '', insuranceBaseDate: '',
    client: '', zipCode: '', address: '', addressDetail: '',
    manager: '', managerPhone: '', managerFax: '',
    siteAgent: {}, safetyOfficer: {}, qualityInspector: {},
  };
}

function emptyInsurance(): InsuranceForm {
  return {
    empMgmt: '', empDate: '',
    woundMgmt: '', woundDate: '',
    healthDailyMgmt: '', healthDailyDate: '',
    healthRegularMgmt: '', healthRegularDate: '',
    pensionDailyMgmt: '', pensionDailyDate: '',
    pensionRegularMgmt: '', pensionRegularDate: '',
  };
}
