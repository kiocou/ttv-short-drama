import React, { ReactNode } from 'react';

interface MicaCardProps {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
}

export const MicaCard: React.FC<MicaCardProps> = ({
  children,
  className = '',
  hoverable = false,
  onClick,
  style,
}) => {
  return (
    <div
      onClick={onClick}
      style={style}
      className={`relative rounded-xl border border-white/80 bg-white/75 backdrop-blur-xl shadow-fluent overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        hoverable
          ? 'cursor-pointer hover:bg-white/95 hover:-translate-y-1.5 hover:shadow-fluent-lg hover:border-white hover:ring-1 hover:ring-blue-400/20 active:scale-[0.98] active:translate-y-0 active:shadow-fluent active:duration-100 will-change-transform'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};
