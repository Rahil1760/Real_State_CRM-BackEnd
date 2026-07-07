import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import User from '../models/User';
import bcrypt from 'bcryptjs';
import BaseRepository from '../repositories/BaseRepository';

const userRepository = new BaseRepository(User);

export const getUsers = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    // Exclude passwordHash from fetch
    const users = await User.find({ tenantId }).select('-passwordHash').sort({ createdAt: -1 });
    return res.status(200).json(users);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createUser = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { name, email, password, role, phone } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await userRepository.create(tenantId, {
      name,
      email,
      phone: phone || '',
      passwordHash,
      role,
    });

    const responseUser = user.toObject();
    delete (responseUser as any).passwordHash;

    return res.status(201).json(responseUser);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const updateUser = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { name, email, password, role, phone } = req.body;
    const user = await userRepository.findOne(tenantId, { _id: req.params.id });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = name || user.name;
    user.email = email || user.email;
    user.role = role || user.role;
    user.phone = phone !== undefined ? phone : user.phone;

    if (password) {
      user.passwordHash = await bcrypt.hash(password, 10);
    }

    await user.save();

    const responseUser = user.toObject();
    delete (responseUser as any).passwordHash;

    return res.status(200).json(responseUser);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const deleteUser = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const user = await userRepository.findByIdAndDelete(tenantId, req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.status(200).json({ message: 'User deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
