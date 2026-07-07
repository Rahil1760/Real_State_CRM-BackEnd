import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import User from '../models/User';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const seed = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/real_estate_crm';
    await mongoose.connect(mongoUri);

    const email = 'superadmin@gmail.com';
    const password = '123456';
    
    let user = await User.findOne({ email });
    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10);
      user = new User({
        name: 'Super Admin',
        email,
        passwordHash,
        role: 'SuperAdmin'
      });
      await user.save();
      console.log('Superadmin user created.');
    } else {
      console.log('Superadmin user already exists.');
    }
    
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

seed();
