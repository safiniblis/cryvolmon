import * as React from "react";
import { useCryptoStats, useRefreshStats } from "@/hooks/use-crypto-stats";
import { VolatilityTable } from "@/components/dashboard/volatility-table";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, AlertTriangle, Zap, Activity, Bot, Users } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export default function Dashboard() {
  const { data: stats, isLoading, isError } = useCryptoStats();
  const { mutate: refresh, isPending: isRefreshing } = useRefreshStats();
  const [xToken, setXToken] = React.useState("");
  const [xSaved, setXSaved] = React.useState(false);
  const [xSaving, setXSaving] = React.useState(false);
  const [xError, setXError] = React.useState("");
  const [goldHealth, setGoldHealth] = React.useState<any>(null);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/engine/gold-health");
        const data = await response.json();
        if (active) setGoldHealth(data);
      } catch {
        if (active) setGoldHealth({ status: "unavailable", error: "Health check unavailable" });
      }
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const topMover = stats?.reduce((prev, current) => 
    (prev.hourlySwings || 0) > (current.hourlySwings || 0) ? prev : current
  , stats[0]);

  const totalSwings = stats?.reduce((acc, curr) => acc + (curr.hourlySwings || 0), 0) || 0;
  const avgSwings = stats?.length ? (totalSwings / stats.length).toFixed(1) : "0";

  if (isError) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center space-y-4 bg-background text-foreground">
        <AlertTriangle className="h-16 w-16 text-destructive animate-pulse" />
        <h2 className="text-2xl font-bold">Failed to load market data</h2>
        <Button onClick={() => window.location.reload()} variant="outline">
          Try Again
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[#0a0f1e] text-foreground p-4 md:p-8 lg:p-12 relative overflow-hidden">
      {/* Background Gradients */}
      <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-blue-900/10 to-transparent pointer-events-none" />
      <div className="absolute -top-[100px] -right-[100px] w-[500px] h-[500px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10 space-y-8">
        
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <motion.h1 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-4xl md:text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-blue-100 to-white/50"
            >
              Volatility Radar
            </motion.h1>
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              className="text-muted-foreground text-lg"
            >
              Tracking hourly price swings ≥ 1% for top 20 assets
            </motion.p>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <Link href="/trading" data-testid="link-trading">
              <Button
                variant="outline"
                className="border-purple-500/30 text-purple-300 hover:text-purple-200"
              >
                <Bot className="h-4 w-4 mr-2" /> Trading Agent
              </Button>
            </Link>

            <Link href="/council" data-testid="link-council">
              <Button
                variant="outline"
                className="border-violet-500/30 text-violet-300 hover:text-violet-200"
              >
                <Users className="h-4 w-4 mr-2" /> AI Council
              </Button>
            </Link>

            <div className="hidden md:flex flex-col items-end text-right">
              <span className="text-xs text-muted-foreground font-mono">
                LAST UPDATED
              </span>
              <span className="text-sm font-medium font-mono text-emerald-400">
                {stats?.[0]?.lastUpdated 
                  ? new Date(stats[0].lastUpdated).toLocaleTimeString() 
                  : '--:--:--'}
              </span>
            </div>
            
            <Button
              size="lg"
              onClick={() => refresh()}
              disabled={isRefreshing}
              className={`
                relative overflow-hidden bg-primary/10 hover:bg-primary/20 
                text-primary border border-primary/20 shadow-lg shadow-primary/10
                transition-all duration-300
                ${isRefreshing ? 'opacity-80' : 'hover:-translate-y-0.5 hover:shadow-primary/20'}
              `}
            >
              <RefreshCw className={`mr-2 h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? "Scanning..." : "Scan Market"}
            </Button>
          </div>
        </header>

        {/* Small isolated live-data tile. Token is sent only to the server and never displayed. */}
        <div className="flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-sky-500/20 bg-sky-500/5 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sky-100">Live Data</h2>
              <span className="text-xs text-muted-foreground">1 source</span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded border border-white/10 px-3 py-2 text-sm">
              <span>𝕏 X</span><span className={xSaved ? "text-emerald-400" : "text-muted-foreground"}>{xSaved ? "saved" : "not connected"}</span>
            </div>
            <Dialog>
              <DialogTrigger asChild><Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => setXError("")}>Add X token</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Connect X live data</DialogTitle><DialogDescription>Paste the bearer token here. It is sent only to this server, stored in a local protected file, and never shown back.</DialogDescription></DialogHeader>
                <Input type="password" value={xToken} onChange={(e) => { setXToken(e.target.value); setXError(""); }} placeholder="X bearer token" autoComplete="off" spellCheck={false} />
                {xError && <p className="text-sm text-red-400">{xError}</p>}
                <DialogFooter><Button disabled={!xToken.trim() || xSaving} onClick={async () => {
                  setXSaving(true); setXError("");
                  try {
                    const response = await fetch("/api/live-data/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: xToken.trim() }) });
                    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || "Could not save token"); }
                    setXSaved(true); setXToken("");
                  } catch (error) { setXError(error instanceof Error ? error.message : "Could not save token"); }
                  finally { setXSaving(false); }
                }}>{xSaving ? "Saving…" : "Save securely"}</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
            <div className="flex items-center justify-between"><h2 className="font-semibold text-amber-100">Gold Engine Health</h2><span className="text-xs text-muted-foreground">E-XAUT-USDT</span></div>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><span>Status</span><span>{goldHealth?.status || "checking…"}</span></div>
              <div className="flex justify-between"><span>Mark</span><span>{goldHealth?.mark ?? "unknown"}</span></div>
              <div className="flex justify-between"><span>Budget</span><span>{goldHealth?.budget == null ? "unknown" : `${goldHealth.budget}`}</span></div>
              <div className="flex justify-between"><span>Open orders</span><span>{goldHealth?.orderCount ?? "unknown"}</span></div>
              {goldHealth?.error && <p className="pt-1 text-xs text-amber-300">{goldHealth.error}</p>}
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatCard
            title="Most Volatile Asset"
            value={topMover ? topMover.name : "Loading..."}
            description={topMover ? `${topMover.hourlySwings} swings in past hour` : undefined}
            icon={<Zap className="h-4 w-4 text-yellow-400" />}
            trend="down"
            className="border-yellow-500/20 bg-yellow-500/5"
          />
          <StatCard
            title="Average Swings (Top 20)"
            value={avgSwings}
            description="High volatility detected"
            icon={<Activity className="h-4 w-4 text-blue-400" />}
            trend="neutral"
            className="border-blue-500/20 bg-blue-500/5"
          />
          <StatCard
            title="Total Market Swings"
            value={totalSwings}
            description="Across all monitored assets"
            icon={<TrendingUp className="h-4 w-4 text-purple-400" />}
            trend="up"
            className="border-purple-500/20 bg-purple-500/5"
          />
        </div>

        {/* Main Content */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-foreground/90 flex items-center gap-2">
              <span className="w-1 h-6 bg-primary rounded-full block" />
              Live Market Data
            </h2>
          </div>
          
          <VolatilityTable data={stats || []} isLoading={isLoading} />
        </div>

        <footer className="pt-12 pb-6 text-center text-sm text-muted-foreground/40 font-mono">
          Data provided for informational purposes only. Not financial advice.
          <br />
          System Time: {new Date().toISOString()}
        </footer>
      </div>
    </div>
  );
}
