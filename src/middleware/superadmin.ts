import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

export const requireSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  if (req.user.role !== 'SuperAdmin') {
    return res.status(403).json({ message: 'Access denied: superadmin privileges required' });
  }

  next();
};
