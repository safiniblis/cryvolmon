import { z } from 'zod';
import { cryptoCache } from './schema';

export const api = {
  stats: {
    list: {
      method: 'GET' as const,
      path: '/api/stats' as const,
      responses: {
        200: z.array(z.custom<typeof cryptoCache.$inferSelect>()),
      },
    },
    refresh: {
      method: 'POST' as const,
      path: '/api/stats/refresh' as const,
      responses: {
        200: z.object({ message: z.string() }),
      },
    }
  },
};
