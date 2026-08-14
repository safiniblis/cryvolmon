import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";
import { getPairPrecision, checkPairRotation, type GridConfig, type PairPrecision } from "./strategy-engine";
import { logTandemRebalanceDecision, logTandemRebalanceTrade, type TandemRebalanceContext } from "./tandem-decision-log";
import { managedParam } from "./managed-params";

function roundQty(qty: number, precision: number): string {
  return qty.toFixed(precision);
}

function roundPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

async function placeLimitClose(
  client: any,
  params: { symbol: string; qty: string; side: "BUY" | "SELL"; positionId?: string; price: number; quotePrecision: number },
): Promise<{ result: any; filled: boolean }> {
  const result = await client.placeOrder({
    symbol: params.symbol,
    qty: params.qty,
    side: params.side,
    tradeSide: "CLOSE",
    orderType: "LIMIT",
    price: roundPrice(params.price, params.quotePrecision),
    effect: "IOC",
    ...(params.positionId ? { positionId: params.positionId } : {}),
  });
  if (result?.code !== 0 || !result?.data?.orderId) return { result, filled: false };

  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const history = await client.getOrderHistory(params.symbol);
    const orders = Array.isArray(history?.data?.orderList) ? history.data.orderList : [];
    const order = orders.find((item: any) => String(item.orderId) === String(result.data.orderId));
    const status = String(order?.status || "").toUpperCase();
    return { result, filled: status === "FILLED" || status === "COMPLETE" || status === "DONE" || status === "2" || status === "3" };
  } catch {
    return { result, filled: false };
  }
}

async function getTickerPrice(symbol: string): Promise<{ symbol: string; lastPrice: number; high24h: number; low24h: number; volume24h: number; change24h: number } | null> {
  const wsPrice = priceFeed.getLastPrice(symbol);
  if (wsPrice && wsPrice > 0) {
    return {
      symbol,
      lastPrice: wsPrice,
      high24h: 0,
      low24h: 0,
      volume24h: 0,
      change24h: 0,
    };
  }

  const client = getBitunixClient();
  if (!client) return null;

  try {
    const result = await client.getTickers(symbol);
    if (result?.data && result.data.length > 0) {
      const t = result.data[0];
      return {
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice || t.last || "0"),
        high24h: parseFloat(t.high24h || t.high || "0"),
        low24h: parseFloat(t.low24h || t.low || "0"),
        volume24h: parseFloat(t.volume24h || t.volume || "0"),
        change24h: parseFloat(t.change24h || t.priceChangePercent || "0"),
      };
    }
  } catch (e) {
    console.error(`Failed to get ticker for ${symbol}:`, e);
  }
  return null;
}

export interface TandemConfig {
  leverage: number;
  totalCapital: number;
  feeMultiplier: number;
  phase: "entry" | "waiting_liquidation" | "cascade" | "trailing" | "complete";
  entryPrice: number;
  longGridId: number | null;
  shortGridId: number | null;
  longPositionId: string | null;
  shortPositionId: string | null;
  longEntryQty: number;
  shortEntryQty: number;
  liquidatedSide: "LONG" | "SHORT" | null;
  liquidationPrice: number;
  cascadeStep: number;
  tpOrderIds: string[];
  highWatermark: number;
  remainingQty: number;
  survivingSide: "LONG" | "SHORT" | null;
  survivingPositionId: string | null;
  cycleCount: number;
  totalPnl: number;
  lastActionAt: number;
  rotationEnabled?: boolean;
  capitalPerSide?: number;
  initialCapital?: number;
  exchangeRealizedPnl?: number;
  capitalTrackingStartedAt?: number;
  lastExchangeCapitalRefreshAt?: number;
  longWeight?: number;
  shortWeight?: number;
  lastRebalanceAt?: number;
  rebalanceCount?: number;
  consecutiveRebalances?: number;
  lastRebalancePriceRef?: number;
}

const tandemEntryLocks: Set<number> = new Set();

function isSymbolPosition(position: any, symbol: string): boolean {
  return String(position?.symbol || "").toUpperCase() === symbol.toUpperCase();
}

function exchangeRealizedValue(row: any): number | null {
  const raw = row?.realizedPNL;
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function readExchangeRealizedPnl(client: any, symbol: string): Promise<number | null> {
  try {
    const positionsRes = await client.getPositions(symbol);
        const positions = (Array.isArray(positionsRes?.data) ? positionsRes.data : [])
      .filter((position: any) => String(position.symbol || "").toUpperCase() === symbol.toUpperCase());
    const positionValues = positions.map(exchangeRealizedValue).filter((value: number | null): value is number => value !== null);
    if (positionValues.length > 0) return positionValues.reduce((sum: number, value: number) => sum + value, 0);
  } catch {}

  return null;
}

async function refreshExchangeCapital(strategy: Strategy, config: TandemConfig, client: any): Promise<void> {
  const initialCapital = Number(config.initialCapital || config.totalCapital || 0);
  if (initialCapital <= 0) return;
  if (!config.capitalTrackingStartedAt) {
    config.capitalTrackingStartedAt = Date.now();
    await storage.updateStrategy(strategy.id, { config });
  }
  if (Date.now() - Number(config.lastExchangeCapitalRefreshAt || 0) < 180_000) return;
  const realizedPnl = await readExchangeRealizedPnl(client, strategy.symbol);
  if (realizedPnl === null) return;
  config.lastExchangeCapitalRefreshAt = Date.now();
  const nextTotalCapital = Math.max(0, initialCapital + realizedPnl);
  if (Math.abs((config.exchangeRealizedPnl || 0) - realizedPnl) < 0.0001 && Math.abs((config.totalCapital || 0) - nextTotalCapital) < 0.0001) return;
  config.initialCapital = initialCapital;
  config.exchangeRealizedPnl = realizedPnl;
  config.totalCapital = nextTotalCapital;
  await storage.updateStrategy(strategy.id, { config });
  console.log(`[Tandem ${strategy.id}] Exchange capital refresh: initial=${initialCapital.toFixed(4)} realizedPnl=${realizedPnl.toFixed(4)} totalCapital=${nextTotalCapital.toFixed(4)}`);
}

function defaultGridConfigForSide(side: "LONG" | "SHORT", currentPrice: number, leverage: number, budget: number, feeMultiplier: number = 3.5, twinMode: boolean = false, twinGapPct: number = 0.006, reservePct: number = 0.1): GridConfig & { initialBuyDone?: boolean; gridSide: "LONG" | "SHORT" } {
  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const effectiveFm = twinMode ? (twinGapPct / 2) / roundTripFee : feeMultiplier;
  const gridRatio = 1 + roundTripFee * effectiveFm;

  const liqDist = 1 / leverage;
  const gridRange = liqDist * 0.85;
  const tpRange = liqDist * 0.5;

  const tandemReservePct = reservePct;

  if (side === "LONG") {
    return {
      startPrice: currentPrice,
      lowerPrice: currentPrice * (1 - gridRange),
      upperPrice: currentPrice * (1 + tpRange),
      liquidationPrice: currentPrice * (1 - liqDist),
      leverage,
      gridRatio,
      gridCount: 20,
      amountPerGrid: 2,
      geometric: true,
      gapGrowthBelow: 1.0,
      gapShrinkAbove: 1.0,
      gridsAbove: 10,
      gridsBelow: 10,
      extensionsBelow: 0,
      extensionsAbove: 0,
      allocatedBudget: budget,
      tpReservePct: tandemReservePct,
      gridSide: "LONG",
      ...(twinMode ? { twinMode: true, twinGapPct, feeMultiplier: effectiveFm } : {}),
    };
  } else {
    return {
      startPrice: currentPrice,
      lowerPrice: currentPrice * (1 - tpRange),
      upperPrice: currentPrice * (1 + gridRange),
      liquidationPrice: currentPrice * (1 + liqDist),
      leverage,
      gridRatio,
      gridCount: 20,
      amountPerGrid: 2,
      geometric: true,
      gapGrowthBelow: 1.0,
      gapShrinkAbove: 1.0,
      gridsAbove: 10,
      gridsBelow: 10,
      extensionsBelow: 0,
      extensionsAbove: 0,
      allocatedBudget: budget,
      tpReservePct: tandemReservePct,
      gridSide: "SHORT",
      ...(twinMode ? { twinMode: true, twinGapPct, feeMultiplier: effectiveFm } : {}),
    };
  }
}

export async function executeTandemStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as TandemConfig;
  await refreshExchangeCapital(strategy, config, client);
  const phase = config.phase || "entry";

  console.log(`[Tandem ${strategy.id}] Phase: ${phase} | Cycle: ${config.cycleCount || 0} | Symbol: ${strategy.symbol}`);

  switch (phase) {
    case "entry":
      await tandemEntry(strategy, config, client);
      break;
    case "waiting_liquidation":
      await tandemWaitLiquidation(strategy, config, client);
      break;
    case "cascade":
      await tandemCascade(strategy, config, client);
      break;
    case "trailing":
      await tandemTrailing(strategy, config, client);
      break;
    case "complete":
      await tandemComplete(strategy, config, client);
      break;
  }
}

