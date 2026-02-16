import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";

async function fetchTop20CryptoData() {
  try {
    // 1. Fetch Top 20 by Market Cap with Sparkline (7 days)
    // sparkline_in_7d gives roughly hourly data (7 * 24 = 168 points)
    const marketsResponse = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true"
    );
    
    if (!marketsResponse.ok) {
      if (marketsResponse.status === 429) {
         console.warn("CoinGecko rate limit hit. Using cached data if available.");
         return []; // Return empty to avoid wiping cache if we have one
      }
      throw new Error(`CoinGecko API error: ${marketsResponse.statusText}`);
    }

    const markets = await marketsResponse.json();
    const results = [];

    for (const coin of markets) {
      const prices: number[] = coin.sparkline_in_7d?.price || [];
      
      // We want the last 24 hours. If we have ~168 points, take last 25.
      // 168 points / 7 days = 24 points per day. So it is hourly.
      
      let swings = 0;
      // Take last 25 points to get 24 intervals
      const recentPrices = prices.slice(-25);
      
      // Create chart data [timestamp, price]. 
      // We don't have exact timestamps in sparkline, so we simulate them relative to now.
      const now = Date.now();
      const priceHistory = recentPrices.map((price, index) => {
         // specific time doesn't matter much for sparkline visual, but let's approximate
         // index 0 is 24h ago, index 24 is now.
         const hoursAgo = recentPrices.length - 1 - index;
         return {
           timestamp: now - (hoursAgo * 60 * 60 * 1000),
           price: price
         };
      });

      for (let i = 1; i < recentPrices.length; i++) {
        const prevPrice = recentPrices[i-1];
        const currPrice = recentPrices[i];
        
        if (!prevPrice) continue; // Safety check
        
        const change = Math.abs((currPrice - prevPrice) / prevPrice);
        
        if (change >= 0.01) {
          swings++;
        }
      }

      results.push({
        slug: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        marketCap: coin.market_cap,
        currentPrice: coin.current_price,
        hourlySwings: swings,
        priceHistory: priceHistory,
      });
    }

    return results;
  } catch (error) {
    console.error("Error fetching crypto data:", error);
    throw error;
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Initial data fetch on startup (async, don't block server start)
  fetchTop20CryptoData().then(async (data) => {
    if (data.length > 0) {
      console.log(`Fetched data for ${data.length} coins`);
      await storage.updateCryptoStats(data);
    }
  }).catch(console.error);

  app.get("/api/stats", async (req, res) => {
    const stats = await storage.getCryptoStats();
    res.json(stats.sort((a, b) => (b.hourlySwings || 0) - (a.hourlySwings || 0)));
  });

  app.post("/api/stats/refresh", async (req, res) => {
    try {
      const data = await fetchTop20CryptoData();
      if (data.length > 0) {
        await storage.updateCryptoStats(data);
        res.json({ message: "Data refreshed successfully" });
      } else {
         res.status(429).json({ message: "Rate limit hit, please try again later" });
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to refresh data" });
    }
  });

  return httpServer;
}
