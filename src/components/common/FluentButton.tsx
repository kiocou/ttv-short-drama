import React, { ButtonHTMLAttributes, ReactNode } from 'react';

interface FluentButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  children?: ReactNode;
}

export const FluentButton: React.FC<FluentButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  disabled,
  ...props
}) => {
  const sizeStyles = {
    sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg font-medium',
    md: 'h-9 px-4 text-xs gap-2 rounded-xl font-medium',
    lg: 'h-11 px-5 text-sm gap-2.5 rounded-xl font-semibold',
  };

  const variantStyles = {
    primary:
      'fluent-raised-primary text-white font-semibold',
    secondary:
      'fluent-raised-tile text-slate-800 font-medium',
    subtle:
      'bg-transparent hover:bg-slate-200/60 text-slate-600 hover:text-slate-900 active:bg-slate-200/80',
    danger:
      'bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 active:bg-rose-200 shadow-xs',
  };

  return (
    <button
      disabled={disabled}
      className={`inline-flex items-center justify-center select-none transition-all duration-150 fluent-press disabled:opacity-45 disabled:pointer-events-none cursor-pointer flex-shrink-0 ${
        sizeStyles[size]
      } ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children && <span>{children}</span>}
    </button>
  );
};
