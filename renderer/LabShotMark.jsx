import React from 'react';
import labShotMark from '../assets/brand/labshot-mark-ui.png';

export default function LabShotMark({ size = 20, className = '', style, decorative = true }) {
  return (
    <img
      className={className}
      src={labShotMark}
      width={size}
      height={size}
      style={{ display: 'block', objectFit: 'contain', ...style }}
      alt={decorative ? '' : 'LabShot'}
      aria-hidden={decorative ? 'true' : undefined}
      draggable="false"
    />
  );
}
