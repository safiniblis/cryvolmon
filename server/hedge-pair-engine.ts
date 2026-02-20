import { getBitunixClient } from "./bitunix";
import { storage } from "./storage";
import type { Strategy } from "@shared/schema";
import { priceFeed } from "./ws-price-feed";
import { getPairPrecision } from "./strategy-engine";

function roundQty(qty: number, precision: number): string {
  return qty.toFixed(precision);
}

function roundPrice(price: number, precision: number): string {
  return price.toFixed(precision);
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

export interface HedgePairConfig {
  leverage: number;
  capitalPerSide: number;
  phase: "entry" | "monitoring" | "trailing" | "done";
  entryPrice: number;
  longPositionId: string | null;
  shortPositionId: string | null;
  longQty: number;
  shortQty: number;
  liquidatedSide: "LONG" | "SHORT" | null;
  liquidationPrice: number;
  survivingSide: "LONG" | "SHORT" | null;
  survivingQty: number;
  slOrderId: string | null;
  trailingPct: number;
  trailingHwm: number;
  cycleCount: number;
  totalPnl: number;
  lastActionAt: number;
  autoRestart: boolean;
  cyclePnl: number;
}

export async function executeHedgePairStrategy(strategy: Strategy) {
  const client = getBitunixClient();
  if (!client) throw new Error("Bitunix client not configured");

  const config = strategy.config as HedgePairConfig;
  const tag = `Hedge ${strategy.id}`;

  switch (config.phase) {
    case "entry":
      await hedgePairEntry(strategy, config, client);
      break;
    case "monitoring":
      await hedgePairMonitor(strategy, config, client);
      break;
    case "trailing":
      await hedgePairTrailing(strategy, config, client);
      break;
    case "done":
      await hedgePairDone(strategy, config, client);
      break;
  }
}

async function hedgePairEntry(strategy: Strategy, config: HedgePairConfig, client: any) {
  const tag = `Hedge ${strategy.id}`;

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const precision = await getPairPrecision(strategy.symbol);
  let requestedLeverage = config.leverage || 100;

  try { await client.setMarginMode(strategy.symbol, "ISOLATION"); } catch (e: any) {
    console.log(`[${tag}] Margin mode note:`, e.message);
  }
  try { await client.setLeverage(strategy.symbol, requestedLeverage); } catch (e: any) {
    console.log(`[${tag}] Leverage note:`, e.message);
  }

  let actualLeverage = requestedLeverage;
  try {
    const levRes = await client.getLeverageMarginMode(strategy.symbol);
    if (levRes?.code === 0 && levRes.data) {
      const reportedLev = parseInt(levRes.data.leverage || levRes.data.longLeverage || "0");
      if (reportedLev > 0) {
        actualLeverage = reportedLev;
        if (actualLeverage !== requestedLeverage) {
          console.log(`[${tag}] Exchange capped leverage: requested ${requestedLeverage}x, got ${actualLeverage}x`);
        }
      }
    }
  } catch (e: any) {
    console.log(`[${tag}] Could not verify leverage, using requested ${requestedLeverage}x`);
  }

  const leverage = actualLeverage;
  const capitalPerSide = config.capitalPerSide || 2;
  const notional = capitalPerSide * leverage;
  const qty = notional / currentPrice;
  const qtyStr = roundQty(qty, precision.basePrecision);
  console.log(`[${tag}] Capital calc: capitalPerSide=${capitalPerSide}, leverage=${leverage}x, notional=${notional.toFixed(2)}, qty=${qtyStr}, margin≈$${(parseFloat(qtyStr) * currentPrice / leverage).toFixed(4)}/side`);

  if (actualLeverage !== requestedLeverage) {
    await storage.updateStrategy(strategy.id, {
      config: { ...config, leverage: actualLeverage },
    });
  }

  console.log(`[${tag}] Opening LONG + SHORT: ${qtyStr} @ ${currentPrice.toFixed(precision.quotePrecision)}, ${leverage}x, $${capitalPerSide}/side`);

  let longOk = false, shortOk = false;

  try {
    const longResult = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: "BUY",
      tradeSide: "OPEN",
      orderType: "MARKET",
    });
    if (longResult?.code === 0) {
      longOk = true;
      console.log(`[${tag}] LONG opened: ${qtyStr}`);
    } else {
      console.error(`[${tag}] LONG failed:`, longResult?.msg);
    }
  } catch (e: any) {
    console.error(`[${tag}] LONG error:`, e.message);
  }

  try {
    const shortResult = await client.placeOrder({
      symbol: strategy.symbol,
      qty: qtyStr,
      side: "SELL",
      tradeSide: "OPEN",
      orderType: "MARKET",
    });
    if (shortResult?.code === 0) {
      shortOk = true;
      console.log(`[${tag}] SHORT opened: ${qtyStr}`);
    } else {
      console.error(`[${tag}] SHORT failed:`, shortResult?.msg);
    }
  } catch (e: any) {
    console.error(`[${tag}] SHORT error:`, e.message);
  }

  if (!longOk || !shortOk) {
    console.error(`[${tag}] Failed to open both sides, cleaning up`);
    if (longOk) {
      try { await client.placeOrder({ symbol: strategy.symbol, qty: qtyStr, side: "SELL", tradeSide: "CLOSE", orderType: "MARKET" }); } catch {}
    }
    if (shortOk) {
      try { await client.placeOrder({ symbol: strategy.symbol, qty: qtyStr, side: "BUY", tradeSide: "CLOSE", orderType: "MARKET" }); } catch {}
    }
    return;
  }

  await new Promise(r => setTimeout(r, 2000));

  const posRes = await client.getPositions(strategy.symbol);
  let longPosId = "", shortPosId = "", longEntryQty = 0, shortEntryQty = 0;
  if (posRes?.code === 0 && Array.isArray(posRes.data)) {
    const longPos = posRes.data.find((p: any) => p.side === "BUY" && parseFloat(p.qty || "0") > 0);
    const shortPos = posRes.data.find((p: any) => p.side === "SELL" && parseFloat(p.qty || "0") > 0);
    if (longPos) { longPosId = longPos.positionId; longEntryQty = parseFloat(longPos.qty); }
    if (shortPos) { shortPosId = shortPos.positionId; shortEntryQty = parseFloat(shortPos.qty); }
  }

  const updatedConfig: HedgePairConfig = {
    ...config,
    phase: "monitoring",
    entryPrice: currentPrice,
    longPositionId: longPosId,
    shortPositionId: shortPosId,
    longQty: longEntryQty || parseFloat(qtyStr),
    shortQty: shortEntryQty || parseFloat(qtyStr),
    liquidatedSide: null,
    liquidationPrice: 0,
    survivingSide: null,
    survivingQty: 0,
    slOrderId: null,
    trailingHwm: 0,
    trailingPct: config.trailingPct || 0.0033,
    cycleCount: (config.cycleCount || 0) + 1,
    cyclePnl: 0,
    lastActionAt: Date.now(),
  };

  await storage.updateStrategy(strategy.id, { config: updatedConfig });
  await storage.createTradeLog({
    strategyId: strategy.id, symbol: strategy.symbol, side: "BOTH",
    orderType: "MARKET", quantity: parseFloat(qtyStr), price: currentPrice,
    status: "filled", orderId: null, pnl: 0,
    errorMsg: `Hedge pair cycle ${updatedConfig.cycleCount}: opened L+S @ ${currentPrice.toFixed(4)}, trailing SL ${(updatedConfig.trailingPct * 100).toFixed(2)}% (triggers at other side's liq)`,
  });

  console.log(`[${tag}] Cycle ${updatedConfig.cycleCount}: LONG=${longPosId} SHORT=${shortPosId} entry=${currentPrice.toFixed(4)}, trailing SL ${(updatedConfig.trailingPct * 100).toFixed(2)}% armed`);
}

