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
import { Link } from "wouter";
import {
  useConnectionStatus,
  useAccount,
  useStrategies,
  useStartStrategy,
  useStopStrategy,
  useDeleteStrategy,
  useTradeLogs,
  useBitunixPairs,
  useVolatilityScores,
  useSimulation,
  useQuickStart,
  useAddMargin,
  useRemoveMargin,
  useMarginInfo,
  useExtendOrders,
  useUpdateStrategyConfig,
} from "@/hooks/use-trading";
import { Switch } from "@/components/ui/switch";
import {
  Bot, Play, Square, Trash2, Plus, Wifi, WifiOff,
  TrendingUp, TrendingDown, DollarSign, Activity,
  AlertTriangle, ArrowRight, Zap,
  BarChart3, RotateCcw, Shield, PlusCircle, MinusCircle, Loader2, ArrowDownToLine,
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
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-6 w-6 mx-auto text-yellow-400 mb-2" />
            <p className="text-muted-foreground">No balance found in your Bitunix futures wallet.</p>
            <p className="text-xs text-muted-foreground mt-1">Transfer USDT from your spot wallet to your futures wallet on Bitunix to start trading.</p>
          </CardContent>
        </Card>
      )}
      {data.balances.length > 0 && data.balances[0]?.available < 10 && (
        <Card className="bg-yellow-500/5 border-yellow-500/20 col-span-3">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-400 flex-shrink-0" />
            <div>
              <p className="text-sm text-yellow-400 font-medium">Low balance warning</p>
              <p className="text-xs text-muted-foreground">You have {formatCurrency(data.balances[0]?.available)} USDT available. Orders are spread across grid levels using your full balance.</p>
            </div>
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

function GapModifiers({ strategy }: { strategy: Strategy }) {
  const cfg = (strategy.config || {}) as Record<string, any>;
  const [gapBelow, setGapBelow] = useState(String(cfg.gapGrowthBelow || 1.07));
  const [gapAbove, setGapAbove] = useState(String(cfg.gapShrinkAbove || 0.96));
  const updateConfig = useUpdateStrategyConfig();

  const handleSave = () => {
    const below = parseFloat(gapBelow);
    const above = parseFloat(gapAbove);
    if (isNaN(below) || isNaN(above) || below < 1 || above > 1 || above <= 0) return;
    updateConfig.mutate({ id: strategy.id, config: { gapGrowthBelow: below, gapShrinkAbove: above } });
  };

  const changed = parseFloat(gapBelow) !== (cfg.gapGrowthBelow || 1.07) || parseFloat(gapAbove) !== (cfg.gapShrinkAbove || 0.96);

  return (
    <div className="mt-3 p-3 rounded border border-border/30 bg-card/10">
      <p className="text-xs font-semibold text-muted-foreground mb-2">Grid Spacing Modifiers</p>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] text-muted-foreground whitespace-nowrap">Gap Below</Label>
          <Input
            type="number"
            min="1.00"
            max="2.00"
            step="0.01"
            value={gapBelow}
            onChange={(e) => setGapBelow(e.target.value)}
            className="w-20 text-xs"
            data-testid={`input-gap-below-${strategy.id}`}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] text-muted-foreground whitespace-nowrap">Gap Above</Label>
          <Input
            type="number"
            min="0.50"
            max="1.00"
            step="0.01"
            value={gapAbove}
            onChange={(e) => setGapAbove(e.target.value)}
            className="w-20 text-xs"
            data-testid={`input-gap-above-${strategy.id}`}
          />
        </div>
        {changed && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={updateConfig.isPending}
            data-testid={`button-save-gaps-${strategy.id}`}
          >
            {updateConfig.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Save
          </Button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mt-1.5">
        Below: wider grids downward ({">"} 1.0). Above: tighter grids upward ({"<"} 1.0). Applied next cycle.
      </p>
    </div>
  );
}

function MarginControls({ strategy }: { strategy: Strategy }) {
  const [addAmount, setAddAmount] = useState("1");
  const [removeCount, setRemoveCount] = useState("1");
  const addMargin = useAddMargin();
  const removeMargin = useRemoveMargin();
  const extendOrders = useExtendOrders();
  const { data: marginInfo } = useMarginInfo(strategy.id, strategy.status === "running" && strategy.type === "grid");

  return (
    <div className="mt-3 p-3 rounded border border-border/30 bg-card/10">
      <p className="text-xs font-semibold text-muted-foreground mb-2">Margin Controls</p>
      {marginInfo && (
        <div className="flex items-center gap-3 mb-2 text-[10px] text-muted-foreground flex-wrap">
          <span>Price: ${marginInfo.currentPrice.toFixed(3)}</span>
          <span>Band: ${marginInfo.bandLow.toFixed(2)}</span>
          {marginInfo.lowestBuyPrice && <span>Lowest: ${marginInfo.lowestBuyPrice.toFixed(3)}</span>}
          {marginInfo.uncoveredLevels > 0 && (
            <span className="text-yellow-400">{marginInfo.uncoveredLevels} uncovered</span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            type="number"
            min="0.1"
            step="0.1"
            value={addAmount}
            onChange={(e) => setAddAmount(e.target.value)}
            className="w-24 text-xs"
            placeholder="USDT"
            data-testid={`input-add-margin-${strategy.id}`}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={addMargin.isPending || !addAmount || parseFloat(addAmount) <= 0}
            onClick={() => addMargin.mutate({ id: strategy.id, amount: parseFloat(addAmount) })}
            data-testid={`button-add-margin-${strategy.id}`}
          >
            {addMargin.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <PlusCircle className="h-3 w-3 mr-1" />}
            Add Margin
          </Button>
          {marginInfo?.needsExtension && (
            <Button
              size="sm"
              variant="outline"
              disabled={extendOrders.isPending}
              onClick={() => extendOrders.mutate(strategy.id)}
              data-testid={`button-extend-orders-${strategy.id}`}
            >
              {extendOrders.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ArrowDownToLine className="h-3 w-3 mr-1" />}
              Extend to -1%
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-28">
            <Input
              type="number"
              min="1"
              step="1"
              value={removeCount}
              onChange={(e) => setRemoveCount(e.target.value)}
              className="text-xs pr-12"
              placeholder={marginInfo && marginInfo.removableOrders > 0 ? `~$${marginInfo.removableMargin.toFixed(2)}` : "0"}
              data-testid={`input-remove-margin-${strategy.id}`}
            />
            {marginInfo && marginInfo.removableOrders > 0 && (
              <button
                className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground px-1 rounded"
                onClick={() => setRemoveCount(String(marginInfo.removableOrders))}
                data-testid={`button-max-remove-${strategy.id}`}
              >
                MAX
              </button>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={removeMargin.isPending || !removeCount || parseInt(removeCount) < 1}
            onClick={() => removeMargin.mutate({ id: strategy.id, count: parseInt(removeCount) })}
            data-testid={`button-remove-margin-${strategy.id}`}
          >
            {removeMargin.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <MinusCircle className="h-3 w-3 mr-1" />}
            Remove Bottom
          </Button>
          {marginInfo && marginInfo.removableOrders > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {marginInfo.removableOrders} removable (~${marginInfo.removableMargin.toFixed(2)})
            </span>
          )}
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1.5">
        Add: places extra buy orders within 1% band. Remove: cancels lowest orders {">"}1% below price.
      </p>
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

  const gridParams = s.type === "grid" ? [
    { label: "Start Price", value: `$${Number(cfg.startPrice || 0).toFixed(2)}` },
    { label: "Lower Bound", value: `$${Number(cfg.lowerPrice || 0).toFixed(2)}` },
    { label: "Upper Bound", value: `$${Number(cfg.upperPrice || 0).toFixed(2)}` },
    { label: "Liquidation", value: `$${Number(cfg.liquidationPrice || 0).toFixed(2)}` },
    { label: "Grid Count", value: `${cfg.gridCount || 0}` },
    { label: "Grids Below", value: `${cfg.gridsBelow || 0}` },
    { label: "Grids Above", value: `${cfg.gridsAbove || 0}` },
    { label: "Leverage", value: `${cfg.leverage || 1}x` },
    { label: "Grid Ratio", value: `${Number(cfg.gridRatio || 0).toFixed(4)}` },
    { label: "Per Grid", value: `$${cfg.amountPerGrid || 0}` },
    { label: "Gap Growth Below", value: `${cfg.gapGrowthBelow || 1}x` },
    { label: "Gap Shrink Above", value: `${cfg.gapShrinkAbove || 1}x` },
    { label: "Extensions", value: `${cfg.extensionsBelow || 0} below / ${cfg.extensionsAbove || 0} above` },
    { label: "Pair Rotation", value: cfg.rotationEnabled ? "Enabled" : "Disabled" },
  ] : Object.entries(cfg).map(([key, val]) => ({ label: key, value: String(val) }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-border/40 bg-card/30 overflow-visible"
      data-testid={`card-strategy-${s.id}`}
    >
      <div
        className="p-4 cursor-pointer hover-elevate"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-${s.id}`}
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
                {s.type === "grid" && cfg.leverage && (
                  <span className="text-xs text-yellow-300 font-mono">{cfg.leverage}x</span>
                )}
                {s.type === "grid" && (cfg.extensionsBelow > 0 || cfg.extensionsAbove > 0) && (
                  <Badge variant="secondary" className="text-[10px] bg-blue-500/20 text-blue-300 border-blue-500/30">
                    Ext: {cfg.extensionsBelow || 0} / {cfg.extensionsAbove || 0}
                  </Badge>
                )}
                {cfg.rotationEnabled && (
                  <Badge variant="secondary" className="text-[10px] bg-purple-500/20 text-purple-300 border-purple-500/30">
                    <RotateCcw className="h-2.5 w-2.5 mr-0.5" /> Auto-Rotate
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {s.status === "running" && position && (
              <div className="flex flex-col items-center gap-1 mr-2" data-testid={`pnl-meter-${s.id}`}>
                <div className="relative w-12 h-12">
                  <svg viewBox="0 0 36 36" className="w-12 h-12 -rotate-90">
                    <circle
                      cx="18" cy="18" r="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="text-border/30"
                    />
                    <circle
                      cx="18" cy="18" r="15"
                      fill="none"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeDasharray={`${Math.min(Math.abs(pnlPercent), 100) * 0.94} 94`}
                      className={unrealizedPnl >= 0 ? "stroke-emerald-400" : "stroke-red-400"}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className={`text-[9px] font-bold font-mono ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {pnlPercent > 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div className="text-right hidden sm:block">
              <div className="text-sm font-mono">
                <span className={`font-bold ${(s.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {formatCurrency(s.totalPnl || 0)}
                </span>
              </div>
              {s.status === "running" && position && (
                <div className="text-xs font-mono" data-testid={`text-pnl-pct-${s.id}`}>
                  <span className={`font-bold ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {unrealizedPnl >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%
                  </span>
                  <span className="text-muted-foreground ml-1">
                    {unrealizedPnl >= 0 ? "+" : ""}{formatCurrency(unrealizedPnl)}
                  </span>
                </div>
              )}
              {!(s.status === "running" && position) && (
                <div className="text-xs text-muted-foreground">{s.totalTrades || 0} trades</div>
              )}
            </div>
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
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
        <div className="px-4 pb-4 pt-0 border-t border-border/30">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mt-3">
            {gridParams.map(p => (
              <div key={p.label} className="p-2 rounded border border-border/20 bg-card/20" data-testid={`param-${s.id}-${p.label.toLowerCase().replace(/\s/g, "-")}`}>
                <p className="text-[10px] text-muted-foreground">{p.label}</p>
                <p className="font-mono text-xs font-semibold text-foreground">{p.value}</p>
              </div>
            ))}
          </div>
          {s.type === "grid" && s.status === "running" && (
            <>
              <GapModifiers strategy={s} />
              <MarginControls strategy={s} />
            </>
          )}
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
            <span>Created: {s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}</span>
            <span>Last run: {s.lastRunAt ? (() => {
              const ago = Math.round((Date.now() - new Date(s.lastRunAt).getTime()) / 1000);
              if (ago < 60) return `${ago}s ago`;
              if (ago < 3600) return `${Math.round(ago / 60)}m ago`;
              return new Date(s.lastRunAt).toLocaleString();
            })() : "Never"}</span>
            <Badge variant={s.status === "running" ? "default" : s.status === "error" ? "destructive" : "outline"}>
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
        <StrategyCard key={s.id} s={s} />
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

function VolatilityScoresPanel() {
  const { data: scores, isLoading } = useVolatilityScores();

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4 text-blue-400" />
          Volatility Scores
        </CardTitle>
        <Badge variant="secondary" className="text-[10px]">24h</Badge>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {isLoading && <p className="text-xs text-muted-foreground">Loading scores...</p>}
        {scores?.slice(0, 10).map(s => (
          <div key={s.symbol} className="flex items-center justify-between text-xs p-1.5 rounded border border-border/20" data-testid={`vol-score-${s.symbol}`}>
            <div className="flex items-center gap-2">
              <span className="font-bold text-foreground uppercase">{s.symbol}</span>
              <span className="text-muted-foreground">{s.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {s.swings1to5} swings
              </Badge>
              {s.largeSwingsDown > 0 && (
                <Badge variant="destructive" className="text-[10px]">
                  {s.largeSwingsDown} drops
                </Badge>
              )}
              {s.largeSwingsUp > 0 && (
                <Badge className="bg-emerald-600/50 text-[10px]">
                  {s.largeSwingsUp} pumps
                </Badge>
              )}
              <span className="font-mono text-muted-foreground w-12 text-right">
                R:{s.riskGauge.toFixed(1)}
              </span>
            </div>
          </div>
        ))}
        {scores && scores.length === 0 && (
          <p className="text-xs text-muted-foreground">No volatility data yet. Refresh dashboard first.</p>
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
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-yellow-400" />
          Grid Strategy Simulation
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            data-testid="input-sim-symbol"
            placeholder="Symbol (empty = all)"
            value={simSymbol}
            onChange={e => setSimSymbol(e.target.value)}
            className="w-40 h-8 text-xs"
          />
          <Button
            variant="outline"
            onClick={handleSimulate}
            disabled={simulation.isPending}
            data-testid="button-run-simulation"
          >
            <Zap className="h-4 w-4 mr-1" />
            {simulation.isPending ? "Simulating..." : "Run Backtest"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!results && !simulation.isPending && (
          <p className="text-sm text-muted-foreground">
            Run a backtest to simulate the grid strategy on historical CoinGecko price data (25h window).
            Leave symbol empty to test all top 20 coins.
          </p>
        )}
        {isArray && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Buys</TableHead>
                  <TableHead className="text-right">Sells</TableHead>
                  <TableHead className="text-right">Realized PnL</TableHead>
                  <TableHead className="text-right">Unrealized</TableHead>
                  <TableHead className="text-right">Total PnL</TableHead>
                  <TableHead className="text-right">Max DD</TableHead>
                  <TableHead className="text-right">Leverage</TableHead>
                  <TableHead className="text-right">Grids</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r: any) => (
                  <TableRow key={r.symbol} data-testid={`sim-row-${r.symbol}`}>
                    <TableCell className="font-bold">{r.symbol}</TableCell>
                    <TableCell className="text-right font-mono">{r.totalTrades}</TableCell>
                    <TableCell className="text-right font-mono text-emerald-400">{r.buys}</TableCell>
                    <TableCell className="text-right font-mono text-red-400">{r.sells}</TableCell>
                    <TableCell className={`text-right font-mono ${r.realizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      ${r.realizedPnl.toFixed(4)}
                    </TableCell>
                    <TableCell className={`text-right font-mono ${r.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      ${r.unrealizedPnl.toFixed(4)}
                    </TableCell>
                    <TableCell className={`text-right font-mono font-bold ${r.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      ${r.totalPnl.toFixed(4)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-amber-400">${r.maxDrawdown.toFixed(4)}</TableCell>
                    <TableCell className="text-right font-mono">{r.leverage}x</TableCell>
                    <TableCell className="text-right font-mono">{r.gridCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {results && !isArray && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[10px] text-muted-foreground">Total Trades</p>
                <p className="font-mono font-bold" data-testid="text-sim-trades">{results.totalTrades}</p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[10px] text-muted-foreground">Total PnL</p>
                <p className={`font-mono font-bold ${results.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-sim-pnl">
                  ${results.totalPnl.toFixed(4)}
                </p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[10px] text-muted-foreground">Max Drawdown</p>
                <p className="font-mono font-bold text-amber-400" data-testid="text-sim-dd">${results.maxDrawdown.toFixed(4)}</p>
              </div>
              <div className="p-2 rounded border border-border/30 text-center">
                <p className="text-[10px] text-muted-foreground">Price Range</p>
                <p className="font-mono text-xs" data-testid="text-sim-range">{results.priceRange}</p>
              </div>
            </div>
            {results.trades?.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Grid</TableHead>
                    <TableHead className="text-right">PnL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.trades.map((t: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs text-muted-foreground">{new Date(t.time).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant={t.side === "BUY" ? "default" : "destructive"} className="text-[10px]">{t.side}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">${t.price.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono">{t.gridLevel}</TableCell>
                      <TableCell className={`text-right font-mono ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${t.pnl.toFixed(4)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuickStartPanel() {
  const [amount, setAmount] = useState("100");
  const quickStart = useQuickStart();
  const { data: scores } = useVolatilityScores();
  const topPair = scores?.[0];

  const result = quickStart.data;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="bg-gradient-to-r from-purple-900/30 via-card/40 to-blue-900/30 border-purple-500/30">
        <CardContent className="p-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-400" />
                Quick Start Grid Bot
              </h2>
              <p className="text-sm text-muted-foreground">
                Enter your USDT amount and we'll auto-select the best pair based on volatility scores
                {topPair && (
                  <span className="text-purple-300 ml-1">
                    — currently favoring <span className="font-semibold uppercase">{topPair.symbol}</span> ({topPair.name}, score: {topPair.score})
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative">
                <DollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="input-quickstart-amount"
                  type="number"
                  min="5"
                  step="10"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="pl-8 w-32 font-mono"
                  placeholder="100"
                />
              </div>
              <span className="text-sm text-muted-foreground font-medium">USDT</span>
              <Button
                data-testid="button-quickstart"
                onClick={() => quickStart.mutate({ amount: parseFloat(amount) })}
                disabled={quickStart.isPending || !amount || parseFloat(amount) <= 0}
                className="bg-purple-600 border-purple-500"
              >
                {quickStart.isPending ? (
                  <>
                    <Activity className="h-4 w-4 mr-1 animate-spin" /> Starting...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-1" /> Start Bot
                  </>
                )}
              </Button>
            </div>
          </div>

          {result && (
            <div className="mt-4 p-3 rounded-lg border border-emerald-500/30 bg-emerald-900/10">
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-emerald-600/50">Running</Badge>
                <span className="text-sm font-semibold">{result.selectedPair}</span>
                <span className="text-xs text-muted-foreground">({result.pairName})</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <span className="text-muted-foreground">Volatility Score</span>
                  <p className="font-mono font-bold text-purple-300" data-testid="text-qs-score">{result.volatilityScore}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Risk Gauge</span>
                  <p className="font-mono font-bold" data-testid="text-qs-risk">{result.riskGauge.toFixed(1)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Grids / Leverage</span>
                  <p className="font-mono font-bold" data-testid="text-qs-grids">{result.gridInfo.gridCount} / {result.gridInfo.leverage}x</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Per Grid</span>
                  <p className="font-mono font-bold" data-testid="text-qs-pergrid">${result.gridInfo.amountPerGrid}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
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

        <QuickStartPanel />

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
            <VolatilityScoresPanel />
          </div>
        </div>

        <SimulationPanel />

        <footer className="pt-8 pb-6 text-center text-sm text-muted-foreground/40 font-mono">
          Automated trading involves significant risk. Past performance does not guarantee future results.
        </footer>
      </div>
    </div>
  );
}