async function tandemEntry(strategy: Strategy, config: TandemConfig, client: any) {
  if (tandemEntryLocks.has(strategy.id)) {
    console.log(`[Tandem ${strategy.id}] Entry already in progress, skipping...`);
    return;
  }
  tandemEntryLocks.add(strategy.id);

  try {
    const ticker = await getTickerPrice(strategy.symbol);
    if (!ticker) throw new Error(`Cannot get price for ${strategy.symbol}`);

    const currentPrice = ticker.lastPrice;
    const leverage = config.leverage || 33;
    const totalCapital = config.totalCapital || (config.capitalPerSide ? config.capitalPerSide * 2 : 100);
    const longWeight = managedParam(config, "longWeight", config.longWeight || 1);
    const shortWeight = managedParam(config, "shortWeight", config.shortWeight || 1);
    const totalWeight = longWeight + shortWeight;
    const longCapital = totalCapital * (longWeight / totalWeight);
    const shortCapital = totalCapital * (shortWeight / totalWeight);

    const accountRes = await client.getAccount();
    if (accountRes?.code !== 0 || !accountRes?.data) throw new Error("Cannot fetch account balance");
    const accountAvailable = parseFloat(accountRes.data.available || "0");
    if (accountAvailable < totalCapital) {
      throw new Error(`Insufficient balance: ${accountAvailable.toFixed(2)} USDT, need ${totalCapital.toFixed(2)} total`);
    }

    try { await client.setMarginMode(strategy.symbol, "ISOLATION"); } catch (e: any) {
      console.log(`[Tandem ${strategy.id}] Margin mode note:`, e.message);
    }
    try { await client.setLeverage(strategy.symbol, leverage); } catch (e: any) {
      console.log(`[Tandem ${strategy.id}] Leverage note:`, e.message);
    }

    const precision = await getPairPrecision(strategy.symbol);
    const tandemReservePct = managedParam(config, "tpReservePct", 0.1);
    const minTpCount = 5;
    const minInitialQty = (minTpCount * precision.minTradeVolume) / (1 - tandemReservePct);
    const perSideCapital = Math.min(longCapital, shortCapital);
    const minInitialMargin = (minInitialQty * currentPrice) / (leverage * 0.95);
    const initialShare = Math.max(minInitialMargin, perSideCapital * managedParam(config, "initialSharePct", 0.25));
    const initialNotional = initialShare * leverage * 0.95;
    const symmetricQty = Math.max(initialNotional / currentPrice, minInitialQty);
    const symmetricQtyStr = roundQty(symmetricQty, precision.basePrecision);
    const symmetricQtyNum = parseFloat(symmetricQtyStr);

    console.log(`[Tandem ${strategy.id}] Creating LONG + SHORT grid bots, total=${totalCapital}, L=${longCapital.toFixed(1)}(${longWeight}/${totalWeight}) S=${shortCapital.toFixed(1)}(${shortWeight}/${totalWeight}), leverage=${leverage}x, symmetricQty=${symmetricQtyStr}`);

    const fm = managedParam(config, "feeMultiplier", config.feeMultiplier || 3.5);
    const longGridConfig = defaultGridConfigForSide("LONG", currentPrice, leverage, longCapital, fm, false, 0.006, tandemReservePct);
    (longGridConfig as any).parentTandemId = strategy.id;
    (longGridConfig as any).fixedInitialQty = symmetricQtyStr;
    (longGridConfig as any).fixedInitialShare = initialShare;
    const longGrid = await storage.createStrategy({
      name: `TL ${strategy.symbol}`,
      type: "grid",
      symbol: strategy.symbol,
      side: "BUY",
      status: "running",
      config: { ...longGridConfig },
    });
    console.log(`[Tandem ${strategy.id}] LONG grid created: #${longGrid.id}`);

    const shortGridConfig = defaultGridConfigForSide("SHORT", currentPrice, leverage, shortCapital, fm, false, 0.006, tandemReservePct);
    (shortGridConfig as any).parentTandemId = strategy.id;
    (shortGridConfig as any).fixedInitialQty = symmetricQtyStr;
    (shortGridConfig as any).fixedInitialShare = initialShare;
    const shortGrid = await storage.createStrategy({
      name: `TS ${strategy.symbol}`,
      type: "grid",
      symbol: strategy.symbol,
      side: "SELL",
      status: "running",
      config: { ...shortGridConfig },
    });
    console.log(`[Tandem ${strategy.id}] SHORT grid created: #${shortGrid.id}`);

    const updatedConfig: TandemConfig = {
      ...config,
      totalCapital,
      phase: "waiting_liquidation",
      entryPrice: currentPrice,
      longGridId: longGrid.id,
      shortGridId: shortGrid.id,
      longPositionId: null,
      shortPositionId: null,
      longEntryQty: 0,
      shortEntryQty: 0,
      liquidatedSide: null,
      liquidationPrice: 0,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: 0,
      remainingQty: 0,
      survivingSide: null,
      survivingPositionId: null,
      cycleCount: (config.cycleCount || 0) + 1,
      lastActionAt: Date.now(),
      lastRebalancePriceRef: currentPrice,
      consecutiveRebalances: 0,
      rebalanceCount: 0,
    };

    await storage.updateStrategy(strategy.id, { config: updatedConfig });

    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "BUY",
      orderType: "MARKET",
      quantity: 0,
      price: currentPrice,
      status: "filled",
      orderId: null,
      pnl: null,
      errorMsg: `Tandem cycle ${updatedConfig.cycleCount}: LONG grid #${longGrid.id}(${longCapital.toFixed(0)}) + SHORT grid #${shortGrid.id}(${shortCapital.toFixed(0)}) created`,
    });

    console.log(`[Tandem ${strategy.id}] Cycle ${updatedConfig.cycleCount} started with grid bots #${longGrid.id} (LONG) + #${shortGrid.id} (SHORT) @ ${currentPrice}`);
  } finally {
    tandemEntryLocks.delete(strategy.id);
  }
}

