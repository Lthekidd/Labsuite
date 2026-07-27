import React from 'react';
import brandMark from '../assets/brand/labsuite-mark-ui.png';

export default function BrandMark({ size = 20, className = '', decorative = true }) {
  return (
    <img
      className={className}
      src={brandMark}
      width={size}
      height={size}
      alt={decorative ? '' : 'LabSuite'}
      aria-hidden={decorative ? 'true' : undefined}
      draggable="false"
    />
  );
}
