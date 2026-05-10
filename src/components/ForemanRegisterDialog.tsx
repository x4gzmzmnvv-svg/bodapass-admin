import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { siteApi } from '../api/site';
import { apiClient, getErrorMessage } from '../api/client';
import type {
  Company,
  Foreman,
  ForemanPermissionPreset,
  ForemanSiteRole,
  Site,
} from '../api/site.types';
import { formatPhone, isValidPhone } from '../utils/validation';
import './ForemanRegisterDialog.css';

import { MacSelect } from './MacSelect';

// 표준 직종 옵션 — 「담당 공종」 드롭다운
const TRADE_OPTIONS = [
  { value: '',          label: '선택 없음' },
  { value: '형틀공',     label: '형틀공' },
  { value: '철근공',     label: '철근공' },
  { value: '콘크리트공', label: '콘크리트공' },
  { value: '미장공',     label: '미장공' },
  { value: '도장공',     label: '도장공' },
  { value: '방수공',     label: '방수공' },
  { value: '타일공',     label: '타일공' },
  { value: '전기공',     label: '전기공' },
  { value: '설비공',     label: '설비공' },
  { value: '용접공',     label: '용접공' },
  { value: '보조',       label: '보조' },
];
interface Props {
  open: boolean;
  onClose: () => void;
  /** 반장을 배정할 현장 (없으면 사이트 셀렉트 표시) */
  sites: Site[];
  defaultSiteId?: string;
  onCreated: (foremen: Foreman[]) => void;
}

interface Row {
  name: string;
  phone: string;
}

const EMPTY_ROW: Row = { name: '', phone: '' };

/**
 * 반장 등록 다이얼로그
 *  · 기본: 이름 + 휴대폰 셀프 등록 안내 발송 (현장 + 채널 선택)
 *  · 「상세 설정」 토글: 소속 회사 / 담당 공종 / 역할 / 권한 프리셋 추가
 *
 *  발송 메시지 예시:
 *    [보다패스 반장 등록 안내]
 *    {반장명}님, {현장명} 현장의 반장으로 초대되었습니다.
 *    아래 링크에서 본인 인증 후 반장 등록을 완료해 주세요.
 *    등록 후 본인 팀원의 얼굴인식 출근처리와 출역 관리를 할 수 있습니다.
 *    등록하기: {링크}
 */