async function hedgePairMonitor(strategy: Strategy, config: HedgePairConfig, client: any) {
  const tag = `Hedge ${strategy.id}`;
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const longPos = posRes.data.find((p: any) => p.side === "BUY" && parseFloat(p.qty || "0") > 0);
  const shortPos = posRes.data.find((p: any) => p.side === "SELL" && parseFloat(p.qty || "0") > 0);

  const longAlive = !!longPos;
  const shortAlive = !!shortPos;

  if (longAlive && shortAlive) {
    return;
  }

  if (!longAlive && !shortAlive) {
    console.log(`[${tag}] Both sides liquidated — marking cycle done`);
    const updatedConfig: HedgePairConfig = {
      ...config,
      phase: "done",
      liquidatedSide: null,
      cyclePnl: -(config.capitalPerSide * 2),
      lastActionAt: Date.now(),
    };
    updatedConfig.totalPnl = (config.totalPnl || 0) + updatedConfig.cyclePnl;
    await storage.updateStrategy(strategy.id, { config: updatedConfig });
    return;
  }

  const liquidatedSide: "LONG" | "SHORT" = longAlive ? "SHORT" : "LONG";
  const survivingSide: "LONG" | "SHORT" = longAlive ? "LONG" : "SHORT";
  const survivorPos = longAlive ? longPos : shortPos;
  const survivingQty = parseFloat(survivorPos.qty || "0");

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;

  const liqDist = 1 / config.leverage;
  const liquidationPrice = liquidatedSide === "SHORT"
    ? config.entryPrice * (1 + liqDist)
    : config.entryPrice * (1 - liqDist);

  console.log(`[${tag}] ${liquidatedSide} liquidated! Survivor: ${survivingSide} qty=${survivingQty} @ ${currentPrice.toFixed(4)}, trailing SL armed`);

  const updatedConfig: HedgePairConfig = {
    ...config,
    phase: "trailing",
    liquidatedSide,
    liquidationPrice,
    survivingSide,
    survivingQty,
    slOrderId: null,
    trailingHwm: currentPrice,
    cyclePnl: -config.capitalPerSide,
    lastActionAt: Date.now(),
  };

  await storage.updateStrategy(strategy.id, { config: updatedConfig });
  await storage.createTradeLog({
    strategyId: strategy.id, symbol: strategy.symbol,
    side: liquidatedSide === "LONG" ? "BUY" : "SELL",
    orderType: "MARKET", quantity: 0, price: liquidationPrice,
    status: "filled", orderId: null, pnl: -config.capitalPerSide,
    errorMsg: `Hedge ${liquidatedSide} liquidated, trailing SL ${((config.trailingPct || 0.0033) * 100).toFixed(2)}% active on ${survivingSide}`,
  });
}

