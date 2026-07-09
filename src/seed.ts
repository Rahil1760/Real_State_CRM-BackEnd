import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import Tenant from './models/Tenant';
import User from './models/User';
import Lead from './models/Lead';
import Property from './models/Property';
import Visit from './models/Visit';
import Booking from './models/Booking';
import Campaign from './models/Campaign';
import Notification from './models/Notification';
import Invoice from './models/Invoice';

dotenv.config();

const SEED_MON_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/real_estate_crm';

const locations = ['Whitefield', 'Downtown', 'Brookfield', 'Indiranagar', 'Uptown', 'Koramangala'];
const types: Array<'Apartment' | 'Villa' | 'Plot' | 'Commercial'> = ['Apartment', 'Villa', 'Plot', 'Commercial'];
const sources = ['Facebook Ads', 'Instagram Ads', 'Google Ads', 'Website Form', '99acres Webhook', 'WhatsApp Ads', 'Referral Link', 'Manual Entry'];
const statuses: Array<'New' | 'Qualifying' | 'Qualified' | 'Incomplete' | 'Visit Scheduled' | 'Visit Done' | 'Ready to Buy' | 'Booked' | 'Cold'> = 
  ['New', 'Qualifying', 'Qualified', 'Incomplete', 'Visit Scheduled', 'Visit Done', 'Ready to Buy', 'Booked', 'Cold'];
const scores: Array<'Hot' | 'Warm' | 'Cold' | null> = ['Hot', 'Warm', 'Cold', null];

