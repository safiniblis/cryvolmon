import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon?: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  className?: string;
}

export function StatCard({ title, value, description, icon, trend, className }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card className={cn("bg-card/40 border-border/50 backdrop-blur-sm overflow-hidden", className)}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          {icon && <div className="text-muted-foreground">{icon}</div>}
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-mono tracking-tight text-foreground">{value}</div>
          {description && (
            <p className={cn(
              "text-xs mt-1 font-medium",
              trend === "up" ? "text-green-500" : 
              trend === "down" ? "text-red-500" : "text-muted-foreground"
            )}>
              {description}
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
