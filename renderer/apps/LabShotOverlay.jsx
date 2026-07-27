import React, { useState, useEffect, useRef } from 'react';
import { ArrowElbowDownLeft } from '@phosphor-icons/react/ArrowElbowDownLeft';
import { ArrowRight } from '@phosphor-icons/react/ArrowRight';
import { Check } from '@phosphor-icons/react/Check';
import { Circle } from '@phosphor-icons/react/Circle';
import { Copy } from '@phosphor-icons/react/Copy';
import { DownloadSimple } from '@phosphor-icons/react/DownloadSimple';
import { Drop } from '@phosphor-icons/react/Drop';
import { ListNumbers } from '@phosphor-icons/react/ListNumbers';
import { LockSimple } from '@phosphor-icons/react/LockSimple';
import { PencilSimple } from '@phosphor-icons/react/PencilSimple';
import { PushPin } from '@phosphor-icons/react/PushPin';
import { Square } from '@phosphor-icons/react/Square';
import { TextT } from '@phosphor-icons/react/TextT';
import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { X } from '@phosphor-icons/react/X';

const ipcRenderer = window.electron?.ipcRenderer;

const COLORS = ['#06b6d4', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#ffffff', '#000000'];
const STROKES = [2, 4, 8, 12];

export default function LabShotOverlay() {
  const [screenDataUrl, setScreenDataUrl] = useState(null);
  const [activeTool, setActiveTool] = useState('select'); // select, pen, arrow, rect, circle, text, blur, step
  const [selectedColor, setSelectedColor] = useState('#06b6d4');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [stepCount, setStepCount] = useState(1);
  const [selection, setSelection] = useState(null); // { x, y, w, h }
  const [isSelecting, setIsSelecting] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [annotations, setAnnotations] = useState([]);
  const [history, setHistory] = useState([]);
  const [textInput, setTextInput] = useState(null); // { x, y, text }
  const [statusMsg, setStatusMsg] = useState('');

  const containerRef = useRef(null);
  const bgImageRef = useRef(null);
  const canvasRef = useRef(null);

  // Load screen snapshot on mount
  useEffect(() => {
    async function loadScreen() {
      try {
        const res = await ipcRenderer?.invoke('labshot:getCapturedScreen');
        if (res?.dataUrl) {
          setScreenDataUrl(res.dataUrl);
        }
      } catch (err) {
        console.error('Failed to load screen capture:', err);
      }
    }
    loadScreen();
  }, []);

  // Keyboard hotkey listeners (Esc to cancel, Ctrl+Z to undo, Ctrl+C to copy)
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        closeOverlay();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selection) {
        handleCopy();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, annotations]);

  const closeOverlay = () => {
    ipcRenderer?.invoke('labshot:closeOverlay');
  };

  // Canvas redraw loop
  useEffect(() => {
    if (!canvasRef.current || !screenDataUrl) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Spotlight Dark Overlay if selection exists
    if (selection && selection.w > 0 && selection.h > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.clearRect(selection.x, selection.y, selection.w, selection.h);

      // Selection border
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 2. Render Annotations
    annotations.forEach(ann => {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth;

      if (ann.type === 'pen') {
        ctx.beginPath();
        ann.points.forEach((pt, idx) => {
          if (idx === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
      } else if (ann.type === 'arrow') {
        const dx = ann.to.x - ann.from.x;
        const dy = ann.to.y - ann.from.y;
        const angle = Math.atan2(dy, dx);
        const headlen = ann.strokeWidth * 3.5;

        ctx.beginPath();
        ctx.moveTo(ann.from.x, ann.from.y);
        ctx.lineTo(ann.to.x, ann.to.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(ann.to.x, ann.to.y);
        ctx.lineTo(ann.to.x - headlen * Math.cos(angle - Math.PI / 6), ann.to.y - headlen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(ann.to.x - headlen * Math.cos(angle + Math.PI / 6), ann.to.y - headlen * Math.sin(angle + Math.PI / 6));
        ctx.fill();
      } else if (ann.type === 'rect') {
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      } else if (ann.type === 'circle') {
        ctx.beginPath();
        ctx.ellipse(ann.x + ann.w / 2, ann.y + ann.h / 2, Math.abs(ann.w / 2), Math.abs(ann.h / 2), 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.type === 'blur') {
        ctx.save();
        ctx.fillStyle = 'rgba(120, 120, 120, 0.85)';
        ctx.filter = 'blur(8px)';
        ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
        ctx.restore();
      } else if (ann.type === 'step') {
        ctx.beginPath();
        ctx.arc(ann.x, ann.y, 16, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ann.num), ann.x, ann.y);
      } else if (ann.type === 'text') {
        ctx.font = `bold ${ann.strokeWidth * 5 + 12}px Inter, sans-serif`;
        ctx.fillText(ann.text, ann.x, ann.y);
      }
    });
  }, [screenDataUrl, selection, annotations]);

  // Mouse selection / drawing handlers
  const handleMouseDown = (e) => {
    const x = e.clientX;
    const y = e.clientY;

    if (!selection || activeTool === 'select') {
      setIsSelecting(true);
      setStartPos({ x, y });
      setSelection({ x, y, w: 0, h: 0 });
      return;
    }

    if (activeTool === 'step') {
      const newAnn = { type: 'step', x, y, num: stepCount, color: selectedColor };
      setAnnotations([...annotations, newAnn]);
      setStepCount(stepCount + 1);
      return;
    }

    if (activeTool === 'pen') {
      setIsDrawing(true);
      setAnnotations([...annotations, { type: 'pen', points: [{ x, y }], color: selectedColor, strokeWidth }]);
      return;
    }

    setIsDrawing(true);
    setStartPos({ x, y });
  };

  const handleMouseMove = (e) => {
    const x = e.clientX;
    const y = e.clientY;

    if (isSelecting) {
      const rectX = Math.min(startPos.x, x);
      const rectY = Math.min(startPos.y, y);
      const rectW = Math.abs(x - startPos.x);
      const rectH = Math.abs(y - startPos.y);
      setSelection({ x: rectX, y: rectY, w: rectW, h: rectH });
      return;
    }

    if (!isDrawing) return;

    if (activeTool === 'pen') {
      const updated = [...annotations];
      const current = updated[updated.length - 1];
      if (current && current.type === 'pen') {
        current.points.push({ x, y });
        setAnnotations(updated);
      }
      return;
    }

    if (['arrow', 'rect', 'circle', 'blur'].includes(activeTool)) {
      const updated = [...annotations];
      let current = updated[updated.length - 1];
      if (!current || current.isFinal) {
        current = {
          type: activeTool,
          from: startPos,
          to: { x, y },
          x: Math.min(startPos.x, x),
          y: Math.min(startPos.y, y),
          w: Math.abs(x - startPos.x),
          h: Math.abs(y - startPos.y),
          color: selectedColor,
          strokeWidth
        };
        updated.push(current);
      } else {
        current.to = { x, y };
        current.x = Math.min(startPos.x, x);
        current.y = Math.min(startPos.y, y);
        current.w = Math.abs(x - startPos.x);
        current.h = Math.abs(y - startPos.y);
      }
      setAnnotations(updated);
    }
  };

  const handleMouseUp = () => {
    if (isSelecting) {
      setIsSelecting(false);
      // Auto-switch to pen tool once area is selected
      if (selection && selection.w > 20 && selection.h > 20) {
        setActiveTool('pen');
      }
    }
    if (isDrawing) {
      setIsDrawing(false);
      if (annotations.length > 0) {
        const updated = [...annotations];
        updated[updated.length - 1].isFinal = true;
        setAnnotations(updated);
      }
    }
  };

  const handleUndo = () => {
    if (annotations.length === 0) return;
    const updated = [...annotations];
    const removed = updated.pop();
    setAnnotations(updated);
    setHistory([...history, removed]);
  };

  // Crop snippet to canvas data URL
  const getCroppedDataUrl = async () => {
    if (!screenDataUrl) return null;
    const crop = selection || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

    const img = new Image();
    img.src = screenDataUrl;
    await new Promise(resolve => { img.onload = resolve; });

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.max(1, crop.w);
    cropCanvas.height = Math.max(1, crop.h);
    const ctx = cropCanvas.getContext('2d');

    // Draw background image cropped
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

    // Draw annotations offset by crop.x, crop.y
    annotations.forEach(ann => {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth;

      if (ann.type === 'pen') {
        ctx.beginPath();
        ann.points.forEach((pt, idx) => {
          if (idx === 0) ctx.moveTo(pt.x - crop.x, pt.y - crop.y);
          else ctx.lineTo(pt.x - crop.x, pt.y - crop.y);
        });
        ctx.stroke();
      } else if (ann.type === 'arrow') {
        const dx = ann.to.x - ann.from.x;
        const dy = ann.to.y - ann.from.y;
        const angle = Math.atan2(dy, dx);
        const headlen = ann.strokeWidth * 3.5;

        ctx.beginPath();
        ctx.moveTo(ann.from.x - crop.x, ann.from.y - crop.y);
        ctx.lineTo(ann.to.x - crop.x, ann.to.y - crop.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(ann.to.x - crop.x, ann.to.y - crop.y);
        ctx.lineTo(ann.to.x - crop.x - headlen * Math.cos(angle - Math.PI / 6), ann.to.y - crop.y - headlen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(ann.to.x - crop.x - headlen * Math.cos(angle + Math.PI / 6), ann.to.y - crop.y - headlen * Math.sin(angle + Math.PI / 6));
        ctx.fill();
      } else if (ann.type === 'rect') {
        ctx.strokeRect(ann.x - crop.x, ann.y - crop.y, ann.w, ann.h);
      } else if (ann.type === 'circle') {
        ctx.beginPath();
        ctx.ellipse(ann.x - crop.x + ann.w / 2, ann.y - crop.y + ann.h / 2, Math.abs(ann.w / 2), Math.abs(ann.h / 2), 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.type === 'blur') {
        ctx.save();
        ctx.fillStyle = 'rgba(120, 120, 120, 0.85)';
        ctx.fillRect(ann.x - crop.x, ann.y - crop.y, ann.w, ann.h);
        ctx.restore();
      } else if (ann.type === 'step') {
        ctx.beginPath();
        ctx.arc(ann.x - crop.x, ann.y - crop.y, 16, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ann.num), ann.x - crop.x, ann.y - crop.y);
      }
    });

    return cropCanvas.toDataURL('image/png');
  };

  const handleCopy = async () => {
    const dataUrl = await getCroppedDataUrl();
    if (!dataUrl) return;
    setStatusMsg('Copied to clipboard!');
    await ipcRenderer?.invoke('labshot:copyToClipboard', { dataUrl });
    setTimeout(closeOverlay, 300);
  };

  const handleSaveFile = async () => {
    const dataUrl = await getCroppedDataUrl();
    if (!dataUrl) return;
    const res = await ipcRenderer?.invoke('labshot:saveToFile', { dataUrl });
    if (res?.success) closeOverlay();
  };

  const handleSaveVault = async () => {
    const dataUrl = await getCroppedDataUrl();
    if (!dataUrl) return;
    setStatusMsg('Encrypted & saved to Vault!');
    await ipcRenderer?.invoke('labshot:saveToVault', { dataUrl });
    setTimeout(closeOverlay, 400);
  };

  const handlePin = async () => {
    const dataUrl = await getCroppedDataUrl();
    if (!dataUrl) return;
    const crop = selection || { x: 100, y: 100, w: 400, h: 300 };
    await ipcRenderer?.invoke('labshot:pinToScreen', {
      dataUrl,
      width: crop.w,
      height: crop.h,
      x: crop.x,
      y: crop.y
    });
    closeOverlay();
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        cursor: activeTool === 'select' ? 'crosshair' : 'default',
        userSelect: 'none',
        overflow: 'hidden'
      }}
    >
      {/* 1. Fullscreen background screen image */}
      {screenDataUrl && (
        <img
          ref={bgImageRef}
          src={screenDataUrl}
          alt="Screen Capture"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}

      {/* 2. Interactive Annotation Canvas */}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0 }} />

      {/* 3. Floating Selection Dimensions Indicator */}
      {selection && selection.w > 0 && selection.h > 0 && (
        <div
          style={{
            position: 'absolute',
            left: selection.x,
            top: Math.max(10, selection.y - 28),
            background: 'rgba(15, 23, 42, 0.9)',
            border: '1px solid rgba(6, 182, 212, 0.4)',
            color: '#38bdf8',
            fontSize: '12px',
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: '4px',
            pointerEvents: 'none',
            fontFamily: 'monospace'
          }}
        >
          {Math.round(selection.w)} × {Math.round(selection.h)} px
        </div>
      )}

      {/* 4. Status Toast Notification */}
      {statusMsg && (
        <div
          style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#06b6d4',
            color: '#0f172a',
            fontWeight: 700,
            padding: '8px 16px',
            borderRadius: '20px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 999
          }}
        >
          {statusMsg}
        </div>
      )}

      {/* 5. Flameshot Toolbar Floating Below Selection */}
      {selection && selection.w > 20 && selection.h > 20 && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(window.innerWidth - 480, Math.max(10, selection.x)),
            top: Math.min(window.innerHeight - 60, selection.y + selection.h + 12),
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '8px',
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.7)',
            zIndex: 100
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Tool selector buttons */}
          <button
            onClick={() => setActiveTool('pen')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'pen' ? '#06b6d4' : 'transparent',
              color: activeTool === 'pen' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Pen / Freehand"
          >
            <PencilSimple size={18} weight="bold" />
          </button>

          <button
            onClick={() => setActiveTool('arrow')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'arrow' ? '#06b6d4' : 'transparent',
              color: activeTool === 'arrow' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Arrow"
          >
            <ArrowRight size={18} weight="bold" />
          </button>

          <button
            onClick={() => setActiveTool('rect')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'rect' ? '#06b6d4' : 'transparent',
              color: activeTool === 'rect' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Rectangle"
          >
            <Square size={18} weight="bold" />
          </button>

          <button
            onClick={() => setActiveTool('circle')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'circle' ? '#06b6d4' : 'transparent',
              color: activeTool === 'circle' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Circle"
          >
            <Circle size={18} weight="bold" />
          </button>

          <button
            onClick={() => setActiveTool('blur')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'blur' ? '#06b6d4' : 'transparent',
              color: activeTool === 'blur' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Privacy Blur / Pixelate"
          >
            <Drop size={18} weight="bold" />
          </button>

          <button
            onClick={() => setActiveTool('step')}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: activeTool === 'step' ? '#06b6d4' : 'transparent',
              color: activeTool === 'step' ? '#0f172a' : '#94a3b8',
              cursor: 'pointer'
            }}
            title="Step Counter (1, 2, 3...)"
          >
            <ListNumbers size={18} weight="bold" />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />

          {/* Color Palette Picker */}
          <div style={{ display: 'flex', gap: '4px' }}>
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setSelectedColor(c)}
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: c,
                  border: selectedColor === c ? '2px solid #ffffff' : '1px solid rgba(0,0,0,0.5)',
                  cursor: 'pointer'
                }}
              />
            ))}
          </div>

          <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />

          {/* Undo */}
          <button
            onClick={handleUndo}
            disabled={annotations.length === 0}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: annotations.length > 0 ? '#94a3b8' : '#475569',
              cursor: annotations.length > 0 ? 'pointer' : 'default'
            }}
            title="Undo (Ctrl+Z)"
          >
            <ArrowCounterClockwise size={18} />
          </button>

          {/* Action output buttons */}
          <button
            onClick={handlePin}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: 'none',
              background: '#334155',
              color: '#e2e8f0',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer'
            }}
            title="Pin to Screen"
          >
            <PushPin size={16} /> Pin
          </button>

          <button
            onClick={handleSaveVault}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: 'none',
              background: '#0284c7',
              color: '#ffffff',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer'
            }}
            title="Save to Encrypted Vault"
          >
            <LockSimple size={16} /> Vault
          </button>

          <button
            onClick={handleCopy}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              background: '#06b6d4',
              color: '#0f172a',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer'
            }}
            title="Copy to Clipboard (Ctrl+C)"
          >
            <Copy size={16} weight="bold" /> Copy
          </button>

          <button
            onClick={closeOverlay}
            style={{
              padding: '6px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: '#ef4444',
              cursor: 'pointer',
              marginLeft: '4px'
            }}
            title="Cancel (Esc)"
          >
            <X size={18} weight="bold" />
          </button>
        </div>
      )}
    </div>
  );
}