const seedDB = async () => {
  try {
    console.log(`Connecting to MongoDB at ${SEED_MON_URI}...`);
    await mongoose.connect(SEED_MON_URI);
    console.log('Connected to DB. Cleaning collections...');

    await Tenant.collection.drop().catch(() => {});
    await User.collection.drop().catch(() => {});
    await Lead.collection.drop().catch(() => {});
    await Property.collection.drop().catch(() => {});
    await Visit.collection.drop().catch(() => {});
    await Booking.collection.drop().catch(() => {});
    await Campaign.collection.drop().catch(() => {});
    await Notification.collection.drop().catch(() => {});
    await Invoice.collection.drop().catch(() => {});

    console.log('Collections cleared. Seeding Tenants...');

    // 1. Seed Tenant A: Rahil Builders (Pro Plan)
    const tenantA = new Tenant({
      name: 'Rahil Builders',
      slug: 'rahilbuilders',
      ownerEmail: 'admin@rahilbuilders.com',
      phone: '+919876543210',
      plan: 'pro',
      subscriptionStatus: 'active',
      subscriptionId: 'sub_rzp_pro_123',
      trialEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      maxLeads: 5000,
      maxUsers: 15,
      maxProperties: 100,
    });
    await tenantA.save();

    // 2. Seed Tenant B: Orchid Residences (Trial Plan)
    const tenantB = new Tenant({
      name: 'Orchid Residences',
      slug: 'orchidresidences',
      ownerEmail: 'admin@orchidresidences.com',
      phone: '+919999888877',
      plan: 'free',
      subscriptionStatus: 'trial',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      maxLeads: 50,
      maxUsers: 2,
      maxProperties: 5,
    });
    await tenantB.save();

    console.log('Tenants seeded. Seeding staff users...');

    // Password hashes
    const passAdmin = await bcrypt.hash('admin123', 10);
    const passManager = await bcrypt.hash('manager123', 10);
    const passExec = await bcrypt.hash('exec123', 10);
    const passSuper = await bcrypt.hash('super123', 10);

    // Platform SuperAdmin
    const superAdmin = new User({
      name: 'Platform SuperAdmin',
      email: 'superadmin@NextLead.com',
      passwordHash: passSuper,
      role: 'SuperAdmin',
      tenantId: null, // superadmin is global
    });
    await superAdmin.save();

    // Tenant A staff
    const adminA = new User({
      name: 'Sarah Rahil (Admin)',
      email: 'admin@rahilbuilders.com',
      passwordHash: passAdmin,
      role: 'Admin',
      tenantId: tenantA._id,
    });
    const managerA = new User({
      name: 'John Sales Manager A',
      email: 'manager@NextLead.com',
      passwordHash: passManager,
      role: 'Sales Manager',
      tenantId: tenantA._id,
    });
    const execA = new User({
      name: 'Dev Executive A',
      email: 'exec1@NextLead.com',
      passwordHash: passExec,
      role: 'Sales Executive',
      tenantId: tenantA._id,
    });
    await adminA.save();
    await managerA.save();
    await execA.save();

    // Tenant B staff
    const adminB = new User({
      name: 'Riya Orchid (Admin)',
      email: 'admin@orchidresidences.com',
      passwordHash: passAdmin,
      role: 'Admin',
      tenantId: tenantB._id,
    });
    const execB = new User({
      name: 'Tina Executive B',
      email: 'exec2@NextLead.com',
      passwordHash: passExec,
      role: 'Sales Executive',
      tenantId: tenantB._id,
    });
    await adminB.save();
    await execB.save();

    console.log('Staff seeded. Seeding Property listing inventories...');

    const samplePropertiesA = [];
    const titlesA = [
      'Rahil Heights Premium Apartments',
      'Orchid Meadows Luxury Villas',
      'Urban Spaces Tech Park (Office)',
      'Greenfield Meadows Plots',
      'The Grand Arcade Retail Shops'
    ];

    for (let i = 0; i < 5; i++) {
      const propType = types[i % 4];
      const location = locations[i % locations.length];
      const price = propType === 'Villa' ? 20000000 + (i * 2000000) : 8000000 + (i * 1000000);

      const prop = new Property({
        tenantId: tenantA._id,
        title: titlesA[i],
        type: propType,
        location,
        price,
        amenities: ['24x7 Security', 'Swimming Pool', 'Gymnasium', 'Power Backup'].slice(0, 2 + (i % 3)),
        s3Urls: {
          brochure: `https://NextLead-mock-s3.s3.amazonaws.com/brochures/brochure_rahil_${i + 1}.pdf`,
          floorPlan: `https://NextLead-mock-s3.s3.amazonaws.com/floorplans/floorplan_rahil_${i + 1}.png`
        },
        description: `Premium real estate opportunity by Rahil Builders at ${location}.`
      });
      await prop.save();
      samplePropertiesA.push(prop);
    }

    const samplePropertiesB = [];
    const titlesB = [
      'Orchid Serenity Condos',
      'Cascade Boulevard Luxury Penthouses',
      'Blue Hills Suburban Plots'
    ];

    for (let i = 0; i < 3; i++) {
      const propType = types[i % 4];
      const location = locations[(i + 2) % locations.length];
      const price = 5000000 + (i * 1500000);

      const prop = new Property({
        tenantId: tenantB._id,
        title: titlesB[i],
        type: propType,
        location,
        price,
        amenities: ['Gymnasium', 'EV Charging', 'Clubhouse'].slice(0, 1 + i),
        s3Urls: {
          brochure: `https://NextLead-mock-s3.s3.amazonaws.com/brochures/brochure_orchid_${i + 1}.pdf`,
          floorPlan: `https://NextLead-mock-s3.s3.amazonaws.com/floorplans/floorplan_orchid_${i + 1}.png`
        },
        description: `Stunning modern living concepts by Orchid Residences situated at ${location}.`
      });
      await prop.save();
      samplePropertiesB.push(prop);
    }

    console.log('Properties seeded. Seeding 35 Leads for Tenant A and 15 Leads for Tenant B...');

    const firstNames = ['Amit', 'Rajesh', 'Priya', 'Vikram', 'Neha', 'Rohan', 'Anjali', 'Kunal', 'Siddharth', 'Aditi'];
    const lastNames = ['Sharma', 'Verma', 'Patel', 'Nair', 'Gupta', 'Singh', 'Reddy', 'Rao', 'Joshi', 'Choudhury'];

    // Seed Tenant A leads
    for (let i = 0; i < 35; i++) {
      const name = `${firstNames[i % 10]} ${lastNames[(i + 3) % 10]}`;
      const mobile = `91${9000000000 + i}`;
      const email = `${name.toLowerCase().replace(/\s+/g, '')}@example.com`;
      const source = sources[i % sources.length];
      const status = statuses[i % statuses.length];
      let score: any = null;
      if (['Visit Done', 'Ready to Buy', 'Booked'].includes(status)) score = scores[i % 2];
      const budget = 5000000 + ((i % 10) * 2000000);
      const location = locations[i % locations.length];
      const propertyType = types[i % 4];

      const lead = new Lead({
        tenantId: tenantA._id,
        name,
        mobile,
        email,
        source,
        budget,
        location,
        propertyType,
        purpose: 'Buy',
        status,
        score,
        assignedTo: execA._id,
        timeline: [
          {
            event: 'Lead Created',
            timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            actor: 'System',
            details: `Captured via ${source}`,
          }
        ]
      });
      await lead.save();

      if (['Visit Scheduled', 'Visit Done', 'Ready to Buy', 'Booked'].includes(status)) {
        const prop = samplePropertiesA[i % samplePropertiesA.length];
        await Visit.create({
          tenantId: tenantA._id,
          leadId: lead._id,
          propertyId: prop._id,
          scheduledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          status: status === 'Visit Scheduled' ? 'Scheduled' : 'Completed',
          feedback: 'Lovely amenities and surroundings',
          scoreAfterVisit: score || 'Warm',
        });
      }

      if (status === 'Booked') {
        const prop = samplePropertiesA[i % samplePropertiesA.length];
        await Booking.create({
          tenantId: tenantA._id,
          leadId: lead._id,
          propertyId: prop._id,
          amount: prop.price * 0.1,
          paymentId: `pay_rahil_${i + 100}`,
          paymentLink: `https://checkout.razorpay.com/paylink/plink_rahil_${i}`,
          status: 'Paid',
          approvedBy: managerA._id,
        });

        // Seed Invoices for Superadmin analytics
        await Invoice.create({
          tenantId: tenantA._id,
          amount: 2499,
          razorpayPaymentId: `pay_sub_rahil_${i}`,
          plan: 'pro',
          billingPeriodStart: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
          billingPeriodEnd: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
          status: 'paid',
        });
      }
    }

    // Seed Tenant B leads
    for (let i = 0; i < 15; i++) {
      const name = `${firstNames[(i + 4) % 10]} ${lastNames[(i + 6) % 10]}`;
      const mobile = `91${8000000000 + i}`;
      const email = `${name.toLowerCase().replace(/\s+/g, '')}@exampleB.com`;
      const source = sources[i % sources.length];
      const status = statuses[i % statuses.length];
      
      const lead = new Lead({
        tenantId: tenantB._id,
        name,
        mobile,
        email,
        source,
        budget: 4000000 + (i * 50000),
        location: locations[i % locations.length],
        propertyType: types[i % 4],
        purpose: 'Invest',
        status,
        score: null,
        assignedTo: execB._id,
        timeline: [
          {
            event: 'Lead Created',
            timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            actor: 'System',
            details: 'Trial webhook capture',
          }
        ]
      });
      await lead.save();
    }

    console.log('Leads seeded. Seeding campaign drips per tenant...');

    // Drip Campaigns Tenant A
    await Campaign.create([
      {
        tenantId: tenantA._id,
        name: 'Welcome pro-drip sequence',
        trigger: 'Immediate',
        steps: [
          { delay: 0, channel: 'WhatsApp', template: 'welcome_message' },
          { delay: 1, channel: 'Email', template: 'Brochure' },
        ],
      },
      {
        tenantId: tenantA._id,
        name: 'EMI Pro Reminder Drip',
        trigger: 'Immediate',
        steps: [
          { delay: 24, channel: 'WhatsApp', template: 'payment_link' },
        ],
      }
    ]);

    // Drip Campaigns Tenant B
    await Campaign.create([
      {
        tenantId: tenantB._id,
        name: 'Welcome trial-drip sequence',
        trigger: 'Immediate',
        steps: [
          { delay: 0, channel: 'WhatsApp', template: 'welcome_message' },
        ],
      }
    ]);

    console.log('Database Multi-Tenant seeding successfully completed!');
    mongoose.connection.close();
  } catch (error) {
    console.error('Error seeding DB:', error);
    process.exit(1);
  }
};

seedDB();
