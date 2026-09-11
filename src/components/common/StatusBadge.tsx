import React from 'react';

interface StatusBadgeProps {
  label: string;
  variant?: 'default' | 'blue' | 'green' | 'amber' | 'purple' | 'red';
  size?: 'sm' | 'md';
  className?: string;
  dot?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  label,
  variant = 'default',
  size = 'sm',
  className = '',
  dot = false,
}) => {
  const variantStyles = {
    default: 'bg-slate-100/90 text-slate-600 border-slate-200/80',
    blue: 'bg-blue-50/90 text-blue-700 border-blue-200/80',
    green: 'bg-emerald-50/90 text-emerald-700 border-emerald-200/80',
    amber: 'bg-amber-50/90 text-amber-700 border-amber-200/80',
    purple: 'bg-purple-50/90 text-purple-700 border-purple-200/80',
    red: 'bg-rose-50/90 text-rose-700 border-rose-200/80',
  };

  const dotStyles = {
    default: 'bg-slate-400',
    blue: 'bg-blue-600',
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    purple: 'bg-purple-500',
    red: 'bg-rose-500',
  };

  const sizeStyles = {
    sm: 'text-[10px] px-2 py-0.5 rounded-full',
    md: 'text-xs px-2.5 py-1 rounded-full font-medium',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 border shadow-sm backdrop-blur-sm select-none ${
        variantStyles[variant]
      } ${sizeStyles[size]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dotStyles[variant]}`} />}
      {label}
    </span>
  );
};
