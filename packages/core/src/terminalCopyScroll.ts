export interface CopyLayerScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  lineHeight: number;
  rowsFromBottom: number;
}

export interface WheelDeltaMetrics {
  deltaY: number;
  deltaMode: number;
  lineHeight: number;
  pageHeight: number;
}

export function copyLayerScrollTopForAnchor({
  scrollHeight,
  clientHeight,
  lineHeight,
  rowsFromBottom,
}: CopyLayerScrollMetrics): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const target =
    maxScrollTop - Math.max(0, rowsFromBottom) * Math.max(0, lineHeight);
  return Math.max(0, Math.min(maxScrollTop, target));
}

export function wheelDeltaYToPixels({
  deltaY,
  deltaMode,
  lineHeight,
  pageHeight,
}: WheelDeltaMetrics): number {
  if (deltaMode === 1) return deltaY * lineHeight;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}