async function tandemWaitLiquidation(strategy: Strategy, config: TandemConfig, client: any) {
  const timeSinceEntry = Date.now() - (config.lastActionAt || 0);
  const GRACE_PERIOD_MS = 120_000;

  let longGridReady = false;
  let shortGridReady = false;
  if (config.longGridId) {
    try {
      const lg = await storage.getStrategy(config.longGridId);
      if (lg) {
        const lgCfg = lg.config as any;
        longGridReady = !!lgCfg?.initialBuyDone;
      }
    } catch {}
  }
  if (config.shortGridId) {
    try {
      const sg = await storage.getStrategy(config.shortGridId);
      if (sg) {
        const sgCfg = sg.config as any;
        shortGridReady = !!sgCfg?.initialBuyDone;
      }
    } catch {}
  }

  if ((!longGridReady || !shortGridReady) && timeSinceEntry < GRACE_PERIOD_MS) {
    console.log(`[Tandem ${strategy.id}] Waiting for child grids to open initial positions (L=${longGridReady}, S=${shortGridReady}, ${Math.round(timeSinceEntry / 1000)}s elapsed)`);
    return;
  }

  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) {
    console.log(`[Tandem ${strategy.id}] Position fetch failed, retrying next cycle`);
    return;
  }

  let longAlive = false;
  let shortAlive = false;
  let longPos: any = null;
  let shortPos: any = null;

  for (const pos of posRes.data) {
    if (!isSymbolPosition(pos, strategy.symbol)) continue;
    const posQty = parseFloat(pos.qty || "0");
    if (posQty <= 0) continue;
    if (pos.side === "BUY") { longAlive = true; longPos = pos; }
    if (pos.side === "SELL") { shortAlive = true; shortPos = pos; }
  }

  if (!longGridReady || !shortGridReady) {
    if (longAlive) longGridReady = true;
    if (shortAlive) shortGridReady = true;
    if (!longGridReady || !shortGridReady) {
      console.log(`[Tandem ${strategy.id}] Child grids still initializing after grace period (L=${longGridReady}, S=${shortGridReady}), waiting...`);
      return;
    }
  }

  if (config.longEntryQty === 0 && longPos) {
    config.longEntryQty = parseFloat(longPos.qty || "0");
    config.longPositionId = longPos.positionId;
  }
  if (config.shortEntryQty === 0 && shortPos) {
    config.shortEntryQty = parseFloat(shortPos.qty || "0");
    config.shortPositionId = shortPos.positionId;
  }
  if ((config.longEntryQty === 0 && longPos) || (config.shortEntryQty === 0 && shortPos)) {
    await storage.updateStrategy(strategy.id, { config });
  }

  if (longAlive && shortAlive) {
    const ticker = await getTickerPrice(strategy.symbol);
    const longQty = parseFloat(longPos.qty || "0");
    const shortQty = parseFloat(shortPos.qty || "0");
    const longLiqPrice = parseFloat(longPos.liqPrice || "0");
    const shortLiqPrice = parseFloat(shortPos.liqPrice || "0");
    const currentPrice = ticker?.lastPrice || config.entryPrice;

    const longPnl = parseFloat(longPos.unrealizedPNL || "0");
    const shortPnl = parseFloat(shortPos.unrealizedPNL || "0");
    const longMargin = parseFloat(longPos.margin || "0");
    const shortMargin = parseFloat(shortPos.margin || "0");
    const longRoi = longMargin > 0 ? longPnl / longMargin : 0;
    const shortRoi = shortMargin > 0 ? shortPnl / shortMargin : 0;

    const longLiqDist = currentPrice > 0 && longLiqPrice > 0 ? (currentPrice - longLiqPrice) / currentPrice : 1;
    const shortLiqDist = currentPrice > 0 && shortLiqPrice > 0 ? (shortLiqPrice - currentPrice) / currentPrice : 1;

    console.log(`[Tandem ${strategy.id}] Both alive @ ${currentPrice.toFixed(4)} | L=${longQty} liq=${longLiqPrice.toFixed(4)}(${(longLiqDist * 100).toFixed(1)}%) pnl=${longPnl.toFixed(2)} roi=${(longRoi * 100).toFixed(1)}% | S=${shortQty} liq=${shortLiqPrice.toFixed(4)}(${(shortLiqDist * 100).toFixed(1)}%) pnl=${shortPnl.toFixed(2)} roi=${(shortRoi * 100).toFixed(1)}%`);

    const longW = managedParam(config, "longWeight", config.longWeight || 1);
    const shortW = managedParam(config, "shortWeight", config.shortWeight || 1);
    const totalW = longW + shortW;
    const targetLongRatio = longW / totalW;
    const totalQtyValue = longQty + shortQty;
    const actualLongRatio = totalQtyValue > 0 ? longQty / totalQtyValue : targetLongRatio;
    const divergence = actualLongRatio - targetLongRatio;
    const absDivergence = Math.abs(divergence);

    if (absDivergence > 0.03 && config.longGridId && config.shortGridId) {
      const rebalFactor = Math.min(absDivergence * 4, 0.5);
      const longMultiplier = divergence > 0 ? (1 - rebalFactor) : (1 + rebalFactor);
      const shortMultiplier = divergence > 0 ? (1 + rebalFactor) : (1 - rebalFactor);

      try {
        const lg = await storage.getStrategy(config.longGridId);
        const sg = await storage.getStrategy(config.shortGridId);
        if (lg) {
          const lgCfg = lg.config as any;
          if (Math.abs((lgCfg.gridSizeMultiplier || 1) - longMultiplier) > 0.05) {
            lgCfg.gridSizeMultiplier = longMultiplier;
            await storage.updateStrategy(config.longGridId, { config: lgCfg });
          }
        }
        if (sg) {
          const sgCfg = sg.config as any;
          if (Math.abs((sgCfg.gridSizeMultiplier || 1) - shortMultiplier) > 0.05) {
            sgCfg.gridSizeMultiplier = shortMultiplier;
            await storage.updateStrategy(config.shortGridId, { config: sgCfg });
          }
        }
        console.log(`[Tandem ${strategy.id}] Order sizing bias: L×${longMultiplier.toFixed(2)} S×${shortMultiplier.toFixed(2)} (div=${(divergence * 100).toFixed(1)}% from target ${(targetLongRatio * 100).toFixed(0)}/${(100 - targetLongRatio * 100).toFixed(0)})`);
      } catch (e: any) {
        console.error(`[Tandem ${strategy.id}] Grid size multiplier update error:`, e.message);
      }
    } else if (absDivergence <= 0.03 && config.longGridId && config.shortGridId) {
      try {
        const lg = await storage.getStrategy(config.longGridId);
        const sg = await storage.getStrategy(config.shortGridId);
        if (lg) {
          const lgCfg = lg.config as any;
          if (lgCfg.gridSizeMultiplier && lgCfg.gridSizeMultiplier !== 1) {
            lgCfg.gridSizeMultiplier = 1;
            await storage.updateStrategy(config.longGridId, { config: lgCfg });
          }
        }
        if (sg) {
          const sgCfg = sg.config as any;
          if (sgCfg.gridSizeMultiplier && sgCfg.gridSizeMultiplier !== 1) {
            sgCfg.gridSizeMultiplier = 1;
            await storage.updateStrategy(config.shortGridId, { config: sgCfg });
          }
        }
      } catch {}
    }

    const consecutiveRebalances = config.consecutiveRebalances || 0;
    const BASE_COOLDOWN_MS = 120_000;
    const MAX_COOLDOWN_MS = 900_000;
    const cooldownMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.pow(2, consecutiveRebalances));
    const lastRebalance = config.lastRebalanceAt || 0;
    const timeSinceRebalance = Date.now() - lastRebalance;

    if (timeSinceRebalance >= cooldownMs && longQty > 0 && shortQty > 0) {
      const maxQty = Math.max(longQty, shortQty);
      const minQty = Math.min(longQty, shortQty);
      const ratio = maxQty / minQty;

      const liqThreshold = 1 / config.leverage;
      const closerLiqDist = Math.min(longLiqDist, shortLiqDist);
      const liqUrgency = closerLiqDist < liqThreshold * 0.5;

      const imbalanceThreshold = liqUrgency ? 1.05 : 1.10;

      if (ratio <= 1.03 && consecutiveRebalances > 0) {
        config.consecutiveRebalances = 0;
        config.lastRebalancePriceRef = currentPrice;
        await storage.updateStrategy(strategy.id, { config });
      }

      if (ratio > imbalanceThreshold) {
        const lastPriceRef = config.lastRebalancePriceRef || config.entryPrice;
        const priceMove = Math.abs(currentPrice - lastPriceRef) / lastPriceRef;
        const velocityThreshold = liqUrgency ? 0.01 : 0.005;

        if (priceMove > velocityThreshold && !liqUrgency) {
          config.lastRebalancePriceRef = currentPrice;
          await storage.updateStrategy(strategy.id, { config });
          console.log(`[Tandem ${strategy.id}] Rebalance SKIPPED: price moving fast (${(priceMove * 100).toFixed(2)}% since last ref). Ref updated, waiting for stability.`);
          return;
        }

        const qtyLargerSide: "LONG" | "SHORT" = longQty > shortQty ? "LONG" : "SHORT";
        const largerSideRoi = qtyLargerSide === "LONG" ? longRoi : shortRoi;
        const smallerSideRoi = qtyLargerSide === "LONG" ? shortRoi : longRoi;
        const largerSidePnl = qtyLargerSide === "LONG" ? longPnl : shortPnl;

        const DEEP_LOSS_ROI = -0.15;
        const MODERATE_LOSS_ROI = -0.05;

        if (largerSideRoi < DEEP_LOSS_ROI && !liqUrgency) {
          console.log(`[Tandem ${strategy.id}] Rebalance BLOCKED: ${qtyLargerSide} ROI=${(largerSideRoi * 100).toFixed(1)}% is deeply negative (threshold ${(DEEP_LOSS_ROI * 100).toFixed(0)}%). Would realize $${Math.abs(largerSidePnl).toFixed(2)} loss. Relying on grid order sizing bias instead.`);
          config.lastRebalancePriceRef = currentPrice;
          await storage.updateStrategy(strategy.id, { config });
          return;
        }

        let trimSide: "LONG" | "SHORT" = qtyLargerSide;
        let excessQty = maxQty - minQty;

        if (largerSideRoi < MODERATE_LOSS_ROI && smallerSideRoi > 0 && !liqUrgency) {
          const otherSide: "LONG" | "SHORT" = qtyLargerSide === "LONG" ? "SHORT" : "LONG";
          console.log(`[Tandem ${strategy.id}] PnL-aware swap: ${qtyLargerSide} is underwater (ROI=${(largerSideRoi * 100).toFixed(1)}%), ${otherSide} is profitable (ROI=${(smallerSideRoi * 100).toFixed(1)}%). Skipping direct trim of losing side, relying on order sizing bias.`);
          config.lastRebalancePriceRef = currentPrice;
          await storage.updateStrategy(strategy.id, { config });
          return;
        }

        let baseTrimPct = liqUrgency ? 0.75 : 0.50;

        if (largerSideRoi < MODERATE_LOSS_ROI && largerSideRoi >= DEEP_LOSS_ROI) {
          const lossRange = Math.abs(DEEP_LOSS_ROI) - Math.abs(MODERATE_LOSS_ROI);
          const lossSeverity = (Math.abs(largerSideRoi) - Math.abs(MODERATE_LOSS_ROI)) / lossRange;
          baseTrimPct *= Math.max(0.25, 1 - lossSeverity * 0.75);
          console.log(`[Tandem ${strategy.id}] PnL-scaled trim: ${trimSide} ROI=${(largerSideRoi * 100).toFixed(1)}%, trim reduced to ${(baseTrimPct * 100).toFixed(0)}% of excess`);
        }

        const precision = await getPairPrecision(strategy.symbol);
        const trimQty = roundQty(excessQty * baseTrimPct, precision.basePrecision);
        const trimQtyNum = parseFloat(trimQty);

        const estimatedPnlPerUnit = largerSidePnl / (trimSide === "LONG" ? longQty : shortQty);
        const estimatedTrimPnl = estimatedPnlPerUnit * trimQtyNum;

        if (trimQtyNum >= precision.minTradeVolume) {
          const closeSide = trimSide === "LONG" ? "SELL" : "BUY";
          const newConsecutive = consecutiveRebalances + 1;
          const nextCooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.pow(2, newConsecutive));

          console.log(`[Tandem ${strategy.id}] REBALANCE #${(config.rebalanceCount || 0) + 1}: ${trimSide} ${maxQty} vs ${minQty} (ratio ${ratio.toFixed(2)}, trim ${(baseTrimPct * 100).toFixed(0)}%=${trimQty}, est.PnL=${estimatedTrimPnl.toFixed(2)}, ROI=${(largerSideRoi * 100).toFixed(1)}%, liqUrg=${liqUrgency}, priceVel=${(priceMove * 100).toFixed(2)}%, nextCooldown=${Math.round(nextCooldown / 1000)}s)`);

          try {
            const posToTrim = trimSide === "LONG" ? longPos : shortPos;
            const { result, filled } = await placeLimitClose(client, {
              symbol: strategy.symbol,
              qty: trimQty,
              side: closeSide,
              positionId: posToTrim?.positionId,
              price: currentPrice,
              quotePrecision: precision.quotePrecision,
            });

            if (filled) {
              config.lastRebalanceAt = Date.now();
              config.lastRebalancePriceRef = currentPrice;
              config.rebalanceCount = (config.rebalanceCount || 0) + 1;
              config.consecutiveRebalances = newConsecutive;
              await storage.updateStrategy(strategy.id, { config });

              await storage.createTradeLog({
                strategyId: strategy.id,
                symbol: strategy.symbol,
                side: closeSide,
                orderType: "MARKET",
                quantity: trimQtyNum,
                price: currentPrice,
                status: "filled",
                orderId: result.data?.orderId || null,
                pnl: estimatedTrimPnl,
                errorMsg: `Rebalance #${config.rebalanceCount}: trimmed ${trimSide} by ${trimQty} (${(baseTrimPct * 100).toFixed(0)}% of excess, ratio ${ratio.toFixed(2)}, ROI=${(largerSideRoi * 100).toFixed(1)}%, est.PnL=${estimatedTrimPnl.toFixed(2)}, cooldown=${Math.round(nextCooldown / 1000)}s)`,
              });

              console.log(`[Tandem ${strategy.id}] Rebalanced: ${trimSide} -${trimQty} (est.PnL=${estimatedTrimPnl.toFixed(2)}). Target ~${(minQty + excessQty * (1 - baseTrimPct)).toFixed(1)}`);
            } else {
              console.error(`[Tandem ${strategy.id}] Rebalance LIMIT IOC was not filled: ${result?.msg || "unfilled"}`);
            }
          } catch (e: any) {
            console.error(`[Tandem ${strategy.id}] Rebalance error:`, e.message);
          }
        }
      }
    }
    return;
  }

  const capitalPerSide = (config.totalCapital || 100) / 2;

  if (!longAlive && !shortAlive) {
    console.log(`[Tandem ${strategy.id}] Both grids liquidated! Cleaning up child strategies...`);
    await stopChildGrids(config);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: "BUY",
      orderType: "MARKET",
      quantity: 0,
      price: config.entryPrice,
      status: "filled",
      orderId: null,
      pnl: -config.totalCapital,
      errorMsg: `Tandem cycle ${config.cycleCount}: BOTH grids liquidated`,
    });
    return;
  }

  const liquidatedSide: "LONG" | "SHORT" = longAlive ? "SHORT" : "LONG";
  const survivingSide: "LONG" | "SHORT" = longAlive ? "LONG" : "SHORT";
  const survivingPos = longAlive ? longPos : shortPos;
  const survivingPositionId = survivingPos?.positionId || null;
  const survivingQty = parseFloat(survivingPos?.qty || "0");

  const liquidatedGridId = liquidatedSide === "LONG" ? config.longGridId : config.shortGridId;
  if (liquidatedGridId) {
    try {
      await storage.updateStrategy(liquidatedGridId, { status: "stopped" });
      console.log(`[Tandem ${strategy.id}] Stopped liquidated ${liquidatedSide} grid #${liquidatedGridId}`);
    } catch {}
  }

  const ticker = await getTickerPrice(strategy.symbol);
  const liquidationPrice = ticker?.lastPrice || config.entryPrice;

  console.log(`[Tandem ${strategy.id}] ${liquidatedSide} grid LIQUIDATED @ ~${liquidationPrice.toFixed(4)} | Survivor: ${survivingSide} grid (qty=${survivingQty})`);

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "cascade",
      liquidatedSide,
      liquidationPrice,
      survivingSide,
      survivingPositionId,
      remainingQty: survivingQty,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: liquidationPrice,
      lastActionAt: Date.now(),
    },
  });

  await storage.createTradeLog({
    strategyId: strategy.id,
    symbol: strategy.symbol,
    side: liquidatedSide === "LONG" ? "BUY" : "SELL",
    orderType: "MARKET",
    quantity: 0,
    price: liquidationPrice,
    status: "filled",
    orderId: null,
    pnl: -capitalPerSide,
    errorMsg: `Tandem cycle ${config.cycleCount}: ${liquidatedSide} grid liquidated`,
  });
}

