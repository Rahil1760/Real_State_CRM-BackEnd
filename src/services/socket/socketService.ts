import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

let io: Server | null = null;
let crmNamespace: any = null;

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

  crmNamespace = io.of('/crm');

  // Middleware for JWT authentication
  crmNamespace.use((socket: Socket, next: any) => {
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
    console.log(`[Socket] User connected to /crm: ${user?.email || 'authenticated user'} (${user?.role || 'user'})`);

    // Join lead workspace channel
    socket.join('crm_workspace');

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${user?.email || 'user'}`);
    });
  });

  // Patch io.to and io.emit to guarantee events are emitted to clients connected to /crm namespace
  const originalTo = io.to.bind(io);
  const originalEmit = io.emit.bind(io);

  io.to = function (room: string | string[]) {
    const roomStr = Array.isArray(room) ? room.join(',') : room;
    if (roomStr === '/crm' || roomStr === 'crm_workspace') {
      return {
        emit: (event: string, ...args: any[]) => {
          if (crmNamespace) {
            crmNamespace.emit(event, ...args);
            crmNamespace.to('crm_workspace').emit(event, ...args);
          }
          return originalTo(roomStr).emit(event, ...args);
        }
      } as any;
    }
    return originalTo(room);
  };

  io.emit = function (event: string, ...args: any[]) {
    if (crmNamespace) {
      crmNamespace.emit(event, ...args);
      crmNamespace.to('crm_workspace').emit(event, ...args);
    }
    return originalEmit(event, ...args);
  };

  return io;
};

export const getIO = (): Server | null => {
  return io;
};

export const emitToCRM = (event: string, data: any) => {
  if (crmNamespace) {
    crmNamespace.emit(event, data);
    crmNamespace.to('crm_workspace').emit(event, data);
  }
  if (io) {
    io.emit(event, data);
    io.to('/crm').emit(event, data);
  }
};