export function ForemanRegisterDialog({
  open,
  onClose,
  sites,
  defaultSiteId,
  onCreated,
}: Props) {
  const [siteId, setSiteId] = useState(defaultSiteId ?? sites[0]?.id ?? '');
  const [channel, setChannel] = useState<'SMS' | 'KAKAO'>('KAKAO');
  const [rows, setRows] = useState<Row[]>([EMPTY_ROW, EMPTY_ROW]);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  // 상세 설정 — 모든 등록 행에 공통 적용
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 발송 메시지 미리보기 — 토글
  const [previewOpen, setPreviewOpen] = useState(false);
  // 편집 가능한 발송 메시지 초안
  const [messageDraft, setMessageDraft] = useState('');
  const [companyId, setCompanyId] = useState<string>('');
  const [trade, setTrade] = useState<string>('');
  const [siteRole, setSiteRole] = useState<ForemanSiteRole>('주반장');
  const [permissionPreset, setPermissionPreset] = useState<ForemanPermissionPreset>('STANDARD');
  const [companies, setCompanies] = useState<Company[]>([]);

  // 회사 목록 가져오기 — 다이얼로그 열릴 때
  useEffect(() => {
    if (!open) return;
    apiClient.get<{ companies: Company[] }>('/companies')
      .then((res) => setCompanies(res.data.companies ?? []))
      .catch(() => setCompanies([]));
  }, [open]);

  // 회사가 1개뿐이고 미선택 상태면 자동 선택
  useEffect(() => {
    if (companies.length === 1 && !companyId) {
      setCompanyId(companies[0].id);
    }
  }, [companies, companyId]);

  useEffect(() => {
    if (open) {
      setSiteId(defaultSiteId ?? sites[0]?.id ?? '');
      setRows([EMPTY_ROW, EMPTY_ROW]);
      setErrMsg(null);
      setResultMsg(null);
      setAdvancedOpen(false);
      setCompanyId('');
      setTrade('');
      setSiteRole('주반장');
      setPermissionPreset('STANDARD');
    }
  }, [open, defaultSiteId, sites]);

  function setRow(idx: number, p: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...p } : r)));
  }
  function addRow() { setRows((rs) => [...rs, EMPTY_ROW]); }
  function removeRow(idx: number) { setRows((rs) => rs.filter((_, i) => i !== idx)); }

  async function handleSubmit() {
    setErrMsg(null);
    setResultMsg(null);

    if (!siteId) {
      setErrMsg('현장을 선택해주세요. 현장이 없다면 먼저 현장을 등록해야 합니다.');
      return;
    }

    const filled = rows
      .map((r) => ({ name: r.name.trim(), phone: r.phone.trim() }))
      .filter((r) => r.name || r.phone);

    if (filled.length === 0) {
      setErrMsg('성명·전화번호를 한 명 이상 입력해주세요.');
      return;
    }
    const invalid = filled.find(
      (r) => !r.name || !r.phone || !isValidPhone(r.phone),
    );
    if (invalid) {
      setErrMsg('각 행의 성명과 휴대폰번호(010-1234-5678) 형식을 다시 확인해주세요.');
      return;
    }

    // 상세 설정 (열려 있는 경우에만 옵션 필드 적용)
    const optional = advancedOpen
      ? {
          companyId: companyId.trim() || undefined,
          trade: trade.trim() || undefined,
          siteRole,
          permissionPreset,
        }
      : {};

    setSubmitting(true);
    try {
      const res = await siteApi.createForemen({
        siteId,
        channel,
        message: messageDraft.trim() || undefined,
        foremen: filled.map((r) => ({ ...r, ...optional })),
      });
      onCreated(res.created);
      const okCount = res.created.length;
      const failCount = res.failures.length;
      if (failCount > 0) {
        setResultMsg(
          `${okCount}명 등록 / 발송 완료 — ${failCount}명 실패: ${res.failures
            .map((f) => `${f.name}(${f.reason})`)
            .join(', ')}`,
        );
      } else {
        setResultMsg(
          `${okCount}명 반장에게 ${channel === 'KAKAO' ? '카카오톡' : 'SMS'} 등록 안내가 발송되었습니다.`,
        );
        setTimeout(() => {
          setResultMsg(null);
          onClose();
        }, 1200);
      }
    } catch (err) {
      setErrMsg(getErrorMessage(err, '반장 등록 실패'));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedSite = sites.find((s) => s.id === siteId);
  // 미리보기 메시지 (반장 1명일 때 첫 번째 행 이름 사용)
  const previewName = rows[0]?.name?.trim() || '{반장명}';
  const previewSite = selectedSite?.name ?? '{현장명}';
  const messagePreview = `[보다패스 반장 등록 안내]
${previewName}님, ${previewSite} 현장의 반장으로 초대되었습니다.
아래 링크에서 본인 인증 후 반장 등록을 완료해 주세요.
등록 후 본인 팀원의 얼굴인식 출근처리와 출역 관리를 할 수 있습니다.
등록하기: https://app.bodapass.com/invite/<TOKEN>`;

  // previewOpen 또는 자동 생성 메시지가 바뀌면 messageDraft 초기화
  useEffect(() => {
    if (previewOpen) setMessageDraft(messagePreview);
  }, [previewOpen, messagePreview]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="반장 발송"
      subtitle="성명과 전화번호를 입력하면 등록 안내가 자동 발송됩니다."
      width={640}
      footer={
        <>
          <button type="button" className="frd__btn frd__btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="frd__btn frd__btn--primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '발송 중…' : '반장 발송'}
          </button>
        </>
      }
    >
      <div className="frd">
        <div className="frd__top">
          <div>
            <label className="frd__label">현장 <span className="frd__req">*</span></label>
            <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              className="frd__select"
              options={sites.length === 0
                ? [{ value: '', label: '— 등록된 현장이 없습니다 —' }]
                : sites.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div>
            <label className="frd__label">발송 채널 <span className="frd__req">*</span></label>
            <div className="frd__seg">
              <button
                type="button"
                className={`frd__seg-btn ${channel === 'KAKAO' ? 'is-active' : ''}`}
                onClick={() => setChannel('KAKAO')}
              >
                카카오톡
              </button>
              <button
                type="button"
                className={`frd__seg-btn ${channel === 'SMS' ? 'is-active' : ''}`}
                onClick={() => setChannel('SMS')}
              >
                SMS
              </button>
            </div>
          </div>
        </div>

        <div className="frd__hint">
          반장님 휴대폰으로 등록 안내가 발송됩니다. 반장이 링크를 누르면 앱에서 본인의
          신원을 등록하고, 이후 본인 현장의 팀원 출퇴근을 처리할 수 있습니다.
        </div>

        <div className="frd__rows">
          {rows.map((r, idx) => (
            <div key={idx} className="frd-row">
              <div className="frd-row__num">{idx + 1}</div>
              <input
                className="frd-row__input"
                placeholder="성명"
                value={r.name}
                onChange={(e) => setRow(idx, { name: e.target.value })}
                disabled={submitting}
              />
              <input
                className="frd-row__input"
                placeholder="010-1234-5678"
                inputMode="tel"
                value={r.phone}
                onChange={(e) => setRow(idx, { phone: formatPhone(e.target.value) })}
                disabled={submitting}
              />
              <button
                type="button"
                className="frd-row__remove"
                onClick={() => removeRow(idx)}
                disabled={rows.length <= 1 || submitting}
                aria-label="이 행 삭제"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="frd__add-row"
          onClick={addRow}
          disabled={submitting}
        >
          ＋ 행 추가
        </button>

        {/* 상세 설정 — 토글 */}
        <button
          type="button"
          className={'frd__advanced-toggle' + (advancedOpen ? ' is-open' : '')}
          onClick={() => setAdvancedOpen((v) => !v)}
          disabled={submitting}
        >
          <span className="frd__advanced-arrow" aria-hidden>{advancedOpen ? '▾' : '▸'}</span>
          상세 설정 (소속 회사 · 담당 공종 · 역할 · 권한 프리셋)
        </button>

        {advancedOpen && (
          <div className="frd__advanced">
            <div className="frd__advanced-grid">
              <label className="frd__field">
                <span className="frd__label">소속 회사</span>
                <MacSelect
                  value={companyId}
                  onChange={(v) => setCompanyId(String(v))}
                  disabled={submitting}
                  className="frd__input"
                  options={[
                    { value: '', label: '선택 없음' },
                    ...companies.map((c) => ({ value: c.id, label: `${c.id} · ${c.name}` })),
                  ]}
                />
              </label>
              <label className="frd__field">
                <span className="frd__label">담당 공종</span>
                <MacSelect
                  value={trade}
                  onChange={(v) => setTrade(String(v))}
                  disabled={submitting}
                  className="frd__input"
                  options={TRADE_OPTIONS}
                />
              </label>
              <label className="frd__field">
                <span className="frd__label">역할</span>
                <MacSelect
              value={siteRole}
              onChange={(v) => setSiteRole(v as ForemanSiteRole)}
              disabled={submitting}
              className="frd__input"
              options={[{ value: "주반장", label: '주반장' }, { value: "보조반장", label: '보조반장' }, { value: "임시반장", label: '임시반장' }]}
            />
              </label>
              <label className="frd__field">
                <span className="frd__label">권한 프리셋</span>
                <MacSelect
              value={permissionPreset}
              onChange={(v) => setPermissionPreset(v as ForemanPermissionPreset)}
              disabled={submitting}
              className="frd__input"
              options={[{ value: "FULL", label: '일반 반장 (FULL)' }, { value: "STANDARD", label: '보조 반장 (STANDARD)' }, { value: "LIMITED", label: '임시 반장 (LIMITED)' }]}
            />
              </label>
            </div>
            <p className="frd__advanced-hint">
              상세 설정은 옵션입니다. 비워두면 기본 「등록완료」 상태로 추가되고,
              「현장배정」에서 보충할 수 있습니다.
            </p>
          </div>
        )}

        {/* 메시지 미리보기 — 토글 */}
        <button
          type="button"
          className={'frd__advanced-toggle' + (previewOpen ? ' is-open' : '')}
          onClick={() => setPreviewOpen((v) => !v)}
          disabled={submitting}
        >
          <span className="frd__advanced-arrow" aria-hidden>{previewOpen ? '▾' : '▸'}</span>
          메시지 미리보기
        </button>
      </div>
    </Modal>
  );
}