async function stopChildGrids(config: TandemConfig) {
  const ids = [config.longGridId, config.shortGridId].filter(Boolean) as number[];
  for (const id of ids) {
    try {
      const child = await storage.getStrategy(id);
      if (child && child.status === "running") {
        try {
          const client = getBitunixClient();
          if (client) {
            await client.cancelAllOrders(child.symbol);
          }
        } catch {}
        await storage.updateStrategy(id, { status: "stopped" });
        console.log(`[Tandem] Stopped child grid #${id}`);
      }
    } catch {}
  }
}

async function deleteChildGrids(config: TandemConfig) {
  const ids = [config.longGridId, config.shortGridId].filter(Boolean) as number[];
  for (const id of ids) {
    try {
      const child = await storage.getStrategy(id);
      if (child) {
        if (child.status === "running") {
          try {
            const client = getBitunixClient();
            if (client) {
              await client.cancelAllOrders(child.symbol);
            }
          } catch {}
        }
        await storage.deleteStrategy(id);
        console.log(`[Tandem] Deleted child grid #${id}`);
      }
    } catch {}
  }
}

async function bailOutAndRestart(
  strategy: Strategy,
  config: TandemConfig,
  client: any,
  currentPrice: number,
  currentQty: number,
  precision: { basePrecision: number; quotePrecision: number; minTradeVolume: number },
  reason: string,
) {
  const survivingSide = config.survivingSide;
  const closeSide = survivingSide === "LONG" ? "SELL" : "BUY";
  const direction = survivingSide === "LONG" ? 1 : -1;
  const qtyStr = roundQty(currentQty, precision.basePrecision);

  try {
    const { result, filled } = await placeLimitClose(client, {
      symbol: strategy.symbol,
      qty: qtyStr,
      side: closeSide,
      positionId: config.survivingPositionId || undefined,
      price: currentPrice,
      quotePrecision: precision.quotePrecision,
    });

    const profitPerUnit = direction * (currentPrice - config.entryPrice);
    const exitPnl = profitPerUnit * currentQty;

    if (filled) {
      console.log(`[Tandem ${strategy.id}] Bail-out close filled: pnl=${exitPnl.toFixed(4)}`);

      await storage.createTradeLog({
        strategyId: strategy.id,
        symbol: strategy.symbol,
        side: closeSide,
         orderType: "LIMIT",
        quantity: currentQty,
        price: currentPrice,
        status: "filled",
        orderId: result.data?.orderId || null,
        pnl: exitPnl,
        errorMsg: `Tandem bail-out: ${reason}`,
      });

      await storage.updateStrategy(strategy.id, {
        config: { ...config, phase: "complete", lastActionAt: Date.now() },
        totalPnl: (strategy.totalPnl || 0) + exitPnl,
      });
    } else {
      console.error(`[Tandem ${strategy.id}] Bail-out LIMIT IOC was not filled: ${result?.msg || "unfilled"}`);
    }
  } catch (e: any) {
    console.error(`[Tandem ${strategy.id}] Bail-out error:`, e.message);
    console.error(`[Tandem ${strategy.id}] Bail-out LIMIT close error: ${e.message}; position remains for next retry.`);
  }
}

