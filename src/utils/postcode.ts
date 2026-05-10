/**
 * 다음(Daum/Kakao) 우편번호 검색 — 한국 표준
 *  · 호출 시 외부 스크립트를 1회 로드하고 팝업 오픈
 *  · 콜백으로 zonecode + 도로명/지번 주소 + 부가 정보 전달
 *
 * 사용:
 *   openPostcode((d) => { setAddr(d.address); setZip(d.zonecode); });
 */

interface DaumPostcodeData {
  zonecode: string;
  address: string;
  addressType: string;
  bname: string;
  buildingName: string;
  jibunAddress: string;
  roadAddress: string;
}

declare global {
  interface Window {
    daum?: {
      Postcode: new (config: {
        oncomplete: (data: DaumPostcodeData) => void;
        onclose?: () => void;
        width?: string | number;
        height?: string | number;
      }) => { open: (opt?: { popupTitle?: string; popupKey?: string }) => void };
    };
  }
}

const SCRIPT_URL = '//t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
let loadingPromise: Promise<void> | null = null;

function loadDaumScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.daum?.Postcode) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  loadingPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loadingPromise = null;
      reject(new Error('Daum Postcode 스크립트 로드 실패'));
    };
    document.body.appendChild(s);
  });
  return loadingPromise;
}

export interface PostcodeResult {
  /** 우편번호 (5자리) */
  zonecode: string;
  /** 표시용 전체 주소 (도로명 + 부가) */
  address: string;
  /** 도로명 */
  roadAddress: string;
  /** 지번 */
  jibunAddress: string;
  /** 법정동명 */
  bname: string;
  /** 건물명 */
  buildingName: string;
}

export async function openPostcode(
  onSelect: (data: PostcodeResult) => void,
): Promise<void> {
  try {
    await loadDaumScript();
    if (!window.daum?.Postcode) throw new Error('Daum Postcode unavailable');
    new window.daum.Postcode({
      oncomplete: (d) => {
        // 도로명 우선 + (법정동, 건물명) 부가
        let addr = d.roadAddress || d.address || '';
        const extras: string[] = [];
        if (d.bname) extras.push(d.bname);
        if (d.buildingName) extras.push(d.buildingName);
        if (extras.length) addr += ` (${extras.join(', ')})`;
        onSelect({
          zonecode: d.zonecode,
          address: addr,
          roadAddress: d.roadAddress,
          jibunAddress: d.jibunAddress,
          bname: d.bname,
          buildingName: d.buildingName,
        });
      },
    }).open({ popupTitle: '주소 검색' });
  } catch (e) {
    window.alert(
      '주소 검색을 불러올 수 없습니다. 인터넷 연결을 확인하거나, 직접 입력해주세요.',
    );
  }
}
