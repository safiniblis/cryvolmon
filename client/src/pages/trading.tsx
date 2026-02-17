import { useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Link } from "wouter";
import {
  useConnectionStatus,
  useAccount,
  useStrategies,
  useCreateStrategy,
  useStartStrategy,
  useStopStrategy,
  useDeleteStrategy,
  useTradeLogs,
  useManualTrade,
  useGridCalculator,
} from "@/hooks/use-trading";
import {
  Bot, Play, Square, Trash2, Plus, Wifi, WifiOff,
  TrendingUp, TrendingDown, DollarSign, Activity,
  AlertTriangle, ArrowRight, Calculator, Zap,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

function ConnectionBanner() {
  const { data } = useConnectionStatus();
  const connected = data?.connected;

  return (
    <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${connected ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}`}>
      {connected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
      {data?.message || "Checking connection..."}
    </div>
  );
}

function AccountOverview() {
  const { data, isLoading } = useAccount();

  if (isLoading) {
    return <div className="h-32 animate-pulse bg-card/30 rounded-xl" />;
  }

  if (!data?.connected) {
    return (
      <Card className="bg-card/40 border-border/50">
        <CardContent className="p-6 text-center">
          <WifiOff className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Connect your Bitunix API keys to see account data</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {data.balances.map((b: any, i: number) => (
        <Card key={i} className="bg-card/40 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{b.currency} Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono" data-testid={`text-balance-${b.currency}`}>
              {formatCurrency(b.total)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Available: {formatCurrency(b.available)} | Frozen: {formatCurrency(b.frozen)}
            </p>
          </CardContent>
        </Card>
      ))}
      {data.balances.length === 0 && (
        <Card className="bg-card/40 border-border/50 col-span-3">
          <CardContent className="p-6 text-center text-muted-foreground">
            No balance data available yet
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PositionsTable() {
  const { data } = useAccount();
  const positions = data?.positions || [];

  if (positions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No open positions
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border/40">
          <TableHead>Symbol</TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Entry Price</TableHead>
          <TableHead className="text-right">Mark Price</TableHead>
          <TableHead className="text-right">PnL</TableHead>
          <TableHead className="text-right">Leverage</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p: any, i: number) => (
          <TableRow key={i} className="border-border/40">
            <TableCell className="font-bold" data-testid={`text-position-symbol-${i}`}>{p.symbol}</TableCell>
            <TableCell>
              <Badge variant={p.side === "LONG" ? "default" : "destructive"}>
                {p.side}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-mono">{p.quantity}</TableCell>
            <TableCell className="text-right font-mono">{formatCurrency(p.entryPrice)}</TableCell>
            <TableCell className="text-right font-mono">{formatCurrency(p.markPrice)}</TableCell>
            <TableCell className={`text-right font-mono font-bold ${(p.unrealizedPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {formatCurrency(p.unrealizedPnl || 0)}
            </TableCell>
            <TableCell className="text-right font-mono">{p.leverage}x</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CreateStrategyDialog() {
  const [open, setOpen] = useState(false);
  const createStrategy = useCreateStrategy();
  const gridCalculator = useGridCalculator();
  const [type, setType] = useState("grid");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [side, setSide] = useState("LONG");

  // DCA config
  const [buyAmount, setBuyAmount] = useState("10");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [maxBuys, setMaxBuys] = useState("100");
  const [leverage, setLeverage] = useState("1");

  // Grid config
  const [amountPerGrid, setAmountPerGrid] = useState("10");
  const [feeRate, setFeeRate] = useState("0.06");
  const [gridCalc, setGridCalc] = useState<any>(null);

  // Momentum config
  const [threshold, setThreshold] = useState("2");
  const [amount, setAmount] = useState("10");
  const [cooldown, setCooldown] = useState("15");

  const handleCalculateGrid = () => {
    gridCalculator.mutate(
      { symbol, feeRate: parseFloat(feeRate) / 100 },
      { onSuccess: (data) => setGridCalc(data) }
    );
  };

  const handleSubmit = () => {
    let config: Record<string, any> = {};

    if (type === "dca") {
      config = {
        buyAmount: parseFloat(buyAmount),
        intervalMinutes: parseInt(intervalMinutes),
        maxBuys: parseInt(maxBuys),
        leverage: parseInt(leverage),
      };
    } else if (type === "grid") {
      if (!gridCalc) return;
      config = {
        upperPrice: gridCalc.upperPrice,
        lowerPrice: gridCalc.lowerPrice,
        liquidationPrice: gridCalc.liquidationPrice,
        gridCount: gridCalc.gridCount,
        amountPerGrid: parseFloat(amountPerGrid),
        leverage: gridCalc.leverage,
        geometric: true,
        gridRatio: gridCalc.gridRatio,
        gapGrowthBelow: gridCalc.gapGrowthBelow,
        gapShrinkAbove: gridCalc.gapShrinkAbove,
        startPrice: gridCalc.startPrice,
        gridsAbove: gridCalc.gridsAbove,
        gridsBelow: gridCalc.gridsBelow,
        extensionsBelow: 0,
        extensionsAbove: 0,
      };
    } else if (type === "momentum") {
      config = {
        threshold: parseFloat(threshold),
        amount: parseFloat(amount),
        leverage: parseInt(leverage),
        cooldownMinutes: parseInt(cooldown),
      };
    }

    createStrategy.mutate(
      { name: name || `${type.toUpperCase()} ${symbol}`, type, symbol, side, status: "stopped", config },
      { onSuccess: () => { setOpen(false); setGridCalc(null); } }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-create-strategy">
          <Plus className="h-4 w-4 mr-2" /> New Strategy
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg bg-[#0d1226] border-border/50 max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Trading Strategy</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label>Strategy Name</Label>
            <Input
              data-testid="input-strategy-name"
              placeholder="My Strategy"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger data-testid="select-strategy-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dca">DCA (Dollar Cost Avg)</SelectItem>
                  <SelectItem value="grid">Grid Trading</SelectItem>
                  <SelectItem value="momentum">Momentum</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Symbol</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger data-testid="select-symbol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BTCUSDT">BTC/USDT</SelectItem>
                  <SelectItem value="ETHUSDT">ETH/USDT</SelectItem>
                  <SelectItem value="SOLUSDT">SOL/USDT</SelectItem>
                  <SelectItem value="XRPUSDT">XRP/USDT</SelectItem>
                  <SelectItem value="DOGEUSDT">DOGE/USDT</SelectItem>
                  <SelectItem value="BNBUSDT">BNB/USDT</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Side</Label>
              <Select value={side} onValueChange={setSide}>
                <SelectTrigger data-testid="select-side">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LONG">Long</SelectItem>
                  <SelectItem value="SHORT">Short</SelectItem>
                  <SelectItem value="BOTH">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type !== "grid" && (
              <div className="space-y-2">
                <Label>Leverage</Label>
                <Input
                  data-testid="input-leverage"
                  type="number"
                  value={leverage}
                  onChange={(e) => setLeverage(e.target.value)}
                  min="1"
                  max="125"
                />
              </div>
            )}
          </div>

          <Separator />

          {type === "dca" && (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-muted-foreground">DCA Settings</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Buy Amount (USDT)</Label>
                  <Input
                    data-testid="input-buy-amount"
                    type="number"
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Interval (minutes)</Label>
                  <Input
                    data-testid="input-interval"
                    type="number"
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Max Buys</Label>
                <Input
                  data-testid="input-max-buys"
                  type="number"
                  value={maxBuys}
                  onChange={(e) => setMaxBuys(e.target.value)}
                />
              </div>
            </div>
          )}

          {type === "grid" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-yellow-400" />
                  Optimized Geometric Grid
                </h4>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">
                Range: -10% to +2%. Wider grids below (1.07x growth), tighter above (0.96x shrink). Max leverage, 2.5x fee profit.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Fee Rate (%)</Label>
                  <Input
                    data-testid="input-fee-rate"
                    type="number"
                    step="0.01"
                    value={feeRate}
                    onChange={(e) => { setFeeRate(e.target.value); setGridCalc(null); }}
                  />
                  <p className="text-[10px] text-muted-foreground">Taker fee per side (e.g. 0.06%)</p>
                </div>
                <div className="space-y-2">
                  <Label>Amount per Grid (USDT)</Label>
                  <Input
                    data-testid="input-amount-per-grid"
                    type="number"
                    value={amountPerGrid}
                    onChange={(e) => setAmountPerGrid(e.target.value)}
                  />
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full border-yellow-500/30 text-yellow-300 hover:text-yellow-200"
                onClick={handleCalculateGrid}
                disabled={gridCalculator.isPending}
                data-testid="button-calculate-grid"
              >
                <Calculator className="h-4 w-4 mr-2" />
                {gridCalculator.isPending ? "Calculating..." : "Calculate Optimal Grid"}
              </Button>

              {gridCalc && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 space-y-3"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="h-4 w-4 text-yellow-400" />
                    <span className="text-sm font-bold text-yellow-300">Grid Parameters</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Current Price</span>
                      <span className="font-mono font-bold">{formatCurrency(gridCalc.currentPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Leverage</span>
                      <span className="font-mono font-bold text-yellow-300">{gridCalc.leverage}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Upper (+2%)</span>
                      <span className="font-mono">{formatCurrency(gridCalc.upperPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Lower (-10%)</span>
                      <span className="font-mono text-orange-400">{formatCurrency(gridCalc.lowerPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Liquidation (-12%)</span>
                      <span className="font-mono text-red-400">{formatCurrency(gridCalc.liquidationPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Grid Count</span>
                      <span className="font-mono font-bold">{gridCalc.gridCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Grid Ratio</span>
                      <span className="font-mono">{((gridCalc.gridRatio - 1) * 100).toFixed(4)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Profit / Grid</span>
                      <span className="font-mono text-emerald-400">{(gridCalc.profitPerGrid * 100).toFixed(4)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Fee / Grid</span>
                      <span className="font-mono text-red-400">{(gridCalc.feePerGrid * 100).toFixed(4)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Net Profit / Grid</span>
                      <span className="font-mono text-emerald-400 font-bold">{(gridCalc.netProfitPerGrid * 100).toFixed(4)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Profit:Fee Ratio</span>
                      <span className="font-mono font-bold text-yellow-300">{gridCalc.profitToFeeRatio.toFixed(1)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Grids Above Price</span>
                      <span className="font-mono">{gridCalc.gridsAbove}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Grids Below Price</span>
                      <span className="font-mono">{gridCalc.gridsBelow}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground border-t border-border/30 pt-2 mt-2">
                    Asymmetric spacing: wider gaps below (1.07x), tighter above (0.96x). Fewer positions at lows = higher leverage. Extensions follow same scaling.
                  </p>
                </motion.div>
              )}
            </div>
          )}

          {type === "momentum" && (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-muted-foreground">Momentum Settings</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Threshold (%)</Label>
                  <Input
                    data-testid="input-threshold"
                    type="number"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Trade Amount (USDT)</Label>
                  <Input
                    data-testid="input-momentum-amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Cooldown (minutes)</Label>
                <Input
                  data-testid="input-cooldown"
                  type="number"
                  value={cooldown}
                  onChange={(e) => setCooldown(e.target.value)}
                />
              </div>
            </div>
          )}

          <Button
            data-testid="button-submit-strategy"
            className="w-full"
            onClick={handleSubmit}
            disabled={createStrategy.isPending || (type === "grid" && !gridCalc)}
          >
            {createStrategy.isPending ? "Creating..." : type === "grid" && !gridCalc ? "Calculate Grid First" : "Create Strategy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StrategiesList() {
  const { data: strategies, isLoading } = useStrategies();
  const startStrategy = useStartStrategy();
  const stopStrategy = useStopStrategy();
  const deleteStrategy = useDeleteStrategy();

  if (isLoading) {
    return <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-20 animate-pulse bg-card/30 rounded-lg" />)}</div>;
  }

  if (!strategies || strategies.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Bot className="h-12 w-12 mx-auto mb-3 opacity-30" />
        <p>No strategies yet. Create one to start automated trading.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {strategies.map((s) => (
        <motion.div
          key={s.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-lg border border-border/40 bg-card/30"
          data-testid={`card-strategy-${s.id}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${s.status === "running" ? "bg-emerald-400 animate-pulse" : s.status === "error" ? "bg-red-400" : "bg-muted-foreground"}`} />
              <div>
                <h3 className="font-bold text-foreground">{s.name}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Badge variant="outline" className="text-xs">{s.type.toUpperCase()}</Badge>
                  <span className="text-xs text-muted-foreground">{s.symbol}</span>
                  <span className="text-xs text-muted-foreground">{s.side}</span>
                  {s.type === "grid" && (s.config as any)?.leverage && (
                    <span className="text-xs text-yellow-300 font-mono">{(s.config as any).leverage}x</span>
                  )}
                  {s.type === "grid" && ((s.config as any)?.extensionsBelow > 0 || (s.config as any)?.extensionsAbove > 0) && (
                    <Badge variant="secondary" className="text-[10px] bg-blue-500/20 text-blue-300 border-blue-500/30">
                      Ext: {(s.config as any).extensionsBelow || 0}↓ {(s.config as any).extensionsAbove || 0}↑
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <div className="text-sm font-mono">
                  <span className={`font-bold ${(s.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {formatCurrency(s.totalPnl || 0)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{s.totalTrades || 0} trades</div>
              </div>
              <div className="flex items-center gap-1">
                {s.status === "running" ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => stopStrategy.mutate(s.id)}
                    disabled={stopStrategy.isPending}
                    data-testid={`button-stop-${s.id}`}
                  >
                    <Square className="h-4 w-4 text-red-400" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => startStrategy.mutate(s.id)}
                    disabled={startStrategy.isPending}
                    data-testid={`button-start-${s.id}`}
                  >
                    <Play className="h-4 w-4 text-emerald-400" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => deleteStrategy.mutate(s.id)}
                  disabled={deleteStrategy.isPending}
                  data-testid={`button-delete-${s.id}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function TradeHistory() {
  const { data: trades, isLoading } = useTradeLogs();

  if (isLoading) {
    return <div className="space-y-2">{[...Array(5)].map((_, i) => <div key={i} className="h-12 animate-pulse bg-card/30 rounded" />)}</div>;
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No trades executed yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border/40">
            <TableHead>Time</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => (
            <TableRow key={t.id} className="border-border/40" data-testid={`row-trade-${t.id}`}>
              <TableCell className="text-xs text-muted-foreground font-mono">
                {t.createdAt ? new Date(t.createdAt).toLocaleString() : "--"}
              </TableCell>
              <TableCell className="font-bold">{t.symbol}</TableCell>
              <TableCell>
                <Badge variant={t.side === "BUY" ? "default" : "destructive"}>
                  {t.side}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{t.orderType}</TableCell>
              <TableCell className="text-right font-mono">{t.quantity}</TableCell>
              <TableCell className="text-right font-mono">{t.price ? formatCurrency(t.price) : "--"}</TableCell>
              <TableCell>
                <Badge variant={t.status === "filled" ? "default" : t.status === "error" ? "destructive" : "outline"}>
                  {t.status}
                </Badge>
                {t.errorMsg && (
                  <span className="text-xs text-red-400 ml-2" title={t.errorMsg}>
                    <AlertTriangle className="h-3 w-3 inline" />
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ManualTradePanel() {
  const manualTrade = useManualTrade();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [side, setSide] = useState("BUY");
  const [quantity, setQuantity] = useState("10");
  const [leverage, setLeverage] = useState("1");

  const handleTrade = () => {
    manualTrade.mutate({
      symbol,
      side,
      quantity: parseFloat(quantity),
      orderType: "MARKET",
      leverage: parseInt(leverage),
    });
  };

  return (
    <Card className="bg-card/40 border-border/50">
      <CardHeader>
        <CardTitle className="text-lg">Quick Trade</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger data-testid="select-manual-symbol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BTCUSDT">BTC/USDT</SelectItem>
                <SelectItem value="ETHUSDT">ETH/USDT</SelectItem>
                <SelectItem value="SOLUSDT">SOL/USDT</SelectItem>
                <SelectItem value="XRPUSDT">XRP/USDT</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Leverage</Label>
            <Input
              data-testid="input-manual-leverage"
              type="number"
              value={leverage}
              onChange={(e) => setLeverage(e.target.value)}
              min="1"
              max="125"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Amount (USDT)</Label>
          <Input
            data-testid="input-manual-quantity"
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Button
            data-testid="button-buy"
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => { setSide("BUY"); handleTrade(); }}
            disabled={manualTrade.isPending}
          >
            <TrendingUp className="h-4 w-4 mr-1" /> Long
          </Button>
          <Button
            data-testid="button-sell"
            variant="destructive"
            onClick={() => { setSide("SELL"); handleTrade(); }}
            disabled={manualTrade.isPending}
          >
            <TrendingDown className="h-4 w-4 mr-1" /> Short
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center">
          <AlertTriangle className="h-3 w-3 inline mr-1" />
          Trading involves risk. Only trade what you can afford to lose.
        </p>
      </CardContent>
    </Card>
  );
}

export default function TradingPage() {
  return (
    <div className="min-h-screen w-full bg-[#0a0f1e] text-foreground p-4 md:p-8 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-purple-900/10 to-transparent pointer-events-none" />
      <div className="absolute -top-[100px] -right-[100px] w-[500px] h-[500px] bg-purple-500/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10 space-y-6">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <motion.h1
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-3xl md:text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-purple-100 to-white/50"
            >
              <Bot className="h-8 w-8 inline mr-2 text-purple-400" />
              Trading Agent
            </motion.h1>
            <p className="text-muted-foreground mt-1">Automated Bitunix Futures Trading</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <ConnectionBanner />
            <Link href="/">
              <Button variant="outline" data-testid="link-dashboard">
                <ArrowRight className="h-4 w-4 mr-1" /> Volatility Dashboard
              </Button>
            </Link>
          </div>
        </header>

        <AccountOverview />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Tabs defaultValue="strategies" className="w-full">
              <TabsList className="bg-muted/30 border border-border/40">
                <TabsTrigger value="strategies" data-testid="tab-strategies">Strategies</TabsTrigger>
                <TabsTrigger value="positions" data-testid="tab-positions">Positions</TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-history">Trade History</TabsTrigger>
              </TabsList>

              <TabsContent value="strategies" className="space-y-4 mt-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <span className="w-1 h-5 bg-purple-500 rounded-full block" />
                    My Strategies
                  </h2>
                  <CreateStrategyDialog />
                </div>
                <StrategiesList />
              </TabsContent>

              <TabsContent value="positions" className="mt-4">
                <Card className="bg-card/30 border-border/40">
                  <CardHeader>
                    <CardTitle className="text-lg">Open Positions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <PositionsTable />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="history" className="mt-4">
                <Card className="bg-card/30 border-border/40">
                  <CardHeader>
                    <CardTitle className="text-lg">Recent Trades</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TradeHistory />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-6">
            <ManualTradePanel />
          </div>
        </div>

        <footer className="pt-8 pb-6 text-center text-sm text-muted-foreground/40 font-mono">
          Automated trading involves significant risk. Past performance does not guarantee future results.
        </footer>
      </div>
    </div>
  );
}
