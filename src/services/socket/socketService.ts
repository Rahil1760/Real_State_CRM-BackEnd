import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

let io: Server | null = null;

export const initSocket = (server: HttpServer): Server => {
  const allowedOrigins = [
    'https://real-state-crm-front-end.vercel.app',
    'https://real-state-crm-front-end.vercel.app/',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:80'
  ];

  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/')) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true
    },
  });

  const crmNamespace = io.of('/crm');

  // Middleware for JWT authentication
  crmNamespace.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      console.log('[Socket] Connection rejected: Token missing');
      return next(new Error('Authentication error: token missing'));
    }

    const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';
    jwt.verify(token, secret, (err: any, decoded: any) => {
      if (err) {
        console.log('[Socket] Connection rejected: Token invalid');
        return next(new Error('Authentication error: token invalid'));
      }
      (socket as any).user = decoded;
      next();
    });
  });

  crmNamespace.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    console.log(`[Socket] User connected to /crm: ${user.email} (${user.role})`);

    // Join lead workspace channel
    socket.join('crm_workspace');

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${user.email}`);
    });
  });

  return io;
};

export const getIO = (): Server | null => {
  return io;
};
