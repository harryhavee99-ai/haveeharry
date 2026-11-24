import type { AspectRatio, ColorGradingConfig } from '../../shared/types.ts';

export function formatTimecode(seconds: number, showDecimals = false): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const dec = Math.floor((s - Math.floor(s)) * 10);
  const base =
    hrs > 0
      ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return showDecimals ? `${base}.${dec}` : base;
}

export function formatDurationHuman(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}

export function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getAspectRatioNumeric(
  ar: AspectRatio,
  sourceWidth?: number,
  sourceHeight?: number
): number {
  switch (ar) {
    case 'original':
      if (sourceWidth && sourceHeight && sourceWidth > 0 && sourceHeight > 0) {
        return sourceWidth / sourceHeight;
      }
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case '16:9':
      return 16 / 9;
    case '1:1':
      return 1;
    case '4:5':
      return 4 / 5;
    case '4:3':
      return 4 / 3;
    default:
      return 9 / 16;
  }
}

export function buildCssFilterFromGrading(g: ColorGradingConfig): string {
  const brightness = 1 + (g.brightness || 0) + (g.exposure || 0) * 0.65 + (g.aiEnhance ? 0.02 : 0);
  const contrast = (g.contrast || 1) + (g.aiEnhance ? 0.04 : 0) + (g.highlights || 0) * 0.2 - (g.shadows || 0) * 0.15;
  const saturate = (g.saturation || 1) + (g.aiEnhance ? 0.04 : 0);
  const sepia = g.temperature > 0 ? Math.min(0.35, g.temperature * 0.6) : 0;
  const hueRotate = g.temperature < 0 ? Math.max(-24, g.temperature * 45) : 0;

  return [
    `brightness(${Math.max(0.4, Math.min(1.8, brightness)).toFixed(3)})`,
    `contrast(${Math.max(0.5, Math.min(1.9, contrast)).toFixed(3)})`,
    `saturate(${Math.max(0, Math.min(2.2, saturate)).toFixed(3)})`,
    sepia > 0.01 ? `sepia(${sepia.toFixed(3)})` : '',
    Math.abs(hueRotate) > 0.5 ? `hue-rotate(${hueRotate.toFixed(1)}deg)` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function isRtlText(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]/.test(text);
}
