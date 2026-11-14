import React, { useState, useRef, useEffect, useMemo } from 'react';
import { CandleData, TradeRecord, StockQuote, StockStrategySignal } from '../types/stock.ts';
import { Maximize2, Minimize2, Crosshair, AlertTriangle, Star, RefreshCw, TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import { InstitutionalTradesPanel } from './InstitutionalTradesPanel.tsx';

interface InteractiveChartProps {
  candles: CandleData[];
  symbol: string;
  stockName: string;
  trades?: TradeRecord[];
  strategySignal?: StockStrategySignal;
  isLoading?: boolean;
  selectedRange?: string;
  onRangeChange?: (range: string) => void;
  error?: string | null;
  liveQuote?: StockQuote | null;
  isInWatchlist?: boolean;
  onToggleWatchlist?: () => void;
  isAutoRefresh?: boolean;
  autoRefreshCountdown?: number;
  onToggleAutoRefresh?: () => void;
  isRefreshingQuote?: boolean;
  onRefreshQuote?: () => void;
}

export const InteractiveChart: React.FC<InteractiveChartProps> = ({
  candles,
  symbol,
  stockName,
  trades = [],
  strategySignal,
  isLoading = false,
  selectedRange = '2y',
  onRangeChange,
  error,
  liveQuote,
  isInWatchlist = false,
  onToggleWatchlist,
  isAutoRefresh = true,
  autoRefreshCountdown = 15,
  onToggleAutoRefresh,
  isRefreshingQuote = false,
  onRefreshQuote,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [showMAs, setShowMAs] = useState<{ ma5: boolean; ma20: boolean; ma60: boolean }>({
    ma5: true,
    ma20: true,
    ma60: true,
  });
  const [showBollinger, setShowBollinger] = useState<boolean>(true);
  const [showTradeMarkers, setShowTradeMarkers] = useState<boolean>(true);
  const [showIndicatorsDetail, setShowIndicatorsDetail] = useState<boolean>(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [isCrosshairLocked, setIsCrosshairLocked] = useState<boolean>(false);
  const isCrosshairLockedRef = useRef<boolean>(false);
  const [longPressRing, setLongPressRing] = useState<{ x: number; y: number; progress: number; exiting: boolean } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    isCrosshairLockedRef.current = isCrosshairLocked;
  }, [isCrosshairLocked]);

  // Reset zoom, pan & crosshair lock when symbol changes to ensure newly searched stock is centered immediately
  useEffect(() => {
    setOffsetRight(0);
    setHoverIndex(null);
    setIsCrosshairLocked(false);
    isCrosshairLockedRef.current = false;
  }, [symbol]);

  // Responsive resize tracking - monitors container visibility, tab switching & symbol transitions
  useEffect(() => {
    const handleResize = () => {
      const targetEl = canvasRef.current || containerRef.current;
      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setDimensions(prev => {
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            if (prev.width === w && prev.height === h) return prev;
            return { width: w, height: h };
          });
        }
      }
    };

    handleResize();

    // Multiple staggered frames (0ms, 60ms, 150ms, 350ms) to reliably catch mobile CSS display transitions
    const rafId = requestAnimationFrame(handleResize);
    const timer1 = setTimeout(handleResize, 60);
    const timer2 = setTimeout(handleResize, 150);
    const timer3 = setTimeout(handleResize, 350);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        handleResize();
      });
      if (containerRef.current) ro.observe(containerRef.current);
      if (canvasRef.current) ro.observe(canvasRef.current);
    }

    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [isFullscreen, symbol, candles.length, isLoading]);

  // Zoom & Pan state: default show ~75 daily candles for comfortable viewing on 2-year dataset
  const [visibleCount, setVisibleCount] = useState<number>(75);
  const [offsetRight, setOffsetRight] = useState<number>(0); // 0 means latest candle is on the right edge

  useEffect(() => {
    if (candles.length > 0) {
      setVisibleCount(prev => Math.min(Math.max(25, prev), candles.length));
    }
  }, [candles.length]);

  // Touch & Mouse drag handling for panning
  const isDragging = useRef<boolean>(false);
  const startX = useRef<number>(0);
  const startOffset = useRef<number>(0);

  // Compute sliced visible candles
  const visibleData = useMemo(() => {
    if (!candles || candles.length === 0) return [];
    const total = candles.length;
    const end = Math.max(0, total - offsetRight);
    const start = Math.max(0, end - visibleCount);
    return candles.slice(start, end);
  }, [candles, visibleCount, offsetRight]);

  const activeHoverCandle = useMemo(() => {
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < visibleData.length) {
      return visibleData[hoverIndex];
    }
    return visibleData.length > 0 ? visibleData[visibleData.length - 1] : null;
  }, [hoverIndex, visibleData]);


  // Canvas drawing: All-in-one unified view (Price + Volume + KD + MACD + Strategy Trade Markers)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || visibleData.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (width <= 0 || height <= 0) {
      const raf = requestAnimationFrame(() => {
        if (canvasRef.current) {
          const r = canvasRef.current.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            setDimensions({ width: Math.round(r.width), height: Math.round(r.height) });
          }
        }
      });
      return () => cancelAnimationFrame(raf);
    }

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // 4 Integrated Zones:
    // 1. Price + MAs + Strategy Markers: 46%
    // 2. Volume: 14%
    // 3. KD (9, 3, 3): 18%
    // 4. MACD (12, 26, 9): 22%
    const priceTop = 22;
    const priceBottom = height * 0.46;
    const priceHeight = priceBottom - priceTop;

    const volTop = priceBottom + 14;
    const volBottom = priceBottom + height * 0.15;
    const volHeight = volBottom - volTop;

    const kdTop = volBottom + 16;
    const kdBottom = volBottom + height * 0.17;
    const kdHeight = kdBottom - kdTop;

    const macdTop = kdBottom + 16;
    const macdBottom = height - 22;
    const macdHeight = macdBottom - macdTop;

    // Clear background (dark trading floor slate)
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, width, height);

    const chartRight = width - 64;
    const count = visibleData.length;
    const candleWidth = Math.max(2, (chartRight / count) * 0.72);
    const step = chartRight / count;

    // Grid lines styling
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;

    // -------------------------------------------------------------
    // ZONE 1: K-LINE PRICE & MOVING AVERAGES
    // -------------------------------------------------------------
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVol = 0;

    visibleData.forEach(c => {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
      if (showMAs.ma5 && c.ma5) {
        minPrice = Math.min(minPrice, c.ma5);
        maxPrice = Math.max(maxPrice, c.ma5);
      }
      if (showMAs.ma20 && c.ma20) {
        minPrice = Math.min(minPrice, c.ma20);
        maxPrice = Math.max(maxPrice, c.ma20);
      }
      if (showMAs.ma60 && c.ma60) {
        minPrice = Math.min(minPrice, c.ma60);
        maxPrice = Math.max(maxPrice, c.ma60);
      }
      if (showBollinger && c.bbUpper) {
        maxPrice = Math.max(maxPrice, c.bbUpper);
      }
      if (showBollinger && c.bbLower) {
        minPrice = Math.min(minPrice, c.bbLower);
      }
      if (c.volume > maxVol) maxVol = c.volume;
    });

    const pricePadding = (maxPrice - minPrice) * 0.08 || 1;
    minPrice -= pricePadding;
    maxPrice += pricePadding;

    const getY = (val: number) => priceBottom - ((val - minPrice) / (maxPrice - minPrice)) * priceHeight;

    // Horizontal grid in price area
    for (let i = 0; i <= 4; i++) {
      const y = priceTop + (priceHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();

      const val = minPrice + ((maxPrice - minPrice) / 4) * (4 - i);
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(val.toFixed(1), chartRight + 6, y + 3);
    }

    // Section 1 label: K線主圖
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('日K線', 8, priceTop - 8);

    // Candlesticks (Taiwan: Red UP, Green DOWN)
    visibleData.forEach((c, idx) => {
      const x = idx * step + step / 2;
      const isUp = c.close >= c.open;
      const barColor = isUp ? '#ef4444' : '#22c55e';

      ctx.strokeStyle = barColor;
      ctx.fillStyle = barColor;

      // Wick
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, getY(c.high));
      ctx.lineTo(x, getY(c.low));
      ctx.stroke();

      // Body
      const openY = getY(c.open);
      const closeY = getY(c.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // Draw MA lines
    const drawLine = (prop: 'ma5' | 'ma20' | 'ma60', color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      visibleData.forEach((c, idx) => {
        const val = c[prop];
        if (val !== undefined) {
          const x = idx * step + step / 2;
          const y = getY(val);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      ctx.stroke();
    };

    if (showMAs.ma5) drawLine('ma5', '#eab308'); // yellow MA5
    if (showMAs.ma20) drawLine('ma20', '#3b82f6'); // blue MA20
    if (showMAs.ma60) drawLine('ma60', '#a855f7'); // purple MA60

    // Draw Bollinger Bands (shaded channel & upper/lower lines)
    if (showBollinger) {
      // 1. Shaded Band Channel
      ctx.save();
      ctx.fillStyle = 'rgba(168, 85, 247, 0.08)';
      ctx.beginPath();
      let bbTopStarted = false;
      visibleData.forEach((c, idx) => {
        if (c.bbUpper !== undefined) {
          const x = idx * step + step / 2;
          const y = getY(c.bbUpper);
          if (!bbTopStarted) {
            ctx.moveTo(x, y);
            bbTopStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      });
      for (let idx = visibleData.length - 1; idx >= 0; idx--) {
        const c = visibleData[idx];
        if (c.bbLower !== undefined) {
          const x = idx * step + step / 2;
          const y = getY(c.bbLower);
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 2. Upper and Lower lines
      const drawBbLine = (prop: 'bbUpper' | 'bbLower', color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        let started = false;
        visibleData.forEach((c, idx) => {
          const val = c[prop];
          if (val !== undefined) {
            const x = idx * step + step / 2;
            const y = getY(val);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        });
        ctx.stroke();
      };

      drawBbLine('bbUpper', '#c084fc');
      drawBbLine('bbLower', '#c084fc');
    }

    // -------------------------------------------------------------
    // STRATEGY TRADE MARKERS (進場 ▲ / 出場 ▼ / 停損 ▼) & LIVE STRATEGY SIGNAL
    // -------------------------------------------------------------
    if (showTradeMarkers) {
      const timeToVisibleIndex = new Map<string, number>();
      visibleData.forEach((c, idx) => {
        timeToVisibleIndex.set(c.time, idx);
      });

      const entryDrawnIndices = new Set<number>();

      if (trades && trades.length > 0) {
        trades.forEach(trade => {
          const entryIdx = timeToVisibleIndex.get(trade.entryDate);
          const exitIdx = trade.exitDate ? timeToVisibleIndex.get(trade.exitDate) : undefined;

          // 1. Draw dashed connecting line between entry & exit if both are visible
          if (entryIdx !== undefined && exitIdx !== undefined) {
            const x1 = entryIdx * step + step / 2;
            const y1 = getY(trade.entryPrice);
            const x2 = exitIdx * step + step / 2;
            const y2 = getY(trade.exitPrice);

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = trade.isWin ? 'rgba(34, 197, 94, 0.65)' : 'rgba(239, 68, 68, 0.65)';
            ctx.stroke();
            ctx.restore();
          }

          // 2. Entry Marker: ▲ 買進 (Placed below the candle)
          if (entryIdx !== undefined) {
            entryDrawnIndices.add(entryIdx);
            const c = visibleData[entryIdx];
            const x = entryIdx * step + step / 2;
            const yAnchor = Math.min(priceBottom - 8, getY(c.low) + 8);

            ctx.save();
            // Upward Triangle Arrow
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(x, yAnchor);
            ctx.lineTo(x - 4, yAnchor + 6);
            ctx.lineTo(x + 4, yAnchor + 6);
            ctx.closePath();
            ctx.fill();

            // Pill text label: 買 $xxx
            const label = `買 $${trade.entryPrice}`;
            ctx.font = 'bold 8.5px sans-serif';
            const textWidth = ctx.measureText(label).width;
            const pillW = textWidth + 8;
            const pillH = 13;
            const pillX = Math.max(2, Math.min(chartRight - pillW, x - pillW / 2));
            const pillY = yAnchor + 7;

            ctx.fillStyle = '#b91c1c';
            ctx.fillRect(pillX, pillY, pillW, pillH);
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(pillX, pillY, pillW, pillH);

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(label, pillX + pillW / 2, pillY + 10);
            ctx.restore();
          }

          // 3. Exit / Stop-Loss Marker: ▼ (Placed above the candle)
          if (exitIdx !== undefined) {
            const c = visibleData[exitIdx];
            const x = exitIdx * step + step / 2;
            const yAnchor = Math.max(priceTop + 14, getY(c.high) - 8);

            const isStopLoss = trade.exitReason?.includes('停損') || trade.returnPct < 0;
            const badgeColor = isStopLoss ? '#be123c' : '#047857';
            const strokeColor = isStopLoss ? '#fb7185' : '#34d399';
            const arrowColor = isStopLoss ? '#f43f5e' : '#10b981';
            const label = isStopLoss
              ? `停損 ${trade.returnPct}%`
              : `停利 +${trade.returnPct}%`;

            ctx.save();
            // Downward Triangle Arrow
            ctx.fillStyle = arrowColor;
            ctx.beginPath();
            ctx.moveTo(x, yAnchor);
            ctx.lineTo(x - 4, yAnchor - 6);
            ctx.lineTo(x + 4, yAnchor - 6);
            ctx.closePath();
            ctx.fill();

            // Pill text label: 停損 -x% 或 停利 +x%
            ctx.font = 'bold 8.5px sans-serif';
            const textWidth = ctx.measureText(label).width;
            const pillW = textWidth + 8;
            const pillH = 13;
            const pillX = Math.max(2, Math.min(chartRight - pillW, x - pillW / 2));
            const pillY = yAnchor - 6 - pillH;

            ctx.fillStyle = badgeColor;
            ctx.fillRect(pillX, pillY, pillW, pillH);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(pillX, pillY, pillW, pillH);

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(label, pillX + pillW / 2, pillY + 10);
            ctx.restore();
          }
        });
      }

      // Check current live/active StrategySignal (BUY or HOLD):
      // When strategySignal shows 'BUY' or 'HOLD', ensure that candle displays ▲ 買進
      if (strategySignal && (strategySignal.status === 'BUY' || strategySignal.status === 'HOLD')) {
        let targetIdx: number | undefined;
        if (strategySignal.entryDate) {
          targetIdx = timeToVisibleIndex.get(strategySignal.entryDate);
        }
        // If status is 'BUY' and entryDate wasn't matched in visibleData (e.g. entry is on current bar), use the latest visible candle
        if (targetIdx === undefined && strategySignal.status === 'BUY' && visibleData.length > 0) {
          targetIdx = visibleData.length - 1;
        }

        if (targetIdx !== undefined && !entryDrawnIndices.has(targetIdx)) {
          const c = visibleData[targetIdx];
          const x = targetIdx * step + step / 2;
          const yAnchor = Math.min(priceBottom - 8, getY(c.low) + 8);
          const price = strategySignal.entryPrice || c.close;
          const isLatestBuy = strategySignal.status === 'BUY';

          ctx.save();
          // Vertical trigger guide dashed line
          ctx.beginPath();
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = isLatestBuy ? 'rgba(244, 63, 94, 0.7)' : 'rgba(239, 68, 68, 0.4)';
          ctx.moveTo(x, priceTop);
          ctx.lineTo(x, yAnchor);
          ctx.stroke();

          // Upward Triangle Arrow
          ctx.fillStyle = isLatestBuy ? '#f43f5e' : '#ef4444';
          ctx.beginPath();
          ctx.moveTo(x, yAnchor);
          ctx.lineTo(x - 5, yAnchor + 7);
          ctx.lineTo(x + 5, yAnchor + 7);
          ctx.closePath();
          ctx.fill();

          // High-contrast badge: ▲ 買進 $xxx
          const label = isLatestBuy ? `▲ 買進 $${price}` : `買 $${price}`;
          ctx.font = 'bold 9px sans-serif';
          const textWidth = ctx.measureText(label).width;
          const pillW = textWidth + 10;
          const pillH = 15;
          const pillX = Math.max(2, Math.min(chartRight - pillW, x - pillW / 2));
          const pillY = yAnchor + 8;

          ctx.fillStyle = isLatestBuy ? '#be123c' : '#b91c1c';
          ctx.fillRect(pillX, pillY, pillW, pillH);
          ctx.strokeStyle = isLatestBuy ? '#fb7185' : '#f87171';
          ctx.lineWidth = 1;
          ctx.strokeRect(pillX, pillY, pillW, pillH);

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.fillText(label, pillX + pillW / 2, pillY + 11);
          ctx.restore();
        }
      }
    }

    // -------------------------------------------------------------
    // ZONE 2: VOLUME (成交量)
    // -------------------------------------------------------------
    ctx.beginPath();
    ctx.moveTo(0, volTop);
    ctx.lineTo(chartRight, volTop);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('成交量', 8, volTop - 3);

    if (maxVol > 0) {
      visibleData.forEach((c, idx) => {
        const x = idx * step + step / 2;
        const isUp = c.close >= c.open;
        ctx.fillStyle = isUp ? '#ef4444' : '#22c55e';

        const barHeight = (c.volume / maxVol) * volHeight;
        const y = volBottom - barHeight;
        ctx.fillRect(x - candleWidth / 2, y, candleWidth, barHeight);
      });

      ctx.fillStyle = '#64748b';
      ctx.font = '9px monospace';
      ctx.fillText(`${(maxVol / 1000).toFixed(0)}K張`, chartRight + 6, volTop + 10);
    }

    // -------------------------------------------------------------
    // ZONE 3: KD STOCHASTIC OSCILLATOR (9, 3, 3)
    // -------------------------------------------------------------
    ctx.beginPath();
    ctx.moveTo(0, kdTop);
    ctx.lineTo(chartRight, kdTop);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('KD (9, 3, 3)', 8, kdTop - 3);

    const getKDY = (val: number) => kdBottom - (val / 100) * kdHeight;

    // 80 & 20 dashed reference lines
    ctx.strokeStyle = '#334155';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, getKDY(80));
    ctx.lineTo(chartRight, getKDY(80));
    ctx.moveTo(0, getKDY(20));
    ctx.lineTo(chartRight, getKDY(20));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.font = '9px monospace';
    ctx.fillText('80 超買', chartRight + 6, getKDY(80) + 3);
    ctx.fillText('20 超賣', chartRight + 6, getKDY(20) + 3);

    // K line (Red, 1.2px)
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let kStarted = false;
    visibleData.forEach((c, idx) => {
      if (c.k !== undefined) {
        const x = idx * step + step / 2;
        const y = getKDY(c.k);
        if (!kStarted) {
          ctx.moveTo(x, y);
          kStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // D line (Blue, 1.2px)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let dStarted = false;
    visibleData.forEach((c, idx) => {
      if (c.d !== undefined) {
        const x = idx * step + step / 2;
        const y = getKDY(c.d);
        if (!dStarted) {
          ctx.moveTo(x, y);
          dStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // -------------------------------------------------------------
    // ZONE 4: MACD (12, 26, 9)
    // -------------------------------------------------------------
    ctx.beginPath();
    ctx.moveTo(0, macdTop);
    ctx.lineTo(chartRight, macdTop);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('MACD (12, 26, 9)', 8, macdTop - 3);

    let minM = 0;
    let maxM = 0;
    visibleData.forEach(c => {
      if (c.dif !== undefined) {
        minM = Math.min(minM, c.dif);
        maxM = Math.max(maxM, c.dif);
      }
      if (c.macd !== undefined) {
        minM = Math.min(minM, c.macd);
        maxM = Math.max(maxM, c.macd);
      }
      if (c.osc !== undefined) {
        minM = Math.min(minM, c.osc);
        maxM = Math.max(maxM, c.osc);
      }
    });

    const mRange = Math.max(Math.abs(minM), Math.abs(maxM)) * 1.2 || 1;
    const getMY = (val: number) => macdTop + macdHeight / 2 - (val / mRange) * (macdHeight / 2);

    // Zero axis
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, getMY(0));
    ctx.lineTo(chartRight, getMY(0));
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '9px monospace';
    ctx.fillText('0', chartRight + 6, getMY(0) + 3);

    // OSC Histogram
    visibleData.forEach((c, idx) => {
      if (c.osc !== undefined) {
        const x = idx * step + step / 2;
        const y0 = getMY(0);
        const y1 = getMY(c.osc);
        ctx.fillStyle = c.osc >= 0 ? '#ef4444' : '#22c55e';
        ctx.fillRect(x - candleWidth / 2, Math.min(y0, y1), candleWidth, Math.max(1, Math.abs(y1 - y0)));
      }
    });

    // DIF Line (Orange/Red)
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let difStarted = false;
    visibleData.forEach((c, idx) => {
      if (c.dif !== undefined) {
        const x = idx * step + step / 2;
        const y = getMY(c.dif);
        if (!difStarted) {
          ctx.moveTo(x, y);
          difStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // MACD Line (Blue)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let macdStarted = false;
    visibleData.forEach((c, idx) => {
      if (c.macd !== undefined) {
        const x = idx * step + step / 2;
        const y = getMY(c.macd);
        if (!macdStarted) {
          ctx.moveTo(x, y);
          macdStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    });
    ctx.stroke();

    // -------------------------------------------------------------
    // UNIFIED CROSSHAIR ACROSS ALL 4 ZONES
    // -------------------------------------------------------------
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count) {
      const activeX = hoverIndex * step + step / 2;
      const c = visibleData[hoverIndex];
      const activeY = getY(c.close);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);

      // Vertical line across ALL zones (top to bottom)
      ctx.beginPath();
      ctx.moveTo(activeX, 0);
      ctx.lineTo(activeX, height);
      ctx.stroke();

      // Horizontal line in price zone
      ctx.beginPath();
      ctx.moveTo(0, activeY);
      ctx.lineTo(chartRight, activeY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price Tag on Right Axis
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(chartRight + 2, activeY - 8, 58, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(c.close.toFixed(1), chartRight + 6, activeY + 4);

      // Date Tag on Bottom Axis
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(Math.max(0, activeX - 35), height - 16, 70, 16);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(c.time.slice(5), Math.max(4, activeX - 16), height - 4);
    }

    // -------------------------------------------------------------
    // MOBILE CROSSHAIR LOCK INDICATOR & 2-SECOND LONG-PRESS RING
    // -------------------------------------------------------------
    if (isCrosshairLocked) {
      const badgeText = '🔒 十字線已鎖定 · 長按2秒退出';
      ctx.font = 'bold 10px sans-serif';
      const textW = ctx.measureText(badgeText).width;
      const boxW = textW + 16;
      const boxX = Math.max(8, chartRight - boxW - 8);
      const boxY = 6;
      ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, 20, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fcd34d';
      ctx.fillText(badgeText, boxX + 8, boxY + 13.5);
    }

    if (longPressRing) {
      const rx = Math.max(28, Math.min(chartRight - 28, longPressRing.x));
      const ry = Math.max(28, Math.min(height - 28, longPressRing.y));
      const radius = 20;

      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.beginPath();
      ctx.arc(rx, ry, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(rx, ry, radius - 3, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = longPressRing.exiting ? '#fb7185' : '#f59e0b';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(rx, ry, radius - 3, -Math.PI / 2, -Math.PI / 2 + longPressRing.progress * Math.PI * 2);
      ctx.stroke();

      const hintText = longPressRing.exiting ? '長按2秒退出十字線' : '長按2秒開啟十字線';
      ctx.font = 'bold 10px sans-serif';
      const hintW = ctx.measureText(hintText).width + 12;
      const hintX = Math.max(4, Math.min(chartRight - hintW - 4, rx - hintW / 2));
      const hintY = ry - radius - 22 > 4 ? ry - radius - 22 : ry + radius + 6;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.beginPath();
      ctx.roundRect(hintX, hintY, hintW, 18, 4);
      ctx.fill();
      ctx.fillStyle = longPressRing.exiting ? '#fda4af' : '#fde68a';
      ctx.fillText(hintText, hintX + 6, hintY + 12.5);
      ctx.restore();
    }
  }, [visibleData, showMAs, showBollinger, showTradeMarkers, trades, strategySignal, hoverIndex, isCrosshairLocked, longPressRing, dimensions, symbol]);

  const visibleDataLengthRef = useRef<number>(visibleData.length);
  useEffect(() => {
    visibleDataLengthRef.current = visibleData.length;
  }, [visibleData.length]);

  const longPressRef = useRef<{
    timerId: ReturnType<typeof setTimeout> | null;
    rafId: number | null;
    startX: number;
    startY: number;
    localX: number;
    localY: number;
    startTime: number;
    pointerId: number | null;
    triggered: boolean;
    moved: boolean;
  }>({
    timerId: null,
    rafId: null,
    startX: 0,
    startY: 0,
    localX: 0,
    localY: 0,
    startTime: 0,
    pointerId: null,
    triggered: false,
    moved: false,
  });

  const cancelLongPress = () => {
    if (longPressRef.current.timerId) {
      clearTimeout(longPressRef.current.timerId);
      longPressRef.current.timerId = null;
    }
    if (longPressRef.current.rafId !== null) {
      cancelAnimationFrame(longPressRef.current.rafId);
      longPressRef.current.rafId = null;
    }
    longPressRef.current.pointerId = null;
    setLongPressRing(null);
  };

  useEffect(() => {
    return () => cancelLongPress();
  }, []);

  const updateHoverFromClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    const count = visibleDataLengthRef.current;
    if (!canvas || count <= 0) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const chartRight = rect.width - 64;
    if (x >= 0 && x <= chartRight) {
      const step = chartRight / count;
      const idx = Math.floor(x / step);
      setHoverIndex(Math.min(count - 1, Math.max(0, idx)));
      return true;
    }
    return false;
  };

  // Pointer interactions: Desktop hover/pan vs Mobile 2s long-press crosshair lock mode
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      // Multi-touch detected (e.g. second finger for pinch): abort long press
      if (longPressRef.current.pointerId !== null && longPressRef.current.pointerId !== e.pointerId) {
        cancelLongPress();
        isDragging.current = false;
        return;
      }

      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const localX = rect ? e.clientX - rect.left : 0;
      const localY = rect ? e.clientY - rect.top : 0;

      cancelLongPress();
      longPressRef.current.startX = e.clientX;
      longPressRef.current.startY = e.clientY;
      longPressRef.current.localX = localX;
      longPressRef.current.localY = localY;
      longPressRef.current.startTime = performance.now();
      longPressRef.current.pointerId = e.pointerId;
      longPressRef.current.triggered = false;
      longPressRef.current.moved = false;

      const startClientX = e.clientX;
      const wasLocked = isCrosshairLockedRef.current;

      const updateRing = () => {
        if (longPressRef.current.pointerId !== e.pointerId) return;
        const elapsed = performance.now() - longPressRef.current.startTime;
        if (elapsed >= 250 && elapsed < 2000) {
          setLongPressRing({
            x: longPressRef.current.localX,
            y: longPressRef.current.localY,
            progress: Math.min(1, (elapsed - 250) / 1750),
            exiting: wasLocked,
          });
        }
        if (elapsed < 2000) {
          longPressRef.current.rafId = requestAnimationFrame(updateRing);
        }
      };
      longPressRef.current.rafId = requestAnimationFrame(updateRing);

      longPressRef.current.timerId = setTimeout(() => {
        longPressRef.current.triggered = true;
        longPressRef.current.timerId = null;
        if (longPressRef.current.rafId !== null) {
          cancelAnimationFrame(longPressRef.current.rafId);
          longPressRef.current.rafId = null;
        }
        setLongPressRing(null);
        isDragging.current = false;
        touchState.current.isPinching = false;

        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          try { navigator.vibrate(35); } catch (_) {}
        }

        if (isCrosshairLockedRef.current) {
          // 再次長按2秒 -> 退出十字線模式，解除K線固定鎖定
          isCrosshairLockedRef.current = false;
          setIsCrosshairLocked(false);
          setHoverIndex(null);
        } else {
          // 長按2秒 -> 進入十字線模式並固定K線圖不會橫移或放大
          isCrosshairLockedRef.current = true;
          setIsCrosshairLocked(true);
          updateHoverFromClientX(startClientX);
        }
      }, 2000);

      // 十字線模式啟用時固定 K 線不橫移；未開啟十字線時可單指拖曳時間軸
      if (isCrosshairLockedRef.current) {
        isDragging.current = false;
      } else {
        isDragging.current = true;
        startX.current = e.clientX;
        startOffset.current = offsetRight;
      }
      return;
    }

    // Desktop mouse interaction
    if (!isCrosshairLockedRef.current) {
      isDragging.current = true;
      startX.current = e.clientX;
      startOffset.current = offsetRight;
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch (_) {}
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const chartRight = rect.width - 64;

    if (e.pointerType === 'touch') {
      if (longPressRef.current.pointerId === e.pointerId) {
        const dist = Math.hypot(e.clientX - longPressRef.current.startX, e.clientY - longPressRef.current.startY);
        if (dist > 12) {
          longPressRef.current.moved = true;
          cancelLongPress();
          startX.current = e.clientX;
          startOffset.current = offsetRight;
        } else {
          // 手指微幅抖動（12px 內）保留給長按 2 秒判定，不產生圖表位移
          return;
        }
      }

      if (isCrosshairLockedRef.current) {
        // 十字線鎖定模式：固定K線不橫移，手指移動僅精準移動十字準星
        isDragging.current = false;
        if (!longPressRef.current.triggered) {
          updateHoverFromClientX(e.clientX);
        }
      } else if (isDragging.current && !touchState.current.isPinching) {
        // 非十字線模式：不顯示十字線，單指左右滑動可平移K線
        const deltaX = e.clientX - startX.current;
        const step = chartRight / visibleCount;
        const deltaBars = Math.round(deltaX / step);
        const newOffset = Math.max(0, Math.min(candles.length - visibleCount, startOffset.current + deltaBars));
        setOffsetRight(newOffset);
      }
      return;
    }

    // Desktop mouse hover/drag
    if (x >= 0 && x <= chartRight && visibleData.length > 0) {
      const step = chartRight / visibleData.length;
      const idx = Math.floor(x / step);
      setHoverIndex(Math.min(visibleData.length - 1, Math.max(0, idx)));
    } else if (!isCrosshairLockedRef.current) {
      setHoverIndex(null);
    }

    if (isDragging.current && !isCrosshairLockedRef.current) {
      const deltaX = e.clientX - startX.current;
      const step = chartRight / visibleCount;
      const deltaBars = Math.round(deltaX / step);
      const newOffset = Math.max(0, Math.min(candles.length - visibleCount, startOffset.current + deltaBars));
      setOffsetRight(newOffset);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      if (
        isCrosshairLockedRef.current &&
        !longPressRef.current.triggered &&
        !longPressRef.current.moved &&
        longPressRef.current.pointerId === e.pointerId
      ) {
        updateHoverFromClientX(e.clientX);
      }
      cancelLongPress();
      isDragging.current = false;
      return;
    }

    isDragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  const handlePointerCancel = () => {
    cancelLongPress();
    isDragging.current = false;
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      isDragging.current = false;
      return;
    }
    if (!isCrosshairLockedRef.current) {
      setHoverIndex(null);
    }
  };

  // Touch tracking for pinch-to-zoom on mobile devices
  const touchState = useRef<{
    initialDistance: number;
    initialVisibleCount: number;
    isPinching: boolean;
  }>({
    initialDistance: 0,
    initialVisibleCount: 75,
    isPinching: false,
  });

  // Native touch event listeners on canvas to support fluid two-finger pinch zoom (disabled when crosshair is locked)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getTouchDistance = (t1: Touch, t2: Touch) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        cancelLongPress();
        isDragging.current = false;
      }
      if (e.touches.length === 2) {
        e.preventDefault();
        if (isCrosshairLockedRef.current) {
          touchState.current.isPinching = false;
          return;
        }
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        touchState.current = {
          initialDistance: dist,
          initialVisibleCount: visibleCount,
          isPinching: true,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        if (isCrosshairLockedRef.current || !touchState.current.isPinching) {
          return;
        }
        const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
        if (touchState.current.initialDistance > 0 && currentDist > 0) {
          const ratio = currentDist / touchState.current.initialDistance;
          const targetVisible = Math.round(touchState.current.initialVisibleCount / ratio);
          const boundedVisible = Math.max(15, Math.min(candles.length || 75, targetVisible));
          setVisibleCount(boundedVisible);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        touchState.current.isPinching = false;
      }
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [visibleCount, candles.length]);

  // Native non-passive Wheel listener to reliably preventDefault (disabled when crosshair is locked)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (isCrosshairLockedRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const chartRight = rect.width - 64;
      const mouseRatio = Math.max(0, Math.min(1, mouseX / Math.max(1, chartRight)));

      const zoomIn = e.deltaY < 0;

      setVisibleCount(prevVisible => {
        const step = Math.max(2, Math.round(prevVisible * 0.12));
        const delta = zoomIn ? -step : step;
        const newVisible = Math.max(15, Math.min(candles.length, prevVisible + delta));

        // Center zoom around the mouse cursor position for a professional feel
        if (newVisible !== prevVisible && candles.length > 0) {
          const countDiff = newVisible - prevVisible;
          const shiftRight = Math.round((1 - mouseRatio) * -countDiff);
          setOffsetRight(prevOffset => Math.max(0, Math.min(candles.length - newVisible, prevOffset + shiftRight)));
        }

        return newVisible;
      });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [candles.length]);

  return (
    <div
      ref={containerRef}
      className={`bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col ${
        isFullscreen ? 'fixed inset-0 z-50 rounded-none' : 'w-full'
      }`}
    >
      {/* Top Header: Stock Details, Live Price & Technical Toggles */}
      <div className="px-3 py-2 bg-slate-950/90 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-slate-100 text-sm sm:text-base">{stockName}</span>
          <span className="text-xs text-slate-400 font-mono bg-slate-800/80 px-2 py-0.5 rounded">
            {symbol}
          </span>
          {onToggleWatchlist && (
            <button
              onClick={onToggleWatchlist}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold transition-all cursor-pointer active:scale-95 ${
                isInWatchlist
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30 shadow-xs'
                  : 'bg-slate-800 text-slate-300 border border-slate-700 hover:border-amber-400/60 hover:text-amber-300 hover:bg-slate-750'
              }`}
              title={isInWatchlist ? '已在自選池 (點擊移除)' : '點按星號加入股票自選池'}
            >
              <Star
                size={14}
                className={isInWatchlist ? 'fill-amber-400 text-amber-400' : 'text-slate-400 hover:text-amber-400'}
              />
              <span className="text-[11px]">{isInWatchlist ? '已自選' : '加自選'}</span>
            </button>
          )}
          {liveQuote && (
            <div className="flex items-baseline gap-1.5 font-mono">
              <span className={`text-sm sm:text-base font-extrabold ${liveQuote.change >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                ${liveQuote.price.toFixed(2)}
              </span>
              <span className={`text-xs font-semibold ${liveQuote.change >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {liveQuote.change >= 0 ? '+' : ''}{liveQuote.change.toFixed(2)} ({liveQuote.change >= 0 ? '+' : ''}{liveQuote.changePercent.toFixed(2)}%)
              </span>
            </div>
          )}
          {onToggleAutoRefresh && (
            <button
              onClick={onToggleAutoRefresh}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
              title={isAutoRefresh ? '每15秒自動連線yfinance更新盤中價，點擊暫停' : '點擊啟用自動更新'}
            >
              <RefreshCw size={10} className={isRefreshingQuote ? 'animate-spin text-emerald-400' : ''} />
              <span>{isAutoRefresh ? `${autoRefreshCountdown}s` : '暫停'}</span>
            </button>
          )}
        </div>

        {/* Right Tools: Trade Markers Toggle, Bollinger & MA Toggles, Fullscreen */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {/* Strategy Trade Markers Toggle */}
          {trades.length > 0 && (
            <button
              onClick={() => setShowTradeMarkers(!showTradeMarkers)}
              className={`px-2 py-1 rounded text-[11px] sm:text-xs font-semibold flex items-center gap-1 border transition-all ${
                showTradeMarkers
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-xs'
                  : 'bg-slate-950 border-slate-800 text-slate-500 hover:text-slate-300'
              }`}
              title="在K線主圖上標記自訂回測策略的進場、出場、停損點位"
            >
              <Crosshair size={13} className={showTradeMarkers ? 'text-amber-400' : 'text-slate-500'} />
              <span>回測信號 ({trades.length})</span>
            </button>
          )}

          {/* Bollinger Bands Toggle */}
          <button
            onClick={() => setShowBollinger(!showBollinger)}
            className={`px-2 py-0.5 rounded border text-[11px] font-medium transition-colors ${
              showBollinger ? 'border-purple-500/50 text-purple-300 bg-purple-500/10' : 'border-slate-800 text-slate-500'
            }`}
            title="布林通道 (MA20 ± 2倍標準差)"
          >
            布林(20,2)
          </button>

          {/* MA Line Toggles */}
          <div className="flex items-center gap-1 text-[11px]">
            <button
              onClick={() => setShowMAs(p => ({ ...p, ma5: !p.ma5 }))}
              className={`px-2 py-0.5 rounded border transition-colors ${
                showMAs.ma5 ? 'border-yellow-500/40 text-yellow-400 bg-yellow-500/10 font-bold' : 'border-slate-800 text-slate-500'
              }`}
            >
              MA5
            </button>
            <button
              onClick={() => setShowMAs(p => ({ ...p, ma20: !p.ma20 }))}
              className={`px-2 py-0.5 rounded border transition-colors ${
                showMAs.ma20 ? 'border-blue-500/40 text-blue-400 bg-blue-500/10 font-bold' : 'border-slate-800 text-slate-500'
              }`}
            >
              MA20
            </button>
            <button
              onClick={() => setShowMAs(p => ({ ...p, ma60: !p.ma60 }))}
              className={`px-2 py-0.5 rounded border transition-colors ${
                showMAs.ma60 ? 'border-purple-500/40 text-purple-400 bg-purple-500/10 font-bold' : 'border-slate-800 text-slate-500'
              }`}
            >
              MA60
            </button>
          </div>

          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors ml-0.5"
            title={isFullscreen ? '退出全螢幕' : '全螢幕圖表'}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      {/* Persistent Strategy Signal Status Banner */}
      {strategySignal && strategySignal.status === 'BUY' && (
        <div className="px-3 py-1.5 bg-gradient-to-r from-rose-950 via-red-950/90 to-slate-900 border-b border-rose-500/50 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1 font-bold bg-rose-600 text-white px-2 py-0.5 rounded shadow-sm text-xs animate-pulse">
              🔥 策略買進訊號 (BUY)
            </span>
            <span className="text-rose-200 font-semibold">{strategySignal.statusDesc || '符合量化進場條件'}</span>
            {strategySignal.entryPrice && (
              <span className="font-mono text-rose-300 font-bold bg-rose-900/60 px-1.5 py-0.5 rounded border border-rose-700/50">
                觸發買價: ${strategySignal.entryPrice}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-300 font-mono">
            <span>勝率 <strong className="text-emerald-400">{strategySignal.winRate}%</strong></span>
            <span>·</span>
            <span>期望值 <strong className={strategySignal.expectancyPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}>{strategySignal.expectancyPct > 0 ? `+${strategySignal.expectancyPct}%` : `${strategySignal.expectancyPct}%`}</strong></span>
            <span>·</span>
            <span>回撤 <strong className="text-amber-400">{strategySignal.maxDrawdownPct}%</strong></span>
          </div>
        </div>
      )}
      {strategySignal && strategySignal.status === 'HOLD' && (
        <div className="px-3 py-1 bg-amber-950/60 border-b border-amber-600/30 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <span className="font-bold bg-amber-600/80 text-white px-1.5 py-0.2 rounded text-[11px]">
              🔒 策略續抱中 (HOLD)
            </span>
            <span className="text-slate-300 text-[11px]">{strategySignal.statusDesc}</span>
            {strategySignal.entryPrice && (
              <span className="font-mono text-amber-300 text-[11px]">進場價: ${strategySignal.entryPrice}</span>
            )}
          </div>
        </div>
      )}

      {/* Crosshair / Active Bar Minimal Clean Info Banner */}
      {activeHoverCandle && (
        <div className="px-3 py-1.5 bg-slate-950/95 border-b border-slate-800/60 text-xs font-mono flex flex-wrap items-center justify-between gap-2 text-slate-300">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <span className="text-slate-400 font-semibold">{activeHoverCandle.time}</span>
            <div className="flex items-center gap-2 flex-wrap">
              <span>開: <strong className="text-slate-100">{activeHoverCandle.open}</strong></span>
              <span>高: <strong className="text-red-400">{activeHoverCandle.high}</strong></span>
              <span>低: <strong className="text-emerald-400">{activeHoverCandle.low}</strong></span>
              <span>收: <strong className={activeHoverCandle.close >= activeHoverCandle.open ? 'text-red-400' : 'text-emerald-400'}>{activeHoverCandle.close}</strong></span>
              <span>量: <strong className="text-slate-100">{Math.round(activeHoverCandle.volume / 1000)}張</strong></span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowIndicatorsDetail(prev => !prev)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showIndicatorsDetail
                  ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {showIndicatorsDetail ? '簡化數據' : '展開指標數值'}
            </button>
          </div>

          {/* Optional Detailed Indicators (cleanly toggled, keeps chart clean by default) */}
          {showIndicatorsDetail && (
            <div className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 border-t border-slate-800/50 text-[11px] text-slate-400">
              {activeHoverCandle.bbUpper !== undefined && (
                <div className="flex items-center gap-1.5 text-purple-400">
                  <span>布林上: {activeHoverCandle.bbUpper}</span>
                  <span>下: {activeHoverCandle.bbLower}</span>
                  {activeHoverCandle.bbWidth !== undefined && (
                    <span className="text-[10px] text-purple-300 bg-purple-950/70 px-1 rounded border border-purple-800/40">
                      帶寬: {activeHoverCandle.bbWidth}%
                    </span>
                  )}
                </div>
              )}

              {activeHoverCandle.k !== undefined && activeHoverCandle.d !== undefined && (
                <div className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
                  <span className="text-red-400">K: {activeHoverCandle.k}</span>
                  <span className="text-sky-400">D: {activeHoverCandle.d}</span>
                  {activeHoverCandle.k > activeHoverCandle.d ? (
                    <span className="text-[10px] text-red-400 bg-red-950/70 px-1 rounded border border-red-800/40">多方金叉</span>
                  ) : (
                    <span className="text-[10px] text-emerald-400 bg-emerald-950/70 px-1 rounded border border-emerald-800/40">空方死叉</span>
                  )}
                </div>
              )}

              {activeHoverCandle.dif !== undefined && (
                <div className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
                  <span className="text-orange-400">DIF: {activeHoverCandle.dif}</span>
                  <span className="text-sky-400">MACD: {activeHoverCandle.macd}</span>
                  <span className={activeHoverCandle.osc && activeHoverCandle.osc >= 0 ? 'text-red-400' : 'text-emerald-400'}>
                    OSC: {activeHoverCandle.osc}
                  </span>
                </div>
              )}

              {activeHoverCandle.rsi !== undefined && (
                <div className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
                  <span className={activeHoverCandle.rsi >= 70 ? 'text-red-400 font-bold' : activeHoverCandle.rsi <= 30 ? 'text-emerald-400 font-bold' : 'text-slate-300'}>
                    RSI: {activeHoverCandle.rsi}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Unified Canvas Area */}
      <div className={`relative w-full ${isFullscreen ? 'flex-1 h-full' : 'h-[520px] sm:h-[580px]'}`}>
        {isLoading && (
          <div className="absolute inset-0 z-20 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-blue-400 font-medium">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              <span>載入近 2 年日 K 線數據中...</span>
            </div>
          </div>
        )}

        {candles.length === 0 && !isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center p-6 bg-slate-950/85 backdrop-blur-xs">
            <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-amber-400 mb-3 shadow-md">
              <AlertTriangle size={24} />
            </div>
            <h3 className="text-slate-100 text-base font-bold mb-1">未能獲得走勢</h3>
            <p className="text-xs text-slate-400 max-w-sm leading-relaxed mb-3">
              查無 {stockName} ({symbol}) 在市場上的歷史 K 線行情數據，可能此代號無交易走勢記錄或非有效台股上市櫃標的。
            </p>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400 font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                市場代號: {symbol}
              </span>
            </div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair touch-none overscroll-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Legend Overlay for Quick Reading */}
        <div className="absolute top-2 left-20 pointer-events-none flex items-center gap-2 text-[10px] font-mono opacity-85 flex-wrap">
          {showMAs.ma5 && <span className="text-yellow-400">■ MA5</span>}
          {showMAs.ma20 && <span className="text-blue-400">■ MA20</span>}
          {showMAs.ma60 && <span className="text-purple-400">■ MA60</span>}
          {showTradeMarkers && trades.length > 0 && (
            <>
              <span className="text-slate-500">|</span>
              <span className="text-red-400 font-bold">▲ 買進</span>
              <span className="text-emerald-400 font-bold">▼ 停利</span>
              <span className="text-rose-400 font-bold">▼ 停損</span>
            </>
          )}
          <span className="text-slate-500">|</span>
          <span className="text-red-400">■ K(9)</span>
          <span className="text-sky-400">■ D(9)</span>
          <span className="text-slate-500">|</span>
          <span className="text-orange-400">■ DIF</span>
          <span className="text-sky-400">■ MACD</span>
          <span className="text-red-400">■ OSC紅多</span>
          <span className="text-emerald-400">綠空</span>
        </div>
      </div>

      {/* 三大法人每日買賣超區塊 (外資 / 投信 / 自營商) */}
      <InstitutionalTradesPanel
        symbol={symbol}
        stockName={stockName}
        activeDate={activeHoverCandle?.time}
      />

      {/* Bottom status bar for zoom & pan guidance */}
      <div className="px-3 py-1.5 bg-slate-950/90 border-t border-slate-800/80 text-[11px] text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span>滾輪/雙指縮放</span>
          <span>·</span>
          <span>手機長按2秒開關十字線（鎖定圖表）</span>
          <span>·</span>
          <span>十字準星同步掃描 K線、回測信號、成交量、KD、MACD</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setVisibleCount(75);
              setOffsetRight(0);
            }}
            className="text-blue-400 hover:text-blue-300 font-medium text-[11px]"
          >
            重置視角
          </button>
        </div>
      </div>
    </div>
  );
};
