import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowUpDown, Activity, DollarSign, TrendingUp } from "lucide-react";
import { type CryptoStat } from "@shared/schema";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

interface VolatilityTableProps {
  data: CryptoStat[];
  isLoading: boolean;
}

type SortField = "marketCap" | "hourlySwings" | "currentPrice";
type SortDirection = "asc" | "desc";

export function VolatilityTable({ data, isLoading }: VolatilityTableProps) {
  const [sortField, setSortField] = useState<SortField>("hourlySwings");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc"); // Default to desc for new metrics usually
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      const aValue = a[sortField] || 0;
      const bValue = b[sortField] || 0;
      
      if (sortDirection === "asc") {
        return aValue > bValue ? 1 : -1;
      }
      return aValue < bValue ? 1 : -1;
    });
  }, [data, sortField, sortDirection]);

  if (isLoading) {
    return (
      <div className="w-full space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-16 w-full bg-card/30 animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 backdrop-blur-sm overflow-hidden shadow-xl">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow className="hover:bg-transparent border-border/40">
            <TableHead className="w-[80px] font-bold text-muted-foreground">Rank</TableHead>
            <TableHead className="min-w-[200px] font-bold text-muted-foreground">Asset</TableHead>
            <TableHead className="text-right cursor-pointer hover:text-primary transition-colors" onClick={() => handleSort("currentPrice")}>
              <div className="flex items-center justify-end gap-1">
                Price <ArrowUpDown className="h-3 w-3" />
              </div>
            </TableHead>
            <TableHead className="text-right cursor-pointer hover:text-primary transition-colors hidden md:table-cell" onClick={() => handleSort("marketCap")}>
              <div className="flex items-center justify-end gap-1">
                Market Cap <ArrowUpDown className="h-3 w-3" />
              </div>
            </TableHead>
            <TableHead className="text-right cursor-pointer hover:text-primary transition-colors w-[180px]" onClick={() => handleSort("hourlySwings")}>
              <div className="flex items-center justify-end gap-1 text-primary">
                1% Hourly Swings <Activity className="h-3 w-3" />
              </div>
            </TableHead>
            <TableHead className="w-[150px] hidden lg:table-cell text-right text-muted-foreground">7d Trend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AnimatePresence mode="popLayout">
            {sortedData.map((coin, index) => (
              <motion.tr
                key={coin.slug}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2, delay: index * 0.05 }}
                className="group border-border/40 hover:bg-muted/30 transition-colors"
              >
                <TableCell className="font-mono text-muted-foreground font-medium pl-6">
                  {index + 1}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-bold text-base text-foreground flex items-center gap-2">
                      {coin.name}
                      <span className="text-xs font-normal text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded uppercase tracking-wider">
                        {coin.symbol}
                      </span>
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-foreground/90">
                  {formatCurrency(coin.currentPrice || 0)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground hidden md:table-cell">
                  ${formatNumber(coin.marketCap || 0)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className={cn(
                      "font-bold font-mono text-lg",
                      (coin.hourlySwings || 0) > 5 ? "text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.3)]" : 
                      (coin.hourlySwings || 0) > 2 ? "text-yellow-400" : "text-emerald-400"
                    )}>
                      {coin.hourlySwings}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell py-1 px-2">
                  <div className="h-[40px] w-full max-w-[120px] ml-auto opacity-50 group-hover:opacity-100 transition-opacity">
                    {coin.priceHistory && (coin.priceHistory as any[]).length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={coin.priceHistory as any[]}>
                          <Line 
                            type="monotone" 
                            dataKey="price" 
                            stroke={(coin.hourlySwings || 0) > 5 ? "#ef4444" : "#10b981"} 
                            strokeWidth={2} 
                            dot={false}
                          />
                          <YAxis domain={['auto', 'auto']} hide />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground/30">
                        No Data
                      </div>
                    )}
                  </div>
                </TableCell>
              </motion.tr>
            ))}
          </AnimatePresence>
        </TableBody>
      </Table>
    </div>
  );
}

// Helper utility (should be in utils but included here for completeness of component)
function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
