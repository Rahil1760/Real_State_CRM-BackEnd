import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';

dotenv.config();

// Imports Services and Configs
import { initSocket } from './services/socket/socketService';
import { initQueues } from './services/queue/queueConfig';
import { initWorkers } from './services/queue/workers';

// Import Middleware
import { tenantMiddleware } from './middleware/tenant';
import { globalRateLimiter, authRateLimiter } from './middleware/rateLimiter';

// Import Routes
import authRouter from './routes/auth';
import tenantsRouter from './routes/tenants';
import superadminRouter from './routes/superadmin';
import billingRouter from './routes/billing';
import webhooksRouter from './routes/webhooks';
import leadsRouter from './routes/leads';
import propertiesRouter from './routes/properties';
import visitsRouter from './routes/visits';
import bookingsRouter from './routes/bookings';
import analyticsRouter from './routes/analytics';
import campaignsRouter from './routes/campaigns';
import usersRouter from './routes/users';

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'https://real-state-crm-front-end.vercel.app',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'ngrok-skip-browser-warning'],
  credentials: true
}));

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Hello CRM Test Route
app.get('/api/hello-crm', (req: Request, res: Response) => {
  res.status(200).json({ message: 'hello crm' });
});

// Root Route
app.get('/', (req: Request, res: Response) => {
  res.send('Hello World');
});

import openwaRouter from './routes/openwaRoutes';

// Apply Rate Limiters to protect API routes
app.use('/api', globalRateLimiter);
app.use('/api/auth', authRateLimiter);

// 1. Public & Global Platform routes
app.use('/api/auth', authRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/billing', billingRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/openwa', openwaRouter);

// 2. Multi-Tenant Isolated Pipeline routes (Auto-inject req.tenant)
app.use('/api/leads', tenantMiddleware as any, leadsRouter);
app.use('/api/properties', tenantMiddleware as any, propertiesRouter);
app.use('/api/visits', tenantMiddleware as any, visitsRouter);
app.use('/api/bookings', tenantMiddleware as any, bookingsRouter);
app.use('/api/analytics', tenantMiddleware as any, analyticsRouter);
app.use('/api/campaigns', tenantMiddleware as any, campaignsRouter);
app.use('/api/users', tenantMiddleware as any, usersRouter);

// Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date() });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Error Middleware]:', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
  });
});

const startServer = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/real_estate_crm';
    await mongoose.connect(mongoUri);
    console.log('[Database] MongoDB connected.');

    initSocket(server);
    console.log('[Socket] Socket.io server initialized.');

    initQueues();
    initWorkers();

    server.listen(PORT, () => {
      console.log(`[Server] Multi-tenant SaaS Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
