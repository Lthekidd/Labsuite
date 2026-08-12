import React from 'react';

export default function LabMediaMark({ size = 20, className = '', style, color = '#1db954' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ display: 'block', flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="labMediaGradient" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1db954" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      
      {/* Outer Glow Ring */}
      <circle cx="12" cy="12" r="10" stroke="url(#labMediaGradient)" strokeWidth="2" fill="none" opacity="0.9" />
      
      {/* Equalizer Bars */}
      <rect x="6.5" y="10" width="2" height="4" rx="1" fill="url(#labMediaGradient)" />
      <rect x="10" y="7" width="2" height="10" rx="1" fill="url(#labMediaGradient)" />
      <rect x="13.5" y="9" width="2" height="6" rx="1" fill="url(#labMediaGradient)" />
      <rect x="17" y="11" width="2" height="2" rx="1" fill="url(#labMediaGradient)" />
    </svg>
  );
}
