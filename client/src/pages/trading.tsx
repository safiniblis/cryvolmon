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
  useTandemStart,
  useHedgePairStart,
  useSilverLongStart,
  useSpxShortStart,
  usePairInfo,
  useEmergencyStop,
} from "@/hooks/use-trading";
import {
  Bot, Play, Square, Trash2, Wifi, WifiOff,
  DollarSign, Activity,
  AlertTriangle, ArrowRight, Zap,
  BarChart3, RotateCcw, Shield, PlusCircle, MinusCircle, Loader2, ArrowDownToLine,
  RefreshCw, ArrowUpDown, OctagonX,
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

  const phaseLabels: Record<string, string> = {
    entry: "Opening L+S",
    waiting_liquidation: "Waiting Liq",
    cascade: `TP ${cfg.cascadeStep || 0}/3`,
    trailing: "Trailing 0.5%",
    complete: "Cycle Done",
  };

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
    ...(cfg.twinMode ? [{ label: "Twin", value: `${((cfg.twinGapPct || 0.006) * 100).toFixed(1)}% gap` }] : []),
    ...(cfg.allocatedBudget ? [{ label: "Budget", value: `$${Number(cfg.allocatedBudget).toFixed(2)}` }] : []),
  ] : s.type === "tandem" ? [
    { label: "Phase", value: phaseLabels[cfg.phase] || cfg.phase || "—" },
    { label: "Leverage", value: `${cfg.leverage || 33}x` },
    { label: "Total $", value: `$${cfg.totalCapital || cfg.capitalPerSide * 2 || 0}` },
    ...(cfg.longGridId ? [{ label: "L Grid", value: `#${cfg.longGridId}` }] : []),
    ...(cfg.shortGridId ? [{ label: "S Grid", value: `#${cfg.shortGridId}` }] : []),
    { label: "Cycle", value: `#${cfg.cycleCount || 0}` },
    { label: "Entry", value: cfg.entryPrice ? `$${Number(cfg.entryPrice).toFixed(4)}` : "—" },
    ...(cfg.liquidatedSide ? [{ label: "Liq Side", value: cfg.liquidatedSide }] : []),
    ...(cfg.survivingSide ? [{ label: "Survivor", value: cfg.survivingSide }] : []),
    ...(cfg.cascadeStep > 0 ? [{ label: "Cascade", value: `${cfg.cascadeStep}/3` }] : []),
    ...(cfg.highWatermark > 0 ? [{ label: "HWM", value: `$${Number(cfg.highWatermark).toFixed(4)}` }] : []),
    { label: "Rotation", value: cfg.rotationEnabled ? "On" : "Off" },
    { label: "Total PnL", value: `$${Number(cfg.totalPnl || 0).toFixed(2)}` },
  ] : s.type === "hedge_pair" ? [
    { label: "Phase", value: cfg.phase || "—" },
    { label: "Leverage", value: `${cfg.leverage || 100}x` },
    { label: "$/side", value: `$${cfg.capitalPerSide || 0}` },
    { label: "Entry", value: cfg.entryPrice ? `$${Number(cfg.entryPrice).toFixed(4)}` : "—" },
    { label: "Cycle", value: `#${cfg.cycleCount || 0}` },
    ...(cfg.liquidatedSide ? [{ label: "Liq Side", value: cfg.liquidatedSide }] : []),
    ...(cfg.survivingSide ? [{ label: "Survivor", value: cfg.survivingSide }] : []),
    { label: "Trail", value: `${((cfg.trailingPct || 0.0033) * 100).toFixed(2)}%` },
    ...(cfg.trailingHwm ? [{ label: "HWM", value: `$${Number(cfg.trailingHwm).toFixed(4)}` }] : []),
    { label: "Auto", value: cfg.autoRestart ? "On" : "Off" },
    { label: "Cycle PnL", value: `$${Number(cfg.cyclePnl || 0).toFixed(4)}` },
    { label: "Total PnL", value: `$${Number(cfg.totalPnl || 0).toFixed(4)}` },
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
                {s.type === "tandem" && cfg.phase && s.status === "running" && (
                  <Badge variant="secondary" className="text-[10px] bg-orange-500/20 text-orange-300 border-orange-500/30">
                    {phaseLabels[cfg.phase] || cfg.phase}
                  </Badge>
                )}
                {s.type === "hedge_pair" && cfg.phase && s.status === "running" && (
                  <Badge variant="secondary" className="text-[10px] bg-cyan-500/20 text-cyan-300 border-cyan-500/30">
                    {cfg.phase === "entry" ? "Opening" : cfg.phase === "monitoring" ? "Watching" : cfg.phase === "trailing" ? "Trailing" : cfg.phase === "done" ? "Done" : cfg.phase}
                  </Badge>
                )}
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
  const [twinMode, setTwinMode] = useState(true);

  const runningStrategy = strategies?.find(s => s.status === "running" && s.type === "grid");
  const hasRunning = !!runningStrategy;

  const handleStart = (bitunixSymbol: string) => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    setStartingSymbol(bitunixSymbol);
    quickStart.mutate({ amount: val, symbol: bitunixSymbol, twinMode, twinGapPct: 0.006 }, {
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
            <Button
              size="sm"
              variant={twinMode ? "default" : "outline"}
              onClick={() => setTwinMode(!twinMode)}
              className="h-6 px-2 text-[10px]"
              data-testid="button-twin-mode"
            >
              <ArrowUpDown className="h-3 w-3 mr-1" />
              Twin {twinMode ? "On" : "Off"}
            </Button>
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
    params.totalCapital = parseFloat(tandemCapital) || 100;
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

function computeGridStats(lev: number, feeMultiplier: number = 3.5) {
  const feeRate = 0.0006;
  const roundTripFee = 2 * feeRate;
  const gridGap = feeMultiplier * roundTripFee;
  const netPerGrid = gridGap - roundTripFee;
  const liqDist = 1 / lev;
  const gridRange = liqDist * 0.85;
  const gridCount = Math.floor(gridRange / gridGap);
  const roiPerOscillation = gridCount * netPerGrid * lev * 100;
  return {
    gridGapPct: +(gridGap * 100).toFixed(3),
    liqDistPct: +(liqDist * 100).toFixed(2),
    gridRangePct: +(gridRange * 100).toFixed(2),
    gridCount,
    roiPerOscillation: +roiPerOscillation.toFixed(1),
    roiPerGrid: +(netPerGrid * lev * 100).toFixed(2),
  };
}

function TandemStartPanel() {
  const [symbol, setSymbol] = useState("XRPUSDT");
  const [capital, setCapital] = useState("100");
  const [leverage, setLeverage] = useState("33");
  const [rotation, setRotation] = useState(false);
  const [longWeight, setLongWeight] = useState("1");
  const [shortWeight, setShortWeight] = useState("1");
  const tandemStart = useTandemStart();
  const stopStrategy = useStopStrategy();
  const { data: strategies } = useStrategies();
  const { data: accountData } = useAccount();
  const { data: pairInfo } = usePairInfo(symbol);
  const maxLev = (pairInfo as any)?.maxLeverage || 125;
  const runningTandem = strategies?.find(s => s.status === "running" && s.type === "tandem");

  const phaseLabels: Record<string, string> = {
    entry: "Opening L+S",
    waiting_liquidation: "Waiting for Liq",
    cascade: "Cascade TP",
    trailing: "Trailing Stop",
    complete: "Cycle Done",
  };

  if (runningTandem) {
    const cfg = (runningTandem.config || {}) as Record<string, any>;
    const phase = cfg.phase || "entry";

    const sideMap: Record<string, string[]> = { BOTH: ["BUY", "SELL", "LONG", "SHORT"] };
    const matchSides = sideMap["BOTH"];
    const positions = accountData?.positions?.filter((p: any) => p.symbol === runningTandem.symbol && matchSides.includes(p.side?.toUpperCase())) || [];
    const totalUnrealized = positions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);

    return (
      <Card className="bg-card/30 border-border/40">
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4 text-orange-400" />
            <span>{runningTandem.symbol}</span>
            <Badge variant="secondary" className="text-[10px] bg-orange-500/20 text-orange-300 border-orange-500/30">
              {phaseLabels[phase] || phase}
            </Badge>
          </CardTitle>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => stopStrategy.mutate(runningTandem.id)}
            disabled={stopStrategy.isPending}
            data-testid="button-tandem-stop"
          >
            <Square className="h-4 w-4 text-red-400" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-cycle">
              <p className="text-[9px] text-muted-foreground">Cycle</p>
              <p className="font-mono text-[11px] font-semibold">#{cfg.cycleCount || 0}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-leverage">
              <p className="text-[9px] text-muted-foreground">Leverage</p>
              <p className="font-mono text-[11px] font-semibold">{cfg.leverage || 33}x</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-capital">
              <p className="text-[9px] text-muted-foreground">Capital (L/S)</p>
              <p className="font-mono text-[11px] font-semibold">${cfg.totalCapital || 0} ({cfg.longWeight || 1}/{cfg.shortWeight || 1})</p>
            </div>
            {cfg.longGridId && (
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-grids">
                <p className="text-[9px] text-muted-foreground">Grids</p>
                <p className="font-mono text-[11px] font-semibold">L#{cfg.longGridId} S#{cfg.shortGridId}</p>
              </div>
            )}
          </div>
          {cfg.entryPrice > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-entry">
                <p className="text-[9px] text-muted-foreground">Entry</p>
                <p className="font-mono text-[11px] font-semibold">${Number(cfg.entryPrice).toFixed(4)}</p>
              </div>
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-unrealized">
                <p className="text-[9px] text-muted-foreground">Unrealized</p>
                <p className={`font-mono text-[11px] font-bold ${totalUnrealized >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {totalUnrealized >= 0 ? "+" : ""}{formatCurrency(totalUnrealized)}
                </p>
              </div>
            </div>
          )}
          {positions.length >= 2 && phase === "waiting_liquidation" && (
            <div className="grid grid-cols-2 gap-1.5">
              {positions.map((p: any, i: number) => (
                <div key={i} className="p-1.5 rounded border border-border/20 bg-card/20" data-testid={`tandem-pos-${p.side?.toLowerCase()}`}>
                  <p className="text-[9px] text-muted-foreground">{p.side} qty</p>
                  <p className="font-mono text-[11px] font-semibold">{p.quantity}</p>
                </div>
              ))}
            </div>
          )}
          {(cfg.rebalanceCount || 0) > 0 && (
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-rebalance">
              <p className="text-[9px] text-muted-foreground">Rebalances</p>
              <p className="font-mono text-[11px] font-semibold">{cfg.rebalanceCount} {cfg.lastRebalanceAt ? `(${Math.round((Date.now() - cfg.lastRebalanceAt) / 60000)}m ago)` : ""}</p>
            </div>
          )}
          {cfg.liquidatedSide && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-liq-side">
                <p className="text-[9px] text-muted-foreground">Liquidated</p>
                <p className="font-mono text-[11px] font-semibold text-red-400">{cfg.liquidatedSide}</p>
              </div>
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-survivor">
                <p className="text-[9px] text-muted-foreground">Survivor</p>
                <p className="font-mono text-[11px] font-semibold text-emerald-400">{cfg.survivingSide}</p>
              </div>
            </div>
          )}
          {(cfg.cascadeStep > 0 || cfg.phase === "cascade" || cfg.phase === "trailing") && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-cascade">
                <p className="text-[9px] text-muted-foreground">Cascade</p>
                <p className="font-mono text-[11px] font-semibold">{cfg.cascadeStep}/3 {cfg.phase === "trailing" ? "+ trail" : ""}</p>
              </div>
              {cfg.highWatermark > 0 && (
                <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="tandem-hwm">
                  <p className="text-[9px] text-muted-foreground">HWM</p>
                  <p className="font-mono text-[11px] font-semibold">${Number(cfg.highWatermark).toFixed(4)}</p>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/20">
            <span>Total PnL: <span className={`font-mono font-bold ${(cfg.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatCurrency(cfg.totalPnl || 0)}</span></span>
            <span>Last: {runningTandem.lastRunAt ? (() => {
              const ago = Math.round((Date.now() - new Date(runningTandem.lastRunAt).getTime()) / 1000);
              return ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
            })() : "—"}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-orange-400" />
          Tandem L/S
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            data-testid="input-tandem-symbol"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="w-28 text-xs font-mono"
            placeholder="XRPUSDT"
          />
          <Input
            data-testid="input-tandem-capital"
            type="number"
            min="10"
            value={capital}
            onChange={e => setCapital(e.target.value)}
            className="w-16 text-xs font-mono"
            placeholder="Total $"
          />
          <div className="flex items-center gap-1">
            <Input
              data-testid="input-tandem-leverage"
              type="number"
              min="2"
              max={maxLev}
              value={leverage}
              onChange={e => setLeverage(e.target.value)}
              className="w-16 text-xs font-mono"
              placeholder="33x"
            />
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] px-1.5"
              onClick={() => setLeverage(String(maxLev))}
              data-testid="button-tandem-max-leverage"
            >
              Max {maxLev}x
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Split:</span>
          <Input
            data-testid="input-tandem-long-weight"
            type="number"
            min="1"
            max="10"
            value={longWeight}
            onChange={e => setLongWeight(e.target.value)}
            className="w-12 text-xs font-mono"
          />
          <span className="text-[10px] text-muted-foreground">L /</span>
          <Input
            data-testid="input-tandem-short-weight"
            type="number"
            min="1"
            max="10"
            value={shortWeight}
            onChange={e => setShortWeight(e.target.value)}
            className="w-12 text-xs font-mono"
          />
          <span className="text-[10px] text-muted-foreground">S</span>
          <span className="text-[9px] text-muted-foreground/60 ml-auto">
            {(() => {
              const lw = parseInt(longWeight) || 1;
              const sw = parseInt(shortWeight) || 1;
              const t = lw + sw;
              return `L:${((lw / t) * 100).toFixed(0)}% S:${((sw / t) * 100).toFixed(0)}%`;
            })()}
          </span>
        </div>
        {parseInt(leverage) >= 2 && (
          <div className="grid grid-cols-4 gap-1" data-testid="tandem-grid-stats">
            {(() => {
              const stats = computeGridStats(parseInt(leverage) || 33);
              return (
                <>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Grids</p>
                    <p className={`font-mono text-[11px] font-bold ${stats.gridCount >= 4 ? "text-emerald-400" : stats.gridCount >= 2 ? "text-yellow-400" : "text-red-400"}`}>{stats.gridCount}</p>
                  </div>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Gap</p>
                    <p className="font-mono text-[11px] font-semibold">{stats.gridGapPct}%</p>
                  </div>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Liq</p>
                    <p className="font-mono text-[11px] font-semibold">{stats.liqDistPct}%</p>
                  </div>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">ROI/osc</p>
                    <p className="font-mono text-[11px] font-semibold text-blue-400">{stats.roiPerOscillation}%</p>
                  </div>
                </>
              );
            })()}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={rotation}
              onChange={e => setRotation(e.target.checked)}
              className="rounded"
              data-testid="input-tandem-rotation"
            />
            Auto-rotate
          </label>
          <Button
            data-testid="button-tandem-start"
            size="sm"
            disabled={tandemStart.isPending || !symbol || parseFloat(capital) < 10}
            onClick={() => tandemStart.mutate({
              symbol,
              totalCapital: parseFloat(capital),
              leverage: parseInt(leverage),
              rotationEnabled: rotation,
              longWeight: parseInt(longWeight) || 1,
              shortWeight: parseInt(shortWeight) || 1,
            })}
          >
            {tandemStart.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />}
            Start
          </Button>
        </div>
        <p className="text-[9px] text-muted-foreground/60">
          L+S entry, weighted split, order window 6, cascade 3/7+2/7+1/7, trail 0.3%
        </p>
      </CardContent>
    </Card>
  );
}

function SpxShortPanel() {
  const { data: strategies } = useStrategies();
  const stopStrategy = useStopStrategy();
  const spxShortStart = useSpxShortStart();

  const [symbol, setSymbol] = useState("SPXUSDT");
  const [baseCapital, setBaseCapital] = useState("100");
  const [leverage, setLeverage] = useState("20");

  const running = strategies?.find(
    (s: Strategy) => s.type === "spx_short" && s.status === "running",
  );

  if (running) {
    const cfg = (running.config || {}) as any;
    const phase = cfg.phase || "entry";
    const phaseLabels: Record<string, string> = { entry: "Opening", monitoring: "Monitoring", complete: "Done" };
    const nextCheckMin = cfg.lastLiqCheckAt
      ? Math.max(0, Math.round((cfg.lastLiqCheckAt + 3600000 - Date.now()) / 60000))
      : "—";

    return (
      <Card className="bg-card/30 border-border/40">
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ArrowDownToLine className="h-4 w-4 text-red-400" />
            <span>{running.symbol}</span>
            <Badge variant="secondary" className="text-[10px] bg-red-500/20 text-red-300 border-red-500/30">
              SHORT · {phaseLabels[phase] || phase}
            </Badge>
          </CardTitle>
          <Button size="icon" variant="ghost" onClick={() => stopStrategy.mutate(running.id)} disabled={stopStrategy.isPending}>
            <Square className="h-3.5 w-3.5 text-red-400" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Leverage</p>
              <p className="font-mono text-[11px] font-semibold text-red-300">{cfg.leverage}x</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Capital</p>
              <p className="font-mono text-[11px] font-semibold">${cfg.baseCapital}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Fills</p>
              <p className="font-mono text-[11px] font-semibold text-red-300">
                {cfg.ordersHit ?? 0}/{(cfg.ordersHit ?? 0) >= 5 ? "final" : "5"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Entry</p>
              <p className="font-mono text-[11px] font-semibold">{cfg.entryPrice ? `$${Number(cfg.entryPrice).toFixed(3)}` : "..."}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Liq Price</p>
              <p className="font-mono text-[11px] font-semibold text-red-400">{cfg.liquidationPrice ? `$${Number(cfg.liquidationPrice).toFixed(3)}` : "..."}</p>
            </div>
          </div>
          {phase === "monitoring" && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">Mode</p>
                <p className="font-mono text-[11px] font-semibold">
                  {(cfg.ordersHit ?? 0) >= 6 ? <span className="text-purple-400">Terminal</span>
                    : (cfg.ordersHit ?? 0) >= 5 ? <span className="text-orange-400">Final</span>
                    : <span className="text-cyan-400">Loop</span>}
                </p>
              </div>
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">Support</p>
                <p className="font-mono text-[11px] font-semibold">
                  {(cfg.ordersHit ?? 0) >= 6 ? "20% @−0.1%" : (cfg.ordersHit ?? 0) >= 5 ? "5%+20%" : "5%+5%"}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/20">
            <span>Next liq check: <span className="font-mono text-red-300">{typeof nextCheckMin === "number" ? `${nextCheckMin}m` : nextCheckMin}</span></span>
            <span>Orders @ liq−0.1% / −0.05%</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ArrowDownToLine className="h-4 w-4 text-red-400" />
          SPX Short
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="w-28 text-xs font-mono"
            placeholder="SPXUSDT"
          />
          <Input
            type="number" min="5" step="10"
            value={baseCapital}
            onChange={e => setBaseCapital(e.target.value)}
            className="w-20 text-xs font-mono"
            placeholder="Capital $"
          />
          <div className="flex items-center gap-1">
            <Input
              type="number" min="2" max="125"
              value={leverage}
              onChange={e => setLeverage(e.target.value)}
              className="w-16 text-xs font-mono"
              placeholder="Lev"
            />
            <Button
              size="sm"
              className="h-7 px-3 text-xs bg-red-700 hover:bg-red-600"
              disabled={spxShortStart.isPending}
              onClick={() => spxShortStart.mutate({ symbol, baseCapital: parseFloat(baseCapital) || 100, leverage: parseInt(leverage) || 20 })}
            >
              {spxShortStart.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />}
              Start
            </Button>
          </div>
        </div>
        <p className="text-[9px] text-muted-foreground/60">
          20% market short · 5% @ liq−0.1% · 5% @ liq−0.05% · hourly liq refresh
        </p>
      </CardContent>
    </Card>
  );
}

function SilverLongPanel() {
  const { data: strategies } = useStrategies();
  const stopStrategy = useStopStrategy();
  const silverLongStart = useSilverLongStart();

  const [symbol, setSymbol] = useState("XAGUSDT");
  const [baseCapital, setBaseCapital] = useState("100");
  const [leverage, setLeverage] = useState("10");

  const running = strategies?.find(
    (s: Strategy) => s.type === "silver_long" && s.status === "running",
  );

  if (running) {
    const cfg = (running.config || {}) as any;
    const phase = cfg.phase || "entry";
    const phaseLabels: Record<string, string> = {
      entry: "Opening",
      monitoring: "Monitoring",
      complete: "Done",
    };
    const nextCheckMin = cfg.lastLiqCheckAt
      ? Math.max(0, Math.round((cfg.lastLiqCheckAt + 3600000 - Date.now()) / 60000))
      : "—";

    return (
      <Card className="bg-card/30 border-border/40">
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-yellow-400" />
            <span>{running.symbol}</span>
            <Badge variant="secondary" className="text-[10px] bg-yellow-500/20 text-yellow-300 border-yellow-500/30">
              {phaseLabels[phase] || phase}
            </Badge>
          </CardTitle>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => stopStrategy.mutate(running.id)}
            disabled={stopStrategy.isPending}
          >
            <Square className="h-3.5 w-3.5 text-red-400" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Leverage</p>
              <p className="font-mono text-[11px] font-semibold text-yellow-300">{cfg.leverage}x</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Capital</p>
              <p className="font-mono text-[11px] font-semibold">${cfg.baseCapital}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Phase</p>
              <p className="font-mono text-[11px] font-semibold text-emerald-400">{phaseLabels[phase] || phase}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Entry</p>
              <p className="font-mono text-[11px] font-semibold">
                {cfg.entryPrice ? `$${Number(cfg.entryPrice).toFixed(3)}` : "..."}
              </p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20">
              <p className="text-[9px] text-muted-foreground">Liq Price</p>
              <p className="font-mono text-[11px] font-semibold text-red-400">
                {cfg.liquidationPrice ? `$${Number(cfg.liquidationPrice).toFixed(3)}` : "..."}
              </p>
            </div>
          </div>
          {phase === "monitoring" && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="p-1.5 rounded border border-border/20 bg-card/20">
                  <p className="text-[9px] text-muted-foreground">Fills</p>
                  <p className="font-mono text-[11px] font-semibold text-yellow-300">
                    {cfg.ordersHit ?? 0} / {cfg.ordersHit >= 5 ? "final" : "5"}
                  </p>
                </div>
                <div className="p-1.5 rounded border border-border/20 bg-card/20">
                  <p className="text-[9px] text-muted-foreground">Mode</p>
                  <p className="font-mono text-[11px] font-semibold">
                    {(cfg.ordersHit ?? 0) >= 6
                      ? <span className="text-purple-400">Terminal</span>
                      : (cfg.ordersHit ?? 0) >= 5
                      ? <span className="text-orange-400">Final</span>
                      : <span className="text-cyan-400">Loop</span>}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="p-1.5 rounded border border-border/20 bg-card/20">
                  <p className="text-[9px] text-muted-foreground">
                    {(cfg.ordersHit ?? 0) >= 6 ? "—" : "Liq+0.1%"}
                  </p>
                  <p className="font-mono text-[11px] font-semibold">
                    {(cfg.ordersHit ?? 0) >= 6
                      ? <span className="text-muted-foreground">—</span>
                      : cfg.order1Id
                      ? <span className="text-emerald-400">5% Active</span>
                      : <span className="text-muted-foreground">—</span>}
                  </p>
                </div>
                <div className="p-1.5 rounded border border-border/20 bg-card/20">
                  <p className="text-[9px] text-muted-foreground">
                    {(cfg.ordersHit ?? 0) >= 6 ? "Liq+0.1%" : "Liq+0.05%"}
                  </p>
                  <p className="font-mono text-[11px] font-semibold">
                    {cfg.order2Id
                      ? <span className="text-emerald-400">{(cfg.ordersHit ?? 0) >= 5 ? "20%" : "5%"} Active</span>
                      : <span className="text-muted-foreground">—</span>}
                  </p>
                </div>
              </div>
            </>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/20">
            <span>Next liq check: <span className="font-mono text-yellow-300">{typeof nextCheckMin === "number" ? `${nextCheckMin}m` : nextCheckMin}</span></span>
            <span>Support: <span className="font-mono">
              {(cfg.ordersHit ?? 0) >= 6 ? "20% @0.1%" : (cfg.ordersHit ?? 0) >= 5 ? "5%+20%" : "5%+5%"}
            </span></span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-yellow-400" />
          Silver Long
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="w-28 text-xs font-mono"
            placeholder="XAGUSDT"
          />
          <Input
            type="number"
            min="5"
            step="10"
            value={baseCapital}
            onChange={e => setBaseCapital(e.target.value)}
            className="w-20 text-xs font-mono"
            placeholder="Capital $"
          />
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min="2"
              max="125"
              value={leverage}
              onChange={e => setLeverage(e.target.value)}
              className="w-16 text-xs font-mono"
              placeholder="Lev"
            />
            <Button
              size="sm"
              className="h-7 px-3 text-xs bg-yellow-600 hover:bg-yellow-500"
              disabled={silverLongStart.isPending}
              onClick={() =>
                silverLongStart.mutate({
                  symbol,
                  baseCapital: parseFloat(baseCapital) || 100,
                  leverage: parseInt(leverage) || 10,
                })
              }
            >
              {silverLongStart.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Start
            </Button>
          </div>
        </div>
        <p className="text-[9px] text-muted-foreground/60">
          20% market entry · 5% @ liq+0.1% · 15% @ liq+0.05% · hourly liq refresh
        </p>
      </CardContent>
    </Card>
  );
}

function HedgePairPanel() {
  const { data: strategies } = useStrategies();
  const { data: accountData } = useAccount();
  const stopStrategy = useStopStrategy();
  const hedgePairStart = useHedgePairStart();

  const [symbol, setSymbol] = useState("XRPUSDT");
  const [capitalPerSide, setCapitalPerSide] = useState("5");
  const [leverage, setLeverage] = useState("100");
  const [autoRestart, setAutoRestart] = useState(true);
  const [trailingPct, setTrailingPct] = useState("0.33");

  const { data: pairInfo } = usePairInfo(symbol);
  const maxLev = (pairInfo as any)?.maxLeverage || 125;

  const runningHedge = strategies?.find((s: Strategy) => s.type === "hedge_pair" && s.status === "running");

  if (runningHedge) {
    const cfg = (runningHedge.config || {}) as any;
    const phase = cfg.phase || "entry";
    const liqDist = (1 / (cfg.leverage || 100) * 100).toFixed(2);

    const hedgePhaseLabels: Record<string, string> = {
      entry: "Opening L+S",
      monitoring: "Watching",
      trailing: "Trailing SL",
      done: "Cycle Done",
    };

    return (
      <Card className="bg-card/30 border-border/40">
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-cyan-400" />
            <span>{runningHedge.symbol}</span>
            <Badge variant="secondary" className="text-[10px] bg-cyan-500/20 text-cyan-300 border-cyan-500/30">
              {hedgePhaseLabels[phase] || phase}
            </Badge>
          </CardTitle>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => stopStrategy.mutate(runningHedge.id)}
            disabled={stopStrategy.isPending}
            data-testid="button-hedge-stop"
          >
            <Square className="h-3.5 w-3.5 text-red-400" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="hedge-leverage">
              <p className="text-[9px] text-muted-foreground">Leverage</p>
              <p className="font-mono text-[11px] font-semibold text-yellow-300">{cfg.leverage}x</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="hedge-capital">
              <p className="text-[9px] text-muted-foreground">$/side</p>
              <p className="font-mono text-[11px] font-semibold">${cfg.capitalPerSide}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="hedge-cycle">
              <p className="text-[9px] text-muted-foreground">Cycle</p>
              <p className="font-mono text-[11px] font-semibold">#{cfg.cycleCount || 0}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="hedge-entry">
              <p className="text-[9px] text-muted-foreground">Entry</p>
              <p className="font-mono text-[11px] font-semibold">{cfg.entryPrice ? `$${Number(cfg.entryPrice).toFixed(4)}` : "..."}</p>
            </div>
            <div className="p-1.5 rounded border border-border/20 bg-card/20" data-testid="hedge-liq-dist">
              <p className="text-[9px] text-muted-foreground">Liq Dist</p>
              <p className="font-mono text-[11px] font-semibold">{liqDist}%</p>
            </div>
          </div>
          {cfg.liquidatedSide && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">Liquidated</p>
                <p className="font-mono text-[11px] font-semibold text-red-400">{cfg.liquidatedSide}</p>
              </div>
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">Survivor</p>
                <p className="font-mono text-[11px] font-semibold text-emerald-400">{cfg.survivingSide}</p>
              </div>
            </div>
          )}
          {phase === "trailing" && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">Trail %</p>
                <p className="font-mono text-[11px] font-semibold text-yellow-300">{((cfg.trailingPct || 0.0033) * 100).toFixed(2)}%</p>
              </div>
              <div className="p-1.5 rounded border border-border/20 bg-card/20">
                <p className="text-[9px] text-muted-foreground">HWM</p>
                <p className="font-mono text-[11px] font-semibold">{cfg.trailingHwm ? `$${Number(cfg.trailingHwm).toFixed(4)}` : "..."}</p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/20">
            <span>Cycle: <span className={`font-mono font-bold ${(cfg.cyclePnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatCurrency(cfg.cyclePnl || 0)}</span></span>
            <span>Total: <span className={`font-mono font-bold ${(cfg.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatCurrency(cfg.totalPnl || 0)}</span></span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/30 border-border/40">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4 text-cyan-400" />
          Hedge Pair
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            data-testid="input-hedge-symbol"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="w-28 text-xs font-mono"
            placeholder="XRPUSDT"
          />
          <Input
            data-testid="input-hedge-capital"
            type="number"
            min="1"
            step="1"
            value={capitalPerSide}
            onChange={e => setCapitalPerSide(e.target.value)}
            className="w-16 text-xs font-mono"
            placeholder="$/side"
          />
          <div className="flex items-center gap-1">
            <Input
              data-testid="input-hedge-leverage"
              type="number"
              min="10"
              max={maxLev}
              value={leverage}
              onChange={e => setLeverage(e.target.value)}
              className="w-16 text-xs font-mono"
              placeholder="100x"
            />
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] px-1.5"
              onClick={() => setLeverage(String(maxLev))}
              data-testid="button-hedge-max-leverage"
            >
              Max {maxLev}x
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Trail:</span>
          <Input
            data-testid="input-hedge-trailing-pct"
            type="number"
            min="0.1"
            max="5"
            step="0.01"
            value={trailingPct}
            onChange={e => setTrailingPct(e.target.value)}
            className="w-16 text-xs font-mono"
          />
          <span className="text-[10px] text-muted-foreground">%</span>
        </div>
        {parseInt(leverage) >= 10 && (
          <div className="grid grid-cols-3 gap-1" data-testid="hedge-stats-preview">
            {(() => {
              const lev = parseInt(leverage) || 100;
              const cap = parseFloat(capitalPerSide) || 2;
              const liqDist = (100 / lev).toFixed(2);
              const notional = (cap * lev).toFixed(0);
              const maxLoss = (cap * 2).toFixed(2);
              return (
                <>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Liq Dist</p>
                    <p className="font-mono text-[11px] font-bold text-yellow-300">{liqDist}%</p>
                  </div>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Notional</p>
                    <p className="font-mono text-[11px] font-semibold">${notional}</p>
                  </div>
                  <div className="p-1 rounded border border-border/20 bg-card/20 text-center">
                    <p className="text-[8px] text-muted-foreground">Max Loss</p>
                    <p className="font-mono text-[11px] font-semibold text-red-400">${maxLoss}</p>
                  </div>
                </>
              );
            })()}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoRestart}
              onChange={e => setAutoRestart(e.target.checked)}
              className="rounded"
              data-testid="input-hedge-auto-restart"
            />
            Auto-restart
          </label>
          <Button
            data-testid="button-hedge-start"
            size="sm"
            disabled={hedgePairStart.isPending || !symbol || parseFloat(capitalPerSide) < 1}
            onClick={() => hedgePairStart.mutate({
              symbol,
              capitalPerSide: parseFloat(capitalPerSide),
              leverage: parseInt(leverage),
              autoRestart,
              trailingPct: parseFloat(trailingPct) / 100,
            })}
          >
            {hedgePairStart.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Shield className="h-3 w-3 mr-1" />}
            Start
          </Button>
        </div>
        <p className="text-[9px] text-muted-foreground/60">
          Static L+S, high leverage, trailing SL 0.33% after other side liquidates. Min $0.5/side.
        </p>
      </CardContent>
    </Card>
  );
}

export default function TradingPage() {
  const emergencyStop = useEmergencyStop();

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
            <Button
              variant="destructive"
              size="sm"
              data-testid="button-emergency-stop"
              disabled={emergencyStop.isPending}
              onClick={() => {
                if (confirm("EMERGENCY STOP: This will stop ALL strategies and cancel ALL open orders. Continue?")) {
                  emergencyStop.mutate();
                }
              }}
            >
              <OctagonX className="h-3 w-3 mr-1" />
              {emergencyStop.isPending ? "Stopping..." : "Emergency Stop"}
            </Button>
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
            <SpxShortPanel />
            <SilverLongPanel />
            <TandemStartPanel />
            <HedgePairPanel />
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
