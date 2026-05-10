import { useEffect, useMemo, useRef, useState } from 'react';
import { JOB_BY_CATEGORY, JOB_CATEGORIES, POPULAR_JOBS, findJobByName } from '../data/jobs';
import './RoleSelect.css';

interface Props {
  value: string;
  onChange: (jobName: string) => void;
  placeholder?: string;
}

/**
 * 직무범위.xlsx 의 303개 직종 중 하나를 검색·선택.
 *  - 입력창에 키워드 입력 → 카테고리/이름/설명에서 매칭
 *  - 빠른 선택(POPULAR_JOBS)을 칩으로 노출
 *  - 선택된 직종은 카테고리 라벨과 짧은 설명을 함께 표시
 */
export function RoleSelect({ value, onChange, placeholder = '직종을 선택하세요' }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const selected = useMemo(() => findJobByName(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: { cat: string; name: string; description: string }[] = [];
    for (const cat of JOB_CATEGORIES) {
      for (const j of JOB_BY_CATEGORY[cat]) {
        if (
          j.name.toLowerCase().includes(q) ||
          (j.description && j.description.toLowerCase().includes(q))
        ) {
          out.push({ cat, name: j.name, description: j.description });
        }
        if (out.length >= 60) break;
      }
      if (out.length >= 60) break;
    }
    return out;
  }, [query]);

  function pick(name: string) {
    onChange(name);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="rsel" ref={wrapRef}>
      <button
        type="button"
        className={'rsel__btn ' + (open ? 'is-open' : '')}
        onClick={() => setOpen((v) => !v)}
      >
        {value ? (
          <span className="rsel__btn-text">
            <span className="rsel__btn-name">{value}</span>
            {selected?.insuranceName && (
              <span className="rsel__btn-cat">{selected.insuranceName}</span>
            )}
          </span>
        ) : (
          <span className="rsel__placeholder">{placeholder}</span>
        )}
        <span className="rsel__arrow" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="rsel__panel">
          <div className="rsel__search">
            <input
              autoFocus
              className="rsel__search-input"
              placeholder="이름·설명·카테고리로 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {!query && (
            <div className="rsel__pop">
              <p className="rsel__pop-label">빠른 선택</p>
              <div className="rsel__pop-row">
                {POPULAR_JOBS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={'rsel__chip ' + (value === p ? 'is-active' : '')}
                    onClick={() => pick(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rsel__list">
            {query ? (
              filtered && filtered.length > 0 ? (
                filtered.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    className="rsel__item"
                    onClick={() => pick(f.name)}
                  >
                    <span className="rsel__item-name">{f.name}</span>
                    <span className="rsel__item-meta">{f.cat}</span>
                    {f.description && (
                      <span className="rsel__item-desc">{f.description}</span>
                    )}
                  </button>
                ))
              ) : (
                <p className="rsel__empty">"{query}" 에 해당하는 직종이 없습니다.</p>
              )
            ) : (
              JOB_CATEGORIES.map((cat) => (
                <details key={cat} className="rsel__group">
                  <summary>
                    <span>{cat}</span>
                    <span className="rsel__group-count">{JOB_BY_CATEGORY[cat].length}</span>
                  </summary>
                  <div className="rsel__group-list">
                    {JOB_BY_CATEGORY[cat].map((j) => (
                      <button
                        key={j.name}
                        type="button"
                        className={'rsel__item ' + (value === j.name ? 'is-active' : '')}
                        onClick={() => pick(j.name)}
                      >
                        <span className="rsel__item-name">{j.name}</span>
                        {j.description && (
                          <span className="rsel__item-desc">{j.description}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </details>
              ))
            )}
          </div>

          <p className="rsel__foot">
            건설업 직종 분류 — 4대보험 표 기준 303개 (출처: 직무범위.xlsx)
          </p>
        </div>
      )}
    </div>
  );
}
