import rateLimit from 'express-rate-limit';
import { Request } from 'express';

/**
 * Global API Rate Limiter
 * Default: 100 requests per 15 minutes per IP/Tenant
 */
export const globalRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable legacy `X-RateLimit-*` headers
  validate: { keyGeneratorIpFallback: false },
  message: {
    status: 429,
    message: 'Too many requests, please try again later.',
  },
  keyGenerator: (req: Request): string => {
    const tenantId = req.headers['x-tenant-id'] as string;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return tenantId ? `${tenantId}_${ip}` : ip;
  },
});

/**
 * Authentication Rate Limiter (Brute-force protection for login/signup/reset routes)
 * Default: 10 requests per 15 minutes per IP
 */
export const authRateLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10), // Limit each IP to 10 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: 'Too many authentication attempts, please try again after 15 minutes.',
  },
});

/**
 * AI & High-Cost Operations Rate Limiter
 * Default: 30 requests per 15 minutes per IP/Tenant
 */
export const aiRateLimiter = rateLimit({
  windowMs: parseInt(process.env.AI_RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: {
    status: 429,
    message: 'Too many AI requests. Please wait a moment before trying again.',
  },
  keyGenerator: (req: Request): string => {
    const tenantId = req.headers['x-tenant-id'] as string;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return tenantId ? `ai_${tenantId}_${ip}` : `ai_${ip}`;
  },
});