async function tandemCascade(strategy: Strategy, config: TandemConfig, client: any) {
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const survivingSide = config.survivingSide;
  const posSide = survivingSide === "LONG" ? "BUY" : "SELL";
  const survivingPos = posRes.data.find((p: any) => isSymbolPosition(p, strategy.symbol) && p.side === posSide && parseFloat(p.qty || "0") > 0);

  const capitalPerSide = (config.totalCapital || 100) / 2;

  const cascadePortions = [1/2, 1/4, 1/4];
  const cascadeTargetPcts = [0, 0.01, 0.02];
  const cascadeLabels = ["immediate recovery", "1% beyond liq", "2% beyond liq"];
  const TOTAL_CASCADE_STEPS = 3;
  const TRAILING_PULLBACK = 0.003;

  if (!survivingPos) {
    console.log(`[Tandem ${strategy.id}] Surviving position gone (liquidated during cascade)`);
    await stopChildGrids(config);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    await storage.createTradeLog({
      strategyId: strategy.id,
      symbol: strategy.symbol,
      side: posSide,
      orderType: "MARKET",
      quantity: 0,
      price: config.liquidationPrice,
      status: "filled",
      orderId: null,
      pnl: -capitalPerSide,
      errorMsg: `Tandem cycle ${config.cycleCount}: survivor also liquidated`,
    });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const currentQty = parseFloat(survivingPos.qty || "0");
  const precision = await getPairPrecision(strategy.symbol);

  const direction = survivingSide === "LONG" ? 1 : -1;
  const cascadeStartPrice = config.liquidationPrice;

  const moveBeyondLiq = survivingSide === "LONG"
    ? (currentPrice - cascadeStartPrice) / cascadeStartPrice
    : (cascadeStartPrice - currentPrice) / cascadeStartPrice;

  const cascadeStep = config.cascadeStep || 0;

  if (cascadeStep > 0 && moveBeyondLiq < 0) {
    console.log(`[Tandem ${strategy.id}] REVERSAL BAIL-OUT: trend broke after cascade step ${cascadeStep}, price reversed past liq point (move=${(moveBeyondLiq * 100).toFixed(2)}%). Closing remaining and restarting.`);
    await bailOutAndRestart(strategy, config, client, currentPrice, currentQty, precision, "cascade reversal after step " + cascadeStep);
    return;
  }

  if (cascadeStep < TOTAL_CASCADE_STEPS) {
    const targetPct = cascadeTargetPcts[cascadeStep];

    if (moveBeyondLiq >= targetPct) {
      const originalQty = config.longEntryQty || config.shortEntryQty || config.remainingQty;
      const portionQty = originalQty * cascadePortions[cascadeStep];
      const sellQty = Math.min(portionQty, currentQty);
      const qtyStr = roundQty(sellQty, precision.basePrecision);

      if (sellQty < precision.minTradeVolume) {
        console.log(`[Tandem ${strategy.id}] Cascade step ${cascadeStep + 1} qty too small (${sellQty}), skipping`);
        const newStep = cascadeStep + 1;
        await storage.updateStrategy(strategy.id, {
          config: {
            ...config,
            cascadeStep: newStep,
            phase: newStep >= TOTAL_CASCADE_STEPS ? "trailing" : "cascade",
            lastActionAt: Date.now(),
          },
        });
      } else {
        const closeSide = survivingSide === "LONG" ? "SELL" : "BUY";
        console.log(`[Tandem ${strategy.id}] CASCADE ${cascadeStep + 1}/${TOTAL_CASCADE_STEPS}: ${closeSide} ${qtyStr} (${(cascadePortions[cascadeStep] * 100).toFixed(0)}%) @ LIMIT IOC — ${cascadeLabels[cascadeStep]} (move=${(moveBeyondLiq * 100).toFixed(2)}%)`);

        try {
          const { result, filled } = await placeLimitClose(client, {
            symbol: strategy.symbol,
            qty: qtyStr,
            side: closeSide,
            positionId: config.survivingPositionId || undefined,
            price: currentPrice,
            quotePrecision: precision.quotePrecision,
          });

          const profitPerUnit = direction * (currentPrice - config.entryPrice);
          const exitPnl = profitPerUnit * sellQty;

          if (filled) {
            const newStep = cascadeStep + 1;
            const newRemainingQty = currentQty - sellQty;

            await storage.updateStrategy(strategy.id, {
              config: {
                ...config,
                cascadeStep: newStep,
                remainingQty: newRemainingQty,
                highWatermark: currentPrice,
                phase: newStep >= TOTAL_CASCADE_STEPS ? "trailing" : "cascade",
                lastActionAt: Date.now(),
              },
              totalPnl: (strategy.totalPnl || 0) + exitPnl,
            });

            await storage.createTradeLog({
              strategyId: strategy.id,
              symbol: strategy.symbol,
              side: closeSide,
              orderType: "LIMIT",
              quantity: sellQty,
              price: currentPrice,
              status: "filled",
              orderId: result.data?.orderId || null,
              pnl: exitPnl,
              errorMsg: `Tandem cascade ${newStep}/${TOTAL_CASCADE_STEPS}: ${cascadeLabels[cascadeStep]} (${(cascadePortions[cascadeStep] * 100).toFixed(0)}%)`,
            });

            console.log(`[Tandem ${strategy.id}] Cascade ${newStep}/${TOTAL_CASCADE_STEPS} filled: pnl=${exitPnl.toFixed(4)}, remaining=${newRemainingQty.toFixed(precision.basePrecision)}`);
          } else {
            console.error(`[Tandem ${strategy.id}] Cascade LIMIT IOC was not filled: ${result?.msg || "unfilled"}`);
          }
        } catch (e: any) {
          console.error(`[Tandem ${strategy.id}] Cascade TP error:`, e.message);
        }
      }
    } else {
      console.log(`[Tandem ${strategy.id}] Cascade waiting: step ${cascadeStep + 1} needs ${(targetPct * 100).toFixed(0)}% move, current=${(moveBeyondLiq * 100).toFixed(2)}%`);
    }
  }
}

async function tandemTrailing(strategy: Strategy, config: TandemConfig, client: any) {
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const posSide = config.survivingSide === "LONG" ? "BUY" : "SELL";
  const survivingPos = posRes.data.find((p: any) => isSymbolPosition(p, strategy.symbol) && p.side === posSide && parseFloat(p.qty || "0") > 0);

  if (!survivingPos) {
    console.log(`[Tandem ${strategy.id}] Trailing: position gone, completing cycle`);
    await stopChildGrids(config);
    await storage.updateStrategy(strategy.id, {
      config: { ...config, phase: "complete", lastActionAt: Date.now() },
    });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const currentQty = parseFloat(survivingPos.qty || "0");
  const precision = await getPairPrecision(strategy.symbol);

  const cascadeStartPrice = config.liquidationPrice;
  const moveBeyondLiq = config.survivingSide === "LONG"
    ? (currentPrice - cascadeStartPrice) / cascadeStartPrice
    : (cascadeStartPrice - currentPrice) / cascadeStartPrice;

  if (moveBeyondLiq < 0) {
    console.log(`[Tandem ${strategy.id}] REVERSAL BAIL-OUT (trailing): price reversed past liq point (move=${(moveBeyondLiq * 100).toFixed(2)}%). Closing remaining and restarting.`);
    await bailOutAndRestart(strategy, config, client, currentPrice, currentQty, precision, "trailing reversal past liq");
    return;
  }

  let hwm = config.highWatermark || currentPrice;
  if (config.survivingSide === "LONG") {
    hwm = Math.max(hwm, currentPrice);
  } else {
    hwm = Math.min(hwm, currentPrice);
  }

  const trailingDrop = config.survivingSide === "LONG"
    ? (hwm - currentPrice) / hwm
    : (currentPrice - hwm) / hwm;

  const TRAILING_TRIGGER = 0.003;
  console.log(`[Tandem ${strategy.id}] Trailing 1/7: price=${currentPrice.toFixed(4)} hwm=${hwm.toFixed(4)} drop=${(trailingDrop * 100).toFixed(3)}% (trigger=${(TRAILING_TRIGGER * 100).toFixed(1)}%)`);

  if (trailingDrop >= TRAILING_TRIGGER) {
    const survivingGridId = config.survivingSide === "LONG" ? config.longGridId : config.shortGridId;
    if (survivingGridId) {
      try { await storage.updateStrategy(survivingGridId, { status: "stopped" }); } catch {}
    }

    const closeSide = config.survivingSide === "LONG" ? "SELL" : "BUY";
    const qtyStr = roundQty(currentQty, precision.basePrecision);

    console.log(`[Tandem ${strategy.id}] TRAILING STOP triggered: ${closeSide} ${qtyStr} @ LIMIT IOC`);

    try {
      const { result, filled } = await placeLimitClose(client, {
        symbol: strategy.symbol,
        qty: qtyStr,
        side: closeSide,
        positionId: survivingPos?.positionId,
        price: currentPrice,
        quotePrecision: precision.quotePrecision,
      });

      const direction = config.survivingSide === "LONG" ? 1 : -1;
      const profitPerUnit = direction * (currentPrice - config.entryPrice);
      const exitPnl = profitPerUnit * currentQty;

      if (filled) {
        await storage.updateStrategy(strategy.id, {
          config: { ...config, phase: "complete", highWatermark: hwm, lastActionAt: Date.now() },
          totalPnl: (strategy.totalPnl || 0) + exitPnl,
        });

        await storage.createTradeLog({
          strategyId: strategy.id,
          symbol: strategy.symbol,
          side: closeSide,
          orderType: "LIMIT",
          quantity: currentQty,
          price: currentPrice,
          status: "filled",
          orderId: result.data?.orderId || null,
          pnl: exitPnl,
          errorMsg: `Tandem trailing stop 1/7 (0.3% pullback from HWM ${hwm.toFixed(4)})`,
        });

        console.log(`[Tandem ${strategy.id}] Trailing close: pnl=${exitPnl.toFixed(4)}`);
      } else {
        console.error(`[Tandem ${strategy.id}] Trailing LIMIT IOC was not filled: ${result?.msg || "unfilled"}`);
      }
    } catch (e: any) {
      console.error(`[Tandem ${strategy.id}] Trailing close error:`, e.message);
    }
  } else {
    await storage.updateStrategy(strategy.id, {
      config: { ...config, highWatermark: hwm },
    });
  }
}

async function tandemComplete(strategy: Strategy, config: TandemConfig, client: any) {
  console.log(`[Tandem ${strategy.id}] Cycle ${config.cycleCount} complete. Cleaning up and restarting...`);

  await stopChildGrids(config);

  try { await client.cancelAllOrders(strategy.symbol); } catch {}
  try {
    const tpRes = await client.getPendingTpslOrders(strategy.symbol);
    if (tpRes?.code === 0) {
      let tpList = tpRes.data;
      if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) tpList = tpList.orderList;
      if (Array.isArray(tpList)) {
        for (const tp of tpList) {
          const tpId = tp.id || tp.orderId;
          if (tpId) try { await client.cancelTpslOrder(strategy.symbol, tpId); } catch {}
        }
      }
    }
  } catch {}

  try {
     const posRes = await client.getPositions(strategy.symbol);
     if (posRes?.code === 0 && Array.isArray(posRes.data)) {
       for (const pos of posRes.data) {
        if (!isSymbolPosition(pos, strategy.symbol)) continue;
        if (parseFloat(pos.qty || "0") > 0) {
          try { await client.flashClose(strategy.symbol, pos.positionId); } catch {}
        }
      }
    }
  } catch {}

  await deleteChildGrids(config);

  const checkRotation = config.rotationEnabled;
  if (checkRotation) {
    const rotation = await checkPairRotation(strategy);
    if (rotation.shouldRotate && rotation.newSymbol) {
      console.log(`[Tandem ${strategy.id}] Rotating to ${rotation.newSymbol}: ${rotation.reason}`);
      await storage.updateStrategy(strategy.id, {
        symbol: rotation.newSymbol,
        config: {
          ...config,
          phase: "entry",
          entryPrice: 0,
          longGridId: null,
          shortGridId: null,
          longPositionId: null,
          shortPositionId: null,
          liquidatedSide: null,
          survivingSide: null,
          survivingPositionId: null,
          cascadeStep: 0,
          tpOrderIds: [],
          highWatermark: 0,
          remainingQty: 0,
          lastActionAt: Date.now(),
        },
      });
      priceFeed.subscribe(rotation.newSymbol);
      return;
    }
  }

  await storage.updateStrategy(strategy.id, {
    config: {
      ...config,
      phase: "entry",
      entryPrice: 0,
      longGridId: null,
      shortGridId: null,
      longPositionId: null,
      shortPositionId: null,
      liquidatedSide: null,
      survivingSide: null,
      survivingPositionId: null,
      cascadeStep: 0,
      tpOrderIds: [],
      highWatermark: 0,
      remainingQty: 0,
      lastActionAt: Date.now(),
    },
  });

  console.log(`[Tandem ${strategy.id}] Reset to entry phase for next cycle`);
}

export async function cancelAllTandemOrders(strategyId: number, symbol: string) {
  const client = getBitunixClient();
  if (!client) return;

  const strategy = await storage.getStrategy(strategyId);
  if (strategy) {
    const config = strategy.config as TandemConfig;
    await deleteChildGrids(config);
  }

  try { await client.cancelAllOrders(symbol); } catch {}
  try {
    const tpRes = await client.getPendingTpslOrders(symbol);
    if (tpRes?.code === 0) {
      let tpList = tpRes.data;
      if (tpList && !Array.isArray(tpList) && Array.isArray(tpList.orderList)) tpList = tpList.orderList;
      if (Array.isArray(tpList)) {
        for (const tp of tpList) {
          const tpId = tp.id || tp.orderId;
          if (tpId) try { await client.cancelTpslOrder(symbol, tpId); } catch {}
        }
      }
    }
  } catch {}

  try {
     const posRes = await client.getPositions(symbol);
     if (posRes?.code === 0 && Array.isArray(posRes.data)) {
       for (const pos of posRes.data) {
        if (!isSymbolPosition(pos, symbol)) continue;
        if (parseFloat(pos.qty || "0") > 0) {
          try { await client.flashClose(symbol, pos.positionId); } catch {}
        }
      }
    }
  } catch {}
}

export interface TandemCycle {
  cycleNum: number;
  entryPrice: number;
  liquidatedSide: "LONG" | "SHORT";
  liquidationPrice: number;
  gridPnlLong: number;
  gridPnlShort: number;
  cascadePnl: number;
  liquidationLoss: number;
  cyclePnl: number;
  cascadeExits: { percent: number; price: number; pnl: number }[];
  trailingExitPrice?: number;
}

export interface TandemSimResult {
  symbol: string;
  leverage: number;
  startPrice: number;
  endPrice: number;
  totalCycles: number;
  totalPnl: number;
  totalGridPnl: number;
  totalCascadePnl: number;
  totalLiquidationLoss: number;
  winCycles: number;
  lossCycles: number;
  maxDrawdown: number;
  capitalUsed: number;
  roiPercent: number;
  cycles: TandemCycle[];
  pricePoints: number;
}

export function simulateTandem(
  priceHistory: { timestamp: number; price: number }[],
  feeRate: number = 0.0006,
  capitalPerSide: number = 50,
  leverage: number = 100,
  feeMultiplier: number = 4.0
): TandemSimResult | null {
  if (!priceHistory || priceHistory.length < 10) return null;

  const roundTripFee = 2 * feeRate;
  const gridGap = feeMultiplier * roundTripFee;
  const liqDistance = 1 / leverage;
  const totalCapital = capitalPerSide * 2;
  const notionalPerSide = capitalPerSide * leverage;
  const maxGrids = Math.floor(liqDistance / gridGap);
  const gridSize = maxGrids > 0 ? notionalPerSide / maxGrids : notionalPerSide;
  const gridProfitPerRoundTrip = (gridSize * gridGap) - (gridSize * roundTripFee);

  const cycles: TandemCycle[] = [];
  let cumulativePnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  let i = 0;

  while (i < priceHistory.length - 1) {
    const entryPrice = priceHistory[i].price;
    const longLiqPrice = entryPrice * (1 - liqDistance);
    const shortLiqPrice = entryPrice * (1 + liqDistance);
    const posQty = notionalPerSide / entryPrice;

    const entryFees = notionalPerSide * feeRate * 2;
    let gridPnlLong = 0;
    let gridPnlShort = 0;

    const longOpenBuys = new Set<number>();
    const shortOpenSells = new Set<number>();
    let liquidatedSide: "LONG" | "SHORT" | null = null;
    let liquidationPrice = 0;
    let prevPrice = entryPrice;

    i++;

    while (i < priceHistory.length) {
      const price = priceHistory[i].price;

      if (price <= longLiqPrice) {
        liquidatedSide = "LONG";
        liquidationPrice = price;
        break;
      }
      if (price >= shortLiqPrice) {
        liquidatedSide = "SHORT";
        liquidationPrice = price;
        break;
      }

      const longGridIdx = Math.max(0, Math.floor((entryPrice - price) / (entryPrice * gridGap)));
      const shortGridIdx = Math.max(0, Math.floor((price - entryPrice) / (entryPrice * gridGap)));
      const prevLongIdx = Math.max(0, Math.floor((entryPrice - prevPrice) / (entryPrice * gridGap)));
      const prevShortIdx = Math.max(0, Math.floor((prevPrice - entryPrice) / (entryPrice * gridGap)));

      if (longGridIdx > prevLongIdx) {
        for (let g = prevLongIdx + 1; g <= Math.min(longGridIdx, maxGrids); g++) {
          if (!longOpenBuys.has(g)) {
            longOpenBuys.add(g);
            gridPnlLong -= gridSize * feeRate;
          }
        }
      } else if (longGridIdx < prevLongIdx) {
        for (let g = prevLongIdx; g > longGridIdx && g > 0; g--) {
          if (longOpenBuys.has(g)) {
            longOpenBuys.delete(g);
            gridPnlLong += gridProfitPerRoundTrip;
          }
        }
      }

      if (shortGridIdx > prevShortIdx) {
        for (let g = prevShortIdx + 1; g <= Math.min(shortGridIdx, maxGrids); g++) {
          if (!shortOpenSells.has(g)) {
            shortOpenSells.add(g);
            gridPnlShort -= gridSize * feeRate;
          }
        }
      } else if (shortGridIdx < prevShortIdx) {
        for (let g = prevShortIdx; g > shortGridIdx && g > 0; g--) {
          if (shortOpenSells.has(g)) {
            shortOpenSells.delete(g);
            gridPnlShort += gridProfitPerRoundTrip;
          }
        }
      }

      prevPrice = price;
      i++;
    }

    if (!liquidatedSide || i >= priceHistory.length) break;

    const liquidationLoss = capitalPerSide;

    const survivingSide = liquidatedSide === "LONG" ? "SHORT" : "LONG";
    const direction = survivingSide === "LONG" ? 1 : -1;

    const tandemReservePct = 0.1;
    const tpSoldQty = posQty * (1 - tandemReservePct);
    const tpSoldPnl = tpSoldQty * Math.abs(liquidationPrice - entryPrice) * 0.5 - tpSoldQty * entryPrice * roundTripFee;

    const cascadeExits: TandemCycle["cascadeExits"] = [];
    let cascadePnl = tpSoldPnl;
    let remainingQty = posQty * tandemReservePct;
    const portions = [3 / 7, 2 / 7, 1 / 7];
    const targetPcts = [0, 0.01, 0.02];
    const TOTAL_STEPS = 3;
    const TRAILING_PULLBACK_SIM = 0.003;
    let cascadeStep = 0;
    const cascadeStartPrice = liquidationPrice;
    let highWatermark = liquidationPrice;

    const survivorLiqPrice = survivingSide === "LONG" ? longLiqPrice : shortLiqPrice;

    i++;
    while (i < priceHistory.length && remainingQty > 0) {
      const price = priceHistory[i].price;

      const survivorLiquidated = survivingSide === "LONG"
        ? price <= survivorLiqPrice
        : price >= survivorLiqPrice;

      if (survivorLiquidated) {
        cascadePnl -= capitalPerSide;
        cascadeExits.push({ percent: -2, price, pnl: -capitalPerSide });
        remainingQty = 0;
        i++;
        break;
      }

      const profitPerUnit = direction * (price - entryPrice);

      if (survivingSide === "LONG") {
        highWatermark = Math.max(highWatermark, price);
      } else {
        highWatermark = Math.min(highWatermark, price);
      }

      const moveBeyondLiq = survivingSide === "LONG"
        ? (price - cascadeStartPrice) / cascadeStartPrice
        : (cascadeStartPrice - price) / cascadeStartPrice;

      if (cascadeStep > 0 && moveBeyondLiq < 0) {
        const bailPnl = profitPerUnit * remainingQty - remainingQty * price * feeRate;
        cascadePnl += bailPnl;
        cascadeExits.push({ percent: -3, price, pnl: bailPnl });
        remainingQty = 0;
        i++;
        break;
      }

      if (cascadeStep < TOTAL_STEPS) {
        if (moveBeyondLiq >= targetPcts[cascadeStep]) {
          const sellQty = posQty * portions[cascadeStep];
          const exitPnl = profitPerUnit * sellQty - sellQty * price * feeRate;
          cascadePnl += exitPnl;
          remainingQty -= sellQty;
          cascadeExits.push({ percent: cascadeStep + 1, price, pnl: exitPnl });
          cascadeStep++;
          if (cascadeStep >= TOTAL_STEPS) {
            highWatermark = price;
          }
        }
      }

      if (cascadeStep >= TOTAL_STEPS) {
        if (moveBeyondLiq < 0) {
          const bailPnl = profitPerUnit * remainingQty - remainingQty * price * feeRate;
          cascadePnl += bailPnl;
          cascadeExits.push({ percent: -3, price, pnl: bailPnl });
          remainingQty = 0;
          i++;
          break;
        }

        const trailingDrop = survivingSide === "LONG"
          ? (highWatermark - price) / highWatermark
          : (price - highWatermark) / highWatermark;

        if (trailingDrop >= TRAILING_PULLBACK_SIM) {
          const profitPerUnitNow = direction * (price - entryPrice);
          const exitPnl = profitPerUnitNow * remainingQty - remainingQty * price * feeRate;
          cascadePnl += exitPnl;
          cascadeExits.push({ percent: -1, price, pnl: exitPnl });
          remainingQty = 0;
          break;
        }
      }

      i++;
    }

    if (remainingQty > 0 && i >= priceHistory.length) {
      const lastPrice = priceHistory[priceHistory.length - 1].price;
      const profitPerUnit = direction * (lastPrice - entryPrice);
      const exitPnl = profitPerUnit * remainingQty - remainingQty * lastPrice * feeRate;
      cascadePnl += exitPnl;
      cascadeExits.push({ percent: 0, price: lastPrice, pnl: exitPnl });
      remainingQty = 0;
    }

    const cyclePnl = gridPnlLong + gridPnlShort + cascadePnl - liquidationLoss - entryFees;
    cumulativePnl += cyclePnl;

    peakPnl = Math.max(peakPnl, cumulativePnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumulativePnl);

    cycles.push({
      cycleNum: cycles.length + 1,
      entryPrice,
      liquidatedSide,
      liquidationPrice,
      gridPnlLong,
      gridPnlShort,
      cascadePnl,
      liquidationLoss: liquidationLoss + entryFees,
      cyclePnl,
      cascadeExits,
    });
  }

  return {
    symbol: "",
    leverage,
    startPrice: priceHistory[0].price,
    endPrice: priceHistory[priceHistory.length - 1].price,
    totalCycles: cycles.length,
    totalPnl: cumulativePnl,
    totalGridPnl: cycles.reduce((s, c) => s + c.gridPnlLong + c.gridPnlShort, 0),
    totalCascadePnl: cycles.reduce((s, c) => s + c.cascadePnl, 0),
    totalLiquidationLoss: cycles.reduce((s, c) => s + c.liquidationLoss, 0),
    winCycles: cycles.filter(c => c.cyclePnl > 0).length,
    lossCycles: cycles.filter(c => c.cyclePnl <= 0).length,
    maxDrawdown,
    capitalUsed: totalCapital,
    roiPercent: totalCapital > 0 ? (cumulativePnl / totalCapital) * 100 : 0,
    cycles,
    pricePoints: priceHistory.length,
  };
}
