import { ReactNode } from 'react';
import './PageHeader.css';

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/** 각 페이지 상단에 공통으로 쓰는 타이틀 영역 */
export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