async function hedgePairTrailing(strategy: Strategy, config: HedgePairConfig, client: any) {
  const tag = `Hedge ${strategy.id}`;
  const posRes = await client.getPositions(strategy.symbol);
  if (posRes?.code !== 0 || !Array.isArray(posRes.data)) return;

  const posSide = config.survivingSide === "LONG" ? "BUY" : "SELL";
  const survivorPos = posRes.data.find((p: any) => p.side === posSide && parseFloat(p.qty || "0") > 0);

  if (!survivorPos) {
    console.log(`[${tag}] Survivor position closed (trailing SL hit)`);

    const ticker = await getTickerPrice(strategy.symbol);
    const exitPrice = ticker?.lastPrice || config.liquidationPrice;
    const direction = config.survivingSide === "LONG" ? 1 : -1;
    const pnlFromSurvivor = config.survivingQty * (exitPrice - config.entryPrice) * direction;
    const netPnl = pnlFromSurvivor - config.capitalPerSide;

    const updatedConfig: HedgePairConfig = {
      ...config,
      phase: "done",
      cyclePnl: netPnl,
      lastActionAt: Date.now(),
    };
    updatedConfig.totalPnl = (config.totalPnl || 0) + netPnl;

    await storage.updateStrategy(strategy.id, { config: updatedConfig });
    await storage.createTradeLog({
      strategyId: strategy.id, symbol: strategy.symbol, side: posSide,
      orderType: "MARKET", quantity: config.survivingQty, price: exitPrice,
      status: "filled", orderId: null, pnl: netPnl,
      errorMsg: `Hedge cycle ${config.cycleCount} complete: net=${netPnl > 0 ? "+" : ""}${netPnl.toFixed(4)}`,
    });
    return;
  }

  const ticker = await getTickerPrice(strategy.symbol);
  if (!ticker) return;
  const currentPrice = ticker.lastPrice;
  const precision = await getPairPrecision(strategy.symbol);
  const trailingPct = config.trailingPct || 0.0033;
  const isLong = config.survivingSide === "LONG";

  let hwm = config.trailingHwm || currentPrice;
  let hwmUpdated = false;
  if (isLong && currentPrice > hwm) {
    hwm = currentPrice;
    hwmUpdated = true;
  } else if (!isLong && currentPrice < hwm) {
    hwm = currentPrice;
    hwmUpdated = true;
  }

  const slPrice = isLong
    ? hwm * (1 - trailingPct)
    : hwm * (1 + trailingPct);
  const slPriceStr = roundPrice(slPrice, precision.quotePrecision);

  const profitPct = isLong
    ? (currentPrice - config.entryPrice) / config.entryPrice
    : (config.entryPrice - currentPrice) / config.entryPrice;

  if (hwmUpdated || !config.slOrderId) {
    if (config.slOrderId) {
      try {
        await client.cancelTpslOrder(strategy.symbol, config.slOrderId);
      } catch (e: any) {
        console.log(`[${tag}] Old trailing SL cancel note:`, e.message);
      }
    }

    try {
      const positionId = survivorPos.positionId;
      const result = await client.placeTpslOrder({
        symbol: strategy.symbol,
        positionId,
        slPrice: slPriceStr,
        slStopType: "LAST_PRICE",
        slOrderType: "MARKET",
      });
      if (result?.code === 0) {
        const newSlId = result.data?.orderId || "";
        console.log(`[${tag}] Trailing SL ${hwmUpdated ? "updated" : "placed"}: HWM=${hwm.toFixed(4)} SL=${slPriceStr} profit=${(profitPct * 100).toFixed(2)}%`);

        await storage.updateStrategy(strategy.id, {
          config: { ...config, trailingHwm: hwm, slOrderId: newSlId, lastActionAt: Date.now() },
        });
      } else {
        console.error(`[${tag}] Trailing SL failed:`, result?.msg);
      }
    } catch (e: any) {
      console.error(`[${tag}] Trailing SL error:`, e.message);
    }
  } else if (hwm !== config.trailingHwm) {
    await storage.updateStrategy(strategy.id, {
      config: { ...config, trailingHwm: hwm, lastActionAt: Date.now() },
    });
  }
}

async function hedgePairDone(strategy: Strategy, config: HedgePairConfig, client: any) {
  const tag = `Hedge ${strategy.id}`;

  if (config.autoRestart) {
    const cooldown = Date.now() - (config.lastActionAt || 0);
    if (cooldown < 5000) return;

    console.log(`[${tag}] Cycle ${config.cycleCount} done (PnL: ${(config.cyclePnl || 0).toFixed(4)}). Auto-restarting...`);

    const freshConfig: HedgePairConfig = {
      ...config,
      phase: "entry",
      entryPrice: 0,
      longPositionId: null,
      shortPositionId: null,
      longQty: 0,
      shortQty: 0,
      liquidatedSide: null,
      liquidationPrice: 0,
      survivingSide: null,
      survivingQty: 0,
      slOrderId: null,
      trailingHwm: 0,
      cyclePnl: 0,
      lastActionAt: Date.now(),
    };
    await storage.updateStrategy(strategy.id, { config: freshConfig });
  } else {
    console.log(`[${tag}] Cycle ${config.cycleCount} done. Auto-restart disabled, stopping.`);
    await storage.updateStrategy(strategy.id, { status: "stopped" });
  }
}
