import { useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import {
  useConnectionStatus,
  useAccount,
  useStrategies,
  useStartStrategy,
  useStopStrategy,
  useDeleteStrategy,
  useTradeLogs,
  useVolatilityScores,
  useSimulation,
  useQuickStart,
  useAddMargin,
  useRemoveMargin,
  useMarginInfo,
  useExtendOrders,
  useUpdateStrategyConfig,
  useManualRotation,
  useTandemSimulation,
} from "@/hooks/use-trading";
import {
  Bot, Play, Square, Trash2, Wifi, WifiOff,
  DollarSign, Activity,
  AlertTriangle, ArrowRight, Zap,
  BarChart3, RotateCcw, Shield, PlusCircle, MinusCircle, Loader2, ArrowDownToLine,
  RefreshCw, ArrowUpDown,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

type Strategy = {
  id: number;
  name: string;
  type: string;
  symbol: string;
  side: string;
  status: string;
  config: Record<string, any> | null;
  totalPnl: number | null;
  totalTrades: number | null;
  createdAt: string | null;
  lastRunAt: string | null;
};

function ConnectionBanner() {
  const { data } = useConnectionStatus();
  const connected = data?.connected;

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${connected ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}`}>
      {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {connected ? "Connected" : "Disconnected"}
    </div>
  );
}

function AccountOverview() {
  const { data, isLoading } = useAccount();

  if (isLoading) {
    return <div className="h-20 animate-pulse bg-card/30 rounded-xl" />;
  }

  if (!data?.connected) {
    return (
      <Card className="bg-card/40 border-border/50">
        <CardContent className="p-4 text-center">
          <WifiOff className="h-6 w-6 mx-auto text-muted-foreground mb-1" />
          <p className="text-sm text-muted-foreground">Connect API keys to see account</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {data.balances.map((b: any, i: number) => (
        <Card key={i} className="bg-card/40 border-border/50">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{b.currency}</p>
            <div className="text-xl font-bold font-mono" data-testid={`text-balance-${b.currency}`}>
              {formatCurrency(b.total)}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Avail: {formatCurrency(b.available)} | Frozen: {formatCurrency(b.frozen)}
            </p>
          </CardContent>
        </Card>
      ))}
      {data.balances.length === 0 && (
        <Card className="bg-card/40 border-border/50 col-span-3">
          <CardContent className="p-4 text-center">
            <AlertTriangle className="h-5 w-5 mx-auto text-yellow-400 mb-1" />
            <p className="text-xs text-muted-foreground">No balance. Transfer USDT to your Bitunix futures wallet.</p>
          </CardContent>
        </Card>
      )}
      {data.balances.length > 0 && data.balances[0]?.available < 10 && (
        <Card className="bg-yellow-500/5 border-yellow-500/20 col-span-3">
          <CardContent className="p-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-400 flex-shrink-0" />
            <p className="text-xs text-yellow-400">Low balance: {formatCurrency(data.balances[0]?.available)} USDT available</p>
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
    return <div className="text-center py-6 text-sm text-muted-foreground">No open positions</div>;
  }

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <div className="min-w-[500px] sm:min-w-0 px-4 sm:px-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border/40">
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">PnL</TableHead>
              <TableHead className="text-right">Lev</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p: any, i: number) => (
              <TableRow key={i} className="border-border/40">
                <TableCell className="font-bold text-xs" data-testid={`text-position-symbol-${i}`}>{p.symbol}</TableCell>
                <TableCell>
                  <Badge variant={p.side === "LONG" ? "default" : "destructive"} className="text-[10px]">{p.side}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{p.quantity}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatCurrency(p.entryPrice)}</TableCell>
                <TableCell className={`text-right font-mono text-xs font-bold ${(p.unrealizedPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {formatCurrency(p.unrealizedPnl || 0)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{p.leverage}x</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GapModifiers({ strategy }: { strategy: Strategy }) {
  const cfg = (strategy.config || {}) as Record<string, any>;
  const [gapBelow, setGapBelow] = useState(String(cfg.gapGrowthBelow || 1.05));
  const [gapAbove, setGapAbove] = useState(String(cfg.gapShrinkAbove || 1.05));
  const updateConfig = useUpdateStrategyConfig();

  const handleSave = () => {
    updateConfig.mutate({
      id: strategy.id,
      config: {
        gapGrowthBelow: parseFloat(gapBelow),
        gapShrinkAbove: parseFloat(gapAbove),
      },
    });
  };

  return (
    <div className="mt-3 p-2 rounded border border-border/20 bg-card/20">
      <p className="text-[10px] text-muted-foreground mb-1.5">Gap Modifiers</p>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Below:</span>
          <Input
            value={gapBelow}
            onChange={e => setGapBelow(e.target.value)}
            className="w-16 text-xs font-mono"
            data-testid={`input-gap-below-${strategy.id}`}
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Above:</span>
          <Input
            value={gapAbove}
            onChange={e => setGapAbove(e.target.value)}
            className="w-16 text-xs font-mono"
            data-testid={`input-gap-above-${strategy.id}`}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={updateConfig.isPending}
          data-testid={`button-save-gaps-${strategy.id}`}
        >
          {updateConfig.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

function MarginControls({ strategy }: { strategy: Strategy }) {
  const [addAmount, setAddAmount] = useState("10");
  const [removeCount, setRemoveCount] = useState("1");
  const addMargin = useAddMargin();
  const removeMargin = useRemoveMargin();
  const extendOrders = useExtendOrders();
  const { data: marginInfo } = useMarginInfo(strategy.id, true);

  return (
    <div className="mt-3 p-2 rounded border border-border/20 bg-card/20">
      <p className="text-[10px] text-muted-foreground mb-1.5">Margin Controls</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            type="number"
            min="1"
            value={addAmount}
            onChange={e => setAddAmount(e.target.value)}
            className="w-20 text-xs font-mono"
            placeholder="USDT"
            data-testid={`input-add-margin-${strategy.id}`}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={addMargin.isPending || !addAmount}
            onClick={() => addMargin.mutate({ id: strategy.id, amount: parseFloat(addAmount) })}
            data-testid={`button-add-margin-${strategy.id}`}
          >
            {addMargin.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <PlusCircle className="h-3 w-3 mr-1" />}
            Add
          </Button>
          {marginInfo?.needsExtension && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => extendOrders.mutate(strategy.id)}
              disabled={extendOrders.isPending}
              data-testid={`button-extend-${strategy.id}`}
            >
              {extendOrders.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ArrowDownToLine className="h-3 w-3 mr-1" />}
              Fill 1%
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            type="number"
            min="1"
            value={removeCount}
            onChange={e => setRemoveCount(e.target.value)}
            className="w-16 text-xs font-mono"
            placeholder="#"
            data-testid={`input-remove-count-${strategy.id}`}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={removeMargin.isPending || !removeCount || parseInt(removeCount) < 1}
            onClick={() => removeMargin.mutate({ id: strategy.id, count: parseInt(removeCount) })}
            data-testid={`button-remove-margin-${strategy.id}`}
          >
            {removeMargin.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <MinusCircle className="h-3 w-3 mr-1" />}
            Remove
          </Button>
          {marginInfo && marginInfo.removableOrders > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {marginInfo.removableOrders} removable (~${marginInfo.removableMargin.toFixed(2)})
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StrategyCard({ s }: { s: Strategy }) {
  const [expanded, setExpanded] = useState(false);
  const startStrategy = useStartStrategy();
  const stopStrategy = useStopStrategy();
  const deleteStrategy = useDeleteStrategy();
  const { data: accountData } = useAccount();
  const cfg = (s.config || {}) as Record<string, any>;

  const sideMap: Record<string, string[]> = { LONG: ["BUY", "LONG"], SHORT: ["SELL", "SHORT"], BOTH: ["BUY", "SELL", "LONG", "SHORT"] };
  const matchSides = sideMap[s.side?.toUpperCase()] || [s.side?.toUpperCase()];
  const position = accountData?.positions?.find((p: any) => p.symbol === s.symbol && matchSides.includes(p.side?.toUpperCase()));
  const unrealizedPnl = position?.unrealizedPnl || 0;
  const posLeverage = position?.leverage || cfg.leverage || 1;
  const margin = position?.entryPrice && position?.quantity
    ? (position.entryPrice * position.quantity) / posLeverage
    : 0;
  const pnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;
  const realizedPnl = s.totalPnl || 0;

  const gridParams = s.type === "grid" ? [
    { label: "Start", value: `$${Number(cfg.startPrice || 0).toFixed(2)}` },
    { label: "Lower", value: `$${Number(cfg.lowerPrice || 0).toFixed(2)}` },
    { label: "Upper", value: `$${Number(cfg.upperPrice || 0).toFixed(2)}` },
    { label: "Liq", value: `$${Number(cfg.liquidationPrice || 0).toFixed(2)}` },
    { label: "Grids", value: `${cfg.gridCount || 0} (${cfg.gridsBelow || 0}/${cfg.gridsAbove || 0})` },
    { label: "Leverage", value: `${cfg.leverage || 1}x` },
    { label: "Ratio", value: `${Number(cfg.gridRatio || 0).toFixed(4)}` },
    { label: "Per Grid", value: `$${cfg.amountPerGrid || 0}` },
    { label: "Gap", value: `${cfg.gapGrowthBelow || 1}x / ${cfg.gapShrinkAbove || 1}x` },
    { label: "TP Res", value: `${((cfg.tpReservePct ?? 0.10) * 100).toFixed(0)}%` },
    { label: "Rotation", value: cfg.rotationEnabled ? "On" : "Off" },
    ...(cfg.allocatedBudget ? [{ label: "Budget", value: `$${Number(cfg.allocatedBudget).toFixed(2)}` }] : []),
  ] : Object.entries(cfg).map(([key, val]) => ({ label: key, value: String(val) }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-border/40 bg-card/30 overflow-visible"
      data-testid={`card-strategy-${s.id}`}
    >
      <div
        className="p-3 cursor-pointer hover-elevate"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-${s.id}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.status === "running" ? "bg-emerald-400 animate-pulse" : s.status === "error" ? "bg-red-400" : "bg-muted-foreground"}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-sm text-foreground truncate">{s.symbol}</span>
                <Badge variant="outline" className="text-[10px]">{s.type.toUpperCase()}</Badge>
                {cfg.leverage && <span className="text-[10px] text-yellow-300 font-mono">{cfg.leverage}x</span>}
                {cfg.rotationEnabled && (
                  <Badge variant="secondary" className="text-[10px] bg-purple-500/20 text-purple-300 border-purple-500/30">
                    <RotateCcw className="h-2.5 w-2.5 mr-0.5" /> Rotate
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {s.status === "running" && (
              <div className="text-right" data-testid={`pnl-display-${s.id}`}>
                <div className={`text-xs font-mono font-bold ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {unrealizedPnl >= 0 ? "+" : ""}{formatCurrency(unrealizedPnl)}
                  <span className="ml-1 text-[10px]">({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)</span>
                </div>
                <div className={`text-[10px] font-mono ${realizedPnl >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}>
                  Real: {formatCurrency(realizedPnl)}
                </div>
              </div>
            )}
            {!s.status?.includes("running") && (
              <div className="text-right">
                <span className={`text-xs font-mono font-bold ${realizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {formatCurrency(realizedPnl)}
                </span>
                <div className="text-[10px] text-muted-foreground">{s.totalTrades || 0} trades</div>
              </div>
            )}
            <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
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
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/30">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 mt-2">
            {gridParams.map(p => (
              <div key={p.label} className="p-1.5 rounded border border-border/20 bg-card/20" data-testid={`param-${s.id}-${p.label.toLowerCase().replace(/\s/g, "-")}`}>
                <p className="text-[9px] text-muted-foreground">{p.label}</p>
                <p className="font-mono text-[11px] font-semibold text-foreground">{p.value}</p>
              </div>
            ))}
          </div>
          {s.type === "grid" && s.status === "running" && (
            <>
              <GapModifiers strategy={s} />
              <MarginControls strategy={s} />
            </>
          )}
          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground flex-wrap gap-1">
            <span>Created: {s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}</span>
            <span>Last: {s.lastRunAt ? (() => {
              const ago = Math.round((Date.now() - new Date(s.lastRunAt).getTime()) / 1000);
              if (ago < 60) return `${ago}s ago`;
              if (ago < 3600) return `${Math.round(ago / 60)}m ago`;
              return new Date(s.lastRunAt).toLocaleString();
            })() : "Never"}</span>
            <Badge variant={s.status === "running" ? "default" : s.status === "error" ? "destructive" : "outline"} className="text-[10px]">
              {s.status}
            </Badge>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function StrategiesList() {
  const { data: strategies, isLoading } = useStrategies();

  if (isLoading) {
    return <div className="space-y-2">{[...Array(2)].map((_, i) => <div key={i} className="h-16 animate-pulse bg-card/30 rounded-lg" />)}</div>;
  }

  if (!strategies || strategies.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Bot className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No strategies yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {strategies.map((s) => (
        <StrategyCard key={s.id} s={s} />
      ))}
    </div>
  );
}

function TradeHistory() {
  const { data: trades, isLoading } = useTradeLogs();

  if (isLoading) {
    return <div className="space-y-1">{[...Array(3)].map((_, i) => <div key={i} className="h-10 animate-pulse bg-card/30 rounded" />)}</div>;
  }

  if (!trades || trades.length === 0) {
    return <div className="text-center py-6 text-sm text-muted-foreground">No trades yet</div>;
  }

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <div className="min-w-[480px] sm:min-w-0 px-4 sm:px-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border/40">
              <TableHead className="text-xs">Time</TableHead>
              <TableHead className="text-xs">Symbol</TableHead>
              <TableHead className="text-xs">Side</TableHead>
              <TableHead className="text-xs text-right">Qty</TableHead>
              <TableHead className="text-xs text-right">Price</TableHead>
              <TableHead className="text-xs">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.map((t) => (
              <TableRow key={t.id} className="border-border/40" data-testid={`row-trade-${t.id}`}>
                <TableCell className="text-[10px] text-muted-foreground font-mono">
                  {t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : "--"}
                </TableCell>
                <TableCell className="font-bold text-xs">{t.symbol}</TableCell>
                <TableCell>
                  <Badge variant={t.side === "BUY" ? "default" : "destructive"} className="text-[10px]">{t.side}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{t.quantity}</TableCell>
                <TableCell className="text-right font-mono text-xs">{t.price ? formatCurrency(t.price) : "--"}</TableCell>
                <TableCell>
                  <Badge variant={t.status === "filled" ? "default" : t.status === "error" ? "destructive" : "outline"} className="text-[10px]">
                    {t.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function VolatilityScoresPanel() {
  const { data: scores, isLoading } = useVolatilityScores();
  const { data: strategies } = useStrategies();
  const manualRotation = useManualRotation();
  const quickStart = useQuickStart();
  const [amount, setAmount] = useState("40");
  const [startingSymbol, setStartingSymbol] = useState<string | null>(null);

  const runningStrategy = strategies?.find(s => s.status === "running" && s.type === "grid");
  const hasRunning = !!runningStrategy;

  const handleStart = (bitunixSymbol: string) => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    setStartingSymbol(bitunixSymbol);
    quickStart.mutate({ amount: val, symbol: bitunixSymbol }, {
      onSettled: () => setStartingSymbol(null),
    });
  };

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4 text-blue-400" />
          Volatility
        </CardTitle>
        {!hasRunning && (
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              data-testid="input-quickstart-amount"
              type="number"
              min="5"
              step="10"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-20 h-7 text-xs font-mono"
              placeholder="40"
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && <p className="text-xs text-muted-foreground p-3">Loading...</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/30">
                <th className="text-left p-2 text-muted-foreground font-medium">Pair</th>
                <th className="text-right p-2 text-muted-foreground font-medium">24h%</th>
                <th className="text-right p-2 text-muted-foreground font-medium">24h</th>
                <th className="text-right p-2 text-muted-foreground font-medium">4h</th>
                <th className="text-right p-2 text-muted-foreground font-medium">Risk</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {scores?.slice(0, 10).map(s => {
                const isActive = runningStrategy?.symbol === s.bitunixSymbol;
                const isStarting = startingSymbol === s.bitunixSymbol;
                return (
                  <tr key={s.symbol} className={`border-b border-border/10 ${isActive ? "bg-purple-500/10" : ""}`} data-testid={`vol-score-${s.symbol}`}>
                    <td className="p-2">
                      <span className="font-bold text-foreground uppercase">{s.symbol}</span>
                    </td>
                    <td className={`p-2 text-right font-mono ${s.priceChange24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {s.priceChange24h >= 0 ? "+" : ""}{s.priceChange24h.toFixed(1)}%
                    </td>
                    <td className="p-2 text-right font-mono text-foreground">{s.swings1to5}</td>
                    <td className="p-2 text-right font-mono text-foreground">{s.score4h}</td>
                    <td className="p-2 text-right font-mono text-muted-foreground">{s.riskGauge.toFixed(1)}</td>
                    <td className="p-2 text-right">
                      {hasRunning ? (
                        isActive ? (
                          <Badge variant="secondary" className="text-[9px] bg-purple-500/20 text-purple-300 border-purple-500/30">Active</Badge>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={manualRotation.isPending}
                            onClick={() => manualRotation.mutate({ id: runningStrategy.id, newSymbol: s.bitunixSymbol })}
                            data-testid={`button-rotate-${s.symbol}`}
                          >
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={quickStart.isPending || !amount || parseFloat(amount) <= 0}
                          onClick={() => handleStart(s.bitunixSymbol)}
                          data-testid={`button-start-${s.symbol}`}
                          className="h-7 px-2 text-xs text-purple-400"
                        >
                          {isStarting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <><Play className="h-3 w-3 mr-1" /> Start</>
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {scores && scores.length === 0 && (
          <p className="text-xs text-muted-foreground p-3">No data yet. Refresh dashboard first.</p>
        )}
      </CardContent>
    </Card>
  );
}

function SimulationPanel() {
  const simulation = useSimulation();
  const [simSymbol, setSimSymbol] = useState("");

  const handleSimulate = () => {
    simulation.mutate(simSymbol ? { symbol: simSymbol } : {});
  };

  const results = simulation.data;
  const isArray = Array.isArray(results);

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-yellow-400" />
          Backtest
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            data-testid="input-sim-symbol"
            placeholder="Symbol or all"
            value={simSymbol}
            onChange={e => setSimSymbol(e.target.value.toUpperCase())}
            className="w-28 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleSimulate}
            disabled={simulation.isPending}
            data-testid="button-run-simulation"
          >
            <Zap className="h-3 w-3 mr-1" />
            {simulation.isPending ? "..." : "Run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!results && !simulation.isPending && (
          <p className="text-xs text-muted-foreground">
            Run a backtest on 25h CoinGecko price data.
          </p>
        )}
        {isArray && (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <div className="min-w-[500px] sm:min-w-0 px-4 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Symbol</TableHead>
                    <TableHead className="text-xs text-right">Trades</TableHead>
                    <TableHead className="text-xs text-right">PnL</TableHead>
                    <TableHead className="text-xs text-right">DD</TableHead>
                    <TableHead className="text-xs text-right">Lev</TableHead>
                    <TableHead className="text-xs text-right">Grids</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((r: any) => (
                    <TableRow key={r.symbol} data-testid={`sim-row-${r.symbol}`}>
                      <TableCell className="font-bold text-xs">{r.symbol}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.totalTrades}</TableCell>
                      <TableCell className={`text-right font-mono text-xs font-bold ${r.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${r.totalPnl.toFixed(4)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-amber-400">${r.maxDrawdown.toFixed(4)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.leverage}x</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.gridCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        {results && !isArray && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Trades</p>
                <p className="font-mono text-xs font-bold" data-testid="text-sim-trades">{results.totalTrades}</p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">PnL</p>
                <p className={`font-mono text-xs font-bold ${results.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-sim-pnl">
                  ${results.totalPnl.toFixed(4)}
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Max DD</p>
                <p className="font-mono text-xs font-bold text-amber-400" data-testid="text-sim-dd">${results.maxDrawdown.toFixed(4)}</p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Range</p>
                <p className="font-mono text-[10px]" data-testid="text-sim-range">{results.priceRange}</p>
              </div>
            </div>
            {results.trades?.length > 0 && (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <div className="min-w-[400px] sm:min-w-0 px-4 sm:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Time</TableHead>
                        <TableHead className="text-xs">Side</TableHead>
                        <TableHead className="text-xs text-right">Price</TableHead>
                        <TableHead className="text-xs text-right">PnL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.trades.map((t: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="text-[10px] text-muted-foreground">{new Date(t.time).toLocaleTimeString()}</TableCell>
                          <TableCell>
                            <Badge variant={t.side === "BUY" ? "default" : "destructive"} className="text-[10px]">{t.side}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">${t.price.toFixed(2)}</TableCell>
                          <TableCell className={`text-right font-mono text-xs ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            ${t.pnl.toFixed(4)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TandemSimulationPanel() {
  const tandem = useTandemSimulation();
  const [tandemSymbol, setTandemSymbol] = useState("");
  const [tandemCapital, setTandemCapital] = useState("50");
  const [tandemLeverage, setTandemLeverage] = useState("100");
  const [tandemDays, setTandemDays] = useState("7");

  const handleRun = () => {
    const params: any = {};
    if (tandemSymbol) params.symbol = tandemSymbol;
    params.capitalPerSide = parseFloat(tandemCapital) || 50;
    params.leverage = parseInt(tandemLeverage) || 100;
    params.days = parseInt(tandemDays) || 7;
    tandem.mutate(params);
  };

  const results = tandem.data;
  const isArray = Array.isArray(results);

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-cyan-400" />
          Tandem L/S Sim
        </CardTitle>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Input
            data-testid="input-tandem-symbol"
            placeholder="Pair"
            value={tandemSymbol}
            onChange={e => setTandemSymbol(e.target.value.toUpperCase())}
            className="w-20 h-7 text-xs"
          />
          <Input
            data-testid="input-tandem-capital"
            type="number"
            value={tandemCapital}
            onChange={e => setTandemCapital(e.target.value)}
            className="w-16 h-7 text-xs font-mono"
            placeholder="$/side"
          />
          <div className="flex items-center gap-0.5">
            {[20, 33, 50, 100].map(lev => (
              <Button
                key={lev}
                size="sm"
                variant={tandemLeverage === String(lev) ? "default" : "ghost"}
                onClick={() => setTandemLeverage(String(lev))}
                data-testid={`button-tandem-lev-${lev}`}
                className="h-7 text-[10px] px-1.5 font-mono"
              >
                {lev}x
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            {[1, 3, 7].map(d => (
              <Button
                key={d}
                size="sm"
                variant={tandemDays === String(d) ? "default" : "ghost"}
                onClick={() => setTandemDays(String(d))}
                data-testid={`button-tandem-days-${d}`}
                className="h-7 text-[10px] px-1.5 font-mono"
              >
                {d}d
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRun}
            disabled={tandem.isPending}
            data-testid="button-run-tandem"
            className="h-7 text-xs"
          >
            <Zap className="h-3 w-3 mr-1" />
            {tandem.isPending ? "..." : "Run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!results && !tandem.isPending && (
          <p className="text-xs text-muted-foreground">
            {tandemDays}d window, {tandemLeverage}x leverage (liq at {(100 / parseInt(tandemLeverage || "100")).toFixed(1)}% move). Both sides open, one liquidates, survivor runs TP cascade (2/7, 2/7, 2/7, 1/7 trailing 0.5%).
          </p>
        )}
        {isArray && (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <div className="min-w-[500px] sm:min-w-0 px-4 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Symbol</TableHead>
                    <TableHead className="text-xs text-right">Cy</TableHead>
                    <TableHead className="text-xs text-right">Grid</TableHead>
                    <TableHead className="text-xs text-right">Casc</TableHead>
                    <TableHead className="text-xs text-right">PnL</TableHead>
                    <TableHead className="text-xs text-right">ROI</TableHead>
                    <TableHead className="text-xs text-right">W/L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((r: any) => (
                    <TableRow key={r.symbol} data-testid={`tandem-row-${r.symbol}`}>
                      <TableCell className="font-bold text-xs">{r.symbol}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.totalCycles}</TableCell>
                      <TableCell className={`text-right font-mono text-xs ${r.totalGridPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${r.totalGridPnl.toFixed(1)}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-xs ${r.totalCascadePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${r.totalCascadePnl.toFixed(1)}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-xs font-bold ${r.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${r.totalPnl.toFixed(2)}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-xs ${r.roiPercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {r.roiPercent.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        <span className="text-emerald-400">{r.winCycles}</span>/<span className="text-red-400">{r.lossCycles}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        {results && !isArray && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Cycles</p>
                <p className="font-mono text-xs font-bold" data-testid="text-tandem-cycles">{results.totalCycles}</p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Total PnL</p>
                <p className={`font-mono text-xs font-bold ${results.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-tandem-pnl">
                  ${results.totalPnl.toFixed(2)}
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">ROI</p>
                <p className={`font-mono text-xs font-bold ${results.roiPercent >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-tandem-roi">
                  {results.roiPercent.toFixed(1)}%
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Max DD</p>
                <p className="font-mono text-xs font-bold text-amber-400" data-testid="text-tandem-dd">${results.maxDrawdown.toFixed(2)}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Grid PnL</p>
                <p className={`font-mono text-xs ${results.totalGridPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ${results.totalGridPnl.toFixed(2)}
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Cascade PnL</p>
                <p className={`font-mono text-xs ${results.totalCascadePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ${results.totalCascadePnl.toFixed(2)}
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[9px] text-muted-foreground">Liq Losses</p>
                <p className="font-mono text-xs text-red-400">-${results.totalLiquidationLoss.toFixed(2)}</p>
              </div>
            </div>
            {results.cycles?.length > 0 && (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <p className="text-[10px] text-muted-foreground mb-1 px-4 sm:px-0">Cycle Details</p>
                <div className="min-w-[400px] sm:min-w-0 px-4 sm:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">#</TableHead>
                        <TableHead className="text-xs">Entry</TableHead>
                        <TableHead className="text-xs">Liq Side</TableHead>
                        <TableHead className="text-xs text-right">Grid</TableHead>
                        <TableHead className="text-xs text-right">Cascade</TableHead>
                        <TableHead className="text-xs text-right">Net</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.cycles.map((c: any) => (
                        <TableRow key={c.cycleNum}>
                          <TableCell className="text-xs font-mono">{c.cycleNum}</TableCell>
                          <TableCell className="text-xs font-mono">${c.entryPrice.toFixed(2)}</TableCell>
                          <TableCell>
                            <Badge variant={c.liquidatedSide === "LONG" ? "destructive" : "default"} className="text-[9px]">
                              {c.liquidatedSide}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-xs ${(c.gridPnlLong + c.gridPnlShort) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            ${(c.gridPnlLong + c.gridPnlShort).toFixed(2)}
                          </TableCell>
                          <TableCell className={`text-right font-mono text-xs ${c.cascadePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            ${c.cascadePnl.toFixed(2)}
                          </TableCell>
                          <TableCell className={`text-right font-mono text-xs font-bold ${c.cyclePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            ${c.cyclePnl.toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuickStartPanel() {
  return null;
}

export default function TradingPage() {
  return (
    <div className="min-h-screen w-full bg-[#0a0f1e] text-foreground p-3 sm:p-6 relative overflow-x-hidden">
      <div className="absolute top-0 left-0 w-full h-[300px] bg-gradient-to-b from-purple-900/10 to-transparent pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10 space-y-4">
        <header className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Bot className="h-6 w-6 text-purple-400" />
            <h1 className="text-xl font-extrabold text-foreground">Trading Agent</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <ConnectionBanner />
            <Link href="/">
              <Button variant="outline" size="sm" data-testid="link-dashboard">
                <ArrowRight className="h-3 w-3 mr-1" /> Dashboard
              </Button>
            </Link>
          </div>
        </header>

        <AccountOverview />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <Tabs defaultValue="strategies" className="w-full">
              <TabsList className="bg-muted/30 border border-border/40">
                <TabsTrigger value="strategies" data-testid="tab-strategies" className="text-xs">Strategies</TabsTrigger>
                <TabsTrigger value="positions" data-testid="tab-positions" className="text-xs">Positions</TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-history" className="text-xs">History</TabsTrigger>
              </TabsList>

              <TabsContent value="strategies" className="space-y-3 mt-3">
                <StrategiesList />
              </TabsContent>

              <TabsContent value="positions" className="mt-3">
                <Card className="bg-card/30 border-border/40">
                  <CardContent className="p-3">
                    <PositionsTable />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="history" className="mt-3">
                <Card className="bg-card/30 border-border/40">
                  <CardContent className="p-3">
                    <TradeHistory />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-4">
            <VolatilityScoresPanel />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SimulationPanel />
          <TandemSimulationPanel />
        </div>

        <footer className="pt-4 pb-4 text-center text-[10px] text-muted-foreground/40 font-mono">
          Automated trading involves significant risk.
        </footer>
      </div>
    </div>
  );
}
